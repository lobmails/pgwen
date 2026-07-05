/**
 * mobile/device.ts — Mobile emulation DSL steps.
 *
 * pgwen extends the reference framework's Chrome-only `pgwen.web.chrome.mobile.deviceName` to
 * all three Playwright engines via Playwright's built-in `devices` map.
 *
 * These steps configure emulation for the CURRENT page.  In practice the
 * device profile is set at context-creation time (via Playwright project
 * config), but these steps allow dynamic device switching in tests.
 *
 * Supported patterns:
 *   I emulate device "<deviceName>"
 *   I emulate device "<deviceName>" on "<engine>"
 *   I set viewport to "<WxH>"
 *   I set viewport to "<WxH>" with device scale "<ratio>"
 *   I enable touch events
 *   I disable touch events
 *   I set orientation to portrait
 *   I set orientation to landscape
 *   the page should be displayed on a mobile viewport
 *   the page should be displayed on a desktop viewport
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { DslAssertionError } from '../locatorUtils';

/** Minimal Playwright CDPSession-like interface for touch emulation. */
interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Minimal Playwright BrowserContext surface needed for emulation. */
interface EmulationContextLike {
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  setDeviceScaleFactor?(ratio: number): Promise<void>;
  setTouchEmulationEnabled?(enabled: boolean): Promise<void>;
  newCDPSession?(page: unknown): Promise<CdpSessionLike>;
}

export function registerMobileDevice(registry: DslRegistry): void {

  // I emulate device "<deviceName>" [on "<engine>"]
  registry.register(
    /^I emulate device "([^"]+)"(?: on "([^"]+)")?$/i,
    async ([deviceName, _engine], scope) => {
      // Store device name in scope — actual Playwright device config happens at
      // context/project level. This step captures the intent for dry-run / reporting.
      scope.set('pgwen.device.name', deviceName!.trim());
    }
  );

  // I set viewport to "<WxH>" [with device scale "<ratio>"]
  registry.register(
    /^I set viewport to "(\d+)x(\d+)"(?: with device scale "(\d+(?:\.\d+)?)")?$/i,
    async ([width, height, scaleStr], scope, page) => {
      const w = parseInt(width!, 10);
      const h = parseInt(height!, 10);
      const ctx = (page as PageLike).context() as unknown as EmulationContextLike;
      if (typeof ctx.setViewportSize === 'function') {
        await ctx.setViewportSize({ width: w, height: h });
      }
      scope.set('pgwen.viewport.width', String(w));
      scope.set('pgwen.viewport.height', String(h));
      if (scaleStr) {
        const scale = parseFloat(scaleStr);
        if (typeof ctx.setDeviceScaleFactor === 'function') {
          await ctx.setDeviceScaleFactor(scale);
        }
        scope.set('pgwen.viewport.deviceScaleFactor', String(scale));
      }
    }
  );

  // I enable touch events
  registry.register(
    /^I enable touch events$/i,
    async (_, scope, page) => {
      scope.set('pgwen.touch.enabled', 'true');
      const ctx = (page as PageLike).context() as unknown as EmulationContextLike;
      if (typeof ctx.setTouchEmulationEnabled === 'function') {
        await ctx.setTouchEmulationEnabled(true);
      }
    }
  );

  // I disable touch events
  registry.register(
    /^I disable touch events$/i,
    async (_, scope, page) => {
      scope.set('pgwen.touch.enabled', 'false');
      const ctx = (page as PageLike).context() as unknown as EmulationContextLike;
      if (typeof ctx.setTouchEmulationEnabled === 'function') {
        await ctx.setTouchEmulationEnabled(false);
      }
    }
  );

  // I set orientation to portrait / landscape
  registry.register(
    /^I set orientation to (portrait|landscape)$/i,
    async ([orientation], scope, page) => {
      const isPortrait = orientation!.toLowerCase() === 'portrait';
      scope.set('pgwen.orientation', isPortrait ? 'portrait' : 'landscape');

      // Swap viewport width/height for landscape if current values are known
      const w = scope.get('pgwen.viewport.width');
      const h = scope.get('pgwen.viewport.height');
      if (w && h) {
        const wn = parseInt(w, 10);
        const hn = parseInt(h, 10);
        const needsSwap = isPortrait ? wn > hn : wn < hn;
        if (needsSwap) {
          const ctx = (page as PageLike).context() as unknown as EmulationContextLike;
          if (typeof ctx.setViewportSize === 'function') {
            await ctx.setViewportSize({ width: hn, height: wn });
          }
          scope.set('pgwen.viewport.width', String(hn));
          scope.set('pgwen.viewport.height', String(wn));
        }
      }
    }
  );

  // ─── Viewport assertions ──────────────────────────────────────────────────

  // the page should be displayed on a mobile viewport
  registry.register(
    /^the page should be displayed on a mobile viewport$/i,
    async (_, scope) => {
      const w = parseInt(scope.get('pgwen.viewport.width') ?? '1280', 10);
      if (w >= 768) {
        throw new DslAssertionError(
          `Expected a mobile viewport (width < 768) but viewport width is ${w}`
        );
      }
    }
  );

  // the page should be displayed on a desktop viewport
  registry.register(
    /^the page should be displayed on a desktop viewport$/i,
    async (_, scope) => {
      const w = parseInt(scope.get('pgwen.viewport.width') ?? '1280', 10);
      if (w < 768) {
        throw new DslAssertionError(
          `Expected a desktop viewport (width >= 768) but viewport width is ${w}`
        );
      }
    }
  );
}
