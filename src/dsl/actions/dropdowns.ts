/**
 * actions/dropdowns.ts — Dropdown / select interaction steps.
 *
 *   I select "<option>" in <dropdown>                        — by visible text
 *   I select by value "<value>" in <dropdown>               — by option value attribute
 *   I select by index "<index>" in <dropdown>               — by 0-based index
 *   I select the <n>st/nd/rd/th option in <dropdown>        — by 1-based ordinal
 *   I deselect "<option>" in <dropdown>                     — multi-select deselect
 *   I deselect the <n>st/nd/rd/th option in <dropdown>      — deselect by ordinal
 *
 * Action-by-JS override:
 *   <dropdown> can be selected by js "<script>"             — bind a JS body to
 *     replace the native selectOption call. The script is evaluated against the
 *     located element. `element` and `$(element)` references in the script are
 *     rewritten to a private parameter name so they resolve to the Playwright
 *     element handle. Used by projects whose target app needs jQuery-style value
 *     setting (e.g. `$(element).val('AU')`) instead of native option select.
 */

import type { DslRegistry } from '../registry';
import { resolveLocator } from '../locatorUtils';
import type { Scope } from '../../engine/Scope';

const JS_ACTION_SUFFIX = '/can-be-selected-by-js';

/** Convert an action-by-JS script body into a Playwright `evaluate` arrow fn. */
function makeActionScript(script: string): string {
  const adjusted = script
    .replace(/\$\(element\)/g, '$(__pgwenEl__)')
    .replace(/\belement\b/g, '__pgwenEl__');
  return `(__pgwenEl__) => { ${adjusted} }`;
}

/**
 * Check for a registered `can be selected by js` override on the element and
 * execute it if present. Returns true when the override fired (caller should
 * skip the native selectOption); false when no override is bound.
 */
async function runSelectByJsOverride(
  elementName: string,
  scope: Scope,
): Promise<boolean> {
  const script = scope.get(`${elementName}${JS_ACTION_SUFFIX}`);
  if (!script) return false;
  const loc = await resolveLocator(elementName, scope);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (loc as any).evaluate(makeActionScript(script));
  return true;
}

export function registerDropdownActions(registry: DslRegistry): void {
  const reg = registry.withCategory('locator-action');

  // <element> can be selected by js "<script>"
  // Binding step — stores the override under `<element>/can-be-selected-by-js`.
  // Subsequent `I select ... in <element>` calls run the JS instead of the
  // native selectOption. Registered FIRST so it wins over the generic
  // `I select "<option>" in (.+)` pattern when someone writes a step like
  // `select foo can be selected by js "..."` (rare; safety net).
  reg.register(
    /^(.+) can be selected by js "(.+)"$/i,
    async ([elementName, script], scope) => {
      scope.setTransparent(`${elementName!.trim()}${JS_ACTION_SUFFIX}`, script!);
    }
  );

  // I select "<v>" in <dropdown> by value|text|index
  //   alternate-order wording — the `by <kind>` suffix follows the dropdown
  //   reference instead of preceding it. Registered BEFORE the bare `I select
  //   "<option>" in <dropdown>` form so the suffix doesn't get swallowed by
  //   the broader pattern's `(.+)` element-name capture.
  reg.register(
    /^I select "([^"]+)" in (.+?) by (value|text|index)$/i,
    async ([selector, elementName, kind], scope) => {
      const name = elementName!.trim();
      if (await runSelectByJsOverride(name, scope)) return;
      const loc = await resolveLocator(name, scope);
      const k = kind!.toLowerCase();
      if (k === 'value') {
        await loc.selectOption({ value: selector! });
      } else if (k === 'index') {
        await loc.selectOption({ index: parseInt(selector!, 10) });
      } else {
        await loc.selectOption({ label: selector! });
      }
    }
  );

  // I select "<option>" in <dropdown>
  reg.register(
    /^I select "([^"]+)" in (.+)$/i,
    async ([option, elementName], scope) => {
      const name = elementName!.trim();
      if (await runSelectByJsOverride(name, scope)) return;
      const loc = await resolveLocator(name, scope);
      await loc.selectOption({ label: option! });
    }
  );

  // I select by value "<value>" in <dropdown>
  reg.register(
    /^I select by value "([^"]+)" in (.+)$/i,
    async ([value, elementName], scope) => {
      const name = elementName!.trim();
      if (await runSelectByJsOverride(name, scope)) return;
      const loc = await resolveLocator(name, scope);
      await loc.selectOption({ value: value! });
    }
  );

  // I select by index "<index>" in <dropdown>
  reg.register(
    /^I select by index "(\d+)" in (.+)$/i,
    async ([indexStr, elementName], scope) => {
      const name = elementName!.trim();
      if (await runSelectByJsOverride(name, scope)) return;
      const loc = await resolveLocator(name, scope);
      await loc.selectOption({ index: parseInt(indexStr!, 10) });
    }
  );

  // I select the <n>st/nd/rd/th option in <dropdown>  (1-based ordinal → 0-based index)
  reg.register(
    /^I select the (\d+)(?:st|nd|rd|th) option in (.+)$/i,
    async ([ordinalStr, elementName], scope) => {
      const name = elementName!.trim();
      if (await runSelectByJsOverride(name, scope)) return;
      const loc = await resolveLocator(name, scope);
      await loc.selectOption({ index: parseInt(ordinalStr!, 10) - 1 });
    }
  );

  // I deselect "<option>" in <dropdown>   (for multi-select)
  reg.register(
    /^I deselect "([^"]+)" in (.+)$/i,
    async ([option, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // Playwright doesn't have a direct deselect; simulate via JS
      const optionText = option!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await loc.evaluate((el: any, text: any) => {
        for (const opt of Array.from(el.options as ArrayLike<{ text: string; selected: boolean }>)) {
          if ((opt as any).text === text) (opt as any).selected = false;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, optionText);
    }
  );

  // I deselect the <n>st/nd/rd/th option in <dropdown>  (1-based ordinal, multi-select)
  reg.register(
    /^I deselect the (\d+)(?:st|nd|rd|th) option in (.+)$/i,
    async ([ordinalStr, elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const zeroIndex = parseInt(ordinalStr!, 10) - 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await loc.evaluate((el: any, idx: number) => {
        const opts = Array.from(el.options as ArrayLike<{ selected: boolean }>);
        if (opts[idx]) (opts[idx] as any).selected = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, zeroIndex);
    }
  );
}
