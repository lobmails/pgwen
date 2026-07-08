/**
 * StringInterpolator.ts — Resolves ${...} expressions in pgwen step text.
 *
 * Resolution order (Preserves exactly):
 *   1. Named binding in current scope
 *   2. setting from loaded config (via settingsProvider)
 *   3. Environment variable: ${env.VAR_NAME}
 *   4. Implicit value (via implicitProvider)
 *
 * Supported syntax:
 *   ${name}                       plain binding lookup
 *   ${env.VAR_NAME}               environment variable
 *   ${name.toUpperCase()}         JS string method applied to resolved value
 *   ${name ?: 'default'}          elvis — use 'default' if name undefined
 *   ${name ?: blank}              elvis — empty string if name undefined
 *   ${name ?: false}              elvis — literal "false" if name undefined
 *   ${name ?: '${other}'}         elvis — chain to another interpolation
 *   ${pgwen.now}                   current date/time (handled by implicitProvider)
 *   ${pgwen.now:yyyy-MM-dd}        formatted date (handled by implicitProvider)
 */

import { Scope } from './Scope';
import { formatNow } from './ImplicitValues';
import { toPosixPath } from '../util/paths';

/**
 * External providers injected at construction time.
 * Both are optional — omit for unit testing the interpolator in isolation.
 */
export interface InterpolationProviders {
  /** Look up a setting (e.g. pgwen.web.wait.seconds) */
  settings?: (key: string) => string | undefined;
  /** Look up an implicit pgwen.* value */
  implicit?: (key: string) => string | undefined;
  /**
   * Returns true when a settings key was declared with the `:masked` suffix in
   * the config file (e.g. `newRelic.apiKey:masked = "secret"`).
   * When true, `interpolateForDisplay()` substitutes `*****` for the value so
   * the real secret never appears in console or HTML report output.
   */
  isMaskedSetting?: (key: string) => boolean;
}

// NOTE: We do NOT use a simple regex like /\$\{([^}]+)\}/ because the elvis
// operator allows nested ${...} inside the default value:
//   ${missing ?: '${other}'}
// The inner `}` would terminate the outer match prematurely.
// Instead, we use findPlaceholders() which tracks brace depth and quote state.

// Detects JS string method calls at the end: .methodName() or .property
// Examples: name.toUpperCase(), value.trim(), items.length
const JS_METHOD_RE = /^(.+?)(\.[a-zA-Z_$][a-zA-Z0-9_$]*(?:\([^)]*\))?)$/;

// Elvis operator: " ?: " (spaces required, matching exact syntax)
const ELVIS_SEPARATOR = ' ?: ';

export class StringInterpolator {
  constructor(
    private readonly scope: Scope,
    private readonly providers: InterpolationProviders = {}
  ) {}

  /**
   * Interpolate all ${...} expressions in `text`.
   * Throws if a placeholder cannot be resolved and no elvis default is given.
   *
   * Synchronous. If your scope contains async lazy resolvers, use interpolateAsync().
   */
  interpolate(text: string): string {
    const parts = findPlaceholders(text);
    if (parts.length === 0) return text;

    // Rebuild the string by replacing each placeholder span with its resolved value.
    let result = '';
    let cursor = 0;
    for (const { start, end, content } of parts) {
      result += text.slice(cursor, start);
      result += this.resolvePlaceholder(content);
      cursor = end + 1; // end points at the closing '}'
    }
    result += text.slice(cursor);
    return result;
  }

  /**
   * Async version of interpolate(). Awaits lazy resolvers from Scope.
   */
  async interpolateAsync(text: string): Promise<string> {
    const parts = findPlaceholders(text);
    if (parts.length === 0) return text;

    // Resolve all placeholders in parallel
    const resolved = await Promise.all(
      parts.map(async ({ content }) => ({
        content,
        value: await this.resolvePlaceholderAsync(content),
      }))
    );

    // Rebuild string
    let result = '';
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
      const { start, end } = parts[i]!;
      result += text.slice(cursor, start);
      result += resolved[i]!.value;
      cursor = end + 1;
    }
    result += text.slice(cursor);
    return result;
  }

  /**
   * Interpolate `text` for display purposes (console + HTML report step text).
   * Identical to `interpolate()` except that values resolved from masked settings
   * (`isMaskedSetting` returns true) are replaced with `*****`.
   *
   * This allows DSL handlers to receive the real value via `interpolate()` while
   * reports show `*****` inline in the step text — matching behaviour.
   */
  interpolateForDisplay(text: string): string {
    const parts = findPlaceholders(text);
    if (parts.length === 0) return text;

    let result = '';
    let cursor = 0;
    for (const { start, end, content } of parts) {
      result += text.slice(cursor, start);
      result += this.resolvePlaceholder(content, true);
      cursor = end + 1;
    }
    result += text.slice(cursor);
    return result;
  }

  /**
   * Async version of `interpolateForDisplay()` — awaits lazy resolvers from
   * Scope while still masking values from `:masked` settings as `*****`.
   *
   * Use whenever the caller has async lazy bindings in scope (e.g. step text
   * interpolation in Compositor, where `is defined by js` bindings register
   * async resolvers). Sync `interpolateForDisplay()` throws on those.
   */
  async interpolateForDisplayAsync(text: string): Promise<string> {
    const parts = findPlaceholders(text);
    if (parts.length === 0) return text;

    const resolved = await Promise.all(
      parts.map(async ({ content }) => ({
        content,
        value: await this.resolvePlaceholderAsync(content, true),
      }))
    );

    let result = '';
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
      const { start, end } = parts[i]!;
      result += text.slice(cursor, start);
      result += resolved[i]!.value;
      cursor = end + 1;
    }
    result += text.slice(cursor);
    return result;
  }

  // ─── Resolution logic ─────────────────────────────────────────────────────

  private resolvePlaceholder(placeholder: string, forDisplay = false): string {
    const { key, defaultExpr } = parseElvis(placeholder);

    const value = this.lookupKey(key, forDisplay);
    if (value !== undefined) return value;

    if (defaultExpr !== undefined) {
      return this.resolveDefault(defaultExpr);
    }

    throw new Error(
      `Undefined binding: "\${${placeholder}}". ` +
      `Add it to scope, a config file, or use the elvis operator for a default.`
    );
  }

  private async resolvePlaceholderAsync(placeholder: string, forDisplay = false): Promise<string> {
    const { key, defaultExpr } = parseElvis(placeholder);

    // :JSONArray suffix — async path
    if (key.endsWith(':JSONArray')) {
      const baseKey = key.slice(0, -':JSONArray'.length);
      const raw = (await this.scope.resolveAsync(baseKey)) ?? this.lookupKeyNonScope(baseKey, forDisplay);
      if (raw !== undefined) {
        const items = raw.trim()
          ? raw.split(/\r?\n|,/).map(s => s.trim()).filter(s => s.length > 0)
          : [];
        return JSON.stringify(items);
      }
      return '[]';
    }

    // Try async scope first
    const scopeValue = await this.scope.resolveAsync(key);
    if (scopeValue !== undefined) return scopeValue;

    // Fall back to sync lookup chain (settings / implicit / env / system-prop)
    const value = this.lookupKeyNonScope(key, forDisplay);
    if (value !== undefined) return value;

    if (defaultExpr !== undefined) {
      return this.resolveDefault(defaultExpr);
    }

    throw new Error(
      `Undefined binding: "\${${placeholder}}". ` +
      `Add it to scope, a config file, or use the elvis operator for a default.`
    );
  }

  /**
   * Full lookup chain (sync).
   * Returns undefined if nothing resolves the key.
   * When forDisplay is true, masked setting values are returned as '*****'.
   */
  private lookupKey(key: string, forDisplay = false): string | undefined {
    // 0. :JSONArray suffix — resolve base key, format as JSON array
    //    e.g. ${pgwen.accumulated.errors:JSONArray} → ["err1","err2"]
    if (key.endsWith(':JSONArray')) {
      const baseKey = key.slice(0, -':JSONArray'.length);
      const raw = this.lookupKey(baseKey, forDisplay);
      if (raw !== undefined) {
        const items = raw.trim()
          ? raw.split(/\r?\n|,/).map(s => s.trim()).filter(s => s.length > 0)
          : [];
        return JSON.stringify(items);
      }
      return '[]';
    }

    // 1. Named binding in scope
    const scopeValue = this.tryScope(key);
    if (scopeValue !== undefined) return scopeValue;

    return this.lookupKeyNonScope(key, forDisplay);
  }

  /**
   * Lookup chain excluding scope (used in async path after scope was already checked).
   * When forDisplay is true, masked setting values are returned as '*****'.
   */
  private lookupKeyNonScope(key: string, forDisplay = false): string | undefined {
    // 2. Environment variable: env.VAR_NAME
    if (key.startsWith('env.')) {
      const varName = key.slice(4);
      return process.env[varName];
    }

    // 2b. System property aliases: user.home, user.name, user.dir, java.io.tmpdir
    //     JVM resolves these via System.getProperty(); pgwen maps to Node.js equivalents.
    if (key === 'user.home') {
      return toPosixPath(process.env['HOME'] ?? process.env['USERPROFILE'] ?? require('os').homedir());
    }
    if (key === 'user.name') {
      return process.env['USER'] ?? process.env['USERNAME'] ?? '';
    }
    if (key === 'user.dir') {
      return toPosixPath(process.cwd());
    }
    if (key === 'java.io.tmpdir') {
      return toPosixPath(require('os').tmpdir());
    }

    // 3. settings
    const settingValue = this.providers.settings?.(key);
    if (settingValue !== undefined) {
      // Masked setting: show '*****' in display context, real value in execution context
      if (forDisplay && this.providers.isMaskedSetting?.(key)) return '*****';
      return settingValue;
    }

    // 4. Implicit values (pgwen.* etc.)
    const implicitValue = this.providers.implicit?.(key);
    if (implicitValue !== undefined) return implicitValue;

    // 5. Dynamic pgwen.now:<format> — any format pattern not pre-registered in scope
    if (key.startsWith('pgwen.now:')) {
      const fmt = key.slice('pgwen.now:'.length);
      return formatNow(fmt);
    }

    return undefined;
  }

  /**
   * Try to resolve `key` from scope, supporting JS method calls and inline arrow functions.
   * e.g. "name.toUpperCase()" → resolve "name", then apply .toUpperCase()
   * e.g. "name => name.toUpperCase()" → resolve "name" from scope, call arrow fn
   * e.g. "(name, surname) => name + ' ' + surname" → resolve each arg from scope
   */
  private tryScope(key: string): string | undefined {
    // Direct lookup first
    const direct = this.scope.get(key);
    if (direct !== undefined) return direct;

    // Inline arrow function: contains "=>" outside of quotes
    if (key.includes('=>')) {
      return this.tryArrowFunction(key);
    }

    // Check for JS method/property access
    const jsMatch = JS_METHOD_RE.exec(key);
    if (jsMatch) {
      const baseName = jsMatch[1]!;
      const accessor = jsMatch[2]!;
      const base = this.scope.get(baseName);
      if (base !== undefined) {
        return applyJsAccessor(base, accessor);
      }
    }

    return undefined;
  }

  /**
   * Evaluate an inline arrow function expression within a ${...} placeholder.
   *
   * Supported forms (standard behaviour):
   *   name => name.toUpperCase()                   — single implicit arg (bound from scope)
   *   (name, surname) => name + ' ' + surname      — multi implicit arg
   *   (name = first name) => ...                   — explicit binding (arg = scope-name)
   *   () => new Date().toISOString()               — zero-arg
   *   name => { ... return expr; }                 — block body
   */
  private tryArrowFunction(expr: string): string | undefined {
    const trimmed = expr.trim();
    try {
      // Parse param list and body from "params => body"
      const arrowIdx = findArrowIndex(trimmed);
      if (arrowIdx === -1) return undefined;

      const paramsPart = trimmed.slice(0, arrowIdx).trim();
      const bodyPart   = trimmed.slice(arrowIdx + 2).trim();

      // Resolve argument values from scope
      const args = parseArrowParams(paramsPart);
      const argValues: string[] = args.map(({ jsName, scopeName }) => {
        const val = this.scope.get(scopeName ?? jsName);
        return val ?? '';
      });

      // Build a callable function from the body
      const paramNames = args.map((a) => a.jsName).join(', ');
      // Block body vs expression body
      const fnBody = bodyPart.startsWith('{')
        ? bodyPart.slice(1, bodyPart.lastIndexOf('}')).trim()
        : `return (${bodyPart})`;

      const fn = new Function(paramNames, fnBody) as (...a: string[]) => unknown;
      const result = fn(...argValues);
      return result == null ? '' : String(result);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the right-hand side of an elvis expression.
   * Handles: 'literal', blank, false, and nested ${...} expressions.
   */
  private resolveDefault(defaultExpr: string): string {
    if (defaultExpr === 'blank') return '';
    if (defaultExpr === 'false') return 'false';

    // Quoted string literal: 'value' or "value"
    if (
      (defaultExpr.startsWith("'") && defaultExpr.endsWith("'")) ||
      (defaultExpr.startsWith('"') && defaultExpr.endsWith('"'))
    ) {
      const inner = defaultExpr.slice(1, -1);
      // The inner string may itself contain ${...} — interpolate recursively
      return this.interpolate(inner);
    }

    // Unquoted — treat as a bare string (fallback behaviour)
    return defaultExpr;
  }

}


// ─── Module-level helpers ────────────────────────────────────────────────────

interface PlaceholderSpan {
  start: number;   // index of '$'
  end: number;     // index of the matching closing '}'
  content: string; // the text between ${ and }
}

/**
 * Locate every ${...} expression in `text`, correctly handling:
 *   - nested ${}: ${outer ?: '${inner}'} — inner } does not close the outer
 *   - quoted }:   ${name ?: 'a}b'}      — } inside quotes is not a closer
 *
 * Rules for depth tracking inside a placeholder:
 *   - Entering '${'  → depth++  (nested interpolation)
 *   - Encountering '}' (outside quotes) → depth--
 *   - Single/double quotes toggle their quote mode; chars inside are not parsed
 *
 * Returns spans sorted left-to-right. end is the index of the closing '}'.
 */
function findPlaceholders(text: string): PlaceholderSpan[] {
  const spans: PlaceholderSpan[] = [];
  let i = 0;

  while (i < text.length - 1) {
    if (text[i] !== '$' || text[i + 1] !== '{') {
      i++;
      continue;
    }

    const start = i;
    i += 2; // skip past '${'

    let depth = 1;
    let inSingle = false;
    let inDouble = false;

    while (i < text.length && depth > 0) {
      const ch = text[i]!;

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (!inSingle && !inDouble) {
        if (ch === '$' && i + 1 < text.length && text[i + 1] === '{') {
          depth++;
          i++; // skip the '{' that belongs to the nested '${', avoid double-counting
        } else if (ch === '{') {
          depth++; // bare brace (e.g. block body in arrow fn) also increases depth
        } else if (ch === '}') {
          depth--;
        }
      }

      i++;
    }

    // After the loop: i is one past the closing '}', so the '}' is at i-1
    if (depth === 0) {
      const end = i - 1;
      const content = text.slice(start + 2, end);
      spans.push({ start, end, content });
    }
    // If depth !== 0: unterminated placeholder — leave as-is (i already advanced)
  }

  return spans;
}

interface ElvisParts {
  key: string;
  defaultExpr: string | undefined;
}

/**
 * Split a placeholder expression on the elvis operator " ?: ".
 * If no elvis operator is present, defaultExpr is undefined.
 */
function parseElvis(placeholder: string): ElvisParts {
  const idx = placeholder.indexOf(ELVIS_SEPARATOR);
  if (idx === -1) {
    return { key: placeholder.trim(), defaultExpr: undefined };
  }
  return {
    key: placeholder.slice(0, idx).trim(),
    defaultExpr: placeholder.slice(idx + ELVIS_SEPARATOR.length).trim(),
  };
}

/**
 * Apply a JS property access or method call string to a resolved string value.
 * Only string methods are supported — this is intentionally limited.
 *
 * Supported: .toUpperCase(), .toLowerCase(), .trim(), .length, .trimStart(),
 *            .trimEnd(), .reverse() (via split/reverse/join)
 */
function applyJsAccessor(base: string, accessor: string): string {
  // Strip leading dot
  const expr = accessor.startsWith('.') ? accessor.slice(1) : accessor;

  // Property access (no parens)
  if (expr === 'length') return String(base.length);

  // Method calls
  const methodMatch = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\(([^)]*)\)$/.exec(expr);
  if (methodMatch) {
    const method = methodMatch[1]!;
    const arg = methodMatch[2]!.trim();

    switch (method) {
      case 'toUpperCase':   return base.toUpperCase();
      case 'toLowerCase':   return base.toLowerCase();
      case 'trim':          return base.trim();
      case 'trimStart':
      case 'trimLeft':      return base.trimStart();
      case 'trimEnd':
      case 'trimRight':     return base.trimEnd();
      case 'reverse':       return base.split('').reverse().join('');
      case 'includes':      return String(base.includes(stripQuotes(arg)));
      case 'startsWith':    return String(base.startsWith(stripQuotes(arg)));
      case 'endsWith':      return String(base.endsWith(stripQuotes(arg)));
      case 'replace': {
        const [from, to] = splitTwoArgs(arg);
        return base.replace(stripQuotes(from ?? ''), stripQuotes(to ?? ''));
      }
      case 'substring':
      case 'slice': {
        const [start, end] = splitTwoArgs(arg);
        return end !== undefined
          ? base.slice(Number(start), Number(end))
          : base.slice(Number(start));
      }
      default:
        throw new Error(
          `Unsupported JS method "${method}" in interpolation accessor "${accessor}". ` +
          `Supported: toUpperCase, toLowerCase, trim, trimStart, trimEnd, reverse, ` +
          `includes, startsWith, endsWith, replace, slice, substring, length.`
        );
    }
  }

  throw new Error(
    `Cannot apply accessor "${accessor}" to binding value. ` +
    `Only string methods and .length are supported.`
  );
}

// ─── Arrow function helpers ───────────────────────────────────────────────────

interface ArrowParam {
  jsName: string;     // JS-safe argument name used in the function body
  scopeName?: string; // Scope key to resolve (when explicit: "arg = scope name")
}

/**
 * Find the index of '=>' that is NOT inside parentheses or quotes.
 * Returns -1 if not found.
 */
function findArrowIndex(expr: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < expr.length - 1; i++) {
    const ch = expr[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && ch === '=' && expr[i + 1] === '>') return i;
  }
  return -1;
}

/**
 * Parse the parameter list portion of an arrow function into ArrowParam entries.
 * Handles: `()`, `name`, `(name)`, `(name, surname)`, `(name = first name)`,
 *           `(name = first name, surname = last name)`.
 */
function parseArrowParams(paramsPart: string): ArrowParam[] {
  // Strip outer parens if present
  let raw = paramsPart.trim();
  if (raw.startsWith('(') && raw.endsWith(')')) {
    raw = raw.slice(1, -1).trim();
  }
  if (raw === '') return []; // zero-arg

  return raw.split(',').map((chunk, idx) => {
    const part = chunk.trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      // Explicit: "jsArg = scope name" — jsArg is the user's chosen JS identifier
      const jsName    = part.slice(0, eqIdx).trim();
      const scopeName = part.slice(eqIdx + 1).trim();
      return { jsName, scopeName };
    }
    // Implicit: JS arg name == scope name (no spaces allowed in JS identifiers)
    return { jsName: part };
  });
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function splitTwoArgs(args: string): [string, string | undefined] {
  const idx = args.indexOf(',');
  if (idx === -1) return [args.trim(), undefined];
  return [args.slice(0, idx).trim(), args.slice(idx + 1).trim()];
}
