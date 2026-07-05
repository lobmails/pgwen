/**
 * assertions/url.ts — URL and page-title assertion steps.
 *
 *   the current url should[ not] be "<expression>"
 *   the current url should[ not] contain "<expression>"
 *   the current url should[ not] start with "<expression>"
 *   the current url should[ not] end with "<expression>"
 *   the current url should[ not] match regex "<expression>"
 *   the page title should[ not] be "<expression>"
 *   the page title should[ not] contain "<expression>"
 *   the page title should[ not] start with "<expression>"
 *   the page title should[ not] end with "<expression>"
 *   the page title should[ not] match regex "<expression>"
 *   the browser title should[ not] be "<expression>"
 *   a new tab should[ not] be open
 *   <n> tab[s] should be open
 */

import type { DslRegistry } from '../registry';
import { assertText, DslAssertionError, type PageLike } from '../locatorUtils';
import { matchesFormat, type FormatKind } from '../formatting/formatMatch';

export function registerUrlAssertions(registry: DslRegistry): void {
  const reg = registry.withCategory('assertion');

  // ─── URL assertions ────────────────────────────────────────────────────────

  reg.register(
    /^the current url should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([notStr, op, expected], scope, page) => {
      const negate = !!notStr;
      const actual = (page as PageLike).url();
      const opts = { trim: scope.get('pgwen._trim') === 'true', ignoreCase: scope.get('pgwen._ignoreCase') === 'true' };
      assertText(actual, normaliseOp(op!), expected!, negate, 'the current url', opts);
    }
  );

  // ─── Page title assertions ─────────────────────────────────────────────────

  reg.register(
    /^the (?:page |browser )?title should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([notStr, op, expected], scope, page) => {
      const negate = !!notStr;
      const actual = await (page as PageLike).title();
      const opts = { trim: scope.get('pgwen._trim') === 'true', ignoreCase: scope.get('pgwen._ignoreCase') === 'true' };
      assertText(actual, normaliseOp(op!), expected!, negate, 'the page title', opts);
    }
  );

  // ─── Format pattern matching (the reference DSL) ─────────────────────────────────
  //   the current url should[ not] match (datetime|number) format "<p>"
  //   the (page|browser )?title should[ not] match (datetime|number) format "<p>"

  reg.register(
    /^the current url should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([notStr, kindStr, pattern], _scope, page) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const actual = (page as PageLike).url();
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected the current url to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );

  reg.register(
    /^the (?:page |browser )?title should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([notStr, kindStr, pattern], _scope, page) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const actual = await (page as PageLike).title();
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected the page title to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );

  // ─── Tab / window count ────────────────────────────────────────────────────

  // a new tab should[ not] be open
  reg.register(
    /^a new tab should (not )?be open$/i,
    async ([notStr], _scope, page) => {
      const negate = !!notStr;
      const context = (page as unknown as { context(): { pages(): unknown[] } }).context();
      const count = context.pages().length;
      const hasNew = count > 1;
      if (negate ? hasNew : !hasNew) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected a new tab to ${notWord}be open (found ${count} tab(s))`);
      }
    }
  );

  // <n> tab[s] should be open
  reg.register(
    /^(\d+) tabs? should be open$/i,
    async ([nStr], _scope, page) => {
      const expected = parseInt(nStr!, 10);
      const context = (page as unknown as { context(): { pages(): unknown[] } }).context();
      const actual = context.pages().length;
      if (actual !== expected) {
        throw new DslAssertionError(`Expected ${expected} tab(s) to be open but found ${actual}`);
      }
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normaliseOp(op: string): import('../locatorUtils').CompareOp {
  const lower = op.toLowerCase();
  if (lower === 'be') return 'be';
  if (lower === 'contain') return 'contain';
  if (lower === 'start with') return 'start with';
  if (lower === 'end with') return 'end with';
  if (lower === 'match regex') return 'match regex';
  return 'be';
}
