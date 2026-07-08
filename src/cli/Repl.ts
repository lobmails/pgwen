/**
 * cli/Repl.ts — Interactive Gherkin step REPL for pgwen.
 *
 * Reference: https://gweninterpreter.org/docs/repl
 *
 * Usage:
 *   pgwen --repl [--browser chromium|firefox|webkit] [--headed]
 *
 * Commands (all without dot prefix, ):
 *   env                       Dump scope bindings (all visible)
 *   env -a                    Dump ALL scope bindings across all layers
 *   env -f                    Dump feature-layer scope bindings only
 *   env "filter"              Dump bindings whose name contains filter
 *   help                      Show available commands
 *   :paste                    Enter paste mode — type steps then Ctrl+D to execute
 *   history                   Show command history
 *   !<n>                      Re-execute command #n from history (1-based)
 *   load <file>               Load a .meta file at runtime
 *   exit / quit / q / bye     Close browser and exit
 *
 * Legacy dot-prefix commands (backward compat, still supported):
 *   .exit     Close browser and exit
 *   .scope    Dump the current scope (flat format)
 *   .clear    Clear the current scope bindings
 *   .screenshot [path]
 *   .help     Show available commands
 *
 * History is persisted to ~/.pgwen_repl_history across sessions.
 *
 * Browser behaviour ():
 *   The browser is NOT launched at startup. It is launched lazily the first
 *   time a Gherkin step is executed. This allows env/load/history commands to
 *   run without popping up a browser window.
 */

import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Scope } from '../engine/Scope';
import { StringInterpolator } from '../engine/StringInterpolator';
import { Compositor } from '../engine/Compositor';
import type { StepResult } from '../engine/Compositor';
import { createDslResolver, builtinRegistry } from '../dsl/index';
import type { BrowserConfig } from '../engine/BrowserConfig';
import { PGWEN_LOGO_LINES } from '../reporting/ConsoleReporter';

// ─── ANSI color helpers (only active on real TTY) ─────────────────────────────

const USE_COLORS = process.stdout.isTTY;
const ESC = USE_COLORS ? '\x1b' : '';
const colors = {
  green:  (s: string) => USE_COLORS ? `\x1b[32m${s}\x1b[0m` : s,
  cyan:   (s: string) => USE_COLORS ? `\x1b[36m${s}\x1b[0m` : s,
  red:    (s: string) => USE_COLORS ? `\x1b[31m${s}\x1b[0m` : s,
  bold:   (s: string) => USE_COLORS ? `\x1b[1m${s}\x1b[0m`  : s,
};
void ESC; // suppress unused warning

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReplOptions {
  /** Working directory for resolving paths. Default: process.cwd() */
  baseDir?: string;
  /** Output stream for results. Default: process.stdout */
  output?: NodeJS.WritableStream;
  /** Input stream for step lines. Default: process.stdin */
  input?: NodeJS.ReadableStream;
  /** Common meta files/dirs to pre-load before starting the REPL. */
  meta?: string[];
  /**
   * Feature files configured for this session (e.g. from pgwen.launch.options.features).
   * The REPL loads associative .meta for each feature file found (sibling .meta at same path).
   * This makes StepDefs from e.g. Example.meta available when running with -p Example.
   */
  featureFiles?: string[];
  /**
   * Path to input data feed CSV (e.g. pgwen.launch.options.inputData).
   * When specified, the REPL pre-loads the first record into scope so variables like
   * RECORD_ID are available immediately — matching REPL behaviour.
   */
  dataFeed?: string;
  /** Loaded pgwen.conf + profile config — makes ${configKey} resolvable in REPL steps. */
  config?: Record<string, string>;
  /** Keys declared with :masked suffix — values display as ***** in output. */
  maskedSettings?: ReadonlySet<string>;
  /** Active profile name (for banner display). */
  profile?: string;
  /** Target environment name (for banner display). */
  targetEnv?: string;
  /** pgwen version string shown in banner. */
  version?: string;
  /**
   * When provided, the REPL is running in breakpoint mode.
   * The existing scope is used directly instead of creating a fresh one —
   * all bindings from the paused execution are immediately accessible.
   */
  attachedScope?: Scope;
  /**
   * When provided alongside attachedScope, page method calls are forwarded
   * to this live page instead of opening a new browser instance.
   */
  attachedPage?: unknown;
  /**
   * Scope retained from the most recently completed feature run.
   * Used by the post-execution REPL so that all variables bound during the
   * feature (e.g. todayIso, RECORD_ID) are immediately accessible.
   * Unlike attachedScope this does NOT trigger breakpoint mode — the REPL
   * still shows the normal banner and pushes a settings layer on top of the
   * inherited bindings so config values remain resolvable via `env`.
   */
  inheritedScope?: Scope;
  /**
   * Step text that triggered the breakpoint — displayed in the breakpoint banner.
   */
  breakpointAt?: string;
}

// History file persists across sessions (behaviour: up/down recall from previous session)
const HISTORY_FILE = path.join(os.homedir(), '.pgwen_repl_history');
const HISTORY_MAX = 500;

// Gherkin keyword prefixes (case-insensitive). Used as the default English
// dialect; the REPL `# language: <code>` directive can swap this for any
// dialect bundled with @cucumber/gherkin.
const KEYWORD_RE = /^(Given|When|Then|And|But)\s+/i;

/**
 * Build a regex that matches any of the supplied Gherkin keyword prefixes.
 * Escapes regex metacharacters in each keyword so non-ASCII forms (e.g.
 * French `*` / `Étant donné`) are handled safely.
 */
export function buildKeywordRegex(keywords: readonly string[]): RegExp {
  const escaped = keywords
    .filter((k) => k && k.trim() && k.trim() !== '*')
    .map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    // Longest first so multi-word forms (e.g. `Étant donné`) match before
    // any substring that would have matched a shorter alternative.
    .sort((a, b) => b.length - a.length);
  return new RegExp(`^(${escaped.join('|')})\\s+`, 'i');
}

/**
 * Extract the leading Gherkin keyword from a user-typed line.
 * Returns { keyword, text } where `text` is the step body without the keyword.
 * If no keyword prefix is found, keyword defaults to 'Given '.
 */
function splitKeyword(line: string, re: RegExp = KEYWORD_RE): { keyword: string; text: string } {
  const m = re.exec(line);
  if (m) {
    return { keyword: m[1]!.trim() + ' ', text: line.slice(m[0].length) };
  }
  return { keyword: 'Given ', text: line };
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

export class Repl {
  private readonly browserConfig: BrowserConfig;
  /** Active Gherkin dialect language code (default: 'en'). */
  private activeLanguage = 'en';
  /** Regex matching keyword prefixes for the active dialect. */
  private keywordRe: RegExp = KEYWORD_RE;

  constructor(browserConfig: BrowserConfig) {
    this.browserConfig = { ...browserConfig, headless: false }; // REPL is always headed
  }

  /**
   * Start the interactive REPL loop.
   * Browser is NOT launched at startup — it is deferred to the first step execution.
   */
  async start(options: ReplOptions = {}): Promise<void> {
    const out = options.output ?? process.stdout;
    const baseDir = options.baseDir ?? process.cwd();

    const isBreakpoint = options.attachedScope !== undefined;

    if (isBreakpoint) {
      // Breakpoint banner — short, no logo
      out.write(`\n${colors.bold('Breakpoint')}\n\n`);
      out.write(`  ${options.breakpointAt ?? 'Step'}\n\n`);
      out.write('REPL Console\n\nEnter steps to evaluate or type continue to resume..\n');
    } else {
      // pgwen-style banner: logo + welcome + target info before "REPL Console"
      const browserName = options.config?.['pgwen.target.browser'] ?? 'chromium';
      const targetEnv = options.targetEnv ?? options.config?.['pgwen.target.env'];
      const version = options.version ?? '';

      out.write('\n');
      for (const line of PGWEN_LOGO_LINES) {
        out.write(colors.cyan(line) + '\n');
      }
      out.write('\n');
      out.write(`Welcome to pgwen${version ? ` v${version}` : ''}\n`);
      out.write('playwright.dev\n');
      out.write('\n');
      out.write(`Target browser: ${browserName}\n`);
      if (targetEnv) out.write(`Target environment: ${targetEnv}\n`);
      if (options.profile) out.write(`\nLaunching: pgwen -p ${options.profile} --repl\n`);
      out.write('\nREPL Console\n\n');
      out.write('Enter steps to evaluate or type help for more options..\n');
    }

    // Set up scope — three cases:
    //
    //   breakpoint mode  (attachedScope set): reuse the live execution scope directly.
    //                    All bindings from paused execution are immediately accessible.
    //                    No extra layers are pushed — scope structure is owned by the runner.
    //
    //   inherited mode   (inheritedScope set): the scope from the most recently completed
    //                    feature run.  Push a settings layer on top so config values
    //                    remain resolvable, but do NOT push a new feature layer — the
    //                    run's feature layer already holds all the user bindings.
    //
    //   fresh REPL mode  (neither set): create a new scope with the standard
    //                    settings → feature layer order.
    const scope: Scope = options.attachedScope ?? options.inheritedScope ?? new Scope();

    if (!isBreakpoint) {
      // 1. Push settings layer FIRST (outer) and inject pgwen.conf + profile config.
      //    This makes ${configKey} resolvable in steps and config visible via `env`.
      if (options.config && Object.keys(options.config).length > 0) {
        scope.push('settings');
        const maskedSettings = options.maskedSettings;
        for (const [key, value] of Object.entries(options.config)) {
          if (maskedSettings?.has(key)) {
            scope.set(key, '*****');
          } else {
            scope.set(key, value);
          }
        }
      }

      // 2. Push a fresh feature layer (innermost) so REPL-entered step bindings
      //    land there rather than in the settings layer just pushed above.
      //    The inheritedScope's existing feature frame remains underneath and
      //    its bindings stay resolvable via findEntry's innermost-first walk.
      scope.push('feature');
    }

    const dslResolver = createDslResolver(scope);

    // Always create a MetaEngine so `load` commands can register StepDefs
    // into the same registry the compositor holds by reference.
    const { MetaEngine } = await import('../engine/MetaEngine') as { MetaEngine: MetaEngineType };
    const { GherkinParser } = await import('../engine/GherkinParser') as { GherkinParser: MetaEngineType };
    const parser = new GherkinParser() as MetaEngineType;
    const metaEngine = new MetaEngine(parser) as MetaEngineType;

    // Load common meta (from pgwen.launch.options.meta / -m flags)
    for (const metaPath of options.meta ?? []) {
      try {
        metaEngine.loadCommon(path.resolve(baseDir, metaPath));
      } catch {
        out.write(`  [WARN] Could not load meta: ${metaPath}\n`);
      }
    }

    // Load associative meta for configured feature files (e.g. Example.meta for Example.feature).
    // This makes feature-specific StepDefs available at REPL startup when running with a profile.
    for (const featureFile of options.featureFiles ?? []) {
      try {
        const resolved = path.isAbsolute(featureFile)
          ? featureFile
          : path.resolve(baseDir, featureFile);
        metaEngine.loadAssociative(resolved);
      } catch {
        // Associative meta is optional — no warning if not found
      }
    }

    // Pre-load first CSV record into feature scope (REPL behaviour).
    // Skipped in breakpoint mode — the live scope already has all feed bindings.
    if (!isBreakpoint && options.dataFeed) {
      try {
        const feedPath = path.isAbsolute(options.dataFeed)
          ? options.dataFeed
          : path.resolve(baseDir, options.dataFeed);
        const { parseCsvFeed } = await import('../data/CsvFeedReader') as { parseCsvFeed: (p: string, o?: object) => Array<Record<string, string>> };
        const records = parseCsvFeed(feedPath, { autoTrim: true });
        if (records.length > 0) {
          const first = records[0]!;
          for (const [key, value] of Object.entries(first)) {
            scope.set(key, value);
          }
        }
      } catch {
        // Feed loading is best-effort — REPL still starts without it
      }
    }

    // Compositor holds a reference to metaEngine.registry — new StepDefs loaded
    // via `load` command are automatically visible without recreating compositor.
    const registry = metaEngine.registry as MetaEngineType;
    const compositor = this.makeCompositor(registry, scope, dslResolver, options);

    // ─── Lazy browser state ─────────────────────────────────────────────────
    // In breakpoint mode the caller owns the browser — we use attachedPage directly
    // and must NOT close it when the REPL exits.
    const attachedPageRef = options.attachedPage as ReplPage | undefined;

    let lazyBrowser: ReplBrowser | undefined;
    let lazyContext: ReplContext | undefined;
    let lazyPage: ReplPage | undefined;

    const ensurePage = async (): Promise<ReplPage> => {
      // Breakpoint mode: return the live page from the paused execution.
      if (attachedPageRef) return attachedPageRef;

      // Auto-reopen: detect if a step closed the browser (e.g. "I close the current browser").
      // Playwright pages expose isClosed() — if true, tear down stale refs and relaunch.
      if (lazyPage) {
        const p = lazyPage as { isClosed?: () => boolean };
        if (typeof p.isClosed !== 'function' || !p.isClosed()) {
          return lazyPage;
        }
        try { await lazyContext?.close(); } catch { /* ignore */ }
        try { await lazyBrowser?.close(); } catch { /* ignore */ }
        lazyPage = undefined;
        lazyContext = undefined;
        lazyBrowser = undefined;
      }
      const pw = await this.importPlaywright();
      const browserType = pw[this.browserConfig.type];
      const fullBrowser = await browserType.launch({
        headless: false,
        ...(this.browserConfig.slowMo > 0 ? { slowMo: this.browserConfig.slowMo } : {}),
      });
      lazyBrowser = fullBrowser;
      const fullContext = await fullBrowser.newContext({ viewport: this.browserConfig.viewport });
      lazyContext = fullContext;
      lazyPage = await fullContext.newPage();
      return lazyPage;
    };

    const closeBrowser = async (): Promise<void> => {
      // Breakpoint mode: never close a browser we don't own.
      if (attachedPageRef) return;
      try { await lazyContext?.close(); } catch { /* ignore */ }
      try { await lazyBrowser?.close(); } catch { /* ignore */ }
    };

    // Sync accessor — lets the lazy-page proxy read the real page if already open.
    const currentPage = (): ReplPage | undefined => attachedPageRef ?? lazyPage;

    await this.runLoop({
      scope, compositor, metaEngine, ensurePage, closeBrowser, currentPage,
      out, options, baseDir,
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private makeCompositor(
    registry: MetaEngineType,
    scope: Scope,
    dslResolver: ReturnType<typeof createDslResolver>,
    options: ReplOptions
  ): Compositor {
    const interpolator = new StringInterpolator(scope, {
      settings: (key) => options.config?.[key],
      isMaskedSetting: (key) => options.maskedSettings?.has(key) ?? false,
    });
    return new Compositor(registry, scope, interpolator, dslResolver, {
      dslCategoryFor: (stepText) => builtinRegistry.categoryFor(stepText),
    });
  }

  private async runLoop(ctx: {
    scope: Scope;
    compositor: Compositor;
    metaEngine: MetaEngineType;
    ensurePage: () => Promise<ReplPage>;
    currentPage: () => ReplPage | undefined;
    closeBrowser: () => Promise<void>;
    out: NodeJS.WritableStream;
    options: ReplOptions;
    baseDir: string;
  }): Promise<void> {
    const { scope, compositor, out } = ctx;

    // Load persisted history
    const sessionHistory: string[] = loadHistory();

    let running = true;

    // Outer loop: re-enters after paste mode Ctrl+D
    while (running) {
      let pasteMode = false;
      const pasteBuffer: string[] = [];
      // Inline docstring state: tracks whether we're inside a """" ... """" block.
      // Docstrings are assembled directly into the last pasteBuffer entry so that
      // the mergeDocstrings post-processor is a no-op fallback only.
      let inDocstring = false;
      // Set to true when :paste is entered on a real TTY — triggers raw-mode editor
      // after the readline phase closes cleanly.
      let requestPasteEditor = false;

      await new Promise<void>((resolve) => {
        const rl = readline.createInterface({
          input: ctx.options.input ?? process.stdin,
          output: out,
          prompt: 'pgwen> ',
          terminal: ctx.options.input === undefined,
          // Pre-populate readline history (most-recent-first is readline's order)
          history: [...sessionHistory].reverse().slice(0, HISTORY_MAX),
          historySize: HISTORY_MAX,
        });

        rl.prompt();

        // Serialize line handling: each line waits for the previous one to finish.
        // This prevents .exit (0 awaits) from racing past a step (3+ awaits for
        // lazy browser launch) and closing the REPL before output is written.
        let lineChain: Promise<void> = Promise.resolve();

        rl.on('line', (line: string) => {
          lineChain = lineChain.then(async () => {
            // ─── Non-TTY paste mode — accumulate lines until Ctrl+D ──────
            if (pasteMode) {
              const DOCSTRING_RE = /^\s*"""/; // matches both """ (standard Gherkin) and """" ()
              if (DOCSTRING_RE.test(line)) {
                if (!inDocstring) {
                  // Opening """" — append opening quote to the preceding step line
                  inDocstring = true;
                  if (pasteBuffer.length > 0) {
                    pasteBuffer[pasteBuffer.length - 1] += ' "';
                  }
                } else {
                  // Closing """" — append closing quote to complete the step
                  inDocstring = false;
                  if (pasteBuffer.length > 0) {
                    pasteBuffer[pasteBuffer.length - 1] += '"';
                  }
                }
              } else if (inDocstring) {
                // Content line inside docstring — append trimmed content (with separator if needed)
                if (pasteBuffer.length > 0) {
                  const last = pasteBuffer[pasteBuffer.length - 1]!;
                  // If this is the first content line (last ends with ` "`), replace the space with content
                  if (last.endsWith(' "')) {
                    pasteBuffer[pasteBuffer.length - 1] = last + line.trim();
                  } else {
                    pasteBuffer[pasteBuffer.length - 1] = last + '\n' + line.trim();
                  }
                }
              } else {
                // Regular step line
                pasteBuffer.push(line);
              }
              out.write('');
              return;
            }

            const trimmed = line.trim();
            if (!trimmed) {
              out.write('  [No-op]\n');
              rl.prompt();
              return;
            }

            // ─── Record history (skip history-recall commands) ───────────
            if (!trimmed.startsWith('!')) {
              sessionHistory.push(trimmed);
            }

            // ─── Command dispatch ────────────────────────────────────────
            let action: 'exit' | 'paste' | 'continue';
            try {
              action = await this.dispatchCommand(trimmed, {
                scope, compositor, metaEngine: ctx.metaEngine,
                ensurePage: ctx.ensurePage, currentPage: ctx.currentPage, out,
                baseDir: ctx.baseDir, options: ctx.options,
                rl, sessionHistory, pasteMode,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              out.write(`  [ERROR] ${msg}\n`);
              rl.prompt();
              return;
            }

            if (action === 'exit') {
              running = false;
              rl.close();
              return;
            }

            if (action === 'paste') {
              // On a real TTY: request the raw multi-line editor by closing readline
              // and letting the outer loop handle it with full arrow-key support.
              // On non-TTY (tests, piped input): fall back to the readline buffer mode.
              const isRealTTY = ctx.options.input === undefined && process.stdin.isTTY;
              if (isRealTTY) {
                requestPasteEditor = true;
                rl.close();
              } else {
                pasteMode = true;
                out.write('\nREPL Console (paste mode)\n\nEnter or paste steps and press ctrl-D on empty line to evaluate..\n\n');
                rl.setPrompt('');
              }
              return;
            }

            rl.prompt();
          });
        });

        rl.on('close', async () => {
          // Wait for any in-flight line handlers to finish before teardown.
          await lineChain;

          if (requestPasteEditor) {
            // TTY paste editor requested — resolve so outer loop can run it.
            resolve();
          } else if (pasteMode) {
            // Non-TTY Ctrl+D while in paste mode → execute accumulated steps (behaviour: fail-fast)
            pasteMode = false;
            inDocstring = false; // reset in case of aborted docstring
            // Inline assembly already merged """" blocks; mergeDocstrings is a
            // fallback for any residual unmerged lines.
            const steps = mergeDocstrings(pasteBuffer).filter(s => s.trim());
            out.write(`\nExiting paste mode, ${steps.length > 0 ? 'evaluating..' : 'nothing pasted'}\n\n`);
            // Lazy proxy: browser only launches when a step actually touches the page.
            const pastePage = makeLazyPageProxy(ctx.ensurePage, ctx.currentPage) as ReplPage;
            for (const step of steps) {
              // Echo the step (matching paste-mode format: no pgwen> prefix)
              out.write(`\r${step}\n\n`);
              const failed = await this.executeStep(step, compositor, pastePage, out);
              out.write('\n');
              // Fail-fast: stop executing remaining steps if one fails (preserves behaviour)
              if (failed) break;
            }
            pasteBuffer.length = 0;
            out.write('REPL Console\n\nEnter steps to evaluate or type exit to quit..\n');
            // Restart the readline loop
            resolve();
          } else {
            // Normal close (Ctrl+D on empty line / .exit / exit)
            running = false;
            await ctx.closeBrowser();
            resolve();
          }
        });
      });

      // ─── TTY raw-mode paste editor ────────────────────────────────────────
      // After readline closes cleanly (requestPasteEditor=true), run the
      // interactive multi-line editor with full arrow-key navigation support.
      if (requestPasteEditor && running) {
        requestPasteEditor = false;
        out.write('\nREPL Console (paste mode)\n\nEnter or paste steps then press ctrl-D to evaluate (ctrl-C to cancel)..\n\n');
        const editorLines = await this.runMultilineEditor(out);
        if (editorLines !== null) {
          const steps = mergeDocstrings(editorLines).filter(s => s.trim());
          out.write(`\nExiting paste mode, ${steps.length > 0 ? 'evaluating..' : 'nothing pasted'}\n\n`);
          const editorPage = makeLazyPageProxy(ctx.ensurePage, ctx.currentPage) as ReplPage;
          for (const step of steps) {
            out.write(`\r${step}\n\n`);
            const failed = await this.executeStep(step, compositor, editorPage, out);
            out.write('\n');
            if (failed) break;
          }
        } else {
          out.write('\nExiting paste mode, cancelled\n\n');
        }
        out.write('REPL Console\n\nEnter steps to evaluate or type exit to quit..\n');
        // running stays true — outer while loop creates a fresh readline interface
      }
    }

    // Persist history on exit
    saveHistory(sessionHistory);
  }

  /**
   * Raw-mode multi-line editor for paste mode (TTY only).
   *
   * Provides a full inline text editor with arrow-key navigation:
   *   Up / Down      — move cursor between lines
   *   Left / Right   — move cursor within a line (wraps at line ends)
   *   Home / End     — jump to start / end of current line
   *   Enter          — insert new line at cursor
   *   Backspace      — delete char before cursor (merges lines at line start)
   *   Delete         — delete char at cursor (merges lines at line end)
   *   Ctrl+D         — submit (returns array of lines)
   *   Ctrl+C         — cancel (returns null)
   *
   * Rendering uses ANSI escape codes to redraw the editor area in-place.
   * The cursor is always re-positioned to (row, col) after each keystroke.
   */
  private async runMultilineEditor(out: NodeJS.WritableStream): Promise<string[] | null> {
    return new Promise<string[] | null>((resolve) => {
      const stdin = process.stdin;

      // Enable keypress events and raw mode so we can read individual keystrokes.
      // stdin.resume() is required here because rl.close() called stdin.pause() when
      // tearing down the previous readline interface. Without resume(), Node.js sees
      // no active I/O handles and exits the process before any keypress fires.
      readline.emitKeypressEvents(stdin);
      stdin.resume();
      if (typeof (stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode === 'function') {
        (stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }).setRawMode(true);
      }

      const lines: string[] = [''];
      let row = 0;
      let col = 0;
      // prevRow tracks the editor row where the cursor was positioned after the last render,
      // so the next render knows how many lines to move up before clearing.
      let prevRow = 0;
      let firstRender = true;

      const write = (s: string) => out.write(s);

      const render = () => {
        if (!firstRender) {
          // Move cursor back to the first line of the editor area.
          // After the previous render the cursor is at (prevRow, col) in editor space.
          if (prevRow > 0) write(`\x1b[${prevRow}A`);
          write('\r\x1b[J'); // go to column 0, clear to end of screen
        }
        firstRender = false;

        // Draw every line separated by CRLF (required in raw mode)
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) write('\r\n');
          write(lines[i]!);
        }

        // Re-position cursor at (row, col).
        // Cursor is currently at the end of the last drawn line.
        const upCount = lines.length - 1 - row;
        if (upCount > 0) write(`\x1b[${upCount}A`);
        write('\r');
        if (col > 0) write(`\x1b[${col}C`);

        prevRow = row;
      };

      // Finish: restore normal mode, move cursor to end of editor content, add newline.
      const cleanup = () => {
        if (typeof (stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode === 'function') {
          (stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }).setRawMode(false);
        }
        stdin.removeListener('keypress', onKeypress);
        stdin.pause(); // balance the resume() above so the next readline can manage stdin

        // Cursor is at (prevRow, col). Move to (last line, end).
        const lastRow = lines.length - 1;
        const downNeeded = lastRow - prevRow;
        if (downNeeded > 0) write(`\x1b[${downNeeded}B`);
        const lastLineLen = lines[lastRow]!.length;
        write('\r');
        if (lastLineLen > 0) write(`\x1b[${lastLineLen}C`);
        write('\r\n');
      };

      // Initial render — draws the empty first line and positions cursor.
      render();

      const onKeypress = (_str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }) => {
        if (!key) return;

        const currentLine = lines[row]!;

        // ── Submit / Cancel ────────────────────────────────────────────────
        if (key.ctrl && key.name === 'd') {
          cleanup();
          resolve(lines);
          return;
        }
        if (key.ctrl && key.name === 'c') {
          cleanup();
          resolve(null);
          return;
        }

        // ── Navigation ────────────────────────────────────────────────────
        if (key.name === 'up') {
          if (row > 0) {
            row--;
            col = Math.min(col, lines[row]!.length);
            render();
          }
          return;
        }
        if (key.name === 'down') {
          if (row < lines.length - 1) {
            row++;
            col = Math.min(col, lines[row]!.length);
            render();
          }
          return;
        }
        if (key.name === 'left') {
          if (col > 0) {
            col--;
          } else if (row > 0) {
            row--;
            col = lines[row]!.length;
          }
          render();
          return;
        }
        if (key.name === 'right') {
          if (col < currentLine.length) {
            col++;
          } else if (row < lines.length - 1) {
            row++;
            col = 0;
          }
          render();
          return;
        }
        if (key.name === 'home') {
          col = 0;
          render();
          return;
        }
        if (key.name === 'end') {
          col = currentLine.length;
          render();
          return;
        }

        // ── Editing ───────────────────────────────────────────────────────
        if (key.name === 'return' || key.name === 'enter') {
          const before = currentLine.slice(0, col);
          const after = currentLine.slice(col);
          lines[row] = before;
          lines.splice(row + 1, 0, after);
          row++;
          col = 0;
          render();
          return;
        }

        if (key.name === 'backspace') {
          if (col > 0) {
            lines[row] = currentLine.slice(0, col - 1) + currentLine.slice(col);
            col--;
          } else if (row > 0) {
            const prevLine = lines[row - 1]!;
            col = prevLine.length;
            lines[row - 1] = prevLine + currentLine;
            lines.splice(row, 1);
            row--;
          }
          render();
          return;
        }

        if (key.name === 'delete') {
          if (col < currentLine.length) {
            lines[row] = currentLine.slice(0, col) + currentLine.slice(col + 1);
          } else if (row < lines.length - 1) {
            lines[row] = currentLine + lines[row + 1]!;
            lines.splice(row + 1, 1);
          }
          render();
          return;
        }

        // ── Printable character ───────────────────────────────────────────
        if (_str && _str.length === 1 && !key.ctrl && !key.meta) {
          const code = _str.charCodeAt(0);
          if (code >= 32 && code < 127) { // printable ASCII
            lines[row] = currentLine.slice(0, col) + _str + currentLine.slice(col);
            col++;
            render();
          }
        }
      };

      stdin.on('keypress', onKeypress);
    });
  }

  /**
   * Dispatch a single line to either a command handler or step execution.
   * Returns: 'exit' | 'paste' | 'continue'
   */
  private async dispatchCommand(
    line: string,
    ctx: {
      scope: Scope;
      compositor: Compositor;
      metaEngine: MetaEngineType;
      ensurePage: () => Promise<ReplPage>;
      currentPage: () => ReplPage | undefined;
      out: NodeJS.WritableStream;
      baseDir: string;
      options: ReplOptions;
      rl: readline.Interface;
      sessionHistory: string[];
      pasteMode: boolean;
    }
  ): Promise<'exit' | 'paste' | 'continue'> {
    const { scope, compositor, out, baseDir, sessionHistory } = ctx;

    // ─── # language: <code> — Gherkin dialect switch ─────────────────────────
    // Sets the active dialect for subsequent step parsing. The DSL handlers
    // themselves only key off the body text (not the keyword), so the dialect
    // controls which leading keywords are recognised when stripping the
    // keyword from a typed line.
    const langMatch = /^#\s*language\s*:\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (langMatch) {
      const code = langMatch[1]!.toLowerCase();
      try {
        const { dialects } = await import('@cucumber/gherkin');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dialect = (dialects as Record<string, any>)[code];
        if (!dialect) {
          out.write(`  ${colors.red(`Unknown dialect: "${code}"`)}\n`);
          return 'continue';
        }
        const kw = [
          ...(dialect.given as string[]),
          ...(dialect.when as string[]),
          ...(dialect.then as string[]),
          ...(dialect.and as string[]),
          ...(dialect.but as string[]),
        ];
        this.activeLanguage = code;
        this.keywordRe = buildKeywordRegex(kw);
        out.write(`  Language set to: ${dialect.name} (${dialect.native})\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.write(`  ${colors.red(`Could not switch dialect: ${msg}`)}\n`);
      }
      return 'continue';
    }

    // ─── :paste ──────────────────────────────────────────────────────────────
    if (line === ':paste' || line === 'paste') {
      return 'paste';
    }

    // ─── continue / c — resume from breakpoint ───────────────────────────────
    const lower = line.toLowerCase();
    if (lower === 'continue' || lower === 'c') {
      return 'exit'; // closeBrowser is a no-op in breakpoint mode; execution resumes
    }

    // ─── exit / quit / q / bye / .exit ───────────────────────────────────────
    if (lower === 'exit' || lower === 'quit' || lower === 'q' || lower === 'bye' || lower === '.exit') {
      return 'exit';
    }

    // ─── help / .help ─────────────────────────────────────────────────────────
    if (lower === 'help' || lower === '.help') {
      out.write(HELP_TEXT);
      return 'continue';
    }

    // ─── history ──────────────────────────────────────────────────────────────
    if (lower === 'history') {
      if (sessionHistory.length === 0) {
        out.write('  (no history)\n');
      } else {
        const start = Math.max(0, sessionHistory.length - 50); // show last 50
        for (let i = start; i < sessionHistory.length; i++) {
          out.write(`  ${i + 1}  ${sessionHistory[i]}\n`);
        }
      }
      return 'continue';
    }

    // ─── !<n> — re-execute Nth history entry ─────────────────────────────────
    if (line.startsWith('!') && line.length > 1) {
      const nStr = line.slice(1);
      const n = parseInt(nStr, 10);
      if (!isNaN(n) && n >= 1 && n <= sessionHistory.length) {
        const recalled = sessionHistory[n - 1]!;
        out.write(`  > ${recalled}\n`);
        sessionHistory.push(recalled);
        return this.dispatchCommand(recalled, ctx);
      }
      out.write(`  History entry ${nStr} not found (${sessionHistory.length} entries available)\n`);
      return 'continue';
    }

    // ─── env — scope dump ────────────────────────────────────────────────────
    if (lower === 'env' || lower.startsWith('env ') || lower.startsWith('env\t')) {
      this.handleEnv(line, scope, out);
      return 'continue';
    }

    // ─── load <file> ─────────────────────────────────────────────────────────
    if (lower.startsWith('load ') || lower.startsWith('load\t')) {
      const filePath = line.slice(5).trim().replace(/^"|"$/g, '');
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
      if (!fs.existsSync(absPath)) {
        out.write(`  [ERROR] File not found: ${absPath}\n`);
        return 'continue';
      }
      try {
        // Use reload() so editing an already-loaded meta file picks up changes.
        // reload() removes the file from the loaded-cache then re-parses it;
        // StepDefRegistry last-registered-wins semantics overwrite the old version.
        ctx.metaEngine.reload(absPath);
        out.write(`  ${colors.green('Loaded')}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.write(`  ${colors.red(`[ERROR] Could not load: ${msg}`)}\n`);
      }
      return 'continue';
    }

    // ─── Legacy dot-prefix commands ──────────────────────────────────────────
    if (line.startsWith('.')) {
      const parts = line.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();

      switch (cmd) {
        case '.scope': {
          const entries = scope.dump();
          if (Object.keys(entries).length === 0) {
            out.write('  (scope is empty)\n');
          } else {
            out.write('  Scope bindings:\n');
            for (const [k, v] of Object.entries(entries)) {
              out.write(`    ${k} = ${v}\n`);
            }
          }
          return 'continue';
        }

        case '.clear':
          scope.clearAll();
          out.write('  Scope cleared.\n');
          return 'continue';

        case '.screenshot': {
          const screenshotPath = parts[1] ?? 'repl-screenshot.png';
          const absPath = path.resolve(baseDir, screenshotPath);
          try {
            const page = await ctx.ensurePage();
            await page.screenshot({ path: absPath });
            out.write(`  Screenshot saved: ${absPath}\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            out.write(`  Screenshot failed: ${msg}\n`);
          }
          return 'continue';
        }

        default:
          out.write(`  Unknown command: ${line}. Type help for available commands.\n`);
          return 'continue';
      }
    }

    // ─── Gherkin step execution ───────────────────────────────────────────────
    // Only execute lines that start with a Gherkin keyword (matching behaviour).
    // Lines without a keyword get "Unknown input or command", same as REPL.
    if (!this.keywordRe.test(line)) {
      out.write(`  Unknown input or command\n`);
      return 'continue';
    }
    // Lazy proxy: browser only launches when the step's DSL handler actually touches the page.
    // Non-browser steps (variable assignments, assertions, etc.) run without opening a browser.
    const stepPage = makeLazyPageProxy(ctx.ensurePage, ctx.currentPage) as ReplPage;
    await this.executeStep(line, compositor, stepPage, out);
    return 'continue';
  }

  /**
   * Handle the `env [flags] ["filter"]` command — print scope format.
   *
   * env           — show all visible (non-internal) bindings from all layers
   * env -a        — same as env (all layers, all entries)
   * env -f        — show feature-layer bindings only
   * env "filter"  — show bindings whose name contains the filter string
   */
  private handleEnv(line: string, scope: Scope, out: NodeJS.WritableStream): void {
    const args = line.trim().split(/\s+/).slice(1); // drop 'env'
    let layerFilter: string | undefined;
    let nameFilter: string | undefined;
    let showAll = false; // -a flag: include settings layer in filtered output

    for (const arg of args) {
      if (arg === '-a') {
        showAll = true; // all layers including settings
      } else if (arg === '-f') {
        layerFilter = 'feature';
      } else {
        // Treat as name filter (strip surrounding quotes)
        nameFilter = arg.replace(/^["']|["']$/g, '');
      }
    }

    const layers = scope.dumpByLayer();

    // Apply layer filter.
    // When a name filter is active (env "x"), exclude the settings layer by default
    // so that config keys that happen to contain the filter string don't flood the output.
    // Use env -a "x" to include settings in a filtered search.
    const filteredLayers = layerFilter
      ? layers.filter((l) => l.layer === layerFilter)
      : (nameFilter && !showAll)
        ? layers.filter((l) => l.layer !== 'settings')
        : layers;

    // Apply name filter
    const filtered = filteredLayers.map((l) => ({
      ...l,
      bindings: nameFilter
        ? l.bindings.filter((b) => b.name.includes(nameFilter!))
        : l.bindings,
    })).filter((l) => l.bindings.length > 0);

    if (filtered.length === 0) {
      out.write('  (scope is empty)\n');
      return;
    }

    out.write('env {\n');
    for (const layer of filtered) {
      out.write(`  scope : "${layer.layer}" {\n`);
      for (const { name, value } of layer.bindings) {
        out.write(`    ${name} : "${value}"\n`);
      }
      out.write('  }\n');
    }
    out.write('}\n');
  }

  /**
   * Execute a single Gherkin step line.
   * Strips the leading keyword (Given/When/Then/And/But) before passing to
   * the Compositor so DSL patterns match the step body without the prefix.
   *
   * Returns true if the step FAILED (used by paste-mode fail-fast to stop execution).
   * Returns false if passed, abstained, or skipped.
   *
   * Output format (matching REPL):
   *   [Xms] ✔           — passed
   *   [Xms] Abstained   — if-guard condition not met (skipped, counted as passed)
   *   [Xms] ✘           — failed
   *   <error message>   — printed on next line after ✘
   */
  private async executeStep(
    stepLine: string,
    compositor: Compositor,
    page: ReplPage,
    out: NodeJS.WritableStream
  ): Promise<boolean> {
    const start = Date.now();

    // Split out the leading keyword so the step body is matched by DSL patterns
    // correctly. E.g. "And I navigate to "x"" → keyword="And ", text="I navigate to "x""
    const { keyword, text } = splitKeyword(stepLine, this.keywordRe);

    try {
      const results = await compositor.executeSteps(
        [{ keyword, text, line: 0 }],
        page
      );

      const durationMs = Date.now() - start;
      const result = results[0];
      const status = result?.status ?? 'passed';

      // Print body steps when the step is a StepDef invocation (has children).
      if (result?.children && result.children.length > 0) {
        this.printChildren(result.children, out, '  ');
      }

      // Status line preserves format (with ANSI colors on TTY)
      if (status === 'failed') {
        const err = result?.error;
        out.write(`  ${colors.red(`[${durationMs}ms] Failed \u2718`)}\n`);
        if (err) out.write(`  ${colors.red(err.message)}\n`);
        return true; // failed → paste-mode should stop
      } else if (result?.abstained) {
        // if-guard condition was false → shows "Abstained" in cyan
        out.write(`  ${colors.cyan(`[${durationMs}ms] Abstained`)}\n`);
      } else {
        out.write(`  ${colors.green(`[${durationMs}ms] \u2714`)}\n`);
      }
      return false;
    } catch (err) {
      const durationMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      out.write(`  ${colors.red(`[${durationMs}ms] Failed \u2718`)}\n`);
      out.write(`  ${colors.red(msg)}\n`);
      return true; // failed → paste-mode should stop
    }
  }

  /**
   * Recursively print child steps of a StepDef invocation.
   * Matches REPL format: each body step on its own line with indentation
   * and a status icon (✓ pass / x fail / - skip). Nested StepDef calls recurse
   * with additional indentation so the full execution tree is visible.
   */
  private printChildren(
    children: StepResult[],
    out: NodeJS.WritableStream,
    indent: string
  ): void {
    for (const child of children) {
      const kw = (child.originalKeyword ?? child.effectiveKeyword ?? '').trim();
      const displayText = child.stepText;
      const hasChildren = !!(child.children && child.children.length > 0);

      if (hasChildren) {
        // StepDef invocation — print header line then recurse into body steps
        out.write(`${indent}${kw} ${displayText}\n`);
        this.printChildren(child.children!, out, indent + '  ');
      } else {
        // Leaf step — show with status icon and timing (format, colored)
        const timing = child.durationMs !== undefined ? ` [${child.durationMs}ms]` : '';
        if (child.status === 'failed') {
          out.write(`${indent}${kw} ${displayText}${timing}  ${colors.red('\u2718')}\n`);
          if (child.error) out.write(`${indent}  ${colors.red(child.error.message)}\n`);
        } else if (child.abstained) {
          out.write(`${indent}${kw} ${displayText}${timing}  ${colors.cyan('Abstained')}\n`);
        } else {
          out.write(`${indent}${kw} ${displayText}${timing}  ${colors.green('\u2714')}\n`);
        }
      }
    }
  }

  private async importPlaywright(): Promise<ReplPlaywright> {
    try {
      return await import('playwright') as ReplPlaywright;
    } catch {
      throw new Error(
        'Playwright is not installed. Run: npm install playwright && npx playwright install'
      );
    }
  }
}

// ─── Paste-mode helpers ───────────────────────────────────────────────────────

/**
 * Merge pgwen-style multiline docstring blocks from a paste buffer into
 * single step lines (standard behaviour for multi-line JS and other values).
 *
 * paste syntax:
 *   And @Eager yesterday is defined by js
 *       """"
 *       () => { ... }
 *       """"
 *
 * The `""""` lines delimit the string value. Everything between them is joined
 * with newlines and appended (quoted) to the preceding step line:
 *   And @Eager yesterday is defined by js "() => { ... }"
 *
 * Lines that are blank or don't start with a Gherkin keyword AND appear before
 * any step keyword are skipped (blank separators). Result contains only
 * non-empty assembled steps.
 */
function mergeDocstrings(rawLines: string[]): string[] {
  const DOCSTRING = /^\s*"""/; // matches both """ (standard Gherkin) and """" ()
  const result: string[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i]!;
    i++;

    if (!line.trim()) continue; // skip blank separator lines

    // Look ahead: if the next non-blank line is a docstring opener, consume the block
    let j = i;
    while (j < rawLines.length && !rawLines[j]!.trim()) j++; // skip blanks

    if (j < rawLines.length && DOCSTRING.test(rawLines[j]!)) {
      // Found docstring block — accumulate content until closing """"
      j++; // skip opening """"
      const contentLines: string[] = [];
      while (j < rawLines.length && !DOCSTRING.test(rawLines[j]!)) {
        contentLines.push(rawLines[j]!);
        j++;
      }
      j++; // skip closing """"
      i = j;
      // Join content and append as the quoted argument to the step
      const content = contentLines.map(l => l.trim()).join('\n');
      result.push(`${line.trim()} "${content}"`);
    } else {
      result.push(line.trim());
    }
  }

  return result;
}

// ─── History persistence ──────────────────────────────────────────────────────

function loadHistory(): string[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return fs.readFileSync(HISTORY_FILE, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }
  } catch {
    // ignore — history file is optional
  }
  return [];
}

function saveHistory(history: string[]): void {
  try {
    const toSave = history.slice(-HISTORY_MAX);
    fs.writeFileSync(HISTORY_FILE, toSave.join('\n') + '\n', 'utf-8');
  } catch {
    // ignore — history save failure is non-fatal
  }
}

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP_TEXT = `
  pgwen REPL commands:

    env                       Show all scope bindings (format)
    env -a                    Show all scope bindings across all layers
    env -f                    Show feature-level scope bindings
    env "filter"              Show bindings whose name contains filter
    help                      Show this help text
    :paste                    Enter paste mode (multi-line; Ctrl+D to execute)
    history                   Show last 50 commands
    !<n>                      Re-execute command #n from history
    load <file>               Load a .meta file and register its StepDefs
    # language: <code>        Switch Gherkin dialect for keyword recognition
    continue / c              Resume execution from breakpoint (breakpoint mode only)
    exit / quit / q / bye     Close browser and exit

  Legacy (dot-prefix) commands:
    .scope                    Dump scope (flat format, legacy)
    .clear                    Clear all scope bindings
    .screenshot [path]        Take a screenshot (default: repl-screenshot.png)
    .help                     Show this help text
    .exit                     Close browser and exit

`;

// ─── Lazy page proxy ─────────────────────────────────────────────────────────

/**
 * Creates a transparent proxy around `ensurePage` so that the browser is only
 * launched when a DSL handler actually calls a method on the page object.
 * Steps that only touch scope (variable assignments, string assertions, etc.)
 * complete without ever opening a browser — matching REPL behaviour.
 *
 * Sync page accessors that the DSL uses directly:
 *   • url()          — returns real URL if page is open, else ''
 *   • context()      — returns a lazy context proxy (all context methods async)
 *   • keyboard       — returns a sub-proxy whose async methods launch on call
 *   • touchscreen    — same
 *   • request        — same
 * All other page methods are wrapped as async functions that call ensurePage()
 * first, then delegate to the real method on the resolved page.
 */
function makeLazyPageProxy(
  ensurePage: () => Promise<unknown>,
  currentPage: () => unknown,
): unknown {
  /** Proxy for page.context() — all methods lazy-launch except pages() (sync). */
  const makeContextProxy = () =>
    new Proxy({} as object, {
      get(_t, prop: string | symbol) {
        if (prop === 'then') return undefined;
        // pages() is synchronous in Playwright — return real list if open, else []
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

  /** Proxy for sub-objects accessed synchronously (keyboard, touchscreen, request). */
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
      if (prop === 'then') return undefined; // not a thenable — prevents await unwrapping

      // context() is synchronous in Playwright — return a lazy context proxy
      if (prop === 'context') return () => makeContextProxy();

      // url() is synchronous — return real URL if page is open, else empty string
      if (prop === 'url') {
        return (): string => {
          const p = currentPage();
          return p ? (p as { url(): string }).url() : '';
        };
      }

      // Sub-objects: accessed synchronously as properties, methods are async
      if (prop === 'keyboard' || prop === 'touchscreen' || prop === 'request') {
        return makeSubProxy(prop as string);
      }

      // All other page methods are async — launch browser on first call
      return async (...args: unknown[]) => {
        const page = await ensurePage();
        const fn = (page as Record<string, (...a: unknown[]) => unknown>)[prop as string];
        return typeof fn === 'function' ? fn.apply(page, args) : fn;
      };
    },
  });
}

// ─── Browser type stubs ───────────────────────────────────────────────────────

interface ReplPage {
  screenshot(options: { path: string }): Promise<Buffer>;
  video: unknown;
}

interface ReplContext {
  close(): Promise<void>;
}

interface ReplBrowser {
  close(): Promise<void>;
}

interface ReplBrowserType {
  launch(options?: { headless?: boolean; slowMo?: number }): Promise<ReplBrowser & {
    newContext(options?: { viewport?: { width: number; height: number } | null }): Promise<ReplContext & {
      newPage(): Promise<ReplPage>;
    }>;
  }>;
}

interface ReplPlaywright {
  chromium: ReplBrowserType;
  firefox: ReplBrowserType;
  webkit: ReplBrowserType;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MetaEngineType = any;
