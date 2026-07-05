/**
 * src/heal/HealValidator.ts — validate a Claude proposal against the live page.
 *
 * Strategy §6.8 + §6.9 + §A6. Three checks, run in this order:
 *
 *   1. identity — proposal.selector_value !== original.value (when
 *      same selector_type). Catches the case where Claude returns
 *      the failing selector unchanged.
 *   2. exact-one-match — proposed selector locates EXACTLY ONE element.
 *      Zero matches OR 2+ matches both fail.
 *   3. tag-match — located element's tag is consistent with the
 *      original binding's LocatorMetadata.expected_tag, when present.
 *
 * Validator is purely structural: no semantic checks ("is this button
 * labeled 'Submit'?"). Semantic validation re-introduces AI in the
 * validation step, defeating the gate. Strategy §A6.
 *
 * Each rule can be individually disabled via `requireExactOneMatch` /
 * `requireTagMatch` (config-driven), but disabling them is strongly
 * discouraged — the floor exists for a reason.
 */

import type { HealProposal, HealSelector, LocatorMetadata } from './types';

export type ValidatorReason =
  | 'zero_match'
  | 'multi_match'
  | 'tag_mismatch'
  | 'no_change';

export interface ValidatorResult {
  ok: boolean;
  reason?: ValidatorReason;
  matched_tag?: string;
  match_count?: number;
}

/**
 * Minimal Playwright page surface the validator needs. The actual
 * Playwright wiring lives in `dsl/locatorUtils.ts` and is bridged in
 * HealPipeline (Phase 3.6) — this interface keeps the validator
 * testable with a synthetic mock.
 */
export interface PageValidatorSource {
  countMatches(proposal: HealProposal): Promise<number>;
  firstMatchTag(proposal: HealProposal): Promise<string | null>;
}

export interface ValidateInputs {
  page: PageValidatorSource;
  proposal: HealProposal;
  original: HealSelector;
  locator_meta?: LocatorMetadata;
  /** When false, skip the exact-one-match check (default true; strategy §10). */
  requireExactOneMatch?: boolean;
  /** When false, skip the tag check (default true; strategy §10). */
  requireTagMatch?: boolean;
}

export async function validate(inputs: ValidateInputs): Promise<ValidatorResult> {
  const requireExactOneMatch = inputs.requireExactOneMatch ?? true;
  const requireTagMatch = inputs.requireTagMatch ?? true;

  // 1. Identity — proposal is byte-equal to original. Same selector
  //    type AND identical value (case-sensitive for ids/css/xpath;
  //    whitespace-trimmed first to forgive trivial reformatting).
  if (
    inputs.proposal.selector_type === inputs.original.type &&
    inputs.proposal.selector_value.trim() === inputs.original.value.trim()
  ) {
    return { ok: false, reason: 'no_change' };
  }

  // 2. Exact-one-match.
  if (requireExactOneMatch) {
    const count = await inputs.page.countMatches(inputs.proposal);
    if (count === 0) {
      return { ok: false, reason: 'zero_match', match_count: 0 };
    }
    if (count > 1) {
      return { ok: false, reason: 'multi_match', match_count: count };
    }
  }

  // 3. Tag-match.
  if (requireTagMatch) {
    const expected = preferTag(inputs.locator_meta, inputs.proposal);
    if (expected !== undefined) {
      const tag = await inputs.page.firstMatchTag(inputs.proposal);
      if (tag === null) {
        // The exact-one-match check is normally responsible for
        // catching zero matches, but when it's disabled the tag
        // check needs its own safety net.
        return { ok: false, reason: 'zero_match', match_count: 0 };
      }
      if (tag.toLowerCase() !== expected.toLowerCase()) {
        return { ok: false, reason: 'tag_mismatch', matched_tag: tag };
      }
    }
  }

  // Optional return shape — only include match metadata when the
  // exact-one-match check ran.
  const result: ValidatorResult = { ok: true };
  if (requireExactOneMatch) {
    result.match_count = 1;
  }
  if (requireTagMatch) {
    const expected = preferTag(inputs.locator_meta, inputs.proposal);
    if (expected !== undefined) {
      result.matched_tag = expected.toLowerCase();
    }
  }
  return result;
}

/**
 * Pick the expected tag from the locator metadata if present;
 * otherwise fall back to the proposal's self-declared
 * `expected_element_tag` (Claude's own claim). Returns undefined
 * when neither side declares a tag — in that case the tag check
 * is a no-op for this proposal.
 */
function preferTag(
  meta: LocatorMetadata | undefined,
  proposal: HealProposal,
): string | undefined {
  if (meta?.expected_tag) return meta.expected_tag;
  if (proposal.expected_element_tag) return proposal.expected_element_tag;
  return undefined;
}
