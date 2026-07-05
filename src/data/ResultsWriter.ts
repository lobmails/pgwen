/**
 * data/ResultsWriter.ts — CSV results output for the @Results annotation.
 *
 * Implements the reference framework's @Results pattern:
 *   @Results("output/resultsALL.csv")
 *   Scenario: process account
 *
 * The runner calls writeResultRow() after each Feature/Scenario execution.
 * Column values are sourced from scope (implicit values like pgwen.feature.eval.status.keyword,
 * pgwen.scenario.eval.status.message.csvEscaped, etc. are available).
 *
 * Supported result file patterns (client's standard):
 *   resultsALL.csv    → STATUS, RECORD_ID, FAILED_REASON
 *   resultsPASSED.csv → STATUS, RECORD_ID
 *   resultsFAILED.csv → STATUS, RECORD_ID, FAILED_REASON
 *
 * The file is created (with header) on first write, then rows are appended.
 * Calling clearResultsFile() removes the file so a fresh run starts clean.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single result row — column name → string value. */
export type ResultRow = Record<string, string>;

// ─── CSV escaping ─────────────────────────────────────────────────────────────

/**
 * Escape a single cell value for CSV output.
 * Wraps in double-quotes if the value contains commas, double-quotes, or newlines.
 * Internal double-quotes are doubled ("" → escaped quote).
 */
export function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/**
 * Escape a value for use in a CSV field where the consumer expects backslash escaping
 * (the reference framework's csvEscaped implicit value format).
 * Replaces newlines with \n and commas with \, for inline embedding.
 */
export function csvEscapePgwen(value: string): string {
  return value
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

// ─── File management ──────────────────────────────────────────────────────────

/**
 * Ensure the directory for the given file path exists.
 * Creates missing parent directories recursively.
 */
function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write the CSV header row to a results file.
 * Overwrites any existing file.
 */
export function initResultsFile(filePath: string, headers: string[]): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, headers.map(csvEscape).join(',') + '\n', 'utf-8');
}

/**
 * Append a result row to the given CSV file.
 * If the file does not exist, it is created with a header row derived from the row keys.
 * If the file already exists, the row is appended without re-writing the header.
 */
export function appendResultRow(filePath: string, row: ResultRow, headers?: string[]): void {
  ensureDir(filePath);

  const cols = headers ?? Object.keys(row);

  if (!fs.existsSync(filePath)) {
    // First call: write header
    fs.writeFileSync(filePath, cols.map(csvEscape).join(',') + '\n', 'utf-8');
  }

  const values = cols.map(col => csvEscape(row[col] ?? ''));
  fs.appendFileSync(filePath, values.join(',') + '\n', 'utf-8');
}

/**
 * Delete a results file if it exists.
 * Called at the start of a run to ensure stale results don't accumulate.
 */
export function clearResultsFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Read all rows from an existing results CSV file.
 * Returns headers and data rows separately.
 * Useful for assertions and validation in tests.
 */
export function readResultsFile(filePath: string): { headers: string[]; rows: ResultRow[] } {
  if (!fs.existsSync(filePath)) return { headers: [], rows: [] };

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]!);
  const rows: ResultRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]!);
    const row: ResultRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = values[j] ?? '';
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Build a standard results row from scope implicit values.
 * Uses the client's standard STATUS / RECORD_ID / FAILED_REASON columns.
 *
 * @param scope     The current execution scope
 * @param columns   Which columns to include (defaults to all three standard ones)
 */
export function buildResultRowFromScope(
  scope: { get(key: string): string | undefined },
  columns: string[] = ['STATUS', 'RECORD_ID', 'FAILED_REASON']
): ResultRow {
  const row: ResultRow = {};
  for (const col of columns) {
    // Try both the column name and its implicit scope equivalent
    row[col] = scope.get(col) ?? '';
  }
  return row;
}

// ─── CSV line parsing ─────────────────────────────────────────────────────────

/**
 * Parse a single CSV line into fields, respecting quoted values.
 * Handles:
 *   - Values wrapped in double-quotes
 *   - Escaped double-quotes inside quoted values ("")
 *   - Unquoted values with no commas
 */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped double-quote inside quoted field
          current += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  fields.push(current);
  return fields;
}
