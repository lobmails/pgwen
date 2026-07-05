/**
 * src/heal/types.ts — runtime self-heal (AI-3) types.
 *
 * Source of truth for the heal track's data contracts, per the
 * `pgwen-ai-heal-strategy.md` §8 (bundle/prompt) + §9 (telemetry) +
 * §10 (config). The runtime heal pipeline assembles a HealBundle when
 * a locator wait times out, hands it to Claude through the
 * `propose_locator` tool, validates the response, and either applies
 * the healed selector (one retry, no loop) or surfaces the original
 * failure.
 *
 * v1 scope: locator-binding rebinds only. NOT assertions, timing,
 * data, or API failures (strategy §4).
 *
 * Module shape only — wire-up lives in HealPipeline.ts (Phase 3.6).
 */

import type { DiagnoseConfidence } from '../diagnose/types';

// ─── Selector tier ─────────────────────────────────────────────────────────

/**
 * The same locator strategy tokens pgwen's `can be located by` DSL
 * supports. Heal proposes selectors in one of these forms; the
 * validator + retry path consume the proposal through the existing
 * `buildLocator` surface, so no new locator-resolution code is needed.
 */
export type HealSelectorType = 'id' | 'name' | 'css' | 'xpath' | 'text' | 'js';

export interface HealSelector {
  type: HealSelectorType;
  value: string;
}

// ─── Bundle (input to Claude) ──────────────────────────────────────────────

/**
 * Strategy §8. The narrower payload sent to Claude for runtime heal —
 * smaller than the diagnose bundle (no recent_diffs by default, no
 * sibling scenarios, no trace.zip).
 */
export interface HealInput {
  pgwen_version: string;
  /** Binding name verbatim from the `.meta` step (e.g. "the example field"). */
  binding_name: string;
  /** The step text that declared the binding — gives Claude semantic context. */
  binding_intent: string;
  original_selector: HealSelector;
  /** The step text that triggered the lookup (often differs from binding_intent). */
  step_being_executed: string;
  dom: {
    /** UTF-8 HTML, scrubber-processed, size-capped (25 KB soft, 50 KB hard). */
    html: string;
    /** True when the bundle was trimmed to fit the cap. */
    truncated: boolean;
  };
  /** Optional locator metadata — tag, role, parent class hints. From LocatorIndex when available. */
  locator_meta?: LocatorMetadata;
  /** Opt-in: recent git diffs touching the .meta file. Gated by pgwen.heal.recentDiffs.enabled. */
  recent_diffs?: string;
}

export interface LocatorMetadata {
  /** Expected tag name on the original element, e.g. "button", "input". */
  expected_tag?: string;
  /** Expected ARIA role, e.g. "button", "textbox". */
  expected_role?: string;
  /** Parent-class hints for stability — first non-utility class on the parent chain. */
  parent_class_hints?: string[];
}

// ─── Proposal (output from Claude) ─────────────────────────────────────────

/**
 * Strategy §8. What Claude returns via the `propose_locator` forced
 * tool call. Validator then checks confidence, exact-one-match, and
 * tag sanity before any application.
 */
export interface HealProposal {
  selector_type: HealSelectorType;
  selector_value: string;
  confidence: DiagnoseConfidence;
  /** Free-form Claude rationale. Max 500 chars (enforced by tool schema). */
  reasoning: string;
  /** Optional sanity hint — used by the tag-class validator gate (§6.9). */
  expected_element_tag?: string;
}

// ─── Telemetry (strategy §9) ────────────────────────────────────────────────

/**
 * One JSONL line in `reports/heal-history/<run-id>.jsonl`. EVERY heal
 * attempt writes one (passed gates / declined / succeeded / failed) —
 * the schema covers every outcome so the measurement loop in
 * `pgwen heal --report` (Phase 3.8) is uniform.
 */
export interface HealHistoryEntry {
  timestamp: string;
  feature: string;
  scenario: string;
  binding_name: string;
  original_selector: string;
  outcome: HealOutcome;
  healed_selector: string | null;
  claude_confidence: DiagnoseConfidence | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  estimated_cost_usd: number;
  step_duration_ms_before_heal: number;
  step_duration_ms_after_heal: number | null;
  /** Populated post-hoc via `pgwen heal --annotate` (Phase 3.8). */
  human_review_outcome: 'correct_heal' | 'wrong_element' | 'unable_to_determine' | null;
}

/**
 * Every distinguishable outcome a heal attempt can have. Used as the
 * `outcome` discriminator in `HealHistoryEntry` and as the API surface
 * the pipeline returns to its caller.
 */
export type HealOutcome =
  // Successful heal — selector validated and retried.
  | 'healed'
  // Claude returned medium / low confidence — gate §6.7.
  | 'claude_low_confidence'
  // Validator: proposed selector matched zero elements — gate §6.8.
  | 'validator_zero_match'
  // Validator: proposed selector matched 2+ elements — gate §6.8.
  | 'validator_multi_match'
  // Validator: element tag/class did not match the binding's intent — gate §6.9.
  | 'validator_tag_mismatch'
  // Validator: proposal equals the original selector (no useful change).
  | 'validator_no_change'
  // Gate denials.
  | 'gate_budget'
  | 'gate_rate_limit'
  | 'gate_no_api_key'
  | 'gate_cooldown'
  | 'gate_class_mismatch'
  | 'gate_annotation_excluded'
  | 'gate_disabled'
  | 'gate_step_shape'
  | 'gate_failure_class';

// ─── Gate result ───────────────────────────────────────────────────────────

/**
 * `HealGate.shouldAttempt()` returns this. When `allow=false`, the
 * pipeline records the deny reason in telemetry and skips the heal
 * attempt — original behaviour is preserved exactly.
 */
export type GateName =
  | 'enabled'
  | 'apiKey'
  | 'stepShape'
  | 'failureClass'
  | 'budget'
  | 'piiScrubber'
  | 'cooldown'
  | 'noHealAnnotation';

export interface GateResult {
  allow: boolean;
  /** Set when `allow=false` — identifies which gate denied. */
  deniedBy?: GateName;
  /** Maps to a telemetry HealOutcome — set when allow=false. */
  outcome?: HealOutcome;
  /** Free-form detail for the human reviewer (e.g. "budget exceeded: $0.51 of $0.50"). */
  reason?: string;
}

// ─── Pipeline outcome ──────────────────────────────────────────────────────

/**
 * The return value of `HealPipeline.attempt()`. The caller (binding-wait
 * site in `bindings/locators.ts`) uses `healed=true` + `newSelector`
 * to retry the lookup once.
 */
export interface HealPipelineResult {
  healed: boolean;
  newSelector?: HealSelector;
  outcome: HealOutcome;
  /** Free-form detail for telemetry / debugging. */
  reason?: string;
}

// ─── Config (strategy §10) ──────────────────────────────────────────────────

/**
 * Typed shape of `pgwen.heal.*` config. Read from the flat-keyed config
 * dict by `HealConfig.fromConfig()`. Defaults from strategy §10:
 *   - enabled = false
 *   - mode = "session"
 *   - budget defaults: 1 / 3 / 10 attempts; $0.50 / run
 *   - confidence.minimum = "high"
 *   - validation: requireExactOneMatch + requireTagMatch
 *   - cooldown = 300 seconds
 *   - recentDiffs.enabled = false
 *   - report.includeInHtml = true
 */
export interface HealConfig {
  enabled: boolean;
  mode: 'session' | 'persist';
  budget: {
    maxAttemptsPerStep: number;
    maxAttemptsPerScenario: number;
    maxAttemptsPerRun: number;
    maxUsdPerRun: number;
  };
  confidence: {
    minimum: DiagnoseConfidence;
  };
  validation: {
    requireExactOneMatch: boolean;
    requireTagMatch: boolean;
  };
  cooldown: {
    seconds: number;
  };
  recentDiffs: {
    enabled: boolean;
  };
  scrubber: {
    extraPatterns: string[];
  };
  report: {
    includeInHtml: boolean;
  };
}

export const DEFAULT_HEAL_CONFIG: HealConfig = {
  enabled: false,
  mode: 'session',
  budget: {
    maxAttemptsPerStep: 1,
    maxAttemptsPerScenario: 3,
    maxAttemptsPerRun: 10,
    maxUsdPerRun: 0.5,
  },
  confidence: {
    minimum: 'high',
  },
  validation: {
    requireExactOneMatch: true,
    requireTagMatch: true,
  },
  cooldown: {
    seconds: 300,
  },
  recentDiffs: {
    enabled: false,
  },
  scrubber: {
    extraPatterns: [],
  },
  report: {
    includeInHtml: true,
  },
};
