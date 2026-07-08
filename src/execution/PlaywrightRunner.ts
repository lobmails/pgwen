/**
 * execution/PlaywrightRunner.ts — Playwright browser lifecycle manager for pgwen.
 *
 * Wraps the core Runner with browser launch/close logic so feature files can
 * be executed against a real (or headless) browser.
 *
 * Design principles:
 *   - One browser instance per run; each feature gets its own BrowserContext for isolation.
 *   - Playwright is imported dynamically so dry-run mode never requires browser binaries.
 *   - Video and trace recording are handled per-context, not per-page.
 *   - Errors during browser launch / teardown are surfaced clearly, not swallowed.
 *
 * Sequential execution:
 *   new PlaywrightRunner(config).runFeatures(files, options)
 *
 * Parallel execution:
 *   new PlaywrightRunner(config).runFeaturesParallel(files, options)
 *   Each feature runs in its own BrowserContext (same browser process, isolated cookie/storage).
 */

import * as path from 'path';
import * as fs from 'fs';
import { Runner, type RunOptions, type RunResult } from './Runner';
import type { Scope } from '../engine/Scope';
import { buildParallelResult, type ParallelRunResult } from './ParallelRunnerUtils';
import { SyncGate } from './SyncGate';
import { ScreenshotCapture } from '../reporting/ScreenshotCapture';
import type { BrowserConfig } from '../engine/BrowserConfig';
import { DialogQueue, attachQueue, detachQueue } from '../dsl/actions/DialogManager';

// ─── PlaywrightRunner ─────────────────────────────────────────────────────────

export interface PlaywrightRunnerOptions {
  /**
   * Base output directory — mirrors the `--output` CLI flag.
   * Videos are written to:  <outputDir>/reports/html/attachments/videos/<slug>.webm
   * Traces are written to:  <outputDir>/traces/<slug>.zip
   * Matches the CI artifact glob (Jenkins / Azure Pipelines / GitHub Actions): pgwen/output/reports/html/** /attachments/videos/*
   * Default: 'pgwen/output'
   */
  outputDir?: string;
  /**
   * Stop running features after the first failed feature.
   * Maps to pgwen.feature.failfast.exit. Default: false.
   */
  failfastExit?: boolean;
  /**
   * Capture a full-page screenshot on scenario failure.
   * Screenshots are written to: <outputDir>/reports/html/attachments/screenshots/<slug>.png
   * Maps to pgwen.web.capture.screenshots.enabled. Default: false.
   */
  screenshotOnFailure?: boolean;
  /**
   * Called after each feature file completes (sequential or dry-run).
   * Enables real-time streaming output so the console shows progress during long runs.
   */
  onFeatureComplete?: (results: RunResult[], featureFile: string) => void;
  /**
   * Called as soon as each data-feed record's RunResult is finalised — before
   * the next record runs. Receives the just-completed RunResult and the source
   * feature file path. For non-feed features (single record) this fires once.
   *
   * Preserves per-record streaming: HTML report updates per-record as
   * each CSV/JSON record completes, not after the whole file finishes.
   */
  onRecordComplete?: (result: RunResult, featureFile: string) => void | Promise<void>;
}

export class PlaywrightRunner {
  private readonly config: BrowserConfig;
  private readonly outputDir: string;
  private readonly failfastExit: boolean;
  private readonly screenshotOnFailure: boolean;
  private readonly onFeatureComplete: ((results: RunResult[], featureFile: string) => void) | undefined;
  private readonly onRecordComplete: ((result: RunResult, featureFile: string) => void | Promise<void>) | undefined;

  /**
   * The Scope from the most recently completed feature run.
   * Captured via the onScopeCreated callback and retained after execution so the
   * post-execution REPL can inherit all bound variables from the last scenario.
   */
  private _lastScope: Scope | undefined;

  /** The live Playwright page from the most recently completed feature run (if any). */
  private _lastPage: unknown;

  /** Scope from the most recently completed feature run — for REPL retention. */
  get lastScope(): Scope | undefined { return this._lastScope; }

  /** Live page from the most recently completed feature run — for REPL retention. */
  get lastPage(): unknown { return this._lastPage; }

  constructor(config: BrowserConfig, options: PlaywrightRunnerOptions = {}) {
    this.config = config;
    this.outputDir = options.outputDir ?? 'pgwen/output';
    this.failfastExit = options.failfastExit ?? false;
    this.screenshotOnFailure = options.screenshotOnFailure ?? false;
    this.onFeatureComplete = options.onFeatureComplete;
    this.onRecordComplete = options.onRecordComplete;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run a single feature file in a new browser context.
   * The browser is launched and closed for this one run.
   * Returns one RunResult per data-feed record (or a single-element array when no feed).
   */
  async runFeature(featureFile: string, options: RunOptions = {}): Promise<RunResult[]> {
    const pw = await importPlaywright();
    const browser = await this.launchOrConnect(pw);

    try {
      return await this.runInContext(browser, featureFile, options);
    } finally {
      await browser.close();
    }
  }

  /**
   * Run multiple feature files sequentially, sharing one browser instance.
   * Each feature gets its own BrowserContext for isolation.
   */
  async runFeatures(featureFiles: string[], options: RunOptions = {}): Promise<RunResult[]> {
    if (featureFiles.length === 0) return [];

    const pw = await importPlaywright();
    const browser = await this.launchOrConnect(pw);
    const results: RunResult[] = [];

    try {
      for (let i = 0; i < featureFiles.length; i++) {
        const fileResults = await this.runInContext(browser, featureFiles[i]!, { ...options, sequenceNo: i + 1 });
        results.push(...fileResults);
        this.onFeatureComplete?.(fileResults, featureFiles[i]!);
        if (this.failfastExit && fileResults.some((r) => r.status === 'failed')) break;
      }
    } finally {
      await browser.close();
    }

    return results;
  }

  /**
   * Run multiple feature files in parallel, sharing one browser instance.
   * Each feature runs concurrently in its own BrowserContext.
   * maxWorkers limits concurrency — default: all files at once.
   */
  async runFeaturesParallel(
    featureFiles: string[],
    options: RunOptions & { maxWorkers?: number } = {}
  ): Promise<ParallelRunResult> {
    if (featureFiles.length === 0) {
      return buildParallelResult([]);
    }

    const pw = await importPlaywright();
    const browser = await this.launchOrConnect(pw);
    const maxConcurrent = options.maxWorkers ?? featureFiles.length;

    // Shared gate ensures @Synchronized StepDefs execute exclusively
    const syncGate = new SyncGate();
    const parallelOptions: RunOptions & { maxWorkers?: number } = {
      ...options,
      syncGate,
    };

    // Resolve ramp-up interval: stagger worker starts within each batch by
    // `pgwen.rampup.interval.seconds` (-parity setting). 0 / unset =
    // simultaneous starts up to maxConcurrent.
    const cfgRampupRaw = options.config?.['pgwen.rampup.interval.seconds'];
    const cfgRampup = cfgRampupRaw !== undefined ? parseFloat(cfgRampupRaw) : NaN;
    const rampupMs = Number.isFinite(cfgRampup) && cfgRampup > 0 ? cfgRampup * 1000 : 0;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const results: RunResult[] = [];
    try {
      for (let i = 0; i < featureFiles.length; i += maxConcurrent) {
        const batch = featureFiles.slice(i, i + maxConcurrent);
        const promises: Array<Promise<RunResult[]>> = [];
        for (let batchIdx = 0; batchIdx < batch.length; batchIdx += 1) {
          if (batchIdx > 0 && rampupMs > 0) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(rampupMs);
          }
          promises.push(
            this.runInContext(browser, batch[batchIdx]!, {
              ...parallelOptions,
              sequenceNo: i + batchIdx + 1,
            }),
          );
        }
        const batchResults = await Promise.all(promises);
        for (const fileResults of batchResults) results.push(...fileResults);
        if (this.failfastExit && batchResults.flat().some((r) => r.status === 'failed')) break;
      }
    } finally {
      await browser.close();
    }

    return buildParallelResult(results);
  }

  /**
   * Run features in dry-run mode — NO browser is launched.
   *
   * Matches -bn behaviour: executes the full feature/meta pipeline
   * with dryRun:true so all browser-dependent DSL steps pass silently.
   * @DryRun(name=,value=) bindings are injected before interpolation.
   * HTML/JUnit/JSON reports are generated normally from the RunResults.
   *
   * Call this instead of runFeatures() when options.dryRun is true.
   */
  async runFeaturesDry(featureFiles: string[], options: RunOptions): Promise<RunResult[]> {
    const runner = new Runner();
    const results: RunResult[] = [];
    for (let i = 0; i < featureFiles.length; i++) {
      const file = featureFiles[i]!;
      const onRecordComplete = this.onRecordComplete;
      const fileResults = await runner.runFeature(file, {
        ...options,
        dryRun: true,
        page: undefined,
        sequenceNo: i + 1,
        ...(onRecordComplete ? {
          onRecordComplete: async (r: RunResult) => { await onRecordComplete(r, file); },
        } : {}),
      });
      results.push(...fileResults);
      this.onFeatureComplete?.(fileResults, file);
      if (this.failfastExit && fileResults.some((r) => r.status === 'failed')) break;
    }
    return results;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async runInContext(
    browser: PlaywrightBrowser,
    featureFile: string,
    options: RunOptions
  ): Promise<RunResult[]> {
    const slug = path.basename(featureFile, path.extname(featureFile));

    // Video: Playwright needs a tmp dir to record into; we rename the file after
    // context.close() finalises it, moving it into the HTML report tree so that
    // A CI job can archive it via: pgwen/output/reports/html/**/attachments/videos/*
    const videoOutputDir = this.config.video !== 'off'
      ? path.join(this.outputDir, 'reports', 'html', 'attachments', 'videos')
      : undefined;

    // Playwright writes a random UUID.webm into this tmp dir while recording
    const videoTmpDir = videoOutputDir
      ? path.join(this.outputDir, '.video-tmp')
      : undefined;

    if (videoTmpDir) {
      fs.mkdirSync(videoTmpDir, { recursive: true });
    }

    // Downloads: use <outputDir>/downloads as the target directory so project steps
    // can reference ${pgwen.downloadDir} to construct expected file paths.
    const downloadDir = path.resolve(path.join(this.outputDir, 'downloads'));
    fs.mkdirSync(downloadDir, { recursive: true });

    const contextOptions: PlaywrightContextOptions = buildContextOptions(
      this.config,
      downloadDir,
      videoTmpDir,
    );

    // Lazy context + page — browser window only opens when the first step that
    // actually touches the page runs (e.g. "I navigate to …").
    // This eliminates the blank browser window that would otherwise flash before
    // meta loading and feature parsing complete.
    let activeContext: PlaywrightBrowserContext | undefined;
    let activePage: PlaywrightPage | undefined;

    // Dialog queue — created before any steps run so it's ready when the real
    // page is created.  Attached to the lazy proxy so DSL handlers can look it up.
    const dialogQueue = new DialogQueue();

    const attachDialogHandler = (p: PlaywrightPage): void => {
      (p as unknown as { on(e: string, h: unknown): void }).on(
        'dialog',
        (d: unknown) => dialogQueue.handleIncoming(d as import('../dsl/locatorUtils').DialogLike)
      );
    };

    const suppressImages = (options.config?.['pgwen.web.suppress.images'] ?? 'false') === 'true';

    const ensurePage = async (): Promise<PlaywrightPage> => {
      if (activePage) return activePage;
      activeContext = await browser.newContext(contextOptions);
      if (this.config.trace !== 'off') {
        await activeContext.tracing.start({ screenshots: true, snapshots: true });
      }
      activePage = await activeContext.newPage();
      activePage.setDefaultTimeout(this.config.waitSeconds * 1000);
      attachDialogHandler(activePage);
      if (suppressImages) {
        await (activePage as unknown as {
          route(pattern: string | RegExp, handler: (route: { abort(): Promise<void> }, request: { resourceType(): string }) => Promise<void>): Promise<void>
        }).route('**/*', async (route, request) => {
          if (request.resourceType() === 'image') {
            await route.abort();
          } else {
            await (route as unknown as { continue(): Promise<void> }).continue();
          }
        });
      }
      return activePage;
    };

    // Page proxy: all method calls are forwarded to the real page, triggering
    // lazy context/page creation on first browser interaction.
    // setActivePage lets window-switch handlers swap the routed page so that
    // subsequent locator / action steps target the new tab.
    const setActivePage = (p: unknown): void => { activePage = p as PlaywrightPage; };
    const lazyPage = makeLazyPageProxy(
      ensurePage as () => Promise<unknown>,
      () => activePage as unknown,
      setActivePage,
    );

    // Register the dialog queue against this proxy so DSL handlers can retrieve it.
    attachQueue(lazyPage as object, dialogQueue);

    // Page factory: creates a fresh page for each data-feed iteration so that
    // a project that calls "I close the current browser" does not invalidate the page
    // for subsequent records. Ensures the context is created first.
    const waitSeconds = this.config.waitSeconds;
    const pageFactory = async (): Promise<unknown> => {
      if (!activeContext) await ensurePage();
      const p = await activeContext!.newPage();
      p.setDefaultTimeout(waitSeconds * 1000);
      attachDialogHandler(p);
      activePage = p;
      return p;
    };

    // Generate a unique session ID for this browser context run.
    // Exposed as ${pgwen.web.sessionId} so steps can build Selenoid-style download URLs.
    // Uses Node.js 18+ global crypto.randomUUID().
    const webSessionId = crypto.randomUUID();

    let results: RunResult[];

    try {
      const runner = new Runner();
      const onRecordComplete = this.onRecordComplete;
      results = await runner.runFeature(featureFile, {
        ...options,
        page: lazyPage, pageFactory, webSessionId, downloadDir,
        // Snapshot after each scenario (last one wins) — taken just before the
        // scenario frame is popped so @Eager-evaluated bindings (e.g. todayIso)
        // are still present alongside the feature-level feed data.
        onScenarioComplete: (s) => { this._lastScope = s.snapshot(); },
        ...(onRecordComplete ? {
          onRecordComplete: async (r: RunResult) => { await onRecordComplete(r, featureFile); },
        } : {}),
      });
      // Retain the live page reference (before context is closed) for REPL attachment.
      this._lastPage = activePage;
    } catch (err) {
      // Ensure context is closed even on unexpected runner error
      if (activeContext) await safeClose(activeContext);
      throw err;
    }

    // Screenshot on failure — capture before context is closed (page still live).
    // Only attempted if a page was ever created (browser-touching steps ran).
    if (activePage && this.screenshotOnFailure && results.some((r) => r.status === 'failed')) {
      const screenshotDir = path.join(
        this.outputDir, 'reports', 'html', 'attachments', 'screenshots'
      );
      await ScreenshotCapture.capture(activePage, path.join(screenshotDir, `${slug}.png`));
    }

    // Handle trace — stop before context close so the file is complete
    if (activeContext && this.config.trace !== 'off') {
      const shouldSaveTrace =
        this.config.trace === 'on' ||
        (this.config.trace === 'retain-on-failure' && results.some((r) => r.status === 'failed'));

      if (shouldSaveTrace) {
        const traceDir = path.join(this.outputDir, 'traces');
        fs.mkdirSync(traceDir, { recursive: true });
        const traceZipPath = path.join(traceDir, `${slug}.zip`);
        await activeContext.tracing.stop({ path: traceZipPath });
        for (const r of results) r.tracePath = traceZipPath;
      } else {
        await activeContext.tracing.stop({});
      }
    }

    // Capture video reference BEFORE closing context — the reference becomes
    // unusable for path() after close if we don't grab it first
    const videoRef = (videoTmpDir && activePage) ? activePage.video() : null;

    if (activeContext) await safeClose(activeContext);
    detachQueue(lazyPage as object);

    // After context.close() the video file is finalised (Playwright flushes it).
    // Move/rename to the target path, or delete if we don't want to keep it.
    if (videoRef && videoOutputDir) {
      const anyFailed = results.some((r) => r.status === 'failed');
      const shouldKeep =
        this.config.video === 'on' ||
        (this.config.video === 'retain-on-failure' && anyFailed);

      if (shouldKeep) {
        try {
          const tmpPath = await videoRef.path();
          if (tmpPath !== null) {
            fs.mkdirSync(videoOutputDir, { recursive: true });
            const finalVideoPath = path.join(videoOutputDir, `${slug}.webm`);
            await fs.promises.rename(tmpPath, finalVideoPath);
            for (const r of results) {
              r.videoPaths = [finalVideoPath];
            }
          }
        } catch { /* ignore rename errors */ }
      } else {
        try { await videoRef.delete(); } catch { /* ignore */ }
      }
    }

    return results;
  }

  /**
   * Launch a local browser or connect to a remote endpoint, depending on config.
   *
   * Remote URL semantics:
   *  - ws:// or wss:// → Playwright Server WebSocket (browserType.connect)
   *  - http:// or https:// or bare host → CDP endpoint (browserType.connectOverCDP)
   */
  private async launchOrConnect(pw: PlaywrightModule): Promise<PlaywrightBrowser> {
    const browserType = pw[this.config.type];
    if (this.config.remoteUrl) {
      const url = this.config.remoteUrl;
      assertNotWebDriverUrl(url);
      if (url.startsWith('ws://') || url.startsWith('wss://')) {
        return browserType.connect(url);
      }
      return browserType.connectOverCDP(url);
    }
    return browserType.launch(this.buildLaunchOptions());
  }

  private buildLaunchOptions(): PlaywrightLaunchOptions {
    const opts: PlaywrightLaunchOptions = { headless: this.config.headless };
    if (this.config.slowMo > 0) opts.slowMo = this.config.slowMo;
    // maximize=true adds --start-maximized for Chromium (no-op on Firefox/WebKit)
    const extraArgs = this.config.maximize && this.config.type === 'chromium'
      ? ['--start-maximized']
      : [];
    const allArgs = [...this.config.args, ...extraArgs];
    if (allArgs.length > 0) opts.args = allArgs;
    return opts;
  }
}

// ─── Lazy page proxy ─────────────────────────────────────────────────────────

/**
 * Returns a Proxy that forwards all page method calls to the real Playwright
 * page, creating the browser context + page lazily on first use.
 * Prevents the blank browser window that would otherwise appear during meta
 * loading and feature parsing before the first browser-touching step runs.
 */
function makeLazyPageProxy(
  ensurePage: () => Promise<unknown>,
  currentPage: () => unknown,
  setActivePage?: (p: unknown) => void,
): unknown {
  const makeContextProxy = () =>
    new Proxy({} as object, {
      get(_t, prop: string | symbol) {
        if (prop === 'then') return undefined;
        if (prop === 'pages') {
          return (): unknown[] => {
            const p = currentPage();
            if (!p) return [];
            return (p as { context(): { pages(): unknown[] } }).context().pages();
          };
        }
        return async (...args: unknown[]) => {
          const page = await ensurePage();
          const c = (page as { context(): Record<string, (...a: unknown[]) => unknown> }).context();
          const fn = c[prop as string];
          return typeof fn === 'function' ? fn.apply(c, args) : fn;
        };
      },
    });

  const makeSubProxy = (propName: string) =>
    new Proxy({} as object, {
      get(_t, subProp: string | symbol) {
        if (subProp === 'then') return undefined;
        return async (...args: unknown[]) => {
          const page = await ensurePage();
          const parent = (page as Record<string, Record<string, (...a: unknown[]) => unknown>>)[propName];
          const fn = parent?.[subProp as string];
          return typeof fn === 'function' ? fn.apply(parent, args) : fn;
        };
      },
    });

  return new Proxy({} as object, {
    get(_t, prop: string | symbol) {
      if (prop === 'then') return undefined;
      // Hooks used by window-switch handlers in src/dsl/actions/windows.ts:
      //   __pgwenSetActivePage(p)  → swap which page the proxy routes to
      //   __pgwenGetActivePage()   → identify the current real page (so the
      //                              switch handler can locate it in pages())
      if (prop === '__pgwenSetActivePage') {
        return (p: unknown): void => { setActivePage?.(p); };
      }
      if (prop === '__pgwenGetActivePage') {
        return (): unknown => currentPage();
      }
      if (prop === 'context') return () => makeContextProxy();
      if (prop === 'url') {
        return (): string => {
          const p = currentPage();
          return p ? (p as { url(): string }).url() : '';
        };
      }
      if (prop === 'keyboard' || prop === 'touchscreen' || prop === 'request') {
        return makeSubProxy(prop as string);
      }
      return async (...args: unknown[]) => {
        const page = await ensurePage();
        const fn = (page as Record<string, (...a: unknown[]) => unknown>)[prop as string];
        return typeof fn === 'function' ? fn.apply(page, args) : fn;
      };
    },
  });
}

// ─── Remote URL validation ────────────────────────────────────────────────────

/**
 * WebDriver-style endpoints expose a `/wd/hub` path. Playwright cannot
 * connect to a WebDriver-style grid hub — it speaks either the Playwright Server
 * WebSocket protocol or Chrome DevTools Protocol. Projects migrating from 
 * commonly leave the old `http://hub:4444/wd/hub` URL in their config, which
 * would otherwise surface as an opaque connect failure from Playwright.
 */
export function assertNotWebDriverUrl(url: string): void {
  if (/\/wd\/hub(?:[/?#]|$)/.test(url)) {
    throw new Error(
      `pgwen.web.remote.url='${url}' looks like a WebDriver-style endpoint (/wd/hub). ` +
      `pgwen runs on Playwright and cannot connect to a WebDriver-style grid hub directly. ` +
      `Point it at a Playwright Browser Server WebSocket instead ` +
      `(e.g. ws://browser-server:3000/pgwen — see docker-compose.grid.yml), ` +
      `or use WebDriver-style grid's CDP bridge after a session is created ` +
      `(ws://<grid-host>:<port>/session/<id>/se/cdp).`
    );
  }
}

// ─── Playwright dynamic import ────────────────────────────────────────────────

/**
 * Import playwright dynamically so this module can be loaded without
 * Playwright being installed (e.g. in dry-run / unit-test contexts).
 */
async function importPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import('playwright') as PlaywrightModule;
  } catch {
    throw new Error(
      'Playwright is not installed. Run: npm install playwright && npx playwright install'
    );
  }
}

async function safeClose(context: PlaywrightBrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // Ignore teardown errors
  }
}

/**
 * Build the Playwright newContext() options object from a resolved BrowserConfig.
 * Extracted as a pure helper so the option-shape logic can be unit-tested
 * without spinning a browser or PlaywrightRunner instance.
 */
export function buildContextOptions(
  config: BrowserConfig,
  downloadDir: string,
  videoTmpDir: string | undefined,
): PlaywrightContextOptions {
  return {
    // maximize=true → viewport:null lets the browser use its native window size
    viewport: config.maximize ? null : config.viewport,
    acceptDownloads: true,
    downloadsPath: downloadDir,
    ...(videoTmpDir ? { recordVideo: { dir: videoTmpDir } } : {}),
    ...(config.ignoreHTTPSErrors !== undefined ? { ignoreHTTPSErrors: config.ignoreHTTPSErrors } : {}),
    ...(config.locale !== undefined ? { locale: config.locale } : {}),
    ...(config.timezoneId !== undefined ? { timezoneId: config.timezoneId } : {}),
    ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
  };
}

// ─── Minimal Playwright structural types (no import of actual package at top level) ──

interface PlaywrightLaunchOptions {
  headless?: boolean;
  slowMo?: number;
  args?: string[];
}

interface PlaywrightContextOptions {
  viewport?: { width: number; height: number } | null;
  recordVideo?: { dir: string };
  /** Absolute path where Playwright saves downloaded files. */
  downloadsPath?: string;
  /** Allow downloads to complete (required for downloadsPath to be used). */
  acceptDownloads?: boolean;
  /** Ignore HTTPS certificate errors. From acceptInsecureCerts capability. */
  ignoreHTTPSErrors?: boolean;
  /** BCP-47 locale. */
  locale?: string;
  /** Timezone identifier. */
  timezoneId?: string;
  /** Default User-Agent string applied to all pages in the context. */
  userAgent?: string;
  /** Proxy settings. */
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
  tracing: {
    start(options: { screenshots: boolean; snapshots: boolean }): Promise<void>;
    stop(options?: { path?: string }): Promise<void>;
  };
}

interface PlaywrightPage {
  video(): { delete(): Promise<void>; path(): Promise<string | null> } | null;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  setDefaultTimeout(timeout: number): void;
}

interface PlaywrightBrowser {
  newContext(options?: PlaywrightContextOptions): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightBrowserType {
  launch(options?: PlaywrightLaunchOptions): Promise<PlaywrightBrowser>;
  /** Connect to a Playwright Server via WebSocket (ws:// or wss://) */
  connect(wsEndpoint: string): Promise<PlaywrightBrowser>;
  /** Connect to a Chrome instance via Chrome DevTools Protocol endpoint */
  connectOverCDP(endpointURL: string): Promise<PlaywrightBrowser>;
}

interface PlaywrightModule {
  chromium: PlaywrightBrowserType;
  firefox: PlaywrightBrowserType;
  webkit: PlaywrightBrowserType;
}
