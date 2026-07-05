/**
 * Assembler.ts — focused failure bundle assembler (§11).
 *
 * Pure function. Given a fully-resolved set of failure inputs, produces
 * a `DiagnoseInput` ready for the Claude prompt layer (§16) — no
 * Claude call, no I/O, no shelling out. All file reads, trace.zip
 * extraction, and git invocations happen UPSTREAM in the caller.
 *
 * Hard invariants enforced here (each backed by a unit test):
 *   - JSON output ≤ `DIAGNOSE_BUNDLE_HARD_CAP_BYTES` (50 KB). When the
 *     bundle would exceed it, the assembler trims `dom_excerpt`
 *     progressively. If even an empty DOM leaves the bundle over cap,
 *     the assembler throws — that's a caller bug (history payload or
 *     binding context too greedy).
 *   - Soft target is `DIAGNOSE_BUNDLE_SOFT_CAP_BYTES` (25 KB).
 *   - The "does NOT do" list from §11 is structural: the input shape
 *     accepts a SINGLE failing step and a SINGLE locator. There is no
 *     surface for unrelated scenarios, network logs, or other bindings.
 */

import {
  type DiagnoseInput,
  DIAGNOSE_BUNDLE_HARD_CAP_BYTES,
  DIAGNOSE_BUNDLE_SOFT_CAP_BYTES,
} from './types';
import { extractPreFailureDom } from './TraceExtractor';
import { scrubDiagnoseInput, type ScrubberOptions } from './Scrubber';
import type { RunResult } from '../execution/Runner';
import type { StepResult } from '../engine/Compositor';

export type StepKeyword = DiagnoseInput['failing']['step_keyword'];
export type SiblingStatus = 'passed' | 'failed' | 'skipped';

/**
 * Optional knobs passed to `assembleBundle`. Defaults run the generic PII
 * scrubber across every free-form field; pass `scrubber: { disabled: true }`
 * to bypass (e.g. internal tests where the input is known-safe).
 */
export interface AssembleBundleOptions {
  scrubber?: ScrubberOptions;
}

export interface AssembleBundleInputs {
  feature: { name: string; file: string };
  scenario: {
    name: string;
    siblings: Array<{ name: string; status: SiblingStatus }>;
  };
  failedStep: {
    /** Raw Gherkin keyword (e.g. 'And ', 'When ') — normalised to a Given/When/Then/And/But token. */
    keyword: string;
    text: string;
    errorClass: string;
    errorMessage: string;
  };
  /** Set when the failure involves a locator binding; `null` otherwise. */
  locator: {
    name: string;
    strategy: string;
    value: string;
    file: string;
    line: number;             // 1-based
    fileContent: string;      // full source — assembler slices ±5 lines
  } | null;
  artifacts: {
    tracePath: string | null;
    /** Already-extracted DOM excerpt (HTML text). Assembler may trim it to fit the cap. */
    domExcerpt: string | null;
    screenshotPath: string | null;
  };
  context: {
    targetEnv: string;
    browser: string;
    viewport: string;
  };
  history: {
    recentDiffs: string;
    priorPgwenFixMarker: string | null;
  };
}

const VALID_KEYWORDS: ReadonlySet<StepKeyword> = new Set(['Given', 'When', 'Then', 'And', 'But']);

/**
 * Normalise a raw Gherkin keyword (which may carry trailing whitespace or
 * mixed casing) to the strict §12 union. Throws on `*` or unknown tokens.
 */
function normaliseKeyword(raw: string): StepKeyword {
  const trimmed = raw.trim();
  // Capitalise first letter, lowercase the rest — matches Gherkin conventions.
  const k = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  if (VALID_KEYWORDS.has(k as StepKeyword)) return k as StepKeyword;
  throw new Error(
    `assembleBundle: unsupported Gherkin keyword "${raw}". ` +
    `Expected one of: ${Array.from(VALID_KEYWORDS).join(', ')}.`
  );
}

/**
 * Build a ±5-line context slice around the binding line. Output is
 * line-numbered with a `>` marker on the binding line so the prompt
 * can point Claude at it without extra annotation.
 *
 *   8: …
 *   9: …
 *  10: …
 *  11: …
 * >12: submit button can be located by id "login-submit"
 *  13: …
 *  ...
 */
function sliceBindingContext(fileContent: string, line: number): string {
  const lines = fileContent.split('\n');
  const first = Math.max(1, line - 5);
  const last = Math.min(lines.length, line + 5);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    const marker = n === line ? '>' : ' ';
    out.push(`${marker}${String(n).padStart(width, ' ')}: ${lines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}

/**
 * Measure the JSON byte-size of a `DiagnoseInput`. Compact (no indent) —
 * the cap targets serialised payload, not pretty-printed form.
 */
function byteSize(bundle: DiagnoseInput): number {
  return Buffer.byteLength(JSON.stringify(bundle), 'utf8');
}

/** Trim a string from the END until total bundle size fits under the given cap. */
function trimDomExcerptToFit(bundle: DiagnoseInput, cap: number): DiagnoseInput {
  if (byteSize(bundle) <= cap) return bundle;
  // No DOM excerpt to trim — return as-is; caller decides whether to throw.
  if (bundle.artifacts.dom_excerpt === null) return bundle;

  // Binary-search the largest DOM excerpt prefix that fits.
  const original = bundle.artifacts.dom_excerpt;
  let lo = 0;
  let hi = original.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate: DiagnoseInput = {
      ...bundle,
      artifacts: { ...bundle.artifacts, dom_excerpt: mid === 0 ? null : original.slice(0, mid) },
    };
    if (byteSize(candidate) <= cap) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return {
    ...bundle,
    artifacts: { ...bundle.artifacts, dom_excerpt: best === 0 ? null : original.slice(0, best) },
  };
}

/**
 * Build a `DiagnoseInput` from already-resolved failure data. See §11 + §12.
 *
 * The PII scrubber runs by default across every free-form field BEFORE the
 * cap-trim logic, so size budgeting sees post-scrub content. Pass
 * `{ scrubber: { disabled: true } }` for the rare caller that has already
 * scrubbed upstream or is operating on internally-trusted text.
 *
 * @throws if the bundle cannot be brought under `DIAGNOSE_BUNDLE_HARD_CAP_BYTES`
 *   even after the DOM excerpt is dropped — that is a caller error
 *   (binding context or recent_diffs too large).
 */
export function assembleBundle(
  input: AssembleBundleInputs,
  options: AssembleBundleOptions = {},
): DiagnoseInput {
  const keyword = normaliseKeyword(input.failedStep.keyword);

  const bundle: DiagnoseInput = {
    failing: {
      feature_name: input.feature.name,
      feature_file: input.feature.file,
      scenario_name: input.scenario.name,
      step_text: input.failedStep.text,
      step_keyword: keyword,
      error_class: input.failedStep.errorClass,
      error_message: input.failedStep.errorMessage,
    },
    locator: input.locator
      ? {
          binding_name: input.locator.name,
          selector_strategy: input.locator.strategy,
          selector_value: input.locator.value,
          binding_line: input.locator.line,
          binding_file: input.locator.file,
          binding_context: sliceBindingContext(input.locator.fileContent, input.locator.line),
        }
      : null,
    artifacts: {
      trace_zip_path: input.artifacts.tracePath,
      dom_excerpt: input.artifacts.domExcerpt,
      screenshot_path: input.artifacts.screenshotPath,
    },
    context: {
      target_env: input.context.targetEnv,
      browser: input.context.browser,
      viewport: input.context.viewport,
      sibling_scenarios: input.scenario.siblings.map((s) => ({ name: s.name, status: s.status })),
    },
    history: {
      recent_diffs: input.history.recentDiffs,
      prior_pgwen_fix_marker: input.history.priorPgwenFixMarker,
    },
  };

  // Generic PII scrubber runs BEFORE cap-trim so size budgeting reflects
  // the post-scrub content. Disable via `options.scrubber.disabled = true`.
  const scrubbed = scrubDiagnoseInput(bundle, options.scrubber ?? {});

  // Trim DOM excerpt down to the soft cap so the typical bundle stays small.
  const softTrimmed = trimDomExcerptToFit(scrubbed, DIAGNOSE_BUNDLE_SOFT_CAP_BYTES);
  if (byteSize(softTrimmed) <= DIAGNOSE_BUNDLE_HARD_CAP_BYTES) return softTrimmed;

  // Soft pass didn't get us under the HARD cap either; try a second pass
  // (this only differs when SOFT < HARD and the original was already
  // somehow large — kept for safety).
  const hardTrimmed = trimDomExcerptToFit(softTrimmed, DIAGNOSE_BUNDLE_HARD_CAP_BYTES);
  if (byteSize(hardTrimmed) <= DIAGNOSE_BUNDLE_HARD_CAP_BYTES) return hardTrimmed;

  throw new Error(
    `assembleBundle: bundle is ${byteSize(hardTrimmed)} bytes even with the DOM excerpt removed, ` +
    `exceeding the ${DIAGNOSE_BUNDLE_HARD_CAP_BYTES}-byte hard cap. ` +
    `Check binding_context and recent_diffs — one of them is too large.`
  );
}

// ─── RunResult facade — bridge from execution layer to DiagnoseInput ────────

/**
 * Caller-resolved inputs that the Assembler facade cannot derive from a
 * RunResult alone. Locator + history + env context still need scope
 * inspection or external lookups (git, config) the caller owns.
 */
export interface BundleForFailedStepArgs {
  runResult: RunResult;
  /** Name of the failed scenario inside `runResult.scenarios`. */
  scenarioName: string;
  /** The specific failed step to diagnose — typically a leaf from a tree walk. */
  failedStep: StepResult;
  /** Locator binding info; null when the failure has no resolvable locator. */
  locator: AssembleBundleInputs['locator'];
  targetEnv: string;
  browser: string;
  viewport: string;
  recentDiffs: string;
  priorPgwenFixMarker: string | null;
  /**
   * Override the DOM excerpt instead of extracting it from `runResult.tracePath`.
   * Mostly used in tests; in production this is left undefined and the
   * facade calls `extractPreFailureDom` on the trace.zip.
   */
  domExcerptOverride?: string | null;
  /**
   * PII scrubber options passed through to `assembleBundle`. Default is
   * scrubber-on with the built-in rule set; pass `extraPatterns` here for
   * domain-specific regexes (e.g. internal ID formats).
   */
  scrubber?: ScrubberOptions;
}

/**
 * Build a §12 DiagnoseInput for a single failed step in a feature's
 * RunResult. Reads the trace.zip via `extractPreFailureDom` to populate
 * `dom_excerpt` when `runResult.tracePath` is set. Returns `null` if the
 * named scenario does not exist on the RunResult.
 *
 * This is the production entry point that AI-backed `pgwen diagnose`
 * (forthcoming) will call. The rule-based path (`--rules-only`) does not
 * need it — it reads `results.json` directly.
 */
export async function buildBundleForFailedStep(
  args: BundleForFailedStepArgs,
): Promise<DiagnoseInput | null> {
  const scenario = args.runResult.scenarios.find((s) => s.scenarioName === args.scenarioName);
  if (!scenario) return null;

  let domExcerpt: string | null;
  if (args.domExcerptOverride !== undefined) {
    domExcerpt = args.domExcerptOverride;
  } else if (args.runResult.tracePath) {
    domExcerpt = await extractPreFailureDom(args.runResult.tracePath);
  } else {
    domExcerpt = null;
  }

  const siblings = args.runResult.scenarios.map((s) => ({
    name: s.scenarioName,
    status: s.status,
  }));

  const inputs: AssembleBundleInputs = {
    feature: { name: args.runResult.featureName, file: args.runResult.featureFile },
    scenario: { name: scenario.scenarioName, siblings },
    failedStep: {
      keyword: (args.failedStep.originalKeyword ?? args.failedStep.effectiveKeyword).trim(),
      text: args.failedStep.stepText,
      errorClass: args.failedStep.error?.constructor?.name ?? 'Error',
      errorMessage: args.failedStep.error?.message ?? '',
    },
    locator: args.locator,
    artifacts: {
      tracePath: args.runResult.tracePath ?? null,
      domExcerpt,
      screenshotPath: scenario.screenshotPath ?? null,
    },
    context: {
      targetEnv: args.targetEnv,
      browser: args.browser,
      viewport: args.viewport,
    },
    history: {
      recentDiffs: args.recentDiffs,
      priorPgwenFixMarker: args.priorPgwenFixMarker,
    },
  };

  return assembleBundle(inputs, args.scrubber ? { scrubber: args.scrubber } : {});
}
