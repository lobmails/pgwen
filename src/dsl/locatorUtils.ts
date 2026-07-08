/**
 * locatorUtils.ts — Helpers for building and resolving Playwright locators.
 *
 * Typed as `unknown` throughout so that the DSL layer has no compile-time
 * dependency on the `playwright` package (which is a devDependency and
 * not available in all execution contexts such as dry-run or unit tests).
 */

import type { Scope } from '../engine/Scope';

// ─── Playwright type stubs (structural, no import needed) ─────────────────────

/** Minimum Playwright BrowserContext surface used by the DSL. */
export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  pages(): PageLike[];
  waitForEvent(event: 'page', options?: { timeout?: number }): Promise<PageLike>;
  setGeolocation(coords: { latitude: number; longitude: number; accuracy?: number }): Promise<void>;
  grantPermissions(permissions: string[], options?: { origin?: string }): Promise<void>;
  clearPermissions(): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  route(url: string | RegExp, handler: (route: RouteLike) => void): Promise<void>;
  unroute(url: string | RegExp): Promise<void>;
  newCDPSession?: (page: unknown) => Promise<CdpSessionLike>;
}

/** Minimum surface of a Playwright Route (for network interception). */
export interface RouteLike {
  request(): { url(): string; method(): string; headers(): Record<string, string> };
  fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    contentType?: string;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  continue(overrides?: { headers?: Record<string, string> }): Promise<void>;
}

/** Minimum surface of a Playwright APIRequestContext. */
export interface ApiRequestContextLike {
  get(url: string, options?: ApiRequestOptions): Promise<ApiResponseLike>;
  post(url: string, options?: ApiRequestOptions): Promise<ApiResponseLike>;
  put(url: string, options?: ApiRequestOptions): Promise<ApiResponseLike>;
  patch(url: string, options?: ApiRequestOptions): Promise<ApiResponseLike>;
  delete(url: string, options?: ApiRequestOptions): Promise<ApiResponseLike>;
  head(url: string, options?: ApiRequestOptions): Promise<ApiResponseLike>;
  fetch(url: string, options?: ApiRequestOptions & { method?: string }): Promise<ApiResponseLike>;
}

export interface ApiRequestOptions {
  headers?: Record<string, string>;
  data?: string | Record<string, unknown>;
  timeout?: number;
}

export interface ApiResponseLike {
  status(): number;
  statusText(): string;
  headers(): Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  ok(): boolean;
}

/** Minimum surface of a Playwright CDPSession (Chrome DevTools Protocol). */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

/** Minimum surface of a Playwright dialog (alert / confirm / prompt). */
export interface DialogLike {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

/** Minimum surface of a Playwright FrameLocator. */
export interface FrameLocatorLike {
  locator(selector: string): LocatorLike;
  getByText(text: string, options?: { exact?: boolean }): LocatorLike;
  getByLabel(text: string, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder(text: string, options?: { exact?: boolean }): LocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp }): LocatorLike;
  frameLocator(selector: string): FrameLocatorLike;
  /** Select by index within a set of matching frames. */
  nth(index: number): FrameLocatorLike;
}

/** Minimum surface of a Playwright FileChooser. */
export interface FileChooserLike {
  setFiles(files: string | string[]): Promise<void>;
}

/** Minimum surface of a Playwright Download. */
export interface DownloadLike {
  path(): Promise<string | null>;
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

/** Minimum Playwright Page surface used by the DSL. */
export interface PageLike {
  locator(selector: string): LocatorLike;
  getByText(text: string, options?: { exact?: boolean }): LocatorLike;
  getByLabel(text: string, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder(text: string, options?: { exact?: boolean }): LocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp }): LocatorLike;
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: string }): Promise<unknown>;
  goBack(options?: { waitUntil?: string }): Promise<unknown>;
  goForward(options?: { waitUntil?: string }): Promise<unknown>;
  bringToFront(): Promise<void>;
  close(options?: unknown): Promise<void>;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { state?: string; timeout?: number }): Promise<LocatorLike>;
  waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { timeout?: number },
  ): Promise<void>;
  waitForFunction(fn: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForEvent(event: string, options?: unknown): Promise<unknown>;
  evaluate<T>(fn: string | ((arg: unknown) => T), arg?: unknown): Promise<T>;
  frameLocator(selector: string): FrameLocatorLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, handler: (...args: any[]) => void): void;
  context(): BrowserContextLike;
  keyboard: { press(key: string): Promise<void> };
  touchscreen: { tap(x: number, y: number): Promise<void> };
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  routeFromHAR(har: string, options?: { notFound?: 'abort' | 'fallback'; update?: boolean; url?: string | RegExp }): Promise<void>;
  /** Playwright request context for API testing. */
  request?: ApiRequestContextLike;
}

/** Minimum Playwright Locator surface used by the DSL. */
export interface LocatorLike {
  click(options?: { button?: string; clickCount?: number; modifiers?: string[] }): Promise<void>;
  dblclick(options?: unknown): Promise<void>;
  tap(options?: unknown): Promise<void>;
  fill(value: string, options?: unknown): Promise<void>;
  pressSequentially(text: string, options?: unknown): Promise<void>;
  clear(options?: unknown): Promise<void>;
  check(options?: unknown): Promise<void>;
  uncheck(options?: unknown): Promise<void>;
  hover(options?: unknown): Promise<void>;
  press(key: string, options?: unknown): Promise<void>;
  type(text: string, options?: unknown): Promise<void>;
  dispatchEvent(type: string, eventInit?: unknown): Promise<void>;
  dragTo(target: LocatorLike, options?: unknown): Promise<void>;
  selectOption(values: string | string[] | { label?: string; value?: string; index?: number } | Array<{ label?: string; value?: string; index?: number }>, options?: unknown): Promise<string[]>;
  isVisible(): Promise<boolean>;
  isHidden(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate<T = unknown>(fn: string | ((el: any, arg?: any) => T), arg?: unknown): Promise<T>;
  count(): Promise<number>;
  nth(index: number): LocatorLike;
  first(): LocatorLike;
  last(): LocatorLike;
  /** Scoped child locator (for locator chaining). */
  locator(selector: string): LocatorLike;
  scrollIntoViewIfNeeded(options?: unknown): Promise<void>;
  focus(options?: unknown): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
  innerHTML(): Promise<string>;
  innerText(): Promise<string>;
  filter(options?: { hasText?: string | RegExp }): LocatorLike;
  all(): Promise<LocatorLike[]>;
  boundingBox(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

// ─── Selector builder ─────────────────────────────────────────────────────────

/**
 * Build a Playwright Locator from a selector type + expression.
 * Selector types mirror web.locator values (case-insensitive).
 */
export function buildLocator(page: unknown, selectorType: string, expression: string): LocatorLike {
  const p = page as PageLike;
  const type = selectorType.trim().toLowerCase();

  switch (type) {
    case 'id':
      return p.locator(`[id="${expression}"]`);
    case 'name':
      return p.locator(`[name="${expression}"]`);
    case 'tag name':
    case 'tag':
      return p.locator(expression);
    case 'css selector':
    case 'css':
      return p.locator(expression);
    case 'xpath':
      return p.locator(`xpath=${expression}`);
    case 'class name':
    case 'class':
      // If expression already starts with "." treat as-is, otherwise prepend "."
      return p.locator(expression.startsWith('.') ? expression : `.${expression}`);
    case 'link text':
      // By.linkText restricts to <a> elements with exact visible text match
      return p.locator(`a:text-is("${expression.replace(/"/g, '\\"')}")`);
    case 'partial link text':
      // By.partialLinkText restricts to <a> elements with substring text match
      return p.locator(`a:text("${expression.replace(/"/g, '\\"')}")`);
    case 'javascript':
    case 'js':
      // (WebDriver-style) used js: to run driver.executeScript() with jQuery.
      // Playwright has no js= engine — convert jQuery expressions to Playwright CSS.
      return p.locator(jqueryToPlaywright(expression));
    default:
      return p.locator(expression);
  }
}

// ─── Locator resolver ─────────────────────────────────────────────────────────

/**
 * Resolve an element name from scope into a Playwright Locator.
 * Throws if no locator binding exists for the name.
 */
export async function resolveLocator(elementName: string, scope: Scope): Promise<LocatorLike> {
  const fn = scope.getLocator(elementName);
  if (!fn) {
    throw new Error(
      `No locator binding found for "${elementName}". ` +
      `Declare it with: ${elementName} can be located by <selector> "<expression>"`
    );
  }
  const loc = await (fn() as Promise<LocatorLike>);
  await applyImplicitBehaviors(loc, scope);
  return loc;
}

/**
 * Apply implicit element behaviours controlled by pgwen.web.implicit.element.* config keys.
 * Called automatically after every locator is resolved.
 *   pgwen.web.implicit.element.moveTo = "true" → scrollIntoViewIfNeeded()
 *   pgwen.web.implicit.element.focus  = "true" → focus()
 *
 * Both are best-effort with short timeouts and swallowed errors. Playwright
 * waits for actionability (visibility / stability) by default, which means
 * `focus()` blocks on CSS-hidden controls like styled file-input widgets
 * (`<input type="file">` overlaid by a custom button). In WebDriver-style-based
 * frameworks the equivalent calls were non-blocking JS, so production projects
 * carry `implicit.element.focus = true` assuming it cannot block. Treating
 * these as advisory side-effects preserves the upstream config semantics.
 */
async function applyImplicitBehaviors(loc: LocatorLike, scope: Scope): Promise<void> {
  if ((scope.get('pgwen.web.implicit.element.moveTo') ?? 'false') === 'true') {
    try { await (loc as { scrollIntoViewIfNeeded(o?: { timeout?: number }): Promise<void> })
      .scrollIntoViewIfNeeded({ timeout: 1000 }); } catch { /* best-effort */ }
  }
  if ((scope.get('pgwen.web.implicit.element.focus') ?? 'false') === 'true') {
    try { await (loc as { focus(o?: { timeout?: number }): Promise<void> })
      .focus({ timeout: 1000 }); } catch { /* best-effort */ }
  }
}

// ─── jQuery → Playwright CSS conversion ──────────────────────────────────────

/**
 * Convert a jQuery-style expression used with js: locator type into a
 * Playwright-compatible CSS selector.
 *
 * Rules applied (in order):
 *   1. `$('a').find('b')`    → `a b`  (descendant combinator)
 *   2. `$('selector')`       → unwrap to `selector`
 *   3. `:contains("text")`  → `:has-text("text")`  (Playwright text extension)
 *
 * Selectors that use no jQuery-specific syntax (attribute selectors, class
 * wildcards, role selectors, etc.) pass through unchanged — they are valid CSS
 * that Playwright already understands.
 */
export function jqueryToPlaywright(expression: string): string {
  let sel = expression.trim();

  // document.querySelector('selector') → selector
  const dqMatch = /^document\.querySelector\(['"](.+)['"]\)$/.exec(sel);
  if (dqMatch) return dqMatch[1]!;

  // document.querySelectorAll('selector')[n] → selector >> nth=n
  const dqaMatch = /^document\.querySelectorAll\(['"](.+)['"]\)\[(\d+)\]$/.exec(sel);
  if (dqaMatch) return `${dqaMatch[1]!} >> nth=${dqaMatch[2]!}`;

  // $('A').closest('B').find('C') — closest ancestor matching B that contains
  // an A descendant, then find C inside it. Maps to CSS :has() reverse-lookup:
  //   B:has(A_inner_css) C_inner_css
  // Common in jQuery DOM walks: e.g. `$('span:contains("X")').closest('td').find('a')`.
  // Two cases for outer-quote convention: single-outer (typical pattern,
  // inner `"..."` attributes) and double-outer (inner `'...'`). Use explicit
  // non-quote char classes so the inner content can contain the OTHER quote
  // without bleeding into the `.closest()` segment.
  //
  // Order matters — must run BEFORE the bare `.find()` matcher below.
  const cfSingle = /^\$\('([^']+)'\)\.closest\('([^']+)'\)\.find\('([^']+)'\)$/.exec(sel);
  const cfDouble = /^\$\("([^"]+)"\)\.closest\("([^"]+)"\)\.find\("([^"]+)"\)$/.exec(sel);
  const closestFindMatch = cfSingle ?? cfDouble;
  if (closestFindMatch) {
    const wrap   = cfSingle ? "'" : '"';
    const inner  = jqueryToPlaywright(`$(${wrap}${closestFindMatch[1]!}${wrap})`);
    const anc    = closestFindMatch[2]!;
    const child  = jqueryToPlaywright(`$(${wrap}${closestFindMatch[3]!}${wrap})`);
    return `${anc}:has(${inner}) ${child}`;
  }

  // $('A').closest('B') — closest ancestor of A matching B.
  const cSingle = /^\$\('([^']+)'\)\.closest\('([^']+)'\)$/.exec(sel);
  const cDouble = /^\$\("([^"]+)"\)\.closest\("([^"]+)"\)$/.exec(sel);
  const closestMatch = cSingle ?? cDouble;
  if (closestMatch) {
    const wrap  = cSingle ? "'" : '"';
    const inner = jqueryToPlaywright(`$(${wrap}${closestMatch[1]!}${wrap})`);
    const anc   = closestMatch[2]!;
    return `${anc}:has(${inner})`;
  }

  // $('parent').find('child') chain — descendant combinator.
  // Outer-quote-scoped variants so inner quotes can be the OTHER style.
  const fSingle = /^\$\('([^']+)'\)\.find\('([^']+)'\)$/.exec(sel);
  const fDouble = /^\$\("([^"]+)"\)\.find\("([^"]+)"\)$/.exec(sel);
  const findMatch = fSingle ?? fDouble;
  if (findMatch) {
    const wrap   = fSingle ? "'" : '"';
    const parent = jqueryToPlaywright(`$(${wrap}${findMatch[1]!}${wrap})`);
    const child  = jqueryToPlaywright(`$(${wrap}${findMatch[2]!}${wrap})`);
    return `${parent} ${child}`;
  }

  // $('selector').first() → selector >> nth=0
  const firstMatch = /^\$\(['"](.+)['"]\)\.first\(\)$/.exec(sel);
  if (firstMatch) return `${jqueryToPlaywright(`$('${firstMatch[1]!}')`)} >> nth=0`;

  // $('selector').last() → selector >> nth=-1
  const lastMatch = /^\$\(['"](.+)['"]\)\.last\(\)$/.exec(sel);
  if (lastMatch) return `${jqueryToPlaywright(`$('${lastMatch[1]!}')`)} >> nth=-1`;

  // $('selector').eq(n) → selector >> nth=n
  const eqMatch = /^\$\(['"](.+)['"]\)\.eq\((\d+)\)$/.exec(sel);
  if (eqMatch) return `${jqueryToPlaywright(`$('${eqMatch[1]!}')`)} >> nth=${eqMatch[2]!}`;

  // Strip outer $('...') or $("...") wrapper
  const wrapperMatch = /^\$\(['"](.+)['"]\)$/.exec(sel);
  if (wrapperMatch) {
    sel = wrapperMatch[1]!;
  }

  // :contains("text") / :contains('text') → :has-text("text")
  sel = sel.replace(/:contains\("([^"]*)"\)/g, ':has-text("$1")');
  sel = sel.replace(/:contains\('([^']*)'\)/g, ":has-text('$1')");

  // :visible → visible jQuery pseudo — use Playwright's :visible pseudo class
  // Playwright supports :visible natively in CSS selectors
  sel = sel.replace(/:visible/g, ':visible');

  // :first → nth=0 (jQuery shorthand)
  sel = sel.replace(/:first\b/, ' >> nth=0');

  // :last → nth=-1
  sel = sel.replace(/:last\b/, ' >> nth=-1');

  // :eq(n) → nth=n
  sel = sel.replace(/:eq\((\d+)\)/g, ' >> nth=$1');

  // `>> nth=N` is Playwright's engine prefix for a chained position filter.
  // It does NOT compose with a descendant on the same chain segment — a
  // selector like `tbody tr >> nth=0 a` would be parsed as nth=0 receiving
  // `0 a` as its argument. Insert a second `>>` separator before any
  // trailing content so the descendant becomes a fresh chained query.
  sel = sel.replace(/(>>\s*nth=-?\d+)\s+(?=\S)/g, '$1 >> ');

  // Reference-framework extended sibling combinators: any sequence of 2+
  // consecutive '+' signs maps to the CSS general sibling combinator (~).
  // The count may vary per locator.
  sel = sel.replace(/\s*\+{2,}\s*/g, ' ~ ');

  return sel;
}

// ─── Text comparison helpers ──────────────────────────────────────────────────

export type CompareOp = 'be' | 'contain' | 'start with' | 'end with' | 'match regex';

export interface AssertTextOpts {
  /** Strip leading/trailing whitespace from actual and expected before comparing. */
  trim?: boolean;
  /** Perform case-insensitive comparison. */
  ignoreCase?: boolean;
}

/**
 * Compare actual vs expected using the given operator.
 * Throws an AssertionError if the comparison fails (or should fail when negated).
 * Supports @Trim and @IgnoreCase StepDef-level modifiers via opts.
 */
export function assertText(
  actual: string,
  op: CompareOp,
  expected: string,
  negate: boolean,
  context: string,
  opts?: AssertTextOpts
): void {
  let a = actual;
  let e = expected;
  if (opts?.trim)       { a = a.trim(); e = e.trim(); }
  if (opts?.ignoreCase) { a = a.toLowerCase(); e = e.toLowerCase(); }

  let passes: boolean;

  switch (op) {
    case 'be':
      passes = a === e;
      break;
    case 'contain':
      passes = a.includes(e);
      break;
    case 'start with':
      passes = a.startsWith(e);
      break;
    case 'end with':
      passes = a.endsWith(e);
      break;
    case 'match regex':
      passes = new RegExp(opts?.ignoreCase ? e : expected, opts?.ignoreCase ? 'i' : '').test(a);
      break;
    default:
      passes = false;
  }

  if (negate ? passes : !passes) {
    const notStr = negate ? ' not' : '';
    throw new DslAssertionError(
      `Expected ${context} to${notStr} ${op} "${expected}" but got "${actual}"`
    );
  }
}

// ─── DSL error type ───────────────────────────────────────────────────────────

export class DslAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DslAssertionError';
  }
}

export class DslStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DslStepError';
  }
}
