/**
 * mobile/touch.ts — Mobile touch-gesture DSL steps.
 *
 * Implements Playwright touch gestures using the Locator.tap() API and
 * page.touchscreen for raw coordinate gestures.
 *
 * Supported patterns:
 *   I tap <element>
 *   I double tap <element>
 *   I swipe <element> "<direction>"       direction: up|down|left|right
 *   I swipe <element> "<direction>" by <pixels> pixels
 *   I pinch <element> to "<scale>"        scale: "in" | "out" | numeric (e.g. "1.5")
 *   I set user agent to "<uaString>"
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { resolveLocator } from '../locatorUtils';

/** Swipe distance in pixels when not explicitly specified. */
const DEFAULT_SWIPE_PX = 200;

export function registerTouchActions(registry: DslRegistry): void {

  // I tap <element>
  registry.register(
    /^I tap (.+)$/i,
    async ([elementName], scope) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await loc.tap();
    }
  );

  // I double tap <element>
  registry.register(
    /^I double tap (.+)$/i,
    async ([elementName], scope, page) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // Simulate double-tap with two sequential taps via touchscreen coordinates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = await (loc as unknown as { boundingBox(): Promise<any> }).boundingBox();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await (page as PageLike).touchscreen.tap(cx, cy);
        await (page as PageLike).touchscreen.tap(cx, cy);
      } else {
        await loc.tap();
        await loc.tap();
      }
    }
  );

  // I swipe <element> "<direction>" [by <pixels> pixels]
  registry.register(
    /^I swipe (.+) "(up|down|left|right)"(?: by (\d+) pixels?)?$/i,
    async ([elementName, direction, pixelsStr], scope, page) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      const dist = pixelsStr ? parseInt(pixelsStr, 10) : DEFAULT_SWIPE_PX;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = await (loc as unknown as { boundingBox(): Promise<any> }).boundingBox();
      if (!box) return;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      let ex = cx, ey = cy;
      switch (direction!.toLowerCase()) {
        case 'up':    ey = cy - dist; break;
        case 'down':  ey = cy + dist; break;
        case 'left':  ex = cx - dist; break;
        case 'right': ex = cx + dist; break;
      }
      // Simulate swipe via touch events dispatched in the browser context
      await (page as PageLike).evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (args: any) => {
          const [sx, sy, dx, dy] = args as [number, number, number, number];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const g = globalThis as any;
          const makeTouch = (id: number, x: number, y: number) =>
            new g.Touch({ identifier: id, target: g.document.body, clientX: x, clientY: y });
          g.document.body.dispatchEvent(
            new g.TouchEvent('touchstart', {
              bubbles: true, cancelable: true,
              touches: [makeTouch(1, sx, sy)],
            })
          );
          g.document.body.dispatchEvent(
            new g.TouchEvent('touchend', {
              bubbles: true, cancelable: true,
              changedTouches: [makeTouch(1, dx, dy)],
            })
          );
        },
        [cx, cy, ex, ey]
      );
    }
  );

  // I pinch <element> to "<scale>"    scale = "in" | "out" | numeric (e.g. "1.5")
  registry.register(
    /^I pinch (.+) to "(in|out|\d+(?:\.\d+)?)"$/i,
    async ([elementName, scale], scope, page) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = await (loc as unknown as { boundingBox(): Promise<any> }).boundingBox();
      if (!box) return;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const scaleVal = scale === 'in' ? 1.5 : scale === 'out' ? 0.5 : parseFloat(scale!);
      await (page as PageLike).evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (args: any) => {
          const [x, y, s] = args as [number, number, number];
          const offset = 50;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const g = globalThis as any;
          const el = g.document.elementFromPoint(x, y) ?? g.document.body;
          const makeTouch = (id: number, px: number, py: number) =>
            new g.Touch({ identifier: id, target: el, clientX: px, clientY: py });
          g.document.dispatchEvent(
            new g.TouchEvent('touchstart', {
              bubbles: true,
              touches: [makeTouch(1, x - offset, y), makeTouch(2, x + offset, y)],
            })
          );
          g.document.dispatchEvent(
            new g.TouchEvent('touchmove', {
              bubbles: true,
              touches: [makeTouch(1, x - offset * s, y), makeTouch(2, x + offset * s, y)],
            })
          );
          g.document.dispatchEvent(
            new g.TouchEvent('touchend', { bubbles: true, touches: [] })
          );
        },
        [cx, cy, scaleVal]
      );
    }
  );

  // I set user agent to "<uaString>"
  registry.register(
    /^I set user agent to "([^"]+)"$/i,
    async ([uaString], scope, page) => {
      scope.set('pgwen.user.agent', uaString!.trim());
      await (page as PageLike).setExtraHTTPHeaders({ 'user-agent': uaString!.trim() });
    }
  );
}
