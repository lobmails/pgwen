/**
 * StepAnnotationParser.ts — Parse inline step annotations from step text.
 *
 * In the reference framework, the body steps of a StepDef can carry inline execution annotations
 * as prefixes (and optionally a trailing @Message suffix):
 *
 *   @Finally I log out of Portal
 *   @Try I click the optional close button
 *   @Soft I assert the total is 0
 *   @Eager @Timeout('5s') I wait for the loader to disappear
 *   @Masked I type my password in the field    @Message('login failed')
 *
 * Multiple leading annotations may appear in any order before the step text.
 * The @Message annotation appears as a trailing suffix separated by whitespace.
 *
 * parseStepInlineAnnotations() strips all annotations and returns the clean
 * step text along with the extracted annotation values. The clean text is
 * what gets passed to the StepDef registry and DSL resolver.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepInlineAnnotations {
  /** Step text with all inline annotation prefixes/suffixes stripped. */
  cleanText: string;
  /** Step should be deferred and run after all other steps (even on failure). */
  isFinally: boolean;
  /** Step errors are swallowed; execution continues. */
  isTry: boolean;
  /** Binding evaluation is forced immediately (eager, not lazy). */
  isEager: boolean;
  /** Binding evaluation is deferred (opposite of eager). */
  isLazy: boolean;
  /** Step text value is masked in logs/reports. */
  isMasked: boolean;
  /** Assertion failure is accumulated and not thrown; execution continues. */
  isSoft: boolean;
  /**
   * Assertion failure is accumulated silently (no step-level indication).
   * Errors are surfaced only via ${pgwen.feature.isSustainedError} in scope.
   */
  isSustained: boolean;
  /**
   * Force immediate failure even when called from a @Soft/@Sustained context.
   * This is the explicit inverse of @Soft — the step fails hard regardless.
   */
  isHard: boolean;
  /**
   * Pause execution at this step and open the REPL with the live scope and page.
   * Only active when pgwen is launched with -d / --debug.
   */
  isBreakpoint: boolean;
  /** Timeout override for this step, e.g. "10s", "2m30s". */
  timeout?: string;
  /** Delay before this step executes, e.g. "2s", "500ms". */
  delay?: string;
  /** Dry-run substitution value for this step — legacy positional form @DryRun('value'). */
  dryRunValue?: string;
  /**
   * Named dry-run binding — the reference framework form @DryRun(name='var',value='val').
   * The variable `dryRunName` is injected into scope with the first of `dryRunValues`
   * BEFORE step interpolation during dry runs, so ${dryRunName} resolves correctly.
   */
  dryRunName?: string;
  /** Values for the named dry-run binding. Multiple values exercise the step once each. */
  dryRunValues?: string[];
  /** Custom failure message override, replacing the default error message. */
  message?: string;
  /**
   * Step MUST resolve to a concrete StepDef. If no StepDef matches the step
   * text, the run fails with a clear "abstract step has no implementation"
   * error instead of falling through to DSL matching. Used to enforce that a
   * caller is invoking a previously-declared abstract operation.
   */
  isAbstract: boolean;
  /**
   * Trim whitespace from both sides of the actual and expected values before
   * comparison. the reference framework step-level annotation: applies to the single decorated
   * step. Mirrors the StepDef-level `@Trim` flag for parity.
   */
  isTrim: boolean;
  /**
   * Compare strings case-insensitively. the reference framework step-level annotation: applies
   * to the single decorated step. Mirrors the StepDef-level `@IgnoreCase`
   * flag for parity.
   */
  isIgnoreCase: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse inline annotations from a step text string.
 *
 * Recognises and strips these leading prefixes:
 *   @Finally   @Try   @Eager   @Masked   @Soft   @Abstract
 *   @Timeout('Xs')   @DryRun('value')
 *
 * And this trailing suffix:
 *   @Message('text')   or   @Message("text")
 *
 * Multiple leading annotations can be stacked in any order:
 *   @Finally @Try I log out  →  cleanText='I log out', isFinally=true, isTry=true
 *
 * Returns a StepInlineAnnotations object with all flags/values and the cleanText.
 *
 * @example
 *   parseStepInlineAnnotations('@Finally I log out of Portal')
 *   // → { cleanText: 'I log out of Portal', isFinally: true, ... }
 *
 * @example
 *   parseStepInlineAnnotations("I submit the form    @Message('submission failed')")
 *   // → { cleanText: 'I submit the form', message: 'submission failed', ... }
 *
 * @example
 *   parseStepInlineAnnotations('@Soft I assert the count is 0')
 *   // → { cleanText: 'I assert the count is 0', isSoft: true, ... }
 */
export function parseStepInlineAnnotations(text: string): StepInlineAnnotations {
  const result: StepInlineAnnotations = {
    cleanText: text,
    isFinally: false,
    isTry: false,
    isEager: false,
    isLazy: false,
    isMasked: false,
    isSoft: false,
    isSustained: false,
    isHard: false,
    isBreakpoint: false,
    isAbstract: false,
    isTrim: false,
    isIgnoreCase: false,
  };

  let remaining = text;

  // Strip trailing @Message first (so it doesn't interfere with leading detection)
  remaining = stripTrailingMessage(remaining, result);

  // Strip leading annotations iteratively (may be stacked)
  remaining = stripLeadingAnnotations(remaining, result);

  result.cleanText = remaining.trim();
  return result;
}

// ─── Valid inline annotation names ───────────────────────────────────────────

/**
 * All recognised inline step-level annotations.
 * Anything else prefixing a step body with @Name<space> or @Name(...) is a typo.
 *
 * Entries split into two groups:
 *   1. Inline annotations that the parser STRIPS from cleanText (Finally,
 *      Try, etc.) — the bulk of this list.
 *   2. DSL-step-prefix annotations that the validator recognises as
 *      legal but does NOT strip (DateTime). Those flow through to the
 *      DSL registry, where step patterns starting with `@DateTime\s+`
 *      handle the reformat.
 */
const VALID_INLINE_ANNOTATIONS = new Set([
  'Finally', 'Try', 'Eager', 'Lazy', 'Masked', 'Soft', 'Sustained', 'Hard',
  'Breakpoint', 'Timeout', 'Delay', 'DryRun', 'Message',
  // Comparison modifiers — the reference framework step-level annotations applied per assertion.
  'Trim', 'IgnoreCase',
  // Passthrough — handled by DSL patterns, not by the strip logic.
  // `@DateTime` and `@Number` both prefix `I format … from … to … as …`
  // steps and are part of the DSL pattern, not stripped annotations.
  'DateTime', 'Number',
]);

/**
 * Return true when the step text begins with any inline annotation prefix.
 * Useful for quick detection without full parsing.
 */
export function hasInlineAnnotation(text: string): boolean {
  // Simple boolean annotations followed by a space
  if (/^@(Finally|Try|Eager|Lazy|Masked|Soft|Sustained|Hard|Breakpoint)\s/i.test(text.trimStart())) return true;
  // Parameterised annotations: @Timeout('...') or @DryRun('...')
  if (/^@(Timeout|Delay|DryRun)\(/i.test(text.trimStart())) return true;
  return false;
}

// ─── DryRun argument parsing ──────────────────────────────────────────────────

/**
 * Parse @DryRun argument string and apply to result.
 *
 * Named form:  name='x',value='v'         → dryRunName='x', dryRunValues=['v']
 * Array form:  name='x',value=['v1','v2'] → dryRunName='x', dryRunValues=['v1','v2']
 * Legacy form: 'value'                    → dryRunValue='value'
 */
function applyDryRunArgs(rawArgs: string, result: StepInlineAnnotations): void {
  const t = rawArgs.trim();

  // Named form requires name=
  const nameMatch =
    /name\s*=\s*'([^']*)'/.exec(t) ??
    /name\s*=\s*"([^"]*)"/.exec(t);

  if (nameMatch) {
    result.dryRunName = nameMatch[1]!;

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
      result.dryRunValues = values;
      return;
    }

    // Single value form: value='val' or value="val"
    const valMatch =
      /value\s*=\s*'([^']*)'/.exec(t) ??
      /value\s*=\s*"([^"]*)"/.exec(t);
    result.dryRunValues = valMatch ? [valMatch[1]!] : [];
    return;
  }

  // Legacy positional form: @DryRun('value') or @DryRun("value")
  const simpleMatch =
    /^'([^']*)'$/.exec(t) ??
    /^"([^"]*)"$/.exec(t);
  result.dryRunValue = simpleMatch ? simpleMatch[1]! : t;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Strip trailing step annotations (@Message, @DryRun) from the end of a step text.
 * Both may appear at the end, separated from the step text by whitespace.
 * Applied iteratively so both can coexist on the same step.
 */
function stripTrailingMessage(text: string, result: StepInlineAnnotations): string {
  let remaining = text;
  let changed = true;
  while (changed) {
    changed = false;

    // @Message('...') or @Message("...")
    const trailingMsg = /\s+@Message\((?:'([^']*)'|"([^"]*)"|`([^`]*)`)\)\s*$/i.exec(remaining);
    if (trailingMsg) {
      result.message = trailingMsg[1] ?? trailingMsg[2] ?? trailingMsg[3] ?? '';
      remaining = remaining.slice(0, trailingMsg.index);
      changed = true;
      continue;
    }

    // Malformed trailing @Message — has parentheses but value is not quoted
    if (/\s+@Message\([^)]*\)\s*$/i.test(remaining)) {
      throw new SyntaxError(
        `@Message annotation value must be surrounded by quotes: @Message('value') or @Message("value")`
      );
    }

    // Trailing @DryRun(...) — the reference framework named form or legacy positional
    const trailingDryRun = /\s+@DryRun\(([^)]+)\)\s*$/i.exec(remaining);
    if (trailingDryRun) {
      applyDryRunArgs(trailingDryRun[1]!, result);
      remaining = remaining.slice(0, trailingDryRun.index);
      changed = true;
      continue;
    }
  }
  return remaining;
}

/**
 * Iteratively strip leading annotation tokens from the step text.
 * Stops when no further recognised annotation prefix is found.
 */
function stripLeadingAnnotations(text: string, result: StepInlineAnnotations): string {
  let remaining = text.trimStart();
  let changed = true;

  while (changed) {
    changed = false;

    // Simple boolean flags — @Annotation<space>
    const simplePairs: [RegExp, keyof StepInlineAnnotations][] = [
      [/^@Finally\s+/i,     'isFinally'],
      [/^@Try\s+/i,         'isTry'],
      [/^@Eager\s+/i,       'isEager'],
      [/^@Lazy\s+/i,        'isLazy'],
      [/^@Masked\s+/i,      'isMasked'],
      [/^@Soft\s+/i,        'isSoft'],
      [/^@Sustained\s+/i,   'isSustained'],
      [/^@Hard\s+/i,        'isHard'],
      [/^@Breakpoint\s+/i,  'isBreakpoint'],
      [/^@Abstract\s+/i,    'isAbstract'],
      [/^@Trim\s+/i,        'isTrim'],
      [/^@IgnoreCase\s+/i,  'isIgnoreCase'],
    ];

    for (const [pattern, flag] of simplePairs) {
      if (pattern.test(remaining)) {
        (result as unknown as Record<string, unknown>)[flag] = true;
        remaining = remaining.replace(pattern, '');
        changed = true;
        break; // restart the outer loop to allow stacking
      }
    }

    if (changed) continue;

    // @Timeout('value') or @Timeout("value") — parameterised
    const timeoutMatch = /^@Timeout\((?:'([^']*)'|"([^"]*)")\)\s*/i.exec(remaining);
    if (timeoutMatch) {
      result.timeout = timeoutMatch[1] ?? timeoutMatch[2] ?? '';
      remaining = remaining.slice(timeoutMatch[0].length);
      changed = true;
      continue;
    }

    // @Delay('value') or @Delay("value") — parameterised
    const delayMatch = /^@Delay\((?:'([^']*)'|"([^"]*)")\)\s*/i.exec(remaining);
    if (delayMatch) {
      result.delay = delayMatch[1] ?? delayMatch[2] ?? '';
      remaining = remaining.slice(delayMatch[0].length);
      changed = true;
      continue;
    }

    // @DryRun(...) — named form @DryRun(name='x',value='v') or legacy @DryRun('value')
    const dryRunMatch = /^@DryRun\(([^)]+)\)\s*/i.exec(remaining);
    if (dryRunMatch) {
      applyDryRunArgs(dryRunMatch[1]!, result);
      remaining = remaining.slice(dryRunMatch[0].length);
      changed = true;
      continue;
    }

    // @Message('value') or @Message("value") as a leading annotation prefix
    const leadingMsgMatch = /^@Message\((?:'([^']*)'|"([^"]*)"|`([^`]*)`)\)\s*/i.exec(remaining);
    if (leadingMsgMatch) {
      result.message = leadingMsgMatch[1] ?? leadingMsgMatch[2] ?? leadingMsgMatch[3] ?? '';
      remaining = remaining.slice(leadingMsgMatch[0].length);
      changed = true;
      continue;
    }

    // Malformed leading @Message — has parentheses but value is not quoted
    if (/^@Message\([^)]*\)\s*/i.test(remaining)) {
      throw new SyntaxError(
        `@Message annotation value must be surrounded by quotes: @Message('value') or @Message("value")`
      );
    }

    // Unknown annotation — looks like @Xxx<space> or @Xxx( but is not a recognised annotation name
    const unknownMatch = /^@([A-Za-z]+)(?:\s+|\()/.exec(remaining);
    if (unknownMatch) {
      const name = unknownMatch[1]!;
      // Check if it is a known annotation (case-insensitive)
      const isKnown = [...VALID_INLINE_ANNOTATIONS].some(
        (v) => v.toLowerCase() === name.toLowerCase()
      );
      if (!isKnown) {
        throw new SyntaxError(
          `Invalid step annotation @${name}. Valid step level annotations include:\n` +
          `  Message, Try, Finally, Eager, Lazy, Breakpoint, Hard, Soft, Sustained, DryRun,\n` +
          `  Masked, Timeout, Delay`
        );
      }
    }
  }

  return remaining;
}
