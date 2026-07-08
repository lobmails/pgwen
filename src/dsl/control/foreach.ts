/**
 * control/foreach.ts — ForEach / until / while control-structure steps.
 *
 * These patterns embed a sub-step in the step text itself and repeat it.
 * The `run` StepRunner (4th HandlerFn argument) executes the sub-step
 * against the same registry and scope as the containing step.
 *
 * Pattern registration order is critical — more-specific patterns must be
 * registered BEFORE generic ones to win on overlapping input.
 *
 * Supported patterns (in registration order, most-specific first):
 *
 *   <step> until <condition> delay <n> second[s]
 *   <step> while <condition> delay <n> second[s]
 *   <step> until <condition> for each <item> in <list>
 *   <step> while <condition> for each <item> in <list>
 *   <step> until <condition>
 *   <step> while <condition>
 *   <step> for each <element> located by <selectorType> "<expr>" in <container>  — DOM iteration with container
 *   <step> for each <element> located by <selectorType> "<expression>"          — DOM element iteration
 *   <step> for each <item> in <list> delimited by "<delimiter>" if <cond>
 *   <step> for each <item> in <list> delimited by "<delimiter>"
 *   <step> for each <item> in <list> if <cond>
 *   <step> for each <item> in <list>            ← registered last (most generic)
 *   <step> for each <entry> in <arrayRef> array
 *   <step> for each <row> in <tableRef> table
 *
 * `<condition>` can be:
 *   • `"<javascript>"` — evaluates JS on the page; truthy → condition met
 *   • `<name> is "<value>"` — scope-value equality check
 *   • `<element> is <state>` — element-state check (visible/hidden/etc.)
 *
 * The iteration counter `pgwen.iteration.number` is maintained in scope.
 * Semantics:
 *   until  — run step, then check; stop when condition is TRUE (do-while style)
 *   while  — check first; stop when condition is FALSE (pre-condition style)
 */

import type { DslRegistry, StepRunner } from '../registry';
import type { Scope } from '../../engine/Scope';
import type { PageLike, LocatorLike } from '../locatorUtils';
import { resolveLocator, buildLocator, jqueryToPlaywright } from '../locatorUtils';

const MAX_ITERATIONS = 1000; // safety cap

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerForEach(registry: DslRegistry): void {

  // ── Delay variants (most specific — register first) ───────────────────────

  // <step> until <condition> delay <n> second[s]
  registry.register(
    /^(.+?) until (.+?) delay (\d+) seconds?$/i,
    async ([subStep, condition, delayStr], scope, page, run) => {
      const delayMs = parseInt(delayStr!, 10) * 1000;
      await runUntil(subStep!.trim(), condition!.trim(), scope, page, run, delayMs, false);
    }
  );

  // <step> while <condition> delay <n> second[s]
  registry.register(
    /^(.+?) while (.+?) delay (\d+) seconds?$/i,
    async ([subStep, condition, delayStr], scope, page, run) => {
      const delayMs = parseInt(delayStr!, 10) * 1000;
      await runUntil(subStep!.trim(), condition!.trim(), scope, page, run, delayMs, true);
    }
  );

  // ── for-each with condition (second most specific) ────────────────────────

  // <step> until <condition> for each <item> in <list>
  registry.register(
    /^(.+?) until (.+?) for each (.+?) in (.+)$/i,
    async ([subStep, condition, itemName, listRef], scope, page, run) => {
      const items = parseList(scope.get(listRef!.trim()) ?? listRef!.trim());
      let iteration = 0;
      for (const item of items) {
        iteration++;
        scope.set(itemName!.trim(), item);
        scope.set('pgwen.iteration.number', String(iteration));
        scope.set('pgwen.iteration.index', String(iteration - 1));
        await run(subStep!.trim(), page);
        if (await evalCondition(condition!.trim(), scope, page)) break;
      }
    }
  );

  // <step> while <condition> for each <item> in <list>
  registry.register(
    /^(.+?) while (.+?) for each (.+?) in (.+)$/i,
    async ([subStep, condition, itemName, listRef], scope, page, run) => {
      const items = parseList(scope.get(listRef!.trim()) ?? listRef!.trim());
      let iteration = 0;
      for (const item of items) {
        if (!await evalCondition(condition!.trim(), scope, page)) break;
        iteration++;
        scope.set(itemName!.trim(), item);
        scope.set('pgwen.iteration.number', String(iteration));
        scope.set('pgwen.iteration.index', String(iteration - 1));
        await run(subStep!.trim(), page);
      }
    }
  );

  // ── Plain until / while ───────────────────────────────────────────────────

  // <step> until <condition>
  registry.register(
    /^(.+?) until (.+)$/i,
    async ([subStep, condition], scope, page, run) => {
      await runUntil(subStep!.trim(), condition!.trim(), scope, page, run, 0, false);
    }
  );

  // <step> while <condition>
  registry.register(
    /^(.+?) while (.+)$/i,
    async ([subStep, condition], scope, page, run) => {
      await runUntil(subStep!.trim(), condition!.trim(), scope, page, run, 0, true);
    }
  );

  // ── ForEach web element (register before generic list iteration) ─────────

  const SELECTOR_TYPES = 'id|name|tag name|tag|css selector|css|xpath|class name|class|link text|partial link text|javascript|js';

  // <step> for each <element> located by <selectorType> "<expression>" in <container>
  registry.register(
    new RegExp(`^(.+?) for each (.+?) located by (${SELECTOR_TYPES}) "([^"]+)" in (.+)$`, 'i'),
    async ([subStep, elementName, selectorType, expression, containerName], scope, page, run) => {
      const containerLoc = await resolveLocator(containerName!.trim(), scope);
      const locator = buildLocatorFromContainer(containerLoc, selectorType!, expression!);
      await forEachElement(subStep!, elementName!, locator, scope, page, run);
    }
  );

  // <step> for each <element> located by <selectorType> "<expression>"
  registry.register(
    new RegExp(`^(.+?) for each (.+?) located by (${SELECTOR_TYPES}) "([^"]+)"$`, 'i'),
    async ([subStep, elementName, selectorType, expression], scope, page, run) => {
      const locator = buildLocator(page, selectorType!, expression!);
      await forEachElement(subStep!, elementName!, locator, scope, page, run);
    }
  );

  // ── for each with delimiter (register before plain for-each) ─────────────

  // <step> for each <item> in <list> delimited by "<delimiter>" if <condition>
  registry.register(
    /^(.+?) for each (.+?) in (.+?) delimited by "([^"]*)" if (.+)$/i,
    async ([subStep, itemName, listRef, delimiter, condition], scope, page, run) => {
      if (!await evalCondition(condition!.trim(), scope, page)) return;
      const rawList = scope.get(listRef!.trim()) ?? listRef!.trim();
      const items = parseListDelimited(rawList, delimiter!);
      let iteration = 0;
      for (const item of items) {
        iteration++;
        scope.set(itemName!.trim(), item);
        scope.set('pgwen.iteration.number', String(iteration));
        scope.set('pgwen.iteration.index', String(iteration - 1));
        await run(subStep!.trim(), page);
      }
    }
  );

  // <step> for each <item> in <list> delimited by "<delimiter>"
  registry.register(
    /^(.+?) for each (.+?) in (.+?) delimited by "([^"]*)"$/i,
    async ([subStep, itemName, listRef, delimiter], scope, page, run) => {
      const rawList = scope.get(listRef!.trim()) ?? listRef!.trim();
      const items = parseListDelimited(rawList, delimiter!);
      let iteration = 0;
      for (const item of items) {
        iteration++;
        scope.set(itemName!.trim(), item);
        scope.set('pgwen.iteration.number', String(iteration));
        scope.set('pgwen.iteration.index', String(iteration - 1));
        await run(subStep!.trim(), page);
      }
    }
  );

  // <step> for each <item> in <list> if <condition>
  registry.register(
    /^(.+?) for each (.+?) in (.+?) if (.+)$/i,
    async ([subStep, itemName, listRef, condition], scope, page, run) => {
      if (!await evalCondition(condition!.trim(), scope, page)) return;
      const rawList = scope.get(listRef!.trim()) ?? listRef!.trim();
      const items = parseList(rawList);
      let iteration = 0;
      for (const item of items) {
        iteration++;
        scope.set(itemName!.trim(), item);
        scope.set('pgwen.iteration.number', String(iteration));
        scope.set('pgwen.iteration.index', String(iteration - 1));
        await run(subStep!.trim(), page);
      }
    }
  );

  // ── Plain for each (most generic — register last) ─────────────────────────

  // <step> for each <item> in <list>
  // <step> for each <entry> in <arrayRef> array
  // <step> for each <row> in <tableRef> table
  registry.register(
    /^(.+?) for each (.+?) in (.+?)(?:\s+(?:array|table))?$/i,
    async ([subStep, itemName, listRef], scope, page, run) => {
      const rawList = scope.get(listRef!.trim()) ?? listRef!.trim();
      const items = parseList(rawList);
      let iteration = 0;
      for (const item of items) {
        iteration++;
        scope.set(itemName!.trim(), item);
        scope.set('pgwen.iteration.number', String(iteration));
        scope.set('pgwen.iteration.index', String(iteration - 1));
        await run(subStep!.trim(), page);
      }
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a list value from scope.  Accepts:
 *   - JSON array string: `["a","b","c"]`
 *   - Comma-separated: `a,b,c`
 */
function parseList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
  }
  return trimmed.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Parse a list value using an explicit delimiter string.
 * Each item is trimmed but empty items are kept (delimiter may be multi-char).
 */
function parseListDelimited(raw: string, delimiter: string): string[] {
  if (!delimiter) return parseList(raw);
  return raw.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Execute `subStep` repeatedly until/while `condition` is satisfied.
 *
 * `isWhile=false` (until): run step first, then check condition → stop when true.
 * `isWhile=true`  (while): check condition first → stop when false; then run step.
 */
async function runUntil(
  subStep: string,
  condition: string,
  scope: Scope,
  page: unknown,
  run: StepRunner,
  delayMs: number,
  isWhile: boolean
): Promise<void> {
  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    // while-semantics: check condition before running
    if (isWhile) {
      const condMet = await evalCondition(condition, scope, page);
      if (!condMet) break;
    }

    iteration++;
    scope.set('pgwen.iteration.number', String(iteration));
    scope.set('pgwen.iteration.index', String(iteration - 1));
    await run(subStep, page);
    if (delayMs > 0) await (page as PageLike).waitForTimeout(delayMs);

    // until-semantics: check condition after running
    if (!isWhile) {
      const condMet = await evalCondition(condition, scope, page);
      if (condMet) break;
    }
  }
}

/**
 * Evaluate a condition expression.  Returns `true` when the condition is satisfied.
 *
 * Supported forms (in priority order):
 *   `not <condition>`       → negation of any other form
 *   `"<js expression>"`     → evaluate JS on page, truthy → true
 *   `<name> is "<value>"`   → scope equality check
 *   `<element> is <state>`  → element-state check (visible/hidden/etc.)
 *   bare scope name         → scope.get(name) → isTruthy(value)
 *   bare string fallback    → isTruthy(condition) for post-interpolation values
 */
async function evalCondition(
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

  // Presence / shape checks (vocabulary):
  //   <name> is [not] defined / blank / empty
  // Must come BEFORE the equality check so the bare-keyword forms match first.
  // env.VAR_NAME prefix is honoured.
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

  // Element state: <element> is <state>
  // MUST be matched BEFORE the bare-token equality below so state keywords
  // ("visible", "checked", …) don't get captured as literal RHS.
  const stateMatch = /^(.+) is (visible|hidden|enabled|disabled|checked)$/i.exec(condition);
  if (stateMatch) {
    try {
      const loc = await resolveLocator(stateMatch[1]!.trim(), scope);
      switch (stateMatch[2]!.toLowerCase()) {
        case 'visible':  return loc.isVisible();
        case 'hidden':   return loc.isHidden();
        case 'enabled':  return loc.isEnabled();
        case 'disabled': return loc.isDisabled();
        case 'checked':  return loc.isChecked();
      }
    } catch {
      return false;
    }
  }

  // Scope equality: <name> is [not] "<value>"  or  <name> is [not] <bare-token>
  // treats quoted and unquoted literals as equivalent — `x is "true"` and
  // `x is true` both mean "scope value of x equals the literal 'true'". Mirror
  // of the same handler in dsl/control/conditions.ts; the two must stay in
  // sync (while/until/for-each guards reuse this evaluator).
  // Also supports env.VAR_NAME prefix to compare against process environment variables.
  const eqMatch = /^(.+?) is (not )?(?:"([^"]*)"|(\S+))$/i.exec(condition);
  if (eqMatch) {
    const condKey = eqMatch[1]!.trim();
    const negated = !!eqMatch[2];
    const rhs = eqMatch[3] !== undefined ? eqMatch[3] : eqMatch[4]!;
    const lhs = condKey.startsWith('env.')
      ? (process.env[condKey.slice(4)] ?? '')
      : (scope.get(condKey) ?? '');
    const equal = lhs === rhs;
    return negated ? !equal : equal;
  }

  // Scope lookup by name: bare binding name → resolve and check truthiness
  const scopeValue = scope.get(condition);
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
 * Build a child locator scoped to a container locator.
 * Used for `for each <element> located by <type> "<expr>" in <container>`.
 */
function buildLocatorFromContainer(container: LocatorLike, selectorType: string, expression: string): LocatorLike {
  const type = selectorType.trim().toLowerCase();
  switch (type) {
    case 'id':           return container.locator(`[id="${expression}"]`);
    case 'name':         return container.locator(`[name="${expression}"]`);
    case 'tag name':
    case 'tag':          return container.locator(expression);
    case 'css selector':
    case 'css':          return container.locator(expression);
    case 'xpath':        return container.locator(`xpath=${expression}`);
    case 'class name':
    case 'class':        return container.locator(expression.startsWith('.') ? expression : `.${expression}`);
    case 'link text':    return container.locator(`a:has-text("${expression}")`);
    case 'partial link text': return container.locator(`a:has-text("${expression}")`);
    case 'javascript':
    case 'js':           return container.locator(jqueryToPlaywright(expression));
    default:             return container.locator(expression);
  }
}

/**
 * Iterate over all elements matched by `locator`, bind each as a named scope
 * locator, and run `subStep` for each.
 */
async function forEachElement(
  subStep: string,
  elementName: string,
  locator: LocatorLike,
  scope: Scope,
  page: unknown,
  run: StepRunner
): Promise<void> {
  const elements = await locator.all();
  let iteration = 0;
  for (const el of elements) {
    iteration++;
    scope.set('pgwen.iteration.number', String(iteration));
    scope.set('pgwen.iteration.index', String(iteration - 1));
    // Bind the element name as a locator so sub-steps can reference it by name
    const captured = el;
    scope.setLocator(elementName.trim(), async () => captured);
    await run(subStep.trim(), page);
  }
}
