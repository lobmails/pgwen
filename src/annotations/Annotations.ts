/**
 * Annotations.ts — Parse all 27 annotations from Gherkin tag strings.
 *
 * Gherkin tags arrive as strings like "@StepDef", "@Timeout('10s')", "@Import('path/to/file.meta')".
 * This module converts an array of such tag strings into a strongly-typed ParsedAnnotations object.
 *
 * All 27 annotations are covered:
 *   @StepDef, @Context, @Action, @Assertion,
 *   @DataTable, @ForEach,
 *   @Synchronized / @Synchronised,
 *   @Try, @Finally,
 *   @Eager, @Lazy, @Masked,
 *   @Timeout('Xs'), @Delay('Xs'),
 *   @Hard, @Soft, @Sustained,
 *   @DryRun('value'),
 *   @Breakpoint,
 *   @Parallel,
 *   @Trim, @IgnoreCase,
 *   @Ignore,
 *   @ShadowRoot,
 *   @Results('file'), @Message('text'),
 *   @Import('path'),
 *   @Examples('file') / @Examples(file='...', where='...', prefix='...', required=true)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExamplesAnnotation {
  file: string;
  where?: string;
  prefix?: string;
  required?: boolean;
}

export interface ParsedAnnotations {
  // Step definition role
  isStepDef: boolean;
  isContext: boolean;
  isAction: boolean;
  isAssertion: boolean;

  // Data table iteration
  isDataTable: boolean;
  isForEach: boolean;

  // Thread safety
  isSynchronized: boolean;

  // Error handling / lifecycle
  isTry: boolean;
  isFinally: boolean;

  // Binding evaluation strategy
  isEager: boolean;
  isLazy: boolean;
  isMasked: boolean;

  // Timeout & delay overrides
  timeout?: string;   // e.g. "10s", "2m30s", "0s"
  delay?: string;     // e.g. "500ms", "5s"

  // Assertion mode overrides
  isHard: boolean;
  isSoft: boolean;
  isSustained: boolean;

  // Dry run value override — legacy positional form @DryRun('value')
  dryRunValue?: string;
  /**
   * Named dry-run bindings — form @DryRun(name='var',value='val').
   * Each entry names a scope variable and the value(s) to inject during dry runs.
   * Multiple values cause the step to be exercised once per value.
   * Populated by: @DryRun(name='x',value='v') or @DryRun(name='x',value=['v1','v2'])
   */
  dryRunBindings?: Array<{ name: string; values: string[] }>;

  // Debug
  isBreakpoint: boolean;

  // Parallelism
  isParallel: boolean;

  // String comparison modifiers
  isTrim: boolean;
  isIgnoreCase: boolean;

  // Skip
  isIgnore: boolean;

  // Shadow DOM
  isShadowRoot: boolean;

  // Abstract StepDef — must be overridden in a downstream meta file
  isAbstract: boolean;

  // Data-table orientation overrides (used in conjunction with @DataTable)
  isHorizontalTable: boolean;
  isVerticalTable: boolean;

  // Generated / compiler-synthesised step — surfaced in reports for debugging
  isSynthetic: boolean;

  // Defer step execution until end of scenario (post-Finally ordering)
  isDeferred: boolean;

  // Data-feed conditional execution
  isData: boolean;     // run only when a data feed is bound
  isNoData: boolean;   // run only when NO data feed is bound

  // Output / messaging
  resultsFile?: string;   // @Results('path/to/results.csv')
  message?: string;       // @Message('custom error text')

  // Meta loading
  importPath?: string;    // @Import('path/to/file.meta')

  // Scenario outline external data
  examples?: ExamplesAnnotation;
}

// ─── Known annotation names ───────────────────────────────────────────────────

/**
 * All PascalCase annotation names recognised by pgwen (base name only, without parens or args).
 * Used by MetaEngine to detect typos like @Eagers instead of @Eager.
 */
export const KNOWN_ANNOTATION_NAMES: ReadonlySet<string> = new Set([
  // Role
  'StepDef', 'Context', 'Action', 'Assertion',
  // Data
  'DataTable', 'ForEach', 'Examples',
  // Thread safety
  'Synchronized', 'Synchronised',
  // Lifecycle
  'Try', 'Finally',
  // Binding strategy
  'Eager', 'Lazy', 'Masked',
  // Timing
  'Timeout', 'Delay',
  // Assertion mode
  'Hard', 'Soft', 'Sustained',
  // Dry run
  'DryRun',
  // Debug
  'Breakpoint',
  // Concurrency
  'Parallel',
  // String comparison
  'Trim', 'IgnoreCase',
  // Skip
  'Ignore',
  // DOM
  'ShadowRoot',
  // Abstract
  'Abstract',
  // Output
  'Results', 'Message',
  // Meta loading
  'Import',
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an array of raw Gherkin tag strings into a ParsedAnnotations object.
 *
 * Tag strings may or may not include the leading "@" — both forms are accepted.
 *
 * @example
 *   parseAnnotations(['@StepDef', '@Action', "@Timeout('10s')"])
 *   // → { isStepDef: true, isAction: true, timeout: '10s', ... }
 */
export function parseAnnotations(tags: readonly string[]): ParsedAnnotations {
  const result: ParsedAnnotations = {
    isStepDef: false,
    isContext: false,
    isAction: false,
    isAssertion: false,
    isDataTable: false,
    isForEach: false,
    isSynchronized: false,
    isTry: false,
    isFinally: false,
    isEager: false,
    isLazy: false,
    isMasked: false,
    isHard: false,
    isSoft: false,
    isSustained: false,
    isBreakpoint: false,
    isParallel: false,
    isTrim: false,
    isIgnoreCase: false,
    isIgnore: false,
    isShadowRoot: false,
    isAbstract: false,
    isHorizontalTable: false,
    isVerticalTable: false,
    isSynthetic: false,
    isDeferred: false,
    isData: false,
    isNoData: false,
  };

  for (const rawTag of tags) {
    const tag = rawTag.startsWith('@') ? rawTag.slice(1) : rawTag;
    applyTag(tag, result);
  }

  return result;
}

/**
 * Return true if the tag list contains a given annotation name (case-sensitive).
 */
export function hasAnnotation(tags: readonly string[], name: string): boolean {
  const target = name.startsWith('@') ? name.slice(1) : name;
  return tags.some((t) => {
    const normalized = t.startsWith('@') ? t.slice(1) : t;
    return normalized === target || normalized.startsWith(`${target}(`);
  });
}

// ─── Internal tag dispatch ────────────────────────────────────────────────────

function applyTag(tag: string, result: ParsedAnnotations): void {
  // Simple boolean flags (no arguments)
  switch (tag) {
    case 'StepDef':       result.isStepDef = true;       return;
    case 'Context':       result.isContext = true;        return;
    case 'Action':        result.isAction = true;         return;
    case 'Assertion':     result.isAssertion = true;      return;
    case 'DataTable':     result.isDataTable = true;      return;
    case 'ForEach':       result.isForEach = true;        return;
    case 'Synchronized':
    case 'Synchronised':  result.isSynchronized = true;   return;
    case 'Try':           result.isTry = true;            return;
    case 'Finally':       result.isFinally = true;        return;
    case 'Eager':         result.isEager = true;          return;
    case 'Lazy':          result.isLazy = true;           return;
    case 'Masked':        result.isMasked = true;         return;
    case 'Hard':          result.isHard = true;           return;
    case 'Soft':          result.isSoft = true;           return;
    case 'Sustained':     result.isSustained = true;      return;
    case 'Breakpoint':    result.isBreakpoint = true;     return;
    case 'Parallel':      result.isParallel = true;       return;
    case 'Trim':          result.isTrim = true;           return;
    case 'IgnoreCase':    result.isIgnoreCase = true;     return;
    case 'Ignore':        result.isIgnore = true;         return;
    case 'ShadowRoot':    result.isShadowRoot = true;     return;
    case 'Abstract':         result.isAbstract = true;         return;
    case 'HorizontalTable':  result.isHorizontalTable = true;  return;
    case 'VerticalTable':    result.isVerticalTable = true;    return;
    case 'Synthetic':        result.isSynthetic = true;        return;
    case 'Deferred':         result.isDeferred = true;         return;
    case 'Data':             result.isData = true;             return;
    case 'NoData':           result.isNoData = true;           return;
  }

  // Parameterised annotations
  const paramMatch = /^([A-Za-z]+)\((.+)\)$/.exec(tag);
  if (!paramMatch) return; // unknown or malformed tag — silently skip

  const [, name, rawArgs] = paramMatch as unknown as [string, string, string];

  switch (name) {
    case 'Timeout':
      result.timeout = extractSingleQuotedArg(rawArgs) ?? rawArgs.trim();
      return;

    case 'Delay':
      result.delay = extractSingleQuotedArg(rawArgs) ?? rawArgs.trim();
      return;

    case 'DryRun': {
      const binding = parseDryRunNamedArgs(rawArgs);
      if (binding !== null) {
        result.dryRunBindings = result.dryRunBindings ?? [];
        result.dryRunBindings.push(binding);
      } else {
        // Legacy positional form: @DryRun('value')
        result.dryRunValue = extractSingleQuotedArg(rawArgs) ?? rawArgs.trim();
      }
      return;
    }

    case 'Results':
      result.resultsFile = extractSingleQuotedArg(rawArgs) ?? rawArgs.trim();
      return;

    case 'Message':
      result.message = extractSingleQuotedArg(rawArgs) ?? rawArgs.trim();
      return;

    case 'Import':
      result.importPath = extractSingleQuotedArg(rawArgs) ?? rawArgs.trim();
      return;

    case 'Examples':
      result.examples = parseExamplesArgs(rawArgs);
      return;
  }
}

// ─── Argument parsing helpers ────────────────────────────────────────────────

/**
 * Extract a single-quoted or double-quoted value from a simple argument string.
 * Returns undefined if no quotes are found.
 *
 * @example  extractSingleQuotedArg("'10s'")  → "10s"
 * @example  extractSingleQuotedArg('"hello"') → "hello"
 */
function extractSingleQuotedArg(args: string): string | undefined {
  const t = args.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1);
  }
  return undefined;
}

/**
 * Parse @DryRun named-argument form:
 *   @DryRun(name='varName',value='singleValue')
 *   @DryRun(name='varName',value=['v1','v2','vN'])  — array form
 *   @DryRun(name='varName',value={"v1","v2","vN"})  — brace form ([ and { interchangeable)
 *
 * Returns null if the args don't contain name= (falls back to legacy positional form).
 */
function parseDryRunNamedArgs(rawArgs: string): { name: string; values: string[] } | null {
  const t = rawArgs.trim();

  // Must have name=
  const nameMatch =
    /name\s*=\s*'([^']*)'/.exec(t) ??
    /name\s*=\s*"([^"]*)"/.exec(t);
  if (!nameMatch) return null;

  const name = nameMatch[1]!;

  // Array/brace form: value=['v1','v2'] or value={"v1","v2"}
  const arrayMatch = /value\s*=\s*[\[{]([^\]{}]*)[\]}]/.exec(t);
  if (arrayMatch) {
    const inner = arrayMatch[1]!;
    const values: string[] = [];
    const vPat = /'([^']*)'|"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = vPat.exec(inner)) !== null) {
      values.push(m[1] ?? m[2] ?? '');
    }
    return { name, values };
  }

  // Single value form: value='val' or value="val"
  const valMatch =
    /value\s*=\s*'([^']*)'/.exec(t) ??
    /value\s*=\s*"([^"]*)"/.exec(t);
  if (valMatch) {
    return { name, values: [valMatch[1]!] };
  }

  // name= present but no value= — return empty values
  return { name, values: [] };
}

/**
 * Parse the argument list inside @Examples(...).
 *
 * Supported forms:
 *   'file.csv'
 *   "file.csv"
 *   file='file.csv', where='...', prefix='...', required=true
 *   file="file.csv", where="...", prefix="...", required=true
 */
function parseExamplesArgs(rawArgs: string): ExamplesAnnotation {
  const t = rawArgs.trim();

  // Simple form: just a quoted file path
  const simple = extractSingleQuotedArg(t);
  if (simple !== undefined) {
    return { file: simple };
  }

  // Named-argument form: key='value' or key="value" pairs
  const result: ExamplesAnnotation = { file: '' };
  const kvPattern = /([a-zA-Z]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|(true|false))/g;
  let m: RegExpExecArray | null;

  while ((m = kvPattern.exec(t)) !== null) {
    const key = m[1]!;
    // value comes from single-quote group, double-quote group, or boolean group
    const value = m[2] ?? m[3] ?? m[4] ?? '';

    switch (key) {
      case 'file':     result.file = value;              break;
      case 'where':    result.where = value;             break;
      case 'prefix':   result.prefix = value;            break;
      case 'required': result.required = value === 'true'; break;
    }
  }

  return result;
}
