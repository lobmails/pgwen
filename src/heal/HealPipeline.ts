/**
 * src/heal/HealPipeline.ts — heal-attempt orchestrator.
 *
 * One attempt = gate → bundle → prompt → AI call → validate → cache →
 * telemetry. Returns `{healed, newSelector?, outcome}` so the caller
 * (eventually a runner action site) can retry once with the new
 * selector.
 *
 * **Phase 3.6a scope:** this module is callable end-to-end with a
 * mock or live AI adapter, but is NOT yet wired into the engine. The
 * runner integration (Phase 3.6b) requires threading the pipeline
 * through every action-site locator timeout — that's a separate
 * refactor with its own parity-risk review.
 *
 * Cost contract: when ANY pre-Claude gate denies, no AI call is made
 * (zero cost). When the AI call IS made and a proposal arrives, the
 * validator may still reject it — the call cost is recorded in
 * telemetry but the original step continues to fail.
 */

import type { AiClient } from '../diagnose/ai/types';
import type {
  HealConfig,
  HealHistoryEntry,
  HealPipelineResult,
  HealProposal,
  HealSelector,
  LocatorMetadata,
} from './types';
import type { HealCache } from './HealCache';
import { shouldAttempt } from './HealGate';
import { buildHealBundle, type PageContentSource } from './HealBundle';
import { buildHealPrompt } from './HealPrompt';
import { validate as validateProposal, type PageValidatorSource } from './HealValidator';

// ─── Public surface — orchestrator types ───────────────────────────────────

export interface HealPipelineDeps {
  client: AiClient;
  cache: HealCache;
  /** Page surfaces used for bundle assembly + validator queries. */
  page: PageContentSource & PageValidatorSource;
  /** Telemetry sink — append-only JSONL writer set up by the runner. */
  appendTelemetry: (entry: HealHistoryEntry) => void;
  /** Caller-supplied "now" for deterministic tests. */
  now?: () => Date;
}

export interface HealAttemptContext {
  config: HealConfig;
  pgwen_version: string;
  feature: string;
  scenario: string;
  scenarioId: string;
  binding_name: string;
  binding_intent: string;
  step_being_executed: string;
  original_selector: HealSelector;
  locator_meta?: LocatorMetadata;
  /** Resolved API key — null when missing (gate denies). */
  apiKey: string | null;
  failure_class:
    | 'LOCATOR_NOT_FOUND'
    | 'ASSERTION_FAILED'
    | 'TIMEOUT'
    | 'NAVIGATION_FAILURE'
    | 'AUTH_FAILURE'
    | 'UNKNOWN';
  is_locator_step_shape: boolean;
  is_try_wrapped: boolean;
  is_no_heal_annotated: boolean;
  attempts: {
    perStep: number;
    perScenario: number;
    perRun: number;
  };
  usd_spent_this_run: number;
  /** Last heal time for this binding (cooldown check). */
  last_healed_at?: Date;
  step_duration_ms_before_heal: number;
}

/**
 * Attempt one heal. Pure orchestration — the gate decisions, bundle
 * assembly, prompt build, validator call, cache write, and telemetry
 * write are all delegated to the modules from earlier phases.
 *
 * Returns the result the caller acts on:
 *   - healed === true  → call site retries the lookup with `newSelector`
 *   - healed === false → call site surfaces the original failure
 *
 * The `outcome` field distinguishes WHY heal didn't fire — used by
 * the orchestrator's CI dashboards (Phase 3.8) and the HTML report
 * (Phase 3.7).
 */
export async function attempt(
  ctx: HealAttemptContext,
  deps: HealPipelineDeps,
): Promise<HealPipelineResult> {
  const now = (deps.now ?? (() => new Date()))();

  // 1. Run the gate stack.
  const gate = shouldAttempt({
    config: ctx.config,
    binding_name: ctx.binding_name,
    apiKey: ctx.apiKey,
    failure_class: ctx.failure_class,
    is_locator_step_shape: ctx.is_locator_step_shape,
    is_try_wrapped: ctx.is_try_wrapped,
    is_no_heal_annotated: ctx.is_no_heal_annotated,
    has_locator_ancestor_timeout: ctx.failure_class === 'ASSERTION_FAILED',
    attempts: ctx.attempts,
    usd_spent_this_run: ctx.usd_spent_this_run,
    ...(ctx.last_healed_at !== undefined ? { last_healed_at: ctx.last_healed_at } : {}),
    now,
  });

  if (!gate.allow) {
    recordTelemetry(deps, ctx, {
      outcome: gate.outcome ?? 'gate_disabled',
      now,
      healed_selector: null,
      claude_confidence: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      estimated_cost_usd: 0,
      step_duration_ms_after_heal: null,
    });
    return {
      healed: false,
      outcome: gate.outcome ?? 'gate_disabled',
      ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
    };
  }

  // 2. Assemble the bundle (PII-scrubbed, size-capped).
  const bundle = await buildHealBundle({
    page: deps.page,
    binding_name: ctx.binding_name,
    binding_intent: ctx.binding_intent,
    original_selector: ctx.original_selector,
    step_being_executed: ctx.step_being_executed,
    pgwen_version: ctx.pgwen_version,
    scrubberExtraPatterns: ctx.config.scrubber.extraPatterns,
    ...(ctx.locator_meta !== undefined ? { locator_meta: ctx.locator_meta } : {}),
  });

  // 3. Build the request body + call Claude.
  const body = buildHealPrompt(bundle, { targetConfidence: ctx.config.confidence.minimum });
  const ai: AiClient = deps.client;
  let aiResult;
  try {
    aiResult = await ai.call(body);
  } catch (err) {
    const reason = `AI call failed: ${(err as Error).message}`;
    recordTelemetry(deps, ctx, {
      outcome: 'gate_no_api_key', // closest existing outcome — AI surface failed
      now,
      healed_selector: null,
      claude_confidence: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      estimated_cost_usd: 0,
      step_duration_ms_after_heal: null,
    });
    return { healed: false, outcome: 'gate_no_api_key', reason };
  }

  // 4. Parse + confidence-floor check. Claude's diagnose-shaped output
  //    is repurposed for heal: the proposal lives in machine_proposal
  //    when category=locator_drift+confidence=high; here we re-derive
  //    the heal-specific HealProposal shape from the raw output.
  const proposal = extractProposal(aiResult.output);
  if (proposal === null) {
    recordTelemetry(deps, ctx, {
      outcome: 'claude_low_confidence',
      now,
      healed_selector: null,
      claude_confidence: null,
      model: aiResult.model,
      tokens_in: aiResult.usage.inputTokens,
      tokens_out: aiResult.usage.outputTokens,
      estimated_cost_usd: 0,
      step_duration_ms_after_heal: null,
    });
    return {
      healed: false,
      outcome: 'claude_low_confidence',
      reason: 'Claude returned no usable proposal (low confidence or null machine_proposal)',
    };
  }

  if (!meetsConfidenceFloor(proposal, ctx.config.confidence.minimum)) {
    recordTelemetry(deps, ctx, {
      outcome: 'claude_low_confidence',
      now,
      healed_selector: null,
      claude_confidence: proposal.confidence,
      model: aiResult.model,
      tokens_in: aiResult.usage.inputTokens,
      tokens_out: aiResult.usage.outputTokens,
      estimated_cost_usd: 0,
      step_duration_ms_after_heal: null,
    });
    return {
      healed: false,
      outcome: 'claude_low_confidence',
      reason: `Claude confidence ${proposal.confidence} below minimum ${ctx.config.confidence.minimum}`,
    };
  }

  // 5. Validate against the live page.
  const validation = await validateProposal({
    page: deps.page,
    proposal,
    original: ctx.original_selector,
    ...(ctx.locator_meta !== undefined ? { locator_meta: ctx.locator_meta } : {}),
    requireExactOneMatch: ctx.config.validation.requireExactOneMatch,
    requireTagMatch: ctx.config.validation.requireTagMatch,
  });

  if (!validation.ok) {
    const outcome =
      validation.reason === 'zero_match'    ? 'validator_zero_match'
    : validation.reason === 'multi_match'   ? 'validator_multi_match'
    : validation.reason === 'tag_mismatch'  ? 'validator_tag_mismatch'
    : validation.reason === 'no_change'     ? 'validator_no_change'
    : 'validator_zero_match';
    recordTelemetry(deps, ctx, {
      outcome,
      now,
      healed_selector: null,
      claude_confidence: proposal.confidence,
      model: aiResult.model,
      tokens_in: aiResult.usage.inputTokens,
      tokens_out: aiResult.usage.outputTokens,
      estimated_cost_usd: 0,
      step_duration_ms_after_heal: null,
    });
    return { healed: false, outcome, reason: `validator rejected: ${validation.reason}` };
  }

  // 6. All gates + validator passed. Record in cache + telemetry.
  const newSelector: HealSelector = {
    type: proposal.selector_type,
    value: proposal.selector_value,
  };
  deps.cache.record(ctx.scenarioId, ctx.binding_name, newSelector, now);

  recordTelemetry(deps, ctx, {
    outcome: 'healed',
    now,
    healed_selector: serialiseSelector(newSelector),
    claude_confidence: proposal.confidence,
    model: aiResult.model,
    tokens_in: aiResult.usage.inputTokens,
    tokens_out: aiResult.usage.outputTokens,
    estimated_cost_usd: 0, // cost computed by the orchestrator from tokens + pricing table
    step_duration_ms_after_heal: null, // populated by the caller after the retry returns
  });

  return {
    healed: true,
    newSelector,
    outcome: 'healed',
    reason: proposal.reasoning,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract a HealProposal from Claude's diagnose-shaped output. Heal
 * uses the same `propose_locator` tool surface as diagnose's
 * `report_diagnosis` — but the AiCallResult.output type is the
 * diagnose `DiagnoseOutput` shape. When Claude is forced to call
 * `propose_locator` instead, the adapter returns a different
 * payload — for the mock path that returns a synthetic locator-drift
 * `DiagnoseOutput` with a populated machine_proposal, this function
 * unwraps it.
 *
 * Returns null when no usable proposal is present (e.g. category !==
 * locator_drift, or machine_proposal === null).
 */
function extractProposal(output: unknown): HealProposal | null {
  // Diagnose path: AiCallResult.output is DiagnoseOutput; the
  // proposal lives in machine_proposal. The MockAdapter fixtures
  // return this shape today, so heal can reuse the same fixtures.
  const o = output as {
    category?: string;
    confidence?: string;
    machine_proposal?: { binding_name: string; file: string; line: number; old: string; new: string } | null;
    human_explanation?: string;
    expected_element_tag?: string;
    // Native heal path (Phase 3.6b — when the propose_locator tool is wired):
    selector_type?: HealProposal['selector_type'];
    selector_value?: string;
    reasoning?: string;
  };

  // Native propose_locator shape — preferred when present.
  if (
    typeof o.selector_type === 'string' &&
    typeof o.selector_value === 'string' &&
    typeof o.confidence === 'string'
  ) {
    return {
      selector_type: o.selector_type,
      selector_value: o.selector_value,
      confidence: o.confidence as HealProposal['confidence'],
      reasoning: o.reasoning ?? '',
      ...(o.expected_element_tag !== undefined ? { expected_element_tag: o.expected_element_tag } : {}),
    };
  }

  // Diagnose-shape fallback — repurposes a locator_drift output's
  // machine_proposal into a HealProposal. The `new` text is the
  // proposed selector. This only works if the proposal was generated
  // for a binding line, but the mock fixtures match.
  if (o.category === 'locator_drift' && o.machine_proposal) {
    return {
      // Without more info we assume css; mock fixtures supply css.
      selector_type: 'css',
      selector_value: extractSelectorFromBindingLine(o.machine_proposal.new),
      confidence: (o.confidence ?? 'low') as HealProposal['confidence'],
      reasoning: o.human_explanation ?? '',
    };
  }

  return null;
}

/**
 * Extract the selector value from a Gherkin `<element> can be located
 * by <type> "<value>"` line. Heal uses this to bridge diagnose-shape
 * proposals into HealProposal — Phase 3.6b will switch to the native
 * `propose_locator` tool and this fallback becomes dead code.
 */
function extractSelectorFromBindingLine(line: string): string {
  const m = /can be located by \w+ "([^"]+)"/i.exec(line);
  return m ? m[1]! : line;
}

function meetsConfidenceFloor(
  proposal: HealProposal,
  floor: HealProposal['confidence'],
): boolean {
  const order: HealProposal['confidence'][] = ['low', 'medium', 'high'];
  return order.indexOf(proposal.confidence) >= order.indexOf(floor);
}

function serialiseSelector(s: HealSelector): string {
  return `${s.type}: ${s.value}`;
}

function recordTelemetry(
  deps: HealPipelineDeps,
  ctx: HealAttemptContext,
  pieces: {
    outcome: HealHistoryEntry['outcome'];
    now: Date;
    healed_selector: string | null;
    claude_confidence: HealHistoryEntry['claude_confidence'];
    model: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    estimated_cost_usd: number;
    step_duration_ms_after_heal: number | null;
  },
): void {
  const entry: HealHistoryEntry = {
    timestamp: pieces.now.toISOString(),
    feature: ctx.feature,
    scenario: ctx.scenario,
    binding_name: ctx.binding_name,
    original_selector: serialiseSelector(ctx.original_selector),
    outcome: pieces.outcome,
    healed_selector: pieces.healed_selector,
    claude_confidence: pieces.claude_confidence,
    model: pieces.model,
    tokens_in: pieces.tokens_in,
    tokens_out: pieces.tokens_out,
    estimated_cost_usd: pieces.estimated_cost_usd,
    step_duration_ms_before_heal: ctx.step_duration_ms_before_heal,
    step_duration_ms_after_heal: pieces.step_duration_ms_after_heal,
    human_review_outcome: null,
  };
  deps.appendTelemetry(entry);
}

// (HealAttemptContext / HealPipelineDeps are defined above and exported there.)
