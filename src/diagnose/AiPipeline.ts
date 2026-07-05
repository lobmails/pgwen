/**
 * AiPipeline.ts — orchestrates a single AI-backed diagnose call
 * (Phase 6 of §16).
 *
 * Per failure, walks through every cost lever before talking to Claude:
 *
 *   build bundle → scrub PII → cache lookup → rate limit → cost estimate
 *     → budget gate → Claude call → record actual cost → cache save
 *
 * Each gate that says "no" short-circuits and returns a `skipped` result
 * with a `reason` field. Callers aggregate these into the user-facing
 * report so it's obvious WHY a call didn't happen.
 *
 * Pure-ish: all I/O happens through injected deps (cache, claude client,
 * trace extractor). Tests pass fakes; the runtime path uses the real
 * modules.
 */

import * as path from 'path';
import {
  assembleBundle,
  type AssembleBundleInputs,
} from './Assembler';
import { extractPreFailureDom } from './TraceExtractor';
import {
  buildPrompt,
  type PromptOptions,
  type PromptRequestBody,
} from './Prompt';
import {
  cacheKey,
  loadCachedDiagnosis,
  saveCachedDiagnosis,
  DIAGNOSIS_CACHE_SUBDIR,
} from './ResponseCache';
import {
  estimateCallCostUsd,
  type BudgetGate,
  type PricingTier,
} from './BudgetGate';
import type { RateLimit } from './RateLimit';
import type { FailureClassification } from './Classifier';
import type { ScrubberOptions } from './Scrubber';
import type { DiagnoseInput, DiagnoseOutput } from './types';
import type { ClaudeCallResult } from './ClaudeClient';
import { DEFAULT_PRICING } from './BudgetGate';

// ─── Public types ──────────────────────────────────────────────────────────

export type SiblingStatus = 'passed' | 'failed' | 'skipped';

export interface FailureToDiagnose {
  feature: { name: string; file: string };
  scenario: { name: string; siblings: Array<{ name: string; status: SiblingStatus }> };
  step: { keyword: string; text: string; errorClass: string; errorMessage: string };
  /** Rule-based classifier output, gates model selection. */
  prior: FailureClassification | null;
  /** Path to the feature's trace.zip, or null if traces aren't captured. */
  tracePath: string | null;
  context: { targetEnv: string; browser: string; viewport: string };
  /**
   * Meta files loaded for this failure's parent feature. Used by the
   * LocatorLookup heuristic; empty array when not available.
   */
  metaFiles?: ReadonlyArray<string>;
}

/**
 * A minimal Claude client interface so AiPipeline tests can inject a
 * fake without spinning up the real fetch wrapper.
 */
export interface ClaudeClientLike {
  call(body: PromptRequestBody): Promise<ClaudeCallResult>;
}

/**
 * Optional trace-extraction override. Defaults to the real
 * extractPreFailureDom; tests can pass a fixture function.
 */
export type DomExtractor = (tracePath: string) => Promise<string | null>;

/**
 * Optional recent-diff fetcher. Receives the set of files involved in
 * the failure and returns the formatted git-log diff (capped).
 */
export type RecentDiffsFetcher = (files: ReadonlyArray<string>) => Promise<string>;

/**
 * Optional locator lookup. Given a failed step's text and feature file,
 * returns the binding the failure most likely references. Builders
 * compose this from `buildLocatorIndex` + `findLocatorForStep`.
 */
export type LocatorLookup = (failure: FailureToDiagnose) => {
  name: string;
  selector_strategy: string;
  selector_value: string;
  binding_file: string;
  binding_line: number;
  file_content: string;
} | null;

export interface AiPipelineDeps {
  claude: ClaudeClientLike;
  /** Base reports directory; the cache lives under `<reportsDir>/diagnosis-cache/`. */
  reportsDir: string;
  budget?: BudgetGate;
  rateLimit?: RateLimit;
  /** Per-model pricing. Defaults to DEFAULT_PRICING. */
  pricing?: Record<string, PricingTier>;
  /** Inject for tests. Defaults to the real trace.zip extractor. */
  extractDom?: DomExtractor;
  /** When set, populates `DiagnoseInput.locator` from parsed meta files. */
  locatorLookup?: LocatorLookup;
  /** When set, populates `DiagnoseInput.history.recent_diffs` from git log. */
  recentDiffsFor?: RecentDiffsFetcher;
}

export interface AiPipelineOptions {
  /** Skip the cache lookup (still saves to cache afterwards). */
  noCache?: boolean;
  /** Forwarded to the bundle scrubber. */
  scrubber?: ScrubberOptions;
  /** Forwarded to buildPrompt. */
  prompt?: PromptOptions;
  /** Bypass the actual Claude call — used by `pgwen diagnose --dry-run`. */
  dryRun?: boolean;
}

export type AiPipelineSource = 'cache' | 'fresh' | 'skipped';

export interface AiPipelineResult {
  failure: FailureToDiagnose;
  source: AiPipelineSource;
  /** Present when source is 'cache' or 'fresh'. Null when skipped. */
  output: DiagnoseOutput | null;
  /** Free-form reason when source is 'skipped'. */
  reason?: string;
  /** SHA-256 of the canonical bundle — also the cache key. */
  cacheKey: string;
  /** Pre-call cost estimate in USD. */
  estimatedUsd?: number;
  /** Actual USD cost (only populated for 'fresh'). */
  actualUsd?: number;
  /** Which model produced the answer (cache or fresh). */
  model?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────

const APPROX_BYTES_PER_TOKEN = 3; // conservative — overshoots for Latin text

export async function runAiDiagnose(
  failure: FailureToDiagnose,
  deps: AiPipelineDeps,
  opts: AiPipelineOptions = {},
): Promise<AiPipelineResult> {
  const pricing = deps.pricing ?? DEFAULT_PRICING;
  const cacheDir = path.join(deps.reportsDir, DIAGNOSIS_CACHE_SUBDIR);

  // 1. Build the bundle (extract DOM if tracePath, scrub PII, cap size).
  const bundle = await buildBundle(failure, deps, opts);
  const key = cacheKey(bundle);

  // 2. Cache lookup.
  if (!opts.noCache) {
    const cached = loadCachedDiagnosis(bundle, cacheDir);
    if (cached) {
      const result: AiPipelineResult = {
        failure,
        source: 'cache',
        output: cached.diagnoseOutput,
        cacheKey: key,
      };
      if (cached.model !== undefined) result.model = cached.model;
      return result;
    }
  }

  // 3. Build the prompt + estimate cost before any side effects.
  const promptBody = buildPrompt(bundle, failure.prior, opts.prompt ?? {});
  const estimatedUsd = estimateRequestCost(promptBody, pricing);

  // 4. Rate limit BEFORE budget — rate-limit feedback is the most
  //    actionable hint to the caller (slow down vs. spend differently).
  if (deps.rateLimit && !deps.rateLimit.tryAcquire()) {
    return {
      failure, source: 'skipped',
      output: null, reason: 'rate-limited',
      cacheKey: key, estimatedUsd,
    };
  }

  // 5. Budget gate.
  if (deps.budget) {
    const check = deps.budget.canSpend(estimatedUsd);
    if (!check.ok) {
      return {
        failure, source: 'skipped',
        output: null, reason: check.reason ?? 'budget-exceeded',
        cacheKey: key, estimatedUsd,
      };
    }
  }

  // 6. Dry-run bails here, after gates have been exercised, before
  //    any network or cache write.
  if (opts.dryRun) {
    return {
      failure, source: 'skipped',
      output: null, reason: 'dry-run',
      cacheKey: key, estimatedUsd,
    };
  }

  // 7. Call Claude. Errors bubble up — the CLI catches per-failure so
  //    one failure's API problem doesn't kill the whole report run.
  const response = await deps.claude.call(promptBody);

  // 8. Compute actual cost and record.
  const actualUsd = estimateCallCostUsd(
    {
      model: response.model,
      inputTokens: response.usage.inputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      outputTokens: response.usage.outputTokens,
    },
    pricing,
  );
  if (deps.budget) deps.budget.record(actualUsd, { model: response.model });

  // 9. Persist to cache.
  saveCachedDiagnosis(bundle, response.output, cacheDir, {
    model: response.model,
    tokensIn: response.usage.inputTokens,
    tokensOut: response.usage.outputTokens,
  });

  return {
    failure,
    source: 'fresh',
    output: response.output,
    cacheKey: key,
    estimatedUsd,
    actualUsd,
    model: response.model,
  };
}

// ─── Bundle + cost helpers ────────────────────────────────────────────────

async function buildBundle(
  failure: FailureToDiagnose,
  deps: AiPipelineDeps,
  opts: AiPipelineOptions,
): Promise<DiagnoseInput> {
  const extractor = deps.extractDom ?? extractPreFailureDom;
  const domExcerpt = failure.tracePath ? await extractor(failure.tracePath) : null;

  // Locator metadata — populated when the LocatorLookup heuristic finds
  // a binding whose name appears in the failing step text. The
  // assembler slices ±5 lines of context from `fileContent`.
  const found = deps.locatorLookup?.(failure) ?? null;
  const locator: AssembleBundleInputs['locator'] = found
    ? {
        name: found.name,
        strategy: found.selector_strategy,
        value: found.selector_value,
        file: found.binding_file,
        line: found.binding_line,
        fileContent: found.file_content,
      }
    : null;

  // Recent diffs — only fetch when the caller wired it AND we have
  // files to filter against. Feature file is always involved; binding
  // file is added when we found one. Anything else would inflate the
  // payload past §12's budget for no signal gain.
  let recentDiffs = '';
  if (deps.recentDiffsFor) {
    const involved = new Set<string>([failure.feature.file]);
    if (found) involved.add(found.binding_file);
    recentDiffs = await deps.recentDiffsFor([...involved]);
  }

  const inputs: AssembleBundleInputs = {
    feature: { name: failure.feature.name, file: failure.feature.file },
    scenario: { name: failure.scenario.name, siblings: failure.scenario.siblings },
    failedStep: {
      keyword: failure.step.keyword,
      text: failure.step.text,
      errorClass: failure.step.errorClass,
      errorMessage: failure.step.errorMessage,
    },
    locator,
    artifacts: {
      tracePath: failure.tracePath,
      domExcerpt,
      screenshotPath: null,
    },
    context: {
      targetEnv: failure.context.targetEnv,
      browser: failure.context.browser,
      viewport: failure.context.viewport,
    },
    history: { recentDiffs, priorPgwenFixMarker: null },
  };

  return assembleBundle(inputs, opts.scrubber ? { scrubber: opts.scrubber } : {});
}

/**
 * Conservative cost estimate for a prompt — assumes ~3 bytes per token
 * (overshoots Latin text on purpose so budget gating errs on the safe
 * side) and uses the prompt body's `max_tokens` as the output bound.
 *
 * Cached-token guesses pre-call would be guesswork; treat all input
 * as fresh for the estimate. Post-call, the actual usage object from
 * Anthropic carries the real cache split.
 */
export function estimateRequestCost(
  body: PromptRequestBody,
  pricing: Record<string, PricingTier> = DEFAULT_PRICING,
): number {
  let bytes = 0;
  for (const block of body.system) bytes += block.text.length;
  for (const m of body.messages) bytes += m.content.length;
  // Tool schemas are also part of the request but typically dwarf-by-
  // bundle size; conservatively add their stringified length.
  for (const t of body.tools) {
    bytes += t.name.length + t.description.length + JSON.stringify(t.input_schema).length;
  }
  const approxInputTokens = Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
  return estimateCallCostUsd(
    { model: body.model, inputTokens: approxInputTokens, outputTokens: body.max_tokens },
    pricing,
  );
}
