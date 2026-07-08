/**
 * Suggest.ts — orchestrator for suggest-only mode.
 *
 * Given the input list (FixInputEntry[]) and the resolved FixConfig,
 * runs each candidate through the pipeline:
 *   confidence gate → category gate → minimum-diff validator →
 *   repeat-fix circuit breaker → writeSuggestion → ledger append.
 *
 * Returns the structured outcome list (one per input). The CLI is a thin
 * wrapper that argparses + calls this + prints.
 */

import * as path from 'path';
import type {
  FixConfig,
  FixInputEntry,
  Suggestion,
  SuggestFixOptions,
  SuggestFixOutcome,
  SuggestFixResult,
  DiagnoseConfidence,
} from './types';
import { DEFAULT_FIX_CONFIG } from './types';
import { buildUnifiedDiff } from './PatchApplier';
import { validateSuggestion } from './MinimumDiffValidator';
import { isRepeatFix, appendHistory } from './RepeatFixDetector';
import { buildSuggestionId, writeSuggestion, readSuggestions } from './SuggestionWriter';
import { writeHtmlReport } from './HtmlReport';

/** Confidence ordering used by the minimum-confidence gate. */
const CONFIDENCE_RANK: Record<DiagnoseConfidence, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

/** Merge a partial config over the defaults. */
export function resolveConfig(overrides: Partial<FixConfig> | undefined): FixConfig {
  return { ...DEFAULT_FIX_CONFIG, ...(overrides ?? {}) };
}

/**
 * Main entry point. Pure-ish: writes to disk only when `dryRun !== true`.
 */
export function runSuggestFix(
  entries: FixInputEntry[],
  opts: SuggestFixOptions,
  packageVersion: string,
): SuggestFixResult {
  const config = resolveConfig(opts.config);
  const now = opts.now ?? new Date();
  const timestamp = now.toISOString();
  const reportsDir = path.resolve(opts.cwd, config.reportsDir);
  const dryRun = opts.dryRun === true;

  const outcomes: SuggestFixOutcome[] = [];

  for (const entry of entries) {
    const out = processEntry(entry, config, reportsDir, timestamp, dryRun, now);
    outcomes.push(out);
    if (!dryRun) {
      appendHistory(reportsDir, {
        timestamp,
        feature_file: entry.failure.feature_file,
        feature_name: entry.failure.feature_name,
        scenario_name: entry.failure.scenario_name,
        step_text: entry.failure.step_text,
        file: entry.output.machine_proposal?.file ?? '',
        line: entry.output.machine_proposal?.line ?? 0,
        outcome: out.kind === 'written' ? 'written' : out.reason,
        suggestion_id: out.kind === 'written' ? out.suggestion.id : null,
      });
    }
  }

  let htmlIndexPath: string | null = null;
  if (!dryRun) {
    const all = readSuggestions(reportsDir);
    htmlIndexPath = writeHtmlReport(reportsDir, {
      suggestions: all,
      version: packageVersion,
      generatedAt: timestamp,
    });
  }

  return { outcomes, htmlIndexPath, reportsDir };
}

function processEntry(
  entry: FixInputEntry,
  config: FixConfig,
  reportsDir: string,
  timestamp: string,
  dryRun: boolean,
  now: Date,
): SuggestFixOutcome {
  const failure = entry.failure;

  // 1. classification gate (when present) — only LOCATOR_NOT_FOUND is actionable in v1.
  if (entry.classification && entry.classification.class !== 'LOCATOR_NOT_FOUND') {
    return {
      kind: 'rejected',
      reason: 'classification_not_actionable',
      detail: `class=${entry.classification.class} is not LOCATOR_NOT_FOUND`,
      failure,
    };
  }

  // 2. category gate — Claude must agree it's a locator drift.
  if (entry.output.category !== 'locator_drift') {
    return {
      kind: 'rejected',
      reason: 'wrong_category',
      detail: `category=${entry.output.category}`,
      failure,
    };
  }

  // 3. confidence gate.
  if (CONFIDENCE_RANK[entry.output.confidence] < CONFIDENCE_RANK[config.confidenceMinimum]) {
    return {
      kind: 'rejected',
      reason: 'low_confidence',
      detail: `confidence=${entry.output.confidence}, minimum=${config.confidenceMinimum}`,
      failure,
    };
  }

  // 4. machine_proposal presence.
  const proposal = entry.output.machine_proposal;
  if (!proposal) {
    return {
      kind: 'rejected',
      reason: 'no_machine_proposal',
      detail: 'DiagnoseOutput.machine_proposal is null',
      failure,
    };
  }

  // 5. build patch + validate.
  let patch: string;
  try {
    patch = buildUnifiedDiff(proposal);
  } catch (err) {
    return {
      kind: 'rejected',
      reason: 'minimum_diff_violation',
      detail: `buildUnifiedDiff threw: ${(err as Error).message}`,
      failure,
    };
  }
  const validation = validateSuggestion({ proposal, patch, config });
  if (!validation.ok) {
    return {
      kind: 'rejected',
      reason: 'minimum_diff_violation',
      detail: validation.violations.join('; '),
      failure,
    };
  }

  // 6. repeat-fix circuit breaker.
  if (
    isRepeatFix({
      reportsDir,
      feature_file: failure.feature_file,
      scenario_name: failure.scenario_name,
      step_text: failure.step_text,
      file: proposal.file,
      line: proposal.line,
      windowDays: config.repeatWindowDays,
      maxAttempts: config.repeatMaxAttempts,
      now,
    })
  ) {
    return {
      kind: 'rejected',
      reason: 'repeat_fix',
      detail: `this target has been suggested ${config.repeatMaxAttempts} times within ${config.repeatWindowDays} days`,
      failure,
    };
  }

  // 7. write.
  const suggestion: Suggestion = {
    id: buildSuggestionId({
      feature_name: failure.feature_name,
      feature_file: failure.feature_file,
      scenario_name: failure.scenario_name,
      timestamp,
    }),
    feature_file: failure.feature_file,
    feature_name: failure.feature_name,
    scenario_name: failure.scenario_name,
    step_text: failure.step_text,
    binding_name: proposal.binding_name,
    file: proposal.file,
    line: proposal.line,
    old: proposal.old,
    new: proposal.new,
    category: entry.output.category,
    confidence: entry.output.confidence,
    rationale: entry.output.human_explanation,
    patch,
    createdAt: timestamp,
    validation,
    ...(entry.instances && entry.instances.length > 1
      ? { affected_instances: entry.instances }
      : {}),
  };

  if (dryRun) {
    return { kind: 'written', suggestion, jsonPath: '(dry-run)', patchPath: '(dry-run)' };
  }

  const { jsonPath, patchPath } = writeSuggestion(reportsDir, suggestion);
  return { kind: 'written', suggestion, jsonPath, patchPath };
}
