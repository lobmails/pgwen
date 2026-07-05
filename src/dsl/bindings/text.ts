/**
 * bindings/text.ts — Text and value binding steps.
 *
 * Implements the reference framework binding DSL patterns that assign values to named bindings in scope:
 *   <name> is "<value>"                            — literal string binding
 *   <name> is blank                                — bind to empty string
 *   <name> is empty                               — bind to empty string (alias)
 *   <name> is true                                — bind to the string "true"
 *   <name> is false                               — bind to the string "false"
 *   <name> is defined by javascript "<script>"     — lazy JS-evaluated binding
 *   <name> is defined by <ref> applied to "<arg>"  — JS ref applied to argument
 *   <name> is defined by <ref> applied to <element> — JS ref evaluated against element (arguments[0])
 *   <name> is defined in the file "<filepath>"     — file content binding
 *   <name> is defined in <ref> by regex "<pattern>"               — regex extract group 1
 *   <name> is defined by extracting <group> from <ref> by regex "<pattern>"
 *   <name> is defined by json path "<path>" in <ref>
 *   <name> is defined by xpath "<expression>" in <ref>
 *   <name> is defined by system process "<command>"
 *   <name> is defined by unix system process "<command>"
 *   <setting> setting is "<value>"                 — settings override
 *
 * NOTE: date/number formatting patterns (<name> is formatted as ...) are registered
 * by formatting/DateTimeFormatter.ts and formatting/NumberFormatter.ts, NOT here.
 */

import * as fs from 'fs';
import type { DslRegistry } from '../registry';
import type { Scope } from '../../engine/Scope';
import { resolveLocator, type PageLike } from '../locatorUtils';
import { waitForPageReady, pageReadyOptsFromScope } from '../../engine/PageReady';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerTextBindings(registry: DslRegistry): void {

  // <setting> setting is "<value>"  — runtime settings override (MUST be before generic "is")
  // Settings overrides use setTransparent so they persist out of StepDef scope.
  registry.register(
    /^(.+) setting is "([^"]*)"$/,
    async ([settingName, value], scope) => {
      scope.setTransparent(settingName!.trim(), value!);
      scope.setTransparent(`settings.${settingName!.trim()}`, value!);
    }
  );

  // <name> is "<value>"  — literal binding (transparent: survives stepdef scope.pop())
  registry.register(
    /^(.+) is "([^"]*)"$/,
    async ([name, value], scope) => {
      scope.setTransparent(name!.trim(), value!);
    }
  );

  // <name> is blank / <name> is empty  — bind to empty string
  registry.register(
    /^(.+) is (?:blank|empty)$/i,
    async ([name], scope) => {
      scope.setTransparent(name!.trim(), '');
    }
  );

  // <name> is true  — bind to the string "true"
  registry.register(
    /^(.+) is true$/i,
    async ([name], scope) => {
      scope.setTransparent(name!.trim(), 'true');
    }
  );

  // <name> is false  — bind to the string "false"
  registry.register(
    /^(.+) is false$/i,
    async ([name], scope) => {
      scope.setTransparent(name!.trim(), 'false');
    }
  );

  // <name> is defined by javascript "<script>"  — lazy JS evaluation (transparent)
  // Also stores <name>/javascript = "<script>" as a literal (the reference framework behaviour — visible in env).
  // Uses [\s\S]+ so multi-line scripts (from paste-mode """" blocks) are matched.
  registry.register(
    /^(.+) is defined by (?:javascript|js) "([\s\S]+)"$/i,
    async ([name, script], scope, page) => {
      const trimmedName = name!.trim();
      // Store JS source expression (shows in env as name/javascript : "expr").
      // Use setTransparent so this survives stepDef scope pop when called in a StepDef body.
      scope.setTransparent(`${trimmedName}/javascript`, script!);
      // Set up lazy evaluation: actual value resolved on demand / via @Eager.
      // Standard behaviour: if the script is a function expression (arrow fn or `function`
      // keyword), auto-invoke it so `() => { return 'x'; }` returns 'x' not the fn.
      const capturedPage = page as PageLike;
      const capturedScript = script!;
      const capturedScope = scope;
      scope.setLazyTransparent(trimmedName, async () => {
        // Dry-run / no-browser path: nothing to evaluate against. Return empty
        // so downstream interpolation doesn't NPE; the framework's
        // "async lazy resolver" diagnostic already surfaces the warning.
        if (capturedPage == null || typeof (capturedPage as PageLike).evaluate !== 'function') return '';
        // NB: we used to also short-circuit when `page.isClosed()` returned
        // true, but that incorrectly matched pre-navigation page state for
        // some Playwright setups. The `isBrowserClosedError` catch around
        // page.evaluate below is sufficient to absorb genuine post-close
        // lazy fires without masking pre-navigation evaluations (which
        // page.evaluate handles fine on about:blank).
        // Page-ready guard — closes the vacuous-pass loophole where a JS
        // predicate evaluates against a half-loaded page and returns a
        // misleading value. Cheap on already-ready pages, configurable via
        // pgwen.web.pageReady.*.
        await waitForPageReady(capturedPage, pageReadyOptsFromScope(capturedScope));
        // If this name also has a locator binding, evaluate the JS
        // against the located element (element passed as arguments[0]).
        const locatorFn = scope.getLocator(trimmedName);
        if (locatorFn) {
          try {
            const loc = await locatorFn();
            const result = await (loc as { evaluate(fn: string): Promise<unknown> })
              .evaluate(makeElementScript(capturedScript));
            return result == null ? '' : String(result);
          } catch { /* fall through to page-level evaluation */ }
        }
        // Page-level evaluation: wrap in IIFE; auto-invoke if expression is a function.
        const wrapped = `(function(){var __r=(${capturedScript});return typeof __r==='function'?__r():__r;})()`;
        try {
          const result = await capturedPage.evaluate(wrapped);
          return result == null ? '' : String(result);
        } catch (e) {
          // Browser closed between the isClosed check and the evaluate call
          // (race in @Finally cleanup chains). Resolver swallows it; the
          // calling step records its own failure via Playwright.
          if (isBrowserClosedError(e)) return '';
          throw e;
        }
      });
    }
  );

  // <name> is defined by javascript  — docstring form (.meta file syntax)
  // The JS script comes from the """" docstring block attached to the step.
  // Compositor sets pgwen._step_docstring in scope before calling any DSL handler.
  registry.register(
    /^(.+) is defined by (?:javascript|js)$/i,
    async ([name], scope, page) => {
      const trimmedName = name!.trim();
      const script = scope.get('pgwen._step_docstring') ?? '';
      // Use setTransparent so /javascript source key survives stepDef scope pop
      scope.setTransparent(`${trimmedName}/javascript`, script);
      const capturedPage = page as PageLike;
      const capturedScript = script;
      const capturedScope = scope;
      scope.setLazyTransparent(trimmedName, async () => {
        if (capturedPage == null || typeof (capturedPage as PageLike).evaluate !== 'function') return '';
        // NB: we used to also short-circuit when `page.isClosed()` returned
        // true, but that incorrectly matched pre-navigation page state for
        // some Playwright setups. The `isBrowserClosedError` catch around
        // page.evaluate below is sufficient to absorb genuine post-close
        // lazy fires without masking pre-navigation evaluations (which
        // page.evaluate handles fine on about:blank).
        await waitForPageReady(capturedPage, pageReadyOptsFromScope(capturedScope));
        // If this name also has a locator binding, evaluate with element
        const locatorFn = scope.getLocator(trimmedName);
        if (locatorFn) {
          try {
            const loc = await locatorFn();
            const result = await (loc as { evaluate(fn: string): Promise<unknown> })
              .evaluate(makeElementScript(capturedScript));
            return result == null ? '' : String(result);
          } catch { /* fall through */ }
        }
        const wrapped = `(function(){var __r=(${capturedScript});return typeof __r==='function'?__r():__r;})()`;
        try {
          const result = await capturedPage.evaluate(wrapped);
          return result == null ? '' : String(result);
        } catch (e) {
          if (isBrowserClosedError(e)) return '';
          throw e;
        }
      });
    }
  );

  // <name> is defined by <javascriptRef> applied to "<arguments>" delimited by "<delimiter>"
  // Multi-argument form: splits the arguments string by delimiter and calls the function
  registry.register(
    /^(.+) is defined by (.+) applied to "(.+)" delimited by "(.+)"$/,
    async ([name, scriptRef, argsStr, delimiter], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const script = scope.get(scriptRef!.trim()) ?? scriptRef!;
        const args = argsStr!.split(delimiter!);
        try {
          const fn = new Function(`return (${script})`)() as (...a: string[]) => unknown;
          const result = fn(...args);
          return result == null ? '' : String(result);
        } catch {
          // Script may be a body-expression using arguments[n] directly (e.g. arguments[0].trim())
          try {
            const result = (new Function(`return (${script})`) as (...a: string[]) => unknown)(...args);
            return result == null ? '' : String(result);
          } catch {
            return argsStr ?? '';
          }
        }
      });
    }
  );

  // <name> is defined by <javascriptRef> applied to "<argument>"
  registry.register(
    /^(.+) is defined by (.+) applied to "(.+)"$/,
    async ([name, scriptRef, argument], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const script = scope.get(scriptRef!.trim()) ?? scriptRef!;
        try {
          // Evaluate the function expression and call it with the argument
          const fn = new Function(`return (${script})`)() as (arg: string) => unknown;
          const result = fn(argument!);
          return result == null ? '' : String(result);
        } catch {
          // Script may be a body-expression using arguments[0] directly (e.g. arguments[0].trim())
          try {
            const result = (new Function(`return (${script})`) as (arg: string) => unknown)(argument!);
            return result == null ? '' : String(result);
          } catch {
            return argument ?? '';
          }
        }
      });
    }
  );

  // <name> is defined by <javascriptRef> applied to <element>
  // Element-binding form: evaluates JS function against the element node (arguments[0] equivalent)
  registry.register(
    /^(.+) is defined by (.+) applied to ([^"]+)$/i,
    async ([name, scriptRef, elementName], scope) => {
      scope.setLazyTransparent(name!.trim(), async () => {
        const script = scope.get(scriptRef!.trim()) ?? scriptRef!;
        const loc = await resolveLocator(elementName!.trim(), scope);
        try {
          const result = await loc.evaluate(new Function(`return (${script})`) as (el: Element) => unknown);
          return result == null ? '' : String(result);
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined in the file "<filepath>"
  registry.register(
    /^(.+) is defined in the file "(.+)"$/,
    async ([name, filepath], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const content = fs.readFileSync(filepath!, 'utf-8');
        return content.trim();
      });
    }
  );

  // <name> is defined by file "<filepath>"
  //   the reference framework-form wording variant. Same lazy-binding behaviour as the
  //   "in the file" form above — projects written against the canonical the reference framework
  //   docs use this phrasing so pgwen must accept it directly.
  registry.register(
    /^(.+) is defined by file "(.+)"$/,
    async ([name, filepath], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const content = fs.readFileSync(filepath!, 'utf-8');
        return content.trim();
      });
    }
  );

  // <name> is defined in <ref> by regex "<pattern>"  — captures group 1 (short form)
  registry.register(
    /^(.+) is defined in (.+) by regex "(.+)"$/,
    async ([name, ref, pattern], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const source = scope.get(ref!.trim()) ?? '';
        const match = new RegExp(pattern!).exec(source);
        return match?.[1] ?? '';
      });
    }
  );

  // <name> is defined by extracting <group> from <ref> by regex "<pattern>"
  registry.register(
    /^(.+) is defined by extracting (.+) from (.+) by regex "(.+)"$/,
    async ([name, groupStr, ref, pattern], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const source = scope.get(ref!.trim()) ?? '';
        const groupIndex = isNaN(Number(groupStr)) ? 1 : parseInt(groupStr!, 10);
        const match = new RegExp(pattern!).exec(source);
        return match?.[groupIndex] ?? '';
      });
    }
  );

  // <name> is defined in <jsonRef> by json path "<path>"
  //   the reference framework-form word order (the reference comes BEFORE the json path). Same
  //   behaviour as the pgwen-form below; this just accepts the canonical the reference framework
  //   wording so projects written against the the reference framework docs resolve directly. Both
  //   forms share the same lazy-binding logic.
  registry.register(
    /^(.+) is defined in (.+) by json path "(.+)"$/,
    async ([name, ref, jsonPath], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const raw = scope.get(ref!.trim()) ?? '{}';
        let obj: unknown;
        try { obj = JSON.parse(raw); } catch { return ''; }
        const result = evaluateJsonPath(obj, jsonPath!);
        return result == null ? '' : String(result);
      });
    }
  );

  // <name> is defined by json path "<path>" in <ref>
  registry.register(
    /^(.+) is defined by json path "(.+)" in (.+)$/,
    async ([name, jsonPath, ref], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const raw = scope.get(ref!.trim()) ?? '{}';
        let obj: unknown;
        try { obj = JSON.parse(raw); } catch { return ''; }
        const result = evaluateJsonPath(obj, jsonPath!);
        return result == null ? '' : String(result);
      });
    }
  );

  // <name> is defined by the <nodeType> in <xmlRef> by xpath "<expression>"
  //
  // the reference framework-form XML binding with explicit node-type selector:
  //   text     — return the string value of the matched node (default-like form)
  //   node     — return the single matched node serialised as XML
  //   nodeset  — return ALL matched nodes serialised and concatenated
  //
  // Registered BEFORE the bare `is defined by xpath …` pattern below so the
  // longer, more-specific text matches first. The two regex shapes don't
  // overlap (different word order: `by the <type> in <ref> by xpath` vs
  // `by xpath … in <ref>`) so first-match-wins is a safety net, not a
  // necessity.
  registry.register(
    /^(.+) is defined by the (text|node|nodeset) in (.+) by xpath "(.+)"$/i,
    async ([name, nodeType, ref, xpathExpr], scope) => {
      const target = name!.trim();
      const kind = nodeType!.toLowerCase() as 'text' | 'node' | 'nodeset';
      const refName = ref!.trim();
      const expr = xpathExpr!;
      scope.setLazyTransparent(target, () => {
        const xml = scope.get(refName) ?? '';
        try {
          const { DOMParser, XMLSerializer } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom');
          const xpathLib = require('xpath') as typeof import('xpath');
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          const serialiser = new XMLSerializer();
          if (kind === 'nodeset') {
            const nodes = xpathLib.select(expr, doc as unknown as Node);
            if (!Array.isArray(nodes) || nodes.length === 0) return '';
            return nodes
              .map((n) => serialiser.serializeToString(n as unknown as Parameters<typeof serialiser.serializeToString>[0]))
              .join('');
          }
          const single = xpathLib.select1(expr, doc as unknown as Node);
          if (single == null) return '';
          if (kind === 'node') {
            // Serialise the single matched node as XML
            return serialiser.serializeToString(single as unknown as Parameters<typeof serialiser.serializeToString>[0]);
          }
          // text — string value of the node (or primitive result)
          if (typeof single === 'string' || typeof single === 'number' || typeof single === 'boolean') {
            return String(single);
          }
          return (single as { textContent?: string | null }).textContent?.trim() ?? '';
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined by xpath "<expr>" in <ref>
  registry.register(
    /^(.+) is defined by xpath "(.+)" in (.+)$/i,
    async ([name, xpathExpr, ref], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const xml = scope.get(ref!.trim()) ?? '';
        try {
          const { DOMParser } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom');
          const xpathLib = require('xpath') as typeof import('xpath');
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          const result = xpathLib.select1(xpathExpr!, doc as unknown as Node);
          if (result == null) return '';
          if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
            return String(result);
          }
          // Node — return its text content
          return (result as { textContent?: string | null }).textContent?.trim() ?? '';
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined by system process "<command>"
  registry.register(
    /^(.+) is defined by system process "(.+)"$/,
    async ([name, command], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const { execSync } = require('child_process') as typeof import('child_process');
        try {
          return execSync(command!, { encoding: 'utf-8' }).trim();
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined by system process "<command>" delimited by "<delimiter>"
  registry.register(
    /^(.+) is defined by system process "(.+)" delimited by "(.+)"$/,
    async ([name, command, delimiter], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const { execSync } = require('child_process') as typeof import('child_process');
        try {
          return execSync(command!, { encoding: 'utf-8' }).split(delimiter!).map(s => s.trim()).join(delimiter!);
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined by unix system process "<command>"  — executes via sh -c on unix-like systems
  registry.register(
    /^(.+) is defined by unix system process "(.+)"$/,
    async ([name, command], scope) => {
      scope.setLazyTransparent(name!.trim(), () => {
        const { execSync } = require('child_process') as typeof import('child_process');
        try {
          return execSync(command!, { shell: '/bin/sh', encoding: 'utf-8' }).trim();
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined by unix system process  — docstring form (multi-line shell/curl command)
  // The command comes from the """ docstring block attached to the step.
  registry.register(
    /^(.+) is defined by unix system process$/i,
    async ([name], scope) => {
      const command = scope.get('pgwen._step_docstring') ?? '';
      scope.setLazyTransparent(name!.trim(), () => {
        const { execSync } = require('child_process') as typeof import('child_process');
        try {
          return execSync(command, { shell: '/bin/sh', encoding: 'utf-8' }).trim();
        } catch {
          return '';
        }
      });
    }
  );

  // <name> is defined by system process  — docstring form
  registry.register(
    /^(.+) is defined by system process$/i,
    async ([name], scope) => {
      const command = scope.get('pgwen._step_docstring') ?? '';
      scope.setLazyTransparent(name!.trim(), () => {
        const { execSync } = require('child_process') as typeof import('child_process');
        try {
          return execSync(command, { encoding: 'utf-8' }).trim();
        } catch {
          return '';
        }
      });
    }
  );
}

// NOTE: <name> is formatted as "<format>" from <ref>
//       <name> is the current date formatted as "<format>"
//       <name> is the current date time formatted as "<format>"
// are registered by formatting/DateTimeFormatter.ts (with full parseDate/formatDate support)
// and NOT here, to avoid shadowing the proper implementation.

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wraps a the reference framework-style JS script that uses `arguments[0]` into a Playwright-compatible
 * element function.  Playwright's locator.evaluate() passes the DOM element as the
 * first parameter of the function, but does NOT populate `arguments[0]`.
 * This wrapper renames `arguments[0]` to `__pgwenEl__` and wraps the script.
 */
function makeElementScript(script: string): string {
  const adjusted = script.replace(/\barguments\[0\]/g, '__pgwenEl__');
  return `(__pgwenEl__) => { return (function() { return (${adjusted}); })(); }`;
}

/**
 * Returns true when the given error indicates the Playwright page / context /
 * browser was closed before / during the call. Used by lazy `is defined by js`
 * resolvers so they can silently no-op when fired during `@Finally` cleanup,
 * after the browser has already shut down. Without this, the resolver throws
 * from inside a Promise that nothing awaits, producing an uncaughtException
 * that kills the Node process before the test runner can render its report.
 */
function isBrowserClosedError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return m.includes('Target page, context or browser has been closed')
      || m.includes('Target closed')
      || m.includes('browser has been closed');
}

/**
 * Evaluate a Jayway-compatible JSONPath expression against a parsed JSON object.
 *
 * Supported features:
 *   $.key              — dot notation
 *   $['key']           — bracket notation
 *   $[0]               — array index (0-based)
 *   $[-1]              — negative array index (from end)
 *   $..*               — deep wildcard (all descendants)
 *   $..key             — recursive descent
 *   $[*]  / $.key[*]   — wildcard (all elements of array/object)
 *   $[1,3]             — union of indices
 *   $[1:3]  $[::2]     — slice (Python-style)
 *   $[?(@.x == 'v')]   — filter: ==  !=  <  <=  >  >=  (string and number comparands)
 *   $[?(@.x)]          — existence filter
 *
 * Returns the first result for single-value paths, or a JSON array string for
 * multi-value paths (wildcard/recursive/filter), matching the reference framework's result format.
 */
function evaluateJsonPath(obj: unknown, path: string): unknown {
  const results = jsonPathQuery(obj, path);
  if (results.length === 0) return undefined;
  if (results.length === 1) return results[0];
  return JSON.stringify(results);
}

function jsonPathQuery(root: unknown, path: string): unknown[] {
  if (!path.startsWith('$')) return [];
  // Strip leading '$' and split into tokens
  const tokens = tokeniseJsonPath(path.slice(1));
  return applyTokens([root], tokens);
}

function tokeniseJsonPath(path: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') {
      if (path[i + 1] === '.') {
        // Recursive descent '..name' or '..[...]'
        i += 2;
        if (path[i] === '[') {
          const end = path.indexOf(']', i);
          tokens.push(`..${path.slice(i, end + 1)}`);
          i = end + 1;
        } else {
          const end = path.slice(i).search(/[\.\[]/);
          const name = end === -1 ? path.slice(i) : path.slice(i, i + end);
          tokens.push(`..${name}`);
          i += name.length;
        }
      } else {
        i++;
        if (i >= path.length) break;
        if (path[i] === '[') continue; // bracket follows dot — handled next iteration
        if (path[i] === '*') { tokens.push('*'); i++; continue; }
        const end = path.slice(i).search(/[\.\[]/);
        const name = end === -1 ? path.slice(i) : path.slice(i, i + end);
        tokens.push(name);
        i += name.length;
      }
    } else if (path[i] === '[') {
      const end = path.indexOf(']', i);
      tokens.push(path.slice(i, end + 1));
      i = end + 1;
    } else {
      // Bare token at start (no leading dot)
      const end = path.slice(i).search(/[\.\[]/);
      const name = end === -1 ? path.slice(i) : path.slice(i, i + end);
      if (name) tokens.push(name);
      i += name.length;
    }
  }
  return tokens;
}

function applyTokens(nodes: unknown[], tokens: string[]): unknown[] {
  let current = nodes;
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const node of current) {
      next.push(...applyToken(node, token));
    }
    current = next;
  }
  return current;
}

function applyToken(node: unknown, token: string): unknown[] {
  if (token === '*') {
    // Wildcard: all children
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') return Object.values(node as object);
    return [];
  }

  if (token.startsWith('..')) {
    // Recursive descent
    const inner = token.slice(2);
    const all = flatDescendants(node);
    if (inner === '' || inner === '*') return all;
    // Apply inner token to all descendants
    return all.flatMap(n => applyToken(n, inner));
  }

  if (token.startsWith('[') && token.endsWith(']')) {
    return applyBracket(node, token.slice(1, -1));
  }

  // Simple property name
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const val = (node as Record<string, unknown>)[token];
    return val !== undefined ? [val] : [];
  }
  return [];
}

function applyBracket(node: unknown, expr: string): unknown[] {
  const trimmed = expr.trim();

  // Filter expression: ?(@.key op value) or ?(@.key)
  if (trimmed.startsWith('?(') && trimmed.endsWith(')')) {
    const filterExpr = trimmed.slice(2, -1);
    if (!Array.isArray(node)) return [];
    return node.filter(item => evalFilter(item, filterExpr));
  }

  // Wildcard
  if (trimmed === '*') {
    if (Array.isArray(node)) return node;
    if (node && typeof node === 'object') return Object.values(node as object);
    return [];
  }

  // Quoted key: 'key' or "key"
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    const key = trimmed.slice(1, -1);
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const val = (node as Record<string, unknown>)[key];
      return val !== undefined ? [val] : [];
    }
    return [];
  }

  // Union: 0,2,4
  if (trimmed.includes(',') && !trimmed.includes(':')) {
    const indices = trimmed.split(',').map(s => parseInt(s.trim(), 10));
    if (!Array.isArray(node)) return [];
    return indices.map(i => node[i < 0 ? node.length + i : i]).filter(v => v !== undefined);
  }

  // Slice: start:end:step
  if (trimmed.includes(':')) {
    if (!Array.isArray(node)) return [];
    const parts = trimmed.split(':').map(s => s.trim() === '' ? undefined : parseInt(s.trim(), 10));
    const len = node.length;
    const step = parts[2] ?? 1;
    const start = parts[0] !== undefined ? (parts[0] < 0 ? len + parts[0] : parts[0]) : (step < 0 ? len - 1 : 0);
    const end   = parts[1] !== undefined ? (parts[1] < 0 ? len + parts[1] : parts[1]) : (step < 0 ? -1 : len);
    const result: unknown[] = [];
    for (let i = start; step > 0 ? i < end : i > end; i += step) {
      result.push(node[i]);
    }
    return result;
  }

  // Numeric index
  const idx = parseInt(trimmed, 10);
  if (!isNaN(idx)) {
    if (Array.isArray(node)) {
      const i = idx < 0 ? node.length + idx : idx;
      return node[i] !== undefined ? [node[i]] : [];
    }
    return [];
  }

  // Bare key (unquoted)
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const val = (node as Record<string, unknown>)[trimmed];
    return val !== undefined ? [val] : [];
  }
  return [];
}

function flatDescendants(node: unknown): unknown[] {
  const result: unknown[] = [node];
  if (Array.isArray(node)) {
    for (const item of node) result.push(...flatDescendants(item));
  } else if (node && typeof node === 'object') {
    for (const val of Object.values(node as object)) result.push(...flatDescendants(val));
  }
  return result;
}

function evalFilter(item: unknown, expr: string): boolean {
  // @.key op value  or  @.key (existence)
  const opMatch = /^@\.(\w+)\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(expr.trim());
  if (opMatch) {
    const [, key, op, rawVal] = opMatch;
    const actual = (item as Record<string, unknown>)?.[key!];
    const expected = parseFilterValue(rawVal!.trim());
    switch (op) {
      case '==': return actual == expected;
      case '!=': return actual != expected;
      case '<':  return (actual as number) < (expected as number);
      case '<=': return (actual as number) <= (expected as number);
      case '>':  return (actual as number) > (expected as number);
      case '>=': return (actual as number) >= (expected as number);
    }
  }
  // Existence: @.key
  const existMatch = /^@\.(\w+)$/.exec(expr.trim());
  if (existMatch) {
    return (item as Record<string, unknown>)?.[existMatch[1]!] !== undefined;
  }
  return false;
}

function parseFilterValue(raw: string): unknown {
  if ((raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const n = Number(raw);
  return isNaN(n) ? raw : n;
}

/** Format a date string using Java DateTimeFormatter-style patterns. */
function formatDate(dateStr: string, pattern: string): string {
  let date: Date;
  try {
    date = new Date(dateStr);
    if (isNaN(date.getTime())) throw new Error('invalid');
  } catch {
    return dateStr;
  }

  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const y = date.getFullYear();
  const M = date.getMonth() + 1;
  const d = date.getDate();
  const H = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();

  return pattern
    .replace('yyyy', String(y))
    .replace('yy', String(y).slice(-2))
    .replace('MM', pad(M))
    .replace('M', String(M))
    .replace('dd', pad(d))
    .replace('d', String(d))
    .replace('HH', pad(H))
    .replace('H', String(H))
    .replace('mm', pad(m))
    .replace('m', String(m))
    .replace('ss', pad(s))
    .replace('s', String(s));
}

// ─── Exported for testing ─────────────────────────────────────────────────────

export { evaluateJsonPath, formatDate };

// Helper for tests — bind a literal value into scope directly
export function bindText(name: string, value: string, scope: Scope): void {
  scope.set(name, value);
}
