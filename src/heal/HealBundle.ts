/**
 * src/heal/HealBundle.ts — assemble the HealInput Claude sees.
 *
 * Strategy §8 + §12. Steps:
 *   1. Grab the live DOM via `page.content()`.
 *   2. Scrub PII (reuse `diagnose/Scrubber.scrubPii`).
 *   3. Size-trim to the 25 KB soft cap. Hard cap at 50 KB — anything
 *      larger is truncated to the soft cap and `dom.truncated=true`.
 *   4. Assemble the HealInput shape (§8) and return it.
 *
 * Trimming strategy: take the SUFFIX of the document inside the hard
 * cap. The interesting part of a page (the data area below nav /
 * head) lives toward the end of the body in most modern app DOMs.
 * Head + global nav rarely contain the failing element. Hard binary
 * search is reserved for a future optimisation if real-project bundles
 * miss the target — for v1 the suffix strategy is the right
 * default. Bundle size is measured as UTF-8 byte length so caps
 * line up with actual prompt-token budgets, not JS string length.
 */

import { scrubPii } from '../diagnose/Scrubber';
import type {
  HealInput,
  HealSelector,
  LocatorMetadata,
} from './types';

export const DOM_SOFT_CAP_BYTES = 25 * 1024;
export const DOM_HARD_CAP_BYTES = 50 * 1024;

export interface PageContentSource {
  content(): Promise<string>;
  url(): string;
}

export interface BuildHealBundleInput {
  page: PageContentSource;
  binding_name: string;
  binding_intent: string;
  original_selector: HealSelector;
  step_being_executed: string;
  pgwen_version: string;
  /**
   * Extra PII regex sources merged on top of the default rule set.
   * Compiles via `scrubPii(opts.extraPatterns)`. Bad regexes are
   * silently skipped by the scrubber.
   */
  scrubberExtraPatterns?: ReadonlyArray<string>;
  /** Pre-built recent-diffs string (optional — gated by config). */
  recent_diffs?: string;
  locator_meta?: LocatorMetadata;
}

export async function buildHealBundle(
  input: BuildHealBundleInput,
): Promise<HealInput> {
  const rawHtml = await input.page.content();
  const scrubbed = input.scrubberExtraPatterns && input.scrubberExtraPatterns.length > 0
    ? scrubPii(rawHtml, { extraPatterns: [...input.scrubberExtraPatterns] })
    : scrubPii(rawHtml);
  const { html, truncated } = trimToCap(scrubbed);

  const result: HealInput = {
    pgwen_version: input.pgwen_version,
    binding_name: input.binding_name,
    binding_intent: input.binding_intent,
    original_selector: input.original_selector,
    step_being_executed: input.step_being_executed,
    dom: { html, truncated },
  };
  if (input.locator_meta !== undefined) result.locator_meta = input.locator_meta;
  if (input.recent_diffs !== undefined && input.recent_diffs.length > 0) {
    result.recent_diffs = input.recent_diffs;
  }
  return result;
}

/**
 * Trim `html` to fit DOM_SOFT_CAP_BYTES. When the input is larger than
 * the hard cap, take only the SUFFIX up to the soft cap (the data
 * area). When the input is between soft and hard, trim down to the
 * soft cap from the suffix as well — the strategy doc says the soft
 * cap is the target, not just the floor.
 *
 * "Truncated" is reported when ANY trimming happened, regardless of
 * which cap was the trigger — Claude needs to know the snapshot is
 * partial.
 */
export function trimToCap(html: string): { html: string; truncated: boolean } {
  const bytes = Buffer.byteLength(html, 'utf-8');
  if (bytes <= DOM_SOFT_CAP_BYTES) return { html, truncated: false };

  // Take the suffix of the document that fits inside DOM_SOFT_CAP_BYTES.
  // Strings index by code units, not bytes, so we approximate then
  // shrink. Worst case is a few UTF-8 surrogate units truncated at the
  // boundary — we walk back to a `<` to avoid splitting a tag.
  const target = DOM_SOFT_CAP_BYTES;
  let start = Math.max(0, html.length - target);
  // Walk forward to the next `<` so the trimmed bundle starts on a
  // tag boundary. If there's no `<` in the suffix at all, just keep
  // the raw suffix — the bundle is unusable HTML but at least it's
  // bounded; Claude will surface low confidence.
  const nextLt = html.indexOf('<', start);
  if (nextLt !== -1 && nextLt - start < 2048) start = nextLt;

  let trimmed = html.slice(start);
  // Re-check byte length; if a wide-char-heavy suffix still exceeds the
  // soft cap, shave from the head until we fit.
  while (Buffer.byteLength(trimmed, 'utf-8') > DOM_SOFT_CAP_BYTES && trimmed.length > 0) {
    trimmed = trimmed.slice(1024);
  }
  return { html: trimmed, truncated: true };
}
