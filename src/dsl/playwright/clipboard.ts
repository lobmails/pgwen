/**
 * playwright/clipboard.ts — Browser clipboard read/write steps.
 *
 * Clipboard access requires the `clipboard-read` / `clipboard-write` permission
 * and executes via `page.evaluate()` using the Clipboard API.
 *
 * Supported patterns:
 *   I write to clipboard "<text>"
 *   I write <textRef> to clipboard
 *   I capture clipboard as <name>
 *   the clipboard should[ not] contain "<expression>"
 *   the clipboard should[ not] be "<expression>"
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { DslAssertionError, assertText } from '../locatorUtils';

const SCOPE_CLIPBOARD = 'pgwen.clipboard';

export function registerClipboard(registry: DslRegistry): void {

  // I write to clipboard "<text>"
  registry.register(
    /^I write to clipboard "([^"]*)"$/i,
    async ([text], scope, page) => {
      await (page as PageLike).evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t: any) => (globalThis as any).navigator.clipboard.writeText(t),
        text!
      );
      scope.set(SCOPE_CLIPBOARD, text!);
    }
  );

  // I write <textRef> to clipboard
  registry.register(
    /^I write (.+) to clipboard$/i,
    async ([textRef], scope, page) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      await (page as PageLike).evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t: any) => (globalThis as any).navigator.clipboard.writeText(t),
        text
      );
      scope.set(SCOPE_CLIPBOARD, text);
    }
  );

  // I capture clipboard as <name>
  registry.register(
    /^I capture clipboard as (.+)$/i,
    async ([name], scope, page) => {
      const text = await (page as PageLike).evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (globalThis as any).navigator.clipboard.readText()
      ) as string;
      scope.set(name!.trim(), text);
      scope.set(SCOPE_CLIPBOARD, text);
    }
  );

  // the clipboard should[ not] be/contain "<expression>"
  registry.register(
    /^the clipboard should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = scope.get(SCOPE_CLIPBOARD) ?? '';
      assertText(actual, op as import('../locatorUtils').CompareOp, expected!, negate, '"clipboard"');
    }
  );
}
