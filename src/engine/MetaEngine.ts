/**
 * MetaEngine.ts — Load .meta files and build the StepDef registry.
 *
 * Implements all three the reference framework meta load strategies:
 *
 *   1. Associative  — auto-loads <name>.meta alongside <name>.feature
 *   2. Common       — loads named meta files / directories for all features
 *   3. Import       — follows @Import('path/to/file.meta') chains recursively
 *
 * Load order (lowest → highest precedence, last-registered wins):
 *   common meta → imported meta → associative meta
 *
 * Cyclic @Import detection is enforced: a file already in the loading
 * stack throws MetaCyclicImportError.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GherkinParser, type ParsedFeature, type ParsedScenario } from './GherkinParser';
import { StepDefRegistry, buildStepDef } from './StepDefRegistry';
import { parseAnnotations, KNOWN_ANNOTATION_NAMES } from '../annotations/Annotations';
import { parseStepInlineAnnotations } from './StepAnnotationParser';

// ─── MetaEngine ───────────────────────────────────────────────────────────────

export interface LoadedMetaFile {
  /** Feature name declared inside the .meta file (e.g. "Account search meta"). */
  name: string;
  /** Relative file path as written in pgwen.conf / CLI (e.g. "pgwen/features/Example.meta"). */
  file: string;
  /** Wall-clock time when this file finished loading. */
  loadTime: Date;
  /** How long the file took to parse and register, in ms. */
  durationMs: number;
}

export class MetaEngine {
  private readonly parser: GherkinParser;
  readonly registry: StepDefRegistry;

  /** Absolute paths already fully loaded — used for dedup and cycle detection. */
  private readonly loadedFiles = new Set<string>();

  /** Stack of files currently being loaded — used to detect @Import cycles. */
  private readonly loadingStack: string[] = [];

  /** Ordered list of meta files that have been successfully loaded. */
  readonly loadedMeta: LoadedMetaFile[] = [];

  /**
   * Global cross-file registry: maps StepDef name → source file of first registration.
   * Used to detect duplicates across different meta files (same rule as same-file duplicates).
   */
  private readonly globalStepNames = new Map<string, string>();

  constructor(parser?: GherkinParser, registry?: StepDefRegistry) {
    this.parser = parser ?? new GherkinParser();
    this.registry = registry ?? new StepDefRegistry();
  }

  // ─── Strategy 1: Common meta ──────────────────────────────────────────────

  /**
   * Load a single .meta file as common meta.
   * If `filePath` is a directory, load all .meta files in it recursively.
   */
  loadCommon(filePath: string): void {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      this.loadMetaDir(resolved);
    } else {
      this.loadMetaFile(resolved);
    }
  }

  /**
   * Re-load a .meta file, bypassing the already-loaded cache.
   * Used by the REPL `load` command to pick up changes to an already-loaded file.
   * Any StepDefs with the same name will be overwritten by the freshly-parsed version
   * (StepDefRegistry uses last-registered-wins semantics for same-name step defs).
   */
  reload(filePath: string): void {
    const resolved = path.resolve(filePath);
    // Remove from loaded cache so loadMetaFile will process it again
    this.loadedFiles.delete(resolved);
    this.loadMetaFile(resolved);
  }

  // ─── Strategy 2: Associative meta ─────────────────────────────────────────

  /**
   * Auto-load the .meta file that lives beside a .feature file (same name, same dir).
   * No-op if no such file exists.
   */
  loadAssociative(featureFilePath: string): void {
    const metaPath = featureFilePath.replace(/\.feature$/, '.meta');
    const resolved = path.resolve(metaPath);
    if (fs.existsSync(resolved)) {
      this.loadMetaFile(resolved);
    }
  }

  // ─── Strategy 3: Import chain ─────────────────────────────────────────────

  /**
   * Load a meta file referenced by @Import('path/to/file.meta').
   * The importPath is resolved relative to the importing file's directory.
   */
  loadImport(importPath: string, fromFile: string): void {
    const resolved = path.resolve(path.dirname(fromFile), importPath);
    if (this.loadingStack.includes(resolved)) {
      throw new MetaCyclicImportError(
        `Cyclic @Import detected: "${resolved}" is already being loaded.\n` +
        `Import chain: ${[...this.loadingStack, resolved].join(' → ')}`
      );
    }
    this.loadMetaFile(resolved);
  }

  // ─── In-memory loading (for tests / REPL) ────────────────────────────────

  /**
   * Parse meta content from a string (no file I/O).
   * `uri` is used as the source label in StepDef records.
   */
  loadMetaSource(content: string, uri: string): void {
    const feature = this.parser.parseSource(content, uri);
    this.processFeature(feature, uri);
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private loadMetaFile(absolutePath: string): void {
    if (this.loadedFiles.has(absolutePath)) return; // already loaded
    this.loadingStack.push(absolutePath);

    try {
      const t0 = Date.now();
      const feature = this.parser.parseFile(absolutePath);
      this.processFeature(feature, absolutePath);
      this.loadedFiles.add(absolutePath);
      this.loadedMeta.push({
        name: feature.name,
        file: absolutePath,
        loadTime: new Date(),
        durationMs: Date.now() - t0,
      });
    } finally {
      this.loadingStack.pop();
    }
  }

  private loadMetaDir(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.loadMetaDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.meta')) {
        this.loadMetaFile(fullPath);
      }
    }
  }

  private processFeature(feature: ParsedFeature, sourceFile: string): void {
    // Track StepDef names seen in THIS file to detect duplicates within the same file.
    // Cross-file duplicates are allowed (last-registered wins); same-file duplicates → error.
    const seenInFile = new Map<string, number>(); // name → count

    // Validate feature-level PascalCase tags. Typos at the Feature header
    // (e.g. `@StepDefs` on the file when authors meant to mark the whole
    // file as a StepDef library) are otherwise silently ignored.
    // Pure @smoke / @regression filter tags are lowercase and skipped.
    validateAnnotationNamesAtLocation(feature.tags, sourceFile, /* line */ 1);

    for (const scenario of feature.scenarios) {
      // Validate annotation names on EVERY scenario, not just @StepDef
      // ones. If the author wrote `@StepDefs` (typo), the scenario won't
      // parse as a StepDef and the old code's `continue` below would
      // silently skip it. Validating up-front catches the typo at load
      // time — matches the reference framework's IllegalStepAnnotationException behaviour.
      validateAnnotationNamesAtLocation(scenario.tags, sourceFile, scenario.line);

      const annotations = parseAnnotations(scenario.tags);

      // Only register Scenarios annotated with @StepDef
      if (!annotations.isStepDef) continue;

      // Handle @Import before registering this StepDef
      if (annotations.importPath) {
        this.loadImport(annotations.importPath, sourceFile);
      }

      // Validate @Finally position: it must only appear on the last step.
      // The reference framework throws IllegalStepAnnotationException immediately on this.
      validateFinallyPosition(scenario, sourceFile);

      // Validate @Eager usage: only permitted on '<x> defined by <y>' binding steps.
      validateEagerAnnotation(scenario, sourceFile);

      // Detect duplicate StepDef names — same file first, then cross-file.
      // The reference framework throws in both cases:
      //   "Ambiguous condition in file X: StepDef 'Y' defined 2 times"
      const existingInFile = seenInFile.get(scenario.name) ?? 0;
      seenInFile.set(scenario.name, existingInFile + 1);
      if (existingInFile >= 1) {
        throw new AmbiguousCaseException(
          `Ambiguous condition in file ${sourceFile}: StepDef '${scenario.name}' defined ${existingInFile + 1} times`
        );
      }

      const priorFile = this.globalStepNames.get(scenario.name);
      if (priorFile !== undefined && priorFile !== sourceFile) {
        // Second definition comes from a different file — throw citing the current file
        // (matches the reference framework's error format which names the file where the duplicate was found)
        throw new AmbiguousCaseException(
          `Ambiguous condition in file ${sourceFile}: StepDef '${scenario.name}' defined 2 times`
        );
      }
      this.globalStepNames.set(scenario.name, sourceFile);

      const stepDef = buildStepDef(
        scenario.name,
        scenario.tags,
        scenario.steps,
        sourceFile,
        scenario.line
      );
      this.registry.register(stepDef);
    }
  }
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class MetaCyclicImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaCyclicImportError';
  }
}

export class IllegalStepAnnotationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalStepAnnotationException';
  }
}

export class AmbiguousCaseException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousCaseException';
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate that all PascalCase Gherkin tags on a @StepDef scenario are recognised
 * pgwen annotations. Typos like @Eagers (instead of @Eager) are silently swallowed
 * by parseAnnotations — this catches them at load time.
 *
 * Rule: if a tag starts with an uppercase letter, it must be in KNOWN_ANNOTATION_NAMES.
 * Lowercase tags (e.g. @smoke, @regression) are user-defined filter tags — allowed.
 */
/** Annotations that require a parameter argument — `@Name(...)` form is mandatory. */
const PARAMETERIZED_ANNOTATIONS: ReadonlySet<string> = new Set([
  'Message', 'Timeout', 'Delay', 'DryRun', 'Results', 'Import', 'Examples',
]);

/**
 * Validate any tag-bearing entity's PascalCase tags. Used for features +
 * every scenario (not only @StepDef ones — the most common typo is
 * @StepDefs, which then fails the isStepDef check and gets silently
 * skipped if validation is gated on isStepDef).
 *
 * Suggests the nearest valid annotation when the typo is close to a
 * known name (Levenshtein distance ≤ 2). Catches @Eagers → @Eager,
 * @Stepdef → @StepDef, @Sycnhronized → @Synchronized, etc.
 */
function validateAnnotationNamesAtLocation(
  tags: readonly string[],
  sourceFile: string,
  line: number,
): void {
  for (const rawTag of tags) {
    const tag = rawTag.startsWith('@') ? rawTag.slice(1) : rawTag;
    // Extract base name (everything before any opening paren)
    const baseName = /^([A-Za-z][A-Za-z0-9]*)/.exec(tag)?.[1] ?? '';
    // Only check PascalCase names (first char uppercase) — lowercase tags are filter tags
    const firstChar = baseName[0];
    if (!baseName || !firstChar || firstChar !== firstChar.toUpperCase() || firstChar === firstChar.toLowerCase()) continue;
    if (!KNOWN_ANNOTATION_NAMES.has(baseName)) {
      const suggestion = nearestKnownAnnotation(baseName);
      const hint = suggestion ? ` Did you mean @${suggestion}?` : '';
      throw new IllegalStepAnnotationException(
        `Invalid or illegal annotation [at ${sourceFile}:${line}]: ` +
        `@${baseName} is not a valid pgwen annotation.${hint}`
      );
    }
    // Parameterised annotations must have `(...)` — missing or unclosed paren is a syntax error
    if (PARAMETERIZED_ANNOTATIONS.has(baseName)) {
      const openIdx = tag.indexOf('(');
      if (openIdx === -1) {
        throw new IllegalStepAnnotationException(
          `Invalid or illegal annotation [at ${sourceFile}:${line}]: ` +
          `@${baseName} requires a parameter — use @${baseName}('value')`
        );
      }
      if (!tag.endsWith(')')) {
        throw new IllegalStepAnnotationException(
          `Invalid or illegal annotation [at ${sourceFile}:${line}]: ` +
          `Malformed annotation @${tag} — missing closing parenthesis`
        );
      }
    }
  }
}

/**
 * Return the known annotation name closest to `name` if the
 * Levenshtein distance is ≤ 2, otherwise undefined. Case-insensitive
 * for the distance check (so @stepdef → @StepDef suggested).
 *
 * Common typos this catches:
 *   @Eagers → @Eager       (distance 1)
 *   @Stepdef → @StepDef    (distance 0 case-insensitive, but 1 raw)
 *   @Sycnhronized → @Synchronized (distance 2)
 */
function nearestKnownAnnotation(name: string): string | undefined {
  const lowered = name.toLowerCase();
  let best: { name: string; dist: number } | undefined;
  for (const known of KNOWN_ANNOTATION_NAMES) {
    const dist = levenshtein(lowered, known.toLowerCase());
    if (dist <= 2 && (best === undefined || dist < best.dist)) {
      best = { name: known, dist };
    }
  }
  return best?.name;
}

/**
 * Compute Levenshtein edit distance between two strings. Pure helper;
 * no external dep. Small enough for typo suggestion — strings here are
 * never longer than ~20 chars.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[] = new Array(rows * cols);
  for (let i = 0; i < rows; i++) matrix[i * cols] = i;
  for (let j = 0; j < cols; j++) matrix[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i * cols + j] = Math.min(
        matrix[(i - 1) * cols + j]! + 1,       // deletion
        matrix[i * cols + (j - 1)]! + 1,        // insertion
        matrix[(i - 1) * cols + (j - 1)]! + cost, // substitution
      );
    }
  }
  return matrix[rows * cols - 1]!;
}

/**
 * Validate that @Finally (inline annotation) appears only on the LAST step of
 * a StepDef body. The reference framework throws IllegalStepAnnotationException immediately
 * when it encounters @Finally on any non-last step during meta loading.
 */
function validateFinallyPosition(scenario: ParsedScenario, sourceFile: string): void {
  const steps = scenario.steps;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]!;
    const inline = parseStepInlineAnnotations(step.text);
    if (inline.isFinally) {
      throw new IllegalStepAnnotationException(
        `Invalid or illegal step annotation [at ${sourceFile}:${step.line}]: ` +
        `@Finally permitted only in last step of parent node`
      );
    }
  }
}

/**
 * Validate that @Eager only appears on '<x> defined by <y>' binding steps.
 * The reference framework error: "Invalid or illegal step annotation [at file:line]:
 *   @Eager annotation permitted only for '<x> defined by <y>' DSL steps"
 */
function validateEagerAnnotation(scenario: ParsedScenario, sourceFile: string): void {
  for (const step of scenario.steps) {
    const inline = parseStepInlineAnnotations(step.text);
    if (inline.isEager) {
      // Strip the @Eager prefix to get the clean step text, then check for "defined by"
      const cleanText = inline.cleanText;
      if (!/ defined by /i.test(cleanText)) {
        throw new IllegalStepAnnotationException(
          `Invalid or illegal step annotation [at ${sourceFile}:${step.line}]: ` +
          `@Eager annotation permitted only for '<x> defined by <y>' DSL steps`
        );
      }
    }
  }
}
