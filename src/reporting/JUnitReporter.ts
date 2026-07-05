/**
 * reporting/JUnitReporter.ts — JUnit XML report generator for CI systems (Jenkins, GitLab, GitHub Actions, Azure Pipelines, etc.).
 *
 * Generates one XML file per feature following the Surefire/JUnit XML schema
 * understood by Jenkins JUnit Plugin, GitLab, GitHub Actions, and all major CI
 * systems. File naming convention mirrors the reference: TEST-NNNN-FeatureName.xml
 *
 * Output structure:
 *   <outputDir>/
 *     TEST-0001-Login.xml
 *     TEST-0002-Search.xml
 *
 * XML format (Surefire schema):
 *   <testsuites name="pgwen" tests="N" failures="M" time="T">
 *     <testsuite name="Feature Name" tests="N" failures="M" time="T"
 *                hostname="…" timestamp="ISO8601">
 *       <properties>
 *         <property name="file" value="path/to/feature"/>
 *       </properties>
 *       <testcase name="Scenario Name" classname="FeatureSlug" time="T"/>
 *       <testcase name="Failing Scenario" classname="FeatureSlug" time="T">
 *         <failure message="short msg" type="AssertionError">full detail</failure>
 *       </testcase>
 *       <testcase name="Skipped Scenario" classname="FeatureSlug" time="T">
 *         <skipped/>
 *       </testcase>
 *     </testsuite>
 *   </testsuites>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FeatureTrace, ScenarioTrace } from './HtmlReporter';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface JUnitReportOptions {
  /** pgwen version shown in the XML suite name. Default: '1.0.0' */
  version?: string;
}

export class JUnitReporter {
  /**
   * Generate one TEST-NNNN-Name.xml file per feature.
   *
   * @param traces    Feature execution traces
   * @param outputDir Directory to write XML files into
   * @param options   Optional version string
   */
  generate(
    traces: FeatureTrace[],
    outputDir: string,
    options: JUnitReportOptions = {}
  ): void {
    fs.mkdirSync(outputDir, { recursive: true });

    // Write the combined testsuites wrapper file (for CI dashboards)
    const combinedXml = this.generateCombinedXml(traces, options);
    fs.writeFileSync(path.join(outputDir, 'TEST-results.xml'), combinedXml, 'utf8');

    // Write one XML file per feature (Surefire convention)
    traces.forEach((trace, idx) => {
      const slug = slugify(path.basename(trace.file, path.extname(trace.file)));
      const fileName = `TEST-${String(idx + 1).padStart(4, '0')}-${slug}.xml`;
      const xml = this.generateSuiteXml(trace, options);
      fs.writeFileSync(path.join(outputDir, fileName), xml, 'utf8');
    });
  }

  /**
   * Generate a combined <testsuites> XML wrapping all features.
   * This is the "master" JUnit file most CI systems read for the overall summary.
   */
  generateCombinedXml(traces: FeatureTrace[], options: JUnitReportOptions = {}): string {
    const totalTests = traces.reduce((s, t) => s + t.scenarios.length, 0);
    const totalFailures = traces.reduce(
      (s, t) => s + t.scenarios.filter((sc) => sc.status === 'failed').length,
      0
    );
    const totalSkipped = traces.reduce(
      (s, t) => s + t.scenarios.filter((sc) => sc.status === 'skipped').length,
      0
    );
    const totalTime = traces.reduce((s, t) => s + t.durationMs, 0);
    const version = options.version ?? '1.0.0';

    const suites = traces
      .map((trace) => this.renderSuiteBlock(trace))
      .join('\n');

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<testsuites name="pgwen v${escapeXml(version)}"` +
      ` tests="${totalTests}"` +
      ` failures="${totalFailures}"` +
      ` errors="0"` +
      ` skipped="${totalSkipped}"` +
      ` time="${msToSeconds(totalTime)}">\n` +
      suites + '\n' +
      `</testsuites>\n`
    );
  }

  /**
   * Generate a standalone <testsuite> XML for one feature.
   */
  generateSuiteXml(trace: FeatureTrace, options: JUnitReportOptions = {}): string {
    const version = options.version ?? '1.0.0';
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!-- pgwen v${escapeXml(version)} -->\n` +
      this.renderSuiteBlock(trace) + '\n'
    );
  }

  // ─── Internal rendering ───────────────────────────────────────────────────

  private renderSuiteBlock(trace: FeatureTrace): string {
    const failures = trace.scenarios.filter((s) => s.status === 'failed').length;
    const skipped = trace.scenarios.filter((s) => s.status === 'skipped').length;
    const slug = slugify(path.basename(trace.file, path.extname(trace.file)));
    const timestamp = trace.startTime.toISOString().slice(0, 19); // no milliseconds
    const relFile = path.relative(process.cwd(), trace.file);

    const testCases = trace.scenarios
      .map((s) => this.renderTestCase(s, slug))
      .join('\n');

    return (
      `  <testsuite` +
      ` name="${escapeXml(trace.name)}"` +
      ` tests="${trace.scenarios.length}"` +
      ` failures="${failures}"` +
      ` errors="0"` +
      ` skipped="${skipped}"` +
      ` time="${msToSeconds(trace.durationMs)}"` +
      ` hostname="${escapeXml(os.hostname())}"` +
      ` timestamp="${timestamp}">\n` +
      `    <properties>\n` +
      `      <property name="file" value="${escapeXml(relFile)}"/>\n` +
      `    </properties>\n` +
      testCases + '\n' +
      `  </testsuite>`
    );
  }

  private renderTestCase(scenario: ScenarioTrace, classname: string): string {
    const attrs =
      ` name="${escapeXml(scenario.name)}"` +
      ` classname="${escapeXml(classname)}"` +
      ` time="${msToSeconds(scenario.durationMs)}"`;

    if (scenario.status === 'failed') {
      const failedStep = scenario.steps.find((s) => s.status === 'failed');
      const message = failedStep?.error ?? 'Scenario failed';
      const detail = buildFailureDetail(scenario);
      return (
        `    <testcase${attrs}>\n` +
        `      <failure message="${escapeXml(message)}" type="AssertionError">${escapeXml(detail)}</failure>\n` +
        `    </testcase>`
      );
    }

    if (scenario.status === 'skipped') {
      return `    <testcase${attrs}>\n      <skipped/>\n    </testcase>`;
    }

    // Passed — empty testcase element (self-closing is fine but some CI consumers prefer open/close)
    return `    <testcase${attrs}/>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the failure detail body: lists all failed steps with error messages.
 */
function buildFailureDetail(scenario: ScenarioTrace): string {
  const lines: string[] = [`Scenario: ${scenario.name}`];
  for (const step of scenario.steps) {
    const prefix = `  ${step.keyword} ${step.text}`;
    if (step.status === 'failed' && step.error) {
      lines.push(`${prefix} [FAILED]`);
      lines.push(`    Error: ${step.error}`);
    } else if (step.status === 'skipped') {
      lines.push(`${prefix} [SKIPPED]`);
    } else {
      lines.push(`${prefix}`);
    }
  }
  return lines.join('\n');
}

/**
 * Convert milliseconds to seconds string with 3 decimal places.
 * e.g. 1534 → "1.534"
 */
export function msToSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Escape XML special characters in attribute values and text content.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert a name to a safe XML/file-system slug.
 */
function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
