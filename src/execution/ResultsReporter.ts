/**
 * ResultsReporter.ts — Config-driven results CSV output.
 *
 * the reference framework writes results to CSV files according to pgwen.conf settings:
 *
 *   pgwen.report.results {
 *     fields {
 *       body = [
 *         { field = "STATUS",         ref = "pgwen.feature.eval.status.keyword.upperCased" }
 *         { field = "RECORD_ID" }
 *         { field = "BulkJobRunNumber", ref = "the run number", defaultValue = "" }
 *       ]
 *       reason = [
 *         { field = "FAILED_REASON",  ref = "pgwen.feature.eval.status.message" }
 *       ]
 *     }
 *     files {
 *       passed { file = "${pgwen.outDir}/results-PASSED.csv", scope = "Feature", status = "Passed" }
 *       failed { file = "${pgwen.outDir}/results-FAILED.csv", scope = "Feature", status = "Failed" }
 *       all    { file = "${pgwen.outDir}/results-ALL.csv",    scope = "Feature" }
 *     }
 *   }
 *
 * Field distribution:
 *   - results-PASSED.csv: body fields only
 *   - results-FAILED.csv: body + reason fields
 *   - results-ALL.csv:    body + reason fields
 *
 * Field value resolution:
 *   - If the field has a `ref`, look up scope.get(ref)
 *   - Otherwise, look up scope.get(field)
 *   - If neither yields a value, use `defaultValue` (or empty string)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../engine/ProfileLoader';
import type { Scope } from '../engine/Scope';
import { parseCSVLine } from '../data/ResultsWriter';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResultsField {
  /** Column header name in the output CSV. */
  field: string;
  /**
   * Scope key whose value to write.
   * When omitted, the scope key defaults to `field`.
   */
  ref?: string;
  /** Fallback value when the scope lookup returns undefined. Default: ''. */
  defaultValue?: string;
  /**
   * When set, rows in the output file are sorted by THIS field at end-of-run.
   * Only ONE field per file may carry a `sort` directive — multiple sort
   * fields throw at parse time (matches the reference framework `multipleSortFieldsError`).
   *
   * Numeric values sort numerically when ALL rows parse as Number; otherwise
   * sort is lexicographic (the reference framework ResultFile.scala:70 behaviour).
   */
  sort?: 'ascending' | 'descending';
}

export type ResultsStatus = 'Passed' | 'Failed';

interface FileSpec {
  /** Absolute path to the output CSV file. */
  file: string;
  /** Fields to write to this file (ordered). */
  fields: ResultsField[];
  /** If set, only write rows matching this status ('Passed' | 'Failed'). Undefined = write all. */
  status?: ResultsStatus;
}

// ─── ResultsReporter ─────────────────────────────────────────────────────────

export class ResultsReporter {
  private readonly files: FileSpec[];

  constructor(files: FileSpec[]) {
    // Standard behaviour: each output file may carry AT MOST ONE sort field.
    // Multiple sort fields throw at construction time (the reference framework
    // `multipleSortFieldsError`) — operators get the misconfiguration
    // surfaced before the run, not after.
    for (const spec of files) {
      const sortFields = spec.fields.filter((f) => f.sort !== undefined);
      if (sortFields.length > 1) {
        const names = sortFields.map((f) => f.field).join(', ');
        throw new Error(
          `ResultsReporter: file "${spec.file}" has ${sortFields.length} sort fields ` +
          `(${names}). Each output file may carry at most one sort directive.`,
        );
      }
    }
    this.files = files;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Create (or overwrite) all configured output CSV files with header rows.
   * Call once before any scenario results are written.
   */
  init(): void {
    for (const spec of this.files) {
      ensureDir(path.dirname(spec.file));
      const header = spec.fields.map((f) => csvCell(f.field)).join(',');
      fs.writeFileSync(spec.file, header + '\n', 'utf-8');
    }
  }

  /**
   * Append one result row for a completed scenario.
   *
   * @param scope   The Scope instance after scenario execution (contains bound values).
   * @param status  The scenario result: 'Passed' or 'Failed'.
   */
  appendRow(scope: Scope, status: ResultsStatus): void {
    for (const spec of this.files) {
      if (spec.status !== undefined && spec.status !== status) continue;
      const row = buildRow(spec.fields, scope);
      fs.appendFileSync(spec.file, row + '\n', 'utf-8');
    }
  }

  /**
   * Call ONCE at end-of-run. For each output file whose field list
   * carries a `sort` directive (standard behaviour), re-read the file,
   * sort the data rows (header preserved), and rewrite. Files without
   * a sort field are untouched.
   *
   * Sort semantics:
   *   - Lexicographic comparison by default.
   *   - When EVERY data-row's value in the sort column parses as a
   *     finite Number, the comparison becomes numeric (so "10" sorts
   *     after "9", not before). This mirrors the reference framework ResultFile.scala:70.
   *   - Direction follows the field's `sort = 'ascending' | 'descending'`.
   *
   * Multiple sort fields in the same file throws at parse time (the reference framework
   * `multipleSortFieldsError`) — caught in the constructor before any
   * row is written.
   */
  finalize(): void {
    for (const spec of this.files) {
      const sortField = spec.fields.find((f) => f.sort !== undefined);
      if (!sortField) continue;
      if (!fs.existsSync(spec.file)) continue;

      const raw = fs.readFileSync(spec.file, 'utf-8');
      const lines = raw.split('\n');
      if (lines.length <= 2) continue; // header only, or empty — nothing to sort

      const header = lines[0]!;
      // Strip trailing empty line from the final \n if present.
      const data = lines.slice(1).filter((l) => l.length > 0);
      const sortIdx = spec.fields.findIndex((f) => f.field === sortField.field);
      if (sortIdx < 0) continue;

      const cells = data.map((line) => parseCSVLine(line));
      const sortColValues = cells.map((row) => row[sortIdx] ?? '');
      const allNumeric = sortColValues.every((v) => v.length > 0 && Number.isFinite(Number(v)));

      cells.sort((a, b) => {
        const av = a[sortIdx] ?? '';
        const bv = b[sortIdx] ?? '';
        const cmp = allNumeric ? Number(av) - Number(bv) : av.localeCompare(bv);
        return sortField.sort === 'descending' ? -cmp : cmp;
      });

      const sortedRows = cells.map((row) =>
        spec.fields.map((_, i) => csvCell(row[i] ?? '')).join(','),
      );
      fs.writeFileSync(spec.file, [header, ...sortedRows].join('\n') + '\n', 'utf-8');
    }
  }

  /** The body fields (first file's fields as proxy, for testing convenience). */
  getFields(): readonly ResultsField[] {
    return this.files[0]?.fields ?? [];
  }

  /** All configured file specs (for testing). */
  getFileSpecs(): readonly FileSpec[] {
    return this.files;
  }

  // ─── Factory ─────────────────────────────────────────────────────────────

  /**
   * Build a ResultsReporter from a flat Config object (from ProfileLoader).
   *
   * Reads:
   *   pgwen.report.results.fields.body   → JSON array of ResultsField
   *   pgwen.report.results.fields.reason → JSON array of ResultsField
   *   pgwen.report.results.files.passed.file   → file path
   *   pgwen.report.results.files.passed.status → 'Passed'
   *   pgwen.report.results.files.failed.file   → file path
   *   pgwen.report.results.files.failed.status → 'Failed'
   *   pgwen.report.results.files.all.file      → file path (no status filter)
   *
   * Returns undefined when no body fields are configured.
   */
  static fromConfig(config: Config): ResultsReporter | undefined {
    const bodyFieldsRaw = parseFieldArray(config['pgwen.report.results.fields.body']);
    if (bodyFieldsRaw.length === 0) return undefined;

    const bodyFields = expandWildcardFields(bodyFieldsRaw);
    // `tail` is treated the same as `reason` — appended to failed/all files but not passed.
    const reasonFields = expandWildcardFields(parseFieldArray(config['pgwen.report.results.fields.reason']));
    const tailFields   = expandWildcardFields(parseFieldArray(config['pgwen.report.results.fields.tail']));
    const allFields = [...bodyFields, ...reasonFields, ...tailFields];

    const files: FileSpec[] = [];

    // Passed file: body fields only
    const passedFile = config['pgwen.report.results.files.passed.file'];
    if (passedFile) {
      files.push({ file: passedFile, fields: bodyFields, status: 'Passed' });
    }

    // Failed file: body + reason fields
    const failedFile = config['pgwen.report.results.files.failed.file'];
    if (failedFile) {
      files.push({ file: failedFile, fields: allFields, status: 'Failed' });
    }

    // All file: body + reason fields, no status filter
    const allFile = config['pgwen.report.results.files.all.file'];
    if (allFile) {
      files.push({ file: allFile, fields: allFields });
    }

    // If no file specs configured, create defaults based on a baseName in outputDir
    // (fallback: use first body/reason fields for backwards compat)
    if (files.length === 0) {
      // No file paths configured — reporter cannot write anywhere
      return undefined;
    }

    return new ResultsReporter(files);
  }

  /**
   * Build named ResultsReporters from config — one per named key under
   * `pgwen.report.results.files.*` that is NOT `passed`, `failed`, or `all`.
   *
   * Named reporters are invoked per-StepDef execution (via `@Results('name')`
   * on the StepDef) rather than per-feature-record like the standard reporters.
   *
   * Returns an empty Map when no body fields are configured.
   */
  static namedFromConfig(config: Config): Map<string, ResultsReporter> {
    const bodyFields   = expandWildcardFields(parseFieldArray(config['pgwen.report.results.fields.body']));
    if (bodyFields.length === 0) return new Map();

    const reasonFields = expandWildcardFields(parseFieldArray(config['pgwen.report.results.fields.reason']));
    const tailFields   = expandWildcardFields(parseFieldArray(config['pgwen.report.results.fields.tail']));
    const allFields = [...bodyFields, ...reasonFields, ...tailFields];

    const reserved = new Set(['passed', 'failed', 'all']);
    const result = new Map<string, ResultsReporter>();

    const prefix = 'pgwen.report.results.files.';
    const fileSuffix = '.file';

    for (const key of Object.keys(config)) {
      if (!key.startsWith(prefix) || !key.endsWith(fileSuffix)) continue;
      const name = key.slice(prefix.length, key.length - fileSuffix.length);
      // Skip reserved names and any composite sub-keys (e.g. "passed.extra")
      if (reserved.has(name) || name.includes('.')) continue;

      const file = config[key];
      if (!file) continue;

      const statusRaw = config[`${prefix}${name}.status`];
      const spec: FileSpec = { file, fields: allFields };
      if (statusRaw === 'Passed' || statusRaw === 'Failed') spec.status = statusRaw;

      result.set(name, new ResultsReporter([spec]));
    }

    return result;
  }
}

// ─── Config parsing ───────────────────────────────────────────────────────────

/**
 * Expand any wildcard fields (`{ field: "*", ref: "path/to/template.csv" }`) to one
 * ResultsField per header column in the referenced CSV file.
 * Fields without `field = "*"` are returned unchanged.
 * If the CSV file cannot be read, the wildcard entry is silently dropped.
 */
function expandWildcardFields(fields: ResultsField[]): ResultsField[] {
  const result: ResultsField[] = [];
  for (const f of fields) {
    if (f.field !== '*') {
      result.push(f);
      continue;
    }
    // Wildcard: ref must be a path to a CSV template file
    const csvPath = f.ref;
    if (!csvPath) continue;
    // Resolve relative to cwd
    const resolved = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const firstLine = content.split('\n')[0] ?? '';
      const headers = parseCSVLine(firstLine);
      for (const header of headers) {
        const trimmed = header.trim();
        if (trimmed) result.push({ field: trimmed });
      }
    } catch {
      // CSV template not found or unreadable — skip wildcard expansion
    }
  }
  return result;
}

/**
 * Parse a JSON array string of ResultsField objects from config.
 * The HOCON parser stores arrays as JSON.stringify'd strings.
 * Each array element should have: { field, ref?, defaultValue? }
 */
function parseFieldArray(raw: string | undefined): ResultsField[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((item: unknown): ResultsField[] => {
    // Simple string form: just a field name, e.g. ["FIELD1", "FIELD2"]
    if (typeof item === 'string') return item ? [{ field: item }] : [];
    if (typeof item !== 'object' || item === null) return [];
    const obj = item as Record<string, unknown>;
    const field = typeof obj['field'] === 'string' ? obj['field'] : undefined;
    if (!field) return [];
    const result: ResultsField = { field };
    if (typeof obj['ref'] === 'string') result.ref = obj['ref'];
    if (typeof obj['defaultValue'] === 'string') result.defaultValue = obj['defaultValue'];
    if (obj['sort'] === 'ascending' || obj['sort'] === 'descending') result.sort = obj['sort'];
    return [result];
  });
}

// ─── Row building ─────────────────────────────────────────────────────────────

function buildRow(fields: ResultsField[], scope: Scope): string {
  return fields
    .map((f) => {
      const key = f.ref ?? f.field;
      const value = scope.get(key) ?? f.defaultValue ?? '';
      return csvCell(value);
    })
    .join(',');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wrap a CSV cell value in quotes if it contains commas, quotes, or newlines.
 * Embedded double-quotes are doubled per RFC 4180.
 */
function csvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
