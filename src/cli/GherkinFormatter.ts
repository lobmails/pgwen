/**
 * GherkinFormatter.ts — Format .feature and .meta files with canonical indentation.
 *
 * Standard indentation rules:
 *   - Feature tags/header at column 0
 *   - Feature description lines at 2-space indent
 *   - Scenario / Background / Rule headings at 2-space indent
 *   - Tags (one per line) at the same indent as their block heading
 *   - Step keywords right-padded so step TEXT always starts at column 10
 *       Given  →  4 spaces + "Given "  (6 chars) → text at col 10
 *       When   →  5 spaces + "When "   (5 chars) → text at col 10
 *       Then   →  5 spaces + "Then "   (5 chars) → text at col 10
 *       And    →  6 spaces + "And "    (4 chars) → text at col 10
 *       But    →  6 spaces + "But "    (4 chars) → text at col 10
 *   - Doc string delimiters at 6-space indent (2 inside step body)
 *   - Data table rows at 6-space indent
 *   - Examples keyword at 4-space indent, table rows at 6-space indent
 *   - Blank line separating consecutive scenarios
 *   - Single trailing newline
 */

import * as fs from 'fs';
import * as path from 'path';
import { GherkinParser, GherkinParseError } from '../engine/GherkinParser';
import type {
  ParsedFeature,
  ParsedScenario,
  ParsedBackground,
  ParsedStep,
  ParsedExamples,
} from '../engine/GherkinParser';

// Column at which step text starts (0-indexed from line start).
const STEP_TEXT_COL = 10;

// ─── GherkinFormatter ─────────────────────────────────────────────────────────

export class GherkinFormatter {
  private readonly parser = new GherkinParser();

  /**
   * Parse and format a raw Gherkin source string.
   * Returns the canonically formatted string (trailing newline included).
   * Throws GherkinParseError on invalid syntax.
   */
  format(source: string, uri = '<source>'): string {
    const feature = this.parser.parseSource(source, uri);
    return this.emit(feature);
  }

  /**
   * Read a file, format it, and write it back if the content changed.
   * Returns true when the file was rewritten, false when already formatted.
   */
  formatFile(filePath: string): boolean {
    const original = fs.readFileSync(filePath, 'utf8');
    let formatted: string;
    try {
      formatted = this.format(original, filePath);
    } catch {
      // Re-throw parse errors so the caller can report them clearly.
      throw new GherkinParseError(`Cannot format "${filePath}": file contains syntax errors`);
    }
    if (formatted !== original) {
      fs.writeFileSync(filePath, formatted, 'utf8');
      return true;
    }
    return false;
  }

  /**
   * Check whether a file needs formatting, without writing it.
   * Returns true when the file content differs from canonical form.
   */
  checkFile(filePath: string): boolean {
    const original = fs.readFileSync(filePath, 'utf8');
    let formatted: string;
    try {
      formatted = this.format(original, filePath);
    } catch {
      return false; // cannot determine — treat as no change needed
    }
    return formatted !== original;
  }

  // ─── Core emitter ──────────────────────────────────────────────────────────

  /** Emit a ParsedFeature back to canonical Gherkin text. */
  emit(feature: ParsedFeature): string {
    const lines: string[] = [];

    // Feature-level tags (each on its own line at col 0)
    for (const tag of feature.tags) {
      lines.push(tag);
    }

    // Feature: heading
    lines.push(`Feature: ${feature.name}`);

    // Optional description (re-indented at 2 spaces)
    if (feature.description) {
      for (const descLine of feature.description.split('\n')) {
        const trimmed = descLine.trim();
        lines.push(trimmed ? `  ${trimmed}` : '');
      }
    }

    // Background section (before scenarios)
    if (feature.background) {
      lines.push('');
      this.emitBackground(feature.background, lines);
    }

    // Scenarios
    for (const scenario of feature.scenarios) {
      lines.push('');
      this.emitScenario(scenario, lines);
    }

    // Single trailing newline
    return lines.join('\n') + '\n';
  }

  // ─── Background ────────────────────────────────────────────────────────────

  private emitBackground(bg: ParsedBackground, lines: string[]): void {
    lines.push('  Background:');
    const annotationColumn = computeAnnotationColumn(bg.steps);
    for (const step of bg.steps) {
      this.emitStep(step, lines, annotationColumn);
    }
  }

  // ─── Scenario / Scenario Outline ───────────────────────────────────────────

  private emitScenario(scenario: ParsedScenario, lines: string[]): void {
    // Tags — one per line at 2-space indent
    for (const tag of scenario.tags) {
      lines.push(`  ${tag}`);
    }

    // Heading
    const keyword = scenario.isOutline ? 'Scenario Outline' : 'Scenario';
    lines.push(`  ${keyword}: ${scenario.name}`);

    // Pre-compute annotation column so trailing @Message/@DryRun etc. align
    const annotationColumn = computeAnnotationColumn(scenario.steps);

    // Steps
    for (const step of scenario.steps) {
      this.emitStep(step, lines, annotationColumn);
    }

    // Examples blocks (only on Scenario Outline)
    for (const ex of scenario.examples) {
      lines.push('');
      this.emitExamples(ex, lines);
    }
  }

  // ─── Examples block ────────────────────────────────────────────────────────

  private emitExamples(ex: ParsedExamples, lines: string[]): void {
    // Examples tags at 4-space indent
    for (const tag of ex.tags) {
      lines.push(`    ${tag}`);
    }
    const heading = ex.name ? `    Examples: ${ex.name}` : '    Examples:';
    lines.push(heading);

    // Table rows at 6-space indent
    const allRows = [ex.header, ...ex.rows];
    const widths = computeColumnWidths(allRows);
    for (const row of allRows) {
      lines.push('      ' + formatTableRow(row, widths));
    }
  }

  // ─── Step ──────────────────────────────────────────────────────────────────

  private emitStep(step: ParsedStep, lines: string[], annotationColumn = 0): void {
    const kw = step.keyword.trim(); // e.g. "Given", "And"
    const indent = ' '.repeat(Math.max(STEP_TEXT_COL - kw.length - 1, 1));

    const { body, trailingAnnotations } = splitTrailingAnnotations(step.text);

    let stepLine: string;
    if (trailingAnnotations !== null) {
      if (annotationColumn > 0) {
        // Align all trailing annotations to the same column
        const bodyCol = STEP_TEXT_COL + body.length;
        const padding = Math.max(3, annotationColumn - bodyCol);
        stepLine = `${indent}${kw} ${body}${' '.repeat(padding)}${trailingAnnotations}`;
      } else {
        // No other annotated steps — just use 3 spaces
        stepLine = `${indent}${kw} ${body}   ${trailingAnnotations}`;
      }
    } else {
      stepLine = `${indent}${kw} ${step.text}`;
    }

    lines.push(stepLine);

    // Doc string
    if (step.docString !== undefined) {
      lines.push('      """');
      for (const docLine of step.docString.split('\n')) {
        lines.push(`      ${docLine}`);
      }
      lines.push('      """');
    }

    // Data table
    if (step.dataTable && step.dataTable.length > 0) {
      const widths = computeColumnWidths(step.dataTable);
      for (const row of step.dataTable) {
        lines.push('      ' + formatTableRow(row, widths));
      }
    }
  }
}

// ─── Step text helpers ────────────────────────────────────────────────────────

/**
 * Normalize the whitespace before trailing inline step annotations so that
 * exactly 3 spaces separate the step body text from any trailing annotation.
 *
 * Trailing annotations are those of the form @Name(args) at the END of the
 * step text — e.g. @Message('...'), @DryRun(name='x',value='v'), @Results('f').
 * Leading annotations (e.g. @Finally, @Soft) are part of the step text body
 * and are NOT affected by this normalisation.
 *
 * Examples:
 *   'I submit the form    @Message(\'failed\')'   → 'I submit the form   @Message(\'failed\')'
 *   'field should be "x"  @Message(\'err\') @Results(\'f.csv\')' → '...   @Message(...) @Results(...)'
 */
function normalizeTrailingAnnotations(text: string): string {
  // Match 1+ whitespace followed by one or more @Name(...) groups at end-of-string.
  // Normalize the leading whitespace to exactly 3 spaces.
  // [^)]*  — annotation args (parens are not nested annotations)
  return text.replace(
    /\s+(@\w+\([^)]*\)(?:\s+@\w+\([^)]*\))*)\s*$/i,
    '   $1'
  );
}

/**
 * Split step text into body and trailing annotations.
 * Trailing annotations: one or more @Name(...) groups at end-of-string.
 * Returns { body, trailingAnnotations } where trailingAnnotations is null if none found.
 */
function splitTrailingAnnotations(text: string): { body: string; trailingAnnotations: string | null } {
  const match = /^(.*?)\s+(@\w+\([^)]*\)(?:\s+@\w+\([^)]*\))*)\s*$/.exec(text);
  if (match) {
    return { body: match[1]!.trim(), trailingAnnotations: match[2]! };
  }
  return { body: text, trailingAnnotations: null };
}

/**
 * Compute the column at which trailing annotations should start across all steps.
 * Returns 0 if no steps have trailing annotations.
 */
function computeAnnotationColumn(steps: ParsedStep[]): number {
  let maxBodyCol = 0;
  let hasAnnotated = false;
  for (const step of steps) {
    const { body, trailingAnnotations } = splitTrailingAnnotations(step.text);
    if (trailingAnnotations !== null) {
      hasAnnotated = true;
      const kw = step.keyword.trim();
      const bodyCol = STEP_TEXT_COL + body.length;
      if (bodyCol > maxBodyCol) maxBodyCol = bodyCol;
    }
  }
  return hasAnnotated ? maxBodyCol + 3 : 0;
}

// ─── Table formatting helpers ─────────────────────────────────────────────────

/**
 * Compute the maximum width of each column across all rows.
 */
function computeColumnWidths(rows: string[][]): number[] {
  if (rows.length === 0) return [];
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i]!, (row[i] ?? '').length);
    }
  }
  return widths;
}

/**
 * Format a single table row as a Gherkin `| cell1 | cell2 |` string.
 * Each cell is left-padded to the column width.
 */
function formatTableRow(row: string[], widths: number[]): string {
  const cells = widths.map((w, i) => ` ${(row[i] ?? '').padEnd(w)} `);
  return `|${cells.join('|')}|`;
}

// ─── Directory scanner ────────────────────────────────────────────────────────

/**
 * Collect all .feature and .meta file paths under a directory (recursive).
 * When `target` is a file, returns it directly (if it has a supported extension).
 */
export function collectGherkinFiles(target: string): string[] {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return [];

  if (stat.isFile()) {
    const ext = path.extname(target).toLowerCase();
    return ext === '.feature' || ext === '.meta' ? [target] : [];
  }

  const results: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectGherkinFiles(full));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.feature' || ext === '.meta') {
        results.push(full);
      }
    }
  }
  return results.sort();
}
