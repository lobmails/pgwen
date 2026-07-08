/**
 * control/conditions.ts — Condition evaluator for inline if-guards.
 *
 * `<step> if <condition>` and `<step> if <condition> otherwise <alt>` are
 * handled by the Compositor BEFORE DSL resolution (see Compositor.ts →
 * parseIfGuard / executeOneStep). This prevents action DSL patterns such as
 * `^I click (.+)$` from consuming the guard suffix and mis-resolving it as a
 * locator name.
 *
 * This module exports only `evalCondition` — no DSL patterns are registered.
 *
 * `<condition>` evaluation rules (in priority order):
 *   • `not <condition>`                    — negation of any other condition form
 *   • `"<javascript>"`                     — page.evaluate; truthy → true
 *   • `<name> is [not] defined`           — scope binding presence check
 *   • `<name> is [not] blank`             — undefined OR whitespace-only string
 *   • `<name> is [not] empty`             — undefined OR empty string (no trim)
 *   • `<name> is "<value>"`               — scope-value equality
 *   • `env.VAR_NAME is "<value>"`         — environment variable comparison
 *   • `<name> matches regex "<pattern>"`  — scope-value regex match
 *   • `<element> is [not] <state>`        — element-state check
 *                                            false when element has no locator → skips step
 *   • bare scope name                      — scope.get(condition) → isTruthy(value)
 *   • bare string fallback                 — isTruthy(condition) handles post-interpolation
 *                                           values like 'true', 'false', 'yes', 'no', '1', '0'
 *
 * Element states:
 *   displayed / visible  → isVisible()
 *   hidden               → isHidden()
 *   enabled              → isEnabled()
 *   disabled             → isDisabled()
 *   checked / ticked     → isChecked()
 *   unchecked / unticked → !isChecked()
 */

import type { DslRegistry } from '../registry';
import type { Scope } from '../../engine/Scope';
import type { PageLike } from '../locatorUtils';
import { resolveLocator } from '../locatorUtils';
import { matchesFormat as formatMatchHelper } from '../formatting/formatMatch';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerConditions(_registry: DslRegistry): void {
  // No DSL patterns to register — if-guard parsing is handled by Compositor.
  // This function is kept for API compatibility with dsl/index.ts.
}

// ─── Condition evaluator (shared logic — keep in sync with foreach.ts) ──────

export async function evalCondition(
  condition: string,
  scope: Scope,
  page: unknown
): Promise<boolean> {
  // Negation: "not <condition>" — recursive inversion
  const notMatch = /^not (.+)$/i.exec(condition);
  if (notMatch) {
    return !(await evalCondition(notMatch[1]!.trim(), scope, page));
  }

  // JS expression: whole string wrapped in double quotes
  const jsMatch = /^"([^"]+)"$/.exec(condition);
  if (jsMatch) {
    const result = await (page as PageLike).evaluate(jsMatch[1]!);
    return Boolean(result);
  }

  // Presence / shape checks:
  //   <name> is [not] defined  /  blank  /  empty
  // Order: BEFORE the `is "<value>"` equality check so the bare keyword form
  // matches first. `env.VAR_NAME` prefix is honoured so authors can ask
  // `env.PGWEN_RETRY is defined` etc.
  const presenceMatch = /^(.+) is (not )?(defined|blank|empty)$/i.exec(condition);
  if (presenceMatch) {
    const condKey = presenceMatch[1]!.trim();
    const negated = !!presenceMatch[2];
    const keyword = presenceMatch[3]!.toLowerCase();
    const isEnv = condKey.startsWith('env.');
    const rawValue = isEnv
      ? process.env[condKey.slice(4)]
      : scope.get(condKey);

    let result: boolean;
    switch (keyword) {
      case 'defined':
        result = rawValue !== undefined && rawValue !== null;
        break;
      case 'blank':
        result = rawValue === undefined || rawValue === null || rawValue.trim() === '';
        break;
      case 'empty':
        result = rawValue === undefined || rawValue === null || rawValue === '';
        break;
      default:
        result = false;
    }
    return negated ? !result : result;
  }

  // Contains: <name> [does not ]contain[s] "<substring>"
  // Used by projects that branch on filename / process / message substring, e.g.
  //   I parse the add campaign file name if FileName contains "add"
  //   I click the delete button if the process contains "remove"
  // env.VAR_NAME prefix is honoured the same way as `is "<value>"`.
  const containsMatch = /^(.+?) (does not contain|contains?|do not contain) "([^"]*)"$/i.exec(condition);
  if (containsMatch) {
    const condKey = containsMatch[1]!.trim();
    const op = containsMatch[2]!.toLowerCase();
    const needle = containsMatch[3]!;
    const lhs = await resolveLhs(scope, condKey);
    const hit = lhs.includes(needle);
    return op.startsWith('does not') || op.startsWith('do not') ? !hit : hit;
  }

  // Regex match: <name> matches regex "<pattern>"
  // Used by project refresh-loops to poll for a final status pattern, e.g.
  //   I refresh the current page until the current job status matches regex "Job (finished|was cancelled)"
  const regexMatch = /^(.+) matches regex "(.+)"$/i.exec(condition);
  if (regexMatch) {
    const condKey = regexMatch[1]!.trim();
    const lhs = await resolveLhs(scope, condKey);
    try {
      return new RegExp(regexMatch[2]!).test(lhs);
    } catch {
      return false;
    }
  }

  // Tab / window count guards:
  //   <step> if there is 1 open (tab|window)
  //   <step> if there are <count> open (tab|window)s
  // Returns true when the browser context holds the expected page count.
  // Used by projects that branch on "did a new tab open?" without writing an
  // ad-hoc JS guard.
  const tabCountSingularMatch = /^there is 1 open (tab|window)$/i.exec(condition);
  if (tabCountSingularMatch && page) {
    const pages = ((page as unknown as { context(): { pages(): unknown[] } })
      .context().pages()) ?? [];
    return pages.length === 1;
  }
  const tabCountPluralMatch = /^there are (\d+) open (?:tab|window)s$/i.exec(condition);
  if (tabCountPluralMatch && page) {
    const expected = parseInt(tabCountPluralMatch[1]!, 10);
    const pages = ((page as unknown as { context(): { pages(): unknown[] } })
      .context().pages()) ?? [];
    return pages.length === expected;
  }

  // Format pattern match:
  //   <name> matches datetime format "<pattern>"
  //   <name> matches number format "<pattern>"
  //   <name> does not match datetime format "<pattern>"
  //   <name> does not match number format "<pattern>"
  // Used by all three guard surfaces (if / while / until). Layered on the
  // shared `matchesFormat` helper in src/dsl/formatting/formatMatch.ts.
  const formatMatchExec =
    /^(.+) (matches|does not match) (datetime|number) format "([^"]*)"$/i.exec(condition);
  if (formatMatchExec) {
    const condKey = formatMatchExec[1]!.trim();
    const op = formatMatchExec[2]!.toLowerCase();
    const kind = formatMatchExec[3]!.toLowerCase() as 'datetime' | 'number';
    const pattern = formatMatchExec[4]!;
    const lhs = await resolveLhs(scope, condKey);
    const matches = formatMatchHelper(kind, lhs, pattern);
    return op === 'does not match' ? !matches : matches;
  }

  // Element state: <element> is [not] <state>
  // Supports the full state vocabulary: displayed/visible/hidden/enabled/disabled/
  // checked/ticked/unchecked/unticked. Returns false when element has no locator binding
  // (element not declared) — condition false → step skipped, no error thrown.
  // MUST be matched BEFORE the bare-token equality below so state keywords
  // ("visible", "ticked", …) don't get captured as literal RHS.
  const stateMatch = /^(.+) is (not )?(displayed|visible|hidden|enabled|disabled|checked|ticked|unchecked|unticked)$/i.exec(condition);
  if (stateMatch) {
    const elementName = stateMatch[1]!.trim();
    const negated = !!stateMatch[2];
    const state = stateMatch[3]!.toLowerCase();
    try {
      const loc = await resolveLocator(elementName, scope);
      let result: boolean;
      switch (state) {
        case 'displayed':
        case 'visible':    result = await loc.isVisible();  break;
        case 'hidden':     result = await loc.isHidden();   break;
        case 'enabled':    result = await loc.isEnabled();  break;
        case 'disabled':   result = await loc.isDisabled(); break;
        case 'checked':
        case 'ticked':     result = await loc.isChecked();  break;
        case 'unchecked':
        case 'unticked':   result = !(await loc.isChecked()); break;
        default:           result = false;
      }
      return negated ? !result : result;
    } catch {
      // No locator binding or Playwright error → condition false → step skipped
      return false;
    }
  }

  // Scope equality: <name> is [not] "<value>"  or  <name> is [not] <bare-token>
  // treats quoted and unquoted literals as equivalent — `x is "true"` and
  // `x is true` both mean "scope value of x equals the literal 'true'".
  // Positioned AFTER presenceMatch / stateMatch / contains / regex / format
  // checks so reserved keyword RHS values (defined, visible, …) don't get
  // captured as literal RHS — those have their own dedicated handlers above.
  // Also supports env.VAR_NAME prefix to compare against process environment variables.
  // Example: env.PGWEN_ENV is "prod"  (used by projects for conditional NewRelic logging)
  const eqMatch = /^(.+?) is (not )?(?:"([^"]*)"|(\S+))$/i.exec(condition);
  if (eqMatch) {
    const condKey = eqMatch[1]!.trim();
    const negated = !!eqMatch[2];
    const rhs = eqMatch[3] !== undefined ? eqMatch[3] : eqMatch[4]!;
    const lhs = await resolveLhs(scope, condKey);
    const equal = lhs === rhs;
    return negated ? !equal : equal;
  }

  // Scope lookup by name: bare binding name → resolve and check truthiness
  const scopeValue = await resolveOrUndefined(scope, condition);
  if (scopeValue !== undefined) {
    return isTruthy(scopeValue);
  }

  // Fallback: treat the condition text itself as a truthy/falsy value.
  // Handles post-interpolation cases where ${ref} was replaced with 'true'/'false'.
  return isTruthy(condition);
}

function isTruthy(val: string): boolean {
  const lower = val.toLowerCase().trim();
  return lower !== 'false' && lower !== 'no' && lower !== '0' && lower !== '';
}

/**
 * Resolve a condition's LHS to a string. Handles `env.VAR_NAME` and async
 * lazy bindings. Returns '' when nothing is bound — matches the prior sync
 * `(scope.get(key) ?? '')` contract.
 *
 * Tries sync `scope.get()` first so callers that mock the sync surface keep
 * working; only escalates to `resolveAsync` when scope reports an async
 * lazy (the case introduced by `is defined by js` bindings).
 */
async function resolveLhs(scope: Scope, key: string): Promise<string> {
  if (key.startsWith('env.')) return process.env[key.slice(4)] ?? '';
  try {
    return scope.get(key) ?? '';
  } catch (e) {
    if (e instanceof Error && e.message.includes('async lazy resolver')) {
      return (await scope.resolveAsync(key)) ?? '';
    }
    throw e;
  }
}

/**
 * Same as `resolveLhs` but returns undefined (not '') when the binding does
 * not exist. Used for the bare-name fallback where existence matters.
 */
async function resolveOrUndefined(scope: Scope, key: string): Promise<string | undefined> {
  if (key.startsWith('env.')) return process.env[key.slice(4)];
  try {
    return scope.get(key);
  } catch (e) {
    if (e instanceof Error && e.message.includes('async lazy resolver')) {
      return scope.resolveAsync(key);
    }
    throw e;
  }
}
