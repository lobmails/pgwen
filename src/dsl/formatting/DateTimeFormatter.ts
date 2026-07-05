/**
 * formatting/DateTimeFormatter.ts — @DateTime step DSL for date reformatting.
 *
 * Registers these step patterns:
 *   @DateTime I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar>
 *   @DateTime I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar> if <condition>
 *
 * The @DateTime prefix is part of the step text (not stripped as an inline annotation).
 * Format patterns use Java DateTimeFormatter-style tokens:
 *   yyyy, yy, MM, M, dd, d, HH, H, mm, m, ss, s, SSS
 * Ordinal suffix: d(st|nd|rd|th) in output format produces "1st", "2nd", etc.
 *
 * Both <var> and <newVar> can be quoted ("name") or unquoted (name).
 */

import type { DslRegistry } from '../registry';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerDateTimeFormatter(registry: DslRegistry): void {

  // <name> is the current date formatted as "<format>"
  // <name> is the current date time formatted as "<format>"
  // the DSL parity: binds the current date/time as a named scope binding.
  registry.register(
    /^(.+?) is the current date(?:[ -]?time)? formatted as "(.+)"$/i,
    async ([nameRaw, fmtRaw], scope) => {
      const name = stripQuotes(nameRaw!.trim());
      const fmt = fmtRaw!.trim();
      scope.setTransparent(name, formatDate(new Date(), fmt));
    }
  );

  // <name> is formatted as "<format>" from <dateRef>
  // the DSL parity: re-format a bound date variable using the given Java-style pattern.
  registry.register(
    /^(.+?) is formatted as "(.+?)" from (.+)$/i,
    async ([nameRaw, fmtRaw, dateRefRaw], scope) => {
      const name = stripQuotes(nameRaw!.trim());
      const fmt = fmtRaw!.trim();
      const dateRef = stripQuotes(dateRefRaw!.trim());
      const raw = scope.get(dateRef) ?? '';
      // Try ISO parse first, then fall back to reformatDate with guessed input format
      const date = new Date(raw);
      const result = isNaN(date.getTime())
        ? reformatDate(raw, 'yyyy-MM-dd', fmt) // best-effort if not ISO
        : formatDate(date, fmt);
      scope.setTransparent(name, result);
    }
  );

  // @DateTime I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar> if <condition>
  // Must be registered BEFORE the unconditional variant because the unconditional pattern
  // ends with greedy (.+)$ which would also match the " if <condition>" suffix.
  registry.register(
    /^@DateTime\s+I format (.+?) from "(.+?)" to "(.+?)" as (.+?) if (.+)$/i,
    async ([varRef, inputFmt, outputFmt, newVarRef, condition], scope) => {
      const condValue = await readScope(scope, condition!.trim());
      if (!isTruthy(condValue)) return;
      const varName = stripQuotes(varRef!.trim());
      const newVarName = stripQuotes(newVarRef!.trim());
      const raw = (await readScope(scope, varName)) ?? '';
      const result = reformatDate(raw, inputFmt!, outputFmt!);
      scope.set(newVarName, result);
    }
  );

  // @DateTime I format <var> from "<inputFmt>" to "<outputFmt>" as <newVar>
  registry.register(
    /^@DateTime\s+I format (.+?) from "(.+?)" to "(.+?)" as (.+)$/i,
    async ([varRef, inputFmt, outputFmt, newVarRef], scope) => {
      const varName = stripQuotes(varRef!.trim());
      const newVarName = stripQuotes(newVarRef!.trim());
      const raw = (await readScope(scope, varName)) ?? '';
      const result = reformatDate(raw, inputFmt!, outputFmt!);
      scope.set(newVarName, result);
    }
  );
}

/**
 * Read a scope binding tolerating async lazy resolvers. Try sync `scope.get()`
 * first; if it throws because the binding is registered as an async lazy
 * (`is defined by js`), await `scope.resolveAsync()` instead. Same pattern
 * used by `evalCondition` and `resolveRef`.
 */
async function readScope(
  scope: { get(n: string): string | undefined; resolveAsync(n: string): Promise<string | undefined> },
  key: string,
): Promise<string | undefined> {
  try {
    return scope.get(key);
  } catch (e) {
    if (e instanceof Error && e.message.includes('async lazy resolver')) {
      return scope.resolveAsync(key);
    }
    throw e;
  }
}

// ─── Date formatting ──────────────────────────────────────────────────────────

/**
 * Reformat a date string from one Java-style pattern to another.
 * Parses the input string according to inputFmt, then formats as outputFmt.
 * Returns the original string if parsing fails.
 */
export function reformatDate(dateStr: string, inputFmt: string, outputFmt: string): string {
  const date = parseDate(dateStr, inputFmt);
  if (!date) return dateStr;
  return formatDate(date, outputFmt);
}

/**
 * Parse a date string according to a Java DateTimeFormatter-style pattern.
 * Supports: yyyy, yy, MM, M, dd, d, HH, H, mm, m, ss, s
 */
export function parseDate(dateStr: string, pattern: string): Date | null {
  // Build a regex from the pattern that captures each field
  const fields: string[] = [];
  let regexStr = escapeRegex(pattern);

  // Replace format tokens with capture groups (longest first to avoid partial matches)
  const tokenMap: Array<[string, string]> = [
    ['yyyy', '(\\d{4})'],
    ['yy',   '(\\d{2})'],
    ['MM',   '(\\d{2})'],
    ['M',    '(\\d{1,2})'],
    ['dd',   '(\\d{2})'],
    ['d(?!\\()',    '(\\d{1,2})'],  // d but not d(st|nd|rd|th)
    ['HH',   '(\\d{2})'],
    ['H',    '(\\d{1,2})'],
    ['mm',   '(\\d{2})'],
    ['m',    '(\\d{1,2})'],
    ['ss',   '(\\d{2})'],
    ['s',    '(\\d{1,2})'],
    ['SSS',  '(\\d{3})'],
  ];

  // We use a different approach: parse the pattern token by token
  const parts = tokenisePattern(pattern);
  let regexParts = '';
  const fieldOrder: string[] = [];

  for (const part of parts) {
    if (part.type === 'token') {
      fieldOrder.push(part.value);
      switch (part.value) {
        case 'yyyy': regexParts += '(\\d{4})'; break;
        case 'yy':   regexParts += '(\\d{2})'; break;
        case 'MM':   regexParts += '(\\d{2})'; break;
        case 'M':    regexParts += '(\\d{1,2})'; break;
        case 'dd':   regexParts += '(\\d{2})'; break;
        case 'd':    regexParts += '(\\d{1,2})'; break;
        case 'HH':   regexParts += '(\\d{2})'; break;
        case 'H':    regexParts += '(\\d{1,2})'; break;
        case 'mm':   regexParts += '(\\d{2})'; break;
        case 'm':    regexParts += '(\\d{1,2})'; break;
        case 'ss':   regexParts += '(\\d{2})'; break;
        case 's':    regexParts += '(\\d{1,2})'; break;
        case 'SSS':  regexParts += '(\\d{3})'; break;
        default:     fieldOrder.pop(); regexParts += escapeRegex(part.value); break;
      }
    } else {
      // Literal text
      regexParts += escapeRegex(part.value);
    }
  }

  void tokenMap; void regexStr; void fields; // suppress unused warnings

  let match: RegExpMatchArray | null;
  try {
    match = new RegExp(`^${regexParts}$`).exec(dateStr);
  } catch {
    return null;
  }
  if (!match) return null;

  let year = 2000, month = 1, day = 1, hour = 0, minute = 0, second = 0;

  for (let i = 0; i < fieldOrder.length; i++) {
    const val = parseInt(match[i + 1]!, 10);
    const field = fieldOrder[i]!;
    if (field === 'yyyy') year = val;
    else if (field === 'yy') year = val < 70 ? 2000 + val : 1900 + val;
    else if (field === 'MM' || field === 'M') month = val;
    else if (field === 'dd' || field === 'd') day = val;
    else if (field === 'HH' || field === 'H') hour = val;
    else if (field === 'mm' || field === 'm') minute = val;
    else if (field === 'ss' || field === 's') second = val;
  }

  const date = new Date(year, month - 1, day, hour, minute, second);
  if (isNaN(date.getTime())) return null;
  return date;
}

/**
 * Format a Date object using a Java DateTimeFormatter-style pattern.
 * Supports ordinal suffix: d(st|nd|rd|th) → "1st", "2nd", "3rd", "4th"
 */
export function formatDate(date: Date, pattern: string): string {
  const y = date.getFullYear();
  const M = date.getMonth() + 1;
  const d = date.getDate();
  const H = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const ms = date.getMilliseconds();

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');

  // Two-pass approach: replace ordinal placeholder with a sentinel first, apply
  // all other token replacements, then swap the sentinel for the real ordinal value.
  // This prevents single-char tokens (s, d, m, H) from corrupting the ordinal output.
  const ORDINAL_SENTINEL = '\x00ORD\x00';
  const hasOrdinal = /d\(st\|nd\|rd\|th\)/.test(pattern);
  const step1 = hasOrdinal
    ? pattern.replace(/d\(st\|nd\|rd\|th\)/g, ORDINAL_SENTINEL)
    : pattern;

  const step2 = step1
    .replace('yyyy', String(y))
    .replace('yy',   String(y).slice(-2))
    .replace('MM',   pad2(M))
    .replace('M',    String(M))
    .replace('dd',   pad2(d))
    .replace('d',    String(d))
    .replace('HH',   pad2(H))
    .replace('H',    String(H))
    .replace('mm',   pad2(m))
    .replace('m',    String(m))
    .replace('ss',   pad2(s))
    .replace('s',    String(s))
    .replace('SSS',  pad3(ms));

  return hasOrdinal
    ? step2.split(ORDINAL_SENTINEL).join(ordinal(d))
    : step2;
}

// ─── Pattern tokeniser ────────────────────────────────────────────────────────

type PatternPart = { type: 'token' | 'literal'; value: string };

const DATE_TOKENS = ['yyyy', 'yy', 'MM', 'dd', 'HH', 'mm', 'ss', 'SSS', 'M', 'd', 'H', 'm', 's'];

function tokenisePattern(pattern: string): PatternPart[] {
  const parts: PatternPart[] = [];
  let i = 0;
  while (i < pattern.length) {
    let matched = false;
    for (const token of DATE_TOKENS) {
      if (pattern.startsWith(token, i)) {
        // Special case: 'd' should not match 'd(' (ordinal placeholder) at start of d(st|nd|rd|th)
        if (token === 'd' && pattern[i + 1] === '(') break;
        parts.push({ type: 'token', value: token });
        i += token.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Ordinal: d(st|nd|rd|th) is a single token
      if (pattern.startsWith('d(st|nd|rd|th)', i)) {
        parts.push({ type: 'token', value: 'd(st|nd|rd|th)' });
        i += 'd(st|nd|rd|th)'.length;
        continue;
      }
      // Literal char
      const last = parts[parts.length - 1];
      if (last?.type === 'literal') {
        last.value += pattern[i];
      } else {
        parts.push({ type: 'literal', value: pattern[i]! });
      }
      i++;
    }
  }
  return parts;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return String(n) + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTruthy(val: string | undefined): boolean {
  if (!val) return false;
  const lower = val.toLowerCase();
  return lower !== 'false' && lower !== '0' && lower !== 'no' && lower !== '';
}
