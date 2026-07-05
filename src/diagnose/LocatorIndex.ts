/**
 * LocatorIndex.ts — heuristic post-hoc locator lookup for the bundle
 * assembler.
 *
 * Real-world test-maintenance pain: a failing step references a binding
 * (e.g. "I click the submit button"). To make `DiagnoseInput.locator`
 * non-null, we need to know:
 *   - the binding declaration's file + line,
 *   - the selector strategy and value,
 *   - the surrounding source lines for context.
 *
 * Capturing this at runtime would mean threading source location through
 * every DSL handler — high cost, broad change. Instead, this module
 * parses the meta files pgwen has already loaded for the failing
 * feature and builds an index. The bundle assembler queries it for the
 * binding that "lives inside" the failing step's text.
 *
 * Trade-off: dynamic bindings (declared by an `<name> is defined by js`
 * step or programmatic StepDefs) are NOT in the index. That's an
 * acceptable known gap — most project bindings are declared statically in
 * .meta files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toPosixPath } from '../util/paths';

export interface LocatorMetadata {
  /** Binding name as written, e.g. "submit button". */
  name: string;
  /** Strategy token: id / css / xpath / name / class / tag / link / partial link / js / … */
  selector_strategy: string;
  /** Selector value the binding evaluates against. */
  selector_value: string;
  /** Absolute path of the meta file the binding was declared in. */
  binding_file: string;
  /** 1-based line where the declaration appears. */
  binding_line: number;
  /** Full source text of the binding file, retained so the assembler can slice ±5 line context. */
  file_content: string;
}

export interface LocatorIndex {
  /** Binding name (lowercased, trimmed) → metadata. */
  byName: ReadonlyMap<string, LocatorMetadata>;
  /** All entries, retained in declaration order (file-then-line) for predictable lookup. */
  all: ReadonlyArray<LocatorMetadata>;
}

const EMPTY_INDEX: LocatorIndex = { byName: new Map(), all: [] };

/**
 * Pattern that matches the common locator-binding form:
 *   `<name> can be located by <strategy> "<value>"`
 *
 * Strategy is one or two whitespace-separated alphanumeric tokens —
 * covers `id`, `css`, `xpath`, `name`, `class`, `tag`, `link`, `partial
 * link`, `js`, plus future single/double-word strategies. We accept
 * leading whitespace so indented Gherkin lines parse cleanly.
 */
const BINDING_RE = /^\s*(?:And|Given|When|Then|But)?\s*(.+?)\s+can\s+be\s+located\s+by\s+([a-z]+(?:\s+[a-z]+)?)\s+"([^"]+)"\s*$/i;

// ─── Builders ──────────────────────────────────────────────────────────────

export interface BuildLocatorIndexInput {
  /** Paths to meta files (absolute or relative). */
  metaFiles: ReadonlyArray<string>;
  /** Resolves relative meta-file paths. Default: CWD. */
  baseDir?: string;
  /** Optional file reader override (tests). Default: fs.readFileSync. */
  readFile?: (filePath: string) => string;
}

/**
 * Parse the supplied meta files and build a name → metadata index.
 * Unreadable files and malformed lines are silently skipped — a single
 * bad file never poisons the whole index.
 */
export function buildLocatorIndex(input: BuildLocatorIndexInput): LocatorIndex {
  const baseDir = input.baseDir ?? process.cwd();
  const readFile = input.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));

  const all: LocatorMetadata[] = [];
  const byName = new Map<string, LocatorMetadata>();

  for (const file of input.metaFiles) {
    const resolved = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
    let content: string;
    try {
      content = readFile(resolved);
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = BINDING_RE.exec(line);
      if (!match) continue;

      const name = match[1]!.trim().replace(/^the\s+/i, '');
      const strategy = match[2]!.trim().toLowerCase();
      const value = match[3]!;

      const meta: LocatorMetadata = {
        name,
        selector_strategy: strategy,
        selector_value: value,
        binding_file: toPosixPath(resolved),
        binding_line: i + 1,
        file_content: content,
      };
      all.push(meta);
      // Last-write-wins on duplicate names — the most recently loaded
      // meta file usually overrides a shared default, matching pgwen's
      // own resolution order.
      byName.set(name.toLowerCase(), meta);
    }
  }

  return { byName, all };
}

// ─── Lookup ────────────────────────────────────────────────────────────────

/**
 * Find the locator binding most likely involved in a failing step.
 * Strategy:
 *   1. Prefer the longest binding name whose word-boundaries match
 *      anywhere in the step text (case-insensitive). This avoids
 *      "submit" matching the step text "I submitted the form" while
 *      still picking "submit button" when the step says "I click the
 *      submit button".
 *   2. Return null when no candidate matches — the assembler emits a
 *      bundle with `locator: null` rather than guess.
 */
export function findLocatorForStep(
  stepText: string,
  index: LocatorIndex,
): LocatorMetadata | null {
  if (index.all.length === 0) return null;
  const sorted = [...index.all].sort((a, b) => b.name.length - a.name.length);
  const haystack = stepText.toLowerCase();
  for (const meta of sorted) {
    if (meta.name.length === 0) continue;
    const re = new RegExp(`\\b${escapeRegex(meta.name)}\\b`, 'i');
    if (re.test(haystack)) return meta;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Empty index helper — useful for callers that need a no-op fallback. */
export function emptyLocatorIndex(): LocatorIndex {
  return EMPTY_INDEX;
}
