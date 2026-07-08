#!/usr/bin/env node
/**
 * cli/launcher.ts — pgwen CLI entry point.
 *
 * Usage:
 *   pgwen [options] [features...]
 *
 * Options:
 *   -p <A[,B,C,...]>        Profile name(s). Comma-separated → sequential multi-profile launch.
 *   -m <meta>               Common meta file or directory (repeatable)
 *   -i <input>              Input data feed (CSV or JSON)
 *   -b, -bn                 Batch / batch+dry-run mode
 *   --parallel              Run feature files in parallel
 *   --tags <expr>           Tag filter expression (@smoke, ~@wip, @a and @b)
 *   --dry-run               Validate step resolution only (no execution)
 *   --browser <type>        Browser engine: chromium | firefox | webkit (default: chromium)
 *   --headed                Run browser in headed (visible) mode
 *   --slow-mo <ms>          Slow down actions by given milliseconds
 *   --repl                  Launch interactive REPL against a live browser
 *   --output, -o <dir>      Output directory for results (default: pgwen/output)
 *   --help, -h              Show usage
 */

import * as fs from 'fs';
import * as path from 'path';
import { PlaywrightRunner, type PlaywrightRunnerOptions } from '../execution/PlaywrightRunner';
import { DryRunner } from '../execution/DryRunner';
import { TagFilter } from '../execution/TagFilter';
import { ResultsReporter } from '../execution/ResultsReporter';
import { HtmlReporter, toFeatureTrace } from '../reporting/HtmlReporter';
import { JUnitReporter } from '../reporting/JUnitReporter';
import { JsonReporter } from '../reporting/JsonReporter';
import { CsvReporter } from '../reporting/CsvReporter';
import { ConsoleReporter } from '../reporting/ConsoleReporter';
import type { ReportEntry } from '../reporting/ConsoleReporter';
import { resolveBrowserConfig } from '../engine/BrowserConfig';
import { Scope } from '../engine/Scope';
import { Repl } from './Repl';
import { GherkinFormatter, collectGherkinFiles } from './GherkinFormatter';
import { runInit } from './Init';
import { runDiagnose } from './Diagnose';
import { isDiagnoseHistoryEnabled, writeFailureHistory } from '../diagnose/HistoryWriter';
import type { RunResult } from '../execution/Runner';
import { loadLayeredWithMasked, loadFile } from '../engine/ProfileLoader';
import type { Config, LoadResult } from '../engine/ProfileLoader';
import type { BrowserType } from '../engine/BrowserConfig';

// ─── Argument parsing ─────────────────────────────────────────────────────────

export interface ParsedArgs {
  /**
   * Profile names to launch. `-p A,B,C` splits on comma so multiple profiles
   * run sequentially in one invocation (). Empty array
   * means "no profile" — pgwen.conf's launch.options settings drive the run.
   * A convenience getter `profile` returns the first entry for callers that
   * only care about the single-profile shape (REPL banner, HTML report label).
   */
  profiles: string[];
  /** Extra config files loaded after base pgwen.conf and before profile conf (-c flag, repeatable) */
  configs: string[];
  /** Show version and exit */
  version: boolean;
  meta: string[];
  dataFeed?: string;
  dryRun: boolean;
  parallel: boolean;
  tags?: string;
  /**
   * Exact scenario name to run. Used after a failure to cheaply re-run just
   * the failing scenario (e.g. the AI-fix prep flow). Empty/undefined runs
   * every matching scenario.
   */
  scenarioName?: string;
  output: string;
  featureFiles: string[];
  help: boolean;
  /** Browser engine override from --browser flag */
  browser?: BrowserType;
  /** Run browser headed (visible) */
  headed: boolean;
  /** Slow-mo delay in ms */
  slowMo?: number;
  /** Launch interactive REPL */
  repl: boolean;
  /**
   * Debug mode — run features normally but pause at any step annotated with
   * @Breakpoint and open the REPL with the live execution scope and page.
   * Type `continue` in the REPL to resume execution.
   */
  debug: boolean;
  /**
   * Interactive mode — after all features complete and reports are printed,
   * automatically open the REPL (matching non-batch default behaviour).
   */
  interactive: boolean;
  /** Run format sub-command (--format flag alias) */
  format: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    profiles: [],
    configs: [],
    meta: [],
    dryRun: false,
    parallel: false,
    output: 'pgwen/output',
    featureFiles: [],
    help: false,
    version: false,
    headed: false,
    repl: false,
    debug: false,
    interactive: false,
    format: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    switch (arg) {
      case '-h':
      case '--help':
        result.help = true;
        break;

      case '-v':
      case '--version':
        result.version = true;
        break;

      case '--verbose':
        // uses -v for verbose; pgwen uses -v for version (--version).
        // --verbose is accepted as a no-op so project scripts that pass --verbose
        // don't fail. Use pgwen --version to print the version number.
        break;

      case '-p': {
        const profileVal = argv[++i];
        if (profileVal !== undefined) {
          // Comma-separated list (): -p A,B,C runs
          // each profile sequentially in one invocation. Repeatable too:
          // -p A -p B is equivalent to -p A,B.
          for (const p of profileVal.split(',')) {
            const trimmed = p.trim();
            if (trimmed) result.profiles.push(trimmed);
          }
        }
        break;
      }

      case '-c': {
        const confVal = argv[++i];
        if (confVal !== undefined) result.configs.push(confVal);
        break;
      }

      case '-m':
        result.meta.push(argv[++i] ?? '');
        break;

      case '-i': {
        const feedVal = argv[++i];
        if (feedVal !== undefined) result.dataFeed = feedVal;
        break;
      }

      case '-b':
        // batch mode — no extra flags needed
        break;

      case '-bn':
        result.dryRun = true;
        break;

      case '--dry-run':
        result.dryRun = true;
        break;

      case '--parallel':
        result.parallel = true;
        break;

      case '--tags': {
        const tagsVal = argv[++i];
        if (tagsVal !== undefined) result.tags = tagsVal;
        break;
      }

      case '--scenario': {
        const sVal = argv[++i];
        if (sVal !== undefined) result.scenarioName = sVal;
        break;
      }

      case '-o':
      case '--output': {
        const outVal = argv[++i];
        result.output = outVal ?? 'pgwen/output';
        break;
      }

      case '--browser':
      case '-B': {
        const bVal = argv[++i] as BrowserType | undefined;
        if (bVal) result.browser = bVal;
        break;
      }

      case '--headed':
        result.headed = true;
        break;

      case '--slow-mo':
        result.slowMo = parseInt(argv[++i] ?? '0', 10);
        break;

      case '--repl':
        result.repl = true;
        break;

      case '-d':
      case '--debug':
        result.debug = true;
        break;

      case '-i':
      case '--interactive':
        result.interactive = true;
        break;

      case '--format':
        result.format = true;
        break;

      default:
        if (!arg.startsWith('-')) {
          result.featureFiles.push(arg);
        } else {
          // Warn on unknown flags so users can catch typos in CI output
          console.warn(`[pgwen] Warning: unknown CLI flag "${arg}" — ignored`);
        }
        break;
    }

    i++;
  }

  return result;
}

// ─── Config loading ───────────────────────────────────────────────────────────

/**
 * Load the layered pgwen configuration:
 *   base pgwen.conf → extra -c confs (in order) → profile conf (if -p given)
 *
 * The `-c` flag Preserves `-c` flag: arbitrary additional config files
 * overlaid on top of pgwen.conf and below the profile conf. Used for browser
 * overlay files like `pgwen/conf/browsers/grid.conf` in CI pipelines.
 */
export function loadConfig(baseDir: string, profile?: string, extraConfigs?: string[]): LoadResult {
  const configFiles: string[] = [];

  const baseConf = path.join(baseDir, 'pgwen.conf');
  if (fs.existsSync(baseConf)) {
    configFiles.push(baseConf);
  }

  // Auto-load env conf (pgwen.target.env → pgwen/conf/env/<env>.conf), mirroring behaviour.
  // We peek at pgwen.conf alone (via loadFile) to read pgwen.target.env without an extra loadLayered call.
  if (fs.existsSync(baseConf)) {
    try {
      const baseOnly = loadFile(baseConf);
      const targetEnv = baseOnly['pgwen.target.env'];
      if (targetEnv) {
        // Support both HOCON (.conf) and JSON (.json) env config files — projects use .json.
        // Prefer .conf when both exist (HOCON is the richer format).
        const envConf = path.join(baseDir, 'pgwen', 'conf', 'env', `${targetEnv}.conf`);
        const envJson = path.join(baseDir, 'pgwen', 'conf', 'env', `${targetEnv}.json`);
        const envPath = fs.existsSync(envConf) ? envConf
                      : fs.existsSync(envJson) ? envJson
                      : null;
        if (envPath) {
          configFiles.push(envPath);
        }
      }
    } catch {
      // ignore — env conf is optional
    }
  }

  // Extra -c config files (e.g. pgwen/conf/browsers/grid.conf)
  for (const extra of extraConfigs ?? []) {
    const resolved = path.isAbsolute(extra) ? extra : path.join(baseDir, extra);
    if (fs.existsSync(resolved)) {
      configFiles.push(resolved);
    }
  }

  if (profile) {
    // Profile inheritance: load base.conf first (if it exists and profile != 'base'),
    // then overlay the named profile on top — Preserves profile layering.
    if (profile !== 'base') {
      const baseProfileConf = path.join(baseDir, 'pgwen', 'conf', 'profiles', 'base.conf');
      if (fs.existsSync(baseProfileConf)) {
        configFiles.push(baseProfileConf);
      }
    }
    const profileConf = path.join(baseDir, 'pgwen', 'conf', 'profiles', `${profile}.conf`);
    if (fs.existsSync(profileConf)) {
      configFiles.push(profileConf);
    }
  }

  if (configFiles.length === 0) {
    return { config: {}, maskedKeys: new Set() };
  }

  try {
    return loadLayeredWithMasked(configFiles);
  } catch {
    return { config: {}, maskedKeys: new Set() };
  }
}

// ─── Feature file resolution ──────────────────────────────────────────────────

/**
 * Resolve feature files from CLI args + config, applying tag filters.
 */
export function resolveFeatureFiles(
  args: ParsedArgs,
  config: Config
): string[] {
  let files: string[] = [...args.featureFiles];

  // Fall back to pgwen.launch.options.features from config
  if (files.length === 0) {
    const featuresFromConfig = config['pgwen.launch.options.features'];
    if (featuresFromConfig) {
      // May be a JSON array string or a single path
      if (featuresFromConfig.startsWith('[')) {
        try {
          const parsed = JSON.parse(featuresFromConfig) as unknown;
          if (Array.isArray(parsed)) {
            files = parsed.map(String);
          }
        } catch {
          files = [featuresFromConfig];
        }
      } else {
        files = [featuresFromConfig];
      }
    }
  }

  return files;
}

/**
 * Resolve meta paths from CLI args + config.
 */
export function resolveMeta(args: ParsedArgs, config: Config): string[] {
  const meta = [...args.meta];

  const metaFromConfig = config['pgwen.launch.options.meta'];
  if (metaFromConfig && meta.length === 0) {
    if (metaFromConfig.startsWith('[')) {
      try {
        const parsed = JSON.parse(metaFromConfig) as unknown;
        if (Array.isArray(parsed)) {
          meta.push(...parsed.map(String));
        }
      } catch {
        meta.push(metaFromConfig);
      }
    } else {
      meta.push(metaFromConfig);
    }
  }

  return meta;
}

// ─── Usage ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
pgwen — Standalone Playwright BDD framework CLI

Usage:
  pgwen [options] [features...]
  pgwen format  [--pretty] [--check] [path...]
  pgwen init    [dir] [--force] [--template <path>]
  pgwen new     [--template <path>] [--output <dir>] [--mode <flow>]
                [--conventions <path>] [--doc <path>] [--transcript <path>]
                [--reference-project <path>] [--doc-url <url>]
                [--allow-oversized] [--provider <name>]

Options:
  -p <A[,B,C,...]>        Profile name(s). Comma-separated list runs each profile
                          sequentially; repeatable (-p A -p B is equivalent to -p A,B).
                          When more than one profile is given, each profile's reports
                          are written under pgwen/output/<profile>/.
  -c <conf>               Additional config file overlaid on pgwen.conf (repeatable)
  -m <meta>               Common meta file or directory (repeatable)
  -i <input>              Input data feed (CSV or JSON)
  -b                      Batch mode
  -bn                     Batch + dry-run mode (validate steps, no execution)
  --dry-run               Validate step resolution only (no execution)
  --parallel              Run feature files in parallel
  --tags <expr>           Tag filter expression (e.g. @smoke, ~@wip, @a and @b)
  --scenario <name>       Run only the scenario with this exact name
  --browser <type>        Browser engine: chromium | firefox | webkit (default: chromium)
  --headed                Run browser in visible (headed) mode
  --slow-mo <ms>          Slow down each action by <ms> milliseconds
  --repl                  Launch interactive Gherkin REPL against a live browser
  -d, --debug             Run with breakpoint support: pause at @Breakpoint steps and open REPL
  -i, --interactive       Open REPL after all features complete (non-batch mode)
  -o, --output <dir>      Output directory for results (default: pgwen/output)
  -v, --version           Show version number and exit
  -h, --help              Show this help message

Format sub-command:
  pgwen format [--pretty] [--check] [path...]
    --pretty              Format .feature/.meta files in place (default)
    --check               Check mode: exit 1 if any file needs formatting (CI use)
    path                  File(s) or director(ies) to format (default: pgwen/)

Init sub-command:
  pgwen init [dir] [--force] [--template <path>]
    dir                   Target directory (default: current directory)
    --force, -f           Scaffold into a non-empty directory
    --template <path>     Template repo to copy from (default: pgwen-template)

New sub-command (Claude-powered project scaffolder; requires ANTHROPIC_API_KEY):
  pgwen new [--template <path>] [--output <dir>] [--mode <flow>] [--conventions <file>]
    --template, -t        Path to a template project repo
    --output, -o          Output parent directory
    --mode                guided | paste | expert
    --conventions, -C     Org-specific conventions file inlined into the prompt

Examples:
  pgwen features/login.feature
  pgwen -p dev --tags @smoke features/
  pgwen --dry-run features/
  pgwen --parallel -m pgwen/meta features/
  pgwen --browser firefox --headed features/
  pgwen --repl
  pgwen format --pretty
  pgwen format --check pgwen/features/
`);
}

// ─── Summary printing — delegated to ConsoleReporter ─────────────────────────
// (legacy printSummary removed; ConsoleReporter handles all console output)

// ─── Format sub-command ───────────────────────────────────────────────────────

/**
 * Handle `pgwen format [--pretty] [--check] [path...]`.
 * Default path is `pgwen/`. Default mode is format-in-place (--pretty).
 * --check exits with code 1 if any file needs formatting.
 */
export function runFormat(argv: string[], baseDir: string): void {
  let checkOnly = false;
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--check') {
      checkOnly = true;
    } else if (arg === '--pretty') {
      // explicit pretty flag — format-in-place (default behaviour, flag is a no-op here)
    } else if (!arg.startsWith('-')) {
      paths.push(arg);
    }
  }

  // Default to pgwen/ relative to cwd
  const targets = paths.length > 0 ? paths : [path.join(baseDir, 'pgwen')];

  const files: string[] = [];
  for (const target of targets) {
    const resolved = path.isAbsolute(target) ? target : path.join(baseDir, target);
    files.push(...collectGherkinFiles(resolved));
  }

  if (files.length === 0) {
    console.log('pgwen format: No .feature or .meta files found.');
    process.exit(0);
  }

  const formatter = new GherkinFormatter();
  const needsFormat: string[] = [];
  const parseErrors: string[] = [];

  for (const file of files) {
    try {
      if (checkOnly) {
        if (formatter.checkFile(file)) {
          needsFormat.push(file);
          console.log(`  needs formatting: ${path.relative(baseDir, file)}`);
        }
      } else {
        const changed = formatter.formatFile(file);
        if (changed) {
          console.log(`  formatted: ${path.relative(baseDir, file)}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parseErrors.push(`  ${path.relative(baseDir, file)}: ${msg}`);
    }
  }

  if (parseErrors.length > 0) {
    console.error('\npgwen format: Parse errors encountered:');
    for (const e of parseErrors) console.error(e);
    process.exit(1);
  }

  if (checkOnly) {
    if (needsFormat.length > 0) {
      console.error(`\npgwen format: ${needsFormat.length} file(s) need formatting. Run 'pgwen format --pretty' to fix.`);
      process.exit(1);
    } else {
      console.log(`pgwen format: All ${files.length} file(s) are correctly formatted.`);
      process.exit(0);
    }
  } else {
    console.log(`\npgwen format: Done. ${files.length} file(s) processed.`);
    process.exit(0);
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function main(argv?: string[]): Promise<void> {
  const rawArgs = argv ?? process.argv.slice(2);

  // ─── Sub-command dispatch ──────────────────────────────────────────────────
  if (rawArgs[0] === 'format') {
    runFormat(rawArgs.slice(1), process.cwd());
    return;
  }

  if (rawArgs[0] === 'init') {
    runInit(rawArgs.slice(1), process.cwd());
    return;
  }

  if (rawArgs[0] === 'diagnose') {
    await runDiagnose(rawArgs.slice(1), process.cwd());
    return;
  }

  if (rawArgs[0] === 'new') {
    const { main: newProjectMain } = await import('./NewProject');
    await newProjectMain(rawArgs.slice(1));
    return;
  }

  const args = parseArgs(rawArgs);

  // --format flag is an alias for the 'format' sub-command
  if (args.format) {
    runFormat(args.featureFiles, process.cwd());
    return;
  }

  if (args.version) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version: string };
    console.log(`pgwen ${pkg.version}`);
    process.exit(0);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const baseDir = process.cwd();

  // ─── Profile list ─────────────────────────────────────────────────────────
  // `-p A,B,C` runs profiles sequentially, . When no
  // profile is given, we treat that as a single anonymous run (undefined),
  // preserving the pre-multi-profile behaviour.
  const profileList: (string | undefined)[] =
    args.profiles.length > 0 ? args.profiles : [undefined];
  const totalProfiles = profileList.length;

  // ─── REPL mode ────────────────────────────────────────────────────────────
  // `--repl` launches the interactive REPL and returns — no feature execution.
  // With multiple profiles the last one wins ( semantics
  // for post-execution REPL: last profile provides the context).
  if (args.repl) {
    const replProfile = profileList[profileList.length - 1];
    const { config, maskedKeys } = loadConfig(baseDir, replProfile, args.configs);
    const browserConfig = resolveBrowserConfig(config, {
      ...(args.browser ? { type: args.browser } : {}),
      ...(args.headed ? { headless: false } : {}),
      ...(args.slowMo !== undefined ? { slowMo: args.slowMo } : {}),
    });
    const meta = resolveMeta(args, config);
    const replFeatureFiles = resolveFeatureFiles(args, config);
    const replDataFeed = args.dataFeed ?? config['pgwen.launch.options.inputData'];
    const repl = new Repl(browserConfig);
    await repl.start({
      baseDir, meta,
      featureFiles: replFeatureFiles,
      ...(replDataFeed ? { dataFeed: replDataFeed } : {}),
      config,
      maskedSettings: maskedKeys,
      version: (() => { try { return (require('../../package.json') as { version: string }).version; } catch { return ''; } })(),
      ...(replProfile ? { profile: replProfile } : {}),
      ...(config['pgwen.target.env'] ? { targetEnv: config['pgwen.target.env'] } : {}),
    });
    process.exit(0);
  }

  // ─── Per-profile execution loop ───────────────────────────────────────────
  // Each profile is a separate CLI-shaped run: own config, own output subdir,
  // own reports. Stop on first failure UNLESS in dry-run (dry-run runs every
  // profile so users see the full picture). Matches .16.2.
  interface ProfileOutcome {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    outputDir: string;
  }
  const profileOutcomes: ProfileOutcome[] = [];
  let lastLoopState: {
    baseDir: string;
    meta: string[];
    featureFiles: string[];
    config: Config;
    maskedKeys: ReadonlySet<string>;
    browserConfig: import('../engine/BrowserConfig').BrowserConfig;
    lastScope?: Scope;
    profileName?: string;
  } | undefined;
  let anyFailed = false;

  for (let profileIdx = 0; profileIdx < profileList.length; profileIdx++) {
    const profileName = profileList[profileIdx];
    const isMultiProfile = totalProfiles > 1;

    // Skip remaining profiles after a failure (unless dry-run — we want to see
    // all resolution errors across the whole suite in one go).
    if (anyFailed && !args.dryRun) {
      profileOutcomes.push({
        name: profileName ?? '(default)',
        status: 'skipped',
        durationMs: 0,
        outputDir: '',
      });
      continue;
    }

    if (isMultiProfile) {
      // Announce which profile is starting — one "Launching: pgwen -p <name>" line per profile.
      const restOfArgs = rawArgs
        .filter((_, i, arr) => {
          if (arr[i - 1] === '-p') return false;
          if (_ === '-p') return false;
          return true;
        })
        .join(' ');
      console.log(`\nLaunching: pgwen -p ${profileName} ${restOfArgs}`.trimEnd() + '\n');
    }

    const profileStartTime = Date.now();
    const outcome = await runOneProfile(args, rawArgs, baseDir, profileName, profileIdx, totalProfiles);
    const profileDuration = Date.now() - profileStartTime;

    profileOutcomes.push({
      name: profileName ?? '(default)',
      status: outcome.anyFailed ? 'failed' : 'passed',
      durationMs: profileDuration,
      outputDir: outcome.outputDir,
    });
    lastLoopState = outcome.state;
    if (outcome.anyFailed) anyFailed = true;
  }

  // ─── Cross-profile summary ────────────────────────────────────────────────
  // Only printed when > 1 profile was launched. Matches 's
  // "results of all profiles at end" block.
  if (totalProfiles > 1) {
    const reporter = new ConsoleReporter({
      version: (() => { try { return (require('../../package.json') as { version: string }).version; } catch { return ''; } })(),
    });
    reporter.printProfileResults(profileOutcomes);
  }

  // ─── Post-execution REPL ──────────────────────────────────────────────────
  // : only open REPL after the LAST profile (or after ANY failure).
  // For pgwen the post-run REPL is the always-on default (non-dryRun, non--repl).
  // Multi-profile changes nothing here — we're at the end of the whole run.
  if (!args.dryRun && !args.repl && lastLoopState) {
    const iRepl = new Repl(lastLoopState.browserConfig);
    await iRepl.start({
      baseDir: lastLoopState.baseDir,
      meta: lastLoopState.meta,
      featureFiles: lastLoopState.featureFiles,
      config: lastLoopState.config,
      maskedSettings: lastLoopState.maskedKeys,
      version: (() => { try { return (require('../../package.json') as { version: string }).version; } catch { return ''; } })(),
      ...(lastLoopState.profileName ? { profile: lastLoopState.profileName } : {}),
      ...(lastLoopState.config['pgwen.target.env'] ? { targetEnv: lastLoopState.config['pgwen.target.env'] } : {}),
      ...(lastLoopState.lastScope ? { inheritedScope: lastLoopState.lastScope } : {}),
    });
  }

  process.exit(anyFailed ? 1 : 0);
}

// ─── Per-profile execution ────────────────────────────────────────────────────

interface RunProfileOutcome {
  anyFailed: boolean;
  outputDir: string;
  state: {
    baseDir: string;
    meta: string[];
    featureFiles: string[];
    config: Config;
    maskedKeys: ReadonlySet<string>;
    browserConfig: import('../engine/BrowserConfig').BrowserConfig;
    lastScope?: Scope;
    profileName?: string;
  };
}

/**
 * Execute a single profile end-to-end: load config → run features → write
 * reports. Extracted from main() so that main() can loop and chain profiles
 * sequentially ( style).
 *
 * When `totalProfiles > 1`, this function isolates each profile's output
 * under `pgwen/output/<profile>/` so profiles running back-to-back don't
 * overwrite each other's HTML / JUnit / JSON / CSV reports.
 */
async function runOneProfile(
  args: ParsedArgs,
  rawArgs: string[],
  baseDir: string,
  profileName: string | undefined,
  profileIdx: number,
  totalProfiles: number,
): Promise<RunProfileOutcome> {
  const { config, maskedKeys } = loadConfig(baseDir, profileName, args.configs);

  // Build browser config from pgwen.conf + CLI flags
  const browserConfig = resolveBrowserConfig(config, {
    ...(args.browser ? { type: args.browser } : {}),
    ...(args.headed ? { headless: false } : {}),
    ...(args.slowMo !== undefined ? { slowMo: args.slowMo } : {}),
  });

  // Resolve feature files and meta from args + config
  const featureFiles = resolveFeatureFiles(args, config);
  const meta = resolveMeta(args, config);
  const dataFeed = args.dataFeed ?? config['pgwen.launch.options.inputData'];

  // Check parallel flag from config as well
  const parallel =
    args.parallel || config['pgwen.launch.options.parallel'] === 'true';

  // Config-driven results CSV reporter — init headers once before execution starts
  const resultsReporter = ResultsReporter.fromConfig(config);
  if (resultsReporter) {
    try {
      resultsReporter.init();
    } catch {
      // Non-fatal — results CSV dir may not exist yet; Runner will create it via appendRow
    }
  }

  // Named results reporters — one per @Results('name') StepDef key in config
  const namedReportersMap = ResultsReporter.namedFromConfig(config);
  for (const [, reporter] of namedReportersMap) {
    try { reporter.init(); } catch { /* Non-fatal */ }
  }
  const namedResultsReporters: ReadonlyMap<string, (scope: Scope, status: 'Passed' | 'Failed') => void> | undefined =
    namedReportersMap.size > 0
      ? new Map([...namedReportersMap].map(([name, r]) => [name, (scope: Scope, status: 'Passed' | 'Failed') => r.appendRow(scope, status)]))
      : undefined;

  // FailFast — stop after first failure (enabled = scenario level, exit = feature level)
  const failfastEnabled = config['pgwen.feature.failfast.enabled'] === 'true';
  const failfastExit    = config['pgwen.feature.failfast.exit'] === 'true';

  // State level — 'scenario' resets feature-level bindings between scenarios
  const stateLevel = (config['pgwen.state.level'] ?? 'feature') as 'scenario' | 'feature';

  // Behaviour rules — 'strict' enforces @Context/@Action/@Assertion keyword constraints
  // Accept both American spelling (pgwen.behavior.rules) and British spelling (pgwen.behaviour.rules)
  const behaviourRules = (config['pgwen.behaviour.rules'] ?? config['pgwen.behavior.rules'] ?? 'strict') as 'strict' | 'lenient';

  if (featureFiles.length === 0) {
    console.error('pgwen: No feature files specified. Use --help for usage.');
    process.exit(1);
  }

  // Apply tag filter to filter feature files is not applicable at this level
  // (tag filtering happens at the scenario level inside Runner)
  // We pass the tag expression to runners so they can filter.
  // An empty array `[]` from HOCON config means "no tag filter" — treat as undefined.
  let rawTagConfig = config['pgwen.launch.options.tags'];
  if (rawTagConfig !== undefined) {
    const trimmed = rawTagConfig.trim();
    if (trimmed === '[]' || trimmed === '') rawTagConfig = undefined;
  }
  const tagExpr = args.tags ?? rawTagConfig;
  const tagFilter = TagFilter.fromExpression(tagExpr);

  // Dry run mode — two phases matching -bn behaviour:
  //   Phase 1: Static step-resolution check — runs silently; undefined steps will surface as
  //            "Undefined step" failures inline during Phase 2 execution.
  //   Phase 2: Full pipeline execution without a browser — all steps execute; browser-dependent
  //            steps pass silently; DSL assertion/binding steps run and can fail normally.
  //            HTML/JUnit/JSON reports are generated showing one entry per feed record.
  if (args.dryRun) {
    const dryRunner = new DryRunner();
    dryRunner.checkFiles(featureFiles, { meta, baseDir });
    // Fall through to the execution path below — runFeaturesDry() will be called.
  }

  // Verify tag filter is used (even if we can't do per-scenario filtering at CLI level without
  // executing the feature, we at least log it)
  if (tagFilter && tagExpr) {
    console.log(`pgwen: Applying tag filter: ${tagExpr}`);
  }

  // Execute features — use PlaywrightRunner for browser execution
  const assertionModeRaw = config['pgwen.assertion.mode'];
  const assertionMode: 'hard' | 'soft' | 'sustained' | undefined =
    assertionModeRaw === 'soft' || assertionModeRaw === 'sustained' || assertionModeRaw === 'hard'
      ? assertionModeRaw
      : undefined;
  const runOptions = {
    meta,
    config,
    maskedSettings: maskedKeys,
    dryRun: args.dryRun,
    ...(profileName !== undefined ? { profileName } : {}),
    ...(config['pgwen.target.env'] ? { targetEnv: config['pgwen.target.env'] } : {}),
    ...(assertionMode !== undefined ? { assertionMode } : {}),
    ...(dataFeed !== undefined ? { dataFeed } : {}),
    ...(tagExpr !== undefined ? { tagFilter: tagExpr } : {}),
    ...(args.scenarioName !== undefined ? { scenarioName: args.scenarioName } : {}),
    failfastEnabled,
    stateLevel,
    behaviourRules,
    ...(resultsReporter !== undefined ? { resultsReporter } : {}),
    ...(namedResultsReporters !== undefined ? { namedResultsReporters } : {}),
    // Debug mode: pause at @Breakpoint steps and open an attached REPL session.
    // The handler receives the live scope and page so the user can inspect state
    // and run further steps before typing `continue` to resume execution.
    ...(args.debug ? {
      breakpointHandler: async (scope: Scope, page: unknown, stepText: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const bpVersion: string = (() => { try { return (require('../../package.json') as { version: string }).version; } catch { return ''; } })();
        const bpRepl = new Repl(browserConfig);
        await bpRepl.start({
          attachedScope: scope,
          attachedPage: page,
          breakpointAt: stepText,
          baseDir,
          meta,
          featureFiles,
          config,
          maskedSettings: maskedKeys,
          version: bpVersion,
          ...(profileName ? { profile: profileName } : {}),
          ...(config['pgwen.target.env'] ? { targetEnv: config['pgwen.target.env'] } : {}),
        });
      },
    } : {}),
  };

  const screenshotOnFailure = config['pgwen.web.capture.screenshots.enabled'] === 'true';

  // Console log depth — 1 = one level of StepDef children (default).
  // In dry-run mode always use -1 (unlimited) regardless of config, so all nested
  // steps are shown for full step-resolution validation — Preserves -bn.
  // In normal mode, config key pgwen.console.log.depth takes precedence.
  let consoleLogDepth: number;
  if (args.dryRun) {
    consoleLogDepth = -1;
  } else {
    const rawDepth = config['pgwen.console.log.depth'];
    if (rawDepth === 'infinity') {
      consoleLogDepth = -1; // unlimited
    } else {
      const parsed = rawDepth !== undefined ? parseInt(rawDepth, 10) : NaN;
      consoleLogDepth = isNaN(parsed) ? 0 : parsed;
    }
  }
  const targetEnv = config['pgwen.target.env'] ?? config['pgwen.target.environment'] ?? 'default';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pgwenVersion: string = (() => { try { return (require('../../package.json') as { version: string }).version; } catch { return ''; } })();
  const reporter = new ConsoleReporter({
    depth: consoleLogDepth,
    version: pgwenVersion,
    browser: browserConfig.type,
    env: targetEnv,
  });

  // Only print the pgwen banner for the FIRST profile — subsequent profiles
  // are announced by main()'s "Launching: pgwen -p <name>" line.
  if (profileIdx === 0) reporter.printBanner();

  const runStartTime = new Date();

  // When more than one profile is being launched, isolate each profile's
  // output under `<args.output>/<profile>/` so back-to-back profiles don't
  // overwrite each other's HTML / JUnit / JSON / CSV reports. Single-profile
  // runs keep the flat layout for backward compatibility.
  const effectiveOutput = totalProfiles > 1 && profileName
    ? path.join(args.output, profileName)
    : args.output;

  // Pre-initialise HTML output dir so feature pages can be written immediately.
  const htmlOutputDir = path.join(baseDir, effectiveOutput, 'reports', 'html');
  const htmlReporter = new HtmlReporter();
  const htmlCommand = rawArgs.join(' ');
  const htmlOpts = { version: pgwenVersion || '1.0.0', command: htmlCommand };
  try { htmlReporter.initOutputDir(htmlOutputDir); } catch { /* non-fatal */ }

  // Collect resolved feature files so we know the total count upfront.
  const resolvedFeatureCount = featureFiles.length;

  // Streaming state for incremental HTML updates.
  const streamedTraces: import('../reporting/HtmlReporter').FeatureTrace[] = [];
  const streamedSummaryInfos: import('../reporting/HtmlReporter').FeatureSummaryInfo[] = [];

  // Streaming: print each record's result to console as soon as it completes
  // and immediately write its HTML page + update index.html. This is the
  // per-record streaming path — for CSV/JSON feeds with N records, the HTML
  // report updates N times as each record completes, matching 's
  // progressive output instead of waiting for the whole file to finish.
  const streamedResults: RunResult[] = [];
  const emitOne = (r: RunResult): void => {
    reporter.printFeature(r);
    streamedResults.push(r);
    try {
      const trace = toFeatureTrace(r);
      streamedTraces.push(trace);
      const featureIdx = streamedTraces.length;
      const summaryInfo = htmlReporter.writeFeaturePage(trace, featureIdx, resolvedFeatureCount, htmlOutputDir, htmlOpts);
      streamedSummaryInfos.push(summaryInfo);
      htmlReporter.writeSummary(streamedTraces, htmlOutputDir, htmlOpts, streamedSummaryInfos);
    } catch { /* non-fatal */ }
  };

  let results: RunResult[];
  const pwRunnerOptions: PlaywrightRunnerOptions = {
    outputDir: path.join(baseDir, effectiveOutput),
    failfastExit,
    screenshotOnFailure,
    onRecordComplete: (r) => emitOne(r),
  };
  const pwRunner = new PlaywrightRunner(browserConfig, pwRunnerOptions);

  if (args.dryRun) {
    // Phase 2: browser-free execution — reports show one entry per feed record
    results = await pwRunner.runFeaturesDry(featureFiles, runOptions);
  } else if (parallel) {
    console.log(`pgwen: Running ${featureFiles.length} feature(s) in parallel...\n`);
    const parallelResult = await pwRunner.runFeaturesParallel(featureFiles, runOptions);
    results = parallelResult.results;
    // Parallel results are not streamed — print them all here
    for (const r of results) reporter.printFeature(r);
  } else {
    console.log(`pgwen: Running ${featureFiles.length} feature(s) sequentially...\n`);
    results = await pwRunner.runFeatures(featureFiles, runOptions);
  }

  // For sequential/dry-run, results were already printed via streamCallback above.
  // For parallel, they were just printed in the else-if block.
  reporter.printSummary(results, runStartTime);

  const traces = results.map(toFeatureTrace);
  const generatedReports: ReportEntry[] = [];

  // HTML report — sequential/dry-run pages already written via streaming; only
  // parallel needs a full batch generate (results not streamed incrementally).
  try {
    if (parallel) {
      htmlReporter.generate(traces, htmlOutputDir, htmlOpts);
    } else {
      // Final index.html refresh to capture exact end times / complete trace list.
      const finalSummaryInfos: import('../reporting/HtmlReporter').FeatureSummaryInfo[] = streamedSummaryInfos.length > 0
        ? streamedSummaryInfos
        : traces.map((t, i) => htmlReporter.writeFeaturePage(t, i + 1, traces.length, htmlOutputDir, htmlOpts));
      htmlReporter.writeSummary(traces, htmlOutputDir, htmlOpts, finalSummaryInfos);
    }
    generatedReports.push({ label: 'HTML', path: `${htmlOutputDir}/index.html` });
  } catch {
    // Report generation failures are non-fatal — don't override exit code
  }

  // JUnit XML report — generated silently (not surfaced in console Reports section)
  const junitOutputDir = path.join(baseDir, effectiveOutput, 'reports', 'junit');
  try {
    const junitReporter = new JUnitReporter();
    junitReporter.generate(traces, junitOutputDir, { version: pgwenVersion || '1.0.0' });
  } catch {
    // Report generation failures are non-fatal — don't override exit code
  }

  // JSON report — generated silently (not surfaced in console Reports section)
  const jsonOutputDir = path.join(baseDir, effectiveOutput, 'reports', 'json');
  try {
    const jsonReporter = new JsonReporter();
    const command = rawArgs.join(' ');
    jsonReporter.generate(traces, jsonOutputDir, { command, version: pgwenVersion || '1.0.0' });
  } catch {
    // Report generation failures are non-fatal — don't override exit code
  }

  // CSV report — generated silently (not surfaced in console Reports section)
  const csvOutputDir = path.join(baseDir, effectiveOutput, 'reports', 'csv');
  try {
    const csvReporter = new CsvReporter();
    csvReporter.generate(traces, csvOutputDir, { version: pgwenVersion || '1.0.0' });
  } catch {
    // Report generation failures are non-fatal — don't override exit code
  }

  // Diagnosis-history sidecars (§13). Opt-in via `pgwen.diagnose.history.enabled`.
  // PGWEN_AI_DISABLED=1 short-circuits all diagnose-track writes regardless of config.
  // Writes one JSON per failed leaf step under
  //   <output>/reports/diagnosis-history/<feature>__<scenario>__<isoStamp>.json
  // Feeds the false-positive-rate measurement that gates the AI track.
  if (isDiagnoseHistoryEnabled(config)) {
    const historyReportsDir = path.join(baseDir, effectiveOutput, 'reports');
    for (const r of results) {
      try {
        writeFailureHistory(r, historyReportsDir, pgwenVersion || '1.0.0');
      } catch {
        // Telemetry write failures are non-fatal — don't override exit code
      }
    }
  }

  // RESULTS — project-specific data-driven output files from ResultsReporter (preserves format).
  // First file uses the 'RESULTS' label; subsequent files use an empty label so they
  // align flush under the first entry (right-pad to same width = spaces only).
  if (resultsReporter) {
    // Sort any output file whose field list carries `sort = ascending|descending`
    // No-op for files without a sort directive.
    try { resultsReporter.finalize(); } catch (e) {
      // Sort failure is non-fatal — log it but keep the unsorted file so the
      // operator still has data.
      process.stderr.write(`pgwen: ResultsReporter.finalize failed: ${(e as Error).message}\n`);
    }
    const specs = resultsReporter.getFileSpecs();
    let firstResults = true;
    for (const spec of specs) {
      generatedReports.push({ label: firstResults ? 'RESULTS' : '', path: spec.file });
      firstResults = false;
    }
  }

  reporter.printReports(generatedReports);

  // Return per-profile outcome — main() aggregates across profiles and
  // opens the post-execution REPL once, at the end of the last profile
  // (or after any failure). See 's REPL-on-last-profile rule.
  const anyFailedInProfile = results.some((r) => r.status === 'failed');
  const state: RunProfileOutcome['state'] = {
    baseDir,
    meta,
    featureFiles,
    config,
    maskedKeys,
    browserConfig,
    ...(pwRunner.lastScope ? { lastScope: pwRunner.lastScope } : {}),
    ...(profileName ? { profileName } : {}),
  };
  return { anyFailed: anyFailedInProfile, outputDir: path.join(baseDir, effectiveOutput), state };
}

// ─── CLI bootstrap ────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`pgwen: Fatal error: ${msg}`);
    process.exit(1);
  });
}
