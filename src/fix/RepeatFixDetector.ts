/**
 * RepeatFixDetector.ts
 *
 * Two surfaces:
 *
 *   1. `appendHistory` + `countPriorAttempts` + `isRepeatFix` — the
 *      suggest-only mode's circuit breaker. Backed by a JSONL ledger at
 *      `<reportsDir>/history.jsonl`. Append-only. Key is
 *      `feature::scenario::step::file:line`.
 *
 *   2. `detectPriorPgwenFix(file, line, opts)` — kept as the original §14
 *      skeleton stub so the boundary test sees the export it expects.
 *      Suggest-only mode does not call it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { RepeatFixCheck } from './types';

const HISTORY_FILE = 'history.jsonl';

/** One ledger entry. Append-only — never edited in place. */
export interface FixHistoryEntry {
  /** ISO 8601 UTC. */
  timestamp: string;
  feature_file: string;
  feature_name: string;
  scenario_name: string;
  step_text: string;
  /** Target file the proposed patch modifies. */
  file: string;
  line: number;
  /** `written` (suggestion landed) or one of the rejection reasons. */
  outcome: string;
  /** `id` of the written suggestion when outcome === 'written', else null. */
  suggestion_id: string | null;
}

/**
 * Build the stable key the detector uses to group attempts on the same
 * fix target. Lowercased + whitespace-collapsed so trivial reformatting
 * of step text doesn't escape the circuit breaker.
 */
export function buildHistoryKey(
  e: Pick<FixHistoryEntry, 'feature_file' | 'scenario_name' | 'step_text' | 'file' | 'line'>,
): string {
  const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, ' ');
  return [
    norm(e.feature_file),
    norm(e.scenario_name),
    norm(e.step_text),
    norm(e.file),
    String(e.line),
  ].join('::');
}

/**
 * Append one entry to `<reportsDir>/history.jsonl`. Creates the directory
 * if needed. Returns the absolute path written to.
 */
export function appendHistory(reportsDir: string, entry: FixHistoryEntry): string {
  fs.mkdirSync(reportsDir, { recursive: true });
  const target = path.join(reportsDir, HISTORY_FILE);
  fs.appendFileSync(target, JSON.stringify(entry) + '\n', 'utf8');
  return target;
}

/**
 * Read the ledger and return every entry. Robust to a missing file (returns
 * `[]`) and to corrupt lines (skipped silently — the ledger is append-only
 * so a partial write leaves at most one bad trailing line).
 */
export function readHistory(reportsDir: string): FixHistoryEntry[] {
  const target = path.join(reportsDir, HISTORY_FILE);
  if (!fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  const out: FixHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as FixHistoryEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

/**
 * Count prior `written` attempts matching `key` within the look-back window.
 * Rejections (e.g. `low_confidence`, `minimum_diff_violation`) do NOT count
 * — only successfully-written suggestions do; otherwise a single rejected
 * proposal would burn the budget for legitimate retries.
 */
export function countPriorAttempts(
  reportsDir: string,
  key: string,
  opts: { windowDays: number; now?: Date },
): number {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const entry of readHistory(reportsDir)) {
    if (entry.outcome !== 'written') continue;
    const t = Date.parse(entry.timestamp);
    if (Number.isNaN(t) || t < cutoff) continue;
    if (buildHistoryKey(entry) === key) count += 1;
  }
  return count;
}

export interface RepeatCheckInputs {
  reportsDir: string;
  feature_file: string;
  scenario_name: string;
  step_text: string;
  file: string;
  line: number;
  windowDays: number;
  maxAttempts: number;
  now?: Date;
}

/**
 * High-level circuit breaker used by `runSuggestFix`.
 * Returns `true` when this target has already been suggested `maxAttempts`
 * or more times inside the look-back window — the proposal should be
 * rejected as `repeat_fix`.
 */
export function isRepeatFix(inputs: RepeatCheckInputs): boolean {
  const key = buildHistoryKey(inputs);
  const prior = countPriorAttempts(inputs.reportsDir, key, {
    windowDays: inputs.windowDays,
    ...(inputs.now !== undefined ? { now: inputs.now } : {}),
  });
  return prior >= inputs.maxAttempts;
}

// ─── detectPriorPgwenFix — git-history circuit breaker ─────────────────────

export interface DetectPriorPgwenFixOpts {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Maximum number of MATCHING pgwen-fix commits to consider, newest
   * first. Default 100. This is `git log -n` applied after `--grep`
   * filtering — bounds the worst-case cost on project repos with long
   * histories without changing the answer when there are few pgwen-fix
   * commits. Reduce to 1 if you only care about the most recent.
   */
  lookBackCommits?: number;
  /**
   * Kept for back-compat with the §14 skeleton signature. The git-backed
   * implementation does not use this; ledger lookups belong in
   * `isRepeatFix` / `countPriorAttempts`.
   */
  historyDir?: string;
  /**
   * Git executor. Defaults to `spawnSync('git', ...)`. Tests inject a
   * fake to verify the contract without spinning up a real repo.
   */
  execGit?: (args: string[], cwd: string) => { stdout: string; status: number | null };
}

/**
 * Check whether a prior `pgwen-fix` commit already touched the given
 * `file:line` within the look-back window. Used as the circuit breaker
 * for the auto-apply path: when the same line has been auto-rebound
 * twice, the project is masking a deeper issue and a human needs to look.
 *
 * Returns `{priorSha, isRepeat}`:
 *   - `priorSha`: SHA of the most recent qualifying pgwen-fix commit,
 *     or null if none found. Commits ordered newest-first.
 *   - `isRepeat`: true when ≥ 2 such commits exist in the window — the
 *     fix has been attempted before and bounced. The orchestrator
 *     should refuse to auto-apply.
 *
 * Errors are swallowed (returns `{priorSha: null, isRepeat: false}`):
 *   - not a git repo
 *   - file not tracked
 *   - git binary missing
 * The orchestrator is responsible for any separate "is this a git repo
 * at all?" sanity check — this function intentionally never throws so a
 * non-repo cwd doesn't crash the whole batch.
 */
export function detectPriorPgwenFix(
  file: string,
  line: number,
  opts: DetectPriorPgwenFixOpts = {},
): RepeatFixCheck {
  if (!Number.isInteger(line) || line < 1 || file.length === 0) {
    return { priorSha: null, isRepeat: false };
  }

  const cwd = opts.cwd ?? process.cwd();
  const lookBack = opts.lookBackCommits ?? 100;
  const execGit = opts.execGit ?? defaultExecGitSync;

  // List candidate commits: those whose message contains "pgwen-fix" AND
  // which touched this file, newest first. `--grep` is regex-by-default
  // but `pgwen-fix` is a plain literal here. `-n` caps the scan.
  let listResult;
  try {
    listResult = execGit(
      ['log', '-n', String(lookBack), '--pretty=%H', '--grep=pgwen-fix', '--', file],
      cwd,
    );
  } catch {
    return { priorSha: null, isRepeat: false };
  }
  if (listResult.status !== 0) return { priorSha: null, isRepeat: false };

  const shas = listResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Filter to commits that actually touched the SPECIFIC LINE — diff
  // hunk new-range overlap. File-level scope alone over-reports; the
  // strategy doc's `prior_pgwen_fix_on_same_line` signal is line-precise.
  const touching: string[] = [];
  for (const sha of shas) {
    if (commitTouchedLine(execGit, cwd, sha, file, line)) {
      touching.push(sha);
    }
  }

  return {
    priorSha: touching[0] ?? null,
    isRepeat: touching.length >= 2,
  };
}

/**
 * Return true when commit `sha` touched the given `line` of `file`.
 * Inspects the diff with zero context (`--unified=0`) and checks every
 * hunk's NEW-range for overlap. The new range covers added + modified
 * lines; deleted-only lines (no NEW slot) are not considered "touched"
 * for the purpose of this check because the line numbers we care about
 * are the post-commit line positions.
 */
function commitTouchedLine(
  execGit: NonNullable<DetectPriorPgwenFixOpts['execGit']>,
  cwd: string,
  sha: string,
  file: string,
  line: number,
): boolean {
  let r;
  try {
    r = execGit(['show', '--unified=0', '--format=', sha, '--', file], cwd);
  } catch {
    return false;
  }
  if (r.status !== 0) return false;

  // Parse hunks: `@@ -oldStart[,oldLen] +newStart[,newLen] @@`
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = hunkRe.exec(r.stdout)) !== null) {
    const newStart = parseInt(m[1]!, 10);
    const newLen = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    if (newLen <= 0) continue; // pure deletion hunk
    if (line >= newStart && line < newStart + newLen) return true;
  }
  return false;
}

function defaultExecGitSync(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? '', status: result.status };
}
