/**
 * DryRunner.ts — Validate step resolution without executing.
 *
 * The dry runner parses all feature files, loads their meta, and checks that
 * every step can be resolved to either a registered StepDef or a DSL handler.
 * No browser is launched; no side effects occur.
 *
 * Used as the pre-flight quality gate (-bn flag in ).
 * Returns a list of undefined step locations.
 */

import * as path from 'path';
import { GherkinParser, type ParsedStep } from '../engine/GherkinParser';
import { MetaEngine } from '../engine/MetaEngine';
import { parseAnnotations } from '../annotations/Annotations';
import { parseStepInlineAnnotations } from '../engine/StepAnnotationParser';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface UndefinedStep {
  featureFile: string;
  scenarioName: string;
  stepText: string;
  line: number;
}

export interface DryRunResult {
  /** All feature files checked. */
  checkedFiles: string[];
  /** All steps that could not be resolved. Empty = all steps defined. */
  undefinedSteps: UndefinedStep[];
  /** true only when undefinedSteps.length === 0 */
  passed: boolean;
}

export interface DryRunOptions {
  /** Common meta files or directories. */
  meta?: string[];
  /** DSL resolver for checking DSL step resolution. */
  dslResolver?: (stepText: string) => unknown;
  /** Base directory for resolving relative paths. Default: process.cwd() */
  baseDir?: string;
}

// Inline annotation stripping now delegates to the shared StepAnnotationParser
// which handles both leading (@Finally, @Soft, @Try, etc.) and trailing (@Message, @DryRun) annotations.

// ─── DryRunner ────────────────────────────────────────────────────────────────

export class DryRunner {
  /**
   * Check that every step in every feature file can be resolved.
   * Returns a DryRunResult with any undefined steps found.
   */
  checkFiles(featureFiles: string[], options: DryRunOptions = {}): DryRunResult {
    const baseDir = options.baseDir ?? process.cwd();
    const parser = new GherkinParser();
    const undefinedSteps: UndefinedStep[] = [];
    const checkedFiles: string[] = [];

    for (const featureFile of featureFiles) {
      const absoluteFile = path.resolve(baseDir, featureFile);
      checkedFiles.push(absoluteFile);

      // Build a fresh MetaEngine per feature (associative meta isolation)
      const metaEngine = new MetaEngine(parser);

      // Load common meta
      for (const metaPath of options.meta ?? []) {
        try {
          metaEngine.loadCommon(path.resolve(baseDir, metaPath));
        } catch {
          // If common meta can't be loaded, continue — step check will surface issues
        }
      }

      // Load associative meta
      try {
        metaEngine.loadAssociative(absoluteFile);
      } catch {
        // No associative meta is fine
      }

      // Parse the feature file
      let feature;
      try {
        feature = parser.parseFile(absoluteFile);
      } catch {
        // If we can't parse, record as undefined (can't check steps)
        continue;
      }

      // Check background steps
      if (feature.background) {
        for (const step of feature.background.steps) {
          const issue = this.checkStep(
            step,
            absoluteFile,
            'Background',
            metaEngine,
            options.dslResolver
          );
          if (issue) undefinedSteps.push(issue);
        }
      }

      // Check scenario steps
      for (const scenario of feature.scenarios) {
        const annotations = parseAnnotations(scenario.tags);

        // Skip @Ignore scenarios
        if (annotations.isIgnore) continue;

        for (const step of scenario.steps) {
          const issue = this.checkStep(
            step,
            absoluteFile,
            scenario.name,
            metaEngine,
            options.dslResolver
          );
          if (issue) undefinedSteps.push(issue);
        }
      }
    }

    return {
      checkedFiles,
      undefinedSteps,
      passed: undefinedSteps.length === 0,
    };
  }

  private checkStep(
    step: ParsedStep,
    featureFile: string,
    scenarioName: string,
    metaEngine: MetaEngine,
    dslResolver: ((stepText: string) => unknown) | undefined
  ): UndefinedStep | null {
    const cleaned = parseStepInlineAnnotations(step.text).cleanText;

    // Check StepDef registry
    if (metaEngine.registry.resolve(cleaned) !== undefined) {
      return null;
    }

    // Check DSL resolver
    if (dslResolver !== undefined && dslResolver(cleaned) !== undefined) {
      return null;
    }

    return {
      featureFile,
      scenarioName,
      stepText: cleaned,
      line: step.line,
    };
  }
}
