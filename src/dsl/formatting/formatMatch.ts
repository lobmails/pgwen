/**
 * formatMatch.ts — pattern-matching helpers behind the
 * "should (not )?match (datetime|number) format '<p>'" DSL set.
 *
 * Layers on top of the existing parseDate / parseNumber primitives in
 * the same directory — they already understand pgwen's Java-style date
 * patterns (yyyy/MM/dd/HH/mm/ss/SSS plus literals) and locale-flexible
 * number patterns (#,##0.00 / 0.00 / etc.). All this module adds is a
 * boolean shape check: "can `value` be parsed under `pattern`?".
 *
 * Pure, no I/O. Used by every assertion + guard surface that supports
 * the format-match step forms (plain ref, page title, URL, dropdowns,
 * popups, JSON path, XPath, control-flow conditions).
 */

import { parseDate } from './DateTimeFormatter';
import { parseNumber } from './NumberFormatter';

/**
 * True when `value` can be parsed as a date under the given pattern.
 * Empty input → false (no spurious matches on undefined / blank refs).
 */
export function matchesDateTimeFormat(value: string, pattern: string): boolean {
  if (value == null) return false;
  const v = String(value);
  if (v.length === 0) return false;
  return parseDate(v, pattern) !== null;
}

/**
 * True when `value` can be parsed as a number under the given pattern.
 * Empty input → false.
 */
export function matchesNumberFormat(value: string, pattern: string): boolean {
  if (value == null) return false;
  const v = String(value);
  if (v.length === 0) return false;
  return parseNumber(v, pattern) !== null;
}

export type FormatKind = 'datetime' | 'number';

/** Single entry-point used by the assertion + guard wirings. */
export function matchesFormat(kind: FormatKind, value: string, pattern: string): boolean {
  return kind === 'datetime'
    ? matchesDateTimeFormat(value, pattern)
    : matchesNumberFormat(value, pattern);
}
