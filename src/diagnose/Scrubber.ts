/**
 * Scrubber.ts — generic PII scrubber for diagnose bundles (Phase 1 of §16).
 *
 * Runs on free-form text fields of a DiagnoseInput before the bundle leaves
 * the local machine. The default rule-set is intentionally conservative
 * and organisation-independent: it covers patterns common to web RPA work
 * (email, phone, credit card, JWT). Projects add domain-specific patterns via
 * `extraPatterns` — no upstream code change required.
 *
 * Design notes:
 *   - Pure functions, no I/O.
 *   - Every match becomes `[REDACTED-<TYPE>]`. The replacement carries no
 *     characters any other rule matches, so passes are order-safe.
 *   - Idempotent: re-running on already-scrubbed text is a no-op.
 *   - The scrubber is ON by default. Callers opt out via `{ disabled: true }`.
 */

import type { DiagnoseInput } from './types';

export interface ScrubberOptions {
  /**
   * When true, every function below becomes a pass-through. Use only when
   * the caller is sure the input is already safe (e.g. internal tests).
   */
  disabled?: boolean;
  /**
   * Extra regex source strings appended to the default rule set. Each
   * match is replaced with `[REDACTED-CUSTOM]`. The strings are compiled
   * with the `g` flag automatically; do not include flags in the input.
   */
  extraPatterns?: string[];
}

// ─── Default rule set ───────────────────────────────────────────────────────

interface Rule {
  name: string;          // appears in the [REDACTED-<NAME>] marker
  pattern: RegExp;       // must carry the `g` flag
  /** Optional validator — only replaced when this returns true. */
  validate?: (match: string) => boolean;
}

const RULES: Rule[] = [
  // JWT — three base64url segments separated by dots, leading `eyJ`.
  {
    name: 'JWT',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  // Email. Local-part and label lengths are bounded (RFC limit: 64 / 63)
  // so the regex cannot backtrack catastrophically on long runs of
  // alphanumeric input that never reach an `@`.
  {
    name: 'EMAIL',
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?){1,9}/g,
  },
  // Credit-card-shaped digit runs (13–19 digits with optional separators),
  // Luhn-validated to filter out random number sequences.
  {
    name: 'CARD',
    pattern: /(?<![\d.])(?:\d[\s-]?){12,18}\d(?![\d.])/g,
    validate: (match) => luhnCheck(match.replace(/\D/g, '')),
  },
  // International E.164: `+` followed by 8–15 digits.
  {
    name: 'PHONE',
    pattern: /(?<![\d+])\+\d{8,15}(?!\d)/g,
  },
  // AU mobile (04xx xxx xxx) and the +61 4xx variant.
  {
    name: 'PHONE',
    pattern: /(?<![\d+])(?:\+?61\s?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g,
  },
  // AU 1300 / 1800 / 13xx numbers.
  {
    name: 'PHONE',
    pattern: /(?<!\d)(?:1[38]00|13\d{2})[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g,
  },
];

function luhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Scrub a free-form string. Returns the scrubbed copy (input is never
 * mutated). When `opts.disabled` is true, returns the input verbatim.
 */
export function scrubPii(text: string, opts: ScrubberOptions = {}): string {
  if (opts.disabled) return text;
  if (text.length === 0) return text;

  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => {
      if (rule.validate && !rule.validate(match)) return match;
      return `[REDACTED-${rule.name}]`;
    });
  }

  if (opts.extraPatterns && opts.extraPatterns.length > 0) {
    for (const source of opts.extraPatterns) {
      const compiled = compileExtra(source);
      if (compiled) out = out.replace(compiled, '[REDACTED-CUSTOM]');
    }
  }

  return out;
}

function compileExtra(source: string): RegExp | null {
  try {
    return new RegExp(source, 'g');
  } catch {
    // Bad user-supplied regex is non-fatal — silently skip rather than
    // refuse to scrub the rest of the bundle.
    return null;
  }
}

/**
 * Scrub every free-form text field on a DiagnoseInput. Identifying
 * fields (feature_file, scenario_name, etc.) are left untouched — they
 * are never expected to contain PII in pgwen's data flow. The returned
 * bundle is a structural copy; the input is not mutated.
 */
export function scrubDiagnoseInput(
  bundle: DiagnoseInput,
  opts: ScrubberOptions = {},
): DiagnoseInput {
  if (opts.disabled) return bundle;

  const scrub = (s: string): string => scrubPii(s, opts);
  const scrubNullable = (s: string | null): string | null => (s === null ? null : scrub(s));

  return {
    failing: {
      ...bundle.failing,
      step_text: scrub(bundle.failing.step_text),
      error_message: scrub(bundle.failing.error_message),
    },
    locator: bundle.locator
      ? { ...bundle.locator, binding_context: scrub(bundle.locator.binding_context) }
      : null,
    artifacts: {
      ...bundle.artifacts,
      dom_excerpt: scrubNullable(bundle.artifacts.dom_excerpt),
    },
    context: bundle.context,
    history: {
      ...bundle.history,
      recent_diffs: scrub(bundle.history.recent_diffs),
    },
  };
}
