/**
 * PageReady.ts — internal page-readiness wait that supplements Playwright.
 *
 * Why this exists: Playwright's auto-wait covers element-interaction
 * actionability (visible / stable / enabled), but it does NOT cover the
 * gap between page-level operations:
 *   - A `<name> is defined by js "..."` predicate evaluates whatever
 *     `document` looks like at that instant. If the page has not finished
 *     loading, the predicate may return a vacuous false / undefined and
 *     the surrounding assertion can pass for the wrong reason.
 *   - After a click that triggers navigation, the next non-locator step
 *     (e.g. another `is defined by js`) can fire before the new document
 *     is parsed.
 *
 * This module fills the gap with an internal FluentWait-style poll on
 * `document.readyState === "complete"` after every navigation and before
 * every page-evaluating action. It is intentionally opt-out-able
 * (default ON) and reads its knobs from scope so projects can tune the
 * timeout / jquery branch / waitFor strategy without code changes.
 *
 * Pure-ish: the function operates on a minimal page-shape (just the
 * `waitForLoadState` + `waitForFunction` methods) and silently swallows
 * timeouts via `.catch(() => {})` — a page that genuinely never settles
 * (e.g. long-polling WebSocket) does not deadlock the run.
 */

import type { Scope } from './Scope';

/** Minimal page surface this module needs — keeps it engine-pure. */
export interface PageReadyTarget {
  waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    opts?: { timeout?: number },
  ): Promise<void>;
  waitForFunction(fn: string, opts?: { timeout?: number }): Promise<unknown>;
}

export type PageReadyState =
  /** Wait until Playwright's `load` event fires. Default. */
  | 'load'
  /** Wait until the DOM is parsed. Skip waiting for sub-resources. */
  | 'domcontentloaded'
  /** Wait until no network activity for 500ms. Risky on long-polling apps. */
  | 'networkidle'
  /** Skip the Playwright load-state call; only poll `document.readyState`. */
  | 'readystate';

export interface PageReadyOpts {
  enabled: boolean;
  waitFor: PageReadyState;
  /** Per-call timeout. Failure is swallowed; the run continues. */
  timeoutMs: number;
  /**
   * When true, also poll for `window.jQuery.active === 0` if jQuery is
   * detected on the page. Catches the "AJAX request still in flight"
   * case Playwright's auto-wait does not cover.
   */
  jquery: boolean;
}

export const DEFAULT_PAGE_READY_OPTS: PageReadyOpts = {
  enabled: true,
  waitFor: 'load',
  timeoutMs: 5000,
  jquery: true,
};

/**
 * Wait until the page is ready. Silently passes on timeout — the page
 * is allowed to be slow; we only block up to `timeoutMs`.
 *
 * No-op when `opts.enabled === false`. The opt-out path returns a
 * resolved promise immediately so the call site can be sprinkled
 * everywhere without adding measurable overhead to runs that opt out.
 */
export async function waitForPageReady(
  page: PageReadyTarget | Partial<PageReadyTarget> | null | undefined,
  opts: PageReadyOpts,
): Promise<void> {
  if (!opts.enabled) return;
  // No page (dry-run, REPL prelude, mocked binding eval) → no-op.
  if (page == null) return;

  // 1) Playwright load-state wait, unless caller asked for readystate-only.
  // Defensive: a mock or stripped page that lacks the method is a no-op,
  // not a crash. Same for waitForFunction below.
  if (opts.waitFor !== 'readystate' && typeof page.waitForLoadState === 'function') {
    await page
      .waitForLoadState(opts.waitFor, { timeout: opts.timeoutMs })
      .catch(() => {});
  }

  if (typeof page.waitForFunction === 'function') {
    // 2) document.readyState poll — always (catches SPA route changes the
    //    Playwright load event doesn't re-fire for).
    await page
      .waitForFunction(`document.readyState === 'complete'`, { timeout: opts.timeoutMs })
      .catch(() => {});

    // 3) jQuery quiet check, when configured.
    if (opts.jquery) {
      await page
        .waitForFunction(
          `typeof window.jQuery === 'undefined' || window.jQuery.active === 0`,
          { timeout: opts.timeoutMs },
        )
        .catch(() => {});
    }
  }
}

/**
 * Resolve PageReadyOpts from a Scope. Projects configure via:
 *
 *   pgwen.web.pageReady.enabled    = true|false       (default true)
 *   pgwen.web.pageReady.waitFor    = "load"|"domcontentloaded"|"networkidle"|"readystate"  (default "load")
 *   pgwen.web.pageReady.timeoutMs  = <number>         (default 5000)
 *   pgwen.web.pageReady.jquery     = true|false       (default true)
 *
 * Unknown / malformed values fall back to the defaults — a bad config
 * never breaks a run.
 */
export function pageReadyOptsFromScope(scope: Scope): PageReadyOpts {
  const enabled = parseBool(scope.get('pgwen.web.pageReady.enabled'), DEFAULT_PAGE_READY_OPTS.enabled);
  const waitFor = parseWaitFor(scope.get('pgwen.web.pageReady.waitFor'));
  const timeoutMs = parsePosInt(
    scope.get('pgwen.web.pageReady.timeoutMs'),
    DEFAULT_PAGE_READY_OPTS.timeoutMs,
  );
  const jquery = parseBool(scope.get('pgwen.web.pageReady.jquery'), DEFAULT_PAGE_READY_OPTS.jquery);
  return { enabled, waitFor, timeoutMs, jquery };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase().trim();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function parsePosInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseWaitFor(raw: string | undefined): PageReadyState {
  if (raw === undefined) return DEFAULT_PAGE_READY_OPTS.waitFor;
  const v = raw.toLowerCase().trim();
  if (v === 'load' || v === 'domcontentloaded' || v === 'networkidle' || v === 'readystate') {
    return v;
  }
  return DEFAULT_PAGE_READY_OPTS.waitFor;
}
