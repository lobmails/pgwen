/**
 * assertions/elements.ts — Element state and value assertion steps.
 *
 * Implements all element assertion patterns:
 *   <element> should[ not] be displayed / hidden / visible
 *   <element> should[ not] be enabled / disabled
 *   <element> should[ not] be checked / unchecked / ticked / unticked
 *   <element> should[ not] be empty
 *   <element> should[ not] exist
 *   <element> should[ not] be clickable
 *   <element> should[ not] be "<value>"          — text content
 *   <element> should[ not] contain "<value>"
 *   <element> should[ not] start with "<value>"
 *   <element> should[ not] end with "<value>"
 *   <element> should[ not] match regex "<pattern>"
 *   <element> should have value "<value>"        — input value attribute
 *   <n> <element>[s] should be displayed         — count assertion
 */

import type { DslRegistry } from '../registry';
import { resolveLocator, assertText, DslAssertionError, type CompareOp } from '../locatorUtils';

export function registerElementAssertions(registry: DslRegistry): void {
  const reg = registry.withCategory('assertion');

  // ─── State assertions ──────────────────────────────────────────────────────

  // <element> should[ not] be displayed / visible
  // Uses waitFor() to wait up to defaultTimeout (=pgwen.web.wait.seconds) — matches smart-wait.
  reg.register(
    /^(.+) should (not )?be (?:displayed|visible)$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      try {
        await loc.waitFor({ state: negate ? 'hidden' : 'visible' });
        // waitFor resolved — assertion passes
      } catch {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be displayed`);
      }
    }
  );

  // <element> should[ not] be hidden
  reg.register(
    /^(.+) should (not )?be hidden$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      try {
        await loc.waitFor({ state: negate ? 'visible' : 'hidden' });
      } catch {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be hidden`);
      }
    }
  );

  // <element> should[ not] be enabled
  reg.register(
    /^(.+) should (not )?be enabled$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      const enabled = await loc.isEnabled();
      if (negate ? enabled : !enabled) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be enabled`);
      }
    }
  );

  // <element> should[ not] be disabled
  reg.register(
    /^(.+) should (not )?be disabled$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      const disabled = await loc.isDisabled();
      if (negate ? disabled : !disabled) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be disabled`);
      }
    }
  );

  // <element> should[ not] be checked / ticked
  reg.register(
    /^(.+) should (not )?be (?:checked|ticked)$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      const checked = await loc.isChecked();
      if (negate ? checked : !checked) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be checked`);
      }
    }
  );

  // <element> should[ not] be unchecked / unticked
  reg.register(
    /^(.+) should (not )?be (?:unchecked|unticked)$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      const checked = await loc.isChecked();
      const unchecked = !checked;
      if (negate ? unchecked : !unchecked) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be unchecked`);
      }
    }
  );

  // <element> should[ not] be clickable  (visible + enabled)
  reg.register(
    /^(.+) should (not )?be clickable$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      const [vis, en] = await Promise.all([loc.isVisible(), loc.isEnabled()]);
      const clickable = vis && en;
      if (negate ? clickable : !clickable) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}be clickable`);
      }
    }
  );

  // ─── Existence ──────────────────────────────────────────────────────────────

  // <element> should[ not] exist
  // Uses waitFor() to wait up to defaultTimeout — matches smart-wait for element presence.
  reg.register(
    /^(.+) should (not )?exist$/i,
    async ([elementName, notStr], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      try {
        await loc.waitFor({ state: negate ? 'detached' : 'attached' });
      } catch {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${elementName}" to ${notWord}exist`);
      }
    }
  );

  // ─── Empty ─────────────────────────────────────────────────────────────────

  // <name> should[ not] be empty
  //   Dual-mode: when <name> resolves to a scope value, the value's string is
  //   checked. When no scope value exists but a locator binding does, the
  //   element's inputValue / textContent is checked. Projects commonly use the
  //   scope-value form for derived bindings (e.g. `pdf.line should not be empty`).
  reg.register(
    /^(.+) should (not )?be empty$/i,
    async ([refName, notStr], scope) => {
      const negate = !!notStr;
      const name = refName!.trim();
      const scopeVal = scope.get(name);
      let text: string;
      if (scopeVal !== undefined) {
        text = scopeVal;
      } else {
        const loc = await resolveLocator(name, scope);
        try {
          text = await loc.inputValue();
        } catch {
          text = (await loc.textContent()) ?? '';
        }
      }
      const empty = text.trim() === '';
      if (negate ? empty : !empty) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected "${name}" to ${notWord}be empty (got "${text}")`);
      }
    }
  );

  // ─── Text content assertions ──────────────────────────────────────────────

  // <element> should[ not] be "<value>"
  // <element> should[ not] contain "<value>"
  // <element> should[ not] start with "<value>"
  // <element> should[ not] end with "<value>"
  // <element> should[ not] match regex "<value>"
  // When no locator binding exists, falls back to scope-based text comparison.
  reg.register(
    /^(.+) should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([elementName, notStr, op, expected], scope) => {
      const negate = !!notStr;
      const locFn = scope.getLocator(elementName!.trim());
      let actual: string;
      if (locFn) {
        const loc = await locFn() as { inputValue(): Promise<string>; textContent(): Promise<string | null> };
        try {
          actual = await loc.inputValue();
        } catch {
          actual = (await loc.textContent()) ?? '';
        }
        actual = actual.trim();
      } else {
        // No locator binding — treat as scope-based text comparison
        const val = scope.get(elementName!.trim());
        actual = val !== undefined ? val : elementName!.trim();
      }
      const opts = { trim: scope.get('pgwen._trim') === 'true', ignoreCase: scope.get('pgwen._ignoreCase') === 'true' };
      assertText(actual, normaliseOp(op!), expected!, negate, `"${elementName}"`, opts);
    }
  );

  // <element> should have value "<value>"   (always uses inputValue)
  reg.register(
    /^(.+) should have value "([^"]*)"$/i,
    async ([elementName, expected], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const actual = await loc.inputValue();
      if (actual !== expected!) {
        throw new DslAssertionError(
          `Expected "${elementName}" to have value "${expected}" but got "${actual}"`
        );
      }
    }
  );

  // ─── Count assertions ─────────────────────────────────────────────────────

  // <n> <element>[s] should be displayed
  reg.register(
    /^(\d+) (.+?)s? should be displayed$/i,
    async ([nStr, elementName], scope) => {
      const expected = parseInt(nStr!, 10);
      const loc = await resolveLocator(elementName!.trim(), scope);
      const count = await loc.count();
      if (count !== expected) {
        throw new DslAssertionError(
          `Expected ${expected} "${elementName}" elements to be displayed but found ${count}`
        );
      }
    }
  );

  // ─── Dropdown assertions ──────────────────────────────────────────────────

  // the selected option in <dropdown> should[ not] be "<option>"
  reg.register(
    /^the selected option in (.+) should (not )?be "([^"]*)"$/i,
    async ([elementName, notStr, expected], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actual = await loc.evaluate((el: any) => {
        return (el as any).options[(el as any).selectedIndex]?.text ?? '';
      });
      const opts = { trim: scope.get('pgwen._trim') === 'true', ignoreCase: scope.get('pgwen._ignoreCase') === 'true' };
      assertText(actual, 'be', expected!, negate, `selected option in "${elementName}"`, opts);
    }
  );

  // <dropdown> should[ not] contain "<option>"   (option exists in list)
  reg.register(
    /^(.+) should (not )?contain option "([^"]*)"$/i,
    async ([elementName, notStr, option], scope) => {
      const negate = !!notStr;
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = await loc.evaluate((el: any) => {
        return Array.from(el.options as ArrayLike<{ text: string }>).map((o: { text: string }) => o.text);
      });
      const has = options.includes(option!);
      if (negate ? has : !has) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${elementName}" to ${notWord}contain option "${option}"`
        );
      }
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normaliseOp(op: string): CompareOp {
  const lower = op.toLowerCase();
  if (lower === 'be') return 'be';
  if (lower === 'contain') return 'contain';
  if (lower === 'start with') return 'start with';
  if (lower === 'end with') return 'end with';
  if (lower === 'match regex') return 'match regex';
  return 'be';
}
