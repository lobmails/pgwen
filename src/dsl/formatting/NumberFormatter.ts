/**
 * formatting/NumberFormatter.ts — @Number step DSL for number reformatting.
 *
 * Registers these step patterns:
 *   @Number I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar>
 *   @Number I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar> if <condition>
 *
 * The @Number prefix is part of the step text (not stripped as an inline annotation).
 * Format patterns use Java DecimalFormat-style tokens:
 *   # = optional digit, 0 = required digit, . = decimal point, , = grouping separator
 *
 * Examples:
 *   from "#,##0.00" to "0.00"   → parse "1,234.56" → output "1234.56"
 *   from "0.00" to "#,##0.00"   → parse "1234.56"  → output "1,234.56"
 */

import type { DslRegistry } from '../registry';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerNumberFormatter(registry: DslRegistry): void {

  // @Number I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar> if <condition>
  // Must be registered BEFORE the unconditional variant because the unconditional pattern
  // ends with greedy (.+)$ which would also match the " if <condition>" suffix.
  registry.register(
    /^@Number\s+I format (.+?) from "(.+?)" to "(.+?)" as (.+?) if (.+)$/i,
    async ([varRef, inputFmt, outputFmt, newVarRef, condition], scope) => {
      const condValue = scope.get(condition!.trim());
      if (!isTruthy(condValue)) return;
      const varName = stripQuotes(varRef!.trim());
      const newVarName = stripQuotes(newVarRef!.trim());
      const raw = scope.get(varName) ?? '';
      const result = reformatNumber(raw, inputFmt!, outputFmt!);
      scope.set(newVarName, result);
    }
  );

  // @Number I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar>
  registry.register(
    /^@Number\s+I format (.+?) from "(.+?)" to "(.+?)" as (.+)$/i,
    async ([varRef, inputFmt, outputFmt, newVarRef], scope) => {
      const varName = stripQuotes(varRef!.trim());
      const newVarName = stripQuotes(newVarRef!.trim());
      const raw = scope.get(varName) ?? '';
      const result = reformatNumber(raw, inputFmt!, outputFmt!);
      scope.set(newVarName, result);
    }
  );
}

// ─── Number formatting ────────────────────────────────────────────────────────

/**
 * Reformat a number string from one Java DecimalFormat pattern to another.
 * Parses the input string according to inputFmt, then formats as outputFmt.
 * Returns the original string if parsing fails.
 */
export function reformatNumber(numStr: string, inputFmt: string, outputFmt: string): string {
  const value = parseNumber(numStr, inputFmt);
  if (value === null) return numStr;
  return formatNumber(value, outputFmt);
}

/**
 * Parse a number string according to a Java DecimalFormat-style pattern.
 * Strips grouping separators and parses the result as a float.
 */
export function parseNumber(numStr: string, inputFmt: string): number | null {
  // Detect the grouping separator (usually ,) and decimal separator (usually .)
  // from the input format pattern
  const { groupSep, decimalSep } = detectSeparators(inputFmt);

  // Strip grouping separators, convert decimal separator to '.'
  let normalized = numStr.trim();
  if (groupSep) {
    normalized = normalized.split(groupSep).join('');
  }
  if (decimalSep && decimalSep !== '.') {
    normalized = normalized.replace(decimalSep, '.');
  }

  const n = parseFloat(normalized);
  if (isNaN(n)) return null;
  return n;
}

/**
 * Format a number using a Java DecimalFormat-style pattern.
 */
export function formatNumber(value: number, outputFmt: string): string {
  const { groupSep, decimalSep, decimalPlaces, hasGrouping } = analyzeFormat(outputFmt);

  let result: string;
  if (decimalPlaces >= 0) {
    result = value.toFixed(decimalPlaces);
  } else {
    result = String(value);
  }

  // Apply grouping separator
  if (hasGrouping && groupSep) {
    const [intPart, fracPart] = result.split('.');
    const grouped = (intPart ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
    result = fracPart !== undefined ? `${grouped}${decimalSep ?? '.'}${fracPart}` : grouped;
  } else if (decimalSep && decimalSep !== '.') {
    result = result.replace('.', decimalSep);
  }

  return result;
}

// ─── Format analysis ──────────────────────────────────────────────────────────

interface SeparatorInfo {
  groupSep: string;
  decimalSep: string;
}

interface FormatInfo extends SeparatorInfo {
  decimalPlaces: number;
  hasGrouping: boolean;
}

function detectSeparators(fmt: string): SeparatorInfo {
  // In Java DecimalFormat, the grouping separator is typically ',' and decimal is '.'
  // We infer from the pattern itself
  const hasCommaBeforeDot = /,.*\./.test(fmt);
  const hasDotBeforeComma = /\..*,/.test(fmt);

  if (hasCommaBeforeDot) {
    return { groupSep: ',', decimalSep: '.' };
  } else if (hasDotBeforeComma) {
    return { groupSep: '.', decimalSep: ',' };
  }
  // Default
  return { groupSep: ',', decimalSep: '.' };
}

function analyzeFormat(fmt: string): FormatInfo {
  const { groupSep, decimalSep } = detectSeparators(fmt);
  const hasGrouping = fmt.includes(groupSep);

  // Count decimal places after the decimal separator
  const decIdx = fmt.lastIndexOf('.');
  let decimalPlaces = -1;
  if (decIdx !== -1) {
    const fracPart = fmt.slice(decIdx + 1);
    // Count # and 0 characters
    const places = (fracPart.match(/[#0]/g) ?? []).length;
    decimalPlaces = places;
  }

  return { groupSep, decimalSep, decimalPlaces, hasGrouping };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function isTruthy(val: string | undefined): boolean {
  if (!val) return false;
  const lower = val.toLowerCase();
  return lower !== 'false' && lower !== '0' && lower !== 'no' && lower !== '';
}
