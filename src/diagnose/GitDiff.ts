/**
 * GitDiff.ts — recent diffs filtered to the files actually involved in a
 * failure, for inclusion in `DiagnoseInput.history.recent_diffs`.
 *
 * Real-world test-maintenance pain: when a CI scenario fails, the 2am
 * triage question is "did the test change or did the app change?".
 * Without git context, the dev's only signal is the error message.
 * With a tight diff of the involved files (feature + meta), they can
 * usually answer in seconds.
 *
 * Trade-offs baked in:
 *   - `--no-merges` removes noise from merge commits.
 *   - File filtering keeps the payload tight (the strategy doc caps the
 *     bundle at 50 KB hard).
 *   - We cap by commit count AND byte budget — long diffs of small
 *     numbers of commits and short diffs of many commits both stay
 *     within bounds.
 *   - Missing git binary, repo-less working dir, missing files: all
 *     resolve to an empty string rather than throwing. The diagnose
 *     bundle is allowed to be empty here; an exception would propagate
 *     up the AiPipeline.
 *
 * No new deps. Uses `node:child_process.execFile` so the shell is never
 * involved (file paths never interpreted as commands or globs).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { toPosixPath } from '../util/paths';

export interface RecentDiffsOptions {
  /** Working directory the `git` command runs in. Default: process.cwd(). */
  repoDir?: string;
  /**
   * Files to filter the diff to (absolute or relative to repoDir). Empty
   * list returns an empty string — without filtering, an unfiltered diff
   * blows the bundle budget.
   */
  files: ReadonlyArray<string>;
  /** Max number of commits to walk. Default 5. */
  maxCommits?: number;
  /** Soft byte cap on the returned diff. Default 8 KB. */
  maxBytes?: number;
  /**
   * Injectable git invoker — used by tests to deliver canned output
   * without spawning a process. Default: real git via child_process.
   */
  execImpl?: (
    args: ReadonlyArray<string>,
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

const DEFAULT_MAX_COMMITS = 5;
const DEFAULT_MAX_BYTES = 8 * 1024;

/**
 * Run `git log -p --no-merges -n <N> -- <files>` and return the
 * captured stdout, capped by `maxBytes`. Returns "" when the repo
 * cannot be located, git is missing, or `files` is empty.
 */
export async function getRecentDiffsForFiles(opts: RecentDiffsOptions): Promise<string> {
  const repoDir = path.resolve(opts.repoDir ?? process.cwd());
  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  if (opts.files.length === 0) return '';
  if (!opts.execImpl && !isProbablyGitRepo(repoDir)) return '';

  const filesRelative = opts.files
    .map((f) => toPosixPath(path.isAbsolute(f) ? path.relative(repoDir, f) : f))
    // Defensive: drop `..` paths that escape the repo (would just fail anyway).
    .filter((f) => !f.startsWith('..') && f.length > 0);
  if (filesRelative.length === 0) return '';

  const args = ['log', '-p', '--no-merges', `-n${maxCommits}`, '--', ...filesRelative];
  const invoker = opts.execImpl ?? defaultExec;

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await invoker(args, repoDir);
  } catch {
    return '';
  }
  if (result.code !== 0) return '';

  const trimmed = capBytes(result.stdout, maxBytes);
  return trimmed;
}

function isProbablyGitRepo(dir: string): boolean {
  // Walk up looking for a .git directory or file (worktrees use a file).
  let cur = dir;
  for (let i = 0; i < 10; i++) {
    const gitPath = path.join(cur, '.git');
    if (fs.existsSync(gitPath)) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}

function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  // UTF-8 safe truncate: take the longest character prefix that fits.
  // Binary-search avoids walking the whole string for trivial cases.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function defaultExec(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as NodeJS.ErrnoException).code === 'number'
            ? ((err as unknown as { code: number }).code)
            : (child.exitCode ?? 1);
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
      },
    );
  });
}
