/**
 * actions/windows.ts — Window / tab / named-browser management steps.
 *
 * Supported patterns:
 *   I open a new tab
 *   I close the current tab
 *   I switch to the new tab
 *   I switch to the last tab
 *   I switch to the parent tab
 *   I switch to the "<name>" tab
 *   I close the "<name>" tab
 *   I start a new browser
 *   I close the browser
 *   I start a new browser as "<name>"
 *   I switch to the "<name>" browser
 *   I close the "<name>" browser
 *
 * "child window" / "parent window" terminology is synonymous with tabs in
 * Playwright — both use the same pages() array on the browser context.
 * "child window" = the last-opened page; "parent window" = pages()[0].
 * Page references are stored in scope as LocatorFn entries so they can be
 * retrieved without adding new Scope APIs. Named browsers and tabs are stored
 * under `pgwen._browser_<name>` and `pgwen._tab_<name>` keys respectively.
 * The most-recently-opened page is stored under `pgwen._last_page`.
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { DslAssertionError } from '../locatorUtils';

/**
 * Swap the runner's active page so subsequent action / locator steps route
 * to the new tab. The lazy-page proxy installed by `PlaywrightRunner` exposes
 * a `__pgwenSetActivePage` setter for exactly this purpose. Without this
 * call, `I switch to ... (tab|window)` steps only update scope bindings but
 * the next `I click the X` still targets the original page.
 */
function routeToPage(proxyPage: unknown, target: unknown): void {
  const setter = (proxyPage as Record<string, unknown>)['__pgwenSetActivePage'];
  if (typeof setter === 'function') (setter as (p: unknown) => void)(target);
}

/**
 * Poll the context's pages array for a child page (one positioned AFTER the
 * current page in the array). Retries until either a child is found or the
 * configured wait window expires.
 *
 * Why this shape (vs. `ctx.waitForEvent('page')`):
 *   - waitForEvent only fires for NEW pages. If the popup opened in the brief
 *     window between the triggering click and this step, the event has
 *     already passed and waitForEvent hangs.
 *   - Polling pages() is idempotent — works whether the popup arrived early,
 *     on time, or late.
 *
 * Matches pgwen-web's `DriverManager.switchToNext(handles)` shape: take the
 * next page AFTER the current one. The "current" page is resolved through
 * the proxy by calling its async `title()` once (forces ensurePage), then
 * comparing references against the `pages()` snapshot.
 */
async function pollForChild(
  proxyPage: unknown,
  scope: { get(name: string): string | undefined },
): Promise<PageLike | null> {
  const ctx = (proxyPage as PageLike).context();
  // Resolve current page reference via the proxy's __pgwenGetActivePage hook
  // if available, otherwise heuristically use pages()[0] as parent.
  const getActive = (proxyPage as Record<string, unknown>)['__pgwenGetActivePage'];
  const current: PageLike | undefined = typeof getActive === 'function'
    ? ((getActive as () => unknown)() as PageLike | undefined)
    : undefined;

  const waitMs = parsePosInt(scope.get('pgwen.web.wait.seconds'), 20) * 1000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const pages = ctx.pages();
    if (pages.length > 1) {
      // Prefer the page AFTER `current` (reference-framework semantics).
      if (current) {
        const idx = pages.indexOf(current);
        if (idx >= 0 && idx + 1 < pages.length) {
          return pages[idx + 1]! as PageLike;
        }
        const notCurrent = pages.find((p) => p !== current);
        if (notCurrent) return notCurrent as PageLike;
      }
      return pages[pages.length - 1]! as PageLike;
    }
    await sleep(100);
  }
  return null;
}

function parsePosInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function registerWindowActions(registry: DslRegistry): void {
  const reg = registry.withCategory('locator-action');

  // I open a new tab
  reg.register(
    /^I open a new tab$/i,
    async (_, scope, page) => {
      const newPage = await (page as PageLike).context().newPage();
      scope.setLocator('pgwen._last_page', () => newPage);
    }
  );

  // I close the current tab
  reg.register(
    /^I close the current tab$/i,
    async (_, _scope, page) => {
      await (page as PageLike).close();
    }
  );

  // I switch to the new tab / last tab
  reg.register(
    /^I switch to the (?:new|last) tab$/i,
    async (_, scope, page) => {
      const ctx = (page as PageLike).context();
      const before = ctx.pages();
      let newPage: PageLike;
      if (before.length > 1) {
        // New tab already exists — take the last one
        newPage = before[before.length - 1]!;
      } else {
        // Wait for Playwright to emit a new page (waitUntil equivalent)
        newPage = await ctx.waitForEvent('page');
      }
      await newPage.bringToFront();
      scope.setLocator('pgwen._last_page', () => newPage);
      routeToPage(page, newPage);
    }
  );

  // I switch to the parent tab
  reg.register(
    /^I switch to the parent tab$/i,
    async (_, scope, page) => {
      const pages = (page as PageLike).context().pages();
      const parentPage = pages[0];
      if (parentPage) {
        await (parentPage as PageLike).bringToFront();
        scope.setLocator('pgwen._last_page', () => parentPage);
        routeToPage(page, parentPage);
      }
    }
  );

  // I switch to the "<name>" tab
  reg.register(
    /^I switch to the "([^"]+)" tab$/i,
    async ([name], scope, page) => {
      const pages = (page as PageLike).context().pages();
      // Find page by title match or stored name
      const stored = scope.getLocator(`pgwen._tab_${name!.trim()}`);
      if (stored) {
        const storedPage = stored() as PageLike;
        await storedPage.bringToFront();
        scope.setLocator('pgwen._last_page', () => storedPage);
        routeToPage(page, storedPage);
        return;
      }
      // Fall back to searching by title
      for (const p of pages) {
        const title = await (p as PageLike).title();
        if (title === name!.trim()) {
          await (p as PageLike).bringToFront();
          scope.setLocator('pgwen._last_page', () => p);
          routeToPage(page, p);
          return;
        }
      }
    }
  );

  // I close the "<name>" tab
  reg.register(
    /^I close the "([^"]+)" tab$/i,
    async ([name], scope) => {
      const stored = scope.getLocator(`pgwen._tab_${name!.trim()}`);
      if (stored) {
        await (stored() as PageLike).close();
      }
    }
  );

  // I start a new browser
  reg.register(
    /^I start a new browser$/i,
    async (_, scope, page) => {
      const newPage = await (page as PageLike).context().newPage();
      scope.setLocator('pgwen._last_page', () => newPage);
    }
  );

  // I close the browser / I close the current browser
  reg.register(
    /^I close the (?:current )?browser$/i,
    async (_, _scope, page) => {
      await (page as PageLike).close();
    }
  );

  // I start a new browser as "<name>"
  reg.register(
    /^I start a new browser as "([^"]+)"$/i,
    async ([name], scope, page) => {
      const newPage = await (page as PageLike).context().newPage();
      scope.setLocator(`pgwen._browser_${name!.trim()}`, () => newPage);
      scope.setLocator('pgwen._last_page', () => newPage);
    }
  );

  // I switch to the "<name>" browser
  reg.register(
    /^I switch to the "([^"]+)" browser$/i,
    async ([name], scope) => {
      const stored = scope.getLocator(`pgwen._browser_${name!.trim()}`);
      if (stored) {
        await (stored() as PageLike).bringToFront();
        scope.setLocator('pgwen._last_page', () => stored() as PageLike);
      }
    }
  );

  // I close the "<name>" browser
  reg.register(
    /^I close the "([^"]+)" browser$/i,
    async ([name], scope) => {
      const stored = scope.getLocator(`pgwen._browser_${name!.trim()}`);
      if (stored) {
        await (stored() as PageLike).close();
      }
    }
  );

  // ── Child / parent window ─────────────────────────────────────────────────
  //   "window" and "tab" are interchangeable: Playwright models both as
  //   entries in BrowserContext.pages(). The regexes below accept either
  //   noun via `(?:window|tab)` so projects that write `child tab` resolve to
  //   the same handler as `child window`.

  // I switch to (the )?child (window|tab)
  //
  // Matches the reference framework's `switchToChild` semantics: switch to
  // the FIRST page AFTER the current one in the context's pages array, NOT
  // the last. Wraps in a waitUntil-style poll that retries until either a
  // child appears or `pgwen.web.wait.seconds` is exhausted — this handles
  // the race where the popup is still allocating when the step fires.
  //
  // Earlier pgwen impls picked `pages[last]` and fell back to
  // `ctx.waitForEvent('page')` if there was only one page. The fallback
  // hung indefinitely whenever the popup opened in the brief window
  // between the click and the switch (no new event to wait for). The new
  // polling approach is event-free and idempotent.
  reg.register(
    /^I switch to (?:the )?child (?:window|tab)$/i,
    async (_, scope, page) => {
      const child = await pollForChild(page, scope);
      if (!child) return;
      await child.bringToFront();
      scope.setLocator('pgwen._last_page', () => child);
      routeToPage(page, child);
    }
  );

  // I switch to the parent (window|tab)  (= first / original page)
  reg.register(
    /^I switch to the parent (?:window|tab)$/i,
    async (_, scope, page) => {
      const pages = (page as PageLike).context().pages();
      const parent = pages[0];
      if (parent) {
        await (parent as PageLike).bringToFront();
        scope.setLocator('pgwen._last_page', () => parent);
        routeToPage(page, parent);
      }
    }
  );

  // I close the child (window|tab)
  reg.register(
    /^I close the child (?:window|tab)$/i,
    async (_, _scope, page) => {
      const pages = (page as PageLike).context().pages();
      const child = pages[pages.length - 1];
      if (child && child !== pages[0]) {
        await (child as PageLike).close();
      }
    }
  );

  // I switch to child (window|tab) <n>  (1-based index)
  reg.register(
    /^I switch to child (?:window|tab) (\d+)$/i,
    async ([indexStr], scope, page) => {
      const index = parseInt(indexStr!, 10);
      const pages = (page as PageLike).context().pages();
      const target = pages[index]; // 1-based: index 1 = pages()[1]
      if (target) {
        await (target as PageLike).bringToFront();
        scope.setLocator('pgwen._last_page', () => target);
        routeToPage(page, target);
      }
    }
  );

  // I switch to tab <n>   /   I switch to window <n>   (0-based numeric occurrence)
  // Page index across the browser context. Index 0 is the first opened page;
  // tabs and windows share the same page array in Playwright so the verb is
  // interchangeable.
  reg.register(
    /^I switch to (?:tab|window) (\d+)$/i,
    async ([indexStr], scope, page) => {
      const index = parseInt(indexStr!, 10);
      const pages = (page as PageLike).context().pages();
      const target = pages[index];
      if (target) {
        await (target as PageLike).bringToFront();
        scope.setLocator('pgwen._last_page', () => target);
        routeToPage(page, target);
      }
    }
  );

  // I start a new browser tab  (alias for I open a new tab)
  reg.register(
    /^I start a new browser tab$/i,
    async (_, scope, page) => {
      const newPage = await (page as PageLike).context().newPage();
      scope.setLocator('pgwen._last_page', () => newPage);
    }
  );

  // I should have <n> open window[s]  — asserts page count in context
  reg.register(
    /^I should have (\d+) open windows?$/i,
    async ([countStr], _scope, page) => {
      const expected = parseInt(countStr!, 10);
      const actual = (page as PageLike).context().pages().length;
      if (actual !== expected) {
        throw new DslAssertionError(
          `Expected ${expected} open window(s) but found ${actual}`
        );
      }
    }
  );

  // I should have <n> open browser[s]  — alias for open windows
  reg.register(
    /^I should have (\d+) open browsers?$/i,
    async ([countStr], _scope, page) => {
      const expected = parseInt(countStr!, 10);
      const actual = (page as PageLike).context().pages().length;
      if (actual !== expected) {
        throw new DslAssertionError(
          `Expected ${expected} open browser(s) but found ${actual}`
        );
      }
    }
  );

  // I have an open browser  — asserts at least one page is open
  reg.register(
    /^I have an open browser$/i,
    async (_, _scope, page) => {
      const count = (page as PageLike).context().pages().length;
      if (count === 0) {
        throw new DslAssertionError('Expected an open browser but none found');
      }
    }
  );

  // I have no open browser  — asserts no pages are open
  reg.register(
    /^I have no open browser$/i,
    async (_, _scope, page) => {
      const count = (page as PageLike).context().pages().length;
      if (count > 0) {
        throw new DslAssertionError(
          `Expected no open browser but found ${count}`
        );
      }
    }
  );

  // I maximize the window / I maximise the window
  reg.register(
    /^I maximi[sz]e the window$/i,
    async (_, _scope, page) => {
      await (page as PageLike).setViewportSize({ width: 1920, height: 1080 });
    }
  );

  // I resize the window to width <w> and height <h>
  reg.register(
    /^I resize the window to width (\d+) and height (\d+)$/i,
    async ([widthStr, heightStr], _scope, page) => {
      const width = parseInt(widthStr!, 10);
      const height = parseInt(heightStr!, 10);
      await (page as PageLike).setViewportSize({ width, height });
    }
  );

  // I set the window position to x <x> and y <y>
  // Playwright cannot move the OS-level window from the DOM/CDP surface in a
  // cross-browser way (it's a chromium-only feature via DevTools `Browser.
  // setWindowBounds`). For non-chromium browsers this is a graceful no-op.
  reg.register(
    /^I set the window position to x (-?\d+) and y (-?\d+)$/i,
    async ([xStr, yStr], _scope, page) => {
      const x = parseInt(xStr!, 10);
      const y = parseInt(yStr!, 10);
      try {
        // Cast through any — Playwright's window-position control is only
        // available on Chromium-family browsers via the Browser CDP session,
        // and the typed surface doesn't expose it cross-browser.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (page as any).context?.();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const browser = ctx?.browser?.();
        if (!browser) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newSession = (browser as any).newBrowserCDPSession?.bind(browser);
        if (typeof newSession !== 'function') return;
        const session = await newSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left: x, top: y },
        });
        await session.detach();
      } catch {
        // Non-chromium or restricted environment — silently skip.
      }
    }
  );

  // I send "<keys>"  — window-level send (no target element); sends through
  // Playwright's keyboard.press, which dispatches at the page level.
  reg.register(
    /^I send "([^"]+)"$/i,
    async ([keys], _scope, page) => {
      const p = page as PageLike & { keyboard: { press(s: string): Promise<void> } };
      await p.keyboard.press(keys!);
    }
  );
}
