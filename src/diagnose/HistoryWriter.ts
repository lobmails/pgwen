/**
 * HistoryWriter.ts — telemetry sidecar writer (§13).
 *
 * Writes one JSON file per failed step under
 *   <reportsDir>/diagnosis-history/<feature>__<scenario>__<isoStamp>.json
 *
 * Each file carries the rule-based classification + enough run identity
 * to correlate later with the human's eventual action. After 2–3 months
 * of `diagnose`-only operation these files feed the false-positive-rate
 * measurement that gates the `fix` track (strategy doc §13).
 *
 * Local-only by design — no external service, no network call. Orgs that
 * want central aggregation pull these files themselves.
 *
 * `human_action` / `outcome` fields are deliberately left optional and
 * undefined here; a future review tool fills them in. The classifier
 * is the only producer of new entries; nothing in core pgwen mutates
 * existing ones.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FailureClassification } from './Classifier';
import type { RunResult } from '../execution/Runner';
import type { StepResult } from '../engine/Compositor';

export interface DiagnosisHistoryEntry {
  pgwen_version: string;
  /** ISO 8601 timestamp at write time (UTC). */
  timestamp: string;
  feature_file: string;
  feature_name: string;
  scenario_name: string;
  step_keyword: string;
  step_text: string;
  error_class: string;
  error_message: string;
  classification: FailureClassification;
  /** Reserved — filled in by a future review tool once the human has acted. */
  human_action?: 'fixed_locator' | 'fixed_app' | 'no_action' | 'other';
  outcome?: 'true_positive' | 'false_positive' | 'acceptable';
}

const HISTORY_SUBDIR = 'diagnosis-history';

/**
 * Slugify a free-text name for use in a filename component.
 * Lowercase, ASCII alphanumeric + hyphen, capped at 60 chars.
 * Empty input collapses to "unknown" so the filename always has a token.
 */
export function slugifyForHistory(input: string): string {
  const lowered = input.toLowerCase().trim();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = replaced.slice(0, 60);
  return truncated.length > 0 ? truncated : 'unknown';
}

/**
 * Build the per-entry filename. Stable, sortable, collision-tolerant:
 *   <feature-slug>__<scenario-slug>__<isoStamp-without-colons>.json
 *
 * The base filename (no .json) is exposed so callers can resolve collisions
 * without re-derive logic.
 */
export function diagnosisHistoryBaseName(entry: DiagnosisHistoryEntry): string {
  const featureSlug = slugifyForHistory(
    entry.feature_name || path.basename(entry.feature_file, path.extname(entry.feature_file)),
  );
  const scenarioSlug = slugifyForHistory(entry.scenario_name);
  // ISO timestamp without colons or millisecond dots — keep it filename-safe.
  const stamp = entry.timestamp.replace(/[:.]/g, '-');
  return `${featureSlug}__${scenarioSlug}__${stamp}`;
}

/**
 * Write a diagnosis history entry as JSON under `<reportsDir>/diagnosis-history/`.
 * Creates the directory if it does not exist. Returns the absolute path written.
 *
 * On filename collision (same scenario, same timestamp — rare but possible
 * for parallel runs that landed in the same millisecond) the writer
 * appends `-2`, `-3`, etc. so no entry is silently overwritten.
 */
export function writeDiagnosisHistoryEntry(
  entry: DiagnosisHistoryEntry,
  reportsDir: string,
): string {
  const dir = path.join(reportsDir, HISTORY_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });

  const base = diagnosisHistoryBaseName(entry);
  let filename = `${base}.json`;
  let suffix = 1;
  while (fs.existsSync(path.join(dir, filename))) {
    suffix += 1;
    filename = `${base}-${suffix}.json`;
  }

  const target = path.join(dir, filename);
  fs.writeFileSync(target, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  return target;
}

// ─── RunResult adapter — walk a feature's failed leaf steps ─────────────────

/**
 * Walk a feature's RunResult, find every failed leaf StepResult that carries
 * a classifier output, and build one DiagnosisHistoryEntry per leaf. Pure
 * function — no I/O.
 *
 * Leaf = a failed step with no failed children. This avoids emitting one
 * entry for the outer StepDef AND another for the inner step that actually
 * threw — the inner step carries the precise failure detail.
 */
export function collectFailureEntriesForFeature(
  runResult: RunResult,
  pgwenVersion: string,
  now: Date = new Date(),
): DiagnosisHistoryEntry[] {
  const timestamp = now.toISOString();
  const entries: DiagnosisHistoryEntry[] = [];

  for (const scenario of runResult.scenarios) {
    if (scenario.status !== 'failed') continue;

    walkFailedLeaves(scenario.steps, (step) => {
      if (!step.failureClass) return;
      entries.push({
        pgwen_version: pgwenVersion,
        timestamp,
        feature_file: runResult.featureFile,
        feature_name: runResult.featureName,
        scenario_name: scenario.scenarioName,
        step_keyword: (step.originalKeyword ?? step.effectiveKeyword).trim(),
        step_text: step.stepText,
        error_class: step.error?.constructor?.name ?? 'Error',
        error_message: step.error?.message ?? '',
        classification: step.failureClass,
      });
    });
  }

  return entries;
}

/**
 * Walk `steps`, invoking `visit` for each failed step whose children (if any)
 * contain no failures of their own — i.e. the most-specific failure on each
 * branch. Steps that simply pass or skip are ignored.
 */
function walkFailedLeaves(steps: StepResult[], visit: (leaf: StepResult) => void): void {
  for (const step of steps) {
    if (step.status !== 'failed') continue;
    const childrenWithFailure = (step.children ?? []).some((c) => c.status === 'failed');
    if (childrenWithFailure) {
      walkFailedLeaves(step.children!, visit);
    } else {
      visit(step);
    }
  }
}

/**
 * Convenience wrapper: build entries for a feature and write them all under
 * `<reportsDir>/diagnosis-history/`. Returns the list of paths written.
 */
export function writeFailureHistory(
  runResult: RunResult,
  reportsDir: string,
  pgwenVersion: string,
  now?: Date,
): string[] {
  const entries = collectFailureEntriesForFeature(runResult, pgwenVersion, now);
  return entries.map((entry) => writeDiagnosisHistoryEntry(entry, reportsDir));
}

// ─── Config + env gate ──────────────────────────────────────────────────────

/**
 * Whether the launcher should emit diagnosis-history sidecars for this run.
 *
 * Two hard gates per strategy doc §13:
 *   1. `pgwen.diagnose.history.enabled` must be "true" (case-insensitive).
 *      Default is false — the writer is opt-in.
 *   2. The `PGWEN_AI_DISABLED` env var must NOT be set to "1". Even though
 *      the writer doesn't call Claude, the strategy treats this env var as
 *      a master kill switch for the entire diagnose track during incident
 *      response.
 */
export function isDiagnoseHistoryEnabled(
  config: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['PGWEN_AI_DISABLED'] === '1') return false;
  const flag = (config['pgwen.diagnose.history.enabled'] ?? '').toLowerCase().trim();
  return flag === 'true';
}
