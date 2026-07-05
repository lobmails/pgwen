/**
 * MinimumDiffValidator.ts
 *
 * Enforces the §7 minimum-diff principle on a proposed unified diff. Pure
 * function — no fs access; the patch text is the source of truth.
 *
 * Rejects when:
 *   - The patch touches more than `maxFiles` files (default 1).
 *   - The hunk contains more than `maxLines` `+`/`-` content lines.
 *   - The target file path does not start with any allowed prefix (default
 *     `pgwen/meta/`) — keeps suggestions confined to project meta files and
 *     out of `src/`, CI config, etc.
 *   - The binding-name token does not appear in the proposal's `old` text
 *     (defence against a proposal renaming the binding itself).
 */

import type {
  MachineProposal,
  ApplyOpts,
  MinimumDiffValidation,
  FixConfig,
} from './types';

export interface ValidateInputs {
  proposal: MachineProposal;
  patch: string;
  config: Pick<FixConfig, 'diffMaxLines' | 'allowedPathPrefixes'>;
}

/**
 * The real entry point used by suggest-only mode. Returns a structured
 * result — never throws on policy violations, only on programmer error.
 */
export function validateSuggestion(inputs: ValidateInputs): MinimumDiffValidation {
  const { proposal, patch, config } = inputs;
  const violations: string[] = [];

  // ─── Path prefix ──────────────────────────────────────────────────────────
  const allowed = config.allowedPathPrefixes;
  if (!allowed.some((p) => proposal.file.startsWith(p))) {
    violations.push(
      `file "${proposal.file}" is outside the allowed prefixes (${allowed.join(', ')})`,
    );
  }

  // ─── Single-file diff ─────────────────────────────────────────────────────
  const fileHeaderMatches = patch.match(/^\+\+\+\s+\S+/gm) ?? [];
  if (fileHeaderMatches.length > 1) {
    violations.push(`patch touches ${fileHeaderMatches.length} files (max 1)`);
  }

  // ─── Line-count ───────────────────────────────────────────────────────────
  // Count `-` and `+` content lines (ignore the `---` / `+++` file headers).
  const contentLines = patch
    .split('\n')
    .filter((l) => (l.startsWith('-') && !l.startsWith('---')) || (l.startsWith('+') && !l.startsWith('+++')));
  if (contentLines.length > config.diffMaxLines) {
    violations.push(
      `patch has ${contentLines.length} changed lines (max ${config.diffMaxLines})`,
    );
  }

  // ─── Binding name appears in OLD text ────────────────────────────────────
  // Prevents a proposal that silently renames the binding itself rather than
  // just its selector value. Case-insensitive substring check is enough; the
  // binding name is verbatim Gherkin text by construction.
  if (!proposal.old.toLowerCase().includes(proposal.binding_name.toLowerCase())) {
    violations.push(
      `binding_name "${proposal.binding_name}" does not appear in the OLD text`,
    );
  }

  return { ok: violations.length === 0, violations };
}

// ─── validateMinimumDiff — auto-apply path validator ───────────────────────

/**
 * Optional knobs for `validateMinimumDiff`. Mirrors `validateSuggestion`'s
 * `config` slice but also exposes `maxFiles` (always 1 in v1 — a proposal
 * targets one file — but a future caller might enforce 0).
 *
 * Defaults align with DEFAULT_APPLY_OPTS + DEFAULT_FIX_CONFIG: one file,
 * one line, `pgwen/meta/` prefix only.
 */
export interface ValidateMinimumDiffOpts {
  maxFiles?: number;
  maxLines?: number;
  allowedPathPrefixes?: string[];
}

const DEFAULTS: Required<ValidateMinimumDiffOpts> = {
  maxFiles: 1,
  maxLines: 1,
  allowedPathPrefixes: ['pgwen/meta/'],
};

/**
 * Validate a `MachineProposal` against the minimum-diff policy BEFORE any
 * patch is built or applied. Used by the auto-apply orchestrator as the
 * first gate after the proposal arrives from `pgwen diagnose`.
 *
 * Returns `{ok, violations}`. Never throws on policy issues; only on
 * programmer error (none in this function). Multiple violations are
 * collected so the operator can see all problems at once.
 *
 * Decisions mirror `validateSuggestion` but operate on the raw proposal,
 * not on a constructed unified-diff string. Both functions agree on the
 * same proposal — any divergence is a bug.
 *
 * Accepts both the legacy `Pick<ApplyOpts, 'maxFiles' | 'maxLines'>`
 * signature and the new `ValidateMinimumDiffOpts` shape that also carries
 * `allowedPathPrefixes`. Path-prefix check is skipped when the caller
 * passes the legacy shape (no prefixes ⇒ all paths permitted), so a
 * caller that wants the full check must use the new shape.
 */
export function validateMinimumDiff(
  proposal: MachineProposal,
  opts: ValidateMinimumDiffOpts | Pick<ApplyOpts, 'maxFiles' | 'maxLines'> = {},
): MinimumDiffValidation {
  const effective: Required<ValidateMinimumDiffOpts> = {
    maxFiles: opts.maxFiles ?? DEFAULTS.maxFiles,
    maxLines: opts.maxLines ?? DEFAULTS.maxLines,
    allowedPathPrefixes:
      (opts as ValidateMinimumDiffOpts).allowedPathPrefixes ?? DEFAULTS.allowedPathPrefixes,
  };

  const violations: string[] = [];

  // ─── Multi-line proposals are not supported in v1 ────────────────────────
  // Both old/new are EXACTLY one line. Embedded newlines would break the
  // unified-diff builder downstream and indicate a malformed proposal.
  if (proposal.old.includes('\n') || proposal.new.includes('\n')) {
    violations.push('multi-line proposals are not supported in v1');
  }

  // ─── No-op detection ─────────────────────────────────────────────────────
  if (proposal.old === proposal.new) {
    violations.push('no-op proposal — old text equals new text');
  }

  // ─── Line number must be a positive integer ──────────────────────────────
  if (!Number.isInteger(proposal.line) || proposal.line < 1) {
    violations.push(
      `invalid line number ${proposal.line} (must be a positive integer)`,
    );
  }

  // ─── File-count cap ──────────────────────────────────────────────────────
  // A single proposal targets one file by definition. If the caller has
  // set maxFiles below 1, the proposal can never satisfy them.
  if (effective.maxFiles < 1) {
    violations.push(
      `proposal touches 1 file but opts.maxFiles=${effective.maxFiles}`,
    );
  }

  // ─── Line-count cap ──────────────────────────────────────────────────────
  // Single-line replacement = 1 modified line. Multi-line cases were
  // already rejected above. A maxLines below 1 would block every fix.
  if (effective.maxLines < 1) {
    violations.push(
      `proposal modifies 1 line but opts.maxLines=${effective.maxLines}`,
    );
  }

  // ─── Path prefix ─────────────────────────────────────────────────────────
  // Skipped when allowedPathPrefixes is empty (legacy caller). When set,
  // the proposal's target file MUST start with at least one prefix.
  if (effective.allowedPathPrefixes.length > 0) {
    if (proposal.file.length === 0) {
      violations.push('proposal.file is empty');
    } else if (!effective.allowedPathPrefixes.some((p) => proposal.file.startsWith(p))) {
      violations.push(
        `file "${proposal.file}" is outside the allowed prefixes ` +
        `(${effective.allowedPathPrefixes.join(', ')})`,
      );
    }
  } else if (proposal.file.length === 0) {
    // Even with no prefix restriction, an empty path is structural garbage.
    violations.push('proposal.file is empty');
  }

  // ─── Binding-name appears in OLD text ────────────────────────────────────
  // Mirror of validateSuggestion. Case-insensitive — Gherkin step text is
  // verbatim but step authors may use mixed case across files.
  if (
    proposal.binding_name.length > 0 &&
    !proposal.old.toLowerCase().includes(proposal.binding_name.toLowerCase())
  ) {
    violations.push(
      `binding_name "${proposal.binding_name}" does not appear in the OLD text`,
    );
  }
  if (proposal.binding_name.length === 0) {
    violations.push('proposal.binding_name is empty');
  }

  return { ok: violations.length === 0, violations };
}
