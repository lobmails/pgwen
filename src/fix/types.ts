/**
 * types.ts — public contract for `@pgwen/fix`.
 *
 * The `DiagnoseOutput` shape below MIRRORS `@pgwen/core`'s
 * `src/diagnose/types.ts`. The mirror is deliberate: `@pgwen/fix` accepts
 * any value matching this shape, regardless of producer, so the two
 * packages share a documented contract — NOT a source dependency. This
 * keeps the §14 boundary structural ("`diagnose` can never silently invoke
 * `fix`" is a build-time property, not a code-review hope).
 *
 * If the upstream shape drifts, this mirror must be revised explicitly
 * and a compatibility note added to README.md.
 */

export type DiagnoseCategory =
  | 'locator_drift'
  | 'app_regression'
  | 'timing'
  | 'env'
  | 'test_bug'
  | 'unknown';

export type DiagnoseConfidence = 'high' | 'medium' | 'low';

export interface MachineProposal {
  binding_name: string;
  file: string;
  line: number;
  old: string;
  new: string;
  original_selector_match_count_in_dom: number;
}

export interface EscalationSignals {
  prior_pgwen_fix_on_same_line: boolean;
  shared_meta_imported_by_multiple_features: boolean;
  failure_repeated_in_consecutive_runs: boolean;
}

export interface DiagnoseOutput {
  category: DiagnoseCategory;
  confidence: DiagnoseConfidence;
  human_explanation: string;
  evidence: string[];
  alternatives_considered: Array<{ option: string; rejected_because: string }>;
  files_likely_involved: Array<{ path: string; role: 'locator' | 'feature' | 'app-code' | 'config' }>;
  escalation_signals: EscalationSignals;
  /** Structured proposal; `null` unless category=locator_drift, confidence=high, no escalations. */
  machine_proposal: MachineProposal | null;
  auto_fix_safe: boolean;
}

// ─── @pgwen/fix-specific shapes ─────────────────────────────────────────────

export interface ApplyOpts {
  /**
   * When true, create a new branch and open a PR (the default flow).
   * Mutually exclusive with `suggestion`.
   */
  branch: boolean;
  /**
   * When true, post a PR `suggestion` review comment instead of committing.
   * Preferred when the failing run is itself on a PR — the human clicks
   * "Commit suggestion" and the resulting commit is human-authored.
   */
  suggestion: boolean;
  /**
   * Hard cap on files touched per fix. Default 1 (§7 minimum-diff principle).
   * Configurable up to a strategy-doc-mandated maximum of 3.
   */
  maxFiles: number;
  /**
   * Hard cap on lines touched per fix. Default 1.
   * Configurable up to 3.
   */
  maxLines: number;
  /** When true, no git/gh actions run; the would-be patch is printed only. */
  dryRun: boolean;
}

export interface ApplyResult {
  status: 'applied' | 'skipped' | 'rejected';
  /** Free-form reason when `status !== 'applied'`. */
  reason?: string;
  /** Files actually touched (empty on skipped/rejected). */
  files: string[];
  /** PR URL when `branch` mode produced one. */
  prUrl?: string;
}

export interface MinimumDiffValidation {
  ok: boolean;
  /** Free-form rule violations. Empty when `ok === true`. */
  violations: string[];
}

export interface RepeatFixCheck {
  /** SHA of a prior pgwen-fix commit that touched this same line, or null. */
  priorSha: string | null;
  /** True when the line has been auto-fixed twice within the look-back window. */
  isRepeat: boolean;
}

// ─── Error type ─────────────────────────────────────────────────────────────

/**
 * Thrown by the auto-apply / branch-mode entry point, which remains a §14
 * skeleton. Suggest-only mode does not throw this — it returns structured
 * results from `runSuggestFix`.
 */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  constructor(operation: string) {
    super(
      `${operation} is not implemented in @pgwen/fix. ` +
      `This package is a §14 skeleton; the patching surface is gated on ` +
      `pgwen-ai-fix-strategy.md §18 stakeholder answers (API key custody, ` +
      `cost cap, RPA-no-browser, rate limits, PII scrubbing).`
    );
  }
}

// ─── Suggest-only mode shapes ───────────────────────────────────────────────

/**
 * One failure + its DiagnoseOutput. The input to `runSuggestFix`. Produced
 * by `pgwen diagnose --json-out <path>`. Mirror of `@pgwen/core`'s shape
 * (we do not import it — see §14 boundary above).
 */
export interface FixInputEntry {
  failure: {
    feature_file: string;
    feature_name: string;
    scenario_name: string;
    step_keyword: string;
    step_text: string;
    error_class: string;
    error_message: string;
  };
  /**
   * Rule-based classification carried over from results.json. Optional
   * because some upstream callers may not have it. When present, used
   * for the `classification.class` confidence gate (LOCATOR_NOT_FOUND in v1).
   */
  classification?: {
    class:
      | 'LOCATOR_NOT_FOUND'
      | 'ASSERTION_FAILED'
      | 'TIMEOUT'
      | 'AUTH_FAILURE'
      | 'NAVIGATION_FAILURE'
      | 'UNKNOWN';
    confidence: DiagnoseConfidence;
    signals: string[];
  };
  /**
   * Other failures that share this entry's fingerprint — populated by the
   * diagnose pipeline's pattern grouping. The first element is the
   * representative (= `failure`). When absent, treat as a singleton group
   * containing just `failure`.
   */
  instances?: Array<{
    feature_file: string;
    feature_name: string;
    scenario_name: string;
    step_text: string;
  }>;
  /** Claude's output. `machine_proposal` is what suggest-mode turns into a patch. */
  output: DiagnoseOutput;
}

/** Single suggestion artefact written to disk. */
export interface Suggestion {
  /** Stable identifier; also the filename stem under `suggestions/`. */
  id: string;
  feature_file: string;
  feature_name: string;
  scenario_name: string;
  step_text: string;
  binding_name: string;
  /** Target file the patch modifies (typically a .meta file). */
  file: string;
  line: number;
  old: string;
  new: string;
  category: DiagnoseCategory;
  confidence: DiagnoseConfidence;
  /** Free-form rationale carried over from DiagnoseOutput.human_explanation. */
  rationale: string;
  /** Unified-diff text — applyable with `patch -p1`. */
  patch: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** Validation result captured at write time. */
  validation: MinimumDiffValidation;
  /**
   * Every failure (representative first) this single patch resolves. Set
   * only when the upstream diagnose entry came in with `instances` — i.e.
   * pattern grouping was on. When absent, this suggestion covers exactly
   * one failure (the one at the top-level fields).
   */
  affected_instances?: Array<{
    feature_file: string;
    feature_name: string;
    scenario_name: string;
    step_text: string;
  }>;
}

/** Configuration knobs — sourced from pgwen.conf or CLI args. */
export interface FixConfig {
  enabled: boolean;
  /** Where suggestions land. Defaults to `reports/pgwen-fix`. */
  reportsDir: string;
  /** Lowest acceptable Claude confidence. `low` is never accepted. */
  confidenceMinimum: Exclude<DiagnoseConfidence, 'low'>;
  /** Maximum line count of the proposed unified diff (excluding headers). */
  diffMaxLines: number;
  /** Allowed glob prefixes for `file` paths. Default: ["pgwen/meta/"]. */
  allowedPathPrefixes: string[];
  /** Repeat-detector window in days. */
  repeatWindowDays: number;
  /** Max prior attempts on the same key before rejecting as a repeat. */
  repeatMaxAttempts: number;
  /** Opt-in GitHub PR commenting. */
  githubEnabled: boolean;
}

export const DEFAULT_FIX_CONFIG: FixConfig = {
  enabled: false,
  reportsDir: 'reports/pgwen-fix',
  confidenceMinimum: 'high',
  diffMaxLines: 20,
  allowedPathPrefixes: ['pgwen/meta/'],
  repeatWindowDays: 14,
  repeatMaxAttempts: 2,
  githubEnabled: false,
};

/** Why a candidate was not turned into a suggestion. */
export type RejectionReason =
  | 'no_machine_proposal'
  | 'low_confidence'
  | 'wrong_category'
  | 'minimum_diff_violation'
  | 'repeat_fix'
  | 'classification_not_actionable';

/** One entry in the SuggestFixResult — either a written suggestion or a rejection. */
export type SuggestFixOutcome =
  | { kind: 'written'; suggestion: Suggestion; jsonPath: string; patchPath: string }
  | { kind: 'rejected'; reason: RejectionReason; detail: string; failure: FixInputEntry['failure'] };

export interface SuggestFixOptions {
  /** Working directory — `reportsDir` is resolved relative to this. */
  cwd: string;
  /** Configuration overrides on top of `DEFAULT_FIX_CONFIG`. */
  config?: Partial<FixConfig>;
  /** When true, computes outcomes but writes nothing to disk. */
  dryRun?: boolean;
  /** "now" injection for deterministic tests. */
  now?: Date;
}

export interface SuggestFixResult {
  outcomes: SuggestFixOutcome[];
  htmlIndexPath: string | null;
  /** Absolute resolved reports directory. */
  reportsDir: string;
}
