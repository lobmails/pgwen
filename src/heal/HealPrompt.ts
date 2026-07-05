/**
 * src/heal/HealPrompt.ts — pure builder for the `propose_locator` request.
 *
 * Strategy §8 schema. The bundle (HealInput) becomes the user message
 * (`JSON.stringify(bundle)`); the system prompt + tool definition
 * carry `cache_control: ephemeral` so Anthropic charges ~10% on
 * cached tokens within the 5-min window — the same trick diagnose
 * uses.
 *
 * Model routing (strategy §8): high-confidence target → Haiku; lower
 * → Sonnet. Opus is opt-in only and discouraged for heal (latency too
 * high for the hot path).
 *
 * Pure: no I/O, no API key, no network call. Cost-estimable from the
 * returned body alone.
 */

import type { PromptRequestBody, SystemBlock, ToolDefinition } from '../diagnose/Prompt';
import {
  DEFAULT_MODEL_FAST,
  DEFAULT_MODEL_REASONING,
} from '../diagnose/Prompt';
import type { DiagnoseConfidence } from '../diagnose/types';
import type { HealInput } from './types';

export const PROPOSE_LOCATOR_TOOL_NAME = 'propose_locator';

/** Tiny — Claude returns ~50-150 token proposal. 1024 is plenty. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

const SYSTEM_PROMPT =
  'You are pgwen-heal: a structured locator-proposal assistant. Given a ' +
  'failed locator binding from a Playwright-based project and a scrubbed DOM ' +
  'snapshot, propose ONE replacement selector that uniquely identifies the ' +
  'same logical element on the current page. ' +
  '\n\n' +
  'CONSTRAINTS:\n' +
  '- Call `propose_locator` exactly once. Do not emit free text.\n' +
  '- selector_type must be one of: id, name, css, xpath, text, js.\n' +
  '- Reply with confidence="high" ONLY when you can point to a stable, ' +
  'unique attribute (data-test-id, role, name) that you can see in the DOM.\n' +
  '- If the DOM excerpt is too partial to be sure, reply with ' +
  'confidence="low" — the validator will reject low confidence and the ' +
  'step will fail normally. That is the correct outcome when uncertain.\n' +
  '- Reasoning must be ≤500 chars and cite specific attributes you saw.\n' +
  '- Never suggest a selector identical to original_selector — the ' +
  'validator will reject that.\n';

export interface BuildHealPromptOptions {
  /**
   * Model override. When unset:
   *   - target confidence "high" → Haiku (cheaper, faster)
   *   - any other target          → Sonnet
   * Opus is never the default; callers must opt in explicitly.
   */
  model?: string;
  maxTokens?: number;
  /**
   * Hint for model routing only. The validator independently enforces
   * the high-confidence floor (strategy §6.7) regardless of what's
   * declared here.
   */
  targetConfidence?: DiagnoseConfidence;
}

/**
 * Build the Anthropic /v1/messages body for one heal attempt. Pure —
 * the same bundle + opts ALWAYS produces the same body.
 */
export function buildHealPrompt(
  bundle: HealInput,
  opts: BuildHealPromptOptions = {},
): PromptRequestBody {
  const model = opts.model ?? selectModel(opts.targetConfidence);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const system: SystemBlock[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];

  return {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: JSON.stringify(bundle) }],
    tools: [proposeLocatorTool()],
    tool_choice: { type: 'tool', name: PROPOSE_LOCATOR_TOOL_NAME },
  };
}

/**
 * Tool definition for `propose_locator`. Exported so HealValidator
 * can cross-check the response shape against the same schema and
 * tests can snapshot it.
 */
export function proposeLocatorTool(): ToolDefinition {
  return {
    name: PROPOSE_LOCATOR_TOOL_NAME,
    description:
      'Report a single replacement locator for the failed binding. ' +
      'Call exactly once per invocation; do not emit text outside this call.',
    input_schema: {
      type: 'object',
      required: ['selector_type', 'selector_value', 'confidence', 'reasoning'],
      properties: {
        selector_type: {
          type: 'string',
          enum: ['id', 'name', 'css', 'xpath', 'text', 'js'],
          description:
            'Locator strategy. Must be one of the values pgwen\'s `can be located by` DSL supports.',
        },
        selector_value: {
          type: 'string',
          minLength: 1,
          description:
            'The selector text, in the format the chosen strategy expects (id="login-btn" → just "login-btn", css="#main .btn" → "#main .btn", etc.).',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description:
            'high = stable unique attribute visible in DOM; medium = best guess; low = uncertain (validator will reject).',
        },
        reasoning: {
          type: 'string',
          maxLength: 500,
          description:
            'Brief explanation citing specific attributes you saw in the DOM snapshot. ≤500 chars.',
        },
        expected_element_tag: {
          type: 'string',
          description:
            'Lowercase tag name the proposed selector should match. Used by the validator\'s tag-class sanity check.',
        },
      },
      additionalProperties: false,
    },
    cache_control: { type: 'ephemeral' },
  };
}

function selectModel(targetConfidence: DiagnoseConfidence | undefined): string {
  // High-confidence heals are the common case (strategy §6.7 only
  // accepts "high" from Claude), so the cheap model is the right
  // default. Lower-confidence routing exists for completeness — the
  // validator rejects them, but logging the attempt is still useful.
  if (targetConfidence === 'high' || targetConfidence === undefined) {
    return DEFAULT_MODEL_FAST;
  }
  return DEFAULT_MODEL_REASONING;
}
