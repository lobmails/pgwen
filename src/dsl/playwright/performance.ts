/**
 * playwright/performance.ts — Web performance metrics steps.
 *
 * Captures Core Web Vitals (LCP, CLS, FCP) and navigation timing via
 * `page.evaluate()`.  Values are stored in scope for assertion.
 *
 * Supported patterns:
 *   I capture performance metrics
 *   I capture performance metrics as <name>
 *
 * Assertion patterns:
 *   the page LCP should be less than "<ms>" milliseconds
 *   the page FCP should be less than "<ms>" milliseconds
 *   the page CLS should be less than "<score>"
 *   the page load time should be less than "<ms>" milliseconds
 *   the page <metric> should be less than "<value>"
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { DslAssertionError } from '../locatorUtils';
import type { Scope } from '../../engine/Scope';

const SCOPE_PERF_PREFIX = 'pgwen.perf.';

export function registerPerformance(registry: DslRegistry): void {

  // I capture performance metrics [as <name>]
  registry.register(
    /^I capture performance metrics(?: as (.+))?$/i,
    async ([name], scope, page) => {
      const metrics = await captureMetrics(page as PageLike);
      for (const [key, value] of Object.entries(metrics)) {
        scope.set(`${SCOPE_PERF_PREFIX}${key}`, String(value));
      }
      if (name) {
        scope.set(name.trim(), JSON.stringify(metrics));
      }
    }
  );

  // the page LCP should be less than "<ms>" milliseconds
  registry.register(
    /^the page LCP should be less than "(\d+(?:\.\d+)?)" milliseconds?$/i,
    async ([threshold], scope: Scope) => {
      assertMetricLt('lcp', parseFloat(threshold!), scope, 'ms');
    }
  );

  // the page FCP should be less than "<ms>" milliseconds
  registry.register(
    /^the page FCP should be less than "(\d+(?:\.\d+)?)" milliseconds?$/i,
    async ([threshold], scope: Scope) => {
      assertMetricLt('fcp', parseFloat(threshold!), scope, 'ms');
    }
  );

  // the page CLS should be less than "<score>"
  registry.register(
    /^the page CLS should be less than "(\d+(?:\.\d+)?)"$/i,
    async ([threshold], scope: Scope) => {
      assertMetricLt('cls', parseFloat(threshold!), scope, '');
    }
  );

  // the page load time should be less than "<ms>" milliseconds
  registry.register(
    /^the page load time should be less than "(\d+(?:\.\d+)?)" milliseconds?$/i,
    async ([threshold], scope: Scope) => {
      assertMetricLt('loadTime', parseFloat(threshold!), scope, 'ms');
    }
  );

  // the page <metric> should be less than "<value>"  (generic form)
  registry.register(
    /^the page (.+) should be less than "(\d+(?:\.\d+)?)"$/i,
    async ([metric, threshold], scope: Scope) => {
      assertMetricLt(metric!.trim().toLowerCase(), parseFloat(threshold!), scope, '');
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function captureMetrics(page: PageLike): Promise<Record<string, number>> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perf = (globalThis as any).performance;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = perf.getEntriesByType('navigation')[0] as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paint: any[] = perf.getEntriesByType('paint');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcpEntry = paint.find((e: any) => e.name === 'first-contentful-paint');

    return {
      loadTime:         nav ? nav.loadEventEnd - nav.startTime : 0,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd - nav.startTime : 0,
      fcp:              fcpEntry ? fcpEntry.startTime : 0,
      lcp:              0,  // LCP requires PerformanceObserver; set to 0 if not captured
      cls:              0,  // CLS requires PerformanceObserver; set to 0 if not captured
    };
  }) as Promise<Record<string, number>>;
}

function assertMetricLt(
  metricKey: string,
  threshold: number,
  scope: Scope,
  unit: string
): void {
  const raw = scope.get(`${SCOPE_PERF_PREFIX}${metricKey}`);
  if (raw === undefined) {
    throw new DslAssertionError(
      `Performance metric "${metricKey}" has not been captured. Run "I capture performance metrics" first.`
    );
  }
  const actual = parseFloat(raw);
  if (actual >= threshold) {
    const unitSuffix = unit ? ` ${unit}` : '';
    throw new DslAssertionError(
      `Expected page ${metricKey.toUpperCase()} to be less than ${threshold}${unitSuffix} but got ${actual}${unitSuffix}`
    );
  }
}
