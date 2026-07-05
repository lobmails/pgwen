/**
 * reporting/JsonReporter.ts — Machine-readable JSON report for pgwen runs.
 *
 * Writes a single `results.json` file containing the full execution trace in a
 * structured, well-typed format — suitable for dashboards, CI pipelines, and
 * custom tooling that needs to consume run results programmatically.
 *
 * Output file: <outputDir>/results.json
 *
 * Top-level shape:
 *   {
 *     "pgwen": "1.0.0",
 *     "command": "pgwen ...",
 *     "status": "passed" | "failed",
 *     "startedAt": "ISO8601",
 *     "finishedAt": "ISO8601",
 *     "durationMs": 1234,
 *     "summary": {
 *       "features":  { "total": N, "passed": N, "failed": N, "skipped": N },
 *       "scenarios": { "total": N, "passed": N, "failed": N, "skipped": N },
 *       "steps":     { "total": N, "passed": N, "failed": N, "skipped": N, "pending": N }
 *     },
 *     "features": [ ... FeatureTrace objects ... ]
 *   }
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FeatureTrace, ScenarioTrace, StepTrace } from './HtmlReporter';

// ─── Output shape ─────────────────────────────────────────────────────────────

export interface JsonStatusCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
}

export interface JsonSummary {
  features: Omit<JsonStatusCounts, 'pending'>;
  scenarios: Omit<JsonStatusCounts, 'pending'>;
  steps: JsonStatusCounts;
}

export interface JsonStep {
  keyword: string;
  text: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending';
  durationMs: number;
  line?: number;
  error?: string;
  /**
   * Constructor name of the thrown error (e.g. 'TimeoutError',
   * 'DslAssertionError'). Present only on failed steps. Used by
   * `pgwen diagnose` to feed Claude an error-class signal.
   */
  error_class?: string;
  children?: JsonStep[];
  bindings?: Array<{ name: string; value: string; masked: boolean }>;
  /**
   * Rule-based failure classification from `src/diagnose/Classifier.ts`.
   * Present only on failed steps; emitted as-is so downstream tools (the
   * planned `pgwen diagnose` CLI, telemetry sidecars) can consume it.
   */
  failureClass?: {
    class: 'LOCATOR_NOT_FOUND' | 'ASSERTION_FAILED' | 'TIMEOUT' | 'AUTH_FAILURE' | 'NAVIGATION_FAILURE' | 'UNKNOWN';
    confidence: 'high' | 'medium' | 'low';
    signals: string[];
  };
}

export interface JsonScenario {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  isBackground?: boolean;
  dataFeedFile?: string;
  recordNumber?: number;
  recordTotal?: number;
  steps: JsonStep[];
}

export interface JsonFeature {
  file: string;
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metaFiles: Array<{ name: string; file: string; durationMs: number }>;
  scenarios: JsonScenario[];
  /**
   * Absolute path to the Playwright trace.zip if captured for this feature.
   * Consumed by AI-assisted diagnosis to extract the pre-failure DOM
   * snapshot for the focused failure bundle.
   */
  tracePath?: string;
}

export interface JsonReport {
  pgwen: string;
  command: string;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: JsonSummary;
  features: JsonFeature[];
}

// ─── Reporter options ─────────────────────────────────────────────────────────

export interface JsonReportOptions {
  /** pgwen version. Default: '1.0.0' */
  version?: string;
  /** CLI command string shown in the report. Default: 'pgwen' */
  command?: string;
  /** JSON indentation spaces. Default: 2 */
  indent?: number;
}

// ─── JsonReporter ─────────────────────────────────────────────────────────────

export class JsonReporter {
  /**
   * Generate `results.json` in the given output directory.
   *
   * @param traces    Array of FeatureTrace (one per feature file run)
   * @param outputDir Directory to write `results.json` into
   * @param options   Version, command, and indent options
   */
  generate(
    traces: FeatureTrace[],
    outputDir: string,
    options: JsonReportOptions = {}
  ): void {
    fs.mkdirSync(outputDir, { recursive: true });
    const json = this.generateJson(traces, options);
    fs.writeFileSync(path.join(outputDir, 'results.json'), json, 'utf8');
  }

  /**
   * Build and return the JSON string without writing to disk.
   * Useful for testing and for piping JSON into other tools.
   */
  generateJson(
    traces: FeatureTrace[],
    options: JsonReportOptions = {}
  ): string {
    const indent = options.indent ?? 2;
    const report = this.buildReport(traces, options);
    return JSON.stringify(report, null, indent) + '\n';
  }

  /**
   * Build the full `JsonReport` object from an array of FeatureTraces.
   */
  buildReport(
    traces: FeatureTrace[],
    options: JsonReportOptions = {}
  ): JsonReport {
    const version = options.version ?? '1.0.0';
    const command = options.command ?? 'pgwen';

    const overallStatus: 'passed' | 'failed' =
      traces.some((t) => t.status === 'failed') ? 'failed' : 'passed';

    const startedAt = (traces[0]?.startTime ?? new Date()).toISOString();
    const finishedAt = (traces[traces.length - 1]?.endTime ?? new Date()).toISOString();
    const durationMs = traces.reduce((sum, t) => sum + t.durationMs, 0);

    const summary = buildSummary(traces);
    const features = traces.map(traceToJsonFeature);

    return {
      pgwen: version,
      command,
      status: overallStatus,
      startedAt,
      finishedAt,
      durationMs,
      summary,
      features,
    };
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function traceToJsonFeature(trace: FeatureTrace): JsonFeature {
  const feature: JsonFeature = {
    file: trace.file,
    name: trace.name,
    status: trace.status,
    startedAt: trace.startTime.toISOString(),
    finishedAt: trace.endTime.toISOString(),
    durationMs: trace.durationMs,
    metaFiles: trace.metaFiles.map((m) => ({
      name: m.name,
      file: m.file,
      durationMs: m.durationMs,
    })),
    scenarios: trace.scenarios.map(traceToJsonScenario),
  };
  if (trace.tracePath !== undefined) feature.tracePath = trace.tracePath;
  return feature;
}

function traceToJsonScenario(s: ScenarioTrace): JsonScenario {
  const scenario: JsonScenario = {
    name: s.name,
    status: s.status,
    durationMs: s.durationMs,
    steps: s.steps.map(traceToJsonStep),
  };
  if (s.isBackground) scenario.isBackground = s.isBackground;
  if (s.dataFeedFile !== undefined) scenario.dataFeedFile = s.dataFeedFile;
  if (s.recordNumber !== undefined) scenario.recordNumber = s.recordNumber;
  if (s.recordTotal !== undefined) scenario.recordTotal = s.recordTotal;
  return scenario;
}

function traceToJsonStep(s: StepTrace): JsonStep {
  const step: JsonStep = {
    keyword: s.keyword,
    text: s.text,
    status: s.status,
    durationMs: s.durationMs,
  };
  if (s.line !== undefined) step.line = s.line;
  if (s.error !== undefined) step.error = s.error;
  if (s.errorClass !== undefined) step.error_class = s.errorClass;
  if (s.children !== undefined && s.children.length > 0) {
    step.children = s.children.map(traceToJsonStep);
  }
  if (s.bindings !== undefined && s.bindings.length > 0) {
    step.bindings = s.bindings.map((b) => ({
      name: b.name,
      value: b.masked ? '*****' : b.value,
      masked: b.masked,
    }));
  }
  if (s.failureClass !== undefined) step.failureClass = s.failureClass;
  return step;
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(traces: FeatureTrace[]): JsonSummary {
  const allScenarios = traces.flatMap((t) => t.scenarios);
  const allSteps = allScenarios.flatMap((s) => s.steps);

  return {
    features: countFeatureStatuses(traces.map((t) => t.status)),
    scenarios: countScenarioStatuses(allScenarios.map((s) => s.status)),
    steps: countStepStatuses(allSteps.map((s) => s.status)),
  };
}

function countFeatureStatuses(
  statuses: string[]
): Omit<JsonStatusCounts, 'pending'> {
  const counts = { total: statuses.length, passed: 0, failed: 0, skipped: 0 };
  for (const s of statuses) {
    if (s === 'passed') counts.passed++;
    else if (s === 'failed') counts.failed++;
    else if (s === 'skipped') counts.skipped++;
  }
  return counts;
}

function countScenarioStatuses(
  statuses: string[]
): Omit<JsonStatusCounts, 'pending'> {
  const counts = { total: statuses.length, passed: 0, failed: 0, skipped: 0 };
  for (const s of statuses) {
    if (s === 'passed') counts.passed++;
    else if (s === 'failed') counts.failed++;
    else if (s === 'skipped') counts.skipped++;
  }
  return counts;
}

function countStepStatuses(statuses: string[]): JsonStatusCounts {
  const counts: JsonStatusCounts = {
    total: statuses.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
  };
  for (const s of statuses) {
    if (s === 'passed') counts.passed++;
    else if (s === 'failed') counts.failed++;
    else if (s === 'skipped') counts.skipped++;
    else if (s === 'pending') counts.pending++;
  }
  return counts;
}
