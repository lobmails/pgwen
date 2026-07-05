/**
 * playwright/console.ts — Browser console capture and assertion steps.
 *
 * Playwright fires `page.on('console', msg)` for each browser console message.
 * pgwen captures all messages in scope and provides assertion steps.
 *
 * Supported patterns:
 *   I capture console output
 *   I clear console output
 *
 * Assertion patterns:
 *   the console should[ not] contain "<message>"
 *   the console should[ not] contain errors
 *   the console should[ not] contain warnings
 *   the console output should[ not] be empty
 */

import type { DslRegistry } from '../registry';
import type { PageLike } from '../locatorUtils';
import { DslAssertionError } from '../locatorUtils';

const SCOPE_CONSOLE_LOG  = 'pgwen.console.log';   // JSON array of message strings
const SCOPE_CONSOLE_ERRS = 'pgwen.console.errors'; // JSON array of error strings
const SCOPE_CONSOLE_WARN = 'pgwen.console.warnings';

export function registerConsoleCapture(registry: DslRegistry): void {

  // I capture console output — registers a page.on('console') listener
  registry.register(
    /^I capture console output$/i,
    async (_, scope, page) => {
      // Reset accumulated messages
      scope.set(SCOPE_CONSOLE_LOG, '[]');
      scope.set(SCOPE_CONSOLE_ERRS, '[]');
      scope.set(SCOPE_CONSOLE_WARN, '[]');

      (page as PageLike).on('console', (msg: { type(): string; text(): string }) => {
        const text = msg.text();
        const type = msg.type();

        const allLog = JSON.parse(scope.get(SCOPE_CONSOLE_LOG) ?? '[]') as string[];
        allLog.push(text);
        scope.set(SCOPE_CONSOLE_LOG, JSON.stringify(allLog));

        if (type === 'error') {
          const errs = JSON.parse(scope.get(SCOPE_CONSOLE_ERRS) ?? '[]') as string[];
          errs.push(text);
          scope.set(SCOPE_CONSOLE_ERRS, JSON.stringify(errs));
        }
        if (type === 'warning') {
          const warns = JSON.parse(scope.get(SCOPE_CONSOLE_WARN) ?? '[]') as string[];
          warns.push(text);
          scope.set(SCOPE_CONSOLE_WARN, JSON.stringify(warns));
        }
      });
    }
  );

  // I clear console output
  registry.register(
    /^I clear console output$/i,
    async (_, scope) => {
      scope.set(SCOPE_CONSOLE_LOG, '[]');
      scope.set(SCOPE_CONSOLE_ERRS, '[]');
      scope.set(SCOPE_CONSOLE_WARN, '[]');
    }
  );

  // ─── Assertions ───────────────────────────────────────────────────────────

  // the console should[ not] contain "<message>"
  registry.register(
    /^the console should (not )?contain "([^"]*)"$/i,
    async ([notStr, message], scope) => {
      const negate = !!notStr;
      const log = JSON.parse(scope.get(SCOPE_CONSOLE_LOG) ?? '[]') as string[];
      const found = log.some(m => m.includes(message!));
      if (negate ? found : !found) {
        throw new DslAssertionError(
          `Expected console to ${negate ? 'not ' : ''}contain "${message}"`
        );
      }
    }
  );

  // the console should[ not] contain errors
  registry.register(
    /^the console should (not )?contain errors$/i,
    async ([notStr], scope) => {
      const negate = !!notStr;
      const errs = JSON.parse(scope.get(SCOPE_CONSOLE_ERRS) ?? '[]') as string[];
      const hasErrors = errs.length > 0;
      if (negate ? hasErrors : !hasErrors) {
        throw new DslAssertionError(
          `Expected console to ${negate ? 'not ' : ''}contain errors (found ${errs.length})`
        );
      }
    }
  );

  // the console should[ not] contain warnings
  registry.register(
    /^the console should (not )?contain warnings$/i,
    async ([notStr], scope) => {
      const negate = !!notStr;
      const warns = JSON.parse(scope.get(SCOPE_CONSOLE_WARN) ?? '[]') as string[];
      const hasWarns = warns.length > 0;
      if (negate ? hasWarns : !hasWarns) {
        throw new DslAssertionError(
          `Expected console to ${negate ? 'not ' : ''}contain warnings (found ${warns.length})`
        );
      }
    }
  );

  // the console output should[ not] be empty
  registry.register(
    /^the console output should (not )?be empty$/i,
    async ([notStr], scope) => {
      const negate = !!notStr;
      const log = JSON.parse(scope.get(SCOPE_CONSOLE_LOG) ?? '[]') as string[];
      const isEmpty = log.length === 0;
      if (negate ? isEmpty : !isEmpty) {
        throw new DslAssertionError(
          `Expected console output to ${negate ? 'not ' : ''}be empty (${log.length} messages found)`
        );
      }
    }
  );
}
