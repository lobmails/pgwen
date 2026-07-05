/**
 * actions/alerts.ts — Browser dialog / alert / confirm / prompt steps.
 *
 * Playwright dialogs are handled via `page.once('dialog', handler)`.
 * pgwen registers a one-shot listener that:
 *  1. Captures the dialog message in scope under `pgwen._dialog_message`
 *  2. Sets `pgwen._dialog_shown` to `"true"`
 *  3. Accepts or dismisses as requested
 *
 * Both "alert" and "confirmation" dialog types are supported — in Playwright
 * both go through the same 'dialog' event with different dialog.type() values.
 *
 * Supported action patterns:
 *   I accept the alert
 *   I accept the confirmation
 *   I dismiss the alert
 *   I dismiss the confirmation
 *   I enter "<text>" in the alert
 *   I capture the alert popup message [as <name>]
 *   I capture the confirmation popup message [as <name>]
 *
 * Supported assertion patterns:
 *   the alert popup should[ not] be displayed
 *   the confirmation popup should[ not] be displayed
 *   the alert message should[ not] be/contain "<expression>"
 *   the alert popup message should[ not] be/contain "<expression>"
 *   the confirmation popup message should[ not] be/contain "<expression>"
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { DslAssertionError, assertText } from '../locatorUtils';
import { getQueue } from './DialogManager';
import { matchesFormat, type FormatKind } from '../formatting/formatMatch';

export function registerAlertActions(registry: DslRegistry): void {
  const reg = registry.withCategory('locator-action');

  // ─── Actions ──────────────────────────────────────────────────────────────

  // I accept the alert  /  I accept the confirmation
  reg.register(
    /^I accept the (?:alert|confirmation)(?: popup)?$/i,
    async (_, scope, page) => {
      const queue = getQueue(page as object);
      if (queue) {
        // Queue model: works whether dialog fires before or after this step
        const msg = await queue.accept();
        scope.set('pgwen._dialog_message', msg);
        scope.set('pgwen._dialog_shown', 'true');
      } else {
        // Fallback: dry-run or page not yet initialised — no-op
        (page as PageLike).once?.('dialog', () => undefined);
      }
    }
  );

  // I dismiss the alert  /  I dismiss the confirmation
  reg.register(
    /^I dismiss the (?:alert|confirmation)(?: popup)?$/i,
    async (_, scope, page) => {
      const queue = getQueue(page as object);
      if (queue) {
        const msg = await queue.dismiss();
        scope.set('pgwen._dialog_message', msg);
        scope.set('pgwen._dialog_shown', 'true');
      } else {
        (page as PageLike).once?.('dialog', () => undefined);
      }
    }
  );

  // I enter "<text>" in the alert  /  I type "<text>" in the alert
  reg.register(
    /^I (?:enter|type) "([^"]+)" in the (?:alert|confirmation)(?: popup)?$/i,
    async ([text], scope, page) => {
      const queue = getQueue(page as object);
      if (queue) {
        const msg = await queue.accept(text!);
        scope.set('pgwen._dialog_message', msg);
        scope.set('pgwen._dialog_shown', 'true');
      } else {
        (page as PageLike).once?.('dialog', () => undefined);
      }
    }
  );

  // I capture the alert popup message [as <name>]
  // I capture the confirmation popup message [as <name>]
  reg.register(
    /^I capture the (?:alert|confirmation) popup message(?: as (.+))?$/i,
    async ([nameStr], scope, page) => {
      const targetName = nameStr?.trim() ?? 'pgwen._dialog_message';
      // Prefer queue's last message (handles post-trigger capture without explicit accept)
      const queue = getQueue(page as object);
      const msg = queue?.lastDialogMessage ?? scope.get('pgwen._dialog_message') ?? '';
      scope.set(targetName, msg);
    }
  );

  // ─── Assertions ───────────────────────────────────────────────────────────

  // the alert popup should[ not] be displayed
  // the confirmation popup should[ not] be displayed
  reg.register(
    /^the (?:alert|confirmation) popup should (not )?be displayed$/i,
    async ([notStr], scope, page) => {
      const negate = !!notStr;
      const queue = getQueue(page as object);
      const shown = queue?.wasShown ?? scope.get('pgwen._dialog_shown') === 'true';
      if (negate ? shown : !shown) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected dialog popup to ${notWord}be displayed`);
      }
    }
  );

  // the alert message should[ not] be/contain "<expression>"
  // the alert popup message should[ not] be/contain "<expression>"
  // the confirmation popup message should[ not] be/contain "<expression>"
  reg.register(
    /^the (?:alert|confirmation)(?: popup)? message should (not )?(be|contain) "([^"]*)"$/i,
    async ([notStr, op, expected], scope, page) => {
      const negate = !!notStr;
      const queue = getQueue(page as object);
      const actual = queue?.lastDialogMessage ?? scope.get('pgwen._dialog_message') ?? '';
      assertText(actual, op === 'contain' ? 'contain' : 'be', expected!, negate, '"dialog message"');
    }
  );

  // Format pattern matching on dialog message text — same shape as the
  // rest of the should-match-format DSL surface.
  //   the (alert|confirmation)( popup)? message should[ not] match (datetime|number) format "<p>"
  reg.register(
    /^the (?:alert|confirmation)(?: popup)? message should (not )?match (datetime|number) format "([^"]*)"$/i,
    async ([notStr, kindStr, pattern], scope, page) => {
      const negate = !!notStr;
      const kind = kindStr!.toLowerCase() as FormatKind;
      const queue = getQueue(page as object);
      const actual = queue?.lastDialogMessage ?? scope.get('pgwen._dialog_message') ?? '';
      const matches = matchesFormat(kind, actual, pattern!);
      if (negate ? matches : !matches) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected the popup message to ${notWord}match ${kind} format "${pattern}" (actual: "${actual}")`
        );
      }
    }
  );
}
