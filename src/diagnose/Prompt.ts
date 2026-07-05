/**
 * Prompt.ts — pure builder for the Anthropic /v1/messages request body
 * (Phase 2 of §16). No I/O, no API key, no network call.
 *
 * Cost-optimised by construction:
 *   - System prompt + tool definition carry `cache_control: ephemeral`
 *     so Anthropic charges ~10% on cached tokens within the 5-min window.
 *   - Forced tool use (`tool_choice: { type: 'tool', name: ... }`) means
 *     Claude returns structured JSON; no parser brittleness, no padding.
 *   - Confidence-tier model routing: when the rule-based classifier was
 *     `medium`, Haiku is plenty; only `low` / `unknown` justifies Sonnet.
 *     Opus is never a default; callers opt in via `opts.model`.
 *
 * Generic by design — no organisation-specific defaults, prompts, or
 * config knobs.
 */

import type { DiagnoseInput } from './types';
import type { FailureClassification } from './Classifier';

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Cheap-and-fast model used when the rule-based prior had medium confidence. */
export const DEFAULT_MODEL_FAST = 'claude-haiku-4-5-20251001';

/** Reasoning model used when the rule-based prior was low / UNKNOWN. */
export const DEFAULT_MODEL_REASONING = 'claude-sonnet-4-6';

/** Tool name Claude is forced to call. */
export const REPORT_DIAGNOSIS_TOOL = 'report_diagnosis';

/**
 * Max output tokens for the diagnosis. A typical DiagnoseOutput serialises
 * to ~300–500 tokens; 800 gives headroom without inviting waffle.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 800;

// ─── Public types — match Anthropic /v1/messages shape ─────────────────────

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: 'ephemeral' };
}

export interface PromptRequestBody {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  messages: UserMessage[];
  tools: ToolDefinition[];
  tool_choice: { type: 'tool'; name: string };
}

export interface PromptOptions {
  /** Override model selection entirely. */
  model?: string;
  /** Override the 800-token output cap. */
  maxTokens?: number;
  /**
   * Replace the built-in system prompt. Advanced — callers that override
   * this must keep the §12 hard rules (`machine_proposal: null` unless
   * locator_drift+high, etc.) in their own prompt or accept the
   * consequences when the patch applier rejects the proposal.
   */
  systemOverride?: string;
}

// ─── Output tool input_schema (mirrors §12 DiagnoseOutput) ─────────────────

const STRING = { type: 'string' as const };
const BOOLEAN = { type: 'boolean' as const };
const INTEGER = { type: 'integer' as const };

const DIAGNOSE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: {
      type: 'string',
      enum: ['locator_drift', 'app_regression', 'timing', 'env', 'test_bug', 'unknown'],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    human_explanation: STRING,
    evidence: { type: 'array', items: STRING },
    alternatives_considered: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { option: STRING, rejected_because: STRING },
        required: ['option', 'rejected_because'],
      },
    },
    files_likely_involved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: STRING,
          role: { type: 'string', enum: ['locator', 'feature', 'app-code', 'config'] },
        },
        required: ['path', 'role'],
      },
    },
    escalation_signals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prior_pgwen_fix_on_same_line: BOOLEAN,
        shared_meta_imported_by_multiple_features: BOOLEAN,
        failure_repeated_in_consecutive_runs: BOOLEAN,
      },
      required: [
        'prior_pgwen_fix_on_same_line',
        'shared_meta_imported_by_multiple_features',
        'failure_repeated_in_consecutive_runs',
      ],
    },
    machine_proposal: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            binding_name: STRING,
            file: STRING,
            line: INTEGER,
            old: STRING,
            new: STRING,
            original_selector_match_count_in_dom: INTEGER,
          },
          required: [
            'binding_name',
            'file',
            'line',
            'old',
            'new',
            'original_selector_match_count_in_dom',
          ],
        },
      ],
    },
    auto_fix_safe: BOOLEAN,
  },
  required: [
    'category',
    'confidence',
    'human_explanation',
    'evidence',
    'alternatives_considered',
    'files_likely_involved',
    'escalation_signals',
    'machine_proposal',
    'auto_fix_safe',
  ],
};

/** Names of the required top-level DiagnoseOutput fields — used by tests to
 *  guard against schema/type drift. */
export const DIAGNOSE_OUTPUT_REQUIRED_FIELDS = [
  'category',
  'confidence',
  'human_explanation',
  'evidence',
  'alternatives_considered',
  'files_likely_involved',
  'escalation_signals',
  'machine_proposal',
  'auto_fix_safe',
] as const;

// ─── System prompt ──────────────────────────────────────────────────────────

/**
 * Stable across calls — lives in the cache_control block. Edits here change
 * the cache key and force a re-cache.
 */
const SYSTEM_PROMPT = `You are a test-failure diagnostic assistant for the pgwen Playwright-based BDD automation framework.

The user message contains a focused failure bundle for a SINGLE failed step, shaped per the pgwen DiagnoseInput type. Your job:

1. Classify the failure into one of: locator_drift, app_regression, timing, env, test_bug, unknown.
2. Provide a concise human-readable explanation for the on-call dev.
3. List the evidence you used (file references, DOM tags, scope bindings cited).
4. Optionally propose a minimum-diff patch — only when the category is locator_drift AND your confidence is high.

Hard rules — violations cause the patch applier to reject your output:
- Report your diagnosis via the report_diagnosis tool only. Do not write prose outside the tool call.
- Never invent files, lines, or selectors not present in the input.
- machine_proposal MUST be null unless category=locator_drift AND confidence=high.
- When machine_proposal is non-null, file MUST equal input.locator.binding_file AND line MUST equal input.locator.binding_line.
- The old field MUST be a verbatim line that already exists in input.locator.binding_context.
- auto_fix_safe is true ONLY when category=locator_drift, confidence=high, AND every escalation_signal is false.

Example — locator_drift:

Input (abbreviated):
  failing.step_text: "I click the submit button"
  failing.error_message: "locator.click: Timeout 5000ms exceeded"
  locator.binding_name: "submit button"
  locator.binding_file: "pgwen/meta/Login.meta"
  locator.binding_line: 12
  locator.binding_context: "  12: submit button can be located by id \\"login-submit\\""
  artifacts.dom_excerpt: "<form><button id=\\"login-go\\">Sign In</button></form>"
  context.sibling_scenarios: [Valid credentials/failed, Invalid credentials/passed]

Expected tool call:
  category: "locator_drift"
  confidence: "high"
  human_explanation: "Selector #login-submit no longer matches. The DOM shows a button with id 'login-go' that is the same target. Sibling scenarios passed, so the app is otherwise healthy."
  evidence: ["pgwen/meta/Login.meta:12 expects id 'login-submit'", "DOM excerpt contains <button id='login-go'>", "Sibling 'Invalid credentials' passed"]
  alternatives_considered: [{option: "[type=submit] CSS", rejected_because: "Risks matching nested forms"}]
  files_likely_involved: [{path: "pgwen/meta/Login.meta", role: "locator"}]
  escalation_signals: {prior_pgwen_fix_on_same_line: false, shared_meta_imported_by_multiple_features: false, failure_repeated_in_consecutive_runs: false}
  machine_proposal: {binding_name: "submit button", file: "pgwen/meta/Login.meta", line: 12, old: "submit button can be located by id \\"login-submit\\"", new: "submit button can be located by id \\"login-go\\"", original_selector_match_count_in_dom: 0}
  auto_fix_safe: true

For categories other than locator_drift, set machine_proposal: null and auto_fix_safe: false, and let human_explanation carry the diagnosis.`;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the request body for a /v1/messages call. Pure — JSON.stringify the
 * return value and POST it. The body is fully self-contained: no API key,
 * no env reads, no HTTP.
 *
 * @param bundle  The §12 DiagnoseInput, ideally already scrubbed by `assembleBundle`.
 * @param prior   The rule-based classifier output gating model choice.
 *                Pass `null` when no classifier was run.
 * @param opts    Per-call overrides; see PromptOptions.
 */
export function buildPrompt(
  bundle: DiagnoseInput,
  prior: FailureClassification | null,
  opts: PromptOptions = {},
): PromptRequestBody {
  const model = opts.model ?? selectModel(prior);
  const max_tokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const systemText = opts.systemOverride ?? SYSTEM_PROMPT;

  return {
    model,
    max_tokens,
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: JSON.stringify(bundle) }],
    tools: [
      {
        name: REPORT_DIAGNOSIS_TOOL,
        description:
          'Report the structured diagnosis for the failure bundle. ' +
          'Call exactly once per invocation; do not call again or emit text outside this call.',
        input_schema: DIAGNOSE_OUTPUT_SCHEMA,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: REPORT_DIAGNOSIS_TOOL },
  };
}

/** Confidence-tier routing: medium → fast/cheap, low or null → reasoning. */
function selectModel(prior: FailureClassification | null): string {
  if (prior?.confidence === 'medium') return DEFAULT_MODEL_FAST;
  // `high` is a caller bug (caller should have skipped Claude entirely) —
  // we still pick the cheap model so the call doesn't burn budget.
  if (prior?.confidence === 'high') return DEFAULT_MODEL_FAST;
  return DEFAULT_MODEL_REASONING;
}
