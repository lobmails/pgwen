#!/usr/bin/env node
/**
 * cli.ts — `pgwen-fix` CLI entry.
 *
 *   pgwen-fix --input <diagnose-output.json> [--reports-dir <path>]
 *             [--confidence-minimum high|medium] [--diff-max-lines N]
 *             [--dry-run]
 *
 * `<diagnose-output.json>` is the JSON array `pgwen diagnose --json-out`
 * produces — one entry per failure with the full DiagnoseOutput attached.
 *
 * Suggest-only mode: writes JSON + .patch sidecars + index.html under
 * `<reports-dir>/pgwen-fix/`. Never modifies source files or branches.
 * Optionally posts (or updates) a GitHub PR comment when
 * GITHUB_TOKEN + PGWEN_FIX_GH_PR + PGWEN_FIX_GH_REPO are all set.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FixInputEntry, FixConfig, SuggestFixOutcome } from './types';
import { runSuggestFix } from './Suggest';
import { postPullRequestComment } from './GithubCommenter';
import { readSuggestions } from './SuggestionWriter';
import { applyMachineProposal } from './PatchApplier';
import { detectPriorPgwenFix } from './RepeatFixDetector';
import { validateMinimumDiff } from './MinimumDiffValidator';

// Read version lazily so this stays a pure JS bundle without bundler magic.
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface CliArgs {
  input: string;
  reportsDir?: string | undefined;
  confidenceMinimum?: 'high' | 'medium' | undefined;
  diffMaxLines?: number | undefined;
  dryRun: boolean;
  /**
   * Auto-apply mode: validate proposal → check git history → write line +
   * branch + commit. Mutually exclusive with suggest mode; when set, the
   * suggest pipeline (.patch/.json sidecars + HTML report + PR comment)
   * does NOT run. Each proposal becomes its own pgwen-fix/<slug> branch
   * in the local working tree. Operators inspect + push manually.
   *
   * v1 contract: this is OFF unless explicitly opted into on the CLI.
   * §18 governance approvals do NOT auto-enable it.
   */
  autoApply: boolean;
  /**
   * Allow-list of path prefixes the auto-apply path will touch. Defaults
   * to `['pgwen/meta/']`. Override when the project's meta files live under
   * a non-standard prefix. Suggest-only mode reads this from FixConfig.
   */
  allowedPathPrefixes?: string[] | undefined;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { input: '', dryRun: false, autoApply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' || a === '-i') {
      args.input = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--reports-dir') {
      args.reportsDir = argv[i + 1];
      i += 1;
    } else if (a === '--confidence-minimum') {
      const v = argv[i + 1];
      if (v === 'high' || v === 'medium') args.confidenceMinimum = v;
      i += 1;
    } else if (a === '--diff-max-lines') {
      const v = parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(v) && v > 0) args.diffMaxLines = v;
      i += 1;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--auto-apply') {
      args.autoApply = true;
    } else if (a === '--allowed-path-prefix') {
      // Repeatable: `--allowed-path-prefix pgwen/meta/ --allowed-path-prefix projects/upload/meta/`
      const v = argv[i + 1];
      if (v !== undefined && v.length > 0) {
        if (args.allowedPathPrefixes === undefined) args.allowedPathPrefixes = [];
        args.allowedPathPrefixes.push(v);
      }
      i += 1;
    } else if (a === '--help' || a === '-h') {
      args.input = '__help__';
    }
  }
  return args;
}

const HELP = `pgwen-fix

Usage:
  pgwen-fix --input <diagnose-output.json> [options]

Modes (mutually exclusive — default is suggest-only):
  (default)                     suggest-only: writes .patch + .json sidecars
                                + HTML index; never modifies source.
  --auto-apply                  validate → check git history → rewrite the
                                line, create pgwen-fix/<slug>-<utc> branch,
                                commit. Local only — no push, no PR.

Options:
  --input, -i <path>            JSON file produced by \`pgwen diagnose --json-out\`
  --reports-dir <path>          Override report destination (default: reports/pgwen-fix)
  --confidence-minimum <level>  high (default) or medium  (suggest mode only)
  --diff-max-lines <N>          Cap on patch size (default: 20)
  --allowed-path-prefix <p>     Repeatable. Default: pgwen/meta/  (auto-apply only)
  --dry-run                     Print outcomes; write no files / branches
  -h, --help                    Show this help

Optional environment for PR commenting (suggest mode):
  GITHUB_TOKEN, PGWEN_FIX_GH_PR, PGWEN_FIX_GH_REPO[, GITHUB_API_URL]
`;

export interface RunCliDeps {
  write?: (s: string) => void;
  /** Inject env. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Inject `fetch` for GitHub-comment testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Auto-apply pipeline: validate → check git history → write line + branch +
 * commit. Each entry runs through the full pipeline independently; one
 * failed entry doesn't stop the batch.
 *
 * Returns exit code 0 when every applicable entry applied cleanly,
 * 1 when ≥1 was rejected (including pre-application gates). Operators
 * who need strict "all-or-nothing" run with `--dry-run` first.
 */
async function runAutoApply(
  entries: FixInputEntry[],
  cwd: string,
  args: CliArgs,
  version: string,
  write: (s: string) => void,
): Promise<number> {
  let applied = 0;
  let rejected = 0;

  write(`pgwen-fix v${version}  (mode: auto-apply${args.dryRun ? ', dry-run' : ''})\n`);
  write(`Found ${entries.length} candidate${entries.length === 1 ? '' : 's'}.\n\n`);

  // Validator config — derive once per run.
  const validatorOpts = {
    maxFiles: 1,
    maxLines: args.diffMaxLines ?? 20,
    ...(args.allowedPathPrefixes !== undefined ? { allowedPathPrefixes: args.allowedPathPrefixes } : {}),
  };

  for (const entry of entries) {
    const scenarioLabel = entry.failure.scenario_name;
    const proposal = entry.output.machine_proposal;

    // 1. Must have an auto-fix-safe machine_proposal.
    if (proposal === null) {
      write(`  rejected ${scenarioLabel}\n           no machine_proposal\n`);
      rejected += 1;
      continue;
    }
    if (entry.output.auto_fix_safe !== true) {
      write(`  rejected ${scenarioLabel}\n           auto_fix_safe=false (diagnose flagged escalation)\n`);
      rejected += 1;
      continue;
    }

    // 2. Validate proposal shape + minimum-diff policy.
    const validation = validateMinimumDiff(proposal, validatorOpts);
    if (!validation.ok) {
      write(`  rejected ${scenarioLabel}\n           minimum-diff: ${validation.violations.join('; ')}\n`);
      rejected += 1;
      continue;
    }

    // 3. Repeat-fix circuit breaker — git history check.
    const priorCheck = detectPriorPgwenFix(proposal.file, proposal.line, { cwd });
    if (priorCheck.isRepeat) {
      const shortSha = priorCheck.priorSha ? priorCheck.priorSha.slice(0, 8) : '?';
      write(`  rejected ${scenarioLabel}\n           repeat-fix: prior pgwen-fix at ${shortSha} on ${proposal.file}:${proposal.line}\n`);
      rejected += 1;
      continue;
    }

    // 4. Apply (rewrite line + branch + commit, or dry-run report).
    const applyResult = await applyMachineProposal(
      proposal,
      { dryRun: args.dryRun },
      { cwd },
    );
    if (applyResult.status === 'applied') {
      const verb = args.dryRun ? 'would apply' : 'applied';
      write(`  ${verb}  ${scenarioLabel}\n           → ${proposal.file}:${proposal.line}\n`);
      applied += 1;
    } else {
      write(`  rejected ${scenarioLabel}\n           ${applyResult.reason ?? 'apply failed'}\n`);
      rejected += 1;
    }
  }

  write(`\n${applied} ${args.dryRun ? 'would apply' : 'applied'}, ${rejected} rejected.\n`);
  if (!args.dryRun && applied > 0) {
    write(`\nLocal pgwen-fix/<...> branches created — inspect and push manually.\n`);
  }
  return rejected > 0 ? 1 : 0;
}

/**
 * The CLI body. Exported so tests can drive it without spawning a process.
 * Returns the exit code.
 */
export async function runCli(argv: string[], cwd: string, deps: RunCliDeps = {}): Promise<number> {
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const env = deps.env ?? process.env;

  const args = parseCliArgs(argv);
  if (args.input === '__help__' || args.input === '') {
    write(HELP);
    return args.input === '__help__' ? 0 : 2;
  }

  const inputPath = path.resolve(cwd, args.input);
  if (!fs.existsSync(inputPath)) {
    write(`pgwen-fix: input file not found: ${inputPath}\n`);
    return 2;
  }

  let entries: FixInputEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as FixInputEntry[];
  } catch (err) {
    write(`pgwen-fix: failed to parse input JSON: ${(err as Error).message}\n`);
    return 2;
  }
  if (!Array.isArray(entries)) {
    write('pgwen-fix: input JSON must be an array of FixInputEntry objects\n');
    return 2;
  }

  const version = readPackageVersion();

  // ─── Auto-apply mode branch ─────────────────────────────────────────────
  if (args.autoApply) {
    return runAutoApply(entries, cwd, args, version, write);
  }

  // ─── Suggest-only mode (default) ────────────────────────────────────────
  const configOverrides: Partial<FixConfig> = {};
  if (args.reportsDir !== undefined) configOverrides.reportsDir = args.reportsDir;
  if (args.confidenceMinimum !== undefined) configOverrides.confidenceMinimum = args.confidenceMinimum;
  if (args.diffMaxLines !== undefined) configOverrides.diffMaxLines = args.diffMaxLines;

  const result = runSuggestFix(entries, {
    cwd,
    config: configOverrides,
    dryRun: args.dryRun,
  }, version);

  const written = result.outcomes.filter((o) => o.kind === 'written').length;
  const rejected = result.outcomes.filter((o) => o.kind === 'rejected').length;

  write(`pgwen-fix v${version}  (mode: suggest-only${args.dryRun ? ', dry-run' : ''})\n`);
  write(`Reading: ${path.relative(cwd, inputPath)}\n`);
  write(`Found ${entries.length} candidate${entries.length === 1 ? '' : 's'}.\n\n`);
  for (const o of result.outcomes) {
    if (o.kind === 'written') {
      write(`  written  ${o.suggestion.scenario_name}\n`);
      write(`           → ${path.relative(cwd, o.jsonPath)}\n`);
    } else {
      write(`  rejected ${o.failure.scenario_name}\n`);
      write(`           ${o.reason}: ${o.detail}\n`);
    }
  }
  write(`\n${written} suggestion${written === 1 ? '' : 's'} written, ${rejected} rejected.\n`);
  if (result.htmlIndexPath) {
    write(`Index: ${path.relative(cwd, result.htmlIndexPath)}\n`);
  }

  // Optional PR comment (no-op when env vars absent).
  if (!args.dryRun && written > 0) {
    const all = readSuggestions(result.reportsDir);
    const out = await postPullRequestComment({
      suggestions: all,
      env: {
        GITHUB_TOKEN: env['GITHUB_TOKEN'],
        PGWEN_FIX_GH_PR: env['PGWEN_FIX_GH_PR'],
        PGWEN_FIX_GH_REPO: env['PGWEN_FIX_GH_REPO'],
        GITHUB_API_URL: env['GITHUB_API_URL'],
      },
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (out.kind === 'created') write(`PR comment created: ${out.commentUrl}\n`);
    else if (out.kind === 'updated') write(`PR comment updated: ${out.commentUrl}\n`);
  }

  return 0;
}

// Entry guard: only execute when invoked directly (not when imported by tests).
if (require.main === module) {
  void runCli(process.argv.slice(2), process.cwd()).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`pgwen-fix: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

// Outcome type for help() callers + tests that want to walk results.
export type { SuggestFixOutcome };
