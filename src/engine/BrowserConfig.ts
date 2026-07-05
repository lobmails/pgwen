/**
 * engine/BrowserConfig.ts — Browser configuration for pgwen.
 *
 * Reads browser settings from the layered pgwen.conf / profile config and
 * provides a typed BrowserConfig object used by PlaywrightRunner and Repl.
 *
 * Supported pgwen.conf keys (the reference framework-faithful — same keys the reference framework projects use):
 *   pgwen.target.browser           chromium | firefox | webkit            (default: chromium)
 *   pgwen.web.browser.headless     true | false                           (default: true)
 *   pgwen.web.browser.size         WxH, e.g. "1920x1080"                 (default: 1280x720)
 *   pgwen.web.capture.video        off | on | retain-on-failure           (default: off)
 *   pgwen.web.useragent            User-Agent string (the reference framework-compatible)    (default: undefined)
 *   pgwen.browser.slowMo           number (ms) — pgwen extension          (default: 0)
 *   pgwen.browser.trace            off | on | retain-on-failure — pgwen   (default: off)
 *   pgwen.browser.args             JSON array of extra browser args        (default: [])
 *   pgwen.web.wait.seconds         Default locator/action timeout in seconds (default: 30)
 *                                 Matches the client's pgwen.conf key; pgwen.web.locator.wait.seconds
 *                                 derives from this value via HOCON substitution.
 *   pgwen.web.remote.url           WebSocket or CDP endpoint URL for remote browser
 *                                 (e.g. ws://browser-server:3000/pgwen).
 *                                 When set, Playwright connects instead of launching locally.
 *                                 WebDriver-style `/wd/hub` URLs are rejected with a
 *                                 clear error — Playwright cannot speak the WebDriver
 *                                 protocol. See docker-compose.grid.yml for the
 *                                 Playwright Browser Server pattern.
 *
 * WebDriver-style capabilities recognised inside pgwen.web.capabilities.* and
 * translated to Playwright equivalents (the reference framework projects already use these idioms):
 *   pageLoadStrategy               eager | normal | none → goto waitUntil
 *   acceptInsecureCerts            true | false          → context ignoreHTTPSErrors
 *   locale                         e.g. "en-AU"          → context locale
 *   se:timeZone                    e.g. "Australia/Sydney" → context timezoneId
 *   proxy.proxyType / .httpProxy / .sslProxy / .noProxy → context proxy
 */

import type { Config } from './ProfileLoader';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BrowserType = 'chromium' | 'firefox' | 'webkit';
export type VideoMode = 'off' | 'on' | 'retain-on-failure';
export type TraceMode = 'off' | 'on' | 'retain-on-failure';
export type PageLoadStrategy = 'eager' | 'normal' | 'none';
export type WaitUntilOption = 'domcontentloaded' | 'load' | 'commit';

export interface ProxySettings {
  /** Proxy server URL, e.g. "http://host:port" or "socks5://host:port". */
  server: string;
  /** Comma-separated list of hosts that bypass the proxy. */
  bypass?: string;
  username?: string;
  password?: string;
}

export interface BrowserConfig {
  /** Playwright browser engine. Default: 'chromium' */
  type: BrowserType;
  /** Run browser without visible window. Default: true */
  headless: boolean;
  /** Milliseconds to slow each action by (for debugging). Default: 0 */
  slowMo: number;
  /** Browser viewport dimensions. */
  viewport: { width: number; height: number };
  /** Video recording mode. Default: 'off' */
  video: VideoMode;
  /** Playwright trace recording mode. Default: 'off' */
  trace: TraceMode;
  /** Extra command-line arguments forwarded to the browser binary. */
  args: string[];
  /**
   * Maximise the browser window on launch.
   * Maps to pgwen.web.maximize. Default: false.
   * Playwright equivalent: viewport=null + --start-maximized arg (Chromium).
   */
  maximize: boolean;
  /**
   * Default locator/action timeout in seconds.
   * Applied as Playwright's page default timeout after each page is created.
   * Reads pgwen.web.wait.seconds — the same key that pgwen.web.locator.wait.seconds
   * derives from in the client's HOCON config.
   * Default: 30 (matches the reference framework and Playwright built-in defaults).
   */
  waitSeconds: number;
  /**
   * Remote browser endpoint URL.
   * If set, Playwright connects to this endpoint instead of launching locally.
   * Use a WebSocket URL (ws://…) for Playwright Server, or an HTTP/WS URL for
   * WebDriver-style grid CDP (ws://grid:4444/session/<id>/se/cdp). WebDriver-style
   * WebDriver `/wd/hub` URLs are rejected at connect time.
   * Maps to pgwen.web.remote.url. Default: undefined (local launch).
   */
  remoteUrl?: string;
  /**
   * Extra capabilities forwarded from pgwen.web.capabilities.* config keys.
   * the reference framework projects set these for WebDriver-style grid — pgwen reads the recognised keys
   * (browserName → type override, screenResolution → viewport) and passes
   * the rest through as-is for grid-specific use.
   */
  capabilities?: Record<string, string>;
  /**
   * Default page-load wait strategy applied to navigation steps (goto/reload/
   * goBack/goForward). Sourced from the WebDriver-style-standard capability
   * `pgwen.web.capabilities.pageLoadStrategy` — the reference framework projects already use this
   * idiom. Undefined leaves Playwright's built-in default ('load') in place.
   */
  pageLoadStrategy?: PageLoadStrategy;
  /**
   * If true, the browser context ignores HTTPS certificate errors.
   * Sourced from `pgwen.web.capabilities.acceptInsecureCerts` (W3C standard).
   */
  ignoreHTTPSErrors?: boolean;
  /** BCP-47 locale, e.g. "en-AU". From `pgwen.web.capabilities.locale`. */
  locale?: string;
  /** timezone, e.g. "Australia/Sydney". From `pgwen.web.capabilities.se:timeZone`. */
  timezoneId?: string;
  /** Default User-Agent applied at context creation. From `pgwen.web.useragent`. */
  userAgent?: string;
  /** Proxy settings. Sourced from `pgwen.web.capabilities.proxy.*` (WebDriver-style proxy capability). */
  proxy?: ProxySettings;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  type: 'chromium',
  headless: true,
  slowMo: 0,
  viewport: { width: 1280, height: 720 },
  video: 'off',
  trace: 'off',
  args: [],
  waitSeconds: 30,
  maximize: false,
};

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Build a BrowserConfig from a loaded pgwen config object, falling back to
 * defaults for any missing keys.  An explicit overrides object can be supplied
 * to layer CLI flags (e.g. --headed) on top.
 */
export function resolveBrowserConfig(
  config: Config,
  overrides: Partial<BrowserConfig> = {}
): BrowserConfig {
  const raw = (key: string): string | undefined => config[key];

  // Collect pgwen.web.capabilities.* into a flat record
  const capabilities: Record<string, string> = {};
  const capPrefix = 'pgwen.web.capabilities.';
  for (const [k, v] of Object.entries(config)) {
    if (k.startsWith(capPrefix) && v !== undefined) {
      capabilities[k.slice(capPrefix.length)] = v;
    }
  }

  // pgwen.web.capabilities.browserName overrides pgwen.target.browser when present
  const capBrowserName = capabilities['browserName'] ? parseType(mapCapBrowserName(capabilities['browserName'])) : undefined;
  const type = capBrowserName ?? parseType(raw('pgwen.target.browser')) ?? DEFAULT_BROWSER_CONFIG.type;

  // pgwen.web.browser.headless — matches the reference framework config key
  const headless = parseBool(raw('pgwen.web.browser.headless')) ?? DEFAULT_BROWSER_CONFIG.headless;
  // pgwen.web.throttle.msecs mirrors the reference framework's pgwen.web.throttle.msecs (per-action delay);
  // pgwen.browser.slowMo is the Playwright-native override — either key works
  const slowMo = parseNum(raw('pgwen.browser.slowMo'))
    ?? parseNum(raw('pgwen.web.throttle.msecs'))
    ?? DEFAULT_BROWSER_CONFIG.slowMo;

  // pgwen.web.capabilities.screenResolution overrides pgwen.web.browser.size
  const capResolution = capabilities['screenResolution'] ? parseViewportSize(capabilities['screenResolution'].replace('x', 'x')) : undefined;
  // pgwen.web.browser.size — "WxH" format, e.g. "1920x1080" — matches the reference framework config key
  const sizeViewport = capResolution ?? parseViewportSize(raw('pgwen.web.browser.size'));
  const viewportWidth = sizeViewport?.width ?? DEFAULT_BROWSER_CONFIG.viewport.width;
  const viewportHeight = sizeViewport?.height ?? DEFAULT_BROWSER_CONFIG.viewport.height;

  // pgwen.web.capture.video — matches the reference framework config key
  const video = parseVideoMode(raw('pgwen.web.capture.video')) ?? DEFAULT_BROWSER_CONFIG.video;
  const trace = parseTraceMode(raw('pgwen.browser.trace')) ?? DEFAULT_BROWSER_CONFIG.trace;
  const args = parseArgs(raw('pgwen.browser.args')) ?? DEFAULT_BROWSER_CONFIG.args;
  const waitSeconds = parseNum(raw('pgwen.web.wait.seconds')) ?? DEFAULT_BROWSER_CONFIG.waitSeconds;
  const remoteUrl = raw('pgwen.web.remote.url');
  const maximize = parseBool(raw('pgwen.web.maximize')) ?? DEFAULT_BROWSER_CONFIG.maximize;

  // Translate W3C/WebDriver-style capabilities → Playwright equivalents.
  // the reference framework projects already set these via pgwen.web.capabilities.* — honour them
  // so existing configs work in pgwen with no rewrite.
  const pageLoadStrategy = parsePageLoadStrategy(capabilities['pageLoadStrategy']);
  const ignoreHTTPSErrors = parseBool(capabilities['acceptInsecureCerts']);
  const locale = capabilities['locale']?.trim() || undefined;
  // WebDriver-style grid convention: "se:timeZone" — flat HOCON key includes the colon
  const timezoneId = capabilities['se:timeZone']?.trim() || undefined;
  const userAgent = raw('pgwen.web.useragent')?.trim() || undefined;
  const proxy = parseProxy(capabilities);

  return {
    type,
    headless,
    slowMo,
    viewport: { width: viewportWidth, height: viewportHeight },
    video,
    trace,
    args,
    waitSeconds,
    maximize,
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(pageLoadStrategy !== undefined ? { pageLoadStrategy } : {}),
    ...(ignoreHTTPSErrors !== undefined ? { ignoreHTTPSErrors } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(timezoneId !== undefined ? { timezoneId } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...overrides,
  };
}

/**
 * Map a WebDriver-style pageLoadStrategy value to the Playwright `waitUntil` option
 * used by page.goto / page.reload / page.goBack / page.goForward.
 *
 *   eager  → 'domcontentloaded'  (DOM parsed, sub-resources still loading)
 *   normal → 'load'              (full load event — Playwright default)
 *   none   → 'commit'            (navigation committed, no wait at all)
 *
 * Returns undefined for any unrecognised input so callers fall back to the
 * Playwright default.
 */
export function mapPageLoadStrategyToWaitUntil(
  strategy: string | undefined,
): WaitUntilOption | undefined {
  const parsed = parsePageLoadStrategy(strategy);
  if (parsed === undefined) return undefined;
  switch (parsed) {
    case 'eager':  return 'domcontentloaded';
    case 'normal': return 'load';
    case 'none':   return 'commit';
  }
}

/**
 * Map WebDriver-style/WebDriver browserName values to pgwen BrowserType strings.
 * WebDriver-style uses "chrome" / "MicrosoftEdge" / "firefox", Playwright uses "chromium".
 */
function mapCapBrowserName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower === 'chrome' || lower === 'googlechrome' || lower === 'microsoftedge' || lower === 'edge') {
    return 'chromium';
  }
  return lower; // 'firefox' and 'webkit'/'safari' pass through — parseType handles validation
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseType(val: string | undefined): BrowserType | undefined {
  if (!val) return undefined;
  const lower = val.toLowerCase().trim();
  if (lower === 'chromium' || lower === 'firefox' || lower === 'webkit') {
    return lower;
  }
  return undefined;
}

function parseBool(val: string | undefined): boolean | undefined {
  if (!val) return undefined;
  const lower = val.toLowerCase().trim();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

function parseNum(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}

function parseVideoMode(val: string | undefined): VideoMode | undefined {
  if (!val) return undefined;
  const lower = val.toLowerCase().trim();
  if (lower === 'off' || lower === 'false') return 'off';
  if (lower === 'on'  || lower === 'true')  return 'on';
  if (lower === 'retain-on-failure') return 'retain-on-failure';
  return undefined;
}

function parseTraceMode(val: string | undefined): TraceMode | undefined {
  if (!val) return undefined;
  const lower = val.toLowerCase().trim();
  if (lower === 'off' || lower === 'on' || lower === 'retain-on-failure') {
    return lower as TraceMode;
  }
  return undefined;
}

/**
 * Parse "WxH" or "W x H" viewport size string (e.g. "1920x1080").
 * Returns undefined for any other format.
 */
function parseViewportSize(val: string | undefined): { width: number; height: number } | undefined {
  if (!val) return undefined;
  const m = val.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!m) return undefined;
  const width = parseInt(m[1]!, 10);
  const height = parseInt(m[2]!, 10);
  return isNaN(width) || isNaN(height) ? undefined : { width, height };
}

function parsePageLoadStrategy(val: string | undefined): PageLoadStrategy | undefined {
  if (!val) return undefined;
  const lower = val.toLowerCase().trim();
  if (lower === 'eager' || lower === 'normal' || lower === 'none') return lower;
  return undefined;
}

/**
 * Build a Playwright proxy object from the WebDriver-style proxy capability keys.
 * WebDriver-style spec keys (W3C): proxyType, httpProxy, sslProxy, ftpProxy,
 * socksProxy, noProxy, socksUsername, socksPassword.
 *
 * Playwright maps these to a single { server, bypass, username, password }
 * object. We pick sslProxy first (HTTPS projects are the common case), then
 * httpProxy, then socksProxy. Returns undefined if no proxy server is set.
 */
function parseProxy(caps: Record<string, string>): ProxySettings | undefined {
  const proxyType = caps['proxy.proxyType']?.toLowerCase().trim();
  // WebDriver-style "direct" / "system" / "autodetect" → no manual proxy
  if (proxyType && proxyType !== 'manual') return undefined;

  const sslProxy = caps['proxy.sslProxy']?.trim();
  const httpProxy = caps['proxy.httpProxy']?.trim();
  const socksProxy = caps['proxy.socksProxy']?.trim();

  const host = sslProxy ?? httpProxy ?? socksProxy;
  if (!host) return undefined;

  // Normalise: if the user wrote "host:port", prefix with scheme so Playwright accepts it
  const server = /^[a-z][a-z0-9+.-]*:\/\//i.test(host)
    ? host
    : (socksProxy && !httpProxy && !sslProxy ? `socks5://${host}` : `http://${host}`);

  const result: ProxySettings = { server };
  const bypass = caps['proxy.noProxy']?.trim();
  if (bypass) result.bypass = bypass;
  const username = caps['proxy.socksUsername']?.trim();
  if (username) result.username = username;
  const password = caps['proxy.socksPassword']?.trim();
  if (password) result.password = password;
  return result;
}

function parseArgs(val: string | undefined): string[] | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through
    }
  }
  // Single arg without brackets
  return trimmed ? [trimmed] : [];
}
