/**
 * src/heal/HealTelemetry.ts — append-only JSONL writer for heal events.
 *
 * Strategy §9 schema. Every heal attempt (passed gates, declined,
 * succeeded, failed) writes exactly one line. The same JSONL format
 * is read back by `pgwen heal --report` (Phase 3.8 — deferred) to
 * compute false-positive rate and cost per run.
 *
 * Append-only: a partial write leaves at most one bad trailing line,
 * which downstream readers tolerate by `try/catch` on `JSON.parse`.
 *
 * Filename convention: `reports/heal-history/<run-id>.jsonl`. The
 * caller supplies `reportsDir`; the writer creates the
 * `heal-history` subdirectory and the file on first write.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { HealHistoryEntry } from './types';

export const HEAL_HISTORY_SUBDIR = 'heal-history';

/**
 * Append one heal-history entry to `<reportsDir>/heal-history/<runId>.jsonl`.
 * Creates the directory + file on first write. Returns the absolute
 * path of the file written to (useful in tests + telemetry).
 *
 * Synchronous fs — tests don't have to await the write to inspect the
 * file. The write volume is one tiny JSON line per heal attempt and
 * heal is gated to ≤10 attempts per run by default, so the sync I/O
 * cost is negligible compared to the AI call itself.
 */
export function appendHealHistory(
  reportsDir: string,
  runId: string,
  entry: HealHistoryEntry,
): string {
  const dir = path.join(reportsDir, HEAL_HISTORY_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const safeRunId = runId.replace(/[^A-Za-z0-9_.-]+/g, '-') || 'run';
  const file = path.join(dir, `${safeRunId}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  return file;
}

/**
 * Read every entry from `<reportsDir>/heal-history/<runId>.jsonl`. Robust
 * to a missing file (returns `[]`) and to corrupt lines (skipped silently
 * — append-only writes leave at most one bad trailing line).
 */
export function readHealHistory(reportsDir: string, runId: string): HealHistoryEntry[] {
  const file = path.join(reportsDir, HEAL_HISTORY_SUBDIR, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const out: HealHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as HealHistoryEntry);
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}
