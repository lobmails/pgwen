/**
 * ImplicitValues.ts — Register all pgwen.* implicit value providers into Scope.
 *
 * All values listed Section 2.9 are supported. They are registered as
 * lazy resolvers in the global scope so they are always available without explicit
 * binding. Values that depend on execution state are re-computed on each access.
 *
 * Usage:
 *   const ctx = new ExecutionContext();
 *   ImplicitValues.register(scope, ctx);
 *   // Now ${pgwen.feature.name}, ${pgwen.now}, etc. resolve automatically
 *   ctx.feature = { name: 'Login', ... };
 */

import { Scope } from './Scope';
import * as path from 'path';
import { toPosixPath } from '../util/paths';

// ─── Execution context types ──────────────────────────────────────────────────

export type EvalStatus = 'Passed' | 'Failed' | 'Pending' | 'Sustained' | 'Skipped';

export interface FeatureContext {
  uri: string;               // absolute path to .feature file
  name: string;
  startTime: Date;
  endTime?: Date;
  status?: EvalStatus;
  errorMessage?: string;
  sequenceNo?: number;
  language?: string;
  /** 0-based index of this data-feed record execution. Undefined when no feed. */
  recordIndex?: number;
  /** Total number of data-feed records. Undefined when no feed. */
  recordTotal?: number;
}

export interface ScenarioContext {
  name: string;
  startTime: Date;
  endTime?: Date;
  status?: EvalStatus;
  errorMessage?: string;
  /** 0-based index of this Scenario Outline row. Undefined when not an outline. */
  outlineIndex?: number;
  /** Total number of Scenario Outline rows. Undefined when not an outline. */
  outlineTotal?: number;
}

export interface RuleContext {
  name: string;
  startTime: Date;
  endTime?: Date;
  status?: EvalStatus;
  errorMessage?: string;
}

export interface ExamplesContext {
  name: string;
  startTime: Date;
  endTime?: Date;
  status?: EvalStatus;
  errorMessage?: string;
  /** 0-based index of the current Examples row. */
  recordIndex: number;
  /** Total number of rows in the Examples block. */
  recordTotal: number;
}

export interface StepDefContext {
  name: string;
  startTime: Date;
  endTime?: Date;
  status?: EvalStatus;
  errorMessage?: string;
}

export interface StepContext {
  /** The interpolated step text (without leading keyword). */
  text: string;
  /** The effective Gherkin keyword (Given/When/Then/etc.). */
  keyword: string;
}

export interface ExecutionContext {
  feature?: FeatureContext;
  scenario?: ScenarioContext;
  rule?: RuleContext;
  examples?: ExamplesContext;
  stepDef?: StepDefContext;
  /** The currently executing step (updated per-step by Compositor). */
  step?: StepContext;
  /** 0-based index of the current CSV/JSON data record. */
  dataRecordIndex?: number;
  /** 0-based index of the current ForEach/Until/While iteration. */
  iterationIndex?: number;
  /** 0-based index of the current DataTable row (mirrors iterationIndex for @DataTable/@ForEach). */
  tableRecordIndex?: number;
  profileName?: string;
  /** Target environment name (pgwen.target.env config key). Available as ${pgwen.target.env}. */
  targetEnv?: string;
  /** Accumulated soft/sustained assertion errors (not yet thrown). */
  accumulatedErrors: string[];
  /** Current browser WebDriver session ID (set by DSL layer). */
  webSessionId?: string;
  /**
   * Absolute path to the directory where Playwright saves downloaded files.
   * Set by PlaywrightRunner when the browser context is created.
   * Exposed in steps as ${pgwen.downloadDir}.
   */
  downloadDir?: string;
}

// ─── ImplicitValues ───────────────────────────────────────────────────────────

export class ImplicitValues {
  /**
   * Register all pgwen.* lazy resolvers into the provided Scope's global layer.
   * Call once per runner initialisation. The ExecutionContext reference is
   * mutated throughout the run — resolvers read it at access time.
   */
  static register(scope: Scope, ctx: ExecutionContext): void {
    // ── Feature ──────────────────────────────────────────────────────────
    scope.setLazy('pgwen.feature.file.name',         () => featureFileName(ctx, true));
    scope.setLazy('pgwen.feature.file.simpleName',   () => featureFileName(ctx, false));
    scope.setLazy('pgwen.feature.file.path',         () => ctx.feature ? toPosixPath(path.relative(process.cwd(), ctx.feature.uri)) : '');
    scope.setLazy('pgwen.feature.file.absolutePath', () => ctx.feature ? toPosixPath(path.resolve(ctx.feature.uri)) : '');
    scope.setLazy('pgwen.feature.name',              () => ctx.feature?.name ?? '');
    scope.setLazy('pgwen.feature.displayName',       () => {
      const name = ctx.feature?.name ?? '';
      const total = ctx.feature?.recordTotal;
      const idx   = ctx.feature?.recordIndex;
      if (total !== undefined && total > 1 && idx !== undefined) {
        return `${name} [${idx + 1} of ${total}]`;
      }
      return name;
    });
    scope.setLazy('pgwen.feature.language',          () => ctx.feature?.language ?? 'en');
    scope.setLazy('pgwen.feature.eval.status.keyword',           () => ctx.feature?.status ?? 'Pending');
    scope.setLazy('pgwen.feature.eval.status.keyword.upperCased',() => (ctx.feature?.status ?? 'Pending').toUpperCase());
    scope.setLazy('pgwen.feature.eval.status.keyword.lowerCased',() => (ctx.feature?.status ?? 'Pending').toLowerCase());
    scope.setLazy('pgwen.feature.eval.status.isPassed',  () => String(ctx.feature?.status === 'Passed'));
    scope.setLazy('pgwen.feature.eval.status.isFailed',  () => String(ctx.feature?.status === 'Failed'));
    scope.setLazy('pgwen.feature.eval.status.message',   () => ctx.feature?.errorMessage ?? '');
    scope.setLazy('pgwen.feature.eval.status.message.escaped',    () => escapeMessage(ctx.feature?.errorMessage ?? ''));
    scope.setLazy('pgwen.feature.eval.status.message.csvEscaped', () => csvEscape(ctx.feature?.errorMessage ?? ''));
    scope.setLazy('pgwen.feature.eval.start.msecs', () => String(ctx.feature?.startTime?.getTime() ?? ''));
    scope.setLazy('pgwen.feature.eval.started',   () => formatDate(ctx.feature?.startTime));
    scope.setLazy('pgwen.feature.eval.finished',  () => formatDate(ctx.feature?.endTime));
    scope.setLazy('pgwen.feature.eval.duration',  () => humanDuration(ctx.feature?.startTime, ctx.feature?.endTime));
    scope.setLazy('pgwen.feature.eval.duration.msecs', () => durationMs(ctx.feature?.startTime, ctx.feature?.endTime));
    scope.setLazy('pgwen.feature.eval.duration.secs',  () => durationSecs(ctx.feature?.startTime, ctx.feature?.endTime));
    scope.setLazy('pgwen.feature.eval.sequenceNo', () => String(ctx.feature?.sequenceNo ?? 0));

    // ── Scenario ─────────────────────────────────────────────────────────
    scope.setLazy('pgwen.scenario.name',        () => ctx.scenario?.name ?? '');
    scope.setLazy('pgwen.scenario.displayName', () => {
      const name  = ctx.scenario?.name ?? '';
      const total = ctx.scenario?.outlineTotal;
      const idx   = ctx.scenario?.outlineIndex;
      if (total !== undefined && total > 1 && idx !== undefined) {
        return `${name} [${idx + 1} of ${total}]`;
      }
      return name;
    });
    scope.setLazy('pgwen.scenario.eval.status.keyword',           () => ctx.scenario?.status ?? 'Pending');
    scope.setLazy('pgwen.scenario.eval.status.keyword.upperCased',() => (ctx.scenario?.status ?? 'Pending').toUpperCase());
    scope.setLazy('pgwen.scenario.eval.status.keyword.lowerCased',() => (ctx.scenario?.status ?? 'Pending').toLowerCase());
    scope.setLazy('pgwen.scenario.eval.status.isPassed',  () => String(ctx.scenario?.status === 'Passed'));
    scope.setLazy('pgwen.scenario.eval.status.isFailed',  () => String(ctx.scenario?.status === 'Failed'));
    scope.setLazy('pgwen.scenario.eval.status.message',   () => ctx.scenario?.errorMessage ?? '');
    scope.setLazy('pgwen.scenario.eval.status.message.escaped',    () => escapeMessage(ctx.scenario?.errorMessage ?? ''));
    scope.setLazy('pgwen.scenario.eval.status.message.csvEscaped', () => csvEscape(ctx.scenario?.errorMessage ?? ''));
    scope.setLazy('pgwen.scenario.eval.start.msecs', () => String(ctx.scenario?.startTime?.getTime() ?? ''));
    scope.setLazy('pgwen.scenario.eval.started',   () => formatDate(ctx.scenario?.startTime));
    scope.setLazy('pgwen.scenario.eval.finished',  () => formatDate(ctx.scenario?.endTime));
    scope.setLazy('pgwen.scenario.eval.duration',  () => humanDuration(ctx.scenario?.startTime, ctx.scenario?.endTime));
    scope.setLazy('pgwen.scenario.eval.duration.msecs', () => durationMs(ctx.scenario?.startTime, ctx.scenario?.endTime));
    scope.setLazy('pgwen.scenario.eval.duration.secs',  () => durationSecs(ctx.scenario?.startTime, ctx.scenario?.endTime));
    scope.setLazy('pgwen.scenario.outlineIndex',  () =>
      ctx.scenario?.outlineIndex !== undefined ? String(ctx.scenario.outlineIndex) : '');
    scope.setLazy('pgwen.scenario.outlineNumber', () =>
      ctx.scenario?.outlineIndex !== undefined ? String(ctx.scenario.outlineIndex + 1) : '');
    scope.setLazy('pgwen.scenario.outlineTotal',  () =>
      ctx.scenario?.outlineTotal !== undefined ? String(ctx.scenario.outlineTotal) : '');

    // ── Rule ─────────────────────────────────────────────────────────────
    scope.setLazy('pgwen.rule.name',        () => ctx.rule?.name ?? '');
    scope.setLazy('pgwen.rule.displayName', () => ctx.rule?.name ?? '');
    scope.setLazy('pgwen.rule.eval.status.keyword',           () => ctx.rule?.status ?? 'Pending');
    scope.setLazy('pgwen.rule.eval.status.keyword.upperCased',() => (ctx.rule?.status ?? 'Pending').toUpperCase());
    scope.setLazy('pgwen.rule.eval.status.keyword.lowerCased',() => (ctx.rule?.status ?? 'Pending').toLowerCase());
    scope.setLazy('pgwen.rule.eval.status.isPassed',  () => String(ctx.rule?.status === 'Passed'));
    scope.setLazy('pgwen.rule.eval.status.isFailed',  () => String(ctx.rule?.status === 'Failed'));
    scope.setLazy('pgwen.rule.eval.status.message',   () => ctx.rule?.errorMessage ?? '');
    scope.setLazy('pgwen.rule.eval.status.message.escaped',    () => escapeMessage(ctx.rule?.errorMessage ?? ''));
    scope.setLazy('pgwen.rule.eval.status.message.csvEscaped', () => csvEscape(ctx.rule?.errorMessage ?? ''));
    scope.setLazy('pgwen.rule.eval.start.msecs', () => String(ctx.rule?.startTime?.getTime() ?? ''));
    scope.setLazy('pgwen.rule.eval.started',   () => formatDate(ctx.rule?.startTime));
    scope.setLazy('pgwen.rule.eval.finished',  () => formatDate(ctx.rule?.endTime));
    scope.setLazy('pgwen.rule.eval.duration',  () => humanDuration(ctx.rule?.startTime, ctx.rule?.endTime));
    scope.setLazy('pgwen.rule.eval.duration.msecs', () => durationMs(ctx.rule?.startTime, ctx.rule?.endTime));
    scope.setLazy('pgwen.rule.eval.duration.secs',  () => durationSecs(ctx.rule?.startTime, ctx.rule?.endTime));

    // ── Examples ─────────────────────────────────────────────────────────
    scope.setLazy('pgwen.examples.name',        () => ctx.examples?.name ?? '');
    scope.setLazy('pgwen.examples.displayName', () => ctx.examples?.name ?? '');
    scope.setLazy('pgwen.examples.eval.status.keyword',           () => ctx.examples?.status ?? 'Pending');
    scope.setLazy('pgwen.examples.eval.status.keyword.upperCased',() => (ctx.examples?.status ?? 'Pending').toUpperCase());
    scope.setLazy('pgwen.examples.eval.status.keyword.lowerCased',() => (ctx.examples?.status ?? 'Pending').toLowerCase());
    scope.setLazy('pgwen.examples.eval.status.isPassed',  () => String(ctx.examples?.status === 'Passed'));
    scope.setLazy('pgwen.examples.eval.status.isFailed',  () => String(ctx.examples?.status === 'Failed'));
    scope.setLazy('pgwen.examples.eval.status.message',   () => ctx.examples?.errorMessage ?? '');
    scope.setLazy('pgwen.examples.eval.status.message.escaped',    () => escapeMessage(ctx.examples?.errorMessage ?? ''));
    scope.setLazy('pgwen.examples.eval.status.message.csvEscaped', () => csvEscape(ctx.examples?.errorMessage ?? ''));
    scope.setLazy('pgwen.examples.eval.start.msecs', () => String(ctx.examples?.startTime?.getTime() ?? ''));
    scope.setLazy('pgwen.examples.eval.started',   () => formatDate(ctx.examples?.startTime));
    scope.setLazy('pgwen.examples.eval.finished',  () => formatDate(ctx.examples?.endTime));
    scope.setLazy('pgwen.examples.eval.duration',  () => humanDuration(ctx.examples?.startTime, ctx.examples?.endTime));
    scope.setLazy('pgwen.examples.eval.duration.msecs', () => durationMs(ctx.examples?.startTime, ctx.examples?.endTime));
    scope.setLazy('pgwen.examples.eval.duration.secs',  () => durationSecs(ctx.examples?.startTime, ctx.examples?.endTime));
    scope.setLazy('pgwen.examples.table.record.index',      () => String(ctx.examples?.recordIndex ?? 0));
    scope.setLazy('pgwen.examples.table.record.number',     () => String((ctx.examples?.recordIndex ?? 0) + 1));

    // ── DataTable record ─────────────────────────────────────────────────
    // pgwen.table.record.* mirrors pgwen.iteration.* for @DataTable/@ForEach iterations
    scope.setLazy('pgwen.table.record.index',  () => String(ctx.tableRecordIndex ?? ctx.iterationIndex ?? 0));
    scope.setLazy('pgwen.table.record.number', () => String((ctx.tableRecordIndex ?? ctx.iterationIndex ?? 0) + 1));

    // ── StepDef ──────────────────────────────────────────────────────────
    scope.setLazy('pgwen.stepDef.name',        () => ctx.stepDef?.name ?? '');
    scope.setLazy('pgwen.stepDef.displayName', () => ctx.stepDef?.name ?? '');
    scope.setLazy('pgwen.stepDef.eval.status.keyword',           () => ctx.stepDef?.status ?? 'Pending');
    scope.setLazy('pgwen.stepDef.eval.status.keyword.upperCased',() => (ctx.stepDef?.status ?? 'Pending').toUpperCase());
    scope.setLazy('pgwen.stepDef.eval.status.keyword.lowerCased',() => (ctx.stepDef?.status ?? 'Pending').toLowerCase());
    scope.setLazy('pgwen.stepDef.eval.status.isPassed',  () => String(ctx.stepDef?.status === 'Passed'));
    scope.setLazy('pgwen.stepDef.eval.status.isFailed',  () => String(ctx.stepDef?.status === 'Failed'));
    scope.setLazy('pgwen.stepDef.eval.status.message',   () => ctx.stepDef?.errorMessage ?? '');
    scope.setLazy('pgwen.stepDef.eval.status.message.escaped',    () => escapeMessage(ctx.stepDef?.errorMessage ?? ''));
    scope.setLazy('pgwen.stepDef.eval.status.message.csvEscaped', () => csvEscape(ctx.stepDef?.errorMessage ?? ''));
    scope.setLazy('pgwen.stepDef.eval.start.msecs', () => String(ctx.stepDef?.startTime?.getTime() ?? ''));
    scope.setLazy('pgwen.stepDef.eval.started',   () => formatDate(ctx.stepDef?.startTime));
    scope.setLazy('pgwen.stepDef.eval.finished',  () => formatDate(ctx.stepDef?.endTime));
    scope.setLazy('pgwen.stepDef.eval.duration',  () => humanDuration(ctx.stepDef?.startTime, ctx.stepDef?.endTime));
    scope.setLazy('pgwen.stepDef.eval.duration.msecs', () => durationMs(ctx.stepDef?.startTime, ctx.stepDef?.endTime));
    scope.setLazy('pgwen.stepDef.eval.duration.secs',  () => durationSecs(ctx.stepDef?.startTime, ctx.stepDef?.endTime));

    // ── Current step ─────────────────────────────────────────────────────
    // Updated by Compositor before each step executes (via ctx.step)
    scope.setLazy('pgwen.step.name',    () => ctx.step?.text ?? '');
    scope.setLazy('pgwen.step.keyword', () => ctx.step?.keyword ?? '');

    // ── Loop / iteration ─────────────────────────────────────────────────
    scope.setLazy('pgwen.iteration.index',  () => String(ctx.iterationIndex ?? 0));
    scope.setLazy('pgwen.iteration.number', () => String((ctx.iterationIndex ?? 0) + 1));

    // ── Data feed record ─────────────────────────────────────────────────
    scope.setLazy('pgwen.data.record.index',  () => String(ctx.dataRecordIndex ?? 0));
    scope.setLazy('pgwen.data.record.number', () => String((ctx.dataRecordIndex ?? 0) + 1));
    // Legacy (non-pgwen-prefixed) aliases — also binds these for backwards compat
    scope.setLazy('data.record.index',  () => String(ctx.dataRecordIndex ?? 0));
    scope.setLazy('data.record.number', () => String((ctx.dataRecordIndex ?? 0) + 1));

    // ── Profile ──────────────────────────────────────────────────────────
    scope.setLazy('pgwen.profile.name', () => ctx.profileName ?? '');
    scope.setLazy('pgwen.target.env',   () => ctx.targetEnv ?? '');

    // ── Web session ──────────────────────────────────────────────────────
    scope.setLazy('pgwen.web.sessionId', () => ctx.webSessionId ?? '');

    // ── Download directory ───────────────────────────────────────────────
    scope.setLazy('pgwen.downloadDir', () => ctx.downloadDir ?? '');

    // ── Accumulated errors ───────────────────────────────────────────────
    scope.setLazy('pgwen.accumulated.errors', () =>
      ctx.accumulatedErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')
    );
    scope.setLazy('pgwen.accumulated.errors:JSONArray', () =>
      JSON.stringify(ctx.accumulatedErrors)
    );

    // ── Date/time ────────────────────────────────────────────────────────
    // pgwen.now → ISO datetime string
    scope.setLazy('pgwen.now', () => new Date().toISOString());
    // pgwen.now:format — handled dynamically via the proxy below
    registerNowProxy(scope);
  }
}

// ─── pgwen.now:format proxy ────────────────────────────────────────────────────

/**
 * Register a dynamic getter for any key matching "pgwen.now:<format>".
 * Since Scope.get() is a direct Map lookup, we need a workaround:
 * we inject a special lazy binding that routes unknown pgwen.now:* keys.
 *
 * The StringInterpolator will call scope.get("pgwen.now:yyyy-MM-dd").
 * We pre-register a set of common formats, and fall back to ISO for others.
 */
function registerNowProxy(scope: Scope): void {
  // Pre-register common formats for direct scope.get() lookup.
  // Any other pattern is handled dynamically by StringInterpolator via formatNow().
  const formats = [
    'yyyy-MM-dd',
    'dd/MM/yyyy',
    'MM/dd/yyyy',
    'yyyy-MM-dd HH:mm:ss',
    'dd-MM-yyyy',
    'yyyyMMdd',
    "yyyy-MM-dd'T'HH:mm:ss",
    'HH:mm:ss',
    'HH:mm',
    'dd MMM yyyy',
    'dd-MMM-yyyy',
    'MMM dd, yyyy',
    'yyyy-MM-dd HH:mm:ss.SSS',
    'yyyyMMddHHmmss',
    'yyyyMMddHHmmssSSS',
    'EEE, dd MMM yyyy HH:mm:ss z',
  ];
  for (const fmt of formats) {
    scope.setLazy(`pgwen.now:${fmt}`, () => formatNow(fmt));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function featureFileName(ctx: ExecutionContext, withExt: boolean): string {
  if (!ctx.feature?.uri) return '';
  const base = path.basename(ctx.feature.uri);
  return withExt ? base : base.replace(/\.[^.]+$/, '');
}

function formatDate(d?: Date): string {
  if (!d) return '';
  return d.toISOString().replace('T', ' ').slice(0, 23);
}

function humanDuration(start?: Date, end?: Date): string {
  if (!start) return '';
  const ms = (end ?? new Date()).getTime() - start.getTime();
  const secs = Math.floor(ms / 1000);
  const remainMs = ms % 1000;
  if (secs === 0) return `${remainMs}ms`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins === 0) return `${secs}s ${remainMs}ms`;
  return `${mins}m ${remainSecs}s ${remainMs}ms`;
}

function durationMs(start?: Date, end?: Date): string {
  if (!start) return '0';
  return String((end ?? new Date()).getTime() - start.getTime());
}

function durationSecs(start?: Date, end?: Date): string {
  if (!start) return '0';
  return String(((end ?? new Date()).getTime() - start.getTime()) / 1000);
}

function escapeMessage(msg: string): string {
  return msg
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function csvEscape(msg: string): string {
  if (msg.includes(',') || msg.includes('"') || msg.includes('\n')) {
    return `"${msg.replace(/"/g, '""')}"`;
  }
  return msg;
}

/**
 * Format the current date/time using a Java DateTimeFormatter-style pattern.
 * Supports: yyyy, MM, dd, HH, mm, ss, SSS, EEE (day name), MMM (month name), z (UTC).
 * Exported so StringInterpolator can use it for arbitrary pgwen.now:<format> keys.
 */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatNow(pattern: string): string {
  const now = new Date();
  // Strip Java-style literal quotes around portions (e.g. 'T' → T)
  let result = pattern.replace(/'([^']*)'/g, '$1');
  result = result
    .replace(/yyyy/g,  String(now.getFullYear()))
    .replace(/SSS/g,   pad3(now.getMilliseconds()))
    .replace(/HH/g,    pad2(now.getHours()))
    .replace(/EEE/g,   DAY_NAMES[now.getDay()] ?? '')
    .replace(/MMM/g,   MONTH_NAMES[now.getMonth()] ?? '')
    .replace(/MM/g,    pad2(now.getMonth() + 1))
    .replace(/dd/g,    pad2(now.getDate()))
    .replace(/mm/g,    pad2(now.getMinutes()))
    .replace(/ss/g,    pad2(now.getSeconds()))
    .replace(/\bz\b/g, 'UTC');
  return result;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function pad3(n: number): string { return String(n).padStart(3, '0'); }
