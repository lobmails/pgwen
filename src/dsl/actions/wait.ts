/**
 * actions/wait.ts — Wait / sleep steps.
 *
 *   I wait <n> second[s]
 *   I wait <n> millisecond[s]
 *   I wait until <element> is <state>
 *   I wait until <element> is <state> for <n> second[s]
 *   I wait until "<javascript>" is true
 *   I wait until "<javascript>" is true for <n> second[s]
 *   I wait for <element>               — waits for element to be visible (standard behaviour)
 *   I wait for <element> text          — waits for element to have non-empty text
 *   I wait for the alert popup         — waits for a browser dialog to appear
 *   I wait for the confirmation popup  — waits for a browser dialog to appear
 *
 * Element states: displayed, hidden, enabled, disabled, checked, unchecked,
 *                 visible, clickable, present / exists
 */

import type { DslRegistry } from '../registry';
import { resolveLocator, DslStepError, type PageLike } from '../locatorUtils';

export function registerWaits(registry: DslRegistry): void {
  const reg = registry.withCategory('wait');

  // I wait <n> second[s]
  reg.register(
    /^I wait (\d+(?:\.\d+)?) seconds?$/i,
    async ([nStr], _scope, page) => {
      const ms = parseFloat(nStr!) * 1000;
      await (page as PageLike).waitForTimeout(ms);
    }
  );

  // I wait <n> millisecond[s]
  reg.register(
    /^I wait (\d+(?:\.\d+)?) milliseconds?$/i,
    async ([nStr], _scope, page) => {
      const ms = parseFloat(nStr!);
      await (page as PageLike).waitForTimeout(ms);
    }
  );

  // I wait until <element> is <state> for <n> second[s]   (with timeout)
  reg.register(
    /^I wait until (.+) is (displayed|hidden|enabled|disabled|checked|unchecked|ticked|unticked|visible|clickable|present|exist(?:s)?) for (\d+(?:\.\d+)?) seconds?$/i,
    async ([elementName, state, nStr], scope) => {
      const timeout = parseFloat(nStr!) * 1000;
      await waitForState(elementName!, state!, scope, timeout);
    }
  );

  // I wait until <element> is <state>   (default timeout from Playwright)
  reg.register(
    /^I wait until (.+) is (displayed|hidden|enabled|disabled|checked|unchecked|ticked|unticked|visible|clickable|present|exist(?:s)?)$/i,
    async ([elementName, state], scope) => {
      await waitForState(elementName!, state!, scope);
    }
  );

  // I wait until "<javascript>" is true for <n> second[s]
  reg.register(
    /^I wait until "(.+)" is true for (\d+(?:\.\d+)?) seconds?$/i,
    async ([script, nStr], _scope, page) => {
      const timeout = parseFloat(nStr!) * 1000;
      await (page as PageLike).waitForFunction(script!, { timeout });
    }
  );

  // I wait until "<javascript>" is true
  reg.register(
    /^I wait until "(.+)" is true$/i,
    async ([script], _scope, page) => {
      await (page as PageLike).waitForFunction(script!);
    }
  );

  // I wait until "<javascript>"   (short form — no "is true" suffix)
  // projects use this form: @Timeout('60s') I wait until "$('#el').is(':visible')"
  reg.register(
    /^I wait until "(.+)"$/i,
    async ([script], _scope, page) => {
      await (page as PageLike).waitForFunction(script!);
    }
  );

  // I wait for the alert popup  /  I wait for the confirmation popup
  // Standard behaviour: polls until a browser dialog is dispatched.
  // Uses page.waitForEvent('dialog') which resolves when the dialog fires.
  reg.register(
    /^I wait for the (?:alert|confirmation) popup$/i,
    async (_, _scope, page) => {
      await (page as PageLike).waitForEvent('dialog');
    }
  );

  // I wait for <element> text
  // Standard behaviour: waits until the element has non-empty inner text.
  // Must be registered BEFORE the bare "I wait for <element>" to avoid the
  // greedy element pattern consuming the trailing " text" word.
  reg.register(
    /^I wait for (.+) text$/i,
    async ([elementName], scope, page) => {
      const loc = await resolveLocator(elementName!.trim(), scope);
      await waitUntil(async () => {
        const text = await loc.innerText().catch(() => '');
        return text.trim().length > 0;
      }, 30_000);
    }
  );

  // I wait for <element>
  // Standard behaviour: waits for the element to become visible — equivalent to
  // "I wait until <element> is displayed" but without a required state keyword.
  // This form is heavily used in real projects: "I wait for the add note button".
  reg.register(
    /^I wait for (.+)$/i,
    async ([elementName], scope) => {
      await waitForState(elementName!.trim(), 'displayed', scope);
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForState(
  elementName: string,
  state: string,
  scope: Parameters<typeof resolveLocator>[1],
  timeoutMs?: number
): Promise<void> {
  const loc = await resolveLocator(elementName.trim(), scope);
  const opts = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;

  switch (state.toLowerCase()) {
    case 'displayed':
    case 'visible':
      return loc.waitFor({ state: 'visible', ...opts });

    case 'hidden':
      return loc.waitFor({ state: 'hidden', ...opts });

    case 'present':
    case 'exists':
    case 'exist':
      return loc.waitFor({ state: 'attached', ...opts });

    case 'enabled':
      // Poll until enabled
      await waitUntil(async () => loc.isEnabled(), timeoutMs ?? 30_000);
      break;

    case 'disabled':
      await waitUntil(async () => loc.isDisabled(), timeoutMs ?? 30_000);
      break;

    case 'checked':
    case 'ticked':
      await waitUntil(async () => loc.isChecked(), timeoutMs ?? 30_000);
      break;

    case 'unchecked':
    case 'unticked':
      await waitUntil(async () => {
        const checked = await loc.isChecked();
        return !checked;
      }, timeoutMs ?? 30_000);
      break;

    case 'clickable':
      // Visible + enabled
      await waitUntil(async () => {
        const [vis, en] = await Promise.all([loc.isVisible(), loc.isEnabled()]);
        return vis && en;
      }, timeoutMs ?? 30_000);
      break;

    default:
      throw new DslStepError(`Unknown wait state: "${state}"`);
  }
}

/** Poll condition every 500ms until true or timeout (ms). */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new DslStepError(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}
