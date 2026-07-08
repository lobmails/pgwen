/**
 * data/CsvFeedReader.ts — CSV data feed parsing and scope binding.
 *
 * Implements CSV data feed pattern:
 *   - First row = column headers → become named bindings in scope
 *   - Each subsequent row = one feature/scenario execution
 *   - pgwen.data.record.number (1-based) and pgwen.data.record.index (0-based) set per row
 *
 * Used by the Runner when `-i inputfeed.csv` is provided:
 *   const feed = parseCsvFeed('pgwen/inputfeed.csv');
 *   for (let i = 0; i < feed.length; i++) {
 *     bindRecordToScope(feed[i], i, scope);
 *     await runner.executeFeature(feature, scope);
 *   }
 *
 * Settings respected:
 *   pgwen.auto.trim.data.csv = true  → strip whitespace from each cell value
 *   pgwen.input.data.maskFields = ["password", ...]  → masked fields logged as *****
 */

import * as fs from 'fs';
import Papa from 'papaparse';
import type { Scope } from '../engine/Scope';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single row from a CSV feed — column name → string value. */
export type DataRecord = Record<string, string>;

export interface CsvFeedOptions {
  /** Strip leading/trailing whitespace from each cell value. Default: false. */
  autoTrim?: boolean;
  /** Skip rows where all cells are empty. Default: true. */
  skipEmptyLines?: boolean;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a CSV file into an array of records.
 * First row is treated as headers.
 */
export function parseCsvFeed(filePath: string, options: CsvFeedOptions = {}): DataRecord[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseCsvContent(content, options);
}

/**
 * Parse CSV content string into an array of records.
 * Useful for testing without disk I/O.
 */
export function parseCsvContent(content: string, options: CsvFeedOptions = {}): DataRecord[] {
  const { autoTrim = false, skipEmptyLines = true } = options;

  // Build config conditionally to satisfy exactOptionalPropertyTypes
  const config: Papa.ParseConfig<Record<string, string>> = {
    header: true,
    skipEmptyLines: skipEmptyLines ? 'greedy' : false,
  };
  if (autoTrim) {
    config.transformHeader = (h: string) => h.trim();
    config.transform = (v: string) => v.trim();
  }

  const result = Papa.parse<Record<string, string>>(content, config);
  return result.data;
}

// ─── Scope binding ────────────────────────────────────────────────────────────

/**
 * Bind all columns of a data record into the given scope.
 * Also sets the implicit pgwen.data.record.* values.
 *
 * Call once per row before executing the feature/scenario for that record.
 *
 * @param readOnly   When true, column bindings are locked as read-only.
 *   Preserves pgwen.input.data.readOnly=true default. The implicit
 *   pgwen.data.record.* values are always writeable.
 * @param maskFields Column names whose values should be stored as "*****".
 *   Mirrors pgwen.input.data.maskFields config — masked values are never
 *   logged or displayed in reports.
 */
export function bindRecordToScope(
  record: DataRecord,
  recordIndex: number,
  scope: Scope,
  readOnly = false,
  maskFields: string[] = []
): void {
  const maskSet = new Set(maskFields.map(f => f.toLowerCase().trim()));
  // Bind each column value as a named scope entry
  for (const [column, value] of Object.entries(record)) {
    const masked = maskSet.size > 0 && maskSet.has(column.toLowerCase().trim()) ? '*****' : value;
    if (readOnly) {
      scope.setReadonly(column, masked);
    } else {
      scope.set(column, masked);
    }
  }

  // Set implicit data record implicit values (always writeable)
  scope.set('pgwen.data.record.index', String(recordIndex));
  scope.set('pgwen.data.record.number', String(recordIndex + 1));
}

/**
 * Returns the column headers (keys) from the first record, or empty array if feed is empty.
 */
export function getFeedHeaders(records: DataRecord[]): string[] {
  if (records.length === 0) return [];
  return Object.keys(records[0]!);
}
