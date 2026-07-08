/**
 * playwright/har.ts — HAR (HTTP Archive) record and replay DSL steps.
 *
 * Playwright-exclusive DSL (no WebDriver-style/equivalent).
 *
 * Registers these step patterns:
 *   I replay requests from HAR file "<path>"
 *   I replay requests from HAR file "<path>" falling back to network
 *   I replay requests matching "<urlPattern>" from HAR file "<path>"
 *
 * Replay routes matching network requests through a pre-recorded HAR file,
 * enabling offline test execution and deterministic responses.
 *
 * `notFound: 'abort'` (default) — unmatched requests fail immediately.
 * `notFound: 'fallback'` — unmatched requests are passed through to the network.
 *
 * Usage in .meta files:
 *   Given I replay requests from HAR file "fixtures/account-search.har"
 *   Given I replay requests matching "api.example.com" from HAR file "api.har"
 *   Given I replay requests from HAR file "fixtures/login.har" falling back to network
 *
 * The HAR file path is resolved relative to the working directory, or may be an
 * absolute path. Create HAR files by running Playwright with `--update-snapshots`
 * or via `page.routeFromHAR` with `update: true`.
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerHarActions(registry: DslRegistry): void {

  // I replay requests matching "<urlPattern>" from HAR file "<path>"
  // Registered before the unconditional variant (first-match wins).
  registry.register(
    /^I replay requests matching "([^"]+)" from HAR file "([^"]+)"$/i,
    async ([urlPattern, filePath], _scope, page) => {
      await (page as PageLike).routeFromHAR(filePath!, {
        url: urlPattern!,
        notFound: 'abort',
      });
    }
  );

  // I replay requests from HAR file "<path>" falling back to network
  registry.register(
    /^I replay requests from HAR file "([^"]+)" falling back to network$/i,
    async ([filePath], _scope, page) => {
      await (page as PageLike).routeFromHAR(filePath!, { notFound: 'fallback' });
    }
  );

  // I replay requests from HAR file "<path>"
  registry.register(
    /^I replay requests from HAR file "([^"]+)"$/i,
    async ([filePath], _scope, page) => {
      await (page as PageLike).routeFromHAR(filePath!, { notFound: 'abort' });
    }
  );
}
