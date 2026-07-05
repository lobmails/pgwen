/**
 * bindings/locators.ts — Element locator binding steps.
 *
 * Implements all the reference framework "can be located by" DSL patterns.
 * Locators are stored in scope as lazy LocatorFn entries; the actual
 * Playwright locator is only created when the element is first used.
 *
 * Supported patterns:
 *   <element> can be located by <selector> "<expression>"
 *   <element> can be located by <selector> "<expression>" at index <n>
 *   <element> can be located by <selector> "<expression>" in <parent>
 *   <element> can be located by <selector> "<expression>" at index <n> in <parent>
 *
 * Relative locators (spatial proximity via bounding-box filtering):
 *   <element> can be located by <selector> "<expression>" above <otherElement>
 *   <element> can be located by <selector> "<expression>" below <otherElement>
 *   <element> can be located by <selector> "<expression>" to left of <otherElement>
 *   <element> can be located by <selector> "<expression>" to right of <otherElement>
 *   <element> can be located by <selector> "<expression>" near <otherElement>
 *   <element> can be located by <selector> "<expression>" near and within <n> pixel[s] of <otherElement>
 *
 * Multi-row table form (mirrors the reference framework-Web BindMultipleElementLocators):
 *   <element> can be located by
 *     | <selectorType> | <expression> |
 *     | <selectorType> | <expression> |
 *   Each row registers a separate locator for the same element name; the
 *   element resolves to the first locator that finds a match (registration
 *   order).
 */

import type { DslRegistry } from '../registry';
import type { Scope } from '../../engine/Scope';
import { buildLocator, resolveLocator, type FrameLocatorLike } from '../locatorUtils';

const SELECTOR_TYPES =
  'id|name|tag name|tag|css selector|css|xpath|class name|class|link text|partial link text|javascript|js';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerLocatorBindings(registry: DslRegistry): void {

  // <element> can be located by <selector> "<expression>"
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)"$`, 'i'),
    async ([elementName, selectorType, expression], scope, page) => {
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const frameFn = scope.getLocator('pgwen._active_frame');
        if (frameFn) {
          const frame = await frameFn() as FrameLocatorLike | undefined | null;
          // `I switch to (main|default|parent) frame` clears the active
          // frame by binding a () => undefined sentinel. Treat that as
          // "no frame" and fall through to page-level locators.
          if (frame) return buildLocatorFromFrame(frame, selectorType!, expression!);
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" at index <n>
  //
  // Note: the lazy-page proxy in PlaywrightRunner intercepts all method calls
  // and wraps them as async (returning Promise<Locator> instead of Locator).
  // We therefore `await` the `buildLocator` result before chaining `.nth()` —
  // skipping the await crashes with "base.nth is not a function".
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" at index (\\d+)$`, 'i'),
    async ([elementName, selectorType, expression, indexStr], scope, page) => {
      const index = parseInt(indexStr!, 10);
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const frameFn = scope.getLocator('pgwen._active_frame');
        if (frameFn) {
          const frame = await frameFn() as FrameLocatorLike;
          return buildLocatorFromFrame(frame, selectorType!, expression!).nth(index);
        }
        const base = await buildLocator(page, selectorType!, expression!);
        return base.nth(index);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" in <parent>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" in (.+)$`, 'i'),
    async ([elementName, selectorType, expression, parentName], scope, _page) => {
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const parentLocator = await resolveLocator(parentName!.trim(), scope);
        return parentLocator.locator(toPlaywrightSelector(selectorType!, expression!));
      });
    }
  );

  // <element> can be located by <selector> "<expression>" at index <n> in <parent>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" at index (\\d+) in (.+)$`, 'i'),
    async ([elementName, selectorType, expression, indexStr, parentName], scope, _page) => {
      const index = parseInt(indexStr!, 10);
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const parentLocator = await resolveLocator(parentName!.trim(), scope);
        const pl = parentLocator as unknown as { locator(s: string): { nth(i: number): unknown } };
        return pl.locator(toPlaywrightSelector(selectorType!, expression!)).nth(index);
      });
    }
  );

  // ── Multi-row table form ─────────────────────────────────────────────────
  // <element> can be located by
  //   | <selectorType> | <expression> |
  //   | <selectorType> | <expression> |
  //
  // Each row is tried in order; the element resolves to the first locator that
  // finds at least one match. If none match, falls back to the first row's
  // locator so the eventual failure points to a real selector.
  //
  // Registered BEFORE the single-line forms so it doesn't get shadowed —
  // the pattern is unambiguous because it has no trailing selector + quoted
  // expression. The handler short-circuits when no data table is present
  // (allowing the single-line patterns to match instead).
  registry.register(
    /^(.+) can be located by$/i,
    async ([elementName], scope, page) => {
      const raw = scope.get('pgwen._step_datatable') ?? '';
      if (!raw) {
        throw new Error(
          `"${elementName} can be located by" requires a data table with selectorType + expression columns.`
        );
      }
      let table: string[][];
      try { table = JSON.parse(raw) as string[][]; }
      catch { throw new Error('Malformed data table for "can be located by" step.'); }

      const validTypes = SELECTOR_TYPES.split('|');
      const rows: Array<{ selectorType: string; expression: string }> = [];
      for (const row of table) {
        if (row.length < 2) continue;
        const selectorType = row[0]!.trim().toLowerCase();
        const expression = row[1]!.trim();
        if (!validTypes.includes(selectorType)) continue; // skip header / unknown
        rows.push({ selectorType, expression });
      }
      if (rows.length === 0) {
        throw new Error(
          `"${elementName} can be located by" table had no rows with a recognised selector type.`
        );
      }

      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const frameFn = scope.getLocator('pgwen._active_frame');

        if (frameFn) {
          const frame = await frameFn() as FrameLocatorLike;
          for (const { selectorType, expression } of rows) {
            const cand = buildLocatorFromFrame(frame, selectorType, expression);
            try {
              const count = await (cand as unknown as { count(): Promise<number> }).count();
              if (count > 0) return cand;
            } catch { /* malformed expression — try next */ }
          }
          return buildLocatorFromFrame(frame, rows[0]!.selectorType, rows[0]!.expression);
        }

        for (const { selectorType, expression } of rows) {
          const cand = buildLocator(page, selectorType, expression);
          try {
            const count = await (cand as unknown as { count(): Promise<number> }).count();
            if (count > 0) return cand;
          } catch { /* malformed expression — try next */ }
        }
        return buildLocator(page, rows[0]!.selectorType, rows[0]!.expression);
      });
    }
  );

  // ── Relative locators (spatial proximity) ────────────────────────────────
  // the reference framework-Web: <element> can be located by <selector> "<expr>" above|below|near|to left of|to right of <otherElement>
  // Playwright doesn't have native relative locators; we filter by bounding-box position at resolution time.

  // <element> can be located by <selector> "<expression>" above <otherElement>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" above (.+)$`, 'i'),
    async ([elementName, selectorType, expression, otherName], scope, page) => {
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const ref = await resolveLocator(otherName!.trim(), scope);
        const refBox = await ref.boundingBox();
        const candidates = await buildLocator(page, selectorType!, expression!).all();
        for (const el of candidates) {
          const box = await el.boundingBox();
          if (box && refBox && box.y + box.height <= refBox.y) return el;
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" below <otherElement>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" below (.+)$`, 'i'),
    async ([elementName, selectorType, expression, otherName], scope, page) => {
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const ref = await resolveLocator(otherName!.trim(), scope);
        const refBox = await ref.boundingBox();
        const candidates = await buildLocator(page, selectorType!, expression!).all();
        for (const el of candidates) {
          const box = await el.boundingBox();
          if (box && refBox && box.y >= refBox.y + refBox.height) return el;
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" to left of <otherElement>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" to left of (.+)$`, 'i'),
    async ([elementName, selectorType, expression, otherName], scope, page) => {
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const ref = await resolveLocator(otherName!.trim(), scope);
        const refBox = await ref.boundingBox();
        const candidates = await buildLocator(page, selectorType!, expression!).all();
        for (const el of candidates) {
          const box = await el.boundingBox();
          if (box && refBox && box.x + box.width <= refBox.x) return el;
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" to right of <otherElement>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" to right of (.+)$`, 'i'),
    async ([elementName, selectorType, expression, otherName], scope, page) => {
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const ref = await resolveLocator(otherName!.trim(), scope);
        const refBox = await ref.boundingBox();
        const candidates = await buildLocator(page, selectorType!, expression!).all();
        for (const el of candidates) {
          const box = await el.boundingBox();
          if (box && refBox && box.x >= refBox.x + refBox.width) return el;
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" near and within <pixels> pixels of <otherElement>
  // <element> can be located by <selector> "<expression>" near and within 1 pixel of <otherElement>
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" near and within (\\d+) pixels? of (.+)$`, 'i'),
    async ([elementName, selectorType, expression, pixelsStr, otherName], scope, page) => {
      const maxDistance = parseInt(pixelsStr!, 10);
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const ref = await resolveLocator(otherName!.trim(), scope);
        const refBox = await ref.boundingBox();
        const candidates = await buildLocator(page, selectorType!, expression!).all();
        for (const el of candidates) {
          const box = await el.boundingBox();
          if (box && refBox) {
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const rcx = refBox.x + refBox.width / 2;
            const rcy = refBox.y + refBox.height / 2;
            if (Math.sqrt((cx - rcx) ** 2 + (cy - rcy) ** 2) <= maxDistance) return el;
          }
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );

  // <element> can be located by <selector> "<expression>" near <otherElement>
  // (defaults to within 50px — the reference framework's default proximity threshold)
  registry.register(
    new RegExp(`^(.+) can be located by (${SELECTOR_TYPES}) "(.+)" near (.+)$`, 'i'),
    async ([elementName, selectorType, expression, otherName], scope, page) => {
      const maxDistance = 50;
      scope.setLocatorTransparent(elementName!.trim(), async () => {
        const ref = await resolveLocator(otherName!.trim(), scope);
        const refBox = await ref.boundingBox();
        const candidates = await buildLocator(page, selectorType!, expression!).all();
        for (const el of candidates) {
          const box = await el.boundingBox();
          if (box && refBox) {
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const rcx = refBox.x + refBox.width / 2;
            const rcy = refBox.y + refBox.height / 2;
            if (Math.sqrt((cx - rcx) ** 2 + (cy - rcy) ** 2) <= maxDistance) return el;
          }
        }
        return buildLocator(page, selectorType!, expression!);
      });
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a locator scoped to an active frame instead of the top-level page. */
function buildLocatorFromFrame(frame: FrameLocatorLike, selectorType: string, expression: string) {
  const type = selectorType.trim().toLowerCase();
  if (type === 'link text') return frame.getByText(expression, { exact: true });
  if (type === 'partial link text') return frame.getByText(expression, { exact: false });
  return frame.locator(toPlaywrightSelector(selectorType, expression));
}

/** Convert the reference framework selector type + expression to a Playwright CSS/XPath selector string. */
function toPlaywrightSelector(selectorType: string, expression: string): string {
  const type = selectorType.trim().toLowerCase();
  switch (type) {
    case 'id': return `[id="${expression}"]`;
    case 'name': return `[name="${expression}"]`;
    case 'css selector': case 'css': return expression;
    case 'xpath': return `xpath=${expression}`;
    case 'class name': case 'class': return expression.startsWith('.') ? expression : `.${expression}`;
    default: return expression;
  }
}

// ─── Re-export for Scope inspection ──────────────────────────────────────────

/**
 * Bind an element locator directly (used by MetaEngine inline-binding in tests).
 * This is the programmatic equivalent of "the <element> can be located by css <expr>".
 */
export function bindLocator(
  elementName: string,
  selectorType: string,
  expression: string,
  scope: Scope,
  page: unknown
): void {
  scope.setLocator(elementName, async () => buildLocator(page, selectorType, expression));
}
