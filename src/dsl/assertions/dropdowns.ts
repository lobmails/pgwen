/**
 * assertions/dropdowns.ts — Dropdown text/value assertions.
 *
 * the reference framework-form patterns:
 *   <dropdown> <text|value> should[ not] be <blank|empty>
 *   <dropdown> <text|value> should[ not] (be|contain|start with|end with|match regex) "<expr>"
 *
 * Reads the dropdown's currently-selected option:
 *   - `text`  → visible text of the selected <option>
 *   - `value` → value attribute of the selected <option>
 *
 * The dropdown reference is resolved through the locator scope just like
 * actions/dropdowns.ts uses.
 */

import type { DslRegistry } from '../registry';
import { resolveLocator, DslAssertionError, assertText } from '../locatorUtils';
import type { Scope } from '../../engine/Scope';
import { matchesFormat, type FormatKind } from '../formatting/formatMatch';

async function readDropdown(
  elementName: string,
  scope: Scope,
  field: 'text' | 'value',
): Promise<string> {
  const loc = await resolveLocator(elementName, scope);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (loc as any).evaluate((el: any, fld: 'text' | 'value') => {
    const opt = el.options?.[el.selectedIndex];
    if (!opt) return '';
    return fld === 'text' ? (opt.text ?? '') : (opt.value ?? '');
  }, field);
  return (result as string) ?? '';
}

export function registerDropdownAssertions(registry: DslRegistry): void {
  const reg = registry.withCategory('assertion');

  // <dropdown> <text|value> should[ not] be <blank|empty>
  reg.register(
    /^(.+) (text|value) should (not )?be (blank|empty)$/i,
    async ([elementName, field, notStr, keyword], scope) => {
      const negate = !!notStr;
      const value = await readDropdown(
        elementName!.trim(),
        scope,
        field!.toLowerCase() as 'text' | 'value',
      );
      const isBlank = keyword!.toLowerCase() === 'blank'
        ? value.trim() === ''
        : value === '';
      if (negate ? isBlank : !isBlank) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${elementName}" ${field} to ${notWord}be ${keyword} (actual: "${value}")`
        );
      }
    }
  );

  // <dropdown> <text|value> should[ not] (be|contain|start with|end with|match regex) "<expr>"
  reg.register(
    /^(.+) (text|value) should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([elementName, field, notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = await readDropdown(
        elementName!.trim(),
        scope,
        field!.toLowerCase() as 'text' | 'value',
      );
      const opts = {
        trim:       scope.get('pgwen._trim')       === 'true',
        ignoreCase: scope.get('pgwen._ignoreCase') === 'true',
      };
      assertText(
        actual,
        normaliseOp(op!),
        expected!,
        negate,
        `"${elementName}" ${field}`,
        opts,
      );
    }
  );

  // <dropdown> <text|value> should[ not] match (datetime|number) format "<p>" — the reference DSL.
  reg.register(
    /^(.+) (text|value) should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([elementName, field, notStr, kindStr, pattern], scope) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const actual = await readDropdown(
        elementName!.trim(),
        scope,
        field!.toLowerCase() as 'text' | 'value',
      );
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected "${elementName}" ${field} to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );
}

function normaliseOp(op: string): import('../locatorUtils').CompareOp {
  const lower = op.toLowerCase();
  if (lower === 'contain')      return 'contain';
  if (lower === 'start with')   return 'start with';
  if (lower === 'end with')     return 'end with';
  if (lower === 'match regex')  return 'match regex';
  return 'be';
}
