/**
 * data/ExamplesLoader.ts — External @Examples file loading for Scenario Outlines.
 *
 * allows Scenario Outlines to pull their example rows from an external
 * CSV or JSON file via the @Examples annotation:
 *
 *   @Examples('pgwen/data/accounts.csv')
 *   @Examples(file='accounts.json', where="STATUS = 'ACTIVE'", prefix='account')
 *
 * This module handles loading, filtering, and converting external example files
 * into the ParsedExamples format used by the GherkinParser AST.
 *
 * The Runner calls loadExternalExamples() before expanding outlines, and uses
 * expandOutlineRow() to substitute <columnName> tokens in step text.
 */

import * as path from 'path';
import type { ParsedScenario, ParsedExamples } from '../engine/GherkinParser';
import { parseAnnotations } from '../annotations/Annotations';
import { parseCsvFeed } from './CsvFeedReader';
import { parseJsonFeed, type JsonDataRecord } from './JsonFeedReader';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoadExamplesOptions {
  /** Base directory for resolving relative file paths. Default: process.cwd(). */
  baseDir?: string;
  /** Config/scope values for interpolating ${varName} in file paths. Default: {}. */
  context?: Record<string, string>;
}

// ─── External examples loading ────────────────────────────────────────────────

/**
 * If a scenario has an @Examples('file') annotation, load the external file
 * and return it as ParsedExamples.
 *
 * Returns undefined if no @Examples annotation with a file is present — callers
 * should fall back to the inline examples in scenario.examples.
 *
 * Supports:
 *   - .csv files (parsed with autoTrim=true)
 *   - .json files (flat array or object-with-array)
 *   - where filter: `column = 'value'` or `column != 'value'`
 *   - prefix: prepend to all column names in the loaded records
 */
export function loadExternalExamples(
  scenario: ParsedScenario,
  options: LoadExamplesOptions = {}
): ParsedExamples | undefined {
  const annotations = parseAnnotations(scenario.tags);
  if (!annotations.examples?.file) return undefined;

  const { file, where, prefix } = annotations.examples;
  const baseDir = options.baseDir ?? process.cwd();
  const resolvedFile = interpolateFilePath(file, options.context ?? {});
  const filePath = path.resolve(baseDir, resolvedFile);
  const ext = path.extname(resolvedFile).toLowerCase();

  let records: JsonDataRecord[];
  if (ext === '.json') {
    records = parseJsonFeed(filePath);
  } else {
    records = parseCsvFeed(filePath, { autoTrim: true });
  }

  // Apply prefix to all column names
  if (prefix) {
    records = records.map((rec) =>
      Object.fromEntries(
        Object.entries(rec).map(([k, v]) => [`${prefix}.${k}`, v])
      )
    );
  }

  // Apply where filter
  if (where) {
    records = applyWhereFilter(records, where);
  }

  // Enforce required=true
  if (annotations.examples.required && records.length === 0) {
    throw new Error(
      `@Examples required=true but no rows matched the where filter: ${where ?? '(no filter)'}`
    );
  }

  if (records.length === 0) {
    return { tags: [], name: resolvedFile, header: [], rows: [], line: 0 };
  }

  const header = Object.keys(records[0]!);
  const rows = records.map((rec) => header.map((col) => rec[col] ?? ''));

  return { tags: [], name: resolvedFile, header, rows, line: 0 };
}

// ─── Outline expansion ────────────────────────────────────────────────────────

/**
 * Create a concrete (non-outline) scenario by substituting one row of example
 * values into the outline's step texts.
 *
 * All <columnName> tokens in step text are replaced with the row value.
 * The resulting scenario has isOutline=false and no examples.
 */
export function expandOutlineRow(
  scenario: ParsedScenario,
  header: string[],
  row: string[]
): ParsedScenario {
  const params: Record<string, string> = {};
  for (let i = 0; i < header.length; i++) {
    params[header[i]!] = row[i] ?? '';
  }

  const expandedSteps = scenario.steps.map((step) => ({
    ...step,
    text: substituteOutlineParams(step.text, params),
  }));

  return {
    ...scenario,
    steps: expandedSteps,
    // Strip @Examples(...) tags from the expanded concrete scenario
    tags: scenario.tags.filter((t) => {
      const norm = t.startsWith('@') ? t.slice(1) : t;
      return !norm.startsWith('Examples(') && norm !== 'Examples';
    }),
    isOutline: false,
    examples: [],
  };
}

// ─── File path interpolation ──────────────────────────────────────────────────

/** Interpolate ${varName} tokens in a file path using the provided context. */
function interpolateFilePath(filePath: string, context: Record<string, string>): string {
  return filePath.replace(/\$\{([^}]+)\}/g, (_m, key: string) => context[key] ?? _m);
}

// ─── Where clause filtering ───────────────────────────────────────────────────

/**
 * Filter records using a where expression.
 *
 * where clauses are JavaScript expressions evaluated after substituting
 * column values into the expression. Two substitution forms are supported:
 *
 *   1. `${COLUMN}` syntax: the column value is interpolated before eval.
 *        where="${STATUS} == 'ACTIVE'"
 *
 *   2. Bare column name syntax: column names present in the record are replaced
 *      with their quoted values before eval. Single `=` is treated as `==`.
 *        where="STATUS = 'ACTIVE'"
 *        where="STATUS != 'INACTIVE'"
 *
 * Examples:
 *   where="STATUS = 'ACTIVE'"          → keep rows where STATUS equals ACTIVE
 *   where="STATUS != 'ACTIVE'"         → keep rows where STATUS does not equal ACTIVE
 *   where="${STATUS} == 'ACTIVE'"      → equivalent JS expression form
 *   where="COUNT > 0"                  → numeric comparison (bare column)
 *
 * Expressions that throw during evaluation are treated as matching (record kept).
 */
function applyWhereFilter(
  records: JsonDataRecord[],
  where: string
): JsonDataRecord[] {
  return records.filter((rec) => evaluateWhere(where, rec));
}

/**
 * Evaluate a where expression against a single record.
 * Returns true if the record matches (should be kept).
 */
function evaluateWhere(where: string, record: JsonDataRecord): boolean {
  try {
    let expr = where;

    // Step 1: Replace ${colName} tokens with quoted record values
    expr = expr.replace(/\$\{([^}]+)\}/g, (_, col: string) => {
      const val = record[col] ?? '';
      return `'${escapeForString(val)}'`;
    });

    // Step 2: Replace bare column names (whole-word matches) with quoted values.
    // Process longest column names first to avoid partial matches.
    const colsSorted = Object.keys(record).sort((a, b) => b.length - a.length);
    for (const col of colsSorted) {
      // Replace bare column name occurrences as whole words.
      // After Step 1, any ${col} references are already substituted with quoted values,
      // so we only need word-boundary matching for simple alphanumeric names.
      const escaped = escapeRegexChars(col);
      // For names with word-char-only composition, use \b word boundaries.
      // For dot-notation names (e.g. address.city), use literal match.
      const boundary = /^\w+$/.test(col) ? `\\b${escaped}\\b` : escaped;
      const colPattern = new RegExp(boundary, 'g');
      const val = record[col] ?? '';
      expr = expr.replace(colPattern, `'${escapeForString(val)}'`);
    }

    // Step 3: Convert standalone = to == for JS evaluation.
    // Handles the shorthand `column = 'value'` syntax.
    // Must not convert: !=  ==  >=  <=
    expr = expr.replace(/(?<![!<>=])=(?!=)/g, '==');

    // Step 4: Evaluate the resulting JS expression
    // eslint-disable-next-line no-new-func
    return Boolean(new Function(`return (${expr})`)());
  } catch {
    // On any error, treat as matching (include the record)
    return true;
  }
}

function escapeForString(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeRegexChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Param substitution ───────────────────────────────────────────────────────

function substituteOutlineParams(text: string, params: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(params)) {
    result = result.replaceAll(`<${name}>`, value);
  }
  return result;
}
