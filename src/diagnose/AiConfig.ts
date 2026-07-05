/**
 * AiConfig.ts — read AI-track config from pgwen.conf into the typed
 * shapes the Phase 4 modules consume. Generic by design — keys live
 * under `pgwen.diagnose.ai.*`, never under an organisation-specific
 * prefix.
 *
 * Defaults are preserved when keys are missing, empty, malformed, or
 * non-positive — pgwen never throws on a bad value at this layer; the
 * config error surfaces as "diagnose runs with the default" rather
 * than crashing a CI job. Real validation happens at write time
 * (HOCON parser) or by the constructor of each consumer.
 *
 * Supported keys
 *   pgwen.diagnose.ai.cost.perRunUsd        number, default 0 (unlimited)
 *   pgwen.diagnose.ai.cost.perDayUsd        number, default 0 (unlimited)
 *   pgwen.diagnose.ai.rate.callsPerWindow   int,    default 30
 *   pgwen.diagnose.ai.rate.windowMs         int,    default 300000 (5min)
 *   pgwen.diagnose.ai.pricing.<model>.input         number USD per MTok
 *   pgwen.diagnose.ai.pricing.<model>.cachedInput   number USD per MTok
 *   pgwen.diagnose.ai.pricing.<model>.output        number USD per MTok
 *
 * Model IDs in pricing keys are exactly as Anthropic publishes them
 * (e.g. `claude-haiku-4-5-20251001`). Per-model overrides merge OVER
 * DEFAULT_PRICING — partial overrides are allowed (only `input`
 * changes, others fall back to the default).
 */

import {
  DEFAULT_PRICING,
  type BudgetCaps,
  type PricingTier,
} from './BudgetGate';
import type { RateLimitOptions } from './RateLimit';

export type Config = Record<string, string | undefined>;

// ─── Cost caps ──────────────────────────────────────────────────────────────

const KEY_PER_RUN_USD = 'pgwen.diagnose.ai.cost.perRunUsd';
const KEY_PER_DAY_USD = 'pgwen.diagnose.ai.cost.perDayUsd';

export function budgetCapsFromConfig(config: Config): BudgetCaps {
  return {
    perRunUsd: readNonNegativeNumber(config[KEY_PER_RUN_USD], 0),
    perDayUsd: readNonNegativeNumber(config[KEY_PER_DAY_USD], 0),
  };
}

// ─── Rate limit ─────────────────────────────────────────────────────────────

const KEY_CALLS_PER_WINDOW = 'pgwen.diagnose.ai.rate.callsPerWindow';
const KEY_WINDOW_MS = 'pgwen.diagnose.ai.rate.windowMs';

export const DEFAULT_RATE_CALLS_PER_WINDOW = 30;
export const DEFAULT_RATE_WINDOW_MS = 5 * 60 * 1000;

export function rateLimitOptionsFromConfig(config: Config): RateLimitOptions {
  return {
    callsPerWindow: readPositiveInt(config[KEY_CALLS_PER_WINDOW], DEFAULT_RATE_CALLS_PER_WINDOW),
    windowMs: readPositiveInt(config[KEY_WINDOW_MS], DEFAULT_RATE_WINDOW_MS),
  };
}

// ─── Pricing overrides ─────────────────────────────────────────────────────

const PRICING_PREFIX = 'pgwen.diagnose.ai.pricing.';
type PricingField = 'input' | 'cachedInput' | 'output';
const PRICING_FIELDS: ReadonlySet<PricingField> = new Set(['input', 'cachedInput', 'output']);

const PRICING_FIELD_TO_KEY: Record<PricingField, keyof PricingTier> = {
  input: 'inputUsdPerMtok',
  cachedInput: 'cachedInputUsdPerMtok',
  output: 'outputUsdPerMtok',
};

/**
 * Build the pricing table for the BudgetGate by merging
 * config-supplied per-model overrides on top of DEFAULT_PRICING.
 * Partial overrides are honoured — a model entry that only sets
 * `input` keeps `cachedInput` and `output` from the default (when
 * the model exists in DEFAULT_PRICING; otherwise unspecified fields
 * default to 0).
 */
export function pricingFromConfig(config: Config): Record<string, PricingTier> {
  const overrides: Record<string, Partial<Record<keyof PricingTier, number>>> = {};

  for (const [key, rawValue] of Object.entries(config)) {
    if (rawValue === undefined) continue;
    if (!key.startsWith(PRICING_PREFIX)) continue;
    const rest = key.slice(PRICING_PREFIX.length);
    const lastDot = rest.lastIndexOf('.');
    if (lastDot <= 0) continue;
    const model = rest.slice(0, lastDot);
    const field = rest.slice(lastDot + 1);
    if (!PRICING_FIELDS.has(field as PricingField)) continue;
    const num = readNonNegativeNumber(rawValue, NaN);
    if (Number.isNaN(num)) continue;
    if (!overrides[model]) overrides[model] = {};
    overrides[model]![PRICING_FIELD_TO_KEY[field as PricingField]] = num;
  }

  // Clone default + merge.
  const merged: Record<string, PricingTier> = {};
  for (const [model, tier] of Object.entries(DEFAULT_PRICING)) {
    merged[model] = { ...tier };
  }
  for (const [model, partial] of Object.entries(overrides)) {
    const base = merged[model] ?? { inputUsdPerMtok: 0, cachedInputUsdPerMtok: 0, outputUsdPerMtok: 0 };
    merged[model] = {
      inputUsdPerMtok: partial.inputUsdPerMtok ?? base.inputUsdPerMtok,
      cachedInputUsdPerMtok: partial.cachedInputUsdPerMtok ?? base.cachedInputUsdPerMtok,
      outputUsdPerMtok: partial.outputUsdPerMtok ?? base.outputUsdPerMtok,
    };
  }
  return merged;
}

// ─── Parsing helpers ───────────────────────────────────────────────────────

function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}
