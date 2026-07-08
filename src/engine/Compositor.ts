/**
 * Compositor.ts — Execute step sequences by composing StepDefs and DSL primitives.
 *
 * This is the runtime heart of pgwen. Given a sequence of steps (from a feature
 * scenario or a StepDef body), the Compositor:
 *
 *   1. Resolves the effective keyword for each step (And/But inheritance).
 *   2. Parses inline step annotations (@Finally, @Try, @Soft, @Eager, etc.)
 *      from step text and strips them before registry/DSL lookup.
 *   3. Interpolates ${...} expressions in the step text via StringInterpolator.
 *   4. Looks up the clean step text in StepDefRegistry → if found, recurse into
 *      its body with a new StepDef scope containing param bindings.
 *   5. Falls back to the DSL resolver → call the Playwright-backed handler.
 *   6. If neither matches → UndefinedStepError.
 *
 * Annotation handling:
 *   @Try       — swallow execution errors; step always returns passed
 *   @Finally   — defer step until after all others (even on failure)
 *   @Soft      — assertion failure accumulated in softErrors[]; step returns passed
 *   @Sustained — failure accumulated silently in sustainedErrors[]; step returns passed;
 *                errors are never surfaced automatically — use ${pgwen.feature.isSustainedError}
 *   @Hard      — force immediate failure even if @Soft/@Sustained context is active
 *   @Timeout   — per-step timeout override (inline or on StepDef Gherkin tag)
 *   @Delay     — pause before this step executes
 *   @Message   — replace failure error message with custom text
 */

import * as path from 'path';
import { toPosixPath } from '../util/paths';
import { type ParsedStep } from './GherkinParser';
import {
  StepDefRegistry,
  type StepDef,
  UndefinedStepError,
  resolveEffectiveKeywords,
} from './StepDefRegistry';
import { DslAssertionError } from '../dsl/locatorUtils';
import { Scope } from './Scope';
import { StringInterpolator } from './StringInterpolator';
import {
  parseStepInlineAnnotations,
  type StepInlineAnnotations,
} from './StepAnnotationParser';
import type { ParsedAnnotations } from '../annotations/Annotations';
import type { SyncGate } from '../execution/SyncGate';
import type { ExecutionContext } from './ImplicitValues';
import { evalCondition } from '../dsl/control/conditions';
import { parseCsvFeed, type DataRecord } from '../data/CsvFeedReader';
import { parseJsonFeed } from '../data/JsonFeedReader';
import { classifyFailure, type FailureClassification, type HandlerCategory } from '../diagnose/Classifier';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StepStatus = 'passed' | 'failed' | 'skipped';

/** A single scope binding recorded as an attachment for an executed step. */
export interface BindingAttachment {
  /** The scope binding name (e.g. "capturedPortalUrl"). */
  name: string;
  /** The resolved value, or "*****" for masked bindings. */
  value: string;
  /** True when the binding was declared @Masked — value is always "*****". */
  masked: boolean;
}

/**
 * Data table used to render the @Examples expansion panel in HTML reports.
 * Populated by executeStepDefRows when a StepDef carries an @Examples annotation.
 */
export interface ExamplesData {
  /** Human-readable summary: "StepDef name -- Data file: ..., prefix: ..., where: ..." */
  summaryText: string;
  /** Column names, with prefix applied (e.g. ["account.ID", "account.STATUS"]). */
  header: string[];
  /** One string[] per matching row, parallel to the parent's children array. */
  rows: string[][];
}

export interface StepResult {
  stepText: string;
  effectiveKeyword: string;
  /**
   * The raw Gherkin keyword as written in the file (e.g. "And", "But", "Given").
   * Used by reporters to display the original keyword rather than the effective one.
   * When absent, falls back to effectiveKeyword.
   */
  originalKeyword?: string;
  status: StepStatus;
  error?: Error;
  /** Nested results when the step resolved to a StepDef body. */
  children?: StepResult[];
  /** Execution duration in milliseconds. */
  durationMs?: number;
  /** Source line number from the feature/meta file. */
  line?: number;
  /**
   * True when the step carried @Masked — the step text contains sensitive data
   * and should be redacted in logs/reports (shown as "***").
   */
  masked?: boolean;
  /**
   * New scope bindings created during this step's execution.
   * Populated by the Compositor from a scope diff (before vs after).
   * Excludes pgwen.* implicit values. Used by HtmlReporter to write
   * per-step attachment files and render the "Attachments" dropdown.
   */
  bindings?: BindingAttachment[];
  /**
   * True when the step was abstained (if-guard condition was false and the step
   * was skipped). Matches Passed(abstained=true) concept.
   */
  abstained?: boolean;
  /**
   * Docstring content attached to this step (e.g. JS function body for
   * "is defined by js" docstring form). Used by ConsoleReporter to render
   * the """" ... """" block below the step line, matching output.
   */
  docString?: string;
  /**
   * Inline step annotations that were active on this step (e.g. ['@Eager'], ['@Try']).
   * Stripped from displayText before execution; preserved here so HTML/console reporters
   * can render them as gray labels before the step text — preserves report style.
   */
  stepAnnotations?: string[];
  /**
   * Source location of the StepDef definition that this step resolved to.
   * Format: "path/to/file.meta:lineNumber". Set on the top-level StepResult
   * (not on body children). Shown in the StepDef expansion panel header.
   */
  metaSource?: string;
  /**
   * Annotation labels for the StepDef definition (e.g. ['@StepDef', '@Context']).
   * Derived from the StepDef's parsed Gherkin tags. Shown in the StepDef panel header.
   */
  annotations?: string[];
  /**
   * Populated when this StepResult was produced by an @Examples-annotated StepDef.
   * Carries the full data table (header + all matching rows) so the HTML reporter
   * can render the Examples expansion panel with the scrollable data table.
   * The children array holds one entry per matching row (each with isExamplesIteration=true).
   */
  examplesData?: ExamplesData;
  /**
   * True when this StepResult represents a single @Examples row iteration.
   * Set on the direct children of a result that has examplesData.
   */
  isExamplesIteration?: boolean;
  /** 1-based row index within the @Examples iteration (for "Scenario [N of M]" label). */
  rowIndex?: number;
  /** Total number of matching rows in the @Examples iteration. */
  totalRows?: number;
  /** Captured parameter name→value pairs when this step resolved to a parameterized StepDef. */
  params?: Record<string, string>;
  /**
   * Rule-based failure classification (see src/diagnose/Classifier.ts).
   * Populated only when `status === 'failed'` and a classification was produced.
   * Strictly additive — never affects pass/fail outcome or behaviour.
   */
  failureClass?: FailureClassification;
  /**
   * True when this step was demoted from failed→passed by @Sustained (or by
   * pgwen.assertion.mode=sustained). Reporters use this to render the step
   * in a passed context but show the accumulated assertion error inline
   * (yellow "Sustained" label + red error message in console; yellow badge
   * + red panel-danger block inside the green step in HTML).
   * When true, `error` is preserved so reporters can display the message.
   */
  sustained?: boolean;
}

/**
 * A DSL handler. The `page` parameter is typed `unknown` here so the engine
 * layer has no compile-time dependency on Playwright types.
 * The DSL layer casts as needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DslHandler = (stepText: string, page: any) => Promise<void>;
export type DslResolver = (stepText: string) => DslHandler | undefined;

export interface CompositorOptions {
  /** If true, execution continues after a step failure (used by @Soft). Default: false. */
  continueOnFailure?: boolean;
  /** Maximum recursion depth before throwing a cycle detection error. Default: 50. */
  maxDepth?: number;
  /**
   * Shared async mutex — when provided, @Synchronized StepDefs acquire the gate
   * before executing so that only one synchronized StepDef runs at a time across
   * all concurrent feature runs.
   */
  syncGate?: SyncGate;
  /**
   * Called just before a @Breakpoint StepDef executes.
   * Typically opens an interactive REPL in headed mode.
   * If absent, @Breakpoint is silently ignored.
   */
  breakpointHandler?: (scope: Scope, page: unknown, stepText: string) => Promise<void>;
  /**
   * When true, steps annotated with @DryRun('value') are substituted: the value
   * is bound to scope using the interpolated step text as the key and the step
   * returns passed without invoking the DSL handler or StepDef.
   * Steps without a @DryRun annotation execute normally.
   * Preserves dry-run substitution behaviour.
   */
  dryRun?: boolean;
  /**
   * Global assertion mode — mirrors pgwen.assertion.mode from config.
   * Applies when no per-step @Soft / @Sustained / @Hard annotation is present.
   * 'soft'      — failures accumulate in softErrors[]; step reports passed; all reported at end
   * 'sustained' — failures accumulate in sustainedErrors[]; step reports passed; never auto-surfaced
   * 'hard'      — first failure stops execution (default if absent)
   * Per-step annotations always override this global mode.
   */
  assertionMode?: 'hard' | 'soft' | 'sustained';
  /**
   * Execution context reference — when provided, the Compositor updates
   * ctx.step before each step so that ${pgwen.step.name} and ${pgwen.step.keyword}
   * resolve to the current step's text and keyword.
   */
  ctx?: ExecutionContext;
  /**
   * Named results reporter callbacks, keyed by the name given in `@Results('name')`.
   * When a StepDef carries `@Results('name')` and a matching callback is found here,
   * it is called after the StepDef executes (unless in dryRun mode).
   * Use ResultsReporter.namedFromConfig() to build these from pgwen.conf.
   */
  namedResultsReporters?: ReadonlyMap<string, (scope: Scope, status: 'Passed' | 'Failed') => void>;
  /**
   * Path to the feature file being executed.
   * When provided, UndefinedStepError messages include [at file:line] location info
   * so project authors can pinpoint the undefined step quickly.
   */
  featureFile?: string;
  /**
   * Maximum number of attempts for a failing assertion step before it is marked failed.
   * Mirrors pgwen.web.assertions.maxStrikes: 'auto' = 3, 'infinity' = unlimited, number = literal.
   * Default: 1 (no retry). Only DslAssertionError triggers a retry; other errors fail immediately.
   */
  maxStrikes?: number;
  /**
   * Milliseconds to wait between assertion retry attempts.
   * Mirrors pgwen.web.assertions.delayMillisecs. Default: 200.
   */
  assertionDelayMs?: number;
  /**
   * Optional lookup that returns the DSL handler category for a given step text,
   * used by the rule-based failure classifier when a step fails. When absent,
   * the classifier still runs but without a `handlerCategory` signal — falling
   * back to error-class-based detection only. See `src/diagnose/Classifier.ts`.
   */
  dslCategoryFor?: (stepText: string) => HandlerCategory | undefined;
}

// ─── Compositor ───────────────────────────────────────────────────────────────

export class Compositor {
  private readonly maxDepth: number;

  /**
   * Errors accumulated from @Soft assertion steps during execution.
   * Runner checks this after executeSteps() to surface soft failures in the
   * final scenario result — if any exist, the scenario is marked failed.
   */
  readonly softErrors: Error[] = [];

  /**
   * Errors accumulated from @Sustained steps during execution.
   * These are NEVER automatically surfaced as failures. Project authors must
   * explicitly check ${pgwen.feature.isSustainedError} in an assertion step.
   * Runner binds this flag to scope after executeSteps() completes.
   */
  readonly sustainedErrors: Error[] = [];

  private readonly maxStrikes: number;
  private readonly assertionDelayMs: number;

  constructor(
    private readonly registry: StepDefRegistry,
    private readonly scope: Scope,
    private readonly interpolator: StringInterpolator,
    private readonly dslResolver: DslResolver = () => undefined,
    private readonly options: CompositorOptions = {}
  ) {
    this.maxDepth = options.maxDepth ?? 50;
    this.maxStrikes = options.maxStrikes ?? 1;
    this.assertionDelayMs = options.assertionDelayMs ?? 200;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Execute a substep invoked from a DSL handler (for-each / while / until
   * loop bodies). Tries StepDef first, then DSL — matching the resolution
   * order of `executeOneStep` for normal scenario steps.
   *
   * Throws "No matching stepdef" so the dslResolver's runner can fall back
   * to DSL pattern matching when this substep isn't a StepDef.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async runSubStep(stepText: string, page: any): Promise<void> {
    const interpolated = await this.interpolator.interpolateAsync(stepText);
    const resolved = this.registry.resolve(interpolated);
    if (resolved) {
      const result = await this.executeStepDef(
        resolved.stepDef, resolved.params, interpolated, 'Given', page, 0,
      );
      if (result.status === 'failed') {
        throw result.error ?? new Error(`Substep failed: ${stepText}`);
      }
      return;
    }
    throw new Error(`No matching stepdef: "${stepText}"`);
  }

  /**
   * Execute a sequence of steps (a full scenario or StepDef body).
   * Returns one StepResult per input step.
   */
  async executeSteps(
    steps: ParsedStep[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: any = null,
    depth = 0,
    continueOnFailure?: boolean
  ): Promise<StepResult[]> {
    if (depth > this.maxDepth) {
      throw new CompositorError(
        `StepDef recursion depth exceeded ${this.maxDepth}. ` +
        `Possible infinite loop in meta composition.`
      );
    }

    const effectiveKeywords = resolveEffectiveKeywords(steps);
    const results: StepResult[] = [];
    let failed = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const effectiveKeyword = effectiveKeywords[i]!;

      // Parse inline annotations from step text
      const inline = parseStepInlineAnnotations(step.text);
      const cleanStep: ParsedStep = { ...step, text: inline.cleanText };

      // Detect @Finally:
      //   (a) inline annotation in step text: @Finally I log out
      //   (b) the resolved StepDef itself has @Finally in its Gherkin tags
      // @Finally steps always run even when a prior step has failed — they are
      // never skipped. Steps run in their exact source order (no reordering).
      const isFinally = inline.isFinally || this.resolveIsFinally(inline.cleanText);

      if (failed && !this.options.continueOnFailure && !continueOnFailure && !this.options.dryRun && !isFinally) {
        const rawKw = cleanStep.keyword.trim();
        results.push({ stepText: step.text, effectiveKeyword, originalKeyword: rawKw, status: 'skipped', durationMs: 0, line: step.line });
        continue;
      }

      const result = await this.executeOneStep(cleanStep, effectiveKeyword, page, depth, inline);
      results.push(result);

      if (result.status === 'failed') {
        failed = true;
      }
    }

    return results;
  }

  /**
   * Execute a single step by text + effective keyword.
   * Accepts optional pre-parsed inline annotations (from executeSteps loop).
   * If inline is not provided, re-parses from step.text.
   */
  async executeOneStep(
    step: ParsedStep,
    effectiveKeyword: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: any = null,
    depth = 0,
    inline?: StepInlineAnnotations
  ): Promise<StepResult> {
    // If the caller didn't pre-parse, do it now (ensures clean text is used)
    let annotations = inline ?? parseStepInlineAnnotations(step.text);
    // Extract inline if-guard BEFORE anything else so that action DSL patterns
    // (e.g. "I click (.+)") never see the guard suffix.
    const ifGuard = parseIfGuard(annotations.cleanText);
    let cleanText = ifGuard ? ifGuard.step : annotations.cleanText;

    // "I assert that <step>" prefix — soft-assert wrapper. Strips the
    // prefix and forces @Soft semantics so the inner step's failure is
    // accumulated (visible at the end via `there should be no accumulated
    // errors`) instead of halting the scenario. The inner step is then
    // resolved exactly as if it had been written without the prefix.
    const assertThatMatch = /^I assert that (.+)$/i.exec(cleanText);
    if (assertThatMatch) {
      cleanText = assertThatMatch[1]!.trim();
      annotations = { ...annotations, isSoft: true };
    }

    const stepStart = Date.now();

    // Update execution context so ${pgwen.step.name} and ${pgwen.step.keyword} resolve.
    if (this.options.ctx) {
      this.options.ctx.step = { text: cleanText, keyword: effectiveKeyword };
    }

    // Begin capturing all scope writes for this step (including recursive StepDef writes).
    this.scope.startCapture();

    const withTiming = (result: StepResult): StepResult => {
      const captured = this.scope.stopCapture();
      const bindings: BindingAttachment[] | undefined =
        captured.length > 0 ? captured : undefined;

      const rawKw = step.keyword.trim();

      // Rule-based failure classification — strictly additive: only attach
      // when a child hasn't already classified this failure (preserve nested
      // detail) and when status === 'failed' with an error to classify.
      let failureClass: FailureClassification | undefined = result.failureClass;
      if (failureClass === undefined && result.status === 'failed' && result.error) {
        const stepTextForClassify = result.stepText ?? cleanText;
        const handlerCategory = this.options.dslCategoryFor?.(stepTextForClassify);
        failureClass = classifyFailure({
          stepText: stepTextForClassify,
          errorClass: result.error.constructor?.name ?? 'Error',
          errorMessage: result.error.message ?? '',
          ...(handlerCategory !== undefined ? { handlerCategory } : {}),
        });
      }

      return {
        ...result,
        durationMs: Date.now() - stepStart,
        line: step.line,
        originalKeyword: rawKw,
        // Propagate @Masked flag so reporters can redact sensitive step text
        ...(annotations.isMasked ? { masked: true } : {}),
        ...(bindings ? { bindings } : {}),
        // Propagate docString so ConsoleReporter can render """" blocks
        ...(step.docString !== undefined ? { docString: step.docString } : {}),
        // Propagate stripped inline annotations so HTML reporter can render gray labels
        ...(() => { const a = collectAnnotationLabels(annotations); return a.length > 0 ? { stepAnnotations: a } : {}; })(),
        ...(failureClass !== undefined ? { failureClass } : {}),
      };
    };

    /**
     * Apply @Message override: replace the failure error message with the
     * custom text specified by the project author. The original error is preserved
     * as `cause` for diagnostic purposes.
     */
    const withMessage = (result: StepResult): StepResult => {
      if (result.status === 'failed' && result.error && annotations.message) {
        // Interpolate ${var} references against the current scope, masking
        // :masked settings. Fall back to the raw text if interpolation throws
        // (e.g. unresolved placeholder) so a malformed @Message never hides
        // the underlying step failure.
        let messageText: string;
        try {
          messageText = this.interpolator.interpolateForDisplay(annotations.message);
        } catch {
          messageText = annotations.message;
        }
        const overridden = new Error(messageText);
        (overridden as Error & { cause?: unknown }).cause = result.error;
        return { ...result, error: overridden };
      }
      return result;
    };

    // @Delay — pause before executing this step
    if (annotations.delay) {
      await sleep(parseDurationMs(annotations.delay));
    }

    // @DryRun named form — inject name=value into scope BEFORE interpolation so
    // ${name} resolves correctly in the step text.  This preserves behaviour:
    // the step still executes; DryRun only seeds the scope variable.
    // Multi-value: each call cycles to the next value using a per-name counter in scope.
    if (annotations.dryRunName !== undefined && annotations.dryRunValues && annotations.dryRunValues.length > 0) {
      const idxKey = `pgwen._dryrun_idx_${annotations.dryRunName}`;
      const currentIdx = parseInt(this.scope.get(idxKey) ?? '0', 10);
      const injectedValue = annotations.dryRunValues[currentIdx % annotations.dryRunValues.length] ?? '';
      this.scope.set(annotations.dryRunName, injectedValue);
      this.scope.set(idxKey, String(currentIdx + 1));
    }

    let interpolated: string;
    // displayText is identical to interpolated EXCEPT masked settings show as '*****'.
    // Used for stepText in StepResult so reports never expose real secrets.
    let displayText: string;
    // If interpolation fails AND this step has an if-guard, the failure is
    // deferred until after the guard is evaluated. A step that references
    // bindings only set on one branch (e.g.
    //   I type "${the iso expiry date}" in <field> if the process contains "add"
    // ) interpolates `${the iso expiry date}` even on the remove iteration
    // where the binding doesn't exist. Without the deferred-failure path the
    // run reports "Undefined binding" before the guard skips the step.
    let deferredInterpolationError: Error | null = null;
    try {
      // Async interpolation awaits lazy resolvers (e.g. `is defined by js`
      // bindings) so the values they produce can flow into surrounding step
      // text — without it, scope.get() throws "async lazy resolver" when a
      // step references such a binding via ${...}.
      interpolated = await this.interpolator.interpolateAsync(cleanText);
      displayText = await this.interpolator.interpolateForDisplayAsync(cleanText);
    } catch (err) {
      if (ifGuard && !this.options.dryRun) {
        deferredInterpolationError = err instanceof Error ? err : new Error(String(err));
        interpolated = cleanText;
        displayText = cleanText;
      } else {
        return withTiming(withMessage({
          stepText: cleanText,
          effectiveKeyword,
          status: 'failed',
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      }
    }

    // Dryrun condition validation: check that all if-guard condition bindings exist.
    // surfaces "Unbound reference" errors for if-guard conditions during dryrun
    // even though the conditions aren't used for control flow — mirrors that behaviour.
    if (ifGuard && this.options.dryRun) {
      for (const rawCond of ifGuard.conditions) {
        let condText: string;
        try { condText = await this.interpolator.interpolateAsync(rawCond); } catch { condText = rawCond; }
        try {
          validateConditionRef(condText, this.scope);
        } catch (condErr) {
          return withTiming(withMessage({
            stepText: displayText,
            effectiveKeyword,
            status: 'failed',
            error: condErr instanceof Error ? condErr : new Error(String(condErr)),
          }));
        }
      }
    }

    // Inline if-guard: evaluate conditions right-to-left (innermost/rightmost first).
    // The guard was stripped from cleanText before interpolation, so `interpolated` is the
    // bare step text. Each condition is interpolated and evaluated in order; if any
    // is false, the step is silently skipped (treated as passed).
    if (ifGuard && !this.options.dryRun) {
      for (const rawCond of ifGuard.conditions) {
        let condText: string;
        try { condText = await this.interpolator.interpolateAsync(rawCond); } catch { condText = rawCond; }
        const met = await evalCondition(condText, this.scope, page);
        if (!met) {
          if (ifGuard.alt) {
            // Run the alternative step through the full execution pipeline
            const altStep: typeof step = { ...step, text: ifGuard.alt, keyword: step.keyword };
            return withTiming(await this.executeOneStep(altStep, effectiveKeyword, page, depth));
          }
          // Condition false and no alt → abstained (passed-with-abstained).
          // Any deferred interpolation failure is intentionally dropped here:
          // the step is being skipped, so its body's `${...}` refs never
          // needed to resolve.
          return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed', abstained: true });
        }
      }
      // All conditions met → fall through to normal DSL resolution using stripped `interpolated`.
      // If the step had a deferred interpolation failure (because the guard
      // was evaluated lazily), it must surface now: the step is going to
      // run, and its body still has unresolved references.
      if (deferredInterpolationError) {
        return withTiming(withMessage({
          stepText: cleanText,
          effectiveKeyword,
          status: 'failed',
          error: deferredInterpolationError,
        }));
      }
    }

    // @DryRun legacy positional form — inject a mock value into scope and return passed.
    // The binding key is the ATTRIBUTE portion of the step text (everything before the
    // first DSL keyword like "should", "is", "can", "will", etc.) rather than the full
    // step text, so the Attachments dropdown shows a meaningful variable name.
    // Kept for backward compat. the named form is always preferred.
    if (this.options.dryRun && annotations.dryRunValue !== undefined && annotations.dryRunName === undefined) {
      const bindingKey = extractAttributeFromStep(interpolated);
      this.scope.set(bindingKey, annotations.dryRunValue);
      return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
    }

    // @Breakpoint inline — pause before executing this step (StepDef or DSL).
    // This fires when the step invocation itself carries @Breakpoint.
    // The StepDef-level @Breakpoint (on the definition) is checked separately below.
    if (annotations.isBreakpoint && this.options.breakpointHandler) {
      try {
        await this.options.breakpointHandler(this.scope, page, displayText);
      } catch {
        // Errors from the breakpoint handler are non-fatal
      }
    }

    // 1. Try StepDef registry
    // Docstring-as-param: if the step has a docstring and normal resolution fails, try
    // a secondary resolution where the last template param is filled from the docstring.
    let resolved = this.registry.resolve(interpolated);
    let docstringUsedAsParam = false;
    if (!resolved && step.docString !== undefined) {
      const interpolatedDocString = await this.interpolator.interpolateAsync(step.docString);
      const docStringResolved = this.registry.resolveWithDocstring(interpolated, interpolatedDocString);
      if (docStringResolved) {
        resolved = docStringResolved;
        docstringUsedAsParam = true;
      }
    }
    if (resolved) {
      // Enforce behaviour rules before executing.
      // depth > 0 means we are inside a StepDef body — rules are NOT checked there
      // because the constraint was already satisfied at the direct call-site and
      // body-step keywords are purely documentary (Standard behaviour: body steps may use
      // any keyword without triggering @Context/@Action/@Assertion errors).
      if (depth === 0) {
        try {
          this.registry.enforceRules(resolved, effectiveKeyword);
        } catch (err) {
          return withTiming(withMessage({
            stepText: displayText,
            effectiveKeyword,
            status: 'failed',
            error: err instanceof Error ? err : new Error(String(err)),
          }));
        }
      }

      // @Abstract — the StepDef has no body; it must be overridden in a downstream meta.
      // If it is reached without an override (i.e., resolved.stepDef.steps is empty and
      // isAbstract is set), throw a descriptive error.
      if (resolved.stepDef.annotations.isAbstract && resolved.stepDef.steps.length === 0) {
        const err = new Error(
          `Abstract StepDef invoked without a concrete implementation: "${resolved.stepDef.name}". ` +
          `Provide a concrete @StepDef with the same name in a downstream meta file.`
        );
        return withTiming({ stepText: displayText, effectiveKeyword, status: 'failed', error: err });
      }

      // @Breakpoint — pause before executing the StepDef (opens REPL in headed mode)
      if (resolved.stepDef.annotations.isBreakpoint && this.options.breakpointHandler) {
        try {
          await this.options.breakpointHandler(this.scope, page, displayText);
        } catch {
          // Errors from the breakpoint handler are non-fatal
        }
      }

      // Build a factory to run the StepDef (with optional inline @Timeout wrapper)
      // Pass displayText (not interpolated) so masked values show as ***** in the caller text.
      const runStepDef = (): Promise<StepResult> => this.executeStepDef(
        resolved.stepDef, resolved.params, displayText, effectiveKeyword, page, depth + 1
      );

      // @Try inline: wrap StepDef execution and swallow errors
      if (annotations.isTry) {
        try {
          const r = annotations.timeout
            ? await withTimeout(runStepDef, parseDurationMs(annotations.timeout), interpolated)
            : await runStepDef();
          return withTiming({ ...r, status: 'passed' });
        } catch {
          return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
        }
      }

      let result: StepResult;
      try {
        result = annotations.timeout
          ? await withTimeout(runStepDef, parseDurationMs(annotations.timeout), interpolated)
          : await runStepDef();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // In dry-run mode, swallow browser/Playwright errors (no browser is running).
        // But data/logic errors (Unbound reference, assertion failures) must still surface.
        if (this.options.dryRun && !isDataError(err)) {
          return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
        }
        // Timeout or unexpected throw during StepDef execution
        return withTiming(withMessage({ stepText: displayText, effectiveKeyword, status: 'failed', error }));
      }

      if (result.status === 'failed') {
        // @Hard explicitly forces immediate failure — overrides any soft mode
        if (annotations.isHard) {
          return withTiming(withMessage(result));
        }
        // @Sustained: accumulate silently; step appears as passed.
        // Apply @Message override so the accumulated error carries the custom text.
        // The step keeps its error and is marked `sustained: true` so reporters
        // can render it in a passed context with the assertion message inline.
        if (annotations.isSustained) {
          const sustainedErr = result.error ? (withMessage(result).error ?? result.error) : undefined;
          if (sustainedErr) this.sustainedErrors.push(sustainedErr);
          return withTiming({ ...result, status: 'passed', sustained: true, ...(sustainedErr ? { error: sustainedErr } : {}) });
        }
        // @Soft: accumulate and report passed.
        // Apply @Message override so the accumulated error carries the custom text.
        if (annotations.isSoft) {
          if (result.error) this.softErrors.push(withMessage(result).error ?? result.error);
          return withTiming({ ...result, status: 'passed' });
        }
        // Global assertion mode (pgwen.assertion.mode) — applies when no per-step override set
        if (this.options.assertionMode === 'sustained') {
          const sustainedErr = result.error ? (withMessage(result).error ?? result.error) : undefined;
          if (sustainedErr) this.sustainedErrors.push(sustainedErr);
          return withTiming({ ...result, status: 'passed', sustained: true, ...(sustainedErr ? { error: sustainedErr } : {}) });
        }
        if (this.options.assertionMode === 'soft') {
          if (result.error) this.softErrors.push(withMessage(result).error ?? result.error);
          return withTiming({ ...result, status: 'passed' });
        }
      }

      return withTiming(withMessage(result));
    }

    // 1a. @Abstract enforcement — step-level annotation that asserts the step
    //     MUST resolve to a concrete StepDef. If no StepDef matched above
    //     (resolved is null) and @Abstract is set, fail loudly here instead of
    //     falling through to DSL matching. This catches typos and unbound
    //     abstract operations at the call site.
    if (annotations.isAbstract && !resolved) {
      const err = new Error(
        `Abstract step has no concrete StepDef implementation: "${interpolated}". ` +
        `Define a @StepDef with a matching name in a meta file, or remove the @Abstract annotation.`
      );
      return withTiming({ stepText: displayText, effectiveKeyword, status: 'failed', error: err });
    }

    // 1b. Special: "I log record to <id> file" — trigger named results reporter inline.
    //     This is a engine-level step (not a DSL step) that calls the named
    //     results reporter for the given file ID, writing current scope to the CSV.
    {
      const logMatch = /^I log record to (.+?) file$/i.exec(interpolated);
      if (logMatch) {
        const reporterId = logMatch[1]!.trim();
        if (!this.options.dryRun && this.options.namedResultsReporters) {
          const cb = this.options.namedResultsReporters.get(reporterId);
          if (cb) {
            const status = this.options.ctx?.scenario?.status === 'Failed' ? 'Failed' : 'Passed';
            cb(this.scope, status);
          }
        }
        return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
      }
    }

    // 2. Try DSL handler
    const dslHandler = this.dslResolver(interpolated);
    if (dslHandler) {
      // Make doc string available to handlers that need it (e.g. multi-line system process commands).
      // Set before calling the handler; cleared in finally to avoid bleeding into subsequent steps.
      const hadDocString = step.docString !== undefined;
      if (hadDocString) {
        // Interpolate ${...} tokens in the doc string so that scope bindings and config
        // values (e.g. ${pgwen.feature.eval.status.keyword.upperCased}) are resolved before
        // the handler passes the command to execSync — otherwise the shell rejects them.
        const interpolatedDocString = await this.interpolator.interpolateAsync(step.docString!);
        this.scope.set('pgwen._step_docstring', interpolatedDocString);
      }

      // Make data table available to handlers that need it (e.g. multi-row
      // locator binding). Stored as JSON so the typed string[][] survives the
      // string-only scope. Handlers read via scope.get('pgwen._step_datatable').
      const hadDataTable = step.dataTable !== undefined && step.dataTable.length > 0;
      if (hadDataTable) {
        this.scope.set('pgwen._step_datatable', JSON.stringify(step.dataTable));
      }

      // @Eager — snapshot lazy resolver refs before execution.
      // After the handler, any key whose resolver reference changed (new binding OR
      // re-bound by the same step) is force-evaluated and replaced with a literal.
      const lazyBefore = annotations.isEager
        ? this.scope.lazyResolversInNonStepdefFrame()
        : undefined;

      // @Lazy — snapshot lazy resolver refs before execution.
      // After the handler, any newly-created lazy resolver is wrapped with a
      // cache-on-first-call layer so the value is computed once at the first
      // reference and then frozen as a literal — matching @Lazy semantics.
      const lazyResolveBefore = annotations.isLazy
        ? this.scope.lazyResolversInNonStepdefFrame()
        : undefined;

      // Inline @Trim / @IgnoreCase — step-level annotations. Apply by
      // temporarily turning the scope flags on for the duration of this step
      // so assertion helpers (text / url / dropdown / file etc.) pick them
      // up via the same `pgwen._trim` / `pgwen._ignoreCase` read they use
      // for the StepDef-level form. Restored after the handler returns —
      // even on throw — so the flags don't leak to sibling steps.
      const trimBefore = this.scope.get('pgwen._trim');
      const ignoreCaseBefore = this.scope.get('pgwen._ignoreCase');
      if (annotations.isTrim)       this.scope.set('pgwen._trim', 'true');
      if (annotations.isIgnoreCase) this.scope.set('pgwen._ignoreCase', 'true');
      const restoreCompareFlags = (): void => {
        if (annotations.isTrim) {
          if (trimBefore === undefined) this.scope.clearKey('pgwen._trim');
          else this.scope.set('pgwen._trim', trimBefore);
        }
        if (annotations.isIgnoreCase) {
          if (ignoreCaseBefore === undefined) this.scope.clearKey('pgwen._ignoreCase');
          else this.scope.set('pgwen._ignoreCase', ignoreCaseBefore);
        }
      };

      try {
        // maxStrikes retry loop — retries only on DslAssertionError; other errors fail immediately.
        for (let strike = 0; strike < this.maxStrikes; strike++) {
          try {
            if (annotations.timeout) {
              await withTimeout(
                () => dslHandler(interpolated, page),
                parseDurationMs(annotations.timeout),
                interpolated
              );
            } else {
              await dslHandler(interpolated, page);
            }
            break; // step passed — exit retry loop
          } catch (retryErr) {
            const retryError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
            if (retryError instanceof DslAssertionError && strike < this.maxStrikes - 1) {
              if (this.assertionDelayMs > 0) {
                await new Promise<void>(r => setTimeout(r, this.assertionDelayMs));
              }
              continue;
            }
            throw retryErr; // non-assertion error or last strike — propagate to outer catch
          }
        }
        restoreCompareFlags();

        // @Eager — force-evaluate lazy bindings created or re-bound by this step.
        // Uses setTransparent so the literal lands in the enclosing non-stepdef frame
        // (feature/scenario) and survives scope.pop() when inside a StepDef body.
        if (lazyBefore) {
          for (const [key, resolver] of this.scope.lazyResolversInNonStepdefFrame()) {
            if (lazyBefore.get(key) !== resolver) { // new binding or updated resolver
              const val = await this.scope.resolveAsync(key);
              this.scope.setTransparent(key, val ?? '');
            }
          }
        }

        // @Lazy — wrap newly-created lazy resolvers with cache-on-first-call.
        // First reference resolves the value and replaces the resolver with a
        // literal so subsequent references return the frozen first-resolved value.
        // Matches @Lazy semantics ("retain the first-evaluated value").
        if (lazyResolveBefore) {
          const scope = this.scope;
          for (const [key, resolver] of scope.lazyResolversInNonStepdefFrame()) {
            if (lazyResolveBefore.get(key) !== resolver) {
              const masked = scope.isMasked(key);
              const wrapped = async (): Promise<string> => {
                const result = await resolver();
                const literal = result == null ? '' : String(result);
                // Self-replace with a literal so the next read skips the resolver.
                scope.setTransparent(key, literal, { masked });
                return literal;
              };
              scope.setLazyTransparent(key, wrapped, { masked });
            }
          }
        }

        return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
      } catch (err) {
        restoreCompareFlags();
        const error = err instanceof Error ? err : new Error(String(err));

        // In dry-run mode, swallow browser/Playwright errors (no browser is running).
        // But data/logic errors (Unbound reference, assertion failures) must still surface.
        if (this.options.dryRun && !isDataError(error)) {
          return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
        }

        // @Hard: force immediate failure regardless of any soft context
        if (!annotations.isHard) {
          // @Sustained: accumulate silently; step appears as passed.
          // Apply @Message override so the accumulated error carries the custom text.
          // Reporters read `sustained` + `error` to render the yellow label + red
          // assertion line while keeping the step in a passed context.
          if (annotations.isSustained) {
            const msgResult = withMessage({ stepText: displayText, effectiveKeyword, status: 'failed', error });
            const sustainedErr = msgResult.error ?? error;
            this.sustainedErrors.push(sustainedErr);
            return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed', sustained: true, error: sustainedErr });
          }
          // @Soft: accumulate and report passed.
          // Apply @Message override so the accumulated error carries the custom text.
          if (annotations.isSoft) {
            const msgResult = withMessage({ stepText: displayText, effectiveKeyword, status: 'failed', error });
            this.softErrors.push(msgResult.error ?? error);
            return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
          }
          // @Try: swallow failure
          if (annotations.isTry) {
            return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
          }
          // Global assertion mode (pgwen.assertion.mode) — applies when no per-step override set
          if (this.options.assertionMode === 'sustained') {
            const msgResult = withMessage({ stepText: displayText, effectiveKeyword, status: 'failed', error });
            const sustainedErr = msgResult.error ?? error;
            this.sustainedErrors.push(sustainedErr);
            return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed', sustained: true, error: sustainedErr });
          }
          if (this.options.assertionMode === 'soft') {
            const msgResult = withMessage({ stepText: displayText, effectiveKeyword, status: 'failed', error });
            this.softErrors.push(msgResult.error ?? error);
            return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
          }
        }

        return withTiming(withMessage({ stepText: displayText, effectiveKeyword, status: 'failed', error }));
      } finally {
        // Clear the doc string scope key after handler completes (pass or fail).
        if (hadDocString) {
          this.scope.set('pgwen._step_docstring', '');
        }
        if (hadDataTable) {
          this.scope.set('pgwen._step_datatable', '');
        }
      }
    }

    // 3. Neither found
    if (annotations.isTry) {
      return withTiming({ stepText: displayText, effectiveKeyword, status: 'passed' });
    }

    // Prefer the step's own sourceFile (set by GherkinParser per parsed
    // step) so substeps in a StepDef body report the .meta file they
    // live in, not the outer feature file. Falls back to the compositor's
    // featureFile option for callers that build ParsedStep literals
    // (older tests) without setting sourceFile per-step.
    const rawSourceFile = step.sourceFile ?? this.options.featureFile;
    const sourceFileForError = rawSourceFile !== undefined
      ? toPosixPath(path.isAbsolute(rawSourceFile) ? path.relative(process.cwd(), rawSourceFile) : rawSourceFile)
      : undefined;
    const undefinedLocation =
      sourceFileForError && step.line !== undefined
        ? `${sourceFileForError}:${step.line}`
        : undefined;

    return withTiming(withMessage({
      stepText: displayText,
      effectiveKeyword,
      status: 'failed',
      error: new UndefinedStepError(interpolated, undefinedLocation),
    }));
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Resolve the clean step text against the registry and check if the matched
   * StepDef has @Finally in its Gherkin-level annotations.
   */
  private resolveIsFinally(cleanText: string): boolean {
    try {
      const interpolated = this.interpolator.interpolate(cleanText);
      return !!this.registry.resolve(interpolated)?.stepDef.annotations.isFinally;
    } catch {
      return false;
    }
  }

  private async executeStepDef(
    stepDef: StepDef,
    params: Record<string, string>,
    callerText: string,
    effectiveKeyword: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: any,
    depth: number
  ): Promise<StepResult> {
    // StepDef-level @Delay — pause before executing the StepDef body
    if (stepDef.annotations.delay) {
      await sleep(parseDurationMs(stepDef.annotations.delay));
    }

    // Build the body executor.
    // @Examples on a StepDef: load an external data file and run the body once per
    // matching row. All other annotations (@Delay, @Timeout, @Synchronized, @Message)
    // still apply — they wrap the entire multi-row expansion as a unit.
    const runBody = (): Promise<StepResult> =>
      stepDef.annotations.examples?.file
        ? this.executeStepDefRows(stepDef, params, callerText, effectiveKeyword, page, depth)
        : this.executeStepDefBody(stepDef, params, callerText, effectiveKeyword, page, depth);

    /**
     * Apply StepDef-level @Message: when the StepDef Gherkin tag carries @Message('text'),
     * replace any failure error with the custom text (original preserved as .cause).
     * This is distinct from inline @Message on the calling step — both can compose.
     */
    const applyStepDefMessage = (result: StepResult): StepResult => {
      if (stepDef.annotations.message && result.status === 'failed' && result.error) {
        const overridden = new Error(stepDef.annotations.message);
        (overridden as Error & { cause?: unknown }).cause = result.error;
        return { ...result, error: overridden };
      }
      return result;
    };

    let result: StepResult;

    // @Synchronized — serialise execution across concurrent parallel feature runs
    if (stepDef.annotations.isSynchronized && this.options.syncGate) {
      const syncedRun = stepDef.annotations.timeout
        ? () => withTimeout(runBody, parseDurationMs(stepDef.annotations.timeout!), callerText)
        : runBody;
      result = await this.options.syncGate.run(syncedRun);
    } else if (stepDef.annotations.timeout) {
      // StepDef-level @Timeout — wrap entire body execution
      result = await withTimeout(runBody, parseDurationMs(stepDef.annotations.timeout), callerText);
    } else {
      result = await runBody();
    }

    result = applyStepDefMessage(result);

    // @Results named reporter — call after execution (skip in dryRun mode)
    if (!this.options.dryRun && stepDef.annotations.resultsFile && this.options.namedResultsReporters) {
      const cb = this.options.namedResultsReporters.get(stepDef.annotations.resultsFile);
      if (cb) cb(this.scope, result.status === 'failed' ? 'Failed' : 'Passed');
    }

    return result;
  }

  /**
   * Execute a StepDef that carries an @Examples(file=...) annotation.
   *
   * Loads the specified CSV or JSON file, applies the prefix and where filter
   * (evaluated using the current scope + row column values), then runs the
   * StepDef body once for each matching row with the row columns merged into
   * the param bindings. Results are aggregated: status is failed if any row
   * iteration failed.
   */
  private async executeStepDefRows(
    stepDef: StepDef,
    params: Record<string, string>,
    callerText: string,
    effectiveKeyword: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: any,
    depth: number
  ): Promise<StepResult> {
    const ex = stepDef.annotations.examples!;

    // Interpolate file path — allows ${scopeVar} in the file path string
    let resolvedFilePath: string;
    try {
      resolvedFilePath = this.interpolator.interpolate(ex.file);
    } catch {
      resolvedFilePath = ex.file;
    }
    const fullPath = path.resolve(resolvedFilePath);
    const ext = path.extname(resolvedFilePath).toLowerCase();

    // Load the data file
    let records: DataRecord[];
    if (ext === '.json') {
      records = parseJsonFeed(fullPath) as DataRecord[];
    } else {
      records = parseCsvFeed(fullPath, { autoTrim: true });
    }

    // Apply column prefix
    if (ex.prefix) {
      const prefix = ex.prefix;
      records = records.map((rec) =>
        Object.fromEntries(Object.entries(rec).map(([k, v]) => [`${prefix}.${k}`, v]))
      );
    }

    // Filter by where clause using current scope + row values
    if (ex.where) {
      const scopeSnapshot = this.scope.dump();
      records = records.filter((rec) => evaluateWhereExamples(ex.where!, rec, scopeSnapshot));
    }

    // @Examples(required=true) — fail if no rows match
    if (ex.required && records.length === 0) {
      const err = new Error(
        `@Examples required=true but no rows matched the where filter: ${ex.where ?? '(no filter)'} in "${ex.file}"`
      );
      const srcFile = path.isAbsolute(stepDef.sourceFile)
        ? path.relative(process.cwd(), stepDef.sourceFile)
        : stepDef.sourceFile;
      const result: StepResult = { stepText: callerText, effectiveKeyword, status: 'failed', error: err };
      result.metaSource = `${srcFile}:${stepDef.sourceLine}`;
      return result;
    }

    // Build the examples table data for the HTML reporter.
    // header = column names from the first record (all records share the same keys after prefix).
    const header = records.length > 0 ? Object.keys(records[0]!) : [];
    const tableRows: string[][] = records.map((rec) => header.map((col) => rec[col] ?? ''));

    // Summary text shown in the Examples panel header (Preserves format)
    const parts: string[] = [`Data file: ${resolvedFilePath}`];
    if (ex.prefix) parts.push(`prefix: ${ex.prefix}`);
    if (ex.where)  parts.push(`where: ${ex.where}`);
    const summaryText = `${callerText} -- ${parts.join(', ')}`;

    // Execute body once per matching row; keep per-row results as separate children
    // so the HTML reporter can render the scrollable data table + per-row Scenario panels.
    const rowResults: StepResult[] = [];
    let anyFailed = false;
    let topError: Error | undefined;

    for (let i = 0; i < records.length; i++) {
      const row = records[i]!;
      // Merge row columns into params so body steps can use $<col> substitutions
      // and ${col} interpolations for the row-bound values.
      const mergedParams = { ...params, ...row };
      const rowStart = Date.now();
      const bodyResult = await this.executeStepDefBody(
        stepDef, mergedParams, callerText, effectiveKeyword, page, depth
      );
      const rowDurationMs = Date.now() - rowStart;

      const rowEntry: StepResult = {
        stepText: callerText,
        effectiveKeyword,
        status: bodyResult.status,
        durationMs: rowDurationMs,
        isExamplesIteration: true,
        rowIndex: i + 1,
        totalRows: records.length,
      };
      if (bodyResult.error)    rowEntry.error    = bodyResult.error;
      if (bodyResult.children) rowEntry.children = bodyResult.children;
      if (bodyResult.bindings) rowEntry.bindings = bodyResult.bindings;
      // Propagate per-row params (caller-supplied + row columns) so the
      // HTML report's outer-row Parameters dropdown shows the row context.
      if (bodyResult.params)   rowEntry.params   = bodyResult.params;
      rowResults.push(rowEntry);

      if (bodyResult.status === 'failed') {
        anyFailed = true;
        if (!topError) topError = bodyResult.error;
      }
    }

    const status: StepStatus = anyFailed ? 'failed' : 'passed';
    const aggregated: StepResult = {
      stepText: callerText,
      effectiveKeyword,
      status,
      children: rowResults,
      examplesData: { summaryText, header, rows: tableRows },
    };
    if (topError) aggregated.error = topError;

    const srcFile = path.isAbsolute(stepDef.sourceFile)
      ? path.relative(process.cwd(), stepDef.sourceFile)
      : stepDef.sourceFile;
    aggregated.metaSource = `${srcFile}:${stepDef.sourceLine}`;
    const annLabels = collectStepDefAnnotationLabels(stepDef.annotations);
    if (annLabels.length > 0) aggregated.annotations = annLabels;

    return aggregated;
  }

  private async executeStepDefBody(
    stepDef: StepDef,
    params: Record<string, string>,
    callerText: string,
    effectiveKeyword: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: any,
    depth: number
  ): Promise<StepResult> {
    // Push StepDef scope and bind all captured params.
    // Use setParam() (not set()) so these internal substitution bindings do NOT
    // propagate to the outer step's capture buffer / HTML report attachments.
    this.scope.push('stepdef');
    for (const [name, value] of Object.entries(params)) {
      this.scope.setParam(name, value);
    }
    // @Trim / @IgnoreCase — set scope flags so assertion helpers can apply them
    if (stepDef.annotations.isTrim)       this.scope.set('pgwen._trim', 'true');
    if (stepDef.annotations.isIgnoreCase) this.scope.set('pgwen._ignoreCase', 'true');

    // Pre-substitute $<paramName> tokens in each body step before executing.
    // body step syntax: $<paramName> references the captured param value.
    // e.g. StepDef name "I type <value> in the field"
    //      Body step:    "I type $<value> in the text field"
    //      After sub:    "I type hello in the text field"
    // Preserve each substep's own sourceFile when set by the parser;
    // fall back to the StepDef's sourceFile so any pre-Gherkin-parsed
    // tests / synthetic bodies still report the right .meta path in
    // UndefinedStepError.
    const substitutedSteps = stepDef.steps.map((s) => ({
      ...s,
      text: substituteParams(s.text, params),
      sourceFile: s.sourceFile ?? stepDef.sourceFile,
    }));

    let children: StepResult[];
    let status: StepStatus = 'passed';
    let topError: Error | undefined;

    try {
      const isTryStepDef = stepDef.annotations.isTry;

      // @Soft or @Sustained on the StepDef tag: body runs with continueOnFailure so all
      // steps execute even after an intermediate failure. Failures are accumulated below.
      const bodyMode = stepDef.annotations.isSoft || stepDef.annotations.isSustained;

      if (isTryStepDef) {
        // @Try on the StepDef Gherkin tag: catch all errors, always return passed
        try {
          children = await this.executeSteps(substitutedSteps, page, depth, bodyMode);
        } catch {
          children = [];
        }
        status = 'passed';
      } else {
        children = await this.executeSteps(substitutedSteps, page, depth, bodyMode);
        const anyFailed = children.some((r) => r.status === 'failed');
        if (anyFailed) {
          status = 'failed';
          topError = children.find((r) => r.error)?.error;
        }
      }
    } catch (err) {
      children = [];
      status = 'failed';
      topError = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.scope.pop();
    }

    // StepDef-level @Soft: accumulate all body failures as soft errors; StepDef reports passed.
    // Preserves @Soft on a StepDef Gherkin tag — all body steps run in soft mode.
    if (stepDef.annotations.isSoft && status === 'failed') {
      for (const child of children!) {
        if (child.status === 'failed' && child.error) {
          this.softErrors.push(child.error);
        }
      }
      children = children!.map((c) => c.status === 'failed' ? { ...c, status: 'passed' as StepStatus } : c);
      status = 'passed';
      topError = undefined;
    }

    // StepDef-level @Sustained: accumulate silently; never auto-surfaced as failures.
    // Project authors must assert ${pgwen.feature.isSustainedError} to detect these.
    // Failed children are demoted to passed but retain `sustained: true` + their
    // error so the HTML/console reporters can render the assertion message.
    if (stepDef.annotations.isSustained && status === 'failed') {
      for (const child of children!) {
        if (child.status === 'failed' && child.error) {
          this.sustainedErrors.push(child.error);
        }
      }
      children = children!.map((c) => c.status === 'failed'
        ? { ...c, status: 'passed' as StepStatus, sustained: true }
        : c);
      status = 'passed';
      topError = undefined;
    }

    const result: StepResult = { stepText: callerText, effectiveKeyword, status, children };
    if (topError !== undefined) result.error = topError;
    // Attach StepDef source location and annotations for the HTML report panel header.
    // Convert absolute paths to project-relative so the report shows "pgwen/meta/Foo.meta:22"
    // rather than a full filesystem path.
    const srcFile = path.isAbsolute(stepDef.sourceFile)
      ? path.relative(process.cwd(), stepDef.sourceFile)
      : stepDef.sourceFile;
    result.metaSource = `${srcFile}:${stepDef.sourceLine}`;
    const annLabels = collectStepDefAnnotationLabels(stepDef.annotations);
    if (annLabels.length > 0) result.annotations = annLabels;
    if (Object.keys(params).length > 0) result.params = params;
    return result;
  }
}

// ─── Param substitution ───────────────────────────────────────────────────────

/**
 * Replace all $<paramName> tokens in stepText with their captured values.
 * This runs before StringInterpolator so the substituted text is a plain string
 * that ${...} interpolation can further process.
 *
 * @example
 *   substituteParams('I type $<value> in the field', { value: 'hello' })
 *   // → 'I type hello in the field'
 */
function substituteParams(stepText: string, params: Record<string, string>): string {
  let result = stepText;
  for (const [name, value] of Object.entries(params)) {
    // Replace $<name> and also "<name>" (outline-style param tokens)
    result = result.replaceAll(`$<${name}>`, value);
    result = result.replaceAll(`<${name}>`, value);
  }
  return result;
}

// ─── Duration / timing helpers ────────────────────────────────────────────────

/**
 * Parse a duration string to milliseconds.
 *
 * Supported formats:
 *   "500ms"   → 500
 *   "5s"      → 5000
 *   "1.5s"    → 1500
 *   "2m"      → 120000
 *   "2m30s"   → 150000
 *   "30"      → 30000  (bare number treated as seconds)
 *
 * Falls back to 30000ms (30s) for unrecognised formats.
 */
export function parseDurationMs(s: string): number {
  const t = s.trim();

  const ms = /^(\d+)\s*ms$/i.exec(t);
  if (ms) return parseInt(ms[1]!, 10);

  const seconds = /^(\d+(?:\.\d+)?)\s*s$/i.exec(t);
  if (seconds) return Math.round(parseFloat(seconds[1]!) * 1000);

  const minutes = /^(\d+)\s*m(?:\s*(\d+)\s*s)?$/i.exec(t);
  if (minutes) {
    return parseInt(minutes[1]!, 10) * 60_000 +
      (minutes[2] ? parseInt(minutes[2], 10) * 1000 : 0);
  }

  // Bare number — treat as seconds
  const plain = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (plain) return Math.round(parseFloat(plain[1]!) * 1000);

  return 30_000; // default 30s for unrecognised
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a deadline timer.
 * Always clears the timer to prevent timer leaks.
 */
async function withTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  stepText: string
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`Step timed out after ${timeoutMs}ms: "${stepText}"`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([factory(), timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class CompositorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositorError';
  }
}

// ─── DryRun error classification ─────────────────────────────────────────────

/**
 * Returns true for errors that should surface even in dryRun mode.
 *
 * dry runs perform *static* validation only — syntax, bindings, and StepDef
 * resolution. "Non-static bindings are never evaluated" per the docs, which
 * means assertions on runtime values (DslAssertionError) must NOT surface in
 * dry-run. Only binding-existence failures should surface:
 *
 *   - "Unbound reference: X" — a ${VAR} reference has no binding at all; this IS
 *     a static error (the variable was never defined anywhere).
 *
 * DslAssertionError is a runtime check on an actual value and is therefore a
 * non-static evaluation — swallowed in dry-run, same as browser errors.
 *
 * Browser/Playwright errors (TimeoutError, locator errors, etc.) return false
 * and are safely swallowed in dryRun since no browser is running.
 */
function isDataError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // error format (from pgwen.conf / runtime): "Unbound reference: X"
  if (err.message.startsWith('Unbound reference:')) return true;
  // pgwen's own interpolation error (StringInterpolator): "Undefined binding: "${X}"..."
  if (err.message.startsWith('Undefined binding:')) return true;
  // pgwen's locator-not-found error (resolveLocator): locator binding never registered
  if (err.message.startsWith('No locator binding found for')) return true;
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the attribute (variable) name from a DSL step text.
 * Returns the portion of the text before the first DSL keyword
 * (should, is, can, will, are, has, have, must) so that @DryRun
 * legacy positional bindings use a meaningful scope key.
 *
 * Examples:
 *   "RESOURCE_ID should not be blank"   → "RESOURCE_ID"
 *   "the account status should be ..."  → "the account status"
 *   "status is defined by ..."          → "status"
 *   "I navigate to ..."                 → "I navigate to ..." (no match → full text)
 */
function extractAttributeFromStep(stepText: string): string {
  const m = /^(.+?)\s+(?:should|is\s|can\s|will\s|are\s|has\s|have\s|must\s)/i.exec(stepText);
  return m ? m[1]!.trim() : stepText;
}

// ─── @Examples where-clause evaluation ───────────────────────────────────────

/**
 * Evaluate a where expression for a single data row in the context of
 * StepDef @Examples execution, where both outer scope bindings and row column
 * values must be available.
 *
 * Evaluation order:
 *   1. ${varName} tokens are replaced from combined context (scope + row).
 *   2. Bare column names (from the row) are replaced with their quoted values.
 *   3. Standalone = is normalised to == for JS evaluation.
 *   4. The resulting JS expression is evaluated with new Function().
 *
 * On any error the record is included (treated as matching).
 */
function evaluateWhereExamples(
  where: string,
  row: Record<string, string>,
  scopeSnapshot: Record<string, string>
): boolean {
  try {
    // Combined context: scope first, row overrides (row is more specific)
    const combined: Record<string, string> = { ...scopeSnapshot, ...row };
    let expr = where;

    // Step 1: Replace ${varName} tokens from combined context
    expr = expr.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      const val = combined[key] ?? '';
      return `'${escapeExamplesStr(val)}'`;
    });

    // Step 2: Replace bare row column names (longest first to avoid partial matches)
    const colsSorted = Object.keys(row).sort((a, b) => b.length - a.length);
    for (const col of colsSorted) {
      const escapedCol = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const boundary = /^\w+$/.test(col) ? `\\b${escapedCol}\\b` : escapedCol;
      const colPattern = new RegExp(boundary, 'g');
      expr = expr.replace(colPattern, `'${escapeExamplesStr(row[col] ?? '')}'`);
    }

    // Step 3: Normalise standalone = to == (shorthand: STATUS = 'ACTIVE')
    expr = expr.replace(/(?<![!<>=])=(?!=)/g, '==');

    // Step 4: Evaluate
    // eslint-disable-next-line no-new-func
    return Boolean(new Function(`return (${expr})`)());
  } catch {
    return true; // on error, include the record
  }
}

function escapeExamplesStr(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Collect human-readable annotation label strings from a StepDef's parsed Gherkin tags.
 * Used to populate StepResult.annotations for the StepDef expansion panel header.
 * Internal/structural annotations (@Synthetic, @If, @While) are intentionally excluded.
 */
function collectStepDefAnnotationLabels(ann: ParsedAnnotations): string[] {
  const labels: string[] = [];
  if (ann.isStepDef)      labels.push('@StepDef');
  if (ann.isContext)      labels.push('@Context');
  if (ann.isAction)       labels.push('@Action');
  if (ann.isAssertion)    labels.push('@Assertion');
  if (ann.isDataTable)    labels.push('@DataTable');
  if (ann.isForEach)      labels.push('@ForEach');
  if (ann.isSynchronized) labels.push('@Synchronized');
  if (ann.isTry)          labels.push('@Try');
  if (ann.isFinally)      labels.push('@Finally');
  if (ann.isEager)        labels.push('@Eager');
  if (ann.isLazy)         labels.push('@Lazy');
  if (ann.isMasked)       labels.push('@Masked');
  if (ann.timeout)        labels.push(`@Timeout('${ann.timeout}')`);
  if (ann.delay)          labels.push(`@Delay('${ann.delay}')`);
  if (ann.isHard)         labels.push('@Hard');
  if (ann.isSoft)         labels.push('@Soft');
  if (ann.isSustained)    labels.push('@Sustained');
  if (ann.isBreakpoint)   labels.push('@Breakpoint');
  if (ann.isParallel)     labels.push('@Parallel');
  if (ann.isTrim)         labels.push('@Trim');
  if (ann.isIgnoreCase)   labels.push('@IgnoreCase');
  if (ann.isAbstract)     labels.push('@Abstract');
  if (ann.isShadowRoot)   labels.push('@ShadowRoot');
  if (ann.message)        labels.push(`@Message('${ann.message}')`);
  if (ann.resultsFile)    labels.push(`@Results('${ann.resultsFile}')`);
  if (ann.examples)       labels.push(`@Examples(file='${ann.examples.file}')`);
  return labels;
}

/**
 * Collect human-readable annotation label strings from parsed inline annotations.
 * Used to populate StepResult.stepAnnotations for HTML/console reporting.
 */
function collectAnnotationLabels(ann: StepInlineAnnotations): string[] {
  const labels: string[] = [];
  if (ann.isEager)     labels.push('@Eager');
  if (ann.isLazy)      labels.push('@Lazy');
  if (ann.isTry)       labels.push('@Try');
  if (ann.isSoft)      labels.push('@Soft');
  if (ann.isSustained) labels.push('@Sustained');
  if (ann.isHard)      labels.push('@Hard');
  if (ann.isFinally)   labels.push('@Finally');
  if (ann.isMasked)    labels.push('@Masked');
  if (ann.timeout)     labels.push(`@Timeout('${ann.timeout}')`);
  if (ann.delay)       labels.push(`@Delay('${ann.delay}')`);
  // @Message is a runtime annotation for custom error messages — not shown in reports.
  if (ann.dryRunName !== undefined && ann.dryRunValues) {
    const vals = ann.dryRunValues.map((v) => `'${v}'`).join(', ');
    labels.push(`@DryRun(name='${ann.dryRunName}', value=[${vals}])`);
  } else if (ann.dryRunValue !== undefined) {
    labels.push(`@DryRun('${ann.dryRunValue}')`);
  }
  return labels;
}

/**
 * Validate that all scope bindings referenced in a condition string exist.
 * Used in dryrun mode to surface "Unbound reference" errors for if-guard conditions,
 * matching pgwen's behaviour of checking binding existence without evaluating control flow.
 * Browser-dependent checks (JS expressions, element state) are silently skipped.
 */
function validateConditionRef(condition: string, scope: Scope): void {
  // Negation: recurse on the inner condition
  const notMatch = /^not (.+)$/i.exec(condition);
  if (notMatch) {
    validateConditionRef(notMatch[1]!.trim(), scope);
    return;
  }

  // JS expression (double-quoted): skip — no browser in dryrun
  if (/^"[^"]+"$/.exec(condition)) return;

  // Element state check: skip — no browser in dryrun
  if (/^.+ is (not )?(displayed|visible|hidden|enabled|disabled|checked|ticked|unchecked|unticked)$/i.exec(condition)) return;

  // Scope equality: <name> is "<value>" — validate the LHS binding exists
  const eqMatch = /^(.+) is "([^"]*)"$/i.exec(condition);
  if (eqMatch) {
    const condKey = eqMatch[1]!.trim();
    if (!condKey.startsWith('env.') && !hasBinding(scope, condKey)) {
      throw new Error(`Unbound reference: ${condKey}`);
    }
    return;
  }

  // Substring guards: <name> [does not ]contain[s] "<value>"
  const containsMatch = /^(.+?) (?:does not contain|contains?|do not contain) "([^"]*)"$/i.exec(condition);
  if (containsMatch) {
    const condKey = containsMatch[1]!.trim();
    if (!condKey.startsWith('env.') && !hasBinding(scope, condKey)) {
      throw new Error(`Unbound reference: ${condKey}`);
    }
    return;
  }

  // Regex / format-match / tab-count / presence (defined|blank|empty) — LHS validation
  const lhsMatch =
    /^(.+) matches regex "/i.exec(condition) ??
    /^(.+) (?:matches|does not match) (?:datetime|number) format "/i.exec(condition) ??
    /^(.+) is (?:not )?(?:defined|blank|empty)$/i.exec(condition);
  if (lhsMatch) {
    const condKey = lhsMatch[1]!.trim();
    if (!condKey.startsWith('env.') && !hasBinding(scope, condKey)) {
      // 'is defined' / 'is not defined' deliberately tolerates missing bindings —
      // the whole point is checking existence. Same logic for blank/empty.
      if (/ is (?:not )?(?:defined|blank|empty)$/i.test(condition)) return;
      throw new Error(`Unbound reference: ${condKey}`);
    }
    return;
  }

  // Tab/window count guards — no scope binding required
  if (/^there (?:is 1|are \d+) open (?:tab|window)s?$/i.test(condition)) return;

  // Bare scope name: must be bound in scope
  if (!hasBinding(scope, condition)) {
    throw new Error(`Unbound reference: ${condition}`);
  }
}

/**
 * Existence check that tolerates async lazy resolvers.
 *
 * `scope.get()` throws "async lazy resolver" when the binding is registered
 * but its resolver returns a Promise (e.g. `is defined by js` bindings). For
 * if-guard validation we only care whether the binding EXISTS — not whether
 * its value can be obtained synchronously — so we treat that throw as a
 * positive existence signal.
 */
function hasBinding(scope: Scope, name: string): boolean {
  try {
    return scope.get(name) !== undefined;
  } catch (e) {
    if (e instanceof Error && e.message.includes('async lazy resolver')) return true;
    throw e;
  }
}

/**
 * Extract an inline `if <condition>` or `if <condition> otherwise <alt>` guard
 * from the end of a step text.
 *
 * Returns null when no guard is present.
 *
 * Why Compositor-level and not DSL-level:
 *   DSL action patterns like `^I click (.+)$` match the FULL text including the
 *   guard suffix (e.g. "I click the login button if the login button is displayed")
 *   and then try to resolve "the login button if the login button is displayed"
 *   as a locator — which fails. Extracting the guard BEFORE DSL resolution allows
 *   the stripped step text ("I click the login button") to resolve correctly.
 */
export interface IfGuard {
  /** Step text with all if-guard suffixes removed. */
  step: string;
  /**
   * Conditions in right-to-left evaluation order (index 0 = rightmost/innermost).
   * evaluates chained guards from right to left: if any is false the step
   * is skipped without evaluating the remaining (outer) conditions.
   *
   * Example: "step if cond1 if cond2 if cond3"
   *   → conditions = ["cond3", "cond2", "cond1"]  (cond3 checked first)
   */
  conditions: string[];
  /** Alternative step text (from "otherwise <alt>"), if present. */
  alt?: string;
}

function parseIfGuard(stepText: string): IfGuard | null {
  // "otherwise" form — must be checked first (more specific pattern).
  // No chaining with "otherwise": only supports single condition + alt branch.
  const otherwiseMatch = /^(.+?)\s+if\s+(.+?)\s+otherwise\s+(.+)$/i.exec(stepText);
  if (otherwiseMatch) {
    return {
      step: otherwiseMatch[1]!.trim(),
      conditions: [otherwiseMatch[2]!.trim()],
      alt: otherwiseMatch[3]!.trim(),
    };
  }

  // Chained if-guard form: "step if cond1 if cond2 if cond3"
  // The first " if " separates the step body from its condition chain.
  const firstIfIdx = stepText.search(/\s+if\s+/i);
  if (firstIfIdx < 0) return null;

  const stepPart = stepText.slice(0, firstIfIdx).trim();
  // Everything after the first " if "
  const conditionsPart = stepText.slice(firstIfIdx).replace(/^\s+if\s+/i, '').trim();

  // Split remaining by " if " to collect every chained condition.
  // E.g. "cond1 if cond2 if cond3" → ["cond1", "cond2", "cond3"]
  const allConditions = conditionsPart.split(/\s+if\s+/i).map((c) => c.trim()).filter(Boolean);

  // Reverse so index 0 = rightmost condition (evaluated first).
  return { step: stepPart, conditions: allConditions.reverse() };
}
