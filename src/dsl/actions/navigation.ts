/**
 * actions/navigation.ts — Page navigation steps.
 *
 *   I navigate to "<url>"
 *   I navigate to <urlRef>                         [from named binding]
 *   I refresh the current page
 *   I navigate back
 *   I navigate forward
 *
 * Page-load strategy: navigation calls honour the WebDriver-style W3C capability
 * `pgwen.web.capabilities.pageLoadStrategy` (eager | normal | none), read
 * from scope at each step so per-feature overrides via the `my <key> setting
 * is "<value>"` DSL also take effect.
 */

import type { Scope } from '../../engine/Scope';
import type { DslRegistry } from '../registry';
import { resolveLocator, type PageLike } from '../locatorUtils';
import { mapPageLoadStrategyToWaitUntil, type WaitUntilOption } from '../../engine/BrowserConfig';
import { evalCondition } from '../control/conditions';
import { waitForPageReady, pageReadyOptsFromScope } from '../../engine/PageReady';

const MAX_REFRESH_ATTEMPTS = 50;

function navOptions(scope: Scope): { waitUntil: WaitUntilOption } | undefined {
  const strategy = scope.get('pgwen.web.capabilities.pageLoadStrategy');
  const waitUntil = mapPageLoadStrategyToWaitUntil(strategy);
  return waitUntil ? { waitUntil } : undefined;
}

/**
 * Internal: wait until the page is ready after the current navigation
 * has resolved Playwright's load event. Reads opts from scope so a project
 * can disable / tune it via `pgwen.web.pageReady.*` without touching code.
 */
async function settle(scope: Scope, page: PageLike): Promise<void> {
  await waitForPageReady(page, pageReadyOptsFromScope(scope));
}

export function registerNavigation(registry: DslRegistry): void {
  const reg = registry.withCategory('navigation');

  // I navigate to "<url>"
  reg.register(
    /^I navigate to "(.+)"$/i,
    async ([url], scope, page) => {
      const opts = navOptions(scope);
      if (opts) await (page as PageLike).goto(url!, opts);
      else await (page as PageLike).goto(url!);
      await settle(scope, page as PageLike);
    }
  );

  // I navigate to <urlRef>  (resolved via scope interpolation already done by Compositor)
  reg.register(
    /^I navigate to (.+)$/i,
    async ([urlRef], scope, page) => {
      const url = scope.get(urlRef!.trim()) ?? urlRef!.trim();
      const opts = navOptions(scope);
      if (opts) await (page as PageLike).goto(url, opts);
      else await (page as PageLike).goto(url);
      await settle(scope, page as PageLike);
    }
  );

  // I refresh the current page / I reload the page
  reg.register(
    /^I (?:refresh|reload)(?: the current page)?$/i,
    async (_, scope, page) => {
      const opts = navOptions(scope);
      if (opts) await (page as PageLike).reload(opts);
      else await (page as PageLike).reload();
      await settle(scope, page as PageLike);
    }
  );

  // I navigate back / I go back
  reg.register(
    /^I (?:navigate|go) back$/i,
    async (_, scope, page) => {
      const opts = navOptions(scope);
      if (opts) await (page as PageLike).goBack(opts);
      else await (page as PageLike).goBack();
      await settle(scope, page as PageLike);
    }
  );

  // I navigate forward / I go forward
  reg.register(
    /^I (?:navigate|go) forward$/i,
    async (_, scope, page) => {
      const opts = navOptions(scope);
      if (opts) await (page as PageLike).goForward(opts);
      else await (page as PageLike).goForward();
      await settle(scope, page as PageLike);
    }
  );

  // I refresh the current page until <element> is displayed
  // Reloads the page up to MAX_REFRESH_ATTEMPTS times until the named element becomes visible.
  // Registered BEFORE the generic until/while handler so first-match-wins keeps the
  // existing wording and error message intact (and preserves the optional `the ` strip).
  reg.register(
    /^I refresh the current page until (?:the )?(.+) is displayed$/i,
    async ([elementName], scope, page) => {
      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
        try {
          const loc = await resolveLocator(elementName!.trim(), scope);
          if (await loc.isVisible()) return;
        } catch { /* element not yet on page */ }
        await (page as PageLike).reload();
        await settle(scope, page as PageLike);
      }
      // Final check — throw if still not visible after all attempts
      const loc = await resolveLocator(elementName!.trim(), scope);
      if (!await loc.isVisible()) {
        throw new Error(`Element "${elementName}" not displayed after ${MAX_REFRESH_ATTEMPTS} page refreshes`);
      }
    }
  );

  // I refresh the current page until <condition>
  // Generic form — evaluates <condition> via evalCondition. Projects use this for
  // status-polling against scope refs and regex patterns, e.g.
  //   I refresh the current page until the current job status matches regex "Job (finished|cancelled)"
  //   I refresh the current page until batch status concluded
  reg.register(
    /^I refresh the current page until (.+)$/i,
    async ([condition], scope, page) => {
      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
        if (await evalCondition(condition!.trim(), scope, page)) return;
        await (page as PageLike).reload();
        await settle(scope, page as PageLike);
      }
      if (!(await evalCondition(condition!.trim(), scope, page))) {
        throw new Error(`Condition "${condition}" not met after ${MAX_REFRESH_ATTEMPTS} page refreshes`);
      }
    }
  );

  // I refresh the current page while <condition>
  // Loops while the condition is true (i.e. until it becomes false).
  reg.register(
    /^I refresh the current page while (.+)$/i,
    async ([condition], scope, page) => {
      for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
        if (!(await evalCondition(condition!.trim(), scope, page))) return;
        await (page as PageLike).reload();
        await settle(scope, page as PageLike);
      }
      if (await evalCondition(condition!.trim(), scope, page)) {
        throw new Error(`Condition "${condition}" still true after ${MAX_REFRESH_ATTEMPTS} page refreshes`);
      }
    }
  );
}
