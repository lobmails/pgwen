/**
 * types.ts — the diagnose contract.
 *
 * Single typed pair (`DiagnoseInput`, `DiagnoseOutput`) shared by the
 * focused-failure-bundle assembler (§11) and the Claude prompt layer (§16).
 * Lands BEFORE any prompting code so the validator and the prompt template
 * share one ground truth — see pgwen-ai-fix-strategy.md §12.
 *
 * Hard rules baked into the type:
 *   - `locator` is `null` when the failing step has no resolvable locator.
 *   - `machine_proposal` is `null` unless category=locator_drift AND
 *     confidence=high — enforced by the patch applier ("no proposal, no
 *     patch").
 *   - `human_explanation` is always populated; the patch applier MUST NOT
 *     parse it into a diff.
 */

export type DiagnoseInput = {
  failing: {
    feature_name: string;
    feature_file: string;
    scenario_name: string;
    step_text: string;
    step_keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
    /** Constructor name of the thrown error, e.g. 'TimeoutError', 'DslAssertionError'. */
    error_class: string;
    error_message: string;
  };
  locator: {
    binding_name: string;
    /** Strategy token from the binding declaration: 'id' | 'css' | 'xpath' | 'name' | 'class' | 'tag' | 'link' | 'js' | ... */
    selector_strategy: string;
    selector_value: string;
    binding_line: number;
    /** .meta or .feature file path where the binding was declared. */
    binding_file: string;
    /** ±5 lines of context around the binding, line-numbered. */
    binding_context: string;
  } | null;
  artifacts: {
    trace_zip_path: string | null;
    /** Pre-failure DOM excerpt around the locator (~10 KB cap, hard cap ~25 KB). */
    dom_excerpt: string | null;
    /** Present for second-pass / visual-regression use; NOT sent in the default bundle. */
    screenshot_path: string | null;
  };
  context: {
    /** Value of pgwen.target.env at run time. */
    target_env: string;
    browser: string;
    /** "WxH" string, e.g. "1280x720". */
    viewport: string;
    /** Status of every scenario in the failing feature, including this one. */
    sibling_scenarios: Array<{
      name: string;
      status: 'passed' | 'failed' | 'skipped';
    }>;
  };
  history: {
    /** Last N commits' diffs filtered to .meta / .feature files involved in this failure. */
    recent_diffs: string;
    /** SHA of a prior pgwen-fix commit that touched this same line, or null. */
    prior_pgwen_fix_marker: string | null;
  };
};

export type DiagnoseCategory =
  | 'locator_drift'
  | 'app_regression'
  | 'timing'
  | 'env'
  | 'test_bug'
  | 'unknown';

export type DiagnoseConfidence = 'high' | 'medium' | 'low';

export type DiagnoseOutput = {
  category: DiagnoseCategory;
  confidence: DiagnoseConfidence;
  /** Free-form prose written for the on-call dev. ALWAYS present. */
  human_explanation: string;
  /** Ranked, factual citations Claude actually used (file refs, DOM tags, scope bindings). */
  evidence: string[];
  alternatives_considered: Array<{
    option: string;
    rejected_because: string;
  }>;
  files_likely_involved: Array<{
    path: string;
    role: 'locator' | 'feature' | 'app-code' | 'config';
  }>;
  /** Booleans diagnose can observe but must not decide on — surfaced for the human reviewer. */
  escalation_signals: {
    prior_pgwen_fix_on_same_line: boolean;
    shared_meta_imported_by_multiple_features: boolean;
    failure_repeated_in_consecutive_runs: boolean;
  };
  /**
   * Structured patch proposal for the applier. NEVER derived from
   * `human_explanation`. `null` unless category=locator_drift AND
   * confidence=high AND no escalation signal fires — the type encodes
   * "no proposal, no patch".
   */
  machine_proposal: {
    binding_name: string;
    file: string;
    line: number;
    old: string;
    new: string;
    /** Sanity check: how many elements the OLD selector matched in the pre-failure DOM. */
    original_selector_match_count_in_dom: number;
  } | null;
  /**
   * Derived flag the auto-apply path keys off. True only when category=locator_drift,
   * confidence=high, and no escalation signal fires. Patch applier MUST re-check this
   * server-side rather than trusting the field blindly.
   */
  auto_fix_safe: boolean;
};

/** Hard cap for the assembled bundle JSON, enforced as a unit-test invariant. See §11. */
export const DIAGNOSE_BUNDLE_HARD_CAP_BYTES = 50 * 1024;

/** Soft target the assembler aims for; exceeding it triggers DOM-excerpt trimming. */
export const DIAGNOSE_BUNDLE_SOFT_CAP_BYTES = 25 * 1024;
