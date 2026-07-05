/**
 * Annotate.ts — review workflow for populating `human_action` and
 * `outcome` on DiagnosisHistoryEntry files.
 *
 * The strategy doc's <2 % false-positive-rate gate requires reviewers
 * to record what the human actually did after a failure (fixed the
 * locator, fixed the app, no action, …) and whether the classifier
 * was right. This module is the read/write side of that workflow.
 *
 * The pure helpers (findUnannotatedEntries, annotateEntry, etc.) are
 * usable from any external tool. `runAnnotationSession` drives the
 * interactive CLI but takes its `prompt` + `write` as injected deps so
 * tests never read stdin.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DiagnosisHistoryEntry } from './HistoryWriter';

// ─── Value vocabularies ────────────────────────────────────────────────────

export type HumanAction = NonNullable<DiagnosisHistoryEntry['human_action']>;
export type Outcome = NonNullable<DiagnosisHistoryEntry['outcome']>;

export interface AnnotationInput {
  human_action: HumanAction;
  outcome: Outcome;
}

/** Key → human_action mapping. `s` skips, `q` quits — handled separately. */
export const HUMAN_ACTION_KEY: ReadonlyMap<string, HumanAction> = new Map([
  ['l', 'fixed_locator'],
  ['a', 'fixed_app'],
  ['n', 'no_action'],
  ['o', 'other'],
]);

/** Key → outcome mapping. `s` skips the entry. */
export const OUTCOME_KEY: ReadonlyMap<string, Outcome> = new Map([
  ['t', 'true_positive'],
  ['f', 'false_positive'],
  ['a', 'acceptable'],
]);

// ─── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Read a single entry from disk. Returns null on missing file, malformed
 * JSON, or schema-incomplete payload.
 */
export function readHistoryEntry(filePath: string): DiagnosisHistoryEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DiagnosisHistoryEntry;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.feature_file !== 'string' || !parsed.classification) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Scan `historyDir` and return *.json files split into already-annotated
 * vs not (presence of `outcome` is the gating field).
 */
export function listEntries(historyDir: string): { unannotated: string[]; annotated: string[] } {
  const unannotated: string[] = [];
  const annotated: string[] = [];
  if (!fs.existsSync(historyDir)) return { unannotated, annotated };

  const names = fs.readdirSync(historyDir).filter((n) => n.endsWith('.json')).sort();
  for (const name of names) {
    const filePath = path.join(historyDir, name);
    const entry = readHistoryEntry(filePath);
    if (!entry) continue;
    if (entry.outcome !== undefined) annotated.push(filePath);
    else unannotated.push(filePath);
  }
  return { unannotated, annotated };
}

/** Convenience: just the unannotated list. */
export function findUnannotatedEntries(historyDir: string): string[] {
  return listEntries(historyDir).unannotated;
}

/**
 * Write `human_action` + `outcome` into a history entry file. Preserves
 * every other field. Throws on file-read or schema problems so the
 * caller can decide to skip or abort.
 */
export function annotateEntry(filePath: string, input: AnnotationInput): void {
  const entry = readHistoryEntry(filePath);
  if (!entry) {
    throw new Error(`annotateEntry: cannot read or parse "${filePath}"`);
  }
  const updated: DiagnosisHistoryEntry = {
    ...entry,
    human_action: input.human_action,
    outcome: input.outcome,
  };
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
}

/**
 * Format an entry as a multi-line review block for the prompt. Pure —
 * no I/O.
 */
export function summariseEntryForPrompt(
  entry: DiagnosisHistoryEntry,
  position: { index: number; total: number },
  filePath: string,
): string {
  const lines: string[] = [];
  lines.push(`[${position.index}/${position.total}] ${path.basename(filePath)}`);
  lines.push(`  Feature:    ${entry.feature_name}  (${entry.feature_file})`);
  lines.push(`  Scenario:   ${entry.scenario_name}`);
  lines.push(`  Step:       ${entry.step_keyword} ${entry.step_text}`);
  lines.push(`  Error:      ${entry.error_message}`);
  lines.push(`  Classifier: ${entry.classification.class} (${entry.classification.confidence})`);
  if (entry.classification.signals.length > 0) {
    lines.push(`  Signals:    ${entry.classification.signals.join('; ')}`);
  }
  return lines.join('\n');
}

// ─── Interactive session driver (deps injectable for tests) ───────────────

export interface AnnotationDriverDeps {
  /**
   * Ask the reviewer a question and resolve with their typed input
   * (already lowercased + trimmed). Implementations must echo the
   * input back via `write` if appropriate (the driver itself does not).
   */
  prompt: (label: string, allowed: ReadonlyArray<string>) => Promise<string>;
  write: (s: string) => void;
}

export interface AnnotationSessionOptions {
  historyDir: string;
  deps: AnnotationDriverDeps;
  /** Stop after this many entries have been touched (annotated or skipped). */
  limit?: number;
}

export interface AnnotationSessionResult {
  scanned: number;
  alreadyAnnotated: number;
  /** Newly annotated by this session. */
  annotatedNow: number;
  skipped: number;
  errored: number;
  quitEarly: boolean;
}

const HUMAN_ACTION_KEYS_FULL = ['l', 'a', 'n', 'o', 's', 'q'] as const;
const OUTCOME_KEYS_FULL = ['t', 'f', 'a', 's', 'q'] as const;

/**
 * Interactive review session. Walks unannotated entries in stable
 * filename order, prompts the reviewer for human_action + outcome,
 * writes back. `s` skips, `q` quits early. The driver never reads
 * stdin itself — every input comes from `deps.prompt`.
 */
export async function runAnnotationSession(
  opts: AnnotationSessionOptions,
): Promise<AnnotationSessionResult> {
  const { historyDir, deps, limit } = opts;
  const { unannotated, annotated } = listEntries(historyDir);

  const result: AnnotationSessionResult = {
    scanned: unannotated.length + annotated.length,
    alreadyAnnotated: annotated.length,
    annotatedNow: 0,
    skipped: 0,
    errored: 0,
    quitEarly: false,
  };

  deps.write(`Scanning ${historyDir}\n`);
  deps.write(`  ${result.alreadyAnnotated} already annotated · ${unannotated.length} pending review\n\n`);

  if (unannotated.length === 0) return result;

  const total = limit !== undefined ? Math.min(limit, unannotated.length) : unannotated.length;

  for (let i = 0; i < total; i++) {
    const filePath = unannotated[i]!;
    const entry = readHistoryEntry(filePath);
    if (!entry) {
      result.errored += 1;
      deps.write(`[${i + 1}/${total}] ${path.basename(filePath)} — could not read; skipping.\n\n`);
      continue;
    }

    deps.write(summariseEntryForPrompt(entry, { index: i + 1, total }, filePath));
    deps.write('\n');

    const actionKey = await deps.prompt(
      '  Human action? [l]ocator / [a]pp / [n]o action / [o]ther / [s]kip / [q]uit',
      HUMAN_ACTION_KEYS_FULL,
    );
    if (actionKey === 'q') {
      result.quitEarly = true;
      return result;
    }
    if (actionKey === 's') {
      result.skipped += 1;
      deps.write('  Skipped.\n\n');
      continue;
    }
    const human_action = HUMAN_ACTION_KEY.get(actionKey);
    if (!human_action) {
      // Defensive — the prompt impl should restrict to allowed keys.
      result.skipped += 1;
      deps.write(`  Unrecognised input "${actionKey}"; skipped.\n\n`);
      continue;
    }

    const outcomeKey = await deps.prompt(
      '  Outcome? [t]rue positive / [f]alse positive / [a]cceptable / [s]kip / [q]uit',
      OUTCOME_KEYS_FULL,
    );
    if (outcomeKey === 'q') {
      result.quitEarly = true;
      return result;
    }
    if (outcomeKey === 's') {
      result.skipped += 1;
      deps.write('  Skipped.\n\n');
      continue;
    }
    const outcome = OUTCOME_KEY.get(outcomeKey);
    if (!outcome) {
      result.skipped += 1;
      deps.write(`  Unrecognised input "${outcomeKey}"; skipped.\n\n`);
      continue;
    }

    try {
      annotateEntry(filePath, { human_action, outcome });
      result.annotatedNow += 1;
      deps.write(`  Saved: human_action=${human_action} outcome=${outcome}\n\n`);
    } catch (err) {
      result.errored += 1;
      const msg = err instanceof Error ? err.message : String(err);
      deps.write(`  Failed to save: ${msg}\n\n`);
    }
  }

  return result;
}
