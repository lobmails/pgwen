/**
 * actions/frames.ts — iframe / frame switching steps.
 *
 * Playwright uses FrameLocator (page.frameLocator(selector)) to scope
 * subsequent locator calls to a specific frame.  pgwen stores the active
 * FrameLocatorLike in scope under the key `pgwen._active_frame`.  Locator
 * bindings (locators.ts) check this key at resolution time so that all
 * elements are automatically scoped through the current frame.
 *
 * Supported patterns:
 *   I switch to child frame
 *   I switch to the child frame
 *   I switch to child frame <index>
 *   I switch to frame "<name>"
 *   I switch to the frame "<name>"
 *   I switch to the parent frame
 *   I switch to the default content
 *   I switch to the main frame
 */

import type { DslRegistry } from '../registry';
import type { PageLike, FrameLocatorLike } from '../locatorUtils';

export function registerFrameActions(registry: DslRegistry): void {
  const reg = registry.withCategory('locator-action');

  // I switch to child frame [<index>]
  // Note: the lazy-page proxy makes `page.frameLocator(selector)` async, so we
  // must await before chaining `.nth(index)`. If a previous `I switch to ...`
  // step bound `pgwen._active_frame`, we resolve relative to that frame so
  // the substep navigates one level deeper (nested iframe).
  reg.register(
    /^I switch to (?:the )?child frame(?: (\d+))?$/i,
    async ([indexStr], scope, page) => {
      const index = indexStr ? parseInt(indexStr, 10) : 0;
      const parentFrameFn = scope.getLocator('pgwen._active_frame');
      let frameLocator: FrameLocatorLike;
      if (parentFrameFn) {
        const parent = await parentFrameFn() as FrameLocatorLike;
        frameLocator = parent.frameLocator('iframe').nth(index) as unknown as FrameLocatorLike;
      } else {
        const base = await (page as PageLike).frameLocator('iframe');
        frameLocator = (base as FrameLocatorLike).nth(index) as unknown as FrameLocatorLike;
      }
      scope.setLocator('pgwen._active_frame', () => frameLocator);
    }
  );

  // I switch to frame "<name>" / I switch to the frame "<name>"
  reg.register(
    /^I switch to (?:the )?frame "([^"]+)"$/i,
    async ([name], scope, page) => {
      const selector = `iframe[name="${name!}"],iframe[id="${name!}"],iframe[title="${name!}"]`;
      const frameLocator = await (page as PageLike).frameLocator(selector) as unknown as FrameLocatorLike;
      scope.setLocator('pgwen._active_frame', () => frameLocator);
    }
  );

  // I switch to <frame> content   (no-quote form — frame reference is a
  //   binding or literal token treated as the iframe name/id/title)
  // Excludes "default" and "main" so the parent-frame pattern below still matches.
  reg.register(
    /^I switch to (?!(?:the )?(?:default|main|parent) )(.+) content$/i,
    async ([rawName], scope, page) => {
      const name = rawName!.replace(/^the /i, '').trim();
      const resolved = scope.get(name) ?? name;
      const selector = `iframe[name="${resolved}"],iframe[id="${resolved}"],iframe[title="${resolved}"]`;
      const frameLocator = await (page as PageLike).frameLocator(selector) as unknown as FrameLocatorLike;
      scope.setLocator('pgwen._active_frame', () => frameLocator);
    }
  );

  // I switch to the parent frame / default content / main frame
  reg.register(
    /^I switch to (?:the )?(?:parent frame|default content|main frame)$/i,
    async (_, scope) => {
      // Remove the active frame — subsequent lookups go straight to page
      scope.setLocator('pgwen._active_frame', () => undefined);
    }
  );
}
