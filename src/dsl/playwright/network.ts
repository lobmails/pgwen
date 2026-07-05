/**
 * playwright/network.ts — Network interception and routing steps.
 *
 * Uses Playwright's `context.route()` API to intercept, mock, abort, or
 * modify HTTP requests.  No WebDriver-style equivalent.
 *
 * Supported patterns:
 *   I intercept requests to "<urlPattern>" with status "<n>" and body "<body>"
 *   I intercept requests to "<urlPattern>" with status "<n>" and body from file "<file>"
 *   I intercept requests to "<urlPattern>" and abort them
 *   I intercept requests to "<urlPattern>" and add header "<name>" with value "<value>"
 *   I clear network interception for "<urlPattern>"
 *   I clear all network interceptions
 *
 * Assertions:
 *   the last intercepted request url should[ not] be "<expression>"
 *   the last intercepted request method should[ not] be "<method>"
 */

import { readFileSync } from 'fs';
import type { DslRegistry } from '../registry';
import type { PageLike, RouteLike } from '../locatorUtils';
import { DslAssertionError, assertText } from '../locatorUtils';

export function registerNetworkInterception(registry: DslRegistry): void {

  // I intercept requests to "<urlPattern>" with status "<n>" and body from file "<file>"
  // Must be registered before the plain body version (first match wins).
  registry.register(
    /^I intercept requests to "([^"]+)" with status "(\d+)" and body from file "([^"]+)"$/i,
    async ([urlPattern, status, file], scope, page) => {
      const body = readFileSync(file!, 'utf-8');
      const statusCode = parseInt(status!, 10);
      await (page as PageLike).context().route(urlPattern!, async (route: RouteLike) => {
        scope.set('pgwen.last.intercepted.url', route.request().url());
        scope.set('pgwen.last.intercepted.method', route.request().method());
        await route.fulfill({ status: statusCode, body, contentType: 'application/json' });
      });
    }
  );

  // I intercept requests to "<urlPattern>" with status "<n>" and body "<body>"
  registry.register(
    /^I intercept requests to "([^"]+)" with status "(\d+)" and body "([^"]*)"$/i,
    async ([urlPattern, status, body], scope, page) => {
      const statusCode = parseInt(status!, 10);
      await (page as PageLike).context().route(urlPattern!, async (route: RouteLike) => {
        scope.set('pgwen.last.intercepted.url', route.request().url());
        scope.set('pgwen.last.intercepted.method', route.request().method());
        await route.fulfill({ status: statusCode, body: body ?? '' });
      });
    }
  );

  // I intercept requests to "<urlPattern>" and abort them
  registry.register(
    /^I intercept requests to "([^"]+)" and abort them$/i,
    async ([urlPattern], scope, page) => {
      await (page as PageLike).context().route(urlPattern!, async (route: RouteLike) => {
        scope.set('pgwen.last.intercepted.url', route.request().url());
        scope.set('pgwen.last.intercepted.method', route.request().method());
        await route.abort();
      });
    }
  );

  // I intercept requests to "<urlPattern>" and add header "<name>" with value "<value>"
  registry.register(
    /^I intercept requests to "([^"]+)" and add header "([^"]+)" with value "([^"]*)"$/i,
    async ([urlPattern, headerName, headerValue], scope, page) => {
      await (page as PageLike).context().route(urlPattern!, async (route: RouteLike) => {
        scope.set('pgwen.last.intercepted.url', route.request().url());
        scope.set('pgwen.last.intercepted.method', route.request().method());
        const existing = route.request().headers();
        await route.continue({ headers: { ...existing, [headerName!]: headerValue! } });
      });
    }
  );

  // I clear network interception for "<urlPattern>"
  registry.register(
    /^I clear network interception for "([^"]+)"$/i,
    async ([urlPattern], _scope, page) => {
      await (page as PageLike).context().unroute(urlPattern!);
    }
  );

  // I clear all network interceptions
  registry.register(
    /^I clear all network interceptions$/i,
    async (_, _scope, page) => {
      await (page as PageLike).context().unroute('**');
    }
  );

  // ─── Assertions ───────────────────────────────────────────────────────────

  // the last intercepted request url should[ not] be "<expression>"
  // the last intercepted request url should[ not] contain "<expression>"
  registry.register(
    /^the last intercepted request url should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = scope.get('pgwen.last.intercepted.url') ?? '';
      assertText(actual, op as import('../locatorUtils').CompareOp, expected!, negate, '"last intercepted request url"');
    }
  );

  // the last intercepted request method should[ not] be "<method>"
  registry.register(
    /^the last intercepted request method should (not )?be "([^"]*)"$/i,
    async ([notStr, expected], scope) => {
      const negate = !!notStr;
      const actual = scope.get('pgwen.last.intercepted.method') ?? '';
      if (negate ? actual === expected : actual !== expected) {
        throw new DslAssertionError(
          `Expected last intercepted request method to ${negate ? 'not ' : ''}be "${expected}" but got "${actual}"`
        );
      }
    }
  );
}
