/**
 * execution/Runner.ts — Orchestrate single-feature execution.
 *
 * The Runner is the top-level coordinator for running one .feature file:
 *
 *   1. Load meta — common (via -m flag) then associative (.feature → .meta)
 *   2. Parse the feature file into a ParsedFeature AST
 *   3. Optionally load a CSV/JSON data feed and iterate per record
 *   4. For each scenario:
 *        - Skip @Ignore scenarios
 *        - Expand Scenario Outlines (inline Examples or external @Examples file)
 *        - Execute background steps + scenario steps via Compositor
 *        - Write @Results output row after each scenario if configured
 *   5. Return a structured RunResult with per-scenario pass/fail status
 *
 * This class holds no mutable state between runFeature() calls — create one
 * instance and call it repeatedly, or create per-call.
 */

import * as path from 'path';
import {
  GherkinParser,
  type ParsedScenario,
  type ParsedStep,
} from '../engine/GherkinParser';
import { createDslResolver, builtinRegistry } from '../dsl/index';
import { MetaEngine, type LoadedMetaFile } from '../engine/MetaEngine';
import { Compositor, type StepResult, type DslResolver } from '../engine/Compositor';
import { Scope } from '../engine/Scope';
import { StringInterpolator } from '../engine/StringInterpolator';
import { parseAnnotations } from '../annotations/Annotations';
import {
  parseCsvFeed,
  bindRecordToScope,
  type DataRecord,
} from '../data/CsvFeedReader';
import { parseJsonFeed, bindJsonRecordToScope } from '../data/JsonFeedReader';
import {
  loadExternalExamples,
  expandOutlineRow,
} from '../data/ExamplesLoader';
import {
  initResultsFile,
  appendResultRow,
  buildResultRowFromScope,
} from '../data/ResultsWriter';
import type { ResultsReporter } from './ResultsReporter';
import { TagFilter } from './TagFilter';
import type { SyncGate } from './SyncGate';
import { ImplicitValues, type ExecutionContext, type RuleContext } from '../engine/ImplicitValues';
import { reclassifyByLocatorAncestor } from '../diagnose/Classifier';
import { computeBindingStats } from '../diagnose/BindingStats';

// ─── Public types ────────────────────────────────────────────────────────────

export interface RunOptions {
  /** One or more common .meta files or directories to load before execution. */
  meta?: string[];
  /** Path to a CSV/JSON input data feed — iterates one full feature run per record. */
  dataFeed?: string;
  /** Results output file path. Overrides any @Results annotation on the feature. */
  resultsFile?: string;
  /** Columns to write in results CSV. Default: ['STATUS', 'RECORD_ID', 'FAILED_REASON']. */
  resultsColumns?: string[];
  /** DSL resolver function wiring Playwright handlers into the execution chain. */
  dslResolver?: DslResolver;
  /** Playwright Page instance passed through to step handlers. */
  page?: unknown;
  /**
   * Factory that creates a fresh Playwright Page for each data-feed iteration.
   * When provided, the Runner calls this at the start of each iteration so that
   * a page closed by the project (e.g. via "I close the current browser") does not
   * break subsequent records. The factory is responsible for configuring the page
   * (viewport, timeout, etc.) before returning it.
   * When absent, options.page is used for all iterations (existing behaviour).
   */
  pageFactory?: () => Promise<unknown>;
  /**
   * Base directory for resolving relative paths in @Examples annotations.
   * Defaults to the directory containing the feature file.
   */
  baseDir?: string;
  /**
   * Tag filter expression — scenarios not matching this are skipped.
   * Empty/undefined means no filtering (all scenarios run).
   */
  tagFilter?: string;
  /**
   * Scenario name filter — only scenarios whose name exactly matches this
   * are run; others are skipped. Used by AI-fix prep work and by humans
   * who want to re-run a single scenario after a fix.
   *
   * Match is exact (case-sensitive). For @Examples expansions, the base
   * scenario name (without the "[N of M]" suffix) is what's matched.
   * Empty/undefined means no scenario-name filtering.
   */
  scenarioName?: string;
  /**
   * Stop running scenarios within a feature after the first failure.
   * Maps to pgwen.feature.failfast.enabled. Default: false.
   */
  failfastEnabled?: boolean;
  /**
   * Scope reset behaviour between scenarios.
   * 'scenario' — feature-level bindings are cleared before each scenario.
   * 'feature'  — bindings accumulate across scenarios (default).
   * Maps to pgwen.state.level.
   */
  stateLevel?: 'scenario' | 'feature';
  /**
   * Behaviour rules enforcement mode.
   * 'strict'  — @Context/@Action/@Assertion keyword constraints enforced (default).
   * 'lenient' — constraints ignored; any keyword may call any StepDef.
   * Maps to pgwen.behavior.rules.
   */
  behaviourRules?: 'strict' | 'lenient';
  /**
   * Shared async mutex passed by parallel runners so that @Synchronized StepDefs
   * execute exclusively across concurrent feature runs.
   */
  syncGate?: SyncGate;
  /**
   * Called just before a @Breakpoint StepDef executes.
   * Typically opens an interactive REPL in headed mode.
   * If not provided, @Breakpoint is silently ignored.
   */
  breakpointHandler?: (scope: Scope, page: unknown, stepText: string) => Promise<void>;
  /**
   * Config-driven results CSV reporter.
   * When set, writes one row to the configured CSV files after each feature
   * iteration (one per data-feed record, or once if no feed). The scope must
   * contain the appropriate bindings (CSV columns + pgwen.feature.eval.status.*).
   */
  resultsReporter?: ResultsReporter;
  /**
   * Named results reporter callbacks from `ResultsReporter.namedFromConfig()`.
   * When a StepDef carries `@Results('name')`, the matching callback is invoked
   * after the StepDef executes (one row per StepDef call, not per feature record).
   */
  namedResultsReporters?: ReadonlyMap<string, (scope: Scope, status: 'Passed' | 'Failed') => void>;
  /**
   * Browser context session ID — set by PlaywrightRunner after context creation.
   * Exposed as ${pgwen.web.sessionId} in steps (e.g. for constructing Selenoid download URLs).
   * Defaults to empty string when not provided.
   */
  webSessionId?: string;
  /**
   * Absolute path to the directory where Playwright saves downloaded files.
   * Set by PlaywrightRunner when the browser context is created.
   * Exposed as ${pgwen.downloadDir} in steps.
   * Defaults to empty string when not provided (non-browser runs).
   */
  downloadDir?: string;
  /**
   * Loaded pgwen.conf + profile config flat map.
   * When provided, config keys (e.g. project.name, pgwen.web.wait.seconds) are
   * resolvable as ${key} in feature steps via StringInterpolator's settings
   * provider — mirroring config-to-scope wiring.
   */
  config?: Record<string, string>;
  /**
   * Set of config keys that were declared with the `:masked` suffix.
   * When provided, these values are displayed as `*****` in console and HTML
   * report step text while DSL handlers still receive the real value.
   * Populated automatically from loadLayeredWithMasked() in the launcher.
   */
  maskedSettings?: ReadonlySet<string>;
  /**
   * When true, steps annotated with @DryRun('value') are substituted: the value
   * is bound to scope and the step returns passed without executing.
   * Passed through to CompositorOptions.dryRun.
   */
  dryRun?: boolean;
  /**
   * Active profile name (the -p argument passed to the CLI).
   * Available in steps as ${pgwen.profile.name}.
   */
  profileName?: string;
  /**
   * Target environment name (pgwen.target.env config key).
   * Available in steps as ${pgwen.target.env}.
   */
  targetEnv?: string;
  /**
   * Global assertion mode — mirrors pgwen.assertion.mode in pgwen.conf.
   * 'soft'      — all assertion failures accumulate; execution continues; failures reported at end
   * 'sustained' — all assertion failures accumulate silently; never surfaced as failures
   * 'hard'      — first failure stops execution (default)
   * Per-step @Soft / @Sustained / @Hard annotations override this global mode.
   */
  assertionMode?: 'hard' | 'soft' | 'sustained';
  /**
   * When false, the runner will NOT auto-discover associative .meta files
   * alongside the feature file. Mirrors pgwen.auto.discover.meta in pgwen.conf.
   * Default: true (auto-discovery enabled).
   */
  autoDiscoverMeta?: boolean;
  /**
   * 1-based sequence number for this feature within the current execution run.
   * Populates ${pgwen.feature.eval.sequenceNo}. Defaults to 0 (unset).
   */
  sequenceNo?: number;
  /**
   * Called immediately after the top-level Scope is created for this feature run.
   * The caller can hold a reference to the live Scope so that after execution
   * completes the final state (all bound variables) remains accessible — used by
   * PlaywrightRunner to pass the retained scope to the post-execution REPL.
   */
  onScopeCreated?: (scope: Scope) => void;
  /**
   * Called just before the feature-level Scope frame is popped at the end of
   * runFeature(). The scope still has all bindings from the last scenario.
   * Used by PlaywrightRunner to snapshot the final scope state for REPL retention.
   */
  onFeatureComplete?: (scope: Scope) => void;
  /**
   * Called at the end of each scenario execution, just before the scenario-level
   * Scope frame is popped. The scope has all frames including the scenario frame,
   * so @Eager-evaluated bindings (e.g. todayIso) are still accessible.
   * Called for every scenario — the last call captures the final state, which is
   * what the post-execution REPL should inherit.
   */
  onScenarioComplete?: (scope: Scope) => void;
  /**
   * Called as soon as each data-feed record's RunResult is finalised — before
   * moving on to the next record. Receives the just-completed RunResult.
   * For non-feed features (single record) this fires once at the end.
   *
   * Preserves per-record streaming: reports update progressively for each
   * CSV/JSON record rather than waiting for the whole batch to finish. May
   * return a promise; the runner awaits it before iterating the next record.
   */
  onRecordComplete?: (result: RunResult) => void | Promise<void>;
}

export interface ScenarioRunResult {
  scenarioName: string;
  status: 'passed' | 'failed' | 'skipped';
  steps: StepResult[];
  error?: Error;
  /** Present when execution is driven by a data feed: 0-based record index. */
  recordIndex?: number;
  /** Present when execution is driven by a data feed: 1-based record number. */
  recordNumber?: number;
  /** Present when execution is driven by a data feed: total number of records. */
  recordTotal?: number;
  /**
   * Number of steps at the start of the steps array that came from the Feature's
   * Background section. When > 0, the HTML reporter splits them into a separate
   * Background ScenarioTrace (isBackground=true) preceding the Scenario trace.
   */
  backgroundStepCount?: number;
  /**
   * Path to the data feed file driving this run (e.g. "pgwen/input/data.csv").
   * Forwarded to the Background ScenarioTrace so the HTML report can show the
   * "Input data file: …" line inside the collapsed Background section.
   */
  dataFeedFile?: string;
  /**
   * The raw column-value pairs from the data feed record for this iteration.
   * Used by ConsoleReporter to print the "Background: Input data record" section
   * with `@Data` binding lines (matching console output).
   */
  dataFeedRecord?: Record<string, string>;
  /** Scenario execution duration in milliseconds. */
  durationMs: number;
  /**
   * Full scope dump captured at scenario failure time.
   * Written as the "Environment" attachment in the HTML report.
   * Absent for passing scenarios.
   */
  scopeDump?: string;
  /**
   * Absolute path to the failure screenshot, if captured.
   * Written as the "Screenshot" attachment in the HTML report.
   * Absent when screenshot capture is disabled or scenario passed.
   */
  screenshotPath?: string;
}

export interface RunResult {
  featureFile: string;
  featureName: string;
  /** Overall status: failed if any scenario failed, otherwise passed. */
  status: 'passed' | 'failed';
  scenarios: ScenarioRunResult[];
  /** Feature execution duration in milliseconds. */
  durationMs: number;
  /** When feature execution started. */
  startTime: Date;
  /** When feature execution finished. */
  endTime: Date;
  /**
   * Meta files loaded for this feature (common + associative), in load order.
   * Used by the HTML reporter to render the "Meta" section.
   */
  metaFiles?: LoadedMetaFile[];
  /**
   * Absolute paths to recorded video files for this feature execution.
   * Populated by PlaywrightRunner after context.close() finalises the recording.
   */
  videoPaths?: string[];
  /**
   * Absolute path to the Playwright trace.zip captured for this feature run.
   * Only populated when `pgwen.web.capture.trace = on` (or
   * `retain-on-failure` + the run actually failed). Consumed by
   * AI-assisted diagnosis tooling to extract pre-failure DOM snapshots.
   */
  tracePath?: string;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export class Runner {
  private readonly parser: GherkinParser;

  constructor() {
    this.parser = new GherkinParser();
  }

  /**
   * Execute a single .feature file and return one RunResult per data-feed record
   * (or a single-element array when no data feed is present).
   */
  async runFeature(featureFile: string, options: RunOptions = {}): Promise<RunResult[]> {
    const absoluteFeatureFile = path.resolve(featureFile);
    const baseDir = options.baseDir ?? path.dirname(absoluteFeatureFile);

    // 1. Load meta: common first (lowest precedence), then associative (highest)
    const metaEngine = new MetaEngine(this.parser);
    for (const metaPath of options.meta ?? []) {
      metaEngine.loadCommon(metaPath);
    }
    // Auto-discover associative .meta unless explicitly disabled via option or config key
    const autoDiscoverMeta = options.autoDiscoverMeta ??
      (options.config?.['pgwen.auto.discover.meta'] !== 'false');
    if (autoDiscoverMeta) {
      metaEngine.loadAssociative(absoluteFeatureFile);
    }

    // Apply behaviour rules mode (strict by default, lenient when configured)
    if (options.behaviourRules) {
      metaEngine.registry.setBehaviourMode(options.behaviourRules);
    }

    // 2. Parse feature
    const feature = this.parser.parseFile(absoluteFeatureFile);
    const featureAnnotations = parseAnnotations(feature.tags);

    // 3. Determine results file and initialise it (write header row)
    const resultsFilePath = options.resultsFile ?? featureAnnotations.resultsFile;
    const resultsColumns = options.resultsColumns ?? ['STATUS', 'RECORD_ID', 'FAILED_REASON'];
    if (resultsFilePath) {
      initResultsFile(resultsFilePath, resultsColumns);
    }

    // 4. Create tag filter (matches all if no expression given)
    const tagFilter = TagFilter.fromExpression(options.tagFilter);

    // 5. Create top-level scope and load data feed
    const scope = new Scope();
    scope.push('feature');

    // Notify caller of the live Scope reference so it can be retained for post-run
    // inspection (e.g. passing scope state to the REPL after execution).
    options.onScopeCreated?.(scope);

    // 5a. Wire all pgwen.* implicit values into scope.
    // The ExecutionContext reference is mutated as the run progresses — lazy resolvers
    // read from it at access time so callers always see up-to-date values.
    const ctx: ExecutionContext = {
      feature: {
        uri: absoluteFeatureFile,
        name: feature.name,
        startTime: new Date(),
        sequenceNo: options.sequenceNo ?? 0,
      },
      ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
      ...(options.targetEnv   !== undefined ? { targetEnv: options.targetEnv }     : {}),
      ...(options.webSessionId !== undefined ? { webSessionId: options.webSessionId } : {}),
      ...(options.downloadDir   !== undefined ? { downloadDir: options.downloadDir }   : {}),
      accumulatedErrors: [],
    };
    // Resolve assertionMode from options or from config key 'pgwen.assertion.mode'
    const rawAssertionMode =
      options.assertionMode ??
      (options.config?.['pgwen.assertion.mode'] as 'hard' | 'soft' | 'sustained' | undefined);
    ImplicitValues.register(scope, ctx);

    // 5b. Expose web-behaviour config keys in scope so DSL step handlers can read them
    // via scope.get() (config is otherwise only accessible via StringInterpolator.settings).
    if (options.config) {
      const webKeys = [
        'pgwen.web.implicit.element.moveTo',
        'pgwen.web.implicit.element.focus',
        'pgwen.web.throttle.msecs',
        'pgwen.web.sendKeys.clearFirst',
        'pgwen.web.sendKeys.clickFirst',
        'pgwen.web.highlight.style',
        'pgwen.web.suppress.images',
      ];
      for (const key of webKeys) {
        const val = options.config[key];
        if (val !== undefined) scope.set(key, val);
      }
    }

    // 6. Resolve DSL resolver — use provided override (for testing) or create
    //    one bound to Runner's own scope so DSL step writes are visible to
    //    StringInterpolator.
    //
    // `stepDefRunnerRef` is back-filled by `runScenario` with the Compositor's
    // substep runner once the Compositor is constructed. Loop handlers
    // (for-each / while / until) consult it BEFORE falling back to DSL
    // pattern match — necessary for substeps that target a user-defined
    // StepDef. Without this back-fill, substep StepDefs throw
    // "No DSL handler matched".
    const stepDefRunnerRef: { current: ((text: string, page: unknown) => Promise<void>) | undefined } = { current: undefined };
    const dslResolver = options.dslResolver ?? createDslResolver(scope, async (text, page) => {
      if (!stepDefRunnerRef.current) {
        throw new Error('No matching stepdef — Compositor runner not yet wired');
      }
      await stepDefRunnerRef.current(text, page);
    });

    const feedRecords = loadDataFeed(options.dataFeed, options.config);

    // 7. Execute — once per feed record, or once if no feed
    const iterations = feedRecords.length > 0 ? feedRecords.length : 1;
    const allResults: RunResult[] = [];

    // Effective page for this iteration — the initial page (passed as options.page)
    // is used for the first record; pageFactory creates a fresh page for each
    // subsequent record so that a page closed by the project (e.g. "I close the current
    // browser") does not corrupt later records.
    // Using options.page for iteration 0 avoids an orphaned blank tab in headed mode.
    // currentPage is the LAZY PROXY supplied by PlaywrightRunner. It remains
    // the same reference across all iterations — the proxy's underlying
    // `activePage` is swapped by pageFactory(). Holding the proxy preserves
    // window-switching hooks (`__pgwenSetActivePage`, etc.) for every
    // iteration; if we replaced the proxy with the raw page from pageFactory,
    // subsequent `I switch to the child window` calls would silently no-op
    // because raw pages have no setter hook.
    const currentPage: unknown = options.page;

    for (let recordIdx = 0; recordIdx < iterations; recordIdx++) {
      // Refresh underlying page via factory starting from the second
      // iteration. pageFactory closes the previous active page (if open)
      // and mutates the proxy's activePage to the fresh one.
      if (recordIdx > 0 && options.pageFactory) {
        try { await (currentPage as { close(): Promise<void> }).close(); } catch { /* already closed by project */ }
        await options.pageFactory();
      }

      const recordStart = Date.now();
      const recordStartTime = new Date();

      if (feedRecords.length > 0) {
        // Clear readonly locks from the previous iteration before binding new record
        scope.clearAllReadonly();
        const feedReadOnly = (options.config?.['pgwen.input.data.readOnly'] ?? 'true') !== 'false';
        const maskFields = parseMaskFields(options.config?.['pgwen.input.data.maskFields']);
        bindFeedRecord(feedRecords[recordIdx]!, recordIdx, scope, options.dataFeed!, feedReadOnly, maskFields);
      }

      // Resolve the feature name for this specific record.
      // Feature name may contain ${bindings} resolved after feed data is bound.
      let recordFeatureName = feature.name;
      try {
        const nameInterpolator = new StringInterpolator(scope, {
          settings: (key) => options.config?.[key],
          isMaskedSetting: (key) => options.maskedSettings?.has(key) ?? false,
        });
        recordFeatureName = nameInterpolator.interpolate(feature.name);
        // Also update ctx so pgwen.feature.name implicit value reflects resolved name
        if (ctx?.feature) ctx.feature.name = recordFeatureName;
      } catch {
        // Leave recordFeatureName as the raw template string
      }

      // Update ctx start time and record position for this record
      if (ctx?.feature) {
        ctx.feature.startTime = recordStartTime;
        if (feedRecords.length > 0) {
          ctx.feature.recordIndex = recordIdx;
          ctx.feature.recordTotal = iterations;
        }
      }

      const recordScenarios: ScenarioRunResult[] = [];
      let failfastTriggered = false;

      for (const scenario of feature.scenarios) {
        if (failfastTriggered) {
          // Mark remaining scenarios as skipped rather than silently dropping them
          recordScenarios.push({
            scenarioName: scenario.name,
            status: 'skipped',
            steps: [],
            durationMs: 0,
          });
          continue;
        }

        const annotations = parseAnnotations(scenario.tags);

        // Skip @Ignore
        if (annotations.isIgnore) continue;

        // Skip scenarios that don't match the tag filter
        if (!tagFilter.matches(scenario.tags)) {
          recordScenarios.push({
            scenarioName: scenario.name,
            status: 'skipped',
            steps: [],
            durationMs: 0,
          });
          continue;
        }

        // Skip scenarios that don't match the --scenario name filter
        if (options.scenarioName && scenario.name !== options.scenarioName) {
          recordScenarios.push({
            scenarioName: scenario.name,
            status: 'skipped',
            steps: [],
            durationMs: 0,
          });
          continue;
        }

        // pgwen.state.level = "scenario" — clear feature-level bindings before each scenario
        // so no state leaks between scenarios (Preserves per-scenario isolation mode)
        if ((options.stateLevel ?? 'feature') === 'scenario') {
          scope.clear('feature');
        }

        // Wire Rule context so pgwen.rule.* implicit values resolve for this scenario.
        // Scenarios inside a Rule block have ruleName set; top-level scenarios have undefined.
        if (ctx) {
          if (scenario.ruleName !== undefined) {
            // Enter or stay in the rule — re-use existing ctx.rule if same rule name
            if (ctx.rule?.name !== scenario.ruleName) {
              ctx.rule = { name: scenario.ruleName, startTime: new Date() };
            }
          } else {
            // Top-level scenario — clear any previous rule context
            delete ctx.rule;
          }
        }

        if (scenario.isOutline) {
          const outlineResults = await this.runOutline(
            scenario,
            feature.background?.steps ?? [],
            metaEngine,
            scope,
            { ...options, page: currentPage },
            dslResolver,
            baseDir,
            recordIdx,
            feedRecords.length > 0,
            annotations.isParallel,
            annotations.isForEach,
            ctx,
            rawAssertionMode,
            absoluteFeatureFile,
            stepDefRunnerRef
          );
          // Set recordTotal and dataFeedRecord on outline results when hasFeed
          if (feedRecords.length > 0) {
            for (const r of outlineResults) {
              r.recordTotal = iterations;
              const rec = feedRecords[recordIdx]; if (rec) r.dataFeedRecord = rec;
            }
          }
          recordScenarios.push(...outlineResults);

          // Write @Results for each expanded outline row
          if (resultsFilePath) {
            for (const r of outlineResults) {
              const row = buildResultRowFromScope(scope, resultsColumns);
              appendResultRow(resultsFilePath, row, resultsColumns);
            }
          }

          if (options.failfastEnabled && outlineResults.some((r) => r.status === 'failed')) {
            failfastTriggered = true;
          }
        } else {
          const result = await this.runScenario(
            scenario,
            feature.background?.steps ?? [],
            metaEngine,
            scope,
            { ...options, page: currentPage },
            dslResolver,
            recordIdx,
            feedRecords.length > 0,
            ctx,
            rawAssertionMode,
            absoluteFeatureFile,
            stepDefRunnerRef
          );
          // Set recordTotal and dataFeedRecord when hasFeed
          if (feedRecords.length > 0) {
            result.recordTotal = iterations;
            const feedRec = feedRecords[recordIdx]; if (feedRec) result.dataFeedRecord = feedRec;
          }
          recordScenarios.push(result);

          if (resultsFilePath) {
            const row = buildResultRowFromScope(scope, resultsColumns);
            appendResultRow(resultsFilePath, row, resultsColumns);
          }

          if (options.failfastEnabled && result.status === 'failed') {
            failfastTriggered = true;
          }
        }
      }

      // Bind pgwen.feature.eval.status.* for this record's execution so that
      // ResultsReporter can read them (Preserves implicit value population).
      const recordFailed = recordScenarios.some((r) => r.status === 'failed');
      const recordError = recordScenarios.find((r) => r.status === 'failed')?.error;
      const statusKeyword = recordFailed ? 'Failed' : 'Passed';
      const statusMessage = recordError?.message ?? '';
      // Update ctx so ImplicitValues lazy resolvers reflect the latest status
      if (ctx?.feature) {
        ctx.feature.status = recordFailed ? 'Failed' : 'Passed';
        ctx.feature.endTime = new Date();
        ctx.feature.errorMessage = statusMessage;
      }
      // Also write direct bindings so ResultsReporter/ResultsWriter can read them
      // synchronously without going through the lazy resolver chain.
      scope.set('pgwen.feature.eval.status.keyword', statusKeyword);
      scope.set('pgwen.feature.eval.status.keyword.upperCased', statusKeyword.toUpperCase());
      scope.set('pgwen.feature.eval.status.keyword.lowerCased', statusKeyword.toLowerCase());
      scope.set('pgwen.feature.eval.status.isPassed', recordFailed ? 'false' : 'true');
      scope.set('pgwen.feature.eval.status.isFailed', recordFailed ? 'true' : 'false');
      scope.set('pgwen.feature.eval.status.message', statusMessage);
      scope.set('pgwen.feature.eval.status.message.escaped', statusMessage.replace(/"/g, '\\"'));
      scope.set('pgwen.feature.eval.status.message.csvEscaped', statusMessage.replace(/"/g, '""'));

      // Write config-driven results CSV row (one per feed record / feature execution)
      if (options.resultsReporter) {
        options.resultsReporter.appendRow(scope, recordFailed ? 'Failed' : 'Passed');
      }

      // ── End-of-record reclassification pass ──────────────────────────────
      // Walk every scenario's step tree and post-process ASSERTION_FAILED →
      // LOCATOR_NOT_FOUND for genuine locator timeouts. Cross-scenario
      // binding-success-rate stats are computed first so failures involving
      // a binding that worked elsewhere in this record are NOT flipped.
      // Mutates step.failureClass in place; the recordResult below picks up
      // the rewritten classifications.
      const waitSecondsRaw = options.config?.['pgwen.web.wait.seconds'];
      const waitSeconds = waitSecondsRaw !== undefined ? parseFloat(waitSecondsRaw) : 30;
      if (Number.isFinite(waitSeconds) && waitSeconds > 0 && recordScenarios.length > 0) {
        const bindingStats = computeBindingStats(recordScenarios);
        for (const sc of recordScenarios) {
          reclassifyByLocatorAncestor(sc.steps, {
            waitMs: waitSeconds * 1000,
            bindingStats,
          });
        }
      }

      const recordResult: RunResult = {
        featureFile: absoluteFeatureFile,
        featureName: recordFeatureName,
        status: recordFailed ? 'failed' : 'passed',
        scenarios: recordScenarios,
        durationMs: Date.now() - recordStart,
        startTime: recordStartTime,
        endTime: new Date(),
        metaFiles: metaEngine.loadedMeta,
      };
      allResults.push(recordResult);

      // Per-record streaming hook — fire as soon as this record's result is
      // finalised so reporters can emit progressively (preserves behaviour
      // where each CSV record's HTML page appears as that record completes,
      // rather than waiting for the whole file to finish).
      if (options.onRecordComplete) {
        await options.onRecordComplete(recordResult);
      }
    }

    // Notify caller before popping so it can snapshot the live scope state
    // (all user bindings are still present at this point).
    options.onFeatureComplete?.(scope);

    scope.pop();
    return allResults;
  }

  // ─── Internal execution ──────────────────────────────────────────────────

  private async runScenario(
    scenario: ParsedScenario,
    backgroundSteps: ParsedStep[],
    metaEngine: MetaEngine,
    scope: Scope,
    options: RunOptions,
    dslResolver: import('../engine/Compositor').DslResolver,
    recordIdx: number,
    hasFeed: boolean,
    ctx?: ExecutionContext,
    assertionMode?: 'hard' | 'soft' | 'sustained',
    featureFilePath?: string,
    stepDefRunnerRef?: { current: ((text: string, page: unknown) => Promise<void>) | undefined }
  ): Promise<ScenarioRunResult> {
    const scenarioStart = Date.now();
    scope.push('scenario');
    scope.set('pgwen.scenario.name', scenario.name);

    // Update ExecutionContext so pgwen.scenario.* implicit values resolve correctly
    if (ctx) {
      ctx.scenario = { name: scenario.name, startTime: new Date() };
    }

    const interpolator = new StringInterpolator(scope, {
      settings: (key) => options.config?.[key],
      isMaskedSetting: (key) => options.maskedSettings?.has(key) ?? false,
    });
    const compositor = new Compositor(
      metaEngine.registry,
      scope,
      interpolator,
      dslResolver,
      {
        ...(options.syncGate !== undefined ? { syncGate: options.syncGate } : {}),
        ...(options.breakpointHandler !== undefined ? { breakpointHandler: options.breakpointHandler } : {}),
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(assertionMode !== undefined ? { assertionMode } : {}),
        ...(ctx !== undefined ? { ctx } : {}),
        ...(options.namedResultsReporters !== undefined ? { namedResultsReporters: options.namedResultsReporters } : {}),
        ...(featureFilePath !== undefined ? { featureFile: featureFilePath } : {}),
        ...parseMaxStrikesOption(options.config),
        // Tie the rule-based failure classifier to the built-in DSL registry's
        // category metadata. Test overrides pass their own resolver and may
        // not have category info; in that case the classifier still runs but
        // without the handlerCategory signal.
        dslCategoryFor: (stepText) => builtinRegistry.categoryFor(stepText),
      }
    );

    // Back-fill the StepDef substep runner now that the Compositor exists.
    // The ref is captured by the dslResolver in executeFeature so loop
    // handlers (for-each / while / until) can resolve substeps that
    // target StepDefs.
    if (stepDefRunnerRef) {
      stepDefRunnerRef.current = (text, page) => compositor.runSubStep(text, page);
    }

    // Register pgwen.accumulated.errors as a live lazy binding so DSL steps like
    // "there should be no accumulated errors" can read soft/sustained errors at any
    // point during scenario execution — the resolver is evaluated on every access.
    scope.setLazy('pgwen.accumulated.errors', () => {
      const all = [...compositor.softErrors, ...compositor.sustainedErrors];
      return all.length === 0
        ? ''
        : all.map((e, i) => `${i + 1}. ${e.message}`).join('\n');
    });
    scope.setLazy('pgwen.accumulated.errors:JSONArray', () =>
      JSON.stringify(
        [...compositor.softErrors, ...compositor.sustainedErrors].map((e) => e.message)
      )
    );
    // Side-effect lazy: calling scope.get('pgwen._accumulated_errors_clear') clears both arrays.
    // Used by the "I reset accumulated errors" DSL step.
    scope.setLazy('pgwen._accumulated_errors_clear', () => {
      compositor.softErrors.splice(0);
      compositor.sustainedErrors.splice(0);
      return '';
    });

    const allSteps: ParsedStep[] = [...backgroundSteps, ...scenario.steps];
    let steps: StepResult[] = [];
    let status: 'passed' | 'failed' = 'passed';
    let topError: Error | undefined;

    try {
      // In dryRun mode, continue past failures so all steps are validated and all
      // errors are collected. Outside dryRun, fail-fast within the scenario is default.
      steps = await compositor.executeSteps(allSteps, options.page, 0, options.dryRun === true);

      // NOTE: locator-ancestor reclassification is now run AFTER all scenarios
      // in this record complete (see runFeature), so it has cross-scenario
      // binding-success-rate context. Per-scenario reclassification was the
      // previous behaviour but it couldn't tell "binding works elsewhere" from
      // "binding is broken everywhere".

      if (steps.some((s) => s.status === 'failed')) {
        status = 'failed';
        topError = steps.find((s) => s.error)?.error;
      }

      // Surface accumulated @Soft assertion failures — any soft errors mean the
      // scenario is failed even though individual steps reported passed.
      if (compositor.softErrors.length > 0) {
        status = 'failed';
        if (!topError) {
          topError = new Error(
            `${compositor.softErrors.length} soft assertion(s) failed:\n` +
            compositor.softErrors
              .map((e, i) => `  ${i + 1}. ${e.message}`)
              .join('\n')
          );
        }
      }
    } catch (err) {
      status = 'failed';
      topError = err instanceof Error ? err : new Error(String(err));
    }

    // Bind @Sustained error status to scope so project authors can assert it explicitly:
    //   Then pgwen.feature.isSustainedError should be "false"
    scope.set('pgwen.feature.isSustainedError',
      compositor.sustainedErrors.length > 0 ? 'true' : 'false');

    // Update ExecutionContext scenario status so pgwen.scenario.eval.status.* resolves correctly
    if (ctx?.scenario) {
      ctx.scenario.status = status === 'passed' ? 'Passed' : 'Failed';
      ctx.scenario.endTime = new Date();
      ctx.scenario.errorMessage = topError?.message ?? '';
    }

    // Capture scope dump for failed scenarios BEFORE pop() so all scenario-level
    // bindings are still visible. Written as the "Environment" attachment in HTML.
    let scopeDump: string | undefined;
    if (status === 'failed') {
      scopeDump = buildScopeDump(scope, scenario.name);
    }

    // Notify caller before popping — all scenario-level bindings (including
    // @Eager-evaluated values like todayIso) are still present here.
    // Called for every scenario; the last call wins for REPL scope retention.
    options.onScenarioComplete?.(scope);

    scope.pop();

    const result: ScenarioRunResult = {
      scenarioName: scenario.name,
      status,
      steps,
      durationMs: Date.now() - scenarioStart,
    };
    if (topError !== undefined) result.error = topError;
    if (scopeDump !== undefined) result.scopeDump = scopeDump;
    if (backgroundSteps.length > 0) result.backgroundStepCount = backgroundSteps.length;
    if (hasFeed) {
      result.recordIndex = recordIdx;
      result.recordNumber = recordIdx + 1;
      if (options.dataFeed) result.dataFeedFile = options.dataFeed;
    }
    return result;
  }

  private async runOutline(
    scenario: ParsedScenario,
    backgroundSteps: ParsedStep[],
    metaEngine: MetaEngine,
    scope: Scope,
    options: RunOptions,
    dslResolver: import('../engine/Compositor').DslResolver,
    baseDir: string,
    recordIdx: number,
    hasFeed: boolean,
    parallelRows = false,
    /**
     * @ForEach on Scenario Outline: in addition to substituting <COLUMN> tokens in step
     * text (standard Outline behaviour), also bind each column value into the feature
     * scope as ${COLUMN} so body steps can reference column values via interpolation.
     * This preserves @ForEach/@DataTable semantics where rows are also scope-bound.
     */
    bindColumnsToScope = false,
    ctx?: ExecutionContext,
    assertionMode?: 'hard' | 'soft' | 'sustained',
    featureFilePath?: string,
    stepDefRunnerRef?: { current: ((text: string, page: unknown) => Promise<void>) | undefined }
  ): Promise<ScenarioRunResult[]> {
    // Prefer external @Examples file over inline Examples table
    const externalExamples = loadExternalExamples(scenario, { baseDir });
    const examplesBlocks = externalExamples ? [externalExamples] : scenario.examples;

    if (parallelRows) {
      // @Parallel on Scenario Outline — run all rows concurrently
      const rowTasks = examplesBlocks.flatMap((examples) =>
        examples.rows.map((row) => {
          if (bindColumnsToScope) {
            examples.header.forEach((col, idx) => scope.set(col, row[idx] ?? ''));
          }
          const concrete = expandOutlineRow(scenario, examples.header, row);
          return this.runScenario(
            concrete,
            backgroundSteps,
            metaEngine,
            scope,
            options,
            dslResolver,
            recordIdx,
            hasFeed,
            ctx,
            assertionMode,
            featureFilePath,
            stepDefRunnerRef
          );
        })
      );
      return Promise.all(rowTasks);
    }

    // Sequential (default)
    const results: ScenarioRunResult[] = [];
    // Pre-count total outline rows so displayName can show [x of N]
    const totalRows = examplesBlocks.reduce((sum, ex) => sum + ex.rows.length, 0);
    let outlineRowIdx = 0;
    for (const examples of examplesBlocks) {
      for (const row of examples.rows) {
        // @ForEach: bind column values to scope before running, so ${COLUMN} interpolation
        // resolves correctly inside step bodies (standard Outline only does text substitution)
        if (bindColumnsToScope) {
          examples.header.forEach((col, idx) => scope.set(col, row[idx] ?? ''));
        }
        const concrete = expandOutlineRow(scenario, examples.header, row);
        // Wire outline position into ctx so pgwen.scenario.displayName shows [x of N]
        if (ctx?.scenario) {
          ctx.scenario.outlineIndex = outlineRowIdx;
          ctx.scenario.outlineTotal = totalRows;
        }
        // Wire examples context so pgwen.examples.* implicit values resolve correctly
        if (ctx) {
          ctx.examples = {
            name: examples.name ?? '',
            startTime: new Date(),
            recordIndex: outlineRowIdx,
            recordTotal: totalRows,
          };
        }
        const result = await this.runScenario(
          concrete,
          backgroundSteps,
          metaEngine,
          scope,
          options,
          dslResolver,
          recordIdx,
          hasFeed,
          ctx,
          assertionMode,
          featureFilePath,
          stepDefRunnerRef
        );
        results.push(result);
        outlineRowIdx++;
      }
    }
    // Clear examples context after outline completes
    if (ctx) delete ctx.examples;
    return results;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse pgwen.web.assertions.maxStrikes and pgwen.web.assertions.delayMillisecs
 * from config and return the corresponding CompositorOptions fragment.
 * 'auto' → 3 strikes, 'infinity' → Infinity, integer string → literal value.
 */
function parseMaxStrikesOption(
  config: Record<string, string> | undefined
): { maxStrikes?: number; assertionDelayMs?: number } {
  if (!config) return {};
  const result: { maxStrikes?: number; assertionDelayMs?: number } = {};
  const rawStrikes = config['pgwen.web.assertions.maxStrikes'];
  if (rawStrikes !== undefined) {
    if (rawStrikes === 'auto') {
      result.maxStrikes = 3;
    } else if (rawStrikes === 'infinity') {
      result.maxStrikes = Infinity;
    } else {
      const parsed = parseInt(rawStrikes, 10);
      if (!isNaN(parsed) && parsed > 0) result.maxStrikes = parsed;
    }
  }
  const rawDelay = config['pgwen.web.assertions.delayMillisecs'];
  if (rawDelay !== undefined) {
    const parsed = parseInt(rawDelay, 10);
    if (!isNaN(parsed) && parsed >= 0) result.assertionDelayMs = parsed;
  }
  return result;
}

/**
 * Parse pgwen.input.data.maskFields into an array of field names.
 * Accepts JSON array: ["password","token"] or comma-separated: "password,token"
 */
function parseMaskFields(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

function loadDataFeed(feedPath: string | undefined, config?: Record<string, string>): DataRecord[] {
  if (!feedPath) return [];
  const ext = path.extname(feedPath).toLowerCase();
  if (ext === '.json') {
    const autoTrim = (config?.['pgwen.auto.trim.data.json'] ?? 'false') === 'true';
    return parseJsonFeed(feedPath, { autoTrim });
  }
  const autoTrim = (config?.['pgwen.auto.trim.data.csv'] ?? 'true') !== 'false';
  return parseCsvFeed(feedPath, { autoTrim });
}

function bindFeedRecord(
  record: DataRecord,
  index: number,
  scope: Scope,
  feedPath: string,
  readOnly = false,
  maskFields: string[] = []
): void {
  const ext = path.extname(feedPath).toLowerCase();
  if (ext === '.json') {
    bindJsonRecordToScope(record, index, scope, readOnly);
  } else {
    bindRecordToScope(record, index, scope, readOnly, maskFields);
  }
}

/**
 * Build a human-readable scope dump for the "Environment" attachment.
 * Shows all user-visible bindings (excludes locators and lazy resolvers that throw).
 * Masked values are shown as "*****".
 */
function buildScopeDump(scope: Scope, scenarioName: string): string {
  const lines: string[] = [];
  lines.push(`scope : "scenario:${scenarioName}" {`);
  const names = scope.allNames();
  for (const name of names) {
    try {
      const value = scope.isMasked(name) ? '*****' : (scope.get(name) ?? '');
      lines.push(`  ${name} : "${value}"`);
    } catch {
      // Skip bindings that fail to resolve (async lazy resolvers, etc.)
    }
  }
  lines.push('}');
  return lines.join('\n');
}
