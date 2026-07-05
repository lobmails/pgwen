/**
 * PatchApplier.ts
 *
 * Two surfaces:
 *
 *   1. `buildUnifiedDiff(proposal)` — pure: turns a MachineProposal into a
 *      unified-diff string applyable with `patch -p1`. Used by suggest-only
 *      mode (writes a .patch sidecar). No fs access; the OLD text is taken
 *      from the proposal itself.
 *
 *   2. `applyMachineProposal(proposal, opts, deps)` — branch-mode auto-apply.
 *      Reads the target file, verifies the expected OLD text is at the
 *      named line, rewrites it to NEW, creates a new branch, and commits.
 *      Designed so the §18-governance flip is a flag change at the CLI
 *      surface — the code path itself is complete and tested here.
 *
 * Auto-apply boundaries (v1):
 *   - branch mode only (`opts.branch=true`, the default). `opts.suggestion`
 *     mode (PR review-comment) is OUT OF SCOPE — throws a clear error.
 *   - single-line proposals only (validated upstream by `buildUnifiedDiff`).
 *     Multi-line ones never reach this function in practice.
 *   - never pushes the branch. Never opens a PR. The branch stays local;
 *     the operator is expected to inspect + push manually.
 *   - never resolves more than one file per call (per-proposal scope).
 *     `opts.maxFiles` / `opts.maxLines` are caps the orchestration layer
 *     enforces across proposals — this function trusts the values reached it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { MachineProposal, ApplyOpts, ApplyResult } from './types';

export const DEFAULT_APPLY_OPTS: ApplyOpts = {
  branch: true,
  suggestion: false,
  maxFiles: 1,
  maxLines: 1,
  dryRun: false,
};

/**
 * Build a unified-diff string for a single-line locator-binding replacement.
 *
 * The header uses paths relative to repo root (with `a/` and `b/` prefixes
 * so `patch -p1` works). The hunk has exactly one `-` and one `+` line and
 * no surrounding context lines — locator-binding swaps are intentionally
 * minimum-diff (§7) and a single-line hunk is unambiguous.
 *
 * Throws if `old` or `new` contain a newline — multi-line proposals are out
 * of scope for v1 and would silently produce a malformed patch.
 */
export function buildUnifiedDiff(proposal: MachineProposal): string {
  if (proposal.old.includes('\n') || proposal.new.includes('\n')) {
    throw new Error(
      `buildUnifiedDiff: multi-line proposals are not supported in v1 ` +
      `(file=${proposal.file}, line=${proposal.line})`,
    );
  }
  if (!Number.isInteger(proposal.line) || proposal.line < 1) {
    throw new Error(
      `buildUnifiedDiff: invalid line number ${proposal.line} (must be a positive integer)`,
    );
  }

  // Hunk with zero context: -<line>,1 +<line>,1
  const header =
    `--- a/${proposal.file}\n` +
    `+++ b/${proposal.file}\n` +
    `@@ -${proposal.line},1 +${proposal.line},1 @@\n`;
  return header + `-${proposal.old}\n` + `+${proposal.new}\n`;
}

// ─── applyMachineProposal — DI seam ─────────────────────────────────────────

/**
 * Optional injection points for `applyMachineProposal`. Tests supply
 * fake implementations to avoid touching the host filesystem or running
 * real git commands; production omits everything and gets the defaults.
 */
export interface ApplyMachineProposalDeps {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Read a file (utf-8). Defaults to `fs.promises.readFile`. */
  readFile?: (absPath: string) => Promise<string>;
  /** Write a file (utf-8). Defaults to `fs.promises.writeFile`. */
  writeFile?: (absPath: string, content: string) => Promise<void>;
  /**
   * Run a git command. Returns the result; should throw if the command
   * fails. Defaults to a `child_process.spawnSync('git', args, { cwd })`
   * wrapper that throws on non-zero exit.
   */
  execGit?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  /** "Now" injection — used to generate the branch name. Defaults to `new Date()`. */
  now?: Date;
}

export interface AppliedDetails {
  /** Branch name created (when `opts.branch=true`). */
  branch?: string;
  /** Files actually touched (always one in v1). */
  files: string[];
}

/**
 * Apply a single MachineProposal as a local-only git commit.
 *
 * Flow:
 *   1. Reject `opts.suggestion === true` — PR review-comment mode is post-v1.
 *   2. Validate the proposal: line ≥ 1, old/new differ, no embedded newlines,
 *      target file resolves inside `cwd` (no `..` escapes).
 *   3. Read the file. Verify line N reads exactly `proposal.old`. Reject
 *      otherwise — DOM-derived AI proposals MUST match the source verbatim
 *      or the patch wasn't grounded in the current code.
 *   4. In `dryRun` mode, return `{status: 'applied', files: [proposal.file]}`
 *      WITHOUT writing or running git. Used by the orchestrator to compute
 *      what would happen before the operator opts in.
 *   5. Otherwise: rewrite the line, write the file, then either:
 *      - `branch: true` (default) — `git checkout -b <auto-name>`, then
 *        `git add` + `git commit`. The branch stays local.
 *      - `branch: false` — commit on the current branch directly.
 *
 * Return value never throws on validation rejections — they come back as
 * `{status: 'rejected', reason}` so the orchestrator can keep going through
 * a batch. Unexpected fs / git failures DO throw (out-of-disk, broken git
 * repo, etc.) — the orchestrator should log + abort.
 */
export async function applyMachineProposal(
  proposal: MachineProposal,
  opts: Partial<ApplyOpts> = {},
  deps: ApplyMachineProposalDeps = {},
): Promise<ApplyResult> {
  const effective: ApplyOpts = { ...DEFAULT_APPLY_OPTS, ...opts };

  // 1. Suggestion mode is post-v1 — fail loud.
  if (effective.suggestion) {
    throw new Error(
      `applyMachineProposal: opts.suggestion=true (PR review-comment mode) ` +
      `is not implemented in v1. Use branch mode (opts.branch=true, the default) ` +
      `and post the comment from the operator's tooling.`,
    );
  }
  if (!effective.branch) {
    // Mutually-exclusive contract: suggestion=false AND branch=false is ambiguous.
    // Branch mode is the only v1 channel.
    return {
      status: 'rejected',
      reason: 'opts.branch=false is not supported in v1; set opts.branch=true or use suggest-only',
      files: [],
    };
  }

  // 2. Validate the proposal shape.
  const validation = validateProposalShape(proposal);
  if (validation) return validation;

  // 3. Resolve target file path inside cwd (no escape).
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const fileAbs = path.resolve(cwd, proposal.file);
  if (!isInside(cwd, fileAbs)) {
    return {
      status: 'rejected',
      reason: `target file "${proposal.file}" resolves outside the working tree`,
      files: [],
    };
  }

  // 4. Read + verify the target line.
  const readFile = deps.readFile ?? ((p: string) => fs.promises.readFile(p, 'utf-8'));
  let content: string;
  try {
    content = await readFile(fileAbs);
  } catch (err) {
    return {
      status: 'rejected',
      reason: `cannot read "${proposal.file}": ${(err as Error).message}`,
      files: [],
    };
  }

  const lines = content.split('\n');
  if (proposal.line > lines.length) {
    return {
      status: 'rejected',
      reason: `line ${proposal.line} is out of range (file has ${lines.length} line(s))`,
      files: [],
    };
  }
  const actual = lines[proposal.line - 1]!;
  if (actual !== proposal.old) {
    return {
      status: 'rejected',
      reason:
        `line ${proposal.line} in "${proposal.file}" does not match the proposal's ` +
        `OLD text — the AI was looking at a stale copy. Refusing to apply.`,
      files: [],
    };
  }

  // 5. Dry-run short-circuit — report what would happen, no side effects.
  if (effective.dryRun) {
    return { status: 'applied', files: [proposal.file] };
  }

  // 6. Apply: rewrite the line, write the file, then commit.
  lines[proposal.line - 1] = proposal.new;
  const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.promises.writeFile(p, c, 'utf-8'));
  await writeFile(fileAbs, lines.join('\n'));

  const execGit = deps.execGit ?? defaultExecGit;
  const branchName = buildBranchName(proposal, deps.now ?? new Date());
  const commitMsg = buildCommitMessage(proposal);

  try {
    await execGit(['checkout', '-b', branchName], cwd);
    await execGit(['add', '--', proposal.file], cwd);
    await execGit(['commit', '-m', commitMsg], cwd);
  } catch (err) {
    // Surface as a rejection so a batch can continue. The orchestrator
    // logs the underlying git error message.
    return {
      status: 'rejected',
      reason: `git operation failed: ${(err as Error).message}`,
      files: [],
    };
  }

  return { status: 'applied', files: [proposal.file] };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function validateProposalShape(proposal: MachineProposal): ApplyResult | null {
  if (proposal.old.includes('\n') || proposal.new.includes('\n')) {
    return {
      status: 'rejected',
      reason: 'multi-line proposals are not supported in v1',
      files: [],
    };
  }
  if (proposal.old === proposal.new) {
    return {
      status: 'rejected',
      reason: 'no-op proposal — old text equals new text',
      files: [],
    };
  }
  if (!Number.isInteger(proposal.line) || proposal.line < 1) {
    return {
      status: 'rejected',
      reason: `invalid line number ${proposal.line} (must be a positive integer)`,
      files: [],
    };
  }
  if (proposal.file.length === 0) {
    return { status: 'rejected', reason: 'proposal.file is empty', files: [] };
  }
  return null;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function buildBranchName(proposal: MachineProposal, now: Date): string {
  const slug = slugify(proposal.binding_name);
  const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  return `pgwen-fix/${slug}-${stamp}`;
}

function buildCommitMessage(proposal: MachineProposal): string {
  return (
    `pgwen-fix: rebind "${proposal.binding_name}" in ${proposal.file}\n` +
    `\n` +
    `Auto-applied locator rebind suggested by pgwen diagnose + @pgwen/fix.\n` +
    `Verify the new selector before merging:\n` +
    `  ${proposal.file}:${proposal.line}\n` +
    `\n` +
    `Original-DOM-match-count: ${proposal.original_selector_match_count_in_dom}\n`
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unnamed';
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

async function defaultExecGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status}: ${(result.stderr ?? '').trim()}`,
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
