/**
 * @pgwen/fix — peer package for AI-proposed locator fixes.
 *
 * See README.md for the §14 module-boundary rationale: this package
 * holds everything that touches git, gh, and the patch-applying surface,
 * so that `@pgwen/core` has no compile-time path to those concerns.
 *
 * v1 ships suggest-only mode (`runSuggestFix`) — writes structured
 * suggestions + a self-contained HTML index, never modifies source.
 * The branch/PR auto-apply surface (`applyMachineProposal`) remains a
 * §14 skeleton gated on the strategy doc's open governance questions.
 */

// Suggest-only mode (v1 surface).
export { runSuggestFix, resolveConfig } from './Suggest';
export { buildUnifiedDiff } from './PatchApplier';
export { validateSuggestion } from './MinimumDiffValidator';
export {
  appendHistory,
  readHistory,
  countPriorAttempts,
  isRepeatFix,
  buildHistoryKey,
} from './RepeatFixDetector';
export {
  writeSuggestion,
  readSuggestions,
  slugify,
  buildSuggestionId,
} from './SuggestionWriter';
export { renderHtmlReport, writeHtmlReport, escapeHtml } from './HtmlReport';
export {
  postPullRequestComment,
  buildCommentBody,
  COMMENT_MARKER,
} from './GithubCommenter';
export { runCli, parseCliArgs } from './cli';

// Auto-apply surface — implemented as of Phase 2. The boundary test
// asserts these symbols stay exported from index.ts. Suggest-only mode
// uses `runSuggestFix` (above); auto-apply orchestration calls these
// three in sequence (validate → detect → apply) once §18 governance
// answers gate the CLI flag.
export { applyMachineProposal, DEFAULT_APPLY_OPTS } from './PatchApplier';
export { validateMinimumDiff } from './MinimumDiffValidator';
export { detectPriorPgwenFix } from './RepeatFixDetector';

export type {
  DiagnoseCategory,
  DiagnoseConfidence,
  DiagnoseOutput,
  MachineProposal,
  EscalationSignals,
  ApplyOpts,
  ApplyResult,
  MinimumDiffValidation,
  RepeatFixCheck,
  // Suggest-only mode types
  FixInputEntry,
  FixConfig,
  Suggestion,
  SuggestFixOptions,
  SuggestFixOutcome,
  SuggestFixResult,
  RejectionReason,
} from './types';
export { DEFAULT_FIX_CONFIG } from './types';

export { NotImplementedError } from './types';
