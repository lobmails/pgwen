/**
 * actions/javascript.ts — JS execution steps (standalone + element-scoped).
 *
 * the reference framework-form patterns:
 *   I execute <javascript|js> "<script>"               — page.evaluate
 *   I execute <javascript|js> on <element> "<function>" — element.evaluate
 *   I execute <functionRef> on <element>               — resolve ref, then
 *                                                       element.evaluate
 *
 * The standalone form runs in the page context (no element). The element
 * variants run with the located element passed as the first argument to the
 * function — references to `arguments[0]`, `$(element)` and bare `element` in
 * the script are rewritten to the private parameter name `__pgwenEl__`,
 * matching the makeElementScript convention from bindings/text.ts.
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { resolveLocator } from '../locatorUtils';
import { waitForPageReady, pageReadyOptsFromScope } from '../../engine/PageReady';

function makeElementScript(script: string): string {
  const adjusted = script
    .replace(/\barguments\[0\]/g, '__pgwenEl__')
    .replace(/\$\(element\)/g, '$(__pgwenEl__)')
    .replace(/\belement\b/g, '__pgwenEl__');
  return `(__pgwenEl__) => { ${adjusted} }`;
}

export function registerJsExecution(registry: DslRegistry): void {

  // I execute <javascript|js> on <element> "<function>"
  // Registered BEFORE the standalone form so the "on <element>" suffix wins.
  registry.register(
    /^I execute (?:javascript|js) on (.+?) "([^"]+)"$/i,
    async ([elementName, script], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (loc as any).evaluate(makeElementScript(script!));
    }
  );

  // I execute <functionRef> on <element>
  // Resolves <functionRef> through scope (typically a JS-binding created via
  // `<name> is defined by js "..."` or stored under `<name>/javascript`).
  registry.register(
    /^I execute (.+?) on (.+)$/i,
    async ([functionRef, elementName], scope) => {
      const ref = functionRef!.trim();
      const script = scope.get(`${ref}/javascript`) ?? scope.get(ref);
      if (!script) {
        throw new Error(`No JS binding found for "${ref}". Define it with: ${ref} is defined by js "<script>"`);
      }
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (loc as any).evaluate(makeElementScript(script));
    }
  );

  // I execute <javascript|js> "<script>"   (standalone — runs in page context)
  registry.register(
    /^I execute (?:javascript|js) "([^"]+)"$/i,
    async ([script], scope, page) => {
      // Settle the page first — same rationale as the JS bindings: a script
      // that runs against a half-loaded document can produce vacuous results.
      await waitForPageReady(page as PageLike, pageReadyOptsFromScope(scope));
      await (page as PageLike).evaluate(script!);
    }
  );
}
