/**
 * StepDefRegistry.ts — Store, look up, and validate StepDef definitions.
 *
 * Responsibilities:
 *   1. Register StepDefs parsed from .meta files.
 *   2. Match a runtime step text against registered StepDefs (with <param> capture).
 *   3. Enforce the reference framework behaviour rules (strict mode):
 *        @Context  → may only be called from Given keyword chains
 *        @Action   → may only be called from When keyword chains
 *        @Assertion → may only be called from Then / But keyword chains
 *
 * Step resolution order is first-registered-wins within the same tier.
 * MetaEngine loads in correct precedence order (associative last = highest).
 */

import { type ParsedStep } from './GherkinParser';
import { type ParsedAnnotations, parseAnnotations } from '../annotations/Annotations';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepDef {
  /** Original name string from the Scenario title, e.g. "I am on the <page> page" */
  name: string;
  /** Compiled regex with <param> slots replaced by capture groups. */
  pattern: RegExp;
  /** Ordered list of param names extracted from <...> tokens in the name. */
  paramNames: string[];
  /** All parsed annotations on the StepDef Scenario. */
  annotations: ParsedAnnotations;
  /** The steps that make up this StepDef's body. */
  steps: ParsedStep[];
  sourceFile: string;
  sourceLine: number;
}

export interface ResolvedStep {
  stepDef: StepDef;
  /** Map of param name → captured value from the step text match. */
  params: Record<string, string>;
}

export type BehaviourMode = 'strict' | 'lenient';

// Effective keywords (after And/But inheritance)
const GIVEN_KEYWORDS = new Set(['given', '*']);
const WHEN_KEYWORDS  = new Set(['when']);
const THEN_KEYWORDS  = new Set(['then', 'but']);
const INHERITING_KEYWORDS = new Set(['and', 'but', '*']);

// ─── Registry ────────────────────────────────────────────────────────────────

export class StepDefRegistry {
  private readonly stepDefs: StepDef[] = [];
  private behaviourMode: BehaviourMode = 'strict';

  setBehaviourMode(mode: BehaviourMode): void {
    this.behaviourMode = mode;
  }

  // ─── Registration ───────────────────────────────────────────────────────

  /**
   * Register a StepDef. If a StepDef with the same name already exists,
   * the new one overrides it (last-registered = highest precedence,
   * so MetaEngine must load in ascending-precedence order).
   */
  register(stepDef: StepDef): void {
    const idx = this.stepDefs.findIndex((s) => s.name === stepDef.name);
    if (idx !== -1) {
      this.stepDefs[idx] = stepDef; // override
    } else {
      this.stepDefs.push(stepDef);
    }
  }

  /** Return all registered StepDefs (for debugging/REPL). */
  all(): readonly StepDef[] {
    return this.stepDefs;
  }

  /** Return true if any StepDef has been registered. */
  isEmpty(): boolean {
    return this.stepDefs.length === 0;
  }

  // ─── Resolution ─────────────────────────────────────────────────────────

  /**
   * Find the StepDef whose pattern matches stepText.
   * Returns undefined if no match.
   * Throws AmbiguousStepError if two or more StepDefs match the same step text.
   *
   * Does NOT enforce behaviour rules — call enforceRules() separately.
   */
  resolve(stepText: string): ResolvedStep | undefined {
    const matches: Array<{ stepDef: StepDef; match: RegExpExecArray }> = [];
    for (const stepDef of this.stepDefs) {
      const match = stepDef.pattern.exec(stepText);
      if (match) {
        matches.push({ stepDef, match });
      }
    }
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new AmbiguousStepError(stepText, matches.map(m => m.stepDef.name));
    }
    const { stepDef, match } = matches[0]!;
    const params: Record<string, string> = {};
    stepDef.paramNames.forEach((name, i) => {
      params[name] = match[i + 1] ?? '';
    });
    return { stepDef, params };
  }

  /**
   * Resolve a step that has a docstring but no inline value for the last param.
   *
   * Standard behaviour: when a StepDef template ends with `<paramName>` and the calling
   * step text matches the template prefix (everything before the last placeholder),
   * the docstring content is bound to that parameter instead of the inline text.
   *
   * This is a secondary resolution path tried only after normal resolve() fails.
   *
   * @param stepText  The interpolated step text (no docstring appended).
   * @param docString The raw docstring content from the calling step.
   */
  resolveWithDocstring(stepText: string, docString: string): ResolvedStep | undefined {
    for (const stepDef of this.stepDefs) {
      if (stepDef.paramNames.length === 0) continue;

      // Only substitute docstring when the LAST param is a trailing param — i.e., the
      // pattern ends with `(.+)$` (possibly preceded by literal text and no more params after it).
      // Standard behaviour: mid-template params are never filled from docstring.
      const src = stepDef.pattern.source;
      if (!src.endsWith('(.*)$')) continue; // trailing param only

      const lastCaptureIdx = src.lastIndexOf('(.*)');

      // Replace the trailing space before the last capture group with optional whitespace
      // so "I submit" matches the template "I submit <body>" (the space before param is optional)
      const prefix = src.slice(0, lastCaptureIdx).replace(/\s+$/, '\\s*');
      const relaxedSrc = prefix + '(.*)' + '$';
      const relaxedPattern = new RegExp(relaxedSrc);
      const match = relaxedPattern.exec(stepText);

      if (match) {
        const lastParam = stepDef.paramNames[stepDef.paramNames.length - 1]!;
        const params: Record<string, string> = {};
        stepDef.paramNames.forEach((name, i) => {
          const captured = match[i + 1] ?? '';
          // Fill the last param with the docstring when its inline capture is empty
          params[name] = (name === lastParam && captured === '') ? docString : captured;
        });
        return { stepDef, params };
      }
    }
    return undefined;
  }

  /**
   * Enforce the reference framework behaviour rules (strict mode only).
   * Throws BehaviourRuleError when a step keyword violates the StepDef's annotation.
   *
   * @param effectiveKeyword  The inherited keyword (after And/But resolution).
   */
  enforceRules(resolved: ResolvedStep, effectiveKeyword: string): void {
    if (this.behaviourMode === 'lenient') return;

    const { annotations } = resolved.stepDef;
    const kw = effectiveKeyword.toLowerCase().trim();

    if (annotations.isContext && !GIVEN_KEYWORDS.has(kw)) {
      throw new BehaviourRuleError(
        `@Context StepDef "${resolved.stepDef.name}" may only be called from a Given step chain ` +
        `(called from "${effectiveKeyword}").`
      );
    }

    if (annotations.isAction && !WHEN_KEYWORDS.has(kw)) {
      throw new BehaviourRuleError(
        `@Action StepDef "${resolved.stepDef.name}" may only be called from a When step chain ` +
        `(called from "${effectiveKeyword}").`
      );
    }

    if (annotations.isAssertion && !THEN_KEYWORDS.has(kw)) {
      throw new BehaviourRuleError(
        `@Assertion StepDef "${resolved.stepDef.name}" may only be called from a Then/But step chain ` +
        `(called from "${effectiveKeyword}").`
      );
    }
  }

  // ─── Pattern compilation (static utility) ───────────────────────────────

  /**
   * Compile a StepDef name string into a match pattern and extract param names.
   *
   * Rules:
   *   - <paramName> becomes (.+) in the regex (greedy, but bounded by surrounding text)
   *   - All other regex special characters in the name are escaped
   *   - Pattern is anchored: ^...$
   *   - Case-sensitive (the reference framework is case-sensitive)
   *
   * @example
   *   compilePattern("I am on the <page> page")
   *   // → { pattern: /^I am on the (.+) page$/, paramNames: ["page"] }
   */
  static compilePattern(name: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    // Split on <...> tokens, preserving them
    const parts = name.split(/(<[^>]+>)/);
    const regexParts = parts.map((part) => {
      const paramMatch = /^<([^>]+)>$/.exec(part);
      if (paramMatch) {
        paramNames.push(paramMatch[1]!);
        return '(.*)';   // allow empty string captures — the reference framework permits blank param values
      }
      return escapeRegex(part);
    });

    const pattern = new RegExp(`^${regexParts.join('')}$`);
    return { pattern, paramNames };
  }
}

// ─── Keyword resolution ───────────────────────────────────────────────────────

/**
 * Resolve the effective Gherkin keyword for a step, applying And/But inheritance.
 *
 * Rules (mirrors the reference framework strict mode):
 *   - Given / When / Then → themselves
 *   - And / But → inherit the nearest preceding Given/When/Then
 *   - * (bullet) → treated as Given when no predecessor, otherwise inherits
 *   - If no predecessor exists for And/But, treat as Given
 */
export function resolveEffectiveKeyword(
  rawKeyword: string,
  precedingEffective: string | undefined
): string {
  const kw = rawKeyword.trim().toLowerCase();

  if (!INHERITING_KEYWORDS.has(kw)) {
    // Given, When, Then — return normalised
    return kw;
  }

  // And / But / * → inherit
  if (precedingEffective !== undefined) {
    return precedingEffective;
  }

  // No predecessor → default to 'given'
  return 'given';
}

/**
 * Walk a step sequence and compute effective keywords for every step.
 * Accounts for And/But inheritance across the entire sequence.
 */
export function resolveEffectiveKeywords(steps: ParsedStep[]): string[] {
  let lastNonInheriting: string | undefined;
  return steps.map((step) => {
    const effective = resolveEffectiveKeyword(
      step.keyword.trim().toLowerCase(),
      lastNonInheriting
    );
    const kw = step.keyword.trim().toLowerCase();
    if (!INHERITING_KEYWORDS.has(kw)) {
      lastNonInheriting = effective;
    }
    return effective;
  });
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class BehaviourRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BehaviourRuleError';
  }
}

export class UndefinedStepError extends Error {
  constructor(stepText: string, location?: string) {
    const loc = location ? ` [at ${location}]` : '';
    super(
      `Undefined step: "${stepText}"${loc}. ` +
      `Add a @StepDef in a .meta file or implement it as a DSL primitive.`
    );
    this.name = 'UndefinedStepError';
  }
}

export class AmbiguousStepError extends Error {
  constructor(stepText: string, matchingNames: string[]) {
    const names = matchingNames.map(n => `"${n}"`).join(', ');
    super(`Ambiguous step: "${stepText}" matches multiple StepDefs: ${names}`);
    this.name = 'AmbiguousStepError';
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Escape all regex special characters in a string so it can be used
 * as a literal segment inside a RegExp.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a StepDef object from parsed metadata.
 * Compiles the name pattern and extracts param names.
 */
export function buildStepDef(
  name: string,
  tags: string[],
  steps: ParsedStep[],
  sourceFile: string,
  sourceLine: number
): StepDef {
  const { pattern, paramNames } = StepDefRegistry.compilePattern(name);
  const annotations = parseAnnotations(tags);
  return { name, pattern, paramNames, annotations, steps, sourceFile, sourceLine };
}
