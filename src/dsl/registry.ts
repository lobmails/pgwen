/**
 * registry.ts — DSL step registry.
 *
 * `DslRegistry` stores registered step patterns and creates a `DslResolver`
 * (the function Compositor uses to look up a handler by step text).
 *
 * Usage:
 *   registry.register(/^I navigate to "(.+)"$/, async ([url], _scope, page) => { ... });
 *   const resolver = registry.createResolver(scope);
 *   // resolver is passed to new Compositor(registry, scope, interpolator, resolver)
 */

import type { Scope } from '../engine/Scope';
import type { DslResolver, DslHandler } from '../engine/Compositor';
import type { HandlerCategory } from '../diagnose/Classifier';

export type { HandlerCategory };

/**
 * Executes a single DSL step programmatically (used by control-structure handlers).
 * Resolves the step against the same registry and scope it was created with.
 */
export type StepRunner = (stepText: string, page: unknown) => Promise<void>;

/**
 * A registered DSL handler.
 * groups — the captured regex groups (index 0 = first capture group).
 * run    — a step runner for control-structure handlers; ordinary handlers ignore it.
 */
export type HandlerFn = (groups: string[], scope: Scope, page: unknown, run: StepRunner) => Promise<void>;

export interface DslEntry {
  pattern: RegExp;
  handler: HandlerFn;
  category?: HandlerCategory;
}

export class DslRegistry {
  private readonly entries: DslEntry[] = [];

  /**
   * Register a step pattern with a handler.
   * Patterns are matched in registration order; first match wins.
   * `category` is an optional hint used by the rule-based failure classifier
   * (see src/diagnose/Classifier.ts). Default behaviour is unchanged.
   */
  register(pattern: RegExp, handler: HandlerFn, category?: HandlerCategory): void {
    const entry: DslEntry = { pattern, handler };
    if (category !== undefined) entry.category = category;
    this.entries.push(entry);
  }

  /**
   * Return a thin wrapper whose `.register(pattern, handler)` calls auto-apply
   * the given category. Lets handler-family files tag every registration with
   * a single line at the top:
   *
   *   const reg = registry.withCategory('assertion');
   *   reg.register(/^.../, async () => { ... });
   */
  withCategory(category: HandlerCategory): { register: (pattern: RegExp, handler: HandlerFn) => void } {
    return {
      register: (pattern, handler) => this.register(pattern, handler, category),
    };
  }

  /**
   * Return the HandlerCategory of the first entry whose pattern matches stepText,
   * or undefined when no entry matches. Used by Compositor on the failure path
   * so the classifier can be given a definitive category for that step.
   */
  categoryFor(stepText: string): HandlerCategory | undefined {
    for (const { pattern, category } of this.entries) {
      if (pattern.test(stepText)) return category;
    }
    return undefined;
  }

  /**
   * Create a DslResolver bound to the given scope.
   * The resolver is passed to Compositor as the `dslResolver` parameter.
   *
   * Every handler receives a `run` function that can execute any other
   * registered step in the same registry — used by control-structure
   * handlers (ForEach, if, until, while).
   *
   * `stepDefRunner` (optional) is a callback that resolves the step text
   * against the StepDef registry first (via the Compositor). When supplied,
   * `run(stepText)` tries StepDef matches BEFORE DSL patterns — necessary
   * for loops over StepDef substeps (`<stepdef> for each X in Y` — the
   * common reference-framework pattern). Without it, loop bodies could
   * only invoke DSL patterns, not user-defined StepDefs.
   */
  createResolver(scope: Scope, stepDefRunner?: StepRunner): DslResolver {
    const entries = this.entries;

    /** Build a recursive step-runner that always passes itself along. */
    const makeRunner = (page: unknown): StepRunner =>
      async (stepText: string): Promise<void> => {
        // 1. Try StepDef first when the Compositor wired one through.
        if (stepDefRunner) {
          try {
            await stepDefRunner(stepText, page);
            return;
          } catch (e) {
            // Only fall through to DSL when StepDef explicitly reports "no
            // match". Real errors from a matched StepDef must propagate.
            if (!(e instanceof Error) || !/no.*step.*def|stepdef.*not.*found|no matching/i.test(e.message)) {
              throw e;
            }
          }
        }
        // 2. Try DSL patterns.
        for (const { pattern, handler } of entries) {
          const match = pattern.exec(stepText);
          if (match) {
            const groups = Array.from(match).slice(1).map(g => g ?? '');
            await handler(groups, scope, page, makeRunner(page));
            return;
          }
        }
        throw new Error(`No DSL handler matched: "${stepText}"`);
      };

    return (stepText: string): DslHandler | undefined => {
      for (const { pattern, handler } of entries) {
        const match = pattern.exec(stepText);
        if (match) {
          const groups = Array.from(match).slice(1).map(g => g ?? '');
          return async (_text: string, page: unknown): Promise<void> => {
            await handler(groups, scope, page, makeRunner(page));
          };
        }
      }
      return undefined;
    };
  }

  /** Remove all registered entries (useful between tests). */
  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
