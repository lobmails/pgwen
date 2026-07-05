/**
 * AnalysisReport.ts — analyse the telemetry pgwen has been writing.
 *
 * The strategy doc (§13) names "2–3 months of diagnose-only telemetry"
 * as the gate that decides when `@pgwen/fix` can ship. This module is
 * the read side of that loop: it walks the local sidecars pgwen has
 * already been emitting and computes the distributions an on-call
 * engineer (or a finance reviewer, or the §18 stakeholder group) can
 * scan in a Markdown report.
 *
 * Inputs (all read-only):
 *   <reportsDir>/diagnosis-history/*.json   — one per failed leaf step,
 *     written by `writeFailureHistory` under the
 *     `pgwen.diagnose.history.enabled = true` gate.
 *   <reportsDir>/diagnosis-cache/<aa>/*.json — one per Claude diagnosis
 *     cached by `saveCachedDiagnosis`. Contains the model + token usage
 *     so spend can be computed independently of pricing changes.
 *
 * Pure functions only — `now` is injectable so tests don't touch the
 * wall clock.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DiagnosisHistoryEntry } from './HistoryWriter';
import type { CachedEntry } from './ResponseCache';
import type { DiagnoseCategory } from './types';
import type { FailureClass, FailureConfidence } from './Classifier';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HistoryStats {
  totalEntries: number;
  /** Count by rule-based class (LOCATOR_NOT_FOUND, ASSERTION_FAILED, …). */
  byClass: Record<string, number>;
  /** Nested: byClassConfidence[class][confidence] = count. */
  byClassConfidence: Record<string, Record<string, number>>;
  /** Entries where human_action has been filled in by reviewers. */
  annotated: number;
  truePositives: number;
  falsePositives: number;
  acceptable: number;
  /** Per-class outcome breakdown (only counts annotated entries). */
  outcomeByClass: Record<string, { truePositive: number; falsePositive: number; acceptable: number }>;
  /** Skipped files (malformed JSON, missing required fields). */
  skipped: number;
}

export interface CacheStats {
  totalCached: number;
  /** Distribution of Claude category outputs. */
  byCategory: Record<string, number>;
  /** Distribution of Claude confidence values per category. */
  byCategoryConfidence: Record<string, Record<string, number>>;
  /** Distribution of model IDs seen across cache entries. */
  byModel: Record<string, number>;
  totalTokensIn: number;
  totalTokensOut: number;
  /** Number of entries that proposed a structured machine_proposal. */
  machineProposalCount: number;
  /** Number of entries with auto_fix_safe=true (the gate for actual auto-apply). */
  autoFixSafeCount: number;
  /** Skipped files (malformed JSON, missing required fields). */
  skipped: number;
}

export interface AnalysisReport {
  historyDir: string;
  cacheDir: string | null;
  generatedAt: string;
  history: HistoryStats;
  /** null when the cache directory does not exist. */
  cache: CacheStats | null;
  /** Non-fatal warnings — surfaced in the Markdown report. */
  warnings: string[];
}

// ─── History walking ───────────────────────────────────────────────────────

const HISTORY_SUBDIR = 'diagnosis-history';
const CACHE_SUBDIR = 'diagnosis-cache';

export function analyseHistory(historyDir: string): HistoryStats {
  const stats: HistoryStats = {
    totalEntries: 0,
    byClass: {},
    byClassConfidence: {},
    annotated: 0,
    truePositives: 0,
    falsePositives: 0,
    acceptable: 0,
    outcomeByClass: {},
    skipped: 0,
  };
  if (!fs.existsSync(historyDir)) return stats;

  for (const file of fs.readdirSync(historyDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const entry = readJsonSafely<DiagnosisHistoryEntry>(path.join(historyDir, file.name));
    if (!entry || !entry.classification || typeof entry.classification.class !== 'string') {
      stats.skipped += 1;
      continue;
    }
    stats.totalEntries += 1;

    const cls: string = entry.classification.class;
    stats.byClass[cls] = (stats.byClass[cls] ?? 0) + 1;

    const conf: string = entry.classification.confidence;
    if (!stats.byClassConfidence[cls]) stats.byClassConfidence[cls] = {};
    stats.byClassConfidence[cls]![conf] = (stats.byClassConfidence[cls]![conf] ?? 0) + 1;

    if (entry.outcome !== undefined) {
      stats.annotated += 1;
      if (entry.outcome === 'true_positive') stats.truePositives += 1;
      else if (entry.outcome === 'false_positive') stats.falsePositives += 1;
      else if (entry.outcome === 'acceptable') stats.acceptable += 1;

      if (!stats.outcomeByClass[cls]) {
        stats.outcomeByClass[cls] = { truePositive: 0, falsePositive: 0, acceptable: 0 };
      }
      const o = stats.outcomeByClass[cls]!;
      if (entry.outcome === 'true_positive') o.truePositive += 1;
      else if (entry.outcome === 'false_positive') o.falsePositive += 1;
      else if (entry.outcome === 'acceptable') o.acceptable += 1;
    }
  }
  return stats;
}

// ─── Cache walking ─────────────────────────────────────────────────────────

export function analyseCache(cacheDir: string): CacheStats {
  const stats: CacheStats = {
    totalCached: 0,
    byCategory: {},
    byCategoryConfidence: {},
    byModel: {},
    totalTokensIn: 0,
    totalTokensOut: 0,
    machineProposalCount: 0,
    autoFixSafeCount: 0,
    skipped: 0,
  };
  if (!fs.existsSync(cacheDir)) return stats;

  for (const bucket of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(cacheDir, bucket.name);
    for (const file of fs.readdirSync(bucketDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const entry = readJsonSafely<CachedEntry>(path.join(bucketDir, file.name));
      if (!entry || !entry.diagnoseOutput || typeof entry.diagnoseOutput.category !== 'string') {
        stats.skipped += 1;
        continue;
      }
      stats.totalCached += 1;

      const cat: string = entry.diagnoseOutput.category;
      stats.byCategory[cat] = (stats.byCategory[cat] ?? 0) + 1;

      const conf: string = entry.diagnoseOutput.confidence;
      if (!stats.byCategoryConfidence[cat]) stats.byCategoryConfidence[cat] = {};
      stats.byCategoryConfidence[cat]![conf] = (stats.byCategoryConfidence[cat]![conf] ?? 0) + 1;

      if (entry.model) stats.byModel[entry.model] = (stats.byModel[entry.model] ?? 0) + 1;
      if (typeof entry.tokensIn === 'number' && Number.isFinite(entry.tokensIn)) {
        stats.totalTokensIn += entry.tokensIn;
      }
      if (typeof entry.tokensOut === 'number' && Number.isFinite(entry.tokensOut)) {
        stats.totalTokensOut += entry.tokensOut;
      }
      if (entry.diagnoseOutput.machine_proposal !== null) stats.machineProposalCount += 1;
      if (entry.diagnoseOutput.auto_fix_safe === true) stats.autoFixSafeCount += 1;
    }
  }
  return stats;
}

// ─── Top-level report ──────────────────────────────────────────────────────

export interface BuildReportOptions {
  now?: Date;
}

export function buildAnalysisReport(
  reportsDir: string,
  opts: BuildReportOptions = {},
): AnalysisReport {
  const historyDir = path.join(reportsDir, HISTORY_SUBDIR);
  const cacheDir = path.join(reportsDir, CACHE_SUBDIR);
  const warnings: string[] = [];
  const now = opts.now ?? new Date();

  const history = analyseHistory(historyDir);
  if (!fs.existsSync(historyDir)) {
    warnings.push(
      `No history directory at \`${historyDir}\`. ` +
      `Enable \`pgwen.diagnose.history.enabled = true\` in pgwen.conf to start collecting telemetry.`,
    );
  } else if (history.totalEntries === 0) {
    warnings.push(`History directory at \`${historyDir}\` is empty — no failed steps to analyse.`);
  }
  if (history.skipped > 0) {
    warnings.push(`${history.skipped} history file(s) were skipped (malformed JSON or missing required fields).`);
  }

  const cacheExists = fs.existsSync(cacheDir);
  const cache = cacheExists ? analyseCache(cacheDir) : null;
  if (cacheExists && cache!.skipped > 0) {
    warnings.push(`${cache!.skipped} cache file(s) were skipped (malformed JSON or missing required fields).`);
  }

  return {
    historyDir,
    cacheDir: cacheExists ? cacheDir : null,
    generatedAt: now.toISOString(),
    history,
    cache,
    warnings,
  };
}

// ─── Markdown renderer ─────────────────────────────────────────────────────

export function renderAnalysisMarkdown(report: AnalysisReport): string {
  const lines: string[] = [];
  lines.push('# pgwen diagnose — telemetry analysis');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`History: \`${report.historyDir}\``);
  if (report.cacheDir) lines.push(`Cache: \`${report.cacheDir}\``);
  lines.push('');

  if (report.warnings.length > 0) {
    lines.push('## Notices');
    lines.push('');
    for (const w of report.warnings) lines.push(`> ${w}`);
    lines.push('');
  }

  // History section
  const h = report.history;
  lines.push('## Rule-based classifier');
  lines.push('');
  lines.push(`Total failure entries: **${h.totalEntries}**`);
  lines.push('');

  if (h.totalEntries > 0) {
    lines.push('| Class | Count |');
    lines.push('|---|---|');
    for (const [cls, n] of sortedEntries(h.byClass)) lines.push(`| ${cls} | ${n} |`);
    lines.push('');

    lines.push('### Class × confidence');
    lines.push('');
    lines.push('| Class | high | medium | low |');
    lines.push('|---|---|---|---|');
    for (const [cls, byConf] of sortedEntries(h.byClassConfidence) as Array<[string, Record<string, number>]>) {
      lines.push(`| ${cls} | ${byConf['high'] ?? 0} | ${byConf['medium'] ?? 0} | ${byConf['low'] ?? 0} |`);
    }
    lines.push('');
  }

  // Outcomes section
  lines.push('## Annotated outcomes');
  lines.push('');
  if (h.annotated === 0) {
    lines.push('No annotated entries yet. Reviewers add `human_action` and `outcome` fields to history JSON files post-fact to enable false-positive-rate analysis (see strategy doc §13).');
    lines.push('');
  } else {
    const fpRate = h.truePositives + h.falsePositives === 0
      ? 0
      : h.falsePositives / (h.truePositives + h.falsePositives);
    lines.push(`Annotated: **${h.annotated}** / ${h.totalEntries}`);
    lines.push('');
    lines.push('| Outcome | Count |');
    lines.push('|---|---|');
    lines.push(`| true_positive | ${h.truePositives} |`);
    lines.push(`| false_positive | ${h.falsePositives} |`);
    lines.push(`| acceptable | ${h.acceptable} |`);
    lines.push('');
    lines.push(`False-positive rate: **${(fpRate * 100).toFixed(2)}%** (target: < 2% before \`@pgwen/fix\` can ship)`);
    lines.push('');

    const outcomeClasses = Object.keys(h.outcomeByClass).sort();
    if (outcomeClasses.length > 0) {
      lines.push('### Outcome by class');
      lines.push('');
      lines.push('| Class | TP | FP | acceptable |');
      lines.push('|---|---|---|---|');
      for (const cls of outcomeClasses) {
        const o = h.outcomeByClass[cls]!;
        lines.push(`| ${cls} | ${o.truePositive} | ${o.falsePositive} | ${o.acceptable} |`);
      }
      lines.push('');
    }
  }

  // Cache section
  if (report.cache) {
    const c = report.cache;
    lines.push('## Claude AI calls');
    lines.push('');
    lines.push(`Unique cached diagnoses: **${c.totalCached}** · Input tokens: **${c.totalTokensIn.toLocaleString()}** · Output tokens: **${c.totalTokensOut.toLocaleString()}**`);
    lines.push(`Machine proposals: **${c.machineProposalCount}** · auto_fix_safe=true: **${c.autoFixSafeCount}**`);
    lines.push('');

    if (c.totalCached > 0) {
      lines.push('| AI category | Count |');
      lines.push('|---|---|');
      for (const [cat, n] of sortedEntries(c.byCategory)) lines.push(`| ${cat} | ${n} |`);
      lines.push('');

      lines.push('### Category × confidence');
      lines.push('');
      lines.push('| Category | high | medium | low |');
      lines.push('|---|---|---|---|');
      for (const [cat, byConf] of sortedEntries(c.byCategoryConfidence) as Array<[string, Record<string, number>]>) {
        lines.push(`| ${cat} | ${byConf['high'] ?? 0} | ${byConf['medium'] ?? 0} | ${byConf['low'] ?? 0} |`);
      }
      lines.push('');

      if (Object.keys(c.byModel).length > 0) {
        lines.push('### Model usage');
        lines.push('');
        lines.push('| Model | Count |');
        lines.push('|---|---|');
        for (const [m, n] of sortedEntries(c.byModel)) lines.push(`| ${m} | ${n} |`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readJsonSafely<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sortedEntries<V>(obj: Record<string, V>): Array<[string, V]> {
  return Object.keys(obj).sort().map((k) => [k, obj[k]!] as [string, V]);
}

// Re-export shape types so consumers don't need separate imports.
export type { FailureClass, FailureConfidence, DiagnoseCategory };
