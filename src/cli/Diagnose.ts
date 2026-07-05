/**
 * cli/Diagnose.ts — `pgwen diagnose` subcommand.
 *
 * Four modes:
 *
 *   --report          Telemetry analysis. Reads diagnosis-history/ and
 *                     diagnosis-cache/ sidecars and emits a Markdown
 *                     summary (counts per class/category/confidence,
 *                     token totals, annotated outcome stats including
 *                     false-positive rate). No results.json needed.
 *
 *   --annotate        Interactive review of diagnosis-history/ entries.
 *                     Prompts for human_action + outcome, writes back.
 *                     Powers the false-positive measurement.
 *
 *   --rules-only      Per-failure rule-based output. Free, offline.
 *
 *   (no flag)         Per-failure Claude-backed output. If any gate fails
 *                     — AI disabled in config, PGWEN_AI_DISABLED env set,
 *                     no API key resolved, etc. — the CLI falls back to
 *                     the rules-only path WITH a notice so the user sees
 *                     why.
 *
 * Other flags:
 *   --input <path>    results.json path. Default: <output>/results.json.
 *   --output <dir>    Output directory. Default: pgwen/output.
 *   --config <path>   pgwen.conf path. Default: pgwen.conf in cwd.
 *   --no-cache        Bypass the response cache for this run.
 *   --dry-run         Estimate per-failure cost without calling Claude.
 *   --limit <N>       Cap entries reviewed in --annotate.
 *
 * Tests inject deps via DiagnoseRunOptions; nothing in this file reads
 * process.env directly — `opts.env` is the only env-var surface.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JsonReport, JsonStep, JsonScenario, JsonFeature } from '../reporting/JsonReporter';
import { loadFileWithMasked } from '../engine/ProfileLoader';
import type { LoadResult } from '../engine/ProfileLoader';
import {
  budgetCapsFromConfig,
  rateLimitOptionsFromConfig,
  pricingFromConfig,
} from '../diagnose/AiConfig';
import { BudgetGate } from '../diagnose/BudgetGate';
import { RateLimit } from '../diagnose/RateLimit';
import { resolveApiKey, describeResolvedKey } from '../diagnose/ApiKey';
import {
  runAiDiagnose,
  type AiPipelineResult,
  type ClaudeClientLike,
  type DomExtractor,
  type FailureToDiagnose,
  type LocatorLookup,
  type RecentDiffsFetcher,
  type SiblingStatus,
} from '../diagnose/AiPipeline';
import { ClaudeClient } from '../diagnose/ClaudeClient';
import { selectAdapter, resolveProvider } from '../diagnose/ai/selectAdapter';
import { buildAnalysisReport, renderAnalysisMarkdown } from '../diagnose/AnalysisReport';
import { runAnnotationSession, type AnnotationDriverDeps } from '../diagnose/Annotate';
import {
  buildLocatorIndex,
  findLocatorForStep,
  type LocatorIndex,
} from '../diagnose/LocatorIndex';
import { getRecentDiffsForFiles } from '../diagnose/GitDiff';
import { groupFailures, projectInstance } from '../diagnose/FailureFingerprint';
import * as readline from 'readline';
import type { FailureClassification, FailureClass, FailureConfidence } from '../diagnose/Classifier';

// ─── Args ──────────────────────────────────────────────────────────────────

interface DiagnoseArgs {
  rulesOnly: boolean;
  noCache: boolean;
  dryRun: boolean;
  /** When true, emit a telemetry-analysis report instead of per-failure diagnose. */
  report: boolean;
  /** When true, walk diagnosis-history/ interactively to capture human_action + outcome. */
  annotate: boolean;
  /** When set with --annotate, stop after N entries. */
  annotateLimit?: number;
  input?: string;
  output?: string;
  config?: string;
  /**
   * When set, write a JSON array of `{ failure, classification, output,
   * instances? }` entries to the given path — the input format consumed by
   * `@pgwen/fix`'s `pgwen-fix --input`. Markdown output to stdout is
   * unchanged.
   */
  jsonOut?: string;
  /**
   * Disable pattern grouping. Default OFF — grouping is the default
   * behaviour. Set this to force one Claude call per failure even when
   * two failures share a locator binding.
   */
  noPatternGrouping: boolean;
  /**
   * Override `pgwen.diagnose.ai.provider` for this run. Values:
   * "claude" | "openai" | "azure-openai" | "copilot". When absent,
   * the config value (or its default "claude") applies.
   */
  provider?: string;
}

function parseDiagnoseArgs(argv: string[]): DiagnoseArgs {
  const args: DiagnoseArgs = {
    rulesOnly: false, noCache: false, dryRun: false, report: false, annotate: false,
    noPatternGrouping: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--rules-only') args.rulesOnly = true;
    else if (a === '--no-cache') args.noCache = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--report') args.report = true;
    else if (a === '--annotate') args.annotate = true;
    else if (a === '--limit') {
      const next = argv[++i];
      if (next !== undefined) {
        const n = parseInt(next, 10);
        if (Number.isInteger(n) && n > 0) args.annotateLimit = n;
      }
    } else if (a === '--input') {
      const next = argv[++i];
      if (next !== undefined) args.input = next;
    } else if (a === '--output' || a === '-o') {
      const next = argv[++i];
      if (next !== undefined) args.output = next;
    } else if (a === '--config') {
      const next = argv[++i];
      if (next !== undefined) args.config = next;
    } else if (a === '--json-out') {
      const next = argv[++i];
      if (next !== undefined) args.jsonOut = next;
    } else if (a === '--no-pattern-grouping') {
      args.noPatternGrouping = true;
    } else if (a === '--provider') {
      const next = argv[++i];
      if (next !== undefined) args.provider = next;
    }
  }
  return args;
}

// ─── Failure walking + rules-only renderer (kept pure for tests) ──────────

interface FailedStep {
  featureFile: string;
  featureName: string;
  scenarioName: string;
  scenarioSiblings: Array<{ name: string; status: SiblingStatus }>;
  stepKeyword: string;
  stepText: string;
  error: string;
  errorClass: string;
  failureClass?: NonNullable<JsonStep['failureClass']>;
  tracePath: string | null;
  /** Meta files loaded for the parent feature — used to build a per-feature LocatorIndex. */
  metaFiles: ReadonlyArray<string>;
}

function collectFailedSteps(report: JsonReport): FailedStep[] {
  const out: FailedStep[] = [];
  const walk = (
    feature: JsonFeature,
    scenario: JsonScenario,
    siblings: Array<{ name: string; status: SiblingStatus }>,
    step: JsonStep,
  ): void => {
    if (step.children && step.children.length > 0) {
      for (const child of step.children) walk(feature, scenario, siblings, child);
    }
    if (step.status === 'failed' && step.error && (!step.children || step.children.length === 0)) {
      out.push({
        featureFile: feature.file,
        featureName: feature.name,
        scenarioName: scenario.name,
        scenarioSiblings: siblings,
        stepKeyword: step.keyword,
        stepText: step.text,
        error: step.error,
        errorClass: step.error_class ?? 'Error',
        ...(step.failureClass ? { failureClass: step.failureClass } : {}),
        tracePath: feature.tracePath ?? null,
        metaFiles: feature.metaFiles?.map((m) => m.file) ?? [],
      });
    }
  };
  for (const feature of report.features) {
    const siblings: Array<{ name: string; status: SiblingStatus }> = feature.scenarios.map(
      (s) => ({ name: s.name, status: s.status }),
    );
    for (const scenario of feature.scenarios) {
      for (const step of scenario.steps) walk(feature, scenario, siblings, step);
    }
  }
  return out;
}

const CLASS_ORDER: ReadonlyArray<FailureClass> = [
  'ASSERTION_FAILED', 'LOCATOR_NOT_FOUND', 'NAVIGATION_FAILURE',
  'TIMEOUT', 'AUTH_FAILURE', 'UNKNOWN',
];

export function renderRulesOnlyMarkdown(report: JsonReport, notice?: string): string {
  const failures = collectFailedSteps(report);
  const lines: string[] = [];
  lines.push('# pgwen diagnose — rules-only');
  lines.push('');
  lines.push(`Source: \`${report.command}\` · ${report.startedAt}`);
  lines.push('');
  if (notice) {
    lines.push(`> ${notice}`);
    lines.push('');
  }

  if (failures.length === 0) {
    lines.push('No failed steps in this run.');
    lines.push('');
    return lines.join('\n');
  }

  const byClass = new Map<string, FailedStep[]>();
  for (const f of failures) {
    const key: string = f.failureClass?.class ?? 'UNCLASSIFIED';
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key)!.push(f);
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Class | Count |');
  lines.push('|---|---|');
  for (const cls of CLASS_ORDER) {
    const n = byClass.get(cls)?.length ?? 0;
    if (n > 0) lines.push(`| ${cls} | ${n} |`);
  }
  const unclassified = byClass.get('UNCLASSIFIED')?.length ?? 0;
  if (unclassified > 0) lines.push(`| (unclassified) | ${unclassified} |`);
  lines.push('');

  for (const cls of CLASS_ORDER) {
    const items = byClass.get(cls);
    if (!items || items.length === 0) continue;
    lines.push(`## ${cls} (${items.length})`);
    lines.push('');
    for (const f of items) {
      lines.push(`- **${f.scenarioName}** — \`${f.featureFile}\``);
      lines.push(`  - Step: \`${f.stepKeyword} ${f.stepText}\``);
      lines.push(`  - Error: ${f.error}`);
      lines.push(`  - Confidence: ${f.failureClass?.confidence ?? '?'}`);
      if (f.failureClass?.signals && f.failureClass.signals.length > 0) {
        lines.push(`  - Signals: ${f.failureClass.signals.join('; ')}`);
      }
      lines.push('');
    }
  }

  const unc = byClass.get('UNCLASSIFIED');
  if (unc && unc.length > 0) {
    lines.push(`## Unclassified (${unc.length})`);
    lines.push('');
    lines.push('These steps failed before the rule-based classifier ran, or were produced by a tool version that does not emit `failureClass`. They appear here for completeness.');
    lines.push('');
    for (const f of unc) {
      lines.push(`- **${f.scenarioName}** — \`${f.featureFile}\``);
      lines.push(`  - Step: \`${f.stepKeyword} ${f.stepText}\``);
      lines.push(`  - Error: ${f.error}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── AI orchestration ─────────────────────────────────────────────────────

function jsonFailureClassToClassification(jfc: NonNullable<JsonStep['failureClass']>): FailureClassification {
  return {
    class: jfc.class as FailureClass,
    confidence: jfc.confidence as FailureConfidence,
    signals: jfc.signals,
  };
}

function buildFailureToDiagnose(
  fs0: FailedStep,
  config: Record<string, string | undefined>,
): FailureToDiagnose {
  return {
    feature: { name: fs0.featureName, file: fs0.featureFile },
    scenario: { name: fs0.scenarioName, siblings: fs0.scenarioSiblings },
    step: {
      keyword: fs0.stepKeyword.trim(),
      text: fs0.stepText,
      errorClass: fs0.errorClass,
      errorMessage: fs0.error,
    },
    prior: fs0.failureClass ? jsonFailureClassToClassification(fs0.failureClass) : null,
    tracePath: fs0.tracePath,
    context: {
      targetEnv: (config['pgwen.target.env'] ?? 'unknown').trim() || 'unknown',
      browser: (config['pgwen.target.browser'] ?? 'chromium').trim() || 'chromium',
      viewport: (config['pgwen.web.browser.size'] ?? '1280x720').trim() || '1280x720',
    },
    metaFiles: fs0.metaFiles,
  };
}

/**
 * Build a per-feature LocatorIndex cache + LocatorLookup closure. The
 * cache means parsing each .meta file at most once per CLI invocation
 * — important for large 47-project fleets where a feature can import a
 * dozen shared meta files.
 */
function makeLocatorLookup(baseDir: string): LocatorLookup {
  const cache = new Map<string, LocatorIndex>();
  return (failure) => {
    const files = failure.metaFiles ?? [];
    if (files.length === 0) return null;
    const cacheKey = files.slice().sort().join('|');
    let index = cache.get(cacheKey);
    if (!index) {
      index = buildLocatorIndex({ metaFiles: files, baseDir });
      cache.set(cacheKey, index);
    }
    const found = findLocatorForStep(failure.step.text, index);
    if (!found) return null;
    return {
      name: found.name,
      selector_strategy: found.selector_strategy,
      selector_value: found.selector_value,
      binding_file: found.binding_file,
      binding_line: found.binding_line,
      file_content: found.file_content,
    };
  };
}

/**
 * Build a RecentDiffsFetcher that runs `git log` in the project directory.
 * Returns a no-op fetcher when `baseDir` is not a git repo (the helper
 * itself handles that, so the closure is unconditional).
 */
function makeRecentDiffsFetcher(baseDir: string): RecentDiffsFetcher {
  return async (files) => getRecentDiffsForFiles({ repoDir: baseDir, files });
}

interface AiReportEntry extends AiPipelineResult {
  source: AiPipelineResult['source'];
  /**
   * Set when this entry represents a pattern that grouped multiple failures.
   * `representative` IS the AiPipelineResult.failure; this list includes every
   * failure (representative first) that shares the same fingerprint.
   * Always set when grouping is enabled (length >= 1).
   */
  instances?: FailureToDiagnose[];
}

function renderAiMarkdown(
  report: JsonReport,
  entries: AiReportEntry[],
  meta: { keyDescriptor: string; dryRun: boolean; noCache: boolean },
): string {
  const lines: string[] = [];
  lines.push('# pgwen diagnose — AI-assisted');
  lines.push('');
  lines.push(`Source: \`${report.command}\` · ${report.startedAt}`);
  lines.push(`API key: ${meta.keyDescriptor}${meta.dryRun ? ' · dry-run' : ''}${meta.noCache ? ' · cache-bypassed' : ''}`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('No failed steps in this run.');
    lines.push('');
    return lines.join('\n');
  }

  // Aggregate summary.
  let totalActual = 0;
  let totalEstimated = 0;
  const counts = { cache: 0, fresh: 0, skipped: 0 };
  for (const e of entries) {
    counts[e.source] += 1;
    if (e.actualUsd) totalActual += e.actualUsd;
    if (e.estimatedUsd) totalEstimated += e.estimatedUsd;
  }
  lines.push('## Summary');
  lines.push('');
  lines.push('| Outcome | Count |');
  lines.push('|---|---|');
  lines.push(`| cache hits | ${counts.cache} |`);
  lines.push(`| fresh calls | ${counts.fresh} |`);
  lines.push(`| skipped | ${counts.skipped} |`);
  lines.push('');
  if (meta.dryRun) {
    lines.push(`Estimated cost (no calls made): **$${totalEstimated.toFixed(4)}**`);
  } else {
    lines.push(`Total actual cost: **$${totalActual.toFixed(4)}**`);
  }
  lines.push('');

  // Per-failure detail.
  for (const e of entries) {
    const f = e.failure;
    const instanceCount = e.instances?.length ?? 1;
    const suffix = instanceCount > 1 ? `  _(pattern affects ${instanceCount} instances)_` : '';
    lines.push(`## ${f.scenario.name}${suffix}`);
    lines.push('');
    lines.push(`- Feature: \`${f.feature.file}\``);
    lines.push(`- Step: \`${f.step.keyword} ${f.step.text}\``);
    lines.push(`- Error: ${f.step.errorMessage}`);
    if (instanceCount > 1 && e.instances) {
      lines.push(`- Other instances:`);
      for (const inst of e.instances.slice(1)) {
        lines.push(`  - \`${inst.feature.file}\` — _${inst.scenario.name}_`);
      }
    }
    if (f.prior) lines.push(`- Prior class: \`${f.prior.class}\` (${f.prior.confidence})`);
    lines.push(`- AI source: \`${e.source}\`${e.model ? ` · model \`${e.model}\`` : ''}`);
    if (e.source === 'fresh' && e.actualUsd !== undefined) {
      lines.push(`- Actual cost: $${e.actualUsd.toFixed(4)}`);
    }
    if (e.source === 'skipped') {
      lines.push(`- Reason: ${e.reason ?? 'unknown'}`);
      if (e.estimatedUsd !== undefined) lines.push(`- Estimated cost (had it run): $${e.estimatedUsd.toFixed(4)}`);
    }
    if (e.output) {
      lines.push('');
      lines.push(`**${e.output.category}** · confidence **${e.output.confidence}**`);
      lines.push('');
      lines.push(e.output.human_explanation);
      if (e.output.evidence.length > 0) {
        lines.push('');
        lines.push('Evidence:');
        for (const ev of e.output.evidence) lines.push(`- ${ev}`);
      }
      if (e.output.machine_proposal) {
        lines.push('');
        lines.push('Proposed fix:');
        lines.push('```');
        lines.push(`- ${e.output.machine_proposal.old}`);
        lines.push(`+ ${e.output.machine_proposal.new}`);
        lines.push(`(${e.output.machine_proposal.file}:${e.output.machine_proposal.line})`);
        lines.push('```');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Run options + entry point ────────────────────────────────────────────

export interface DiagnoseRunOptions {
  /** Optional override for stdout. */
  write?: (s: string) => void;
  /** Inject the pgwen.conf loader. Default uses loadFileWithMasked. */
  loadConfig?: (configPath: string) => LoadResult | null;
  /** Inject the Claude client factory. Default builds a real ClaudeClient. */
  makeClaudeClient?: (apiKey: string) => ClaudeClientLike;
  /** Inject the trace-zip DOM extractor. Defaults to the real extractor. */
  extractDom?: DomExtractor;
  /** Inject env. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Inject the annotation prompt fn. Defaults to a readline-backed
   * stdin reader. Tests pass canned responses.
   */
  annotatePrompt?: AnnotationDriverDeps['prompt'];
  /**
   * Inject the locator lookup. Default: closure over `cwd` that builds
   * per-feature LocatorIndex on demand from JsonReport.metaFiles.
   */
  locatorLookup?: LocatorLookup;
  /**
   * Inject the recent-diffs fetcher. Default: closure over `cwd` that
   * runs `git log -p` filtered to the involved files.
   */
  recentDiffsFor?: RecentDiffsFetcher;
}

export async function runDiagnose(
  argv: string[],
  cwd: string,
  opts: DiagnoseRunOptions = {},
): Promise<void> {
  const args = parseDiagnoseArgs(argv);
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const env = opts.env ?? process.env;

  const outputDir = args.output ?? path.join(cwd, 'pgwen', 'output');

  // ── Telemetry-analysis path ──────────────────────────────────────────
  // Independent of results.json — reads the historic sidecars instead.
  if (args.report) {
    const reportsDir = path.join(outputDir, 'reports');
    const analysis = buildAnalysisReport(reportsDir);
    emitMarkdown(write, renderAnalysisMarkdown(analysis));
    return;
  }

  // ── Annotation path ──────────────────────────────────────────────────
  if (args.annotate) {
    const historyDir = path.join(outputDir, 'reports', 'diagnosis-history');
    const prompt = opts.annotatePrompt ?? readlinePrompt;
    const result = await runAnnotationSession({
      historyDir,
      deps: { prompt, write },
      ...(args.annotateLimit !== undefined ? { limit: args.annotateLimit } : {}),
    });
    write(`\nAnnotation session done — ${result.annotatedNow} entries saved, ${result.skipped} skipped, ${result.errored} errors${result.quitEarly ? ' (quit early)' : ''}.\n`);
    return;
  }

  const inputPath = args.input ?? path.join(outputDir, 'results.json');

  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`pgwen diagnose: results.json not found at ${inputPath}\n`);
    process.exitCode = 2;
    return;
  }

  let report: JsonReport;
  try {
    report = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as JsonReport;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pgwen diagnose: failed to parse ${inputPath}: ${msg}\n`);
    process.exitCode = 2;
    return;
  }

  // ── Hard-rules path ──────────────────────────────────────────────────
  if (args.rulesOnly) {
    emitMarkdown(write, renderRulesOnlyMarkdown(report));
    return;
  }

  // ── Decide AI vs fall-back-to-rules ──────────────────────────────────
  const fallback = (notice: string): void => emitMarkdown(write, renderRulesOnlyMarkdown(report, notice));

  if (env['PGWEN_AI_DISABLED'] === '1') {
    return fallback('PGWEN_AI_DISABLED=1 set in the environment — AI mode short-circuited.');
  }

  // Load pgwen.conf if available.
  const configPath = args.config ?? path.join(cwd, 'pgwen.conf');
  const loaded = loadConfigSafely(configPath, opts.loadConfig);
  if (!loaded) {
    return fallback(`No pgwen.conf found at \`${configPath}\` — AI mode requires config. Run with \`--rules-only\` to silence this notice.`);
  }

  const aiEnabled = (loaded.config['pgwen.diagnose.ai.enabled'] ?? '').toLowerCase().trim() === 'true';
  if (!aiEnabled) {
    return fallback('`pgwen.diagnose.ai.enabled = true` is required for AI mode.');
  }

  const resolved = resolveApiKey(loaded.config, { env, maskedKeys: loaded.maskedKeys });
  if (resolved.key === null && !args.dryRun) {
    return fallback(`No API key resolved: ${resolved.warnings.join(' ')}`);
  }

  // ── Build AI dependencies ────────────────────────────────────────────
  const failures = collectFailedSteps(report);
  if (failures.length === 0) {
    emitMarkdown(write, renderAiMarkdown(report, [], {
      keyDescriptor: describeResolvedKey(resolved),
      dryRun: args.dryRun,
      noCache: args.noCache,
    }));
    return;
  }

  const pricing = pricingFromConfig(loaded.config);
  const budget = new BudgetGate({
    caps: budgetCapsFromConfig(loaded.config),
    dataDir: outputDir,
  });
  const rateLimit = new RateLimit(rateLimitOptionsFromConfig(loaded.config));

  // Provider selection. Precedence (highest first):
  //   1. --provider CLI flag (this run only)
  //   2. pgwen.diagnose.ai.provider config
  //   3. Default "claude" inside selectAdapter when neither is set
  // The adapter's call() returns AiCallResult, which is structurally
  // compatible with ClaudeCallResult (extra `provider` field ignored
  // by downstream consumers).
  // Empty CLI flag falls through to the config value — matches the
  // precedence test in tests/unit/cli/diagnose-provider-flag.test.ts.
  const cliProviderTrimmed = args.provider?.trim();
  const providerName =
    cliProviderTrimmed && cliProviderTrimmed.length > 0
      ? cliProviderTrimmed
      : loaded.config['pgwen.diagnose.ai.provider'];
  // Per-provider extras: read every block up-front, even though only one
  // applies — keeps the wiring local + readable. selectAdapter validates
  // the required fields for the chosen provider.
  const azureDeployment = loaded.config['pgwen.diagnose.ai.azureOpenai.deployment'];
  const azureApiVersion = loaded.config['pgwen.diagnose.ai.azureOpenai.apiVersion'];
  const azureResource = loaded.config['pgwen.diagnose.ai.azureOpenai.resource'];
  const azureOpenai = (azureDeployment !== undefined && azureApiVersion !== undefined)
    ? {
        deployment: azureDeployment,
        apiVersion: azureApiVersion,
        ...(azureResource !== undefined ? { resource: azureResource } : {}),
      }
    : undefined;
  const providerModel =
    loaded.config[`pgwen.diagnose.ai.${(providerName ?? 'claude').replace('-', '')}.model`] ??
    loaded.config['pgwen.diagnose.ai.model'];

  const claude: ClaudeClientLike = opts.makeClaudeClient
    ? opts.makeClaudeClient(resolved.key ?? 'dry-run-placeholder')
    : (selectAdapter({
        ...(providerName !== undefined ? { provider: providerName } : {}),
        apiKey: resolved.key ?? 'dry-run-placeholder',
        ...(providerModel !== undefined ? { model: providerModel } : {}),
        ...(azureOpenai !== undefined ? { azureOpenai } : {}),
      }) as unknown as ClaudeClientLike);

  const reportsDir = path.join(outputDir, 'reports');
  const extractDom = opts.extractDom;
  const locatorLookup = opts.locatorLookup ?? makeLocatorLookup(cwd);
  const recentDiffsFor = opts.recentDiffsFor ?? makeRecentDiffsFetcher(cwd);

  const allFailures = failures.map((fs0) => buildFailureToDiagnose(fs0, loaded.config));

  // Group semantically-identical failures so Claude is called once per
  // pattern, not once per failure. When --no-pattern-grouping is set, fall
  // back to a degenerate grouping (one group per failure).
  const groups = args.noPatternGrouping
    ? allFailures.map((f) => ({ fingerprint: '', representative: f, instances: [f] }))
    : groupFailures(allFailures, locatorLookup);

  const entries: AiReportEntry[] = [];
  for (const group of groups) {
    try {
      const result = await runAiDiagnose(
        group.representative,
        {
          claude,
          reportsDir,
          budget,
          rateLimit,
          pricing,
          locatorLookup,
          recentDiffsFor,
          ...(extractDom ? { extractDom } : {}),
        },
        {
          noCache: args.noCache,
          dryRun: args.dryRun,
        },
      );
      entries.push({ ...result, instances: group.instances });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entries.push({
        failure: group.representative,
        source: 'skipped',
        output: null,
        reason: `claude-error: ${msg}`,
        cacheKey: '',
        instances: group.instances,
      });
    }
  }

  emitMarkdown(write, renderAiMarkdown(report, entries, {
    keyDescriptor: describeResolvedKey(resolved),
    dryRun: args.dryRun,
    noCache: args.noCache,
  }));

  // Optionally persist the structured entries for `@pgwen/fix` to consume.
  // Each entry includes the failure context, the rule-based prior, and the
  // full DiagnoseOutput. Entries with no `output` (skipped, errored) are
  // emitted too — the consumer decides what to do with them.
  if (args.jsonOut !== undefined) {
    const fixInputEntries = entries
      .filter((e) => e.output !== null)
      .map((e) => ({
        failure: {
          feature_file: e.failure.feature.file,
          feature_name: e.failure.feature.name,
          scenario_name: e.failure.scenario.name,
          step_keyword: e.failure.step.keyword,
          step_text: e.failure.step.text,
          error_class: e.failure.step.errorClass,
          error_message: e.failure.step.errorMessage,
        },
        ...(e.failure.prior !== null ? {
          classification: {
            class: e.failure.prior.class,
            confidence: e.failure.prior.confidence,
            signals: e.failure.prior.signals,
          },
        } : {}),
        // Affected instances (representative first). Always populated when
        // grouping is on; `[representative]` when grouping is off.
        ...(e.instances && e.instances.length > 0 ? {
          instances: e.instances.map(projectInstance),
        } : {}),
        output: e.output,
      }));
    const outPath = path.resolve(cwd, args.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(fixInputEntries, null, 2) + '\n', 'utf8');
  }
}

function loadConfigSafely(
  configPath: string,
  inject?: (p: string) => LoadResult | null,
): LoadResult | null {
  if (inject) return inject(configPath);
  if (!fs.existsSync(configPath)) return null;
  try {
    return loadFileWithMasked(configPath);
  } catch {
    return null;
  }
}

function emitMarkdown(write: (s: string) => void, md: string): void {
  write(md);
  if (!md.endsWith('\n')) write('\n');
}

/**
 * Default annotation prompt — readline-backed, line-buffered. Re-prompts
 * until the reply is one of the allowed keys (case-insensitive, trimmed).
 * Used only when `pgwen diagnose --annotate` runs without
 * `opts.annotatePrompt` injected.
 */
async function readlinePrompt(label: string, allowed: ReadonlyArray<string>): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => rl.question(`${label}: `, resolve));
      const key = answer.trim().toLowerCase();
      if (allowed.includes(key)) return key;
      process.stdout.write(`  (expected one of: ${allowed.join(', ')})\n`);
    }
  } finally {
    rl.close();
  }
}
