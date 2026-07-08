/**
 * reporting/HtmlReporter.ts — Generate Bootstrap HTML reports output format.
 *
 * Generates a directory structure:
 *   <outputDir>/
 *     index.html                                    ← Summary page
 *     resources/css/pgwen.css                        ← Custom pgwen styles
 *     pgwen-features/
 *       0001-FeatureName/
 *         FeatureName.feature.html                  ← Per-feature detail page
 *
 * HTML uses Bootstrap 3 via CDN + embedded pgwen.css. Mirrors the structure
 * of real the reference HTML report structure so downstream tools recognise it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toPosixPath } from '../util/paths';
import type { RunResult, ScenarioRunResult } from '../execution/Runner';
import type { StepResult, BindingAttachment } from '../engine/Compositor';
import type { FailureClassification } from '../diagnose/Classifier';

// Re-export so callers can reference without importing from Compositor directly
export type { BindingAttachment };

// ─── Trace interfaces ─────────────────────────────────────────────────────────

export interface StepTrace {
  keyword: string;
  text: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending';
  durationMs: number;
  line?: number;
  error?: string;
  /**
   * Constructor name of the thrown error (e.g. 'TimeoutError',
   * 'DslAssertionError'). Set on failed steps only.
   * Carried into JSON for `pgwen diagnose`; not rendered in HTML.
   */
  errorClass?: string;
  children?: StepTrace[];
  /**
   * New scope bindings created during this step's execution.
   * Shown in the "Attachments" dropdown next to the step in the HTML report.
   */
  bindings?: BindingAttachment[];
  /**
   * Source location of the StepDef definition, e.g. "pgwen/meta/CancelRebill.meta:5".
   * Shown as a gray header inside the StepDef expansion panel.
   */
  metaSource?: string;
  /**
   * Annotation tags on the StepDef, e.g. ['@StepDef', '@Context'].
   * Shown as a gray block inside the StepDef expansion panel.
   */
  annotations?: string[];
  /**
   * When true, this is a data-feed binding step rendered inside a Background section.
   * Shown with an @Data annotation prefix in the HTML report.
   */
  isDataStep?: boolean;
  /**
   * Docstring content attached to this step (e.g. JS function body).
   * Rendered as <code class="doc-string"> lines below the step text, with
   * opening/closing """ delimiters, the reference format HTML report style.
   */
  docString?: string;
  /**
   * Inline step annotations active on this step (e.g. ['@Eager'], ['@Try']).
   * Rendered as gray <small> labels before the step text.
   */
  stepAnnotations?: string[];
  /**
   * Populated when this step was produced by an @Examples-annotated StepDef.
   * Triggers the Examples table rendering path in renderStepItem.
   */
  examplesData?: { summaryText: string; header: string[]; rows: string[][] };
  /** True when this trace is a per-row iteration child of an Examples step. */
  isExamplesIteration?: boolean;
  /** 1-based row index within the @Examples iteration. */
  rowIndex?: number;
  /** Total matching rows in the @Examples iteration. */
  totalRows?: number;
  /** Captured parameter name→value pairs when this step resolved to a parameterized StepDef. */
  params?: Record<string, string>;
  /**
   * Rule-based failure classification (see src/diagnose/Classifier.ts).
   * Populated only when `status === 'failed'`. Surfaced as a coloured badge
   * in the HTML report and as a dedicated field in `results.json`.
   */
  failureClass?: FailureClassification;
  /**
   * True when the step was demoted from failed→passed by @Sustained. The step
   * still reports `status: 'passed'` for aggregation purposes, but the report
   * renders a yellow "Sustained" badge and a red panel-danger error block
   * inside the green passed step .
   * Preserved from StepResult.sustained during toStepTrace.
   */
  sustained?: boolean;
}

export interface ScenarioTrace {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  steps: StepTrace[];
  /** When true, this scenario represents a Background section. */
  isBackground?: boolean;
  /** Data feed file if driven by external input. */
  dataFeedFile?: string;
  /** 1-based record number within the feed (e.g. "1 of 5"). */
  recordNumber?: number;
  recordTotal?: number;
  /**
   * Full scope dump captured at scenario failure time.
   * Written as the "Environment" .txt attachment in the HTML report.
   */
  scopeDump?: string;
  /**
   * Absolute path to the failure screenshot, if captured.
   * Written as the "Screenshot" attachment in the HTML report.
   */
  screenshotPath?: string;
}

export interface MetaFileInfo {
  name: string;
  file: string;
  durationMs: number;
  /** When this meta file finished loading. */
  loadTime?: Date;
}

export interface FeatureTrace {
  file: string;
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  startTime: Date;
  endTime: Date;
  metaFiles: MetaFileInfo[];
  scenarios: ScenarioTrace[];
  /** Absolute paths to recorded video files for this feature execution. */
  videoPaths?: string[];
  /**
   * Absolute path to the Playwright trace.zip captured for this feature.
   * Consumed by AI-assisted diagnosis tooling that needs to extract the
   * pre-failure DOM snapshot for the focused failure bundle.
   */
  tracePath?: string;
}

export interface ReportOptions {
  /** pgwen version shown in reports. Default: '1.0.0' */
  version?: string;
  /** Command invocation shown in reports. Default: 'pgwen' */
  command?: string;
}

/** A failed step's error paired with a stable anchor in the feature HTML page. */
interface SummaryErrorLink {
  message: string;
  /** Stable anchor in the feature HTML, e.g. "error-1". */
  anchor: string;
  /** Relative path from outputDir to the feature HTML file. */
  featureHtmlPath: string;
  /** Relative path from outputDir to this step's error-details attachment file. */
  errorDetailsPath?: string;
  /** Relative path from outputDir to this step's environment attachment file. */
  environmentPath?: string;
}

/** Per-feature info collected during feature HTML generation, used in the summary page. */
export interface FeatureSummaryInfo {
  featureHtmlPath: string;
  errorLinks: SummaryErrorLink[];
  /** Video hrefs relative from the HTML outputDir root — used by summary page rows. */
  videoHrefs?: string[];
}

/** Context threaded through render methods for deterministic IDs and error link collection. */
interface RenderCtx {
  /** Sequential counter for generating unique, deterministic HTML element IDs. */
  stepSeq: { value: number };
  /** Collected error links from all failed steps in this feature. */
  errorLinks: SummaryErrorLink[];
  /** Relative path from outputDir to this feature's HTML file. */
  featureHtmlPath: string;
  /** Relative path prefix from outputDir to attachments dir, e.g. "pgwen-features/0001-Foo/attachments/". */
  attachmentsRelPrefix: string;
  /** Scope dump of the current scenario — written as the environment attachment for each error step. */
  scenarioScopeDump?: string;
  /**
   * Relative path (from the feature HTML file) to the scenario's screenshot attachment.
   * Set once per failed scenario before steps are rendered; cleared after scenario is done.
   * Used by renderStepAttachments() to add the Screenshot link to failed-step dropdowns.
   */
  screenshotRelPath?: string;
  /** Mutable summary info being filled during render. */
  summaryInfo: FeatureSummaryInfo;
  /**
   * Dedup map for attachment writes — keyed by `${nameHash}-${contentHash}`.
   * First write of a (name, value) pair allocates a fresh sequence number and
   * writes the file; subsequent renders of the same pair reuse the stored
   * href without bumping the counter or re-writing. Keeps parent + child
   * dropdowns linking to one physical file.
   */
  attachmentMap: Map<string, string>;
}

// ─── Conversion: RunResult → FeatureTrace ─────────────────────────────────────

/**
 * Convert a Runner RunResult into a FeatureTrace for HTML rendering.
 */
export function toFeatureTrace(result: RunResult): FeatureTrace {
  const scenarios: ScenarioTrace[] = [];
  for (const s of result.scenarios) {
    const bgCount = s.backgroundStepCount ?? 0;
    const hasFeedBackground = s.dataFeedFile !== undefined && s.recordNumber !== undefined;
    if (bgCount > 0 && s.steps.length >= bgCount) {
      // Split: first bgCount steps → Background trace, remainder → Scenario trace
      const bgSteps = s.steps.slice(0, bgCount);
      const scenarioSteps = s.steps.slice(bgCount);

      const bgStatus: ScenarioTrace['status'] =
        bgSteps.some((st) => st.status === 'failed') ? 'failed' : 'passed';
      const bgTrace: ScenarioTrace = {
        name: 'Background',
        status: bgStatus,
        durationMs: 0,
        steps: bgSteps.map(toStepTrace),
        isBackground: true,
      };
      if (s.dataFeedFile !== undefined) bgTrace.dataFeedFile = s.dataFeedFile;
      if (s.recordNumber !== undefined) bgTrace.recordNumber = s.recordNumber;
      if (s.recordTotal !== undefined)  bgTrace.recordTotal  = s.recordTotal;
      scenarios.push(bgTrace);

      // Scenario trace (without background steps)
      scenarios.push(toScenarioTrace({ ...s, steps: scenarioSteps }));
    } else if (hasFeedBackground) {
      // No Background: block, but scenario is driven by a data feed.
      // The reference format always renders a Background section with "Input data record [N of M]"
      // and the data file name, even when there are no background steps.
      // Build synthetic @Data step traces from the feed record.
      const dataSteps: StepTrace[] = s.dataFeedRecord
        ? Object.entries(s.dataFeedRecord).map(([col, val], i) => ({
            keyword: i === 0 ? 'Given' : 'And',
            text: `${col} is "${val}"`,
            status: 'passed' as const,
            durationMs: 0,
            isDataStep: true,
          }))
        : [];
      const bgTrace: ScenarioTrace = {
        name: 'Background',
        status: 'passed',
        durationMs: 0,
        steps: dataSteps,
        isBackground: true,
      };
      if (s.dataFeedFile !== undefined) bgTrace.dataFeedFile = s.dataFeedFile;
      if (s.recordNumber !== undefined) bgTrace.recordNumber = s.recordNumber;
      if (s.recordTotal !== undefined) bgTrace.recordTotal = s.recordTotal;
      scenarios.push(bgTrace);
      scenarios.push(toScenarioTrace(s));
    } else {
      scenarios.push(toScenarioTrace(s));
    }
  }

  const metaFiles: MetaFileInfo[] = (result.metaFiles ?? []).map((m) => ({
    name: m.name,
    file: m.file,
    durationMs: m.durationMs,
    loadTime: m.loadTime,
  }));

  return {
    file: result.featureFile,
    name: result.featureName,
    status: result.status,
    durationMs: result.durationMs,
    startTime: result.startTime,
    endTime: result.endTime,
    metaFiles,
    scenarios,
    ...(result.videoPaths ? { videoPaths: result.videoPaths } : {}),
    ...(result.tracePath !== undefined ? { tracePath: result.tracePath } : {}),
  };
}

function toScenarioTrace(s: ScenarioRunResult): ScenarioTrace {
  const trace: ScenarioTrace = {
    name: s.scenarioName,
    status: s.status === 'skipped' ? 'skipped' : s.status,
    durationMs: s.durationMs,
    steps: s.steps.map(toStepTrace),
  };
  if (s.recordNumber !== undefined) trace.recordNumber = s.recordNumber;
  if (s.recordTotal !== undefined)  trace.recordTotal  = s.recordTotal;
  if (s.scopeDump !== undefined) trace.scopeDump = s.scopeDump;
  if (s.screenshotPath !== undefined) trace.screenshotPath = s.screenshotPath;
  return trace;
}

function toStepTrace(s: StepResult): StepTrace {
  // Abstained steps (if-guard condition was false) render with 'skipped'/warning colour
  // to distinguish them from truly-executed passing steps — mirrors the reference grey display.
  const resolvedStatus: StepTrace['status'] =
    s.abstained ? 'skipped' : (s.status === 'skipped' ? 'skipped' : s.status);
  const trace: StepTrace = {
    // Use the original written keyword (e.g. "And", "But") for display;
    // fall back to effectiveKeyword only when originalKeyword is absent.
    keyword: s.originalKeyword ?? s.effectiveKeyword,
    text: s.stepText,
    status: resolvedStatus,
    durationMs: s.durationMs ?? 0,
  };
  if (s.line !== undefined) trace.line = s.line;
  if (s.sustained) trace.sustained = true;
  if (s.error !== undefined) {
    trace.error = s.error.message;
    const ctorName = s.error.constructor?.name;
    if (ctorName) trace.errorClass = ctorName;
  }
  if (s.children !== undefined) trace.children = s.children.map(toStepTrace);
  if (s.bindings !== undefined) trace.bindings = s.bindings;
  if (s.docString !== undefined) trace.docString = s.docString;
  if (s.stepAnnotations !== undefined) trace.stepAnnotations = s.stepAnnotations;
  // Forward optional report-enrichment fields when present on StepResult
  const sr = s as StepResult & { metaSource?: string; annotations?: string[]; isDataStep?: boolean };
  if (sr.metaSource !== undefined) trace.metaSource = sr.metaSource;
  if (sr.annotations !== undefined) trace.annotations = sr.annotations;
  if (sr.isDataStep !== undefined) trace.isDataStep = sr.isDataStep;
  if (s.examplesData !== undefined) trace.examplesData = s.examplesData;
  if (s.isExamplesIteration) trace.isExamplesIteration = true;
  if (s.rowIndex !== undefined) trace.rowIndex = s.rowIndex;
  if (s.totalRows !== undefined) trace.totalRows = s.totalRows;
  if (s.params !== undefined && Object.keys(s.params).length > 0) trace.params = s.params;
  if (s.failureClass !== undefined) trace.failureClass = s.failureClass;
  return trace;
}

// ─── @pgwen/fix footer chip ──────────────────────────────────────────────────

/**
 * Detected `@pgwen/fix` suggestions sibling, for the optional footer chip.
 * Populated only when the run's reports directory contains a sibling
 * `pgwen-fix/suggestions/` directory with at least one `.json` file —
 * i.e. only after pgwen-fix has been run. The main report never shows
 * the chip otherwise (parity baseline).
 */
export interface PgwenFixInfo {
  count: number;
  /** Path relative to the main report's index.html. */
  href: string;
}

/**
 * Detect a pgwen-fix suggestions sidecar next to the main report's
 * outputDir. Returns `undefined` when none is present so the chip is
 * elided entirely from the rendered HTML.
 */
export function detectPgwenFixSuggestions(outputDir: string): PgwenFixInfo | undefined {
  // The pgwen-fix tree lives at <reportsDir>/pgwen-fix/. The HTML report is
  // typically written under <reportsDir>/ directly OR <reportsDir>/html/.
  // Check the most common locations.
  const candidates = [
    { suggestionsDir: path.join(outputDir, 'pgwen-fix', 'suggestions'), href: 'pgwen-fix/index.html' },
    { suggestionsDir: path.join(outputDir, '..', 'pgwen-fix', 'suggestions'), href: '../pgwen-fix/index.html' },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.suggestionsDir)) continue;
    let count = 0;
    try {
      for (const name of fs.readdirSync(c.suggestionsDir)) {
        if (name.endsWith('.json')) count += 1;
      }
    } catch {
      continue;
    }
    if (count > 0) return { count, href: c.href };
  }
  return undefined;
}

function renderPgwenFixChip(info: PgwenFixInfo | undefined): string {
  if (!info) return '';
  const noun = info.count === 1 ? 'suggestion' : 'suggestions';
  return `
    <div style="margin-top: 20px; padding: 8px 12px; background-color: #f5f5f5; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 13px;">
      <span class="badge" style="background-color: #1f23ae;">pgwen-fix</span>
      ${info.count} ${noun} available &middot;
      <a href="${escapeHtml(info.href)}">open pgwen-fix report</a>
    </div>`;
}

// ─── pgwen AI Insights section (separate from the byte-exact main report) ─────
//
// The main HTML report stays byte-exact reference format and readable for non-technical
// users. pgwen's AI layer (diagnose / @pgwen/fix / heal) is surfaced in a
// SEPARATE, self-contained panel at the bottom of index.html — below the
// features — reading only sidecar artifacts already present in the output
// dir. When no AI artifacts exist, nothing renders and the report is free of AI annotations.

const HEAL_HISTORY_DIR = 'heal-history'; // mirrors HealTelemetry.HEAL_HISTORY_SUBDIR

export interface AiFixSuggestion {
  binding_name: string; file: string; line: number;
  old: string; new: string; category: string; confidence: string;
  rationale: string; scenario_name: string;
  patchHref: string; jsonHref: string;
}
export interface AiHealEvent {
  binding_name: string; scenario: string;
  original_selector: string; healed_selector: string | null;
  outcome: string; confidence: string | null; model: string | null;
}
export interface AiDiagnosis {
  scenario_name: string; category: string; confidence: string; explanation: string;
}
export interface AiInsights {
  fixes: AiFixSuggestion[];
  heals: AiHealEvent[];
  diagnoses: AiDiagnosis[];
  fixReportHref?: string;
}

function parseJsonSafe(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
function readJsonFileSafe(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}
function str(v: unknown, fallback = ''): string { return v == null ? fallback : String(v); }

/**
 * Gather pgwen AI-layer artifacts from the output dir for the AI Insights
 * panel. Surface-if-present: reads @pgwen/fix suggestion sidecars, heal
 * telemetry JSONL, and a diagnose.json sidecar (written by
 * `pgwen diagnose --json-out`). Returns undefined when none exist — the
 * normal run path writes none of these, so the report stays free of AI annotations.
 */
export function gatherAiInsights(outputDir: string): AiInsights | undefined {
  const fixes: AiFixSuggestion[] = [];
  let fixReportHref: string | undefined;
  for (const c of [
    { dir: path.join(outputDir, 'pgwen-fix', 'suggestions'), rel: 'pgwen-fix/suggestions', report: 'pgwen-fix/index.html' },
    { dir: path.join(outputDir, '..', 'pgwen-fix', 'suggestions'), rel: '../pgwen-fix/suggestions', report: '../pgwen-fix/index.html' },
  ]) {
    if (!fs.existsSync(c.dir)) continue;
    let names: string[];
    try { names = fs.readdirSync(c.dir); } catch { continue; }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const s = readJsonFileSafe(path.join(c.dir, name)) as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') continue;
      const id = str(s['id'], name.replace(/\.json$/, ''));
      fixes.push({
        binding_name: str(s['binding_name']), file: str(s['file']), line: Number(s['line'] ?? 0),
        old: str(s['old']), new: str(s['new']), category: str(s['category']), confidence: str(s['confidence']),
        rationale: str(s['rationale']), scenario_name: str(s['scenario_name']),
        patchHref: `${c.rel}/${id}.patch`, jsonHref: `${c.rel}/${id}.json`,
      });
    }
    if (fixes.length > 0) { fixReportHref = c.report; break; }
  }

  const heals: AiHealEvent[] = [];
  for (const dir of [path.join(outputDir, HEAL_HISTORY_DIR), path.join(outputDir, '..', HEAL_HISTORY_DIR)]) {
    if (!fs.existsSync(dir)) continue;
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files.sort()) {
      if (!f.endsWith('.jsonl')) continue;
      let content: string;
      try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const e = parseJsonSafe(line) as Record<string, unknown> | undefined;
        if (!e || typeof e !== 'object') continue;
        heals.push({
          binding_name: str(e['binding_name']), scenario: str(e['scenario']),
          original_selector: str(e['original_selector']),
          healed_selector: e['healed_selector'] == null ? null : str(e['healed_selector']),
          outcome: str(e['outcome']),
          confidence: e['claude_confidence'] == null ? null : str(e['claude_confidence']),
          model: e['model'] == null ? null : str(e['model']),
        });
      }
    }
    if (heals.length > 0) break;
  }

  const diagnoses: AiDiagnosis[] = [];
  for (const file of [path.join(outputDir, 'diagnose.json'), path.join(outputDir, '..', 'diagnose.json')]) {
    if (!fs.existsSync(file)) continue;
    const arr = readJsonFileSafe(file);
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      const out = (entry as Record<string, unknown>)?.['output'] as Record<string, unknown> | undefined;
      if (!out) continue;
      const failure = (entry as Record<string, unknown>)?.['failure'] as Record<string, unknown> | undefined;
      diagnoses.push({
        scenario_name: str(failure?.['scenario_name']),
        category: str(out['category']), confidence: str(out['confidence']),
        explanation: str(out['human_explanation']),
      });
    }
    if (diagnoses.length > 0) break;
  }

  if (fixes.length === 0 && heals.length === 0 && diagnoses.length === 0) return undefined;
  const result: AiInsights = { fixes, heals, diagnoses };
  if (fixReportHref) result.fixReportHref = fixReportHref;
  return result;
}

/**
 * Render the AI Insights panel. Uses Bootstrap-3 markup so it
 * looks native, but is visually separated and labelled as the pgwen AI layer.
 */
function renderAiInsightsPanel(ai: AiInsights | undefined): string {
  if (!ai) return '';
  const sections: string[] = [];

  if (ai.diagnoses.length > 0) {
    const rows = ai.diagnoses.map((d) => `
              <li class="list-group-item">
                <span class="label label-info">${escapeHtml(d.category || 'unknown')}</span>
                <small class="text-muted">&nbsp;confidence: ${escapeHtml(d.confidence)}</small>
                <span class="pull-right"><small>${escapeHtml(d.scenario_name)}</small></span>
                <p style="margin: 6px 0 0 0;"><small>${escapeHtml(d.explanation)}</small></p>
              </li>`).join('');
    sections.push(`<h5 style="padding-left: 10px;"><strong>Diagnosis</strong></h5>\n            <ul class="list-group">${rows}\n            </ul>`);
  }

  if (ai.fixes.length > 0) {
    const link = ai.fixReportHref ? ` &middot; <a href="${escapeHtml(ai.fixReportHref)}">full pgwen-fix report</a>` : '';
    const rows = ai.fixes.map((f) => `
              <li class="list-group-item">
                <span class="label label-primary">${escapeHtml(f.binding_name)}</span>
                <small class="text-muted">&nbsp;${escapeHtml(f.file)}:${f.line}</small>
                <span class="pull-right"><small><a href="${escapeHtml(f.patchHref)}" target="_blank">patch</a></small></span>
                <table style="width: 100%; margin-top: 6px;"><tbody class="data-table">
                  <tr><td style="padding: 3px; white-space: nowrap;" align="right"><span class="line-no">old :</span></td><td style="padding: 3px;"><code>${escapeHtml(f.old.trim())}</code></td></tr>
                  <tr><td style="padding: 3px; white-space: nowrap;" align="right"><span class="line-no">new :</span></td><td style="padding: 3px;"><code>${escapeHtml(f.new.trim())}</code></td></tr>
                </tbody></table>
                ${f.rationale ? `<p style="margin: 6px 0 0 0;"><small>${escapeHtml(f.rationale)}</small></p>` : ''}
              </li>`).join('');
    sections.push(`<h5 style="padding-left: 10px;"><strong>Fix suggestions</strong>${link}</h5>\n            <ul class="list-group">${rows}\n            </ul>`);
  }

  if (ai.heals.length > 0) {
    const rows = ai.heals.map((h) => `
              <li class="list-group-item">
                <span class="label label-${h.outcome === 'healed' ? 'success' : 'default'}">${escapeHtml(h.outcome)}</span>
                <span class="label label-primary">${escapeHtml(h.binding_name)}</span>
                ${h.model ? `<span class="pull-right"><small>${escapeHtml(h.model)}${h.confidence ? ' &middot; ' + escapeHtml(h.confidence) : ''}</small></span>` : ''}
                <p style="margin: 6px 0 0 0;"><small><code>${escapeHtml(h.original_selector)}</code>${h.healed_selector ? ` &rarr; <code>${escapeHtml(h.healed_selector)}</code>` : ''}</small></p>
              </li>`).join('');
    sections.push(`<h5 style="padding-left: 10px;"><strong>Heal events</strong></h5>\n            <ul class="list-group">${rows}\n            </ul>`);
  }

  return `
    <div class="panel panel-default" style="margin-top: 20px;">
      <div class="panel-heading">
        <span class="label" style="background-color: #1f23ae;">pgwen AI Insights</span>
        <small class="text-muted">&nbsp; Advanced — pgwen AI layer (diagnose / fix / heal). Not part of the main report format above.</small>
      </div>
      <div class="panel-body">
            ${sections.join('\n            ')}
      </div>
    </div>`;
}

// ─── HtmlReporter ─────────────────────────────────────────────────────────────

export class HtmlReporter {
  /**
   * Ensure the output directory and CSS are initialised.
   * Safe to call multiple times — subsequent calls are no-ops if already created.
   */
  initOutputDir(outputDir: string): void {
    fs.mkdirSync(outputDir, { recursive: true });
    const cssDir = path.join(outputDir, 'resources', 'css');
    fs.mkdirSync(cssDir, { recursive: true });
    fs.writeFileSync(path.join(cssDir, 'pgwen.css'), PGWEN_CSS, 'utf8');
  }

  /**
   * Write a single feature's HTML page immediately (streaming / incremental use).
   * Returns the FeatureSummaryInfo so callers can accumulate it for index.html.
   *
   * @param trace         Feature trace to render
   * @param featureIdx    1-based index of this feature in the total run
   * @param totalFeatures Total number of features in the run
   * @param outputDir     Root HTML output directory
   * @param opts          Version + command strings
   */
  writeFeaturePage(
    trace: FeatureTrace,
    featureIdx: number,
    totalFeatures: number,
    outputDir: string,
    opts: Required<ReportOptions>
  ): FeatureSummaryInfo {
    const slug = slugify(path.basename(trace.file, path.extname(trace.file)));
    const paddedIdx = String(featureIdx).padStart(4, '0');
    const featureDir = path.join(outputDir, 'pgwen-features', `${paddedIdx}-${slug}`);
    const attachmentsDir = path.join(featureDir, 'attachments');
    fs.mkdirSync(featureDir, { recursive: true });

    const featureHtmlPath = `pgwen-features/${paddedIdx}-${slug}/${slug}.feature.html`;
    const attachmentsRelPrefix = `pgwen-features/${paddedIdx}-${slug}/attachments/`;

    // Video paths: relative from featureDir for use in the feature detail page HTML.
    // Also relative from outputDir for use in the summary page.
    const videoHrefs = (trace.videoPaths ?? []).map((vp) => toPosixPath(path.relative(featureDir, vp)));
    const summaryVideoHrefs = (trace.videoPaths ?? []).map((vp) => toPosixPath(path.relative(outputDir, vp)));

    const { html, summaryInfo } = this.generateFeatureHtmlInternal(
      trace, featureIdx, totalFeatures, opts, attachmentsDir, featureHtmlPath, attachmentsRelPrefix,
      videoHrefs.length > 0 ? videoHrefs : undefined
    );
    if (summaryVideoHrefs.length > 0) summaryInfo.videoHrefs = summaryVideoHrefs;
    fs.writeFileSync(path.join(featureDir, `${slug}.feature.html`), html, 'utf8');
    return summaryInfo;
  }

  /**
   * Rewrite index.html with the currently-completed traces.
   * Call after each feature completes to provide live updates.
   *
   * @param completedTraces   All traces completed so far (in order)
   * @param outputDir         Root HTML output directory
   * @param opts              Version + command strings
   * @param featureSummaryInfos  Accumulated summary infos (same order as completedTraces)
   */
  writeSummary(
    completedTraces: FeatureTrace[],
    outputDir: string,
    opts: Required<ReportOptions>,
    featureSummaryInfos: FeatureSummaryInfo[]
  ): void {
    const summary = buildSummary(completedTraces);
    const aiInsights = gatherAiInsights(outputDir);
    const summaryHtml = this.generateSummaryHtml(
      completedTraces, summary, opts, featureSummaryInfos, aiInsights,
    );
    fs.writeFileSync(path.join(outputDir, 'index.html'), summaryHtml, 'utf8');
  }

  /**
   * Generate all HTML report files for the given feature traces (batch mode).
   *
   * @param traces    Array of FeatureTrace (one per feature file run)
   * @param outputDir Root output directory (e.g. 'pgwen/output/reports/html')
   * @param options   Version + command strings for the report header
   */
  generate(
    traces: FeatureTrace[],
    outputDir: string,
    options: ReportOptions = {}
  ): void {
    const opts = {
      version: options.version ?? '1.0.0',
      command: options.command ?? 'pgwen',
    };
    this.initOutputDir(outputDir);
    const featureSummaryInfos: FeatureSummaryInfo[] = [];
    traces.forEach((trace, idx) => {
      featureSummaryInfos.push(this.writeFeaturePage(trace, idx + 1, traces.length, outputDir, opts));
    });
    this.writeSummary(traces, outputDir, opts, featureSummaryInfos);
  }

  // ─── Summary page ────────────────────────────────────────────────────────

  generateSummaryHtml(
    traces: FeatureTrace[],
    summary: SummaryStats,
    opts: Required<ReportOptions>,
    featureSummaryInfos?: FeatureSummaryInfo[],
    aiInsights?: AiInsights,
  ): string {
    const overallStatus = traces.some((t) => t.status === 'failed') ? 'Failed' : 'Passed';
    const statusClass = overallStatus === 'Failed' ? 'danger' : 'success';
    const totalDuration = traces.reduce((sum, t) => sum + t.durationMs, 0);
    const startTime = traces[0]?.startTime ?? new Date();
    const endTime = traces[traces.length - 1]?.endTime ?? new Date();

    // Split traces into failed and passed
    const failedTraces: Array<{ trace: FeatureTrace; globalIdx: number; summaryInfo?: FeatureSummaryInfo }> = [];
    const passedTraces: Array<{ trace: FeatureTrace; globalIdx: number; summaryInfo?: FeatureSummaryInfo }> = [];
    traces.forEach((trace, idx) => {
      const globalIdx = idx + 1;
      const summaryInfo = featureSummaryInfos?.[idx];
      const entry: { trace: FeatureTrace; globalIdx: number; summaryInfo?: FeatureSummaryInfo } = summaryInfo
        ? { trace, globalIdx, summaryInfo }
        : { trace, globalIdx };
      if (trace.status === 'failed') {
        failedTraces.push(entry);
      } else {
        passedTraces.push(entry);
      }
    });

    const failedDuration = failedTraces.reduce((sum, { trace }) => sum + trace.durationMs, 0);
    const passedDuration = passedTraces.reduce((sum, { trace }) => sum + trace.durationMs, 0);

    // Build failed section
    let failedSection = '';
    if (failedTraces.length > 0) {
      const failedRowItems = failedTraces.map(({ trace, globalIdx, summaryInfo }) => {
        const slug = slugify(path.basename(trace.file, path.extname(trace.file)));
        const featureHtmlHref = summaryInfo
          ? summaryInfo.featureHtmlPath
          : `pgwen-features/${String(globalIdx).padStart(4, '0')}-${slug}/${slug}.feature.html`;

        // Per-step error rows — one row per failed step, each with its own Attachments dropdown.
        // Mirrors the reference index.html layout: the 4th cell is a nested table of error rows.
        const errorLinks = summaryInfo?.errorLinks ?? [];
        const errorRowsHtml = errorLinks.map((link) => {
          const attachItems: string[] = [];
          let seq = 1;
          if (link.errorDetailsPath) {
            attachItems.push(renderAttachmentLink(seq++, 'Error details', link.errorDetailsPath, 'danger'));
          }
          if (link.environmentPath) {
            attachItems.push(renderAttachmentLink(seq++, 'Environment', link.environmentPath, 'danger'));
          }
          const dropdown = attachItems.length > 0 ? `
                            <div class="dropdown">
                              <button class="btn btn-danger bg-danger dropdown-toggle" type="button" data-toggle="dropdown">
                                <strong>Attachments</strong>
                                <span class="caret"></span>
                              </button>
                              <ul class="dropdown-menu pull-right" role="menu" style="padding-left:0; max-width: 500px; width: max-content !important;">
                                ${attachItems.join('\n')}
                              </ul>
                            </div>` : '';
          const errorMsg = `<a class="inverted-danger" style="color: #a94442;" href="${escapeHtml(link.featureHtmlPath)}#${escapeHtml(link.anchor)}" target="_top">
                              <span class="text-danger"><small>${escapeHtml(link.message)}</small></span>
                            </a>`;
          return `
                        <tr class="summary-line-0" style="border-top: hidden;">
                          <td class="summary-line-0" style="vertical-align:top;">${dropdown}</td>
                          <td class="summary-line-0">${errorMsg}</td>
                        </tr>`;
        }).join('\n');

        return `
                <tr class="summary-line-2 bg-altrow-danger" style="border-top: hidden;">
                  <td class="summary-line-2" style="padding-left: 0px; white-space: nowrap">
                    <table class="table-responsive"><tbody>
                      <tr class="summary-line-0" style="border-top: hidden;">
                        <td class="summary-line-0" style="vertical-align:top; padding-right: 15px;">
                          <div class="line-no"><small class="unselectable">${globalIdx}</small></div>
                        </td>
                        <td class="summary-line-0" style="vertical-align:top;">
                          <span><small>${formatDate(trace.endTime)}</small></span>
                        </td>
                      </tr>
                    </tbody></table>
                  </td>
                  <td class="summary-line-2" style="width: 0px;"></td>
                  <td class="summary-line-2">
                    <a class="inverted-danger" style="color: #a94442;" href="${escapeHtml(featureHtmlHref)}">
                      <span class="text-danger">${escapeHtml(trace.name)} [${globalIdx} of ${traces.length}]</span>
                    </a>${(summaryInfo?.videoHrefs ?? []).map((href) =>
                      ` &nbsp;<a href="${escapeHtml(href)}" target="_blank" class="inverted-danger"><small>Video</small></a>`
                    ).join('')}
                  </td>
                  <td class="summary-line-2">
                    <table class="table-responsive"><tbody>
                      ${errorRowsHtml}
                    </tbody></table>
                  </td>
                  <td class="summary-line-2">${escapeHtml(toPosixPath(path.isAbsolute(trace.file) ? path.relative(process.cwd(), trace.file) : trace.file))}</td>
                  <td class="summary-line-2" align="right" style="white-space: nowrap;">${formatDuration(trace.durationMs)}</td>
                </tr>`;
      }).join('\n');

      const nf = failedTraces.length;
      failedSection = `
    <div class="panel panel-danger bg-danger">
      <ul class="list-group">
        <li class="list-group-item list-group-item-danger" style="padding: 10px 10px; margin-right: 10px;">
          <span class="label label-danger">Failed</span> ${nf} of ${traces.length} feature${traces.length !== 1 ? 's' : ''}
          <span class="pull-right"><small>${formatDuration(failedDuration)}</small></span>
        </li>
      </ul>
      <div class="panel-body">
        <ul class="list-group">
          <li class="list-group-item list-group-item-danger" style="padding-left:0px; padding-right:0px">
            <table class="table table-responsive">
              <tbody>
                ${failedRowItems}
              </tbody>
            </table>
          </li>
        </ul>
      </div>
    </div>`;
    }

    // Build passed section
    let passedSection = '';
    if (passedTraces.length > 0) {
      const passedRowItems = passedTraces.map(({ trace, globalIdx, summaryInfo }, localIdx) => {
        const slug = slugify(path.basename(trace.file, path.extname(trace.file)));
        const featureHtmlHref = `pgwen-features/${String(globalIdx).padStart(4, '0')}-${slug}/${slug}.feature.html`;
        const altClass = localIdx % 2 === 1 ? ' bg-altrow-success' : '';
        const videoLinks = (summaryInfo?.videoHrefs ?? []).map((href) =>
          ` &nbsp;<a href="${escapeHtml(href)}" target="_blank" class="inverted-success"><small>Video</small></a>`
        ).join('');
        return `
                <tr class="summary-line-2${altClass}" style="border-top: hidden;">
                  <td class="summary-line-2" style="padding-left: 0px; white-space: nowrap">
                    <table class="table-responsive"><tbody>
                      <tr class="summary-line-0" style="border-top: hidden;">
                        <td class="summary-line-0" style="vertical-align:top; padding-right: 15px;">
                          <div class="line-no"><small class="unselectable">${globalIdx}</small></div>
                        </td>
                        <td class="summary-line-0" style="vertical-align:top;">
                          <span><small>${formatDate(trace.endTime)}</small></span>
                        </td>
                      </tr>
                    </tbody></table>
                  </td>
                  <td style="width: 0px;"></td>
                  <td class="summary-line-2">
                    <a class="inverted-success" style="color: #3c763d;" href="${escapeHtml(featureHtmlHref)}">
                      <span class="text-success">${escapeHtml(trace.name)} [${globalIdx} of ${traces.length}]</span>
                    </a>${videoLinks}
                  </td>
                  <td class="summary-line-2">${escapeHtml(toPosixPath(path.isAbsolute(trace.file) ? path.relative(process.cwd(), trace.file) : trace.file))}</td>
                  <td class="summary-line-2" align="right" style="white-space: nowrap;">${formatDuration(trace.durationMs)}</td>
                </tr>`;
      }).join('\n');

      const np = passedTraces.length;
      passedSection = `
    <div class="panel panel-success bg-success">
      <ul class="list-group">
        <li class="list-group-item list-group-item-success" style="padding: 10px 10px; margin-right: 10px;">
          <span class="label label-success">Passed</span> ${np} of ${traces.length} feature${traces.length !== 1 ? 's' : ''}
          <span class="pull-right"><small>${formatDuration(passedDuration)}</small></span>
        </li>
      </ul>
      <div class="panel-body">
        <ul class="list-group">
          <li class="list-group-item list-group-item-success" style="padding-left:0px; padding-right:0px">
            <table class="table table-responsive">
              <tbody>
                ${passedRowItems}
              </tbody>
            </table>
          </li>
        </ul>
      </div>
    </div>`;
    }


    return `<!DOCTYPE html>
<html lang="en">
  <head title="Results Summary">
    <meta charset="utf-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css" />
    <link href="resources/css/pgwen.css" rel="stylesheet" />
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js"></script>
    <script src="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/js/bootstrap.min.js"></script>
  </head>
  <body>
    <table style="width: 100%;" cellpadding="5">
      <tbody>
        <tr>
          <td style="width: 100px;">
            <span style="font-size: 24px; font-weight: bold; color: #1f23ae;">pgwen</span>
          </td>
          <td>
            <h3>Results Summary</h3>
            ${opts.command ? `<small style="color: gray;">${escapeHtml(opts.command)}</small>` : ''}
          </td>
          <td align="right">
            <h3> </h3>
            <span class="badge" style="background-color: #1f23ae;">pgwen</span>
            <p><small style="white-space: nowrap; color: #1f23ae;">v${escapeHtml(opts.version)}</small></p>
          </td>
        </tr>
      </tbody>
    </table>
    <div>
      <span class="pull-right" style="padding-right: 20px; padding-top: 8px;">
        <small>${formatDuration(totalDuration)}</small>
      </span>
      <ol class="breadcrumb" style="padding-right: 20px;">
        <li style="color: gray">
          <span class="caret-left" style="color: #f5f5f5;"></span>
          Summary
        </li>
        <li>
          <span class="badge badge-${statusClass}">${overallStatus}</span>
        </li>
        <li><small><span class="grayed">Started: </span>${formatDate(startTime)}</small></li>
        <li><small><span class="grayed">Finished: </span>${formatDate(endTime)}</small></li>
      </ol>
    </div>
    <div class="panel panel-default">
      <div class="panel-heading" style="padding-right: 20px; padding-bottom: 0px; border-style: none;">
        <span class="label label-black">Results</span>
        <div class="panel-body" style="padding-left: 0px; padding-right: 0px; margin-right: -10px;">
          <span class="pull-right" style="padding-right: 10px;"><small>${formatDuration(totalDuration)}</small></span>
          <table style="width: 100%;" cellpadding="5">
            <tbody>
              <tr>
                <td align="right"><span style="white-space: nowrap;">${summary.features.total} Feature${summary.features.total !== 1 ? 's' : ''}</span></td>
                <td style="width: 99%;">${buildProgressBar(summary.features)}</td>
              </tr>
              <tr>
                <td align="right"><span style="white-space: nowrap;">${summary.scenarios.total} Scenario${summary.scenarios.total !== 1 ? 's' : ''}</span></td>
                <td style="width: 99%;">${buildProgressBar(summary.scenarios)}</td>
              </tr>
              <tr>
                <td align="right"><span style="white-space: nowrap;">${summary.steps.total} Step${summary.steps.total !== 1 ? 's' : ''}</span></td>
                <td style="width: 99%;">${buildProgressBar(summary.steps)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ${failedSection}
    ${passedSection}
    ${renderAiInsightsPanel(aiInsights)}
  </body>
</html>`;
  }

  // ─── Feature page ─────────────────────────────────────────────────────────

  generateFeatureHtml(
    trace: FeatureTrace,
    featureIdx: number,
    totalFeatures: number,
    opts: Required<ReportOptions>,
    attachmentsDir?: string,
    videoHrefs?: string[]
  ): string {
    const { html } = this.generateFeatureHtmlInternal(
      trace, featureIdx, totalFeatures, opts, attachmentsDir,
      'feature.html',
      attachmentsDir ? 'attachments/' : '',
      videoHrefs
    );
    return html;
  }

  private generateFeatureHtmlInternal(
    trace: FeatureTrace,
    featureIdx: number,
    totalFeatures: number,
    opts: Required<ReportOptions>,
    attachmentsDir: string | undefined,
    featureHtmlPath: string,
    attachmentsRelPrefix: string,
    videoHrefs?: string[]
  ): { html: string; summaryInfo: FeatureSummaryInfo } {
    const overallStatus = trace.status === 'failed' ? 'Failed' : 'Passed';
    const statusClass = trace.status === 'failed' ? 'danger' : 'success';
    const relPath = path.relative(process.cwd(), trace.file);

    // Attachment counter: each binding/error attachment gets a unique sequential number.
    // Shared across all scenarios in this feature file.
    const attachCounter = { value: 0 };

    // Initialize RenderCtx
    const summaryInfo: FeatureSummaryInfo = { featureHtmlPath, errorLinks: [] };
    const ctx: RenderCtx = {
      stepSeq: { value: 0 },
      errorLinks: [],
      featureHtmlPath,
      attachmentsRelPrefix,
      summaryInfo,
      attachmentMap: new Map(),
    };

    // Count scenarios and steps (leaf steps only, so sustained-annotated
    // failures inside StepDef bodies are counted correctly).
    const scenarioStats = countStatuses(trace.scenarios.map((s) => ({ status: s.status })));
    const allSteps: StepTrace[] = [];
    for (const s of trace.scenarios) collectLeafSteps(s.steps, allSteps);
    const stepStats = countStatuses(allSteps);

    // Meta section
    const metaSection = trace.metaFiles.length > 0
      ? this.renderMetaSection(trace.metaFiles, ctx)
      : '';

    // Scenario panels
    const scenarioPanels = trace.scenarios
      .map((s, i) => this.renderScenarioPanelItem(s, i, trace.status, attachmentsDir, attachCounter, ctx))
      .join('\n');

    // Copy collected error links into summaryInfo
    summaryInfo.errorLinks = ctx.errorLinks;

    const html = `<!DOCTYPE html>
<html lang="en">
  <head title="Feature Specification - ${escapeHtml(relPath)}">
    <meta charset="utf-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css" />
    <link href="../../resources/css/pgwen.css" rel="stylesheet" />
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js"></script>
    <script src="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/js/bootstrap.min.js"></script>
  </head>
  <body>
    <table style="width: 100%;" cellpadding="5">
      <tbody>
        <tr>
          <td style="width: 100px;">
            <span style="font-size: 24px; font-weight: bold; color: #1f23ae;">pgwen</span>
          </td>
          <td>
            <h3>Feature Specification</h3>
            <small style="color: gray;">${escapeHtml(relPath)}</small>
          </td>
          <td align="right">
            <h3> </h3>
            <span class="badge" style="background-color: #1f23ae;">pgwen</span>
            <p><small style="white-space: nowrap; color: #1f23ae;">v${escapeHtml(opts.version)}</small></p>
          </td>
        </tr>
      </tbody>
    </table>
    <div>
      <span class="pull-right" style="padding-right: 20px; padding-top: 8px;">
        <small>${formatDuration(trace.durationMs)}</small>
      </span>
      <ol class="breadcrumb" style="padding-right: 20px;">
        <li>
          <span class="caret-left"></span>
          <a class="inverted" href="../../index.html">Summary</a>
        </li>
        <li>
          <span class="badge badge-${statusClass}">
            <a class="inverted" id="${statusClass}-link" href="#${overallStatus}" style="color:white;">${overallStatus}</a>
          </span>
        </li>
        <li><small><span class="grayed">Started: </span>${formatDate(trace.startTime)}</small></li>
        <li><small><span class="grayed">Finished: </span>${formatDate(trace.endTime)}</small></li>
        ${(videoHrefs ?? []).map((href) => `
        <li>
          <a href="${escapeHtml(href)}" target="_blank" class="inverted">
            <span class="badge" style="background-color: #555;">Video</span>
          </a>
        </li>`).join('')}
      </ol>
    </div>
    <div class="panel panel-default">
      <div class="panel-heading" style="padding-right: 20px; padding-bottom: 0px; border-style: none;">
        <span class="label label-black">Feature</span>${escapeHtml(trace.name)} [${featureIdx} of ${totalFeatures}]
        <div class="panel-body" style="padding-left: 0px; padding-right: 0px; margin-right: -10px;">
          <span class="pull-right" style="padding-right: 10px;"><small>${formatDuration(trace.durationMs)}</small></span>
          <table style="width: 100%;" cellpadding="5">
            <tbody>
              <tr>
                <td align="right"><span style="white-space: nowrap;">${scenarioStats.total} Scenario${scenarioStats.total !== 1 ? 's' : ''}</span></td>
                <td style="width: 99%;">${buildProgressBar(scenarioStats)}</td>
              </tr>
              <tr>
                <td align="right"><span style="white-space: nowrap;">${stepStats.total} Step${stepStats.total !== 1 ? 's' : ''}</span></td>
                <td style="width: 99%;">${buildProgressBar(stepStats)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ${metaSection}
    <a name="${overallStatus}"></a>
    <div class="panel panel-${statusClass} bg-${statusClass}" style="">
      ${scenarioPanels}
    </div>
  </body>
</html>`;

    return { html, summaryInfo };
  }

  // ─── Meta section ─────────────────────────────────────────────────────────

  private renderMetaSection(metaFiles: MetaFileInfo[], ctx?: RenderCtx): string {
    const rows = metaFiles.map((m, i) => {
      const altClass = i % 2 === 1 ? ' bg-altrow-success' : '';
      const timestamp = m.loadTime ? escapeHtml(formatDate(m.loadTime)) : '';
      // Use relative path if the file is inside cwd, otherwise show as-is
      let displayFile = m.file;
      try { displayFile = path.relative(process.cwd(), m.file); } catch { /* keep absolute */ }
      displayFile = toPosixPath(displayFile);
      return `
                  <tr class="summary-line-2${altClass}" style="border-top: hidden;">
                    <td class="summary-line-2" style="padding-left: 0px; white-space: nowrap">
                      <table class="table-responsive"><tbody>
                        <tr class="summary-line-0" style="border-top: hidden;">
                          <td class="summary-line-0" style="vertical-align:top; padding-right: 15px;"></td>
                          <td class="summary-line-0" style="vertical-align:top;"><small>${timestamp}</small></td>
                        </tr>
                      </tbody></table>
                    </td>
                    <td class="summary-line-2" style="width: 0px;"></td>
                    <td class="summary-line-2">${escapeHtml(m.name)}</td>
                    <td class="summary-line-2">${escapeHtml(displayFile)}</td>
                    <td class="summary-line-2" align="right" style="white-space: nowrap;">${formatDuration(m.durationMs)}</td>
                  </tr>`;
    }).join('\n');

    const collapseId = ctx ? `meta-${ctx.stepSeq.value++}` : `meta-${Date.now()}`;
    return `
    <div class="panel panel-success bg-success">
      <ul class="list-group">
        <li class="list-group-item list-group-item-success" style="padding: 10px 10px; margin-right: 10px;">
          <span class="label label-success">Meta</span>
          <a class="inverted-success" role="button" data-toggle="collapse" href="#${collapseId}" aria-expanded="true" aria-controls="${collapseId}">${metaFiles.length} meta feature${metaFiles.length !== 1 ? 's' : ''}</a>
        </li>
      </ul>
      <div id="${collapseId}" class="panel-collapse collapse">
        <div class="panel-body">
          <ul class="list-group">
            <li class="list-group-item list-group-item-success" style="padding-left:0px; padding-right:0px">
              <table class="table table-responsive">
                <tbody>${rows}</tbody>
              </table>
            </li>
          </ul>
        </div>
      </div>
    </div>`;
  }

  // ─── Scenario panel ───────────────────────────────────────────────────────

  private renderScenarioPanelItem(
    scenario: ScenarioTrace,
    idx: number,
    featureStatus: 'passed' | 'failed',
    attachmentsDir?: string,
    attachCounter?: { value: number },
    ctx?: RenderCtx
  ): string {
    const sc = statusCssClass(scenario.status);
    const featureSc = statusCssClass(featureStatus);
    const label = scenario.isBackground ? 'Background' : 'Scenario';
    const recordSuffix =
      scenario.recordNumber != null && scenario.recordTotal != null
        ? ` [${scenario.recordNumber} of ${scenario.recordTotal}]`
        : '';

    // Make the scenario's scope dump available to renderStepItem so each error step
    // can write its own environment attachment (mirrors the reference per-step env files).
    if (ctx && scenario.scopeDump) {
      ctx.scenarioScopeDump = scenario.scopeDump;
    }

    // Copy the failure screenshot once per scenario into the attachments dir and store the
    // relative path in ctx.  Both renderStepItem (for the failed-step Attachments dropdown)
    // and renderScenarioAttachments (for the scenario-header dropdown) read it from ctx so
    // the file is only written once and the sequential counter is only incremented once.
    if (ctx && scenario.screenshotPath && attachmentsDir && attachCounter) {
      try {
        if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });
        attachCounter.value++;
        const ext = path.extname(scenario.screenshotPath);
        const fileName = `${String(attachCounter.value).padStart(4, '0')}-screenshot${ext}`;
        fs.copyFileSync(scenario.screenshotPath, path.join(attachmentsDir, fileName));
        ctx.screenshotRelPath = `attachments/${fileName}`;
      } catch {
        // Screenshot copy failed — skip silently
      }
    }

    const stepItems = scenario.steps
      .map((step) => this.renderStepItem(step, 0, attachmentsDir, attachCounter, ctx))
      .join('\n');

    const collapseId = ctx ? `scenario-${ctx.stepSeq.value++}` : `scenario-${idx}-${Date.now()}`;

    // Build scenario-level attachments dropdown (Error details + Environment + Screenshot)
    // These appear in the scenario header row for failed scenarios.
    const scenarioAttachments = this.renderScenarioAttachments(
      scenario, sc, attachmentsDir, attachCounter, ctx
    );

    // Clean up scenario-scoped context fields
    if (ctx) {
      delete ctx.scenarioScopeDump;
      delete ctx.screenshotRelPath;
    }

    // Background section: render as collapsible "Input data record" when driven by a data feed.
    if (scenario.isBackground) {
      const hasDataFeed = !!scenario.dataFeedFile && scenario.recordNumber != null;
      if (hasDataFeed) {
        const recordLabel = scenario.recordTotal != null
          ? `Input data record [${scenario.recordNumber} of ${scenario.recordTotal}]`
          : `Input data record [${scenario.recordNumber}]`;
        return `
      <div class="panel panel-${sc} bg-${sc}" style="border-top: none; border-left:none; border-right: none; border-radius: 4px 4px 0 0">
        <ul class="list-group">
          <li class="list-group-item list-group-item-${sc}" style="padding: 10px 10px; margin-right: 10px;">
            <span class="label label-${sc}">Background</span>
            <span class="pull-right"><small>${formatDuration(scenario.durationMs)}</small></span>
            <a class="inverted-${sc}" role="button" data-toggle="collapse" href="#${collapseId}" aria-expanded="true" aria-controls="${collapseId}">${escapeHtml(recordLabel)}</a>
            <div id="${collapseId}" class="panel-collapse collapse" role="tabpanel">
              <p></p>
              <ul class="list-group bg-${sc}">
                <li class="list-group-item bg-${sc}">Input data file: ${escapeHtml(scenario.dataFeedFile!)}</li>
              </ul>
              <div class="panel-body">
                <ul class="list-group" style="margin-right: -20px; margin-left: -10px; margin-top: 10px">
                  ${stepItems}
                </ul>
              </div>
            </div>
          </li>
        </ul>
      </div>`;
      }
      // Background without data feed — render as regular panel
      return `
      <ul class="list-group">
        <li class="list-group-item list-group-item-${sc}" style="padding: 10px 10px; margin-right: 10px;">
          <span class="label label-${sc}">Background</span>
          <span class="pull-right"><small>${formatDuration(scenario.durationMs)}</small></span>
        </li>
      </ul>
      <div class="panel-body">
        <div class="panel-${featureSc}" style="margin-bottom: 0px; border-style: none;">
          <ul class="list-group">
            ${stepItems}
          </ul>
        </div>
      </div>`;
    }

    return `
      <ul class="list-group">
        <li class="list-group-item list-group-item-${sc}" style="padding: 10px 10px; margin-right: 10px;">
          <span class="label label-${sc}">${label}</span>
          <span class="pull-right"><small>${formatDuration(scenario.durationMs)}</small></span>
          ${escapeHtml(scenario.name)}${escapeHtml(recordSuffix)} &nbsp;
          ${scenarioAttachments}
        </li>
      </ul>
      <div class="panel-body">
        <div class="panel-${featureSc}" style="margin-bottom: 0px; border-style: none;">
          <ul class="list-group">
            ${stepItems}
          </ul>
        </div>
      </div>`;
  }

  /**
   * Build the scenario-level "Attachments" dropdown for failed scenarios.
   * Writes "Error details" and "Environment" .txt files; links "Screenshot" if available.
   */
  private renderScenarioAttachments(
    scenario: ScenarioTrace,
    sc: string,
    attachmentsDir?: string,
    attachCounter?: { value: number },
    ctx?: RenderCtx
  ): string {
    if (scenario.status !== 'failed' || !attachmentsDir || !attachCounter) return '';

    const links: string[] = [];
    let linkSeq = 0;

    // 1. Error details (scenario-level — appears in the feature page scenario header dropdown)
    const errorStep = this.findFirstError(scenario.steps);
    if (errorStep) {
      attachCounter.value++;
      linkSeq++;
      const fileName = `${String(attachCounter.value).padStart(4, '0')}-error-details.txt`;
      writeAttachmentFile(attachmentsDir, fileName, errorStep.error ?? 'Unknown error');
      links.push(renderAttachmentLink(linkSeq, 'Error details', `attachments/${fileName}`, sc));
    }

    // 2. Environment (scope dump)
    if (scenario.scopeDump) {
      attachCounter.value++;
      linkSeq++;
      const fileName = `${String(attachCounter.value).padStart(4, '0')}-environment.txt`;
      writeAttachmentFile(attachmentsDir, fileName, scenario.scopeDump);
      links.push(renderAttachmentLink(linkSeq, 'Environment', `attachments/${fileName}`, sc));
    }

    // 3. Screenshot — already copied by renderScenarioPanelItem; just reference ctx path
    if (ctx?.screenshotRelPath) {
      linkSeq++;
      links.push(renderAttachmentLink(linkSeq, 'Screenshot', ctx.screenshotRelPath, sc));
    }

    if (links.length === 0) return '';

    return `
          <div class="dropdown">
            <button class="btn btn-${sc} bg-${sc} dropdown-toggle" type="button" data-toggle="dropdown">
              <strong>Attachments</strong>
              <span class="caret"></span>
            </button>
            <ul class="dropdown-menu pull-right" role="menu" style="padding-left:0; max-width: 500px; width: max-content !important;">
              ${links.join('\n')}
            </ul>
          </div>`;
  }

  /** Recursively find the first failed step with an error message. */
  private findFirstError(steps: StepTrace[]): StepTrace | undefined {
    for (const step of steps) {
      if (step.status === 'failed' && step.error) return step;
      if (step.children) {
        const found = this.findFirstError(step.children);
        if (found) return found;
      }
    }
    return undefined;
  }

  // ─── Step item ────────────────────────────────────────────────────────────

  private renderStepItem(
    step: StepTrace,
    depth = 0,
    attachmentsDir?: string,
    attachCounter?: { value: number },
    ctx?: RenderCtx
  ): string {
    const sc = statusCssClass(step.status);
    const lineNo = step.line != null ? String(step.line) : '';
    const hasChildren = step.children && step.children.length > 0;
    const stepId = ctx ? ctx.stepSeq.value++ : Math.random().toString(36).slice(2, 9);
    const collapseId = `step-${stepId}`;

    const dataPrefix = step.isDataStep
      ? `<span class="grayed"><small>@Data</small></span> `
      : '';

    const stepContent = hasChildren
      ? `<a class="inverted-${sc}" role="button" data-toggle="collapse" href="#${collapseId}" aria-expanded="true" aria-controls="${collapseId}">${escapeHtml(step.text)}</a>`
      : escapeHtml(step.text);

    const metaSourceBlock = step.metaSource
      ? `<span class="grayed"><p><small>${escapeHtml(step.metaSource)}<br /></small></p></span>`
      : '';

    const annotationsBlock = step.annotations && step.annotations.length > 0
      ? `<span class="grayed"><p><small>${step.annotations.map(escapeHtml).join('<br />')}</small></p></span>`
      : '';

    // Failed StepDef panels start expanded so the error is immediately visible.
    // Sustained StepDef panels do the same — the assertion message is the point.
    const collapseClass = hasChildren && (step.status === 'failed' || step.sustained)
      ? 'panel-collapse collapse in'
      : 'panel-collapse collapse';

    // @Examples StepDef — render the Examples data table + per-row Scenario panels.
    // Otherwise render the standard StepDef children list.
    const childrenSection = hasChildren
      ? `
              <div id="${collapseId}" class="${collapseClass}" role="tabpanel">
                <a name="${statusLabel(step.status)}"></a>
                <div class="panel panel-${sc} bg-${sc}" style="margin-left: 20px">
                  <ul class="list-group">
                    <li class="list-group-item list-group-item-${sc}" style="padding: 10px 10px; margin-right: 10px;">
                      ${metaSourceBlock}
                      ${annotationsBlock}
                      <span class="label label-${sc}">StepDef</span>
                      <span class="pull-right"><small>${formatDuration(step.durationMs)}</small></span>
                      ${escapeHtml(step.text)} &nbsp;
                    </li>
                  </ul>
                  <div class="panel-body">
                    ${step.examplesData
                      ? this.renderExamplesPanel(step, sc, attachmentsDir, attachCounter, ctx)
                      : `<div class="panel-${sc}" style="margin-bottom: 0px; border-style: none;">
                      <ul class="list-group">
                        ${step.children!.map((c) => this.renderStepItem(c, depth + 1, attachmentsDir, attachCounter, ctx)).join('\n')}
                      </ul>
                    </div>`}
                  </div>
                </div>
              </div>`
      : '';

    // Sustained steps carry the accumulated assertion error even though status
    // is 'passed' — render it as a red panel-danger block so the message shows
    // as red text inside the green passed step .
    const errorSection = step.error
      ? `
              <div class="panel panel-danger bg-danger" style="margin-top: 5px; margin-left: 50px; padding: 5px 10px;">
                <small><code>${escapeHtml(step.error)}</code></small>
              </div>`
      : '';

    // Yellow "Sustained" badge shown next to the duration on sustained steps.
    // Bootstrap 3 label-warning is yellow — kept inline so no CSS changes
    // are needed in the shipped template.
    const sustainedBadge = step.sustained
      ? `<span class="label label-warning" style="margin-right: 6px;">Sustained</span>`
      : '';

    // Error anchor: attach a named anchor for failed steps with errors so summary can link directly.
    // Also write per-step error-details and environment attachment files (mirrors the reference: each failed
    // step in the index gets its own Attachments dropdown with individual .txt files).
    let errorAnchor = '';
    const stepExtraLinks: { label: string; href: string }[] = [];

    if (step.error && ctx) {
      const anchor = `error-${ctx.errorLinks.length + 1}`;
      const link: SummaryErrorLink = { message: step.error, anchor, featureHtmlPath: ctx.featureHtmlPath };

      if (attachmentsDir && attachCounter) {
        // Per-step error details file
        attachCounter.value++;
        const errFileName = `${String(attachCounter.value).padStart(4, '0')}-error-details.txt`;
        writeAttachmentFile(attachmentsDir, errFileName, step.error);
        link.errorDetailsPath = ctx.attachmentsRelPrefix + errFileName;
        stepExtraLinks.push({ label: 'Error details', href: `attachments/${errFileName}` });

        // Per-step environment file (scope dump at this scenario's point)
        if (ctx.scenarioScopeDump) {
          attachCounter.value++;
          const envFileName = `${String(attachCounter.value).padStart(4, '0')}-environment.txt`;
          writeAttachmentFile(attachmentsDir, envFileName, ctx.scenarioScopeDump);
          link.environmentPath = ctx.attachmentsRelPrefix + envFileName;
          stepExtraLinks.push({ label: 'Environment', href: `attachments/${envFileName}` });
        }
      }

      // Screenshot — copied once at scenario level and stored in ctx
      if (ctx.screenshotRelPath) {
        stepExtraLinks.push({ label: 'Screenshot', href: ctx.screenshotRelPath });
      }

      ctx.errorLinks.push(link);
      errorAnchor = `<a name="${anchor}"></a>`;
    }

    // Per-step "Attachments" dropdown — shown for steps with scope bindings.
    // Failed steps also get Error details / Environment / Screenshot appended to the same dropdown.
    const attachmentsHtml = this.renderStepAttachments(
      step, sc, attachmentsDir, attachCounter,
      stepExtraLinks.length > 0 ? stepExtraLinks : undefined,
      ctx
    );

    // Per-step "Parameters" dropdown — rendered on the outer step row alongside
    // Attachments. Matches the reference layout where both dropdowns sit on the
    // collapsible step row, not inside the inner StepDef panel header.
    const paramsHtml = step.params && Object.keys(step.params).length > 0
      ? this.renderParamsDropdown(step.params, sc)
      : '';

    // Inline annotation labels (e.g. @Eager, @Try) rendered before the step text in gray
    const annotationsHtml = step.stepAnnotations && step.stepAnnotations.length > 0
      ? step.stepAnnotations.map((a) => `<span class="grayed"><small>${escapeHtml(a)}</small></span> `).join('')
      : '';

    // Docstring rendered as <code class="doc-string"> lines inside the step div
    const docstringHtml = step.docString !== undefined
      ? renderDocstringLines(step.docString, sc, step.line)
      : '';

    // Failed steps get an additional bg-danger class on the outer <li> — matches the reference format.
    const liClass = step.status === 'failed'
      ? `list-group-item list-group-item-${sc} bg-${sc}`
      : `list-group-item list-group-item-${sc}`;

    return `
            <li class="${liClass}">
              <a name="${statusLabel(step.status)}-step-${collapseId}"></a>
              ${errorAnchor}
              <div class="bg-${sc}">
                <span class="pull-right"><small>${sustainedBadge}${formatDuration(step.durationMs)}</small></span>
                <div class="line-no"><small class="unselectable">${lineNo}</small></div>
                <div class="keyword-right" style="width:45px">
                  <strong>${escapeHtml(titleCase(step.keyword))}</strong>
                </div>
                ${dataPrefix}${annotationsHtml}${stepContent} &nbsp;  &nbsp;
                ${paramsHtml}${paramsHtml ? ' &nbsp;' : ''}
                ${attachmentsHtml}${docstringHtml}
              </div>
              ${childrenSection}
              ${errorSection}
            </li>`;
  }

  /**
   * Render a "Parameters" dropdown for a step that captured parameter bindings.
   * Mirrors the reference markup exactly: wrapper carries the status background, button
   * keeps default Bootstrap size, table uses `tbody.data-table` with a
   * right-aligned name column.
   */
  private renderParamsDropdown(params: Record<string, string>, sc: string): string {
    const rows = Object.entries(params).map(([name, value]) => `
                          <tr>
                            <td style="padding: 3px; white-space: nowrap;" align="right">
                              <span class="line-no">${escapeHtml(name)} :</span>
                            </td>
                            <td style="padding: 3px">${escapeHtml(value)}</td>
                          </tr>`).join('\n');

    return `
                <div class="dropdown bg-${sc}">
                  <button class="btn btn-${sc} dropdown-toggle" type="button" data-toggle="dropdown">
                    <strong>Parameters </strong>
                    <span class="caret"></span>
                  </button>
                  <ul class="dropdown-menu pull-right" role="menu" style="padding-left:0; max-width: 500px; width: max-content !important;">
                    <li role="presentation" class="text-${sc}">
                      <table style="width: 100%;">
                        <tbody class="data-table">${rows}
                        </tbody>
                      </table>
                    </li>
                  </ul>
                </div>`;
  }

  /**
   * Build the per-step "Attachments" dropdown for steps that created scope bindings.
   * Each binding is written as a .txt file and linked in the dropdown.
   * Masked bindings show "*****" as the file content.
   */
  /**
   * Render the @Examples data table panel and per-row Scenario expansions.
   *
   * Matches the reference HTML structure:
   *   - "Examples" badge + summary text (file, prefix, where)
   *   - Horizontal-scroll table: header row + one clickable row per iteration
   *   - Each row expands to show "Scenario [N of M]" with the body steps
   */
  private renderExamplesPanel(
    step: StepTrace,
    sc: string,
    attachmentsDir?: string,
    attachCounter?: { value: number },
    ctx?: RenderCtx
  ): string {
    const ex = step.examplesData!;

    // Header row (non-clickable)
    const headerCells = ex.header.map((h) => ` ${escapeHtml(h)} `).join('|');
    const headerRowHtml = `
              <li class="list-group-item list-group-item-${sc}">
                <div class="bg-${sc}" style="white-space: nowrap;">
                  <div class="line-no"><small class="unselectable">1</small></div>
                  <div class="keyword-right unselectable" style="width:45px"> </div>
                  <code class="bg-${sc} data-table">|${headerCells}|</code>
                </div>
              </li>`;

    // One data row per matching iteration
    const dataRowsHtml = step.children!.map((child, i) => {
      const rowSc = statusCssClass(child.status);
      const rowCollapseId = ctx ? `examples-row-${ctx.stepSeq.value++}` : `examples-row-${Math.random().toString(36).slice(2, 9)}`;
      const scenCollapseId = ctx ? `examples-scen-${ctx.stepSeq.value++}` : `examples-scen-${Math.random().toString(36).slice(2, 9)}`;
      const rowValues = ex.rows[i] ?? [];
      const rowCells = rowValues.map((v) => ` ${escapeHtml(v)} `).join('|');
      const rowLabel = `${escapeHtml(step.text)} [${child.rowIndex ?? i + 1} of ${child.totalRows ?? step.children!.length}]`;
      const hasBodySteps = child.children && child.children.length > 0;
      const bodyStepsHtml = hasBodySteps
        ? child.children!.map((c) => this.renderStepItem(c, 2, attachmentsDir, attachCounter, ctx)).join('\n')
        : '';

      // Attachments for the row iteration (scope bindings created during body execution)
      const rowAttachmentsHtml = this.renderStepAttachments(child, rowSc, attachmentsDir, attachCounter, undefined, ctx);

      // Error for a failed row iteration
      const rowErrorHtml = child.error
        ? `<div class="panel panel-danger bg-danger" style="margin-top: 5px; margin-left: 50px; padding: 5px 10px;">
             <small><code>${escapeHtml(child.error)}</code></small>
           </div>`
        : '';

      return `
              <li class="list-group-item list-group-item-${rowSc}">
                <div class="bg-${rowSc}" style="white-space: nowrap;">
                  <span class="pull-right"><small>${formatDuration(child.durationMs)}</small></span>
                  <div class="line-no"><small class="unselectable">${i + 2}</small></div>
                  <div class="keyword-right unselectable" style="width:45px"> </div>
                  <a class="inverted-${rowSc}" role="button" data-toggle="collapse" href="#${rowCollapseId}" aria-expanded="true" aria-controls="${rowCollapseId}">
                    <code class="bg-${rowSc} text-${rowSc}">|${rowCells}|</code>
                  </a>
                  ${rowAttachmentsHtml}
                </div>
                ${rowErrorHtml}
                <div id="${rowCollapseId}" class="panel-collapse collapse" role="tabpanel">
                  <a name="${statusLabel(child.status)}"></a>
                  <div class="panel panel-${rowSc} bg-${rowSc}" style="margin-left: 20px">
                    <div class="panel panel-${rowSc} bg-${rowSc}" style="border-top: none; border-left:none; border-right: none; border-radius: 4px 4px 0 0">
                      <ul class="list-group">
                        <li class="list-group-item list-group-item-${rowSc}" style="padding: 10px 10px; margin-right: 10px;">
                          <span class="label label-${rowSc}">Scenario</span>
                          <span class="pull-right"><small>${formatDuration(child.durationMs)}</small></span>
                          <a class="inverted-${rowSc}" role="button" data-toggle="collapse" href="#${scenCollapseId}" aria-expanded="true" aria-controls="${scenCollapseId}">
                            ${rowLabel}
                          </a>
                          <div id="${scenCollapseId}" class="panel-collapse collapse in" role="tabpanel">
                            <p></p>
                            <ul class="list-group" style="margin-right: -20px; margin-left: -10px; margin-top: 10px">
                              ${bodyStepsHtml}
                            </ul>
                          </div>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              </li>`;
    }).join('\n');

    const totalDuration = step.children!.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);

    return `
            <div class="panel-${sc} bg-${sc}" style="margin-bottom: 0px;">
              <ul class="list-group"></ul>
              <div class="panel panel-${sc} bg-${sc}">
                <ul class="list-group">
                  <li class="list-group-item list-group-item-${sc}" style="padding: 10px 10px; margin-right: 10px;">
                    <span class="label label-${sc}">Examples</span>
                    <span class="pull-right"><small>${formatDuration(totalDuration)}</small></span>
                    ${escapeHtml(ex.summaryText)}
                  </li>
                </ul>
                <div class="panel-body">
                  <div class="horizontal-scroll">
                    <ul class="list-group" style="margin-right: -10px; margin-left: -10px">
                      ${headerRowHtml}
                      ${dataRowsHtml}
                    </ul>
                  </div>
                </div>
              </div>
            </div>`;
  }

  /**
   * Render the per-step Attachments control.
   *
   * Always uses a dropdown when there is content (matches the reference format — no inline-pill
   * variant). `extraLinks` carries Error details / Environment / Screenshot for
   * failed steps and is appended after the binding entries.
   *
   * Attachment file writes are deduped via `ctx.attachmentMap` so that a
   * binding aggregated up the StepDef tree links to one physical file across
   * all parent + child dropdowns.
   */
  private renderStepAttachments(
    step: StepTrace,
    sc: string,
    attachmentsDir?: string,
    attachCounter?: { value: number },
    extraLinks?: { label: string; href: string }[],
    ctx?: RenderCtx
  ): string {
    const hasExtra = extraLinks && extraLinks.length > 0;

    // Filter out companion `/javascript` bindings when the base name is also present.
    const baseNames = new Set((step.bindings ?? []).map((b) => b.name));
    const visibleBindings = (step.bindings ?? []).filter(
      (b) => !(b.name.endsWith('/javascript') && baseNames.has(b.name.slice(0, -'/javascript'.length)))
    );

    const canWriteBindings = visibleBindings.length > 0 && !!attachmentsDir && !!attachCounter;

    if (!canWriteBindings && !hasExtra) return '';

    const links: string[] = [];
    let linkSeq = 0;

    if (canWriteBindings) {
      for (const binding of visibleBindings) {
        linkSeq++;
        const content = binding.masked ? '*****' : binding.value;
        const nameHash = fnv1a64(binding.name);
        const contentHash = fnv1a64(content);
        const dedupKey = `${nameHash}-${contentHash}`;
        let href = ctx?.attachmentMap.get(dedupKey);
        if (!href) {
          attachCounter!.value++;
          const safeName = binding.name.replace(/[^a-zA-Z0-9 _-]/g, '_');
          const fileName = `${String(attachCounter!.value).padStart(4, '0')}-${safeName}-${nameHash}-${contentHash}.txt`;
          writeAttachmentFile(attachmentsDir!, fileName, content);
          href = `attachments/${fileName}`;
          ctx?.attachmentMap.set(dedupKey, href);
        }
        links.push(renderAttachmentLink(linkSeq, binding.name, href, sc));
      }
    }

    if (hasExtra) {
      for (const extra of extraLinks!) {
        linkSeq++;
        links.push(renderAttachmentLink(linkSeq, extra.label, extra.href, sc));
      }
    }

    return `
                <div class="dropdown">
                  <button class="btn btn-${sc} bg-${sc} dropdown-toggle" type="button" data-toggle="dropdown">
                    <strong>Attachments</strong>
                    <span class="caret"></span>
                  </button>
                  <ul class="dropdown-menu pull-right" role="menu" style="padding-left:0; max-width: 500px; width: max-content !important;">
                    ${links.join('\n')}
                  </ul>
                </div>`;
  }
}

// ─── Failure class badge ──────────────────────────────────────────────────────

/**
 * Render the rule-based failure classification as a small Bootstrap label.
 * Returns an empty string when no classification is present so the surrounding
 * error block layout is unaffected on legacy traces.
 */
function renderFailureClassBadge(fc: FailureClassification | undefined): string {
  if (!fc) return '';
  const labelClass = ({
    LOCATOR_NOT_FOUND: 'label-warning',
    ASSERTION_FAILED: 'label-danger',
    TIMEOUT: 'label-info',
    AUTH_FAILURE: 'label-warning',
    NAVIGATION_FAILURE: 'label-danger',
    UNKNOWN: 'label-default',
  } as const)[fc.class];
  const tooltip = `Signals: ${fc.signals.join('; ')}`;
  const main = `<span class="label ${labelClass}" style="margin-right: 6px; font-weight: 600;" title="${escapeHtml(tooltip)}">${escapeHtml(fc.class)} · ${escapeHtml(fc.confidence)}</span>`;
  const sibling = renderSiblingRateBadge(fc);
  return main + sibling;
}

/**
 * Sibling-success-rate badge. The classifier records this signal when a
 * locator binding's sibling scenarios in the same run succeeded — a
 * strong indicator that THIS failure is environmental or app-side, not
 * a locator drift.
 *
 * Signal shape (Classifier.ts:219-245):
 *   binding_success_rate_in_run="<name>" <passed>/<total> (rate=<float>)
 *
 * Surfaced as a small chip next to the failure-class badge. Colour
 * coded by rate so on-call can scan quickly:
 *   rate ≥ 0.8 → green   (binding mostly works elsewhere — investigate
 *                          env / app first, not the selector)
 *   rate 0.3-0.8 → amber (mixed — manual look)
 *   rate < 0.3   → red    (binding broadly broken — probable drift)
 *
 * Returns empty string when the signal isn't present (older runs,
 * non-locator failures, single-scenario runs).
 */
function renderSiblingRateBadge(fc: FailureClassification): string {
  // Parse the signal — strict literal prefix to avoid false matches
  // on similar-looking signals in future.
  for (const signal of fc.signals) {
    const m = /^binding_success_rate_in_run="([^"]*)" (\d+)\/(\d+) \(rate=([0-9.]+)\)$/.exec(signal);
    if (!m) continue;
    const bindingName = m[1]!;
    const passed = parseInt(m[2]!, 10);
    const total = parseInt(m[3]!, 10);
    const rate = parseFloat(m[4]!);
    const labelClass =
      rate >= 0.8 ? 'label-success'
    : rate >= 0.3 ? 'label-warning'
    : 'label-danger';
    const tooltip =
      `Binding "${bindingName}" — same name succeeded in ${passed} of ${total} ` +
      `sibling scenarios in this run. ` +
      (rate >= 0.8
        ? 'High sibling success rate suggests the failure is environmental or app-side, NOT a selector drift.'
        : rate >= 0.3
        ? 'Mixed sibling success — manual review recommended.'
        : 'Low sibling success — binding may be broadly broken (probable drift).');
    return (
      `<span class="label ${labelClass}" style="margin-right: 6px; font-weight: 500;" ` +
      `title="${escapeHtml(tooltip)}">siblings ${passed}/${total} (${rate.toFixed(2)})</span>`
    );
  }
  return '';
}

// ─── Attachment file helpers ──────────────────────────────────────────────────

/**
 * Write content to a file in the attachments directory, creating the directory if needed.
 */
function writeAttachmentFile(attachmentsDir: string, fileName: string, content: string): void {
  try {
    if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, fileName), content, 'utf8');
  } catch {
    // Silently skip attachment write failures — report still renders without the link
  }
}

/**
 * 64-bit FNV-1a hash of a UTF-8 string, returned as an unsigned decimal string.
 * Used to build attachment filenames in the form
 *   `<seq>-<safeName>-<nameHash>-<contentHash>.txt`
 * so name + value identity is captured in the filename (mirroring the reference format).
 */
function fnv1a64(input: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString();
}

/**
 * Render a single `<li>` dropdown item linking to an attachment file.
 * The link opens the file in a new browser tab.
 */
function renderAttachmentLink(seq: number, label: string, href: string, sc: string): string {
  return `
                <li role="presentation" class="text-${sc}">
                  <a class="inverted" role="menuitem" tabindex="-1" href="${escapeHtml(href)}" target="_blank">
                    <span class="line-no" style="width: 0px;">${seq}. &nbsp; </span>${escapeHtml(label)}
                    <span class="line-no" style="width: 0px;"> &nbsp; </span>
                  </a>
                </li>`;
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

interface StatusCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  /** Steps demoted from failed→passed by @Sustained. Counted as passed for
   *  aggregation purposes, but surfaced separately here so the progress bar
   *  and stats table can show a yellow "Sustained" segment.
   *  Optional so pre-existing callers that build `StatusCounts` manually keep
   *  working — buildProgressBar treats absent as 0. */
  sustained?: number;
}

interface SummaryStats {
  features: StatusCounts;
  scenarios: StatusCounts;
  steps: StatusCounts;
}

/** Recursively walk step traces, counting only leaf steps (steps without children). */
function collectLeafSteps(steps: StepTrace[], out: StepTrace[]): void {
  for (const s of steps) {
    if (!s.children || s.children.length === 0) out.push(s);
    else collectLeafSteps(s.children, out);
  }
}

function buildSummary(traces: FeatureTrace[]): SummaryStats {
  const features = countStatuses(traces.map((t) => ({ status: t.status })));
  const allScenarios = traces.flatMap((t) => t.scenarios);
  const scenarios = countStatuses(allScenarios.map((s) => ({ status: s.status })));
  const allSteps: StepTrace[] = [];
  for (const s of allScenarios) collectLeafSteps(s.steps, allSteps);
  const steps = countStatuses(allSteps);
  return { features, scenarios, steps };
}

/** Accepts either a bare status string list or a list of items carrying an
 *  optional `sustained` flag. Sustained items are counted as passed AND as
 *  sustained so downstream renderers can distinguish them. */
function countStatuses(items: Array<{ status: string; sustained?: boolean }>): StatusCounts {
  let sustained = 0;
  const counts: StatusCounts = { total: items.length, passed: 0, failed: 0, skipped: 0, pending: 0, sustained: 0 };
  for (const item of items) {
    if (item.status === 'passed') {
      counts.passed++;
      if (item.sustained) sustained++;
    }
    else if (item.status === 'failed') counts.failed++;
    else if (item.status === 'skipped') counts.skipped++;
    else if (item.status === 'pending') counts.pending++;
  }
  counts.sustained = sustained;
  return counts;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

/**
 * Build a Bootstrap 3 progress bar showing passed/failed/skipped/pending percentages.
 */
export function buildProgressBar(counts: StatusCounts): string {
  const { total, passed, failed, skipped, pending } = counts;
  // Sustained is optional in older call sites — default to 0 so callers that
  // pre-date the sustained progress-bar segment keep rendering unchanged.
  const sustained = counts.sustained ?? 0;
  // Sustained steps are counted inside `passed`; split them out so the green
  // segment shows only non-sustained passes and the yellow segment shows
  // sustained passes. matches progress bar.
  const purePassed = Math.max(0, passed - sustained);

  function pct(n: number): string {
    return total === 0 ? '0.0%' : `${(n / total) * 100}%`;
  }

  function label(n: number, name: string): string {
    const p = total === 0 ? 0 : Math.round((n / total) * 10000) / 100;
    return `${n} ${name} - ${p.toFixed(2).replace('.00', '')}%`;
  }

  return `<div class="progress">
    <div class="progress-bar progress-bar-success" style="width: ${pct(purePassed)};">
      <span>${label(purePassed, 'Passed')}</span>
    </div>
    <div class="progress-bar progress-bar-danger" style="width: ${pct(failed)};">
      <span>${label(failed, 'Failed')}</span>
    </div>
    <div class="progress-bar progress-bar-sustained" style="width: ${pct(sustained)}; background-color: #f0ad4e;">
      <span>${label(sustained, 'Sustained')}</span>
    </div>
    <div class="progress-bar progress-bar-warning" style="width: ${pct(skipped)};">
      <span>${label(skipped, 'Skipped')}</span>
    </div>
    <div class="progress-bar progress-bar-info" style="width: ${pct(pending)};">
      <span>${label(pending, 'Pending')}</span>
    </div>
  </div>`;
}

/**
 * Format a duration in ms as "Xm Ys Zms", "Xs Zms", or "Zms".
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const remainMs = ms % 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;

  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || minutes > 0) parts.push(`${seconds}s`);
  if (remainMs > 0) parts.push(`${remainMs}ms`);
  return parts.join(' ');
}

/**
 * Format a Date matching report format: "Mon Apr 27 23:28:40 AEST 2026"
 * Pattern: EEE MMM dd HH:mm:ss <tz-short> yyyy
 */
export function formatDate(date: Date): string {
  const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const day  = DAYS[date.getDay()]!;
  const mon  = MONTHS[date.getMonth()]!;
  // Space-pad single-digit day (matches Java Date.toString() "Mon Apr  1 ...")
  const dd   = date.getDate() < 10 ? ` ${date.getDate()}` : String(date.getDate());
  const hh   = String(date.getHours()).padStart(2, '0');
  const mm   = String(date.getMinutes()).padStart(2, '0');
  const ss   = String(date.getSeconds()).padStart(2, '0');
  const yyyy = date.getFullYear();

  // Short timezone abbreviation e.g. "AEST", "EST", "PDT".
  // Intl sometimes returns "GMT+10" instead of "AEST" depending on the ICU data.
  // Fall back: derive abbreviation from the long name ("Australian Eastern Standard Time" → "AEST").
  let tzShort = new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
  if (/^(GMT|UTC)[+-]/.test(tzShort)) {
    const longTz = new Intl.DateTimeFormat('en', { timeZoneName: 'long' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
    // "Australian Eastern Standard Time" → "AEST"
    const abbr = longTz.split(' ').map((w) => w[0] ?? '').join('');
    if (abbr) tzShort = abbr;
  }

  return `${day} ${mon} ${dd} ${hh}:${mm}:${ss} ${tzShort} ${yyyy}`;
}

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a feature file name to a URL-safe slug (preserves alphanumeric and hyphens).
 */
export function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Map step/scenario status to Bootstrap CSS colour name. */
export function statusCssClass(status: string): string {
  switch (status) {
    case 'passed': return 'success';
    case 'failed': return 'danger';
    case 'skipped': return 'warning';
    case 'pending': return 'info';
    default: return 'default';
  }
}

/** Status label for anchor names (Passed / Failed / Skipped / Pending). */
function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Capitalise the first letter of a string (e.g. "given" → "Given"). */
function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Render a docstring as a series of <code class="doc-string"> rows inside the step div.
 * Matches the reference format HTML report format:
 *   - Opening """ on first line
 *   - Content lines with preserved indentation (spaces → &nbsp;)
 *   - Closing """ on last line
 *   - Line numbers start at step.line + 1 when step.line is known
 */
function renderDocstringLines(docString: string, sc: string, stepLine?: number): string {
  const contentLines = docString.split('\n');
  const allLines = ['"""', ...contentLines, '"""'];

  return allLines.map((rawLine, idx) => {
    const lineNo = stepLine != null ? stepLine + 1 + idx : undefined;
    const lineNoHtml = lineNo != null ? `<small class="unselectable">${lineNo}</small>` : '';
    // Preserve leading whitespace: each space → &nbsp;, each tab → 4 &nbsp;
    const leadingMatch = /^(\s*)/.exec(rawLine);
    const leading = leadingMatch?.[1] ?? '';
    const rest = rawLine.slice(leading.length);
    const encodedLeading = leading
      .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
      .replace(/ /g, '&nbsp;');
    return `
              <div class="bg-${sc}">
                <div class="line-no">${lineNoHtml}</div>
                <div class="keyword-right unselectable" style="width:45px"> </div>
                <code class="bg-${sc} doc-string">${encodedLeading}${escapeHtml(rest)}</code>
              </div>`;
  }).join('');
}

// ─── Embedded pgwen.css ────────────────────────────────────────────────────────

const PGWEN_CSS = `/*
 * pgwen HTML report styles — based on the reference pgwen.css
 * Original: Copyright 2014 Branko Juric, Brady Wood (Apache 2.0)
 */

body {
  margin-top: 20px;
  margin-bottom: 20px;
  margin-left: 40px;
  margin-right: 40px;
}

div { word-wrap: break-word; }

.breadcrumb { margin-top: 10px; margin-bottom: 10px; }
.list-group { margin-bottom: 0px; padding-left: 2px; }
.progress { margin-bottom: 0px; }
.panel-body { padding: 10px 10px; }
.panel-heading { padding: 10px 10px; }

.list-group-item {
  padding: 1px 10px;
  color: #333333;
  border: 0px;
}

.badge-success { background-color: #5cb85c; }
.badge-danger  { background-color: #d9534f; }
.badge-info    { background-color: #5bc0de; }
.badge-warning { background-color: #f0ad4e; }

.bg-success  { background-color: #dff0d8; border-color: #b3dba3; }
.bg-danger   { background-color: #f2dede; border-color: #e2b6b6; }
.bg-info     { background-color: #d9edf7; border-color: #abd7ed; }
.bg-warning  { background-color: #fcf8e3; border-color: #f5e8a3; }

.bg-altrow-success { background-color: #e9f4e4; }
.bg-altrow-danger  { background-color: #f6e8e8; }
.bg-altrow-info    { background-color: #d4f2f9; }
.bg-altrow-warning { background-color: #fdfaeb; }
.bg-default        { background-color: #f5f5f5; border-color: #d9d9d9; }

.label { font-size: 100%; margin-right: 5px; }
.label-black { background-color: #333333; }
.panel { margin-bottom: 10px; }

.btn { padding: 0px 3px; font-size: 12px; }
.btn-success { background-color: #dff0d8; color: #5cb85c; }
.btn-danger  { background-color: #f2dede; color: #a94442; }
.btn-info    { background-color: #d9edf7; color: #5bc0de; }
.btn-warning { background-color: #fcf8e3; color: #f0ad4e; }

.dropdown { display:inline; background-color: transparent; }
.dropdown-toggle { border:none; background-color: transparent; position: relative; top: -0.5px; }
.dropdown-menu { padding: 0px 0px; margin-top: 0px; font-size: 12px; }

a:link    { color:#333333; text-decoration: underline; }
a:visited { color:#333333; text-decoration: underline; }
a:hover   { text-decoration: none; }

a:link.inverted, a:visited.inverted { text-decoration: none; }
a:hover.inverted { text-decoration: underline; }

a:link.inverted-success, a:visited.inverted-success   { text-decoration: none; color: #3c763d; }
a:link.inverted-danger,  a:visited.inverted-danger    { text-decoration: none; color: #a94442; }
a:link.inverted-info,    a:visited.inverted-info      { text-decoration: none; color: #31708f; }
a:link.inverted-warning, a:visited.inverted-warning   { text-decoration: none; color: #8a6d3b; }
a:hover.inverted-success  { text-decoration: underline; color: #3c763d; }
a:hover.inverted-danger   { text-decoration: underline; color: #a94442; }
a:hover.inverted-info     { text-decoration: underline; color: #31708f; }
a:hover.inverted-warning  { text-decoration: underline; color: #8a6d3b; }

td { padding: 10px; word-wrap: break-word; }
table tbody.summary td { padding: 0px; text-indent: 0px; }

.pull-right { padding-left: 10px; }
.keyword-right { text-align: right; display: inline-table; }
.line-no {
  text-align: right; display: inline-table; width: 30px; color: gray;
  -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none;
}
.grayed { color: gray; }
.inline { display: inline-table; }

.caret-left {
  border: 4px solid transparent;
  display: inline-block;
  width: 0; height: 0;
  border-right: 4px solid;
}

.data-table { color: #333333; }
.doc-string { color: #333333; }
.doc-string-type { color: gray; }

.summary-line-2 { padding-top: 2px !important; padding-bottom: 2px !important; }
.summary-line-0 { padding-top: 0px !important; padding-bottom: 0px !important; padding-left: 0px !important; }

div.horizontal-scroll { overflow-x: auto; overflow-y: hidden; white-space: nowrap; }

.unselectable {
  -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none;
}
`;
