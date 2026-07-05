/**
 * playwright/api.ts — HTTP API testing steps.
 *
 * Uses Playwright's `APIRequestContext` (page.request or playwright.request)
 * to make HTTP requests directly without a browser page.  Responses are stored
 * in scope for subsequent assertion steps.
 *
 * Supported patterns:
 *   I send "<method>" request to "<url>"
 *   I send "<method>" request to "<url>" with body "<json>"
 *   I send "<method>" request to "<url>" with body from file "<file>"
 *   I send "<method>" request to "<url>" with header "<name>" and value "<value>"
 *
 * Response assertion patterns:
 *   the response status should[ not] be "<n>"
 *   the response status should be ok
 *   the response body should[ not] be "<expression>"
 *   the response body should[ not] contain "<expression>"
 *   the response body should[ not] match json path "<jsonPath>"
 *   I capture response value "<jsonPath>" as <name>
 *   I capture the response body as <name>
 *   I capture the response status as <name>
 */

import { readFileSync } from 'fs';
import type { DslRegistry } from '../registry';
import type { PageLike, ApiRequestContextLike, ApiResponseLike } from '../locatorUtils';
import { DslAssertionError, assertText } from '../locatorUtils';
import type { Scope } from '../../engine/Scope';

const SCOPE_LAST_RESPONSE_BODY   = 'pgwen.api.last.response.body';
const SCOPE_LAST_RESPONSE_STATUS = 'pgwen.api.last.response.status';

export function registerApiActions(registry: DslRegistry): void {

  // ─── Request sending ──────────────────────────────────────────────────────

  // I send "<method>" request to "<url>" with body from file "<file>"
  registry.register(
    /^I send "([^"]+)" request to "([^"]+)" with body from file "([^"]+)"$/i,
    async ([method, url, file], scope, page) => {
      const body = readFileSync(file!, 'utf-8');
      await sendRequest(method!, url!, scope, page, { data: body });
    }
  );

  // I send "<method>" request to "<url>" with header "<name>" and value "<value>"
  registry.register(
    /^I send "([^"]+)" request to "([^"]+)" with header "([^"]+)" and value "([^"]*)"$/i,
    async ([method, url, headerName, headerValue], scope, page) => {
      await sendRequest(method!, url!, scope, page, {
        headers: { [headerName!]: headerValue! }
      });
    }
  );

  // I send "<method>" request to "<url>" with body "<json>"
  registry.register(
    /^I send "([^"]+)" request to "([^"]+)" with body "([^"]*)"$/i,
    async ([method, url, body], scope, page) => {
      await sendRequest(method!, url!, scope, page, { data: body! });
    }
  );

  // I send "<method>" request to "<url>"
  registry.register(
    /^I send "([^"]+)" request to "([^"]+)"$/i,
    async ([method, url], scope, page) => {
      await sendRequest(method!, url!, scope, page);
    }
  );

  // ─── Response assertions ──────────────────────────────────────────────────

  // the response status should[ not] be "<n>"
  registry.register(
    /^the response status should (not )?be "(\d+)"$/i,
    async ([notStr, expected], scope) => {
      const negate = !!notStr;
      const actual = scope.get(SCOPE_LAST_RESPONSE_STATUS) ?? '';
      if (negate ? actual === expected : actual !== expected) {
        throw new DslAssertionError(
          `Expected response status to ${negate ? 'not ' : ''}be "${expected}" but got "${actual}"`
        );
      }
    }
  );

  // the response status should be ok
  registry.register(
    /^the response status should be ok$/i,
    async (_, scope) => {
      const status = parseInt(scope.get(SCOPE_LAST_RESPONSE_STATUS) ?? '0', 10);
      if (status < 200 || status > 299) {
        throw new DslAssertionError(`Expected response status to be 2xx but got ${status}`);
      }
    }
  );

  // the response body should[ not] be/contain/start with/end with/match regex "<expression>"
  registry.register(
    /^the response body should (not )?(be|contain|start with|end with|match regex) "([^"]*)"$/i,
    async ([notStr, op, expected], scope) => {
      const negate = !!notStr;
      const actual = scope.get(SCOPE_LAST_RESPONSE_BODY) ?? '';
      assertText(actual, op as import('../locatorUtils').CompareOp, expected!, negate, '"response body"');
    }
  );

  // the response body should[ not] match json path "<jsonPath>"
  registry.register(
    /^the response body should (not )?match json path "([^"]*)"$/i,
    async ([notStr, jsonPath], scope) => {
      const negate = !!notStr;
      const body = scope.get(SCOPE_LAST_RESPONSE_BODY) ?? '';
      let matches: boolean;
      try {
        const obj = JSON.parse(body) as unknown;
        matches = evalJsonPath(obj, jsonPath!) !== undefined;
      } catch {
        matches = false;
      }
      if (negate ? matches : !matches) {
        throw new DslAssertionError(
          `Expected response body to ${negate ? 'not ' : ''}match json path "${jsonPath}"`
        );
      }
    }
  );

  // ─── Capture ──────────────────────────────────────────────────────────────

  // I capture response value "<jsonPath>" as <name>
  registry.register(
    /^I capture response value "([^"]+)" as (.+)$/i,
    async ([jsonPath, name], scope) => {
      const body = scope.get(SCOPE_LAST_RESPONSE_BODY) ?? '';
      try {
        const obj = JSON.parse(body) as unknown;
        const value = evalJsonPath(obj, jsonPath!);
        scope.set(name!.trim(), value !== undefined && value !== null ? String(value) : '');
      } catch {
        scope.set(name!.trim(), '');
      }
    }
  );

  // I capture the response body as <name>
  registry.register(
    /^I capture the response body as (.+)$/i,
    async ([name], scope) => {
      scope.set(name!.trim(), scope.get(SCOPE_LAST_RESPONSE_BODY) ?? '');
    }
  );

  // I capture the response status as <name>
  registry.register(
    /^I capture the response status as (.+)$/i,
    async ([name], scope) => {
      scope.set(name!.trim(), scope.get(SCOPE_LAST_RESPONSE_STATUS) ?? '');
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendRequest(
  method: string,
  url: string,
  scope: Scope,
  page: unknown,
  options: { data?: string; headers?: Record<string, string> } = {}
): Promise<void> {
  const apiCtx = (page as PageLike).request;
  if (!apiCtx) {
    // Fallback: store a placeholder so tests can assert without a real request context
    scope.set(SCOPE_LAST_RESPONSE_STATUS, '0');
    scope.set(SCOPE_LAST_RESPONSE_BODY, '');
    return;
  }

  const req = apiCtx as ApiRequestContextLike;
  let response: ApiResponseLike;
  const m = method.toUpperCase();
  const reqOptions: { data?: string; headers?: Record<string, string> } = {};
  if (options.data !== undefined) reqOptions.data = options.data;
  if (options.headers !== undefined) reqOptions.headers = options.headers;

  switch (m) {
    case 'GET':    response = await req.get(url, reqOptions); break;
    case 'POST':   response = await req.post(url, reqOptions); break;
    case 'PUT':    response = await req.put(url, reqOptions); break;
    case 'PATCH':  response = await req.patch(url, reqOptions); break;
    case 'DELETE': response = await req.delete(url, reqOptions); break;
    case 'HEAD':   response = await req.head(url, reqOptions); break;
    default:       response = await req.fetch(url, { ...reqOptions, method: m }); break;
  }

  scope.set(SCOPE_LAST_RESPONSE_STATUS, String(response.status()));
  scope.set(SCOPE_LAST_RESPONSE_BODY, await response.text());
}

function evalJsonPath(obj: unknown, path: string): unknown {
  // Strip the JSONPath root marker so `$.args.lang` and `args.lang` both work.
  const normalised = path.replace(/^\$\.?/, '');
  if (normalised === '') return obj;
  const parts = normalised.replace(/\[(\d+)\]/g, '.$1').split('.').filter(p => p.length > 0);
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
