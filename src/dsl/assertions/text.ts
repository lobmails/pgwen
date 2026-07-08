/**
 * assertions/text.ts — Text / named-binding assertion steps.
 *
 * Asserts against scope bindings (not element content directly).
 * If the name resolves to a locator binding, the element's text content is used.
 * Otherwise the scope value is compared directly.
 *
 *   <textRef> should[ not] be "<expression>"
 *   <textRef> should[ not] contain "<expression>"
 *   <textRef> should[ not] start with "<expression>"
 *   <textRef> should[ not] end with "<expression>"
 *   <textRef> should[ not] match regex "<expression>"
 *   <textRef> should[ not] match xpath "<expression>"      (element match via XPath on value)
 *   <textRef> should[ not] match json path "<expression>"
 *   <textRef> should[ not] match template "<template>"
 *   there should be no accumulated errors
 *   I assert accumulated errors
 */

import type { DslRegistry } from '../registry';
import { resolveLocator, assertText, DslAssertionError } from '../locatorUtils';
import { TemplateMatcher } from '../../engine/TemplateMatcher';
import { matchesFormat, type FormatKind } from '../formatting/formatMatch';

export function registerTextAssertions(registry: DslRegistry): void {
  const reg = registry.withCategory('assertion');

  // ─── JSON at-path assertions ─────────────────────────────────────────────
  //   <jsonRef> at json path "<path>" should[ not] be <blank|empty>
  //   <jsonRef> at json path "<path>" should[ not] (be|contain|...) "<expr>"
  //
  // Must register BEFORE the generic `<ref> should be "<X>"` pattern below
  // because the generic (.+) capture would greedily eat the whole left-hand
  // side including `at json path "..."` and try to resolve it as one binding.

  reg.register(
    /^(.+) at json path "([^"]+)" should (not )?be (blank|empty)$/i,
    async ([refName, jsonPath, notStr, keyword], scope) => {
      const negate = !!notStr;
      const value = extractJsonValueAtPath(refName!.trim(), jsonPath!, scope);
      const isBlank = keyword!.toLowerCase() === 'blank'
        ? value.trim() === ''
        : value === '';
      if (negate ? isBlank : !isBlank) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" at json path "${jsonPath}" to ${notWord}be ${keyword} (actual: "${value}")`
        );
      }
    }
  );

  reg.register(
    /^(.+) at json path "([^"]+)" should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([refName, jsonPath, notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = extractJsonValueAtPath(refName!.trim(), jsonPath!, scope);
      const opts = {
        trim:       scope.get('pgwen._trim')       === 'true',
        ignoreCase: scope.get('pgwen._ignoreCase') === 'true',
      };
      assertText(actual, normaliseOp(op!), expected!, negate, `"${refName}" at json path "${jsonPath}"`, opts);
    }
  );

  //   <jsonRef> at json path "<path>" should[ not] match (datetime|number) format "<p>"
  reg.register(
    /^(.+) at json path "([^"]+)" should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([refName, jsonPath, notStr, kindStr, pattern], scope) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const actual = extractJsonValueAtPath(refName!.trim(), jsonPath!, scope);
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" at json path "${jsonPath}" to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );

  // ─── XML at-xpath assertions ─────────────────────────────────────────────
  //   <xmlRef> at xpath "<path>" should[ not] be <blank|empty>
  //   <xmlRef> at xpath "<path>" should[ not] (be|contain|...) "<expr>"

  reg.register(
    /^(.+) at xpath "([^"]+)" should (not )?be (blank|empty)$/i,
    async ([refName, xpathExpr, notStr, keyword], scope) => {
      const negate = !!notStr;
      const value = extractXmlValueAtPath(refName!.trim(), xpathExpr!, scope);
      const isBlank = keyword!.toLowerCase() === 'blank'
        ? value.trim() === ''
        : value === '';
      if (negate ? isBlank : !isBlank) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" at xpath "${xpathExpr}" to ${notWord}be ${keyword} (actual: "${value}")`
        );
      }
    }
  );

  reg.register(
    /^(.+) at xpath "([^"]+)" should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([refName, xpathExpr, notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = extractXmlValueAtPath(refName!.trim(), xpathExpr!, scope);
      const opts = {
        trim:       scope.get('pgwen._trim')       === 'true',
        ignoreCase: scope.get('pgwen._ignoreCase') === 'true',
      };
      assertText(actual, normaliseOp(op!), expected!, negate, `"${refName}" at xpath "${xpathExpr}"`, opts);
    }
  );

  //   <xmlRef> at xpath "<path>" should[ not] match (datetime|number) format "<p>"
  reg.register(
    /^(.+) at xpath "([^"]+)" should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([refName, xpathExpr, notStr, kindStr, pattern], scope) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const actual = extractXmlValueAtPath(refName!.trim(), xpathExpr!, scope);
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" at xpath "${xpathExpr}" to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );

  // ─── Core text comparison (5 operators) — quoted-literal form ─────────────

  reg.register(
    /^(.+) should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([refName, notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = await resolveRef(refName!.trim(), scope);
      const opts = {
        trim:       scope.get('pgwen._trim')       === 'true',
        ignoreCase: scope.get('pgwen._ignoreCase') === 'true',
      };
      assertText(actual, normaliseOp(op!), expected!, negate, `"${refName}"`, opts);
    }
  );

  // ─── Format pattern matching (the reference DSL) ─────────────────────────────────
  // <ref> should[ not] match (datetime|number) format "<pattern>"
  // Parity with upstream the reference DSL. Layered on parseDate / parseNumber via
  // src/dsl/formatting/formatMatch.ts — a value matches if it can be parsed
  // under the supplied Java-style pattern.
  //
  // JSON-path + XPath variants live further down (alongside the existing
  // json-path / xpath assertion blocks they share a regex prefix with).
  reg.register(
    /^(.+) should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([refName, notStr, kindStr, pattern], scope) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const actual = await resolveRef(refName!.trim(), scope);
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );


  // ─── XPath matching on value ───────────────────────────────────────────────

  // <textRef> should[ not] match xpath "<expression>"
  // Evaluates the XPath expression against the ref value treated as an XML document.
  reg.register(
    /^(.+) should (not )?match xpath "([^"]*)"$/i,
    async ([refName, notStr, xpathExpr], scope) => {
      const negate = !!notStr;
      const actual = await resolveRef(refName!.trim(), scope);
      let matches: boolean;
      try {
        const { DOMParser } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom');
        const xpathLib = require('xpath') as typeof import('xpath');
        const doc = new DOMParser().parseFromString(actual, 'text/xml');
        const result = xpathLib.select(xpathExpr!, doc as unknown as Node);
        // A non-empty result array or truthy scalar means XPath matched
        if (Array.isArray(result)) {
          matches = result.length > 0;
        } else {
          matches = result !== null && result !== false && result !== '' && result !== 0;
        }
      } catch {
        matches = false;
      }
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" to ${notWord}match xpath "${xpathExpr}" (actual: "${actual}")`
        );
      }
    }
  );

  // ─── JSON path matching on value ──────────────────────────────────────────

  // <textRef> should[ not] match json path "<expression>"
  reg.register(
    /^(.+) should (not )?match json path "([^"]*)"$/i,
    async ([refName, notStr, jsonPath], scope) => {
      const negate = !!notStr;
      const actual = await resolveRef(refName!.trim(), scope);
      let matches: boolean;
      try {
        const obj = JSON.parse(actual) as unknown;
        const result = evaluateJsonPath(obj, jsonPath!);
        matches = result !== undefined && result !== null;
      } catch {
        matches = false;
      }
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${refName}" to ${notWord}match json path "${jsonPath}"`
        );
      }
    }
  );

  // ─── Template matching ────────────────────────────────────────────────────

  // <textRef> should[ not] match template
  // Template content comes from the docstring body (pgwen._step_docstring).
  // This is the primary real-form for multi-line API response/body templates.
  // Named <placeholder> tokens in the template are bound into scope on match.
  reg.register(
    /^(.+) should (not )?match template$/i,
    async ([refName, notStr], scope) => {
      const negate = !!notStr;
      const template = scope.get('pgwen._step_docstring') ?? '';
      const actual = await resolveRef(refName!.trim(), scope);
      const { matched, bindings, diffMessage } = TemplateMatcher.match(template, actual);
      if (negate ? matched : !matched) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          diffMessage ??
          `Expected "${refName}" to ${notWord}match template (actual: "${actual}")`
        );
      }
      if (!negate && matched) {
        for (const [key, value] of Object.entries(bindings)) {
          scope.set(key, value);
        }
      }
    }
  );

  // <textRef> should[ not] match template "<template>"
  // Named placeholders in the template are bound into scope on match.
  reg.register(
    /^(.+) should (not )?match template "([^"]*)"$/i,
    async ([refName, notStr, template], scope) => {
      const negate = !!notStr;
      const actual = await resolveRef(refName!.trim(), scope);
      const { matched, bindings, diffMessage } = TemplateMatcher.match(template!, actual);
      if (negate ? matched : !matched) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          diffMessage ??
          `Expected "${refName}" to ${notWord}match template "${template}" (actual: "${actual}")`
        );
      }
      // Bind captured placeholders into scope
      if (!negate && matched) {
        for (const [key, value] of Object.entries(bindings)) {
          scope.set(key, value);
        }
      }
    }
  );

  // <textRef> should[ not] match template file "<filepath>"
  reg.register(
    /^(.+) should (not )?match template file "([^"]*)"$/i,
    async ([refName, notStr, filepath], scope) => {
      const negate = !!notStr;
      const actual = await resolveRef(refName!.trim(), scope);
      const { matched, bindings, diffMessage } = TemplateMatcher.matchFile(filepath!, actual);
      if (negate ? matched : !matched) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          diffMessage ??
          `Expected "${refName}" to ${notWord}match template file "${filepath}"`
        );
      }
      if (!negate && matched) {
        for (const [key, value] of Object.entries(bindings)) {
          scope.set(key, value);
        }
      }
    }
  );

  // ─── Similarity assertions ───────────────────────────────────────────────
  //
  //   <ref> should[ not] be [<comparator>] <N>% similar to "<text>"
  //   <ref> should[ not] be [<comparator>] <N>% similar to <textRef2>
  //
  // Comparator is optional: "less than" | "at most" | "more than" | "at least".
  // Omitted means "equals N% within 0.5% tolerance". Negation inverts.
  //
  // Registered BEFORE the numeric-comparison patterns below so the
  // `be less than 50% similar to ...` phrase doesn't get swallowed by
  // `should be less than <threshold>`. The numeric pattern is greedy and
  // would otherwise capture the full tail as the threshold and fail to
  // parseFloat the project value.

  reg.register(
    /^(.+) should (not )?be (less than |at most |more than |at least )?(\d+(?:\.\d+)?)% similar to "([^"]*)"$/i,
    async ([refName, notStr, comparator, percentStr, expected], scope) => {
      await runSimilarityAssert(refName!, notStr, comparator, percentStr!, expected!, scope);
    }
  );

  reg.register(
    /^(.+) should (not )?be (less than |at most |more than |at least )?(\d+(?:\.\d+)?)% similar to (?!")([^"]+)$/i,
    async ([refName, notStr, comparator, percentStr, expectedRef], scope) => {
      const expected = scope.get(expectedRef!.trim()) ?? expectedRef!.trim();
      await runSimilarityAssert(refName!, notStr, comparator, percentStr!, expected, scope);
    }
  );

  // ─── Numeric comparison assertions ───────────────────────────────────────

  // <name> should be less than <threshold>
  // <name> should be less than or equal to <threshold>
  // <name> should be greater than <threshold>
  // <name> should be greater than or equal to <threshold>
  // <name> should be between <min> and <max>
  // All forms support optional "not" negation.
  reg.register(
    /^(.+) should (not )?(be less than or equal to|be less than|be greater than or equal to|be greater than|be between) (.+?)(?:\s+and\s+(.+))?$/i,
    async ([refName, notStr, opRaw, operand1, operand2], scope) => {
      const negate = !!notStr;
      const op = opRaw!.toLowerCase().replace(/\s+/g, ' ');
      const actual = await resolveRef(refName!.trim(), scope);
      const actualNum = parseFloat(actual.replace(/,/g, ''));
      if (isNaN(actualNum)) {
        throw new DslAssertionError(
          `Expected "${refName}" to be numeric for comparison (actual: "${actual}")`
        );
      }

      const resolveOperand = async (raw: string): Promise<number> => {
        const fromScope = scope.get(raw.trim());
        const str = fromScope !== undefined ? fromScope : raw.trim();
        const n = parseFloat(str.replace(/,/g, ''));
        if (isNaN(n)) throw new DslAssertionError(`Expected operand "${raw}" to be numeric`);
        return n;
      };

      let passes: boolean;
      if (op === 'be between') {
        const min = await resolveOperand(operand1!);
        const max = await resolveOperand(operand2!);
        passes = actualNum >= min && actualNum <= max;
      } else {
        const threshold = await resolveOperand(operand1!);
        if (op === 'be less than') passes = actualNum < threshold;
        else if (op === 'be less than or equal to') passes = actualNum <= threshold;
        else if (op === 'be greater than') passes = actualNum > threshold;
        else passes = actualNum >= threshold; // be greater than or equal to
      }

      if (negate ? passes : !passes) {
        const notWord = negate ? ' not' : '';
        const rangeStr = operand2 ? ` and ${operand2}` : '';
        throw new DslAssertionError(
          `Expected "${refName}" to${notWord} ${op} "${operand1}${rangeStr}" (actual: "${actual}")`
        );
      }
    }
  );

  // ─── Existential assertions ──────────────────────────────────────────────

  // <name> should be absent
  // Passes when the named binding does NOT exist in scope (is undefined).
  // Preserves "should be absent" behaviour for scope variables and locators.
  reg.register(
    /^(.+) should be absent$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const val = scope.get(name);
      const locFn = scope.getLocator(name);
      if (val !== undefined || locFn !== undefined) {
        const display = val !== undefined ? `"${val}"` : '(locator)';
        throw new DslAssertionError(`Expected "${name}" to be absent but it is defined as ${display}`);
      }
    }
  );

  // <name> should be defined
  // Passes when the named binding exists in scope (scope value or locator binding).
  reg.register(
    /^(.+) should be defined$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const val = scope.get(name);
      const locFn = scope.getLocator(name);
      if (val === undefined && locFn === undefined) {
        throw new DslAssertionError(`Expected "${name}" to be defined but no binding exists in scope`);
      }
    }
  );

  // <name> should not be defined  (synonym for "should be absent")
  reg.register(
    /^(.+) should not be defined$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const val = scope.get(name);
      const locFn = scope.getLocator(name);
      if (val !== undefined || locFn !== undefined) {
        const display = val !== undefined ? `"${val}"` : '(locator)';
        throw new DslAssertionError(`Expected "${name}" to not be defined but it is defined as ${display}`);
      }
    }
  );

  // ─── Boolean assertions ──────────────────────────────────────────────────
  // Distinct from `should be "true"` (string equality) — these treat the value
  // as a boolean using the same truthy/falsy rules as evalCondition:
  //   falsy  → "false", "no", "0", "" (empty)
  //   truthy → everything else
  // Pattern must come BEFORE the generic /should be ".."/ regex above. The
  // existing equality regex requires QUOTES so "should be true" (no quotes)
  // falls through to here.

  // <name> should be true
  reg.register(
    /^(.+) should be true$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const actual = await resolveRef(name, scope);
      if (!isTruthyValue(actual)) {
        throw new DslAssertionError(`Expected "${name}" to be true (actual: "${actual}")`);
      }
    }
  );

  // <name> should not be true
  reg.register(
    /^(.+) should not be true$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const actual = await resolveRef(name, scope);
      if (isTruthyValue(actual)) {
        throw new DslAssertionError(`Expected "${name}" to not be true (actual: "${actual}")`);
      }
    }
  );

  // <name> should be false
  reg.register(
    /^(.+) should be false$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const actual = await resolveRef(name, scope);
      if (isTruthyValue(actual)) {
        throw new DslAssertionError(`Expected "${name}" to be false (actual: "${actual}")`);
      }
    }
  );

  // <name> should not be false
  reg.register(
    /^(.+) should not be false$/i,
    async ([refName], scope) => {
      const name = refName!.trim();
      const actual = await resolveRef(name, scope);
      if (!isTruthyValue(actual)) {
        throw new DslAssertionError(`Expected "${name}" to not be false (actual: "${actual}")`);
      }
    }
  );

  // ─── Blank / not-blank assertions ────────────────────────────────────────

  // <name> should be blank  (empty string or whitespace-only)
  reg.register(
    /^(.+) should be blank$/i,
    async ([refName], scope) => {
      const actual = await resolveRef(refName!.trim(), scope);
      if (actual.trim() !== '') {
        throw new DslAssertionError(
          `Expected "${refName}" to be blank (actual: "${actual}")`
        );
      }
    }
  );

  // <name> should not be blank
  reg.register(
    /^(.+) should not be blank$/i,
    async ([refName], scope) => {
      const actual = await resolveRef(refName!.trim(), scope);
      if (actual.trim() === '') {
        throw new DslAssertionError(
          `Expected "${refName}" to not be blank (actual: "${actual}")`
        );
      }
    }
  );

  // ─── Accumulated errors ───────────────────────────────────────────────────

  // there should be no accumulated errors
  reg.register(
    /^there should be no accumulated errors$/i,
    async (_, scope) => {
      const errors = scope.get('pgwen.accumulated.errors') ?? '';
      if (errors.trim()) {
        throw new DslAssertionError(`Accumulated errors:\n${errors}`);
      }
    }
  );

  // I assert accumulated errors
  reg.register(
    /^I assert accumulated errors$/i,
    async (_, scope) => {
      const errors = scope.get('pgwen.accumulated.errors') ?? '';
      if (errors.trim()) {
        throw new DslAssertionError(`Accumulated errors:\n${errors}`);
      }
    }
  );

  // I reset accumulated errors — clears all soft/sustained accumulated errors
  reg.register(
    /^I reset accumulated errors$/i,
    async (_, scope) => {
      // Trigger the side-effect lazy registered by Runner.ts which splices the error arrays.
      // Falls back to a no-op if running outside a Runner (e.g. unit tests).
      scope.get('pgwen._accumulated_errors_clear');
    }
  );

  // ─── Core text comparison — ref-vs-ref form (no quotes on the RHS) ───────
  //
  // `<textRef> should[ not] (be|contain|start with|end with|match regex) <expressionRef>`
  //
  // Resolves the RHS through scope (binding lookup); falls back to the literal
  // token if no binding exists.
  //
  // Registered LAST so every more-specific pattern above wins its match:
  //   - quoted-literal form (`should be "X"`)
  //   - keyword forms (`should be true|false|blank|empty|defined|absent`)
  //   - numeric comparators (`should be less than X`)
  //   - existential / cumulative (`there should be no accumulated errors`)
  //   - match xpath / json path / template
  // Plus a negative lookahead on common keyword tails to short-circuit
  // ambiguous inputs even if pattern ordering changes later.
  reg.register(
    /^(.+) should (not )?(be|contain|start with|end with|match regex) (?!(?:true|false|blank|empty|defined|absent|hidden|displayed|visible|enabled|disabled|checked|ticked|unchecked|unticked|less\s|greater\s|at\s+least\s|at\s+most\s|between\s|no\s+accumulated)\b)([^"]+)$/i,
    async ([refName, notStr, op, expressionRef], scope) => {
      const negate = !!notStr;
      const actual = await resolveRef(refName!.trim(), scope);
      const expectedRef = expressionRef!.trim();
      const expected = scope.get(expectedRef) ?? expectedRef;
      const opts = {
        trim:       scope.get('pgwen._trim')       === 'true',
        ignoreCase: scope.get('pgwen._ignoreCase') === 'true',
      };
      assertText(actual, normaliseOp(op!), expected, negate, `"${refName}"`, opts);
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a reference to its value.
 *
 * Resolution order:
 *  1. Playwright locator binding — returns element text/input value.
 *  2. Scope variable — returns bound string value.
 *  3. Quoted literal — single- or double-quoted string treated as inline value.
 *  4. Unbound reference → throws (Preserves "Unbound reference: X" error).
 *     This means typos like RECORD_IDD (not in scope) fail explicitly, both in
 *     dry-run and live execution, instead of silently passing.
 */
async function resolveRef(refName: string, scope: Parameters<typeof resolveLocator>[1]): Promise<string> {
  // 1. Locator binding (Playwright element)
  const locFn = scope.getLocator(refName);
  if (locFn) {
    const loc = await locFn() as { textContent(): Promise<string | null>; inputValue(): Promise<string> };
    try {
      const val = await loc.inputValue();
      return val;
    } catch {
      return (await loc.textContent()) ?? '';
    }
  }

  // 2. Scope variable — try sync `scope.get()` first; if it throws because
  //    the binding is registered as an async lazy (e.g. `is defined by js`),
  //    await `scope.resolveAsync()` instead.
  let val: string | undefined;
  try {
    val = scope.get(refName);
  } catch (e) {
    if (e instanceof Error && e.message.includes('async lazy resolver')) {
      const asyncScope = scope as unknown as { resolveAsync(name: string): Promise<string | undefined> };
      val = await asyncScope.resolveAsync(refName);
    } else {
      throw e;
    }
  }
  if (val !== undefined) return val;

  // 3. Quoted literal: 'value' or "value" — inline literal, not a variable reference
  const quotedMatch = /^(?:'([^']*)'|"([^"]*)")$/.exec(refName.trim());
  if (quotedMatch) return quotedMatch[1] ?? quotedMatch[2] ?? '';

  // 4. Unbound reference — variable not in scope and not a literal
  throw new Error(`Unbound reference: ${refName}`);
}

/**
 * Truthy/falsy classification used by `should be true` / `should be false`.
 * Matches the same rules as the evalCondition helper so boolean asserts and
 * if-guard conditions agree on what counts as true.
 *   falsy  → "false", "no", "0", "" (any case, after trim)
 *   truthy → everything else
 */
function isTruthyValue(val: string): boolean {
  const lower = val.toLowerCase().trim();
  return lower !== 'false' && lower !== 'no' && lower !== '0' && lower !== '';
}

function normaliseOp(op: string): import('../locatorUtils').CompareOp {
  const lower = op.toLowerCase();
  if (lower === 'be') return 'be';
  if (lower === 'contain') return 'contain';
  if (lower === 'start with') return 'start with';
  if (lower === 'end with') return 'end with';
  if (lower === 'match regex') return 'match regex';
  return 'be';
}

/**
 * Levenshtein-distance-based similarity ratio in the range [0, 100].
 * Returns 100 when both strings are equal; 0 when they share nothing.
 * Used by the `% similar to` assertion and capture families.
 */
export function similarityPercent(a: string, b: string): number {
  if (a === b) return 100;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshtein(a, b);
  return ((maxLen - distance) / maxLen) * 100;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // single-row DP for O(n) memory
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,        // deletion
        curr[j - 1]! + 1,    // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

async function runSimilarityAssert(
  refName: string,
  notStr: string | undefined,
  comparator: string | undefined,
  percentStr: string,
  expected: string,
  scope: Parameters<typeof resolveLocator>[1],
): Promise<void> {
  const negate = !!notStr;
  const actual = await resolveRef(refName.trim(), scope);
  const threshold = parseFloat(percentStr);
  const score = similarityPercent(actual, expected);
  const cmp = (comparator ?? '').trim().toLowerCase();
  let satisfied: boolean;
  switch (cmp) {
    case 'less than':  satisfied = score <  threshold; break;
    case 'at most':    satisfied = score <= threshold; break;
    case 'more than':  satisfied = score >  threshold; break;
    case 'at least':   satisfied = score >= threshold; break;
    case '':           satisfied = Math.abs(score - threshold) < 0.5; break;
    default:           satisfied = false;
  }
  if (negate ? satisfied : !satisfied) {
    const notWord = negate ? 'not ' : '';
    const cmpWord = cmp ? `${cmp} ` : '';
    throw new DslAssertionError(
      `Expected "${refName}" to ${notWord}be ${cmpWord}${threshold}% similar to "${expected}" (actual similarity: ${score.toFixed(2)}%)`
    );
  }
}

/** Read a JSON ref from scope and evaluate a dot/bracket JSON path. */
function extractJsonValueAtPath(
  refName: string,
  jsonPath: string,
  scope: Parameters<typeof resolveLocator>[1],
): string {
  const raw = scope.get(refName);
  if (raw == null) return '';
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return '';
  }
  const result = evaluateJsonPath(obj, jsonPath);
  return result == null ? '' : String(result);
}

/** Read an XML ref from scope and evaluate an XPath expression. */
function extractXmlValueAtPath(
  refName: string,
  xpathExpr: string,
  scope: Parameters<typeof resolveLocator>[1],
): string {
  const xml = scope.get(refName);
  if (xml == null) return '';
  try {
    const { DOMParser } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom');
    const xpathLib = require('xpath') as typeof import('xpath');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const result = xpathLib.select1(xpathExpr, doc as unknown as Node);
    if (result == null) return '';
    if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
      return String(result);
    }
    return (result as { textContent?: string | null }).textContent?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Evaluate a simple dot-notation JSON path. */
function evaluateJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
