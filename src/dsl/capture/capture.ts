/**
 * capture/capture.ts — Value capture steps.
 *
 * Implements all the reference framework "I capture ..." patterns.
 * Capture is always eager — the value is read from the page immediately
 * and stored as a literal string in scope.
 *
 * Supported patterns:
 *   I capture <element>
 *   I capture <element> as <name>
 *   I capture the text in <element> as <name>
 *   I capture the value of <element> as <name>
 *   I capture the url
 *   I capture the url as <name>
 *   I capture the current url
 *   I capture the current url as <name>
 *   I capture the title
 *   I capture the title as <name>
 *   I capture the selected option in <dropdown> as <name>
 *   I capture <element> of <context> as <name>
 *   I capture <attribute> attribute of <element> as <name>
 *   I capture <style> style of <element> as <name>
 *   I capture the number of <element> elements as <name>
 *   I capture the screenshot as <name>
 *   I capture the screenshot
 */

import * as path from 'path';
import * as fs from 'fs';
import type { DslRegistry } from '../registry';
import { resolveLocator, type PageLike } from '../locatorUtils';
import { similarityPercent } from '../assertions/text';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerCapture(registry: DslRegistry): void {

  // I capture the url [as <name>]
  registry.register(
    /^I capture (?:the )?(?:current )?url(?: as (.+))?$/i,
    async ([nameRaw], scope, page) => {
      const name = (nameRaw || 'url').trim();
      const url = (page as PageLike).url();
      scope.setTransparent(name, url);
    }
  );

  // I capture the title [as <name>]
  registry.register(
    /^I capture (?:the )?(?:page )?title(?: as (.+))?$/i,
    async ([nameRaw], scope, page) => {
      const name = (nameRaw || 'title').trim();
      const title = await (page as PageLike).title();
      scope.setTransparent(name, title);
    }
  );

  // I capture the [current] screenshot [as <name>]
  // Takes a full-page screenshot and stores the file path in scope. The optional
  // `current` keyword matches the reference framework's documented form (`I capture the current
  // screenshot`); both wordings resolve to the same handler. Registered HERE
  // (before the generic `I capture <element>` patterns below) so the literal
  // "screenshot" token doesn't get consumed as an element name.
  registry.register(
    /^I capture the (?:current )?screenshot(?: as (.+))?$/i,
    async ([nameRaw], scope, page) => {
      const name = (nameRaw?.trim() || 'pgwen.screenshot').trim();
      const dir = scope.get('pgwen.outdir') ?? '.';
      const timestamp = Date.now();
      const filepath = path.join(dir, `screenshot-${timestamp}.png`);
      fs.mkdirSync(dir, { recursive: true });
      await (page as PageLike & { screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer> })
        .screenshot({ path: filepath, fullPage: true });
      scope.setTransparent(name, filepath);
    }
  );

  // I capture the text in <xmlRef> by xpath "<expr>" as <name>
  // Evaluates an XPath expression against a scope binding that holds XML content.
  // Registered before "I capture the text in (.+) as (.+)" to avoid being swallowed.
  registry.register(
    /^I capture (?:the text in )?(.+?) by xpath "([^"]*)" as (.+)$/i,
    async ([refName, xpathExpr, name], scope) => {
      const xml = scope.get(refName!.trim()) ?? '';
      let value = '';
      try {
        const { DOMParser } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom');
        const xpathLib = require('xpath') as typeof import('xpath');
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const result = xpathLib.select(xpathExpr!, doc as unknown as Node);
        if (Array.isArray(result) && result.length > 0) {
          const node = result[0] as { textContent?: string; nodeValue?: string | null; toString(): string };
          value = node.textContent ?? node.nodeValue ?? node.toString();
        } else if (!Array.isArray(result)) {
          value = String(result);
        }
      } catch { value = ''; }
      scope.setTransparent(name!.trim(), value);
    }
  );

  // I capture the [text|content] in <jsonRef> by json path "<expr>" as <name>
  // Evaluates a dot-notation JSON path against a scope binding that holds JSON content.
  // the reference framework-form wording uses "content"; pgwen also accepts "text" and the bare form
  // (`I capture <ref> by json path …`) for parity with existing project code.
  // Registered before "I capture the text in (.+) as (.+)" to avoid being swallowed.
  registry.register(
    /^I capture (?:the (?:text|content) in )?(.+?) by json path "([^"]*)" as (.+)$/i,
    async ([refName, jsonPath, name], scope) => {
      const json = scope.get(refName!.trim()) ?? '';
      let value = '';
      try {
        const obj = JSON.parse(json) as unknown;
        const result = resolveJsonPath(obj, jsonPath!);
        value = result !== undefined && result !== null ? String(result) : '';
      } catch { value = ''; }
      scope.setTransparent(name!.trim(), value);
    }
  );

  // I capture the text in <element> as <name>
  registry.register(
    /^I capture the text in (.+) as (.+)$/i,
    async ([elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const text = await loc.textContent();
      scope.setTransparent(name!.trim(), text ?? '');
    }
  );

  // I capture the value of <element> as <name>
  registry.register(
    /^I capture the value of (.+) as (.+)$/i,
    async ([elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const value = await loc.inputValue();
      scope.setTransparent(name!.trim(), value);
    }
  );

  // I capture the selected option in <dropdown> as <name>
  registry.register(
    /^I capture the selected option in (.+) as (.+)$/i,
    async ([elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // Playwright: get the text of the selected option
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = await loc.evaluate((el: any) => {
        return el.options[el.selectedIndex]?.text ?? '';
      });
      scope.setTransparent(name!.trim(), text as string);
    }
  );

  // I capture the selected options in <dropdown> as <name>   (multi-select)
  registry.register(
    /^I capture the selected options in (.+) as (.+)$/i,
    async ([elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const texts = await loc.evaluate((el: any) => {
        return Array.from(el.selectedOptions as ArrayLike<{ text: string }>).map((o: { text: string }) => o.text);
      });
      scope.setTransparent(name!.trim(), JSON.stringify(texts));
    }
  );

  // ─── Element screenshot ─────────────────────────────────────────────────
  // I capture element screenshot of <element> [as <name>]
  registry.register(
    /^I capture element screenshot of (.+?)(?: as (.+))?$/i,
    async ([elementName, nameRaw], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const name = (nameRaw?.trim() || `${elementName!.trim()} screenshot`).trim();
      const dir = scope.get('pgwen.outdir') ?? '.';
      const timestamp = Date.now();
      const filepath = path.join(dir, `element-screenshot-${timestamp}.png`);
      fs.mkdirSync(dir, { recursive: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (loc as any).screenshot({ path: filepath });
      scope.setTransparent(name, filepath);
    }
  );

  // ─── URL regex capture ──────────────────────────────────────────────────
  // I capture the text in the current URL by regex "<expr>" as <name>
  registry.register(
    /^I capture the text in the current URL by regex "([^"]+)" as (.+)$/i,
    async ([pattern, name], scope, page) => {
      const url = (page as PageLike).url();
      const re = new RegExp(pattern!);
      const match = re.exec(url);
      const value = match ? (match[1] ?? match[0] ?? '') : '';
      scope.setTransparent(name!.trim(), value);
    }
  );

  // ─── Similarity capture ─────────────────────────────────────────────────
  //
  //   I capture the similarity score of <ref> compared to "<text>" [as <name>]
  //   I capture the similarity score of <ref1> compared to <ref2>   [as <name>]
  //
  // Score is the Levenshtein-based similarity ratio (0-100, two decimal places)
  // computed against either a literal expected text or another scope binding.
  // When `as <name>` is omitted, the score is bound under "similarity score".
  // Registered BEFORE the generic capture-attribute / capture-as / capture
  // patterns so the longer "the similarity score of" phrase wins.

  registry.register(
    /^I capture the similarity score of (.+) compared to "([^"]*)"(?: as (.+))?$/i,
    async ([refName, expected, nameRaw], scope) => {
      const actual = scope.get(refName!.trim()) ?? '';
      const score = similarityPercent(actual, expected!);
      const target = (nameRaw?.trim() || 'similarity score').trim();
      scope.setTransparent(target, score.toFixed(2));
    }
  );

  registry.register(
    /^I capture the similarity score of (.+) compared to (?!")([^"]+?)(?: as (.+))?$/i,
    async ([refName, expectedRef, nameRaw], scope) => {
      const actual = scope.get(refName!.trim()) ?? '';
      const expected = scope.get(expectedRef!.trim()) ?? expectedRef!.trim();
      const score = similarityPercent(actual, expected);
      const target = (nameRaw?.trim() || 'similarity score').trim();
      scope.setTransparent(target, score.toFixed(2));
    }
  );

  // I capture <attribute> attribute of <element> as <name>
  registry.register(
    /^I capture (.+) attribute of (.+) as (.+)$/i,
    async ([attribute, elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const value = await loc.getAttribute(attribute!.trim());
      scope.setTransparent(name!.trim(), value ?? '');
    }
  );

  // I capture <style> style of <element> as <name>
  registry.register(
    /^I capture (.+) style of (.+) as (.+)$/i,
    async ([styleProp, elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const prop = styleProp!.trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = await loc.evaluate((el: any, p: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (globalThis as any).getComputedStyle(el).getPropertyValue(p);
      }, prop);
      scope.setTransparent(name!.trim(), value as string);
    }
  );

  // I capture the number of <element> elements as <name>
  registry.register(
    /^I capture the number of (.+) elements? as (.+)$/i,
    async ([elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const count = await loc.count();
      scope.setTransparent(name!.trim(), String(count));
    }
  );

  // I capture <element> of <context> as <name>
  registry.register(
    /^I capture (.+) of (.+) as (.+)$/i,
    async ([elementName, _contextName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const text = await loc.textContent();
      scope.setTransparent(name!.trim(), text ?? '');
    }
  );

  // I capture <element> as <name>   (text content)
  registry.register(
    /^I capture (.+) as (.+)$/i,
    async ([elementName, name], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const text = await loc.textContent();
      scope.setTransparent(name!.trim(), text ?? '');
    }
  );

  // I capture <element>   (default binding name = element name)
  registry.register(
    /^I capture (.+)$/i,
    async ([elementName], scope) => {
      const name = elementName!.trim();
      const loc = await resolveLocator(name, scope);
      const text = await loc.textContent();
      scope.setTransparent(name, text ?? '');
    }
  );

}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Evaluate a simple dot-notation JSON path against an object. */
function resolveJsonPath(obj: unknown, jsonPath: string): unknown {
  const parts = jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
