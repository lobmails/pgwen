/**
 * GherkinParser.ts — Parse .feature and .meta files into pgwen's internal AST.
 *
 * Wraps @cucumber/gherkin so the rest of the codebase never touches
 * the raw Gherkin library types. Everything external is in terms of
 * ParsedFeature and its component types.
 *
 * Both .feature and .meta files use the same Gherkin grammar.
 * The distinction (StepDef vs regular Scenario) is purely tag-based
 * and is handled by MetaEngine, not here.
 */

import { Parser, AstBuilder, GherkinClassicTokenMatcher } from '@cucumber/gherkin';
import {
  IdGenerator,
  type GherkinDocument,
  type Feature,
  type Scenario,
  type Step,
  type Background,
  type Examples,
  type TableRow,
} from '@cucumber/messages';
import * as fs from 'fs';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ParsedStep {
  /** Raw keyword including trailing space: "Given ", "When ", "And ", etc. */
  keyword: string;
  /** Step text with whitespace trimmed. Does NOT include the keyword. */
  text: string;
  /** Content of a triple-quoted doc string, if present. */
  docString?: string;
  /** Data table rows. Each row is an array of cell strings (already trimmed). */
  dataTable?: string[][];
  line: number;
  /**
   * Absolute or repo-relative path to the file this step was parsed from.
   * Optional for back-compat with callers that build ParsedStep literals
   * for tests. The Compositor uses this to report `[at file:line]` in
   * UndefinedStepError messages from STEPDEF BODIES — without it, the
   * error would report the outer feature file's path even when the
   * undefined substep lives in a .meta file.
   */
  sourceFile?: string;
}

export interface ParsedExamples {
  /** Tags on the Examples block, e.g. ["@Parallel"] */
  tags: string[];
  name: string;
  /** Column headers from the first row. */
  header: string[];
  /** Data rows (header row excluded). */
  rows: string[][];
  line: number;
}

export interface ParsedScenario {
  /** All @Tag strings on this scenario, e.g. ["@StepDef", "@Context", "@Timeout('10s')"] */
  tags: string[];
  name: string;
  steps: ParsedStep[];
  /** Populated only for Scenario Outline. */
  examples: ParsedExamples[];
  /** True when the Gherkin keyword is "Scenario Outline" or "Scenario Template". */
  isOutline: boolean;
  line: number;
  /** Name of the enclosing Rule block, if any. Undefined when not inside a Rule. */
  ruleName?: string;
}

export interface ParsedBackground {
  steps: ParsedStep[];
  line: number;
}

export interface ParsedFeature {
  /** Tags on the Feature itself. */
  tags: string[];
  name: string;
  description: string;
  background?: ParsedBackground;
  /** All Scenarios (and StepDefs in .meta files). */
  scenarios: ParsedScenario[];
  /** Source path as provided to the parser. Empty string for in-memory parses. */
  uri: string;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export class GherkinParser {
  private readonly parser: Parser<GherkinDocument>;

  constructor() {
    const newId = IdGenerator.uuid();
    const builder = new AstBuilder(newId);
    const matcher = new GherkinClassicTokenMatcher();
    this.parser = new Parser(builder, matcher) as Parser<GherkinDocument>;
  }

  /**
   * Parse Gherkin source text into a ParsedFeature.
   * Throws GherkinParseError on invalid syntax.
   *
   * @param content  Raw file contents.
   * @param uri      Path label used in error messages (optional).
   */
  parseSource(content: string, uri = '<source>'): ParsedFeature {
    // Pre-check: "" (two quotes) is an invalid docstring delimiter — must be """
    const twoQuoteMatch = /^[ \t]*""[ \t]*$/m.exec(content);
    if (twoQuoteMatch) {
      throw new GherkinParseError(
        `Invalid docstring delimiter '""' found in "${uri}" — use triple quotes '"""' instead`
      );
    }

    let doc: GherkinDocument;
    try {
      doc = this.parser.parse(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GherkinParseError(`Failed to parse Gherkin in "${uri}": ${msg}`);
    }

    if (!doc.feature) {
      throw new GherkinParseError(`No Feature block found in "${uri}"`);
    }

    return convertFeature(doc.feature, uri);
  }

  /**
   * Read a file from disk and parse it.
   */
  parseFile(filePath: string): ParsedFeature {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GherkinParseError(`Cannot read file "${filePath}": ${msg}`);
    }
    return this.parseSource(content, filePath);
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function convertFeature(feature: Feature, uri: string): ParsedFeature {
  const tags = feature.tags.map((t) => t.name);
  let background: ParsedBackground | undefined;
  const scenarios: ParsedScenario[] = [];

  for (const child of feature.children) {
    if (child.background) {
      background = convertBackground(child.background, uri);
    } else if (child.scenario) {
      scenarios.push(convertScenario(child.scenario, uri));
    }
    // Rules are flattened: children of a Rule are treated as top-level scenarios.
    // Each scenario is tagged with the Rule name so Runner can set ctx.rule.
    if (child.rule) {
      const ruleName = child.rule.name.trim();
      for (const ruleChild of child.rule.children) {
        if (ruleChild.background) {
          // Rule-level background — merge into feature background (last wins)
          background = convertBackground(ruleChild.background, uri);
        } else if (ruleChild.scenario) {
          const s = convertScenario(ruleChild.scenario, uri);
          if (ruleName) s.ruleName = ruleName;
          scenarios.push(s);
        }
      }
    }
  }

  const parsed: ParsedFeature = {
    tags,
    name: feature.name.trim(),
    description: feature.description?.trim() ?? '',
    scenarios,
    uri,
  };
  if (background !== undefined) parsed.background = background;
  return parsed;
}

function convertBackground(bg: Background, sourceFile: string): ParsedBackground {
  return {
    steps: bg.steps.map((s) => convertStep(s, sourceFile)),
    line: bg.location.line,
  };
}

function convertScenario(scenario: Scenario, sourceFile: string): ParsedScenario {
  const keyword = scenario.keyword.trim().toLowerCase();
  const isOutline = keyword === 'scenario outline' || keyword === 'scenario template';

  return {
    tags: scenario.tags.map((t) => t.name),
    name: scenario.name.trim(),
    steps: scenario.steps.map((s) => convertStep(s, sourceFile)),
    examples: scenario.examples.map(convertExamples),
    isOutline,
    line: scenario.location.line,
  };
}

function convertStep(step: Step, sourceFile: string): ParsedStep {
  const parsed: ParsedStep = {
    keyword: step.keyword,   // includes trailing space, e.g. "Given "
    text: step.text.trim(),
    line: step.location.line,
    sourceFile,
  };

  if (step.docString) {
    parsed.docString = step.docString.content;
  }

  if (step.dataTable) {
    parsed.dataTable = step.dataTable.rows.map(convertRow);
  }

  return parsed;
}

function convertRow(row: TableRow): string[] {
  return row.cells.map((c) => c.value.trim());
}

function convertExamples(ex: Examples): ParsedExamples {
  // tableHeader is the header row; tableBody contains only the data rows
  const emptyRow = { cells: [], id: '', location: { line: 0, column: 0 } };
  return {
    tags: ex.tags.map((t) => t.name),
    name: ex.name.trim(),
    header: convertRow(ex.tableHeader ?? emptyRow),
    rows: ex.tableBody.map(convertRow),
    line: ex.location.line,
  };
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class GherkinParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GherkinParseError';
  }
}
