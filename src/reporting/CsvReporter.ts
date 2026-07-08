/**
 * reporting/CsvReporter.ts — CSV report generator for pgwen.
 *
 * Generates a standalone results.csv summary file — one row per scenario — that
 * is useful for post-run analysis, trending dashboards, and data pipelines.
 *
 * Column layout (Preserves results CSV structure):
 *   Feature, FeatureFile, Scenario, Tags, Status, DurationMs, Error
 *
 * Output:
 *   <outputDir>/results.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FeatureTrace } from './HtmlReporter';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CsvReportOptions {
  /** pgwen version included in the file header comment. Default: '1.0.0' */
  version?: string;
  /** Field separator. Default: ',' */
  separator?: string;
}

export class CsvReporter {
  /**
   * Generate a results.csv file from feature execution traces.
   *
   * @param traces    Feature execution traces (from toFeatureTrace())
   * @param outputDir Directory to write results.csv into
   * @param options   Optional version / separator override
   */
  generate(
    traces: FeatureTrace[],
    outputDir: string,
    options: CsvReportOptions = {}
  ): void {
    fs.mkdirSync(outputDir, { recursive: true });
    const csv = this.generateCsv(traces, options);
    fs.writeFileSync(path.join(outputDir, 'results.csv'), csv, 'utf8');
  }

  /**
   * Build the CSV string from traces (exposed for unit testing).
   */
  generateCsv(traces: FeatureTrace[], options: CsvReportOptions = {}): string {
    const sep = options.separator ?? ',';
    const version = options.version ?? '1.0.0';

    const lines: string[] = [];

    // Header comment (not a CSV row — prefixed with # so parsers can skip it)
    lines.push(`# pgwen v${version} — results.csv`);

    // Column headers
    lines.push(
      [
        'Feature',
        'FeatureFile',
        'Scenario',
        'Status',
        'DurationMs',
        'Error',
      ]
        .map((h) => csvField(h, sep))
        .join(sep)
    );

    for (const trace of traces) {
      for (const scenario of trace.scenarios) {
        const failedStep = scenario.steps.find((s) => s.status === 'failed');
        const error = failedStep?.error ?? '';

        const row = [
          trace.name,
          trace.file,
          scenario.name,
          scenario.status,
          String(scenario.durationMs),
          error,
        ]
          .map((v) => csvField(v, sep))
          .join(sep);

        lines.push(row);
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Generate a summary-level CSV: one row per feature (not per scenario).
   * Useful for high-level dashboards.
   */
  generateSummaryCsv(traces: FeatureTrace[], options: CsvReportOptions = {}): string {
    const sep = options.separator ?? ',';
    const version = options.version ?? '1.0.0';

    const lines: string[] = [];
    lines.push(`# pgwen v${version} — summary.csv`);
    lines.push(
      [
        'Feature',
        'FeatureFile',
        'Status',
        'Scenarios',
        'Passed',
        'Failed',
        'Skipped',
        'DurationMs',
      ]
        .map((h) => csvField(h, sep))
        .join(sep)
    );

    for (const trace of traces) {
      const passed  = trace.scenarios.filter((s) => s.status === 'passed').length;
      const failed  = trace.scenarios.filter((s) => s.status === 'failed').length;
      const skipped = trace.scenarios.filter((s) => s.status === 'skipped').length;
      const total   = trace.scenarios.length;

      const row = [
        trace.name,
        trace.file,
        trace.status,
        String(total),
        String(passed),
        String(failed),
        String(skipped),
        String(trace.durationMs),
      ]
        .map((v) => csvField(v, sep))
        .join(sep);

      lines.push(row);
    }

    return lines.join('\n') + '\n';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wrap a value in double quotes if it contains the separator, a quote, or a
 * newline. Internal double-quotes are escaped by doubling them (RFC 4180).
 */
function csvField(value: string, sep: string): string {
  const needsQuoting =
    value.includes(sep) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');

  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
