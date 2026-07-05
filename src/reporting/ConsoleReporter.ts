/**
 * reporting/ConsoleReporter.ts — ANSI-colored console output for pgwen runs.
 *
 * Mirrors the reference console output format:
 *
 *   Feature: Name [x of N]
 *
 *     Scenario: Name
 *
 *       Given a customer account
 *         Given RECORD_ID should not be blank  [4ms] Failed x
 *   Unbound reference: RECORD_ID
 *       When the account is searched
 *       Then the account will be found  [2ms] ✓
 *
 *     Passed  Failed  Sustained  Skipped  Pending
 *       -       1        -          -        -
 *     1 Scenario
 *     5 Steps   3        1
 *
 *     Started   Wed 22 Apr 2026 at 11:12:30 AM
 *     Finished  Wed 22 Apr 2026 at 11:12:30 AM
 *     Elapsed   00:00:00
 *
 *     [13ms] Failed x
 *
 *     — Unbound reference: RECORD_ID
 */

import * as path from 'path';
import type { RunResult, ScenarioRunResult } from '../execution/Runner';
import type { StepResult } from '../engine/Compositor';

// ─── pgwen ASCII art logo ─────────────────────────────────────────────────────
//
// "pgwen" in lean FIGlet style (5 lines), Playwright theatre masks right.
// Rendered bold+cyan so strokes appear thick and readable.
//
//     _ __   __ _    _      __   ___   _ __      .-.  .-.
//    | '_ \ / _' |  \ \ /\ / / / _ \ | '_ \   (^_^)(T_T)
//    | |_) || (_| |  \ V  V / |  __/ | | | |    '-'  '-'
//    | .__/  \__, |   \_/\_/   \___|  |_| |_|
//    |_|     |___/
//
export const PGWEN_LOGO_LINES: ReadonlyArray<string> = [
  "    _ __   __ _    _      __   ___   _ __      .-.  .-.",
  "   | '_ \\ / _' |  \\ \\ /\\ / / / _ \\ | '_ \\   (^_^)(T_T)",
  "   | |_) || (_| |  \\ V  V / |  __/ | | | |    '-'  '-'",
  "   | .__/  \\__, |   \\_/\\_/   \\___|  |_| |_|",
  "   |_|     |___/",
];

// ─── ANSI color codes ─────────────────────────────────────────────────────────

const ANSI = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  pink:   '\x1b[95m',   // bright magenta — matches the reference framework's Feature/Scenario/Background colour
};

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ReportEntry {
  label: string;
  path: string;
}

export interface ConsoleReporterOptions {
  /**
   * Whether to output ANSI color codes.
   * Default: true when process.stdout.isTTY is true, false otherwise (CI).
   */
  colors?: boolean;
  /**
   * Depth of StepDef expansion to show.
   * 0 = top-level steps only.
   * 1 = expand one level (the reference framework default).
   * -1 or Infinity = expand all levels.
   */
  depth?: number;
  /** Output stream. Default: process.stdout. */
  output?: NodeJS.WritableStream;
  /** pgwen version string shown in banner. */
  version?: string;
  /** Target browser type (e.g. "chromium"). */
  browser?: string;
  /** Target environment (e.g. "test"). */
  env?: string;
}

// ─── Stats table ─────────────────────────────────────────────────────────────

// Column layout: leading spaces are wide enough that "Passed" center aligns with
// the longest possible sub-row label (e.g. "  2 Scenarios" = 13 chars → min start 15).
// 13 leading spaces → "Passed" at col 13, center at 15 for single-char values.
//
//  Column starts (0-indexed in TABLE_HEADER):
//    Passed    → 13  width 6
//    Failed    → 21  width 6
//    Sustained → 29  width 9
//    Skipped   → 40  width 7
//    Pending   → 49  width 7
const TABLE_HEADER = '             Passed  Failed  Sustained  Skipped  Pending';

interface TableCols {
  passed: number;
  failed: number;
  sustained: number;
  skipped: number;
  pending: number;
}

function buildValuesRow(cols: TableCols): string {
  const entries: Array<{ label: string; val: number }> = [
    { label: 'Passed',    val: cols.passed    },
    { label: 'Failed',    val: cols.failed    },
    { label: 'Sustained', val: cols.sustained },
    { label: 'Skipped',   val: cols.skipped   },
    { label: 'Pending',   val: cols.pending   },
  ];

  let row = '';
  for (const { label, val } of entries) {
    const valStr = val === 0 ? '-' : String(val);
    const colStart = TABLE_HEADER.indexOf(label);
    const center = colStart + Math.floor((label.length - valStr.length) / 2);
    while (row.length < center) row += ' ';
    row += valStr;
  }
  return row;
}

/** Place a numeric value (or '-' if 0) under the given column label in the header.
 *  Always ensures at least 2 spaces gap from the current row content, so labels
 *  longer than the column position (e.g. "  40 Steps") don't collide with the value.
 *  Pass `minStart` to enforce a consistent column across multiple rows (e.g. summary
 *  sub-rows so "2 Scenarios" and "56 Steps" values align at the same column).
 */
function placeUnderCol(row: string, label: string, val: number, minStart?: number): string {
  const valStr = val === 0 ? '-' : String(val);
  const colStart = TABLE_HEADER.indexOf(label);
  const center = colStart + Math.floor((label.length - valStr.length) / 2);
  // Enforce minimum 2-space gap from current row end, OR a caller-supplied minimum
  const enforcedMin = minStart ?? (row.length + 2);
  const targetPos = Math.max(center, enforcedMin);
  let r = row;
  while (r.length < targetPos) r += ' ';
  r += valStr;
  return r;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMs(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatDateTime(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} at ${h12}:${m}:${s} ${ampm}`;
}

function formatElapsed(ms: number): string {
  const h   = Math.floor(ms / 3600000);
  const m   = Math.floor((ms % 3600000) / 60000);
  const s   = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  // Show milliseconds only for sub-minute durations
  if (rem > 0 && h === 0 && m === 0) parts.push(`${rem}ms`);
  return parts.length > 0 ? parts.join(' ') : '0ms';
}

interface StepCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/** Count leaf steps (steps with no children) recursively. StepDef calls are not counted. */
function countLeafSteps(steps: StepResult[]): StepCounts {
  let total = 0, passed = 0, failed = 0, skipped = 0;
  for (const step of steps) {
    if (!step.children || step.children.length === 0) {
      total++;
      if (step.status === 'passed') passed++;
      else if (step.status === 'failed') failed++;
      else skipped++;
    } else {
      const c = countLeafSteps(step.children);
      total += c.total; passed += c.passed; failed += c.failed; skipped += c.skipped;
    }
  }
  return { total, passed, failed, skipped };
}

interface ErrorEntry {
  message: string;
  /** Source location, e.g. "pgwen/features/Example.meta:6" */
  location?: string;
}

/** Collect unique error entries (message + location) from a step tree. */
function collectErrorEntries(steps: StepResult[], seen: Map<string, ErrorEntry>): void {
  for (const step of steps) {
    if (step.error) {
      const key = step.error.message;
      if (!seen.has(key)) {
        const entry: ErrorEntry = { message: key };
        if (step.metaSource) entry.location = step.metaSource;
        seen.set(key, entry);
      }
    }
    if (step.children) collectErrorEntries(step.children, seen);
  }
}

// ─── ConsoleReporter ─────────────────────────────────────────────────────────

export class ConsoleReporter {
  private readonly colors: boolean;
  private readonly depth: number;
  private readonly output: NodeJS.WritableStream;
  private readonly version: string;
  private readonly browser: string;
  private readonly env: string;

  constructor(options: ConsoleReporterOptions = {}) {
    this.colors = options.colors ?? (process.stdout.isTTY === true);
    this.depth = options.depth ?? 1;
    this.output = options.output ?? process.stdout;
    this.version = options.version ?? '';
    this.browser = options.browser ?? '';
    this.env = options.env ?? '';
  }

  // ─── Color helpers ────────────────────────────────────────────────────────

  private c(code: string, text: string): string {
    if (!this.colors) return text;
    return `${code}${text}${ANSI.reset}`;
  }

  private bold(text: string): string  { return this.c(ANSI.bold, text);   }
  private green(text: string): string { return this.c(ANSI.green, text);  }
  private red(text: string): string   { return this.c(ANSI.red, text);    }
  private gray(text: string): string  { return this.c(ANSI.gray, text);   }
  private cyan(text: string): string  { return this.c(ANSI.cyan, text);   }
  private pink(text: string): string  { return this.c(ANSI.pink, text);   }

  /**
   * Build the stats table header with "Passed" rendered in green and the
   * rest in gray — matches the reference framework console output.
   */
  private coloredHeader(): string {
    if (!this.colors) return this.gray(TABLE_HEADER);
    return (
      `${ANSI.gray}             ${ANSI.reset}` +
      `${ANSI.green}Passed${ANSI.reset}` +
      `${ANSI.gray}  Failed  Sustained  Skipped  Pending${ANSI.reset}`
    );
  }

  /**
   * Find `val` within the column region for `label` and wrap it with `colorFn`.
   * Must be applied right-to-left across columns (rightmost first) so earlier
   * column positions are not shifted by the ANSI code insertion.
   */
  private colorizeAtLabel(
    row: string,
    label: string,
    val: number,
    colorFn: (s: string) => string,
  ): string {
    if (val === 0) return row; // '-' stays uncolored
    const valStr = String(val);
    const colStart = TABLE_HEADER.indexOf(label);
    if (colStart < 0) return row;
    const colEnd   = colStart + label.length;
    const idx = row.indexOf(valStr, colStart);
    if (idx >= 0 && idx < colEnd) {
      return row.slice(0, idx) + colorFn(valStr) + row.slice(idx + valStr.length);
    }
    return row;
  }

  /**
   * Colorize a `buildValuesRow()` result: passed → green, failed/sustained → red.
   * Processes columns right-to-left so ANSI insertions don't shift earlier positions.
   */
  private colorizeValuesRow(row: string, cols: TableCols): string {
    let r = row;
    if (cols.sustained > 0) r = this.colorizeAtLabel(r, 'Sustained', cols.sustained, this.red.bind(this));
    if (cols.failed > 0)    r = this.colorizeAtLabel(r, 'Failed',    cols.failed,    this.red.bind(this));
    if (cols.passed > 0)    r = this.colorizeAtLabel(r, 'Passed',    cols.passed,    this.green.bind(this));
    return r;
  }

  /**
   * Colorize a sub-row: passed counts → green under 'Passed' column,
   * failed counts → red under 'Failed' column. Processes right-to-left.
   */
  private colorizeSubRow(row: string, passedVal: number, failedVal: number): string {
    let r = row;
    if (failedVal > 0)  r = this.colorizeAtLabel(r, 'Failed', failedVal, this.red.bind(this));
    if (passedVal > 0)  r = this.colorizeAtLabel(r, 'Passed', passedVal, this.green.bind(this));
    return r;
  }

  private write(line: string): void {
    this.output.write(line + '\n');
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Print the pgwen banner. Call once before execution starts.
   * Matches the reference framework's banner format: large ASCII art logo, welcome line, target info.
   */
  printBanner(): void {
    this.write('');
    for (const line of PGWEN_LOGO_LINES) {
      this.write(this.bold(this.cyan(line)));
    }
    this.write('');
    const welcomeLine = `Welcome to pgwen${this.version ? ` v${this.version}` : ''}`;
    this.write(welcomeLine);
    this.write('playwright.dev');
    this.write('');
    if (this.browser) this.write(`Target browser: ${this.bold(this.browser)}`);
    if (this.env)     this.write(`Target environment: ${this.bold(this.env)}`);
    this.write('');
  }

  /**
   * Print report paths after all reports are generated.
   * Matches the reference framework format: "Reports:" header, right-aligned labels, relative paths.
   * @param entries  Array of {label, path} pairs, e.g. {label: 'HTML', path: '...'}
   */
  printReports(entries: ReportEntry[]): void {
    if (entries.length === 0) return;
    // Compute max label width for right-alignment
    const maxLabelLen = Math.max(...entries.map((e) => e.label.length));
    this.write('');
    this.write(this.bold('Reports:'));
    this.write('');
    for (const e of entries) {
      const absPath = path.isAbsolute(e.path) ? e.path : path.resolve(process.cwd(), e.path);
      const labelPad = e.label.padStart(maxLabelLen);
      this.write(`  ${this.bold(labelPad)}   ${this.cyan(absPath)}`);
    }
    this.write('');
  }

  /**
   * Print the result of a single feature run.
   * Called (via streaming callback) after each feature completes.
   */
  printFeature(result: RunResult): void {
    // Feature header — include [x of N] when driven by a data feed
    const firstScenario = result.scenarios[0];
    const recordNumber = firstScenario?.recordNumber;
    const recordTotal  = firstScenario?.recordTotal;
    const recordSuffix = (recordNumber != null && recordTotal != null)
      ? ` [${recordNumber} of ${recordTotal}]`
      : '';

    this.write('');
    this.write(`${this.pink(this.bold('Feature:'))} ${result.featureName}${recordSuffix}`);
    this.write('');

    // Scenarios
    for (const scenario of result.scenarios) {
      this.printScenario(scenario, '  ');
    }

    // Aggregate stats for this feature
    let passedScenarios = 0, failedScenarios = 0, skippedScenarios = 0;
    const errorEntries = new Map<string, ErrorEntry>();
    let totalSteps = 0, passedSteps = 0, failedSteps = 0, skippedSteps = 0;

    for (const s of result.scenarios) {
      if (s.status === 'passed')       passedScenarios++;
      else if (s.status === 'failed')  failedScenarios++;
      else                             skippedScenarios++;

      if (s.error && !errorEntries.has(s.error.message)) {
        errorEntries.set(s.error.message, { message: s.error.message });
      }
      collectErrorEntries(s.steps, errorEntries);

      const sc = countLeafSteps(s.steps);
      totalSteps   += sc.total;
      passedSteps  += sc.passed;
      failedSteps  += sc.failed;
      skippedSteps += sc.skipped;
    }

    const totalScenarios = result.scenarios.length;

    // Stats table — header + sub-rows only (no separate values row, matches the reference framework)
    this.write(this.coloredHeader());

    const scenarioWord = totalScenarios === 1 ? 'Scenario' : 'Scenarios';
    const stepWord = totalSteps === 1 ? 'Step' : 'Steps';
    const scenarioPrefix = `  ${totalScenarios} ${scenarioWord}`;
    const stepPrefix     = `  ${totalSteps} ${stepWord}`;
    const subRowMinStart = Math.max(scenarioPrefix.length, stepPrefix.length) + 2;

    let scenarioRow = scenarioPrefix;
    scenarioRow = placeUnderCol(scenarioRow, 'Passed',    passedScenarios,  subRowMinStart);
    scenarioRow = placeUnderCol(scenarioRow, 'Failed',    failedScenarios);
    scenarioRow = placeUnderCol(scenarioRow, 'Sustained', 0);
    scenarioRow = placeUnderCol(scenarioRow, 'Skipped',   skippedScenarios);
    scenarioRow = placeUnderCol(scenarioRow, 'Pending',   0);
    this.write(this.colorizeSubRow(scenarioRow, passedScenarios, failedScenarios));

    if (totalSteps > 0) {
      let stepRow = stepPrefix;
      stepRow = placeUnderCol(stepRow, 'Passed',    passedSteps,  subRowMinStart);
      stepRow = placeUnderCol(stepRow, 'Failed',    failedSteps);
      stepRow = placeUnderCol(stepRow, 'Sustained', 0);
      stepRow = placeUnderCol(stepRow, 'Skipped',   skippedSteps);
      stepRow = placeUnderCol(stepRow, 'Pending',   0);
      this.write(this.colorizeSubRow(stepRow, passedSteps, failedSteps));
    }

    // Timing
    this.write('');
    this.write(`  Started   ${formatDateTime(result.startTime)}`);
    this.write(`  Finished  ${formatDateTime(result.endTime)}`);
    this.write(`  Elapsed   ${formatElapsed(result.endTime.getTime() - result.startTime.getTime())}`);
    this.write('');

    // Status line — matches the reference framework: "[duration] Passed ✓" or "[duration] Failed x" at column 0
    if (result.status === 'passed') {
      this.write(`[${formatMs(result.durationMs)}] ${this.green('Passed ✓')}`);
    } else {
      this.write(`[${formatMs(result.durationMs)}] ${this.red('Failed x')}`);
    }

    // Error list — matches the reference framework format: "- message" then indented "[at location]"
    if (errorEntries.size > 0) {
      this.write('');
      for (const entry of errorEntries.values()) {
        this.write(` - ${entry.message}`);
        if (entry.location) this.write(`   [at ${entry.location}]`);
      }
    }

    this.write('');
  }

  /**
   * Print the global summary after all features complete.
   * @param results    All feature run results.
   * @param startTime  When execution started (for elapsed time).
   */
  printSummary(results: RunResult[], startTime?: Date): void {
    const finishTime = new Date();

    let passedFeatures = 0, failedFeatures = 0;
    let totalScenarios = 0, passedScenarios = 0, failedScenarios = 0, skippedScenarios = 0;
    let totalSteps = 0, passedSteps = 0, failedSteps = 0, skippedSteps = 0;
    const errorEntries = new Map<string, ErrorEntry>();

    for (const r of results) {
      if (r.status === 'passed') passedFeatures++; else failedFeatures++;

      for (const s of r.scenarios) {
        totalScenarios++;
        if (s.status === 'passed')       passedScenarios++;
        else if (s.status === 'failed')  failedScenarios++;
        else                             skippedScenarios++;

        if (s.error && !errorEntries.has(s.error.message)) {
          errorEntries.set(s.error.message, { message: s.error.message });
        }
        collectErrorEntries(s.steps, errorEntries);

        const sc = countLeafSteps(s.steps);
        totalSteps   += sc.total;
        passedSteps  += sc.passed;
        failedSteps  += sc.failed;
        skippedSteps += sc.skipped;
      }
    }

    const totalFeatures = results.length;
    const anyFailed = failedFeatures > 0;

    this.write(this.bold('Summary:'));
    this.write('');

    // Per-feature result list FIRST — mirrors the reference framework's summary format:
    //   [duration] Passed ✓  Feature name [X of N]  path/to/feature
    //   [duration] Failed x  Feature name [X of N]  path/to/feature
    for (const r of results) {
      const dur = `[${formatElapsed(r.durationMs)}]`;
      const firstScenario = r.scenarios[0];
      const recNo  = firstScenario?.recordNumber;
      const recTot = firstScenario?.recordTotal;
      const recordSuffix = (recNo != null && recTot != null) ? ` [${recNo} of ${recTot}]` : '';
      const relFile = path.isAbsolute(r.featureFile)
        ? path.relative(process.cwd(), r.featureFile)
        : r.featureFile;
      if (r.status === 'passed') {
        this.write(`  ${this.green(dur)} ${this.green('Passed ✓')}  ${r.featureName}${recordSuffix}  ${relFile}`);
      } else {
        this.write(`  ${this.red(dur)} ${this.red('Failed x')}  ${r.featureName}${recordSuffix}  ${relFile}`);
      }
    }

    this.write('');

    // Stats table — header + sub-rows only (no separate values row, matches the reference framework)
    // All sub-rows (Features, Scenarios, Steps) share the same value column start
    // so their passed/failed counts align vertically regardless of label width.
    this.write(this.coloredHeader());

    const featureWord  = totalFeatures  === 1 ? 'Feature'  : 'Features';
    const scenarioWord = totalScenarios === 1 ? 'Scenario' : 'Scenarios';
    const stepWord     = totalSteps     === 1 ? 'Step'     : 'Steps';
    const featurePrefix  = `  ${totalFeatures} ${featureWord}`;
    const scenarioPrefix = `  ${totalScenarios} ${scenarioWord}`;
    const stepPrefix     = `  ${totalSteps} ${stepWord}`;
    const subRowMinStart = Math.max(featurePrefix.length, scenarioPrefix.length, stepPrefix.length) + 2;

    let featureRow = featurePrefix;
    featureRow = placeUnderCol(featureRow, 'Passed',    passedFeatures,  subRowMinStart);
    featureRow = placeUnderCol(featureRow, 'Failed',    failedFeatures);
    featureRow = placeUnderCol(featureRow, 'Sustained', 0);
    featureRow = placeUnderCol(featureRow, 'Skipped',   0);
    featureRow = placeUnderCol(featureRow, 'Pending',   0);
    this.write(this.colorizeSubRow(featureRow, passedFeatures, failedFeatures));

    let scenarioRow = scenarioPrefix;
    scenarioRow = placeUnderCol(scenarioRow, 'Passed',    passedScenarios,  subRowMinStart);
    scenarioRow = placeUnderCol(scenarioRow, 'Failed',    failedScenarios);
    scenarioRow = placeUnderCol(scenarioRow, 'Sustained', 0);
    scenarioRow = placeUnderCol(scenarioRow, 'Skipped',   skippedScenarios);
    scenarioRow = placeUnderCol(scenarioRow, 'Pending',   0);
    this.write(this.colorizeSubRow(scenarioRow, passedScenarios, failedScenarios));

    if (totalSteps > 0) {
      let stepRow = stepPrefix;
      stepRow = placeUnderCol(stepRow, 'Passed',    passedSteps,  subRowMinStart);
      stepRow = placeUnderCol(stepRow, 'Failed',    failedSteps);
      stepRow = placeUnderCol(stepRow, 'Sustained', 0);
      stepRow = placeUnderCol(stepRow, 'Skipped',   skippedSteps);
      stepRow = placeUnderCol(stepRow, 'Pending',   0);
      this.write(this.colorizeSubRow(stepRow, passedSteps, failedSteps));
    }

    // Timing
    this.write('');
    const totalDurationMs = startTime
      ? finishTime.getTime() - startTime.getTime()
      : results.reduce((sum, r) => sum + r.durationMs, 0);
    if (startTime) {
      this.write(`  Started   ${formatDateTime(startTime)}`);
      this.write(`  Finished  ${formatDateTime(finishTime)}`);
      this.write(`  Elapsed   ${formatElapsed(totalDurationMs)}`);
    }
    this.write('');

    // Total status line — "[duration] Passed ✓" or "[duration] Failed x" at column 0
    if (anyFailed) {
      this.write(`[${formatElapsed(totalDurationMs)}] ${this.red('Failed x')}`);
    } else {
      this.write(`[${formatElapsed(totalDurationMs)}] ${this.green('Passed ✓')}`);
    }

    // Error list — matches the reference framework format: "- message" then indented "[at location]"
    if (anyFailed && errorEntries.size > 0) {
      this.write('');
      for (const entry of errorEntries.values()) {
        this.write(` - ${entry.message}`);
        if (entry.location) this.write(`   [at ${entry.location}]`);
      }
    }

    this.write('');
  }

  // ─── Internal rendering ────────────────────────────────────────────────────

  private printScenario(scenario: ScenarioRunResult, indent: string): void {
    // Background section: shown when driven by a data feed (matches the reference framework output).
    if (scenario.dataFeedFile !== undefined && scenario.recordNumber !== undefined) {
      const recordLabel = scenario.recordTotal != null
        ? `Input data record [${scenario.recordNumber} of ${scenario.recordTotal}]`
        : `Input data record [${scenario.recordNumber}]`;
      this.write(`${indent}${this.pink(this.bold('Background:'))} ${recordLabel}`);
      this.write('');
      this.write(`${indent}  Input data file: ${scenario.dataFeedFile}`);
      this.write('');
      if (scenario.dataFeedRecord) {
        const entries = Object.entries(scenario.dataFeedRecord);
        for (let i = 0; i < entries.length; i++) {
          const [col, val] = entries[i]!;
          const kw = i === 0 ? 'Given' : 'And';
          // Right-align keyword so text starts at the same column as "Given" would
          const kwPad = ' '.repeat(5 - kw.length);
          this.write(`${indent}  ${kwPad}${this.bold(kw)} ${this.cyan('@Data')} ${col} is "${val}"  ${this.green('[0ms]')} ${this.green('✓')}`);
        }
      }
      this.write('');
    }

    // Scenario is a section header — no pass/fail icon here
    this.write(`${indent}${this.pink(this.bold('Scenario:'))} ${scenario.scenarioName}`);
    this.write('');

    if (this.depth !== 0 && scenario.steps.length > 0) {
      this.printSteps(scenario.steps, indent + '  ', 0);
      this.write('');
    }
  }

  private printSteps(steps: StepResult[], indent: string, currentDepth: number): void {
    const maxDepth = this.depth === -1 || this.depth === Infinity ? Infinity : this.depth;

    for (const step of steps) {
      const displayText = step.masked ? '*** (masked)' : step.stepText;
      const keyword = step.originalKeyword ?? step.effectiveKeyword;
      const isStepDef = !!(step.children && step.children.length > 0 && currentDepth < maxDepth);

      // At depth >= 1 (inside a StepDef body), right-align keywords so step text always
      // starts at the same column. "Given"/"While"/"Until" (5 chars) define the column;
      // shorter keywords get leading spaces: "When"/"Then" → +1, "And"/"But" → +2.
      const kwPad = currentDepth >= 1 ? ' '.repeat(Math.max(0, 5 - keyword.length)) : '';

      // Docstring indent: 4 spaces past the keyword-aligned prefix
      const docIndent = indent + kwPad + '    ';

      if (isStepDef) {
        // StepDef invocation: show keyword + text, no timing/icon
        this.write(`${indent}${kwPad}${keyword} ${displayText}`);
        // Each StepDef level adds 6 spaces (matches the reference framework hierarchy depth)
        this.printSteps(step.children!, indent + '      ', currentDepth + 1);
      } else {
        // Leaf step: show keyword + text + [timing] + icon/Failed
        // Always show [Xms] even when duration is 0 (matches the reference framework).
        const timing = step.durationMs != null ? ` ${this.green('[' + formatMs(step.durationMs) + ']')} ` : ' ';
        if (step.status === 'passed') {
          if (step.docString !== undefined) {
            // Render step text, then """" block, then closing """" + timing + icon
            this.write(`${indent}${kwPad}${keyword} ${displayText}`);
            this.write(`${docIndent}""""`);
            for (const line of step.docString.split('\n')) {
              this.write(`${docIndent}${line}`);
            }
            this.write(`${docIndent}""""${timing}${this.green('✓')}`);
          } else {
            this.write(`${indent}${kwPad}${keyword} ${displayText}${timing}${this.green('✓')}`);
          }
        } else if (step.status === 'failed') {
          if (step.docString !== undefined) {
            this.write(`${indent}${kwPad}${keyword} ${displayText}`);
            this.write(`${docIndent}""""`);
            for (const line of step.docString.split('\n')) {
              this.write(`${docIndent}${line}`);
            }
            this.write(`${docIndent}""""${timing}${this.red('Failed x')}`);
          } else {
            this.write(`${indent}${kwPad}${keyword} ${displayText}${timing}${this.red('Failed x')}`);
          }
          // Error message at column 0 (the reference framework behaviour)
          if (step.error) {
            this.write(this.red(step.error.message));
          }
        } else {
          // skipped/abstained — show timing and no icon (greyed)
          this.write(`${indent}${kwPad}${keyword} ${displayText}${timing}`);
        }
      }
    }
  }
}
