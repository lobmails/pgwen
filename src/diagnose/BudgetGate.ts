/**
 * BudgetGate.ts — per-run + per-day USD spend caps (Phase 4a of §16).
 *
 * Cost-control discipline:
 *   - The caller estimates the worst-case USD for a planned call
 *     (input tokens already counted, output tokens assumed at max_tokens).
 *   - `canSpend(estimated)` blocks the call if either cap would be busted.
 *   - After the call returns, `record(actual)` updates counters; actual
 *     output tokens may have been less than max_tokens, so the per-day
 *     ledger stays accurate even when estimates are pessimistic.
 *
 * Persistence is per-day JSONL — append-safe across concurrent pgwen
 * processes thanks to atomic-line writes for sub-PIPE_BUF payloads.
 * `dataDir` is optional; when omitted the gate runs in-memory and the
 * per-day counter resets each process.
 *
 * Pricing is a generic, override-able table. Default rates target the
 * latest Anthropic public list (Haiku 4.5, Sonnet 4.6, Opus 4.7). Callers
 * override per model via `opts.pricing` — pgwen never hard-codes a
 * particular customer's negotiated rate.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Pricing ────────────────────────────────────────────────────────────────

export interface PricingTier {
  /** USD per million standard input tokens. */
  inputUsdPerMtok: number;
  /** USD per million cached-input tokens (cache reads). */
  cachedInputUsdPerMtok: number;
  /** USD per million output tokens. */
  outputUsdPerMtok: number;
}

/**
 * Generic default table. Caller can extend / override via the `pricing`
 * argument to `estimateCallCostUsd` (and the BudgetGate constructor).
 * Numbers track each provider's public list as of Q2 2026; refresh as
 * needed — these are starting points, not contractual rates. Keys are
 * provider-specific model identifiers; the model string returned by the
 * provider's API is the lookup key.
 *
 * GitHub Copilot pricing: Copilot is billed per-seat to the org rather
 * than per-token. The per-token rates below are SYNTHETIC — they exist
 * so the budget gate can still produce a relative cost estimate, but
 * they don't reflect actual incremental spend. Projects that care about a
 * hard $ cap on Copilot calls should set perRunUsd=0 (unlimited) and
 * rely on Copilot's own quota enforcement instead.
 */
export const DEFAULT_PRICING: Record<string, PricingTier> = {
  // Anthropic Claude
  'claude-haiku-4-5-20251001': {
    inputUsdPerMtok: 1.0,
    cachedInputUsdPerMtok: 0.1,
    outputUsdPerMtok: 5.0,
  },
  'claude-sonnet-4-6': {
    inputUsdPerMtok: 3.0,
    cachedInputUsdPerMtok: 0.3,
    outputUsdPerMtok: 15.0,
  },
  'claude-opus-4-7': {
    inputUsdPerMtok: 15.0,
    cachedInputUsdPerMtok: 1.5,
    outputUsdPerMtok: 75.0,
  },

  // OpenAI direct (model ids returned by Chat Completions response)
  'gpt-4o-2024-08-06': {
    inputUsdPerMtok: 2.5,
    cachedInputUsdPerMtok: 1.25,
    outputUsdPerMtok: 10.0,
  },
  'gpt-4o-mini-2024-07-18': {
    inputUsdPerMtok: 0.15,
    cachedInputUsdPerMtok: 0.075,
    outputUsdPerMtok: 0.6,
  },
  'o1-preview-2024-09-12': {
    inputUsdPerMtok: 15.0,
    cachedInputUsdPerMtok: 7.5,
    outputUsdPerMtok: 60.0,
  },
  'o1-mini-2024-09-12': {
    inputUsdPerMtok: 3.0,
    cachedInputUsdPerMtok: 1.5,
    outputUsdPerMtok: 12.0,
  },

  // Azure OpenAI returns the deployment-name OR the underlying model
  // depending on configuration. Pre-populate the most common shapes.
  'gpt-4o': {
    inputUsdPerMtok: 2.5,
    cachedInputUsdPerMtok: 1.25,
    outputUsdPerMtok: 10.0,
  },
  'gpt-4o-mini': {
    inputUsdPerMtok: 0.15,
    cachedInputUsdPerMtok: 0.075,
    outputUsdPerMtok: 0.6,
  },

  // GitHub Copilot — synthetic per-token rates (see header docstring).
  // Set to zero so estimate doesn't double-count Copilot seat licenses.
  'copilot:gpt-4o': {
    inputUsdPerMtok: 0,
    cachedInputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
  },
  'copilot:claude-3.5-sonnet': {
    inputUsdPerMtok: 0,
    cachedInputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
  },
};

/**
 * Provider-aware model name resolution. Some providers (Copilot, Azure
 * with deployment-name aliasing) return ambiguous model strings — this
 * helper prefixes them so the pricing table can disambiguate.
 *
 * Used by callers that know the provider context (e.g. `pgwen diagnose`
 * after `selectAdapter` returns). When the provider doesn't apply (e.g.
 * raw OpenAI returns `gpt-4o-2024-08-06` which is already unique), the
 * input is returned unchanged.
 */
export function pricingKey(provider: string, model: string): string {
  if (provider === 'copilot') return `copilot:${model}`;
  return model;
}

export interface UsageMetrics {
  model: string;
  inputTokens: number;
  /** Tokens served from prompt cache; charged at the cached rate. */
  cachedInputTokens?: number;
  outputTokens: number;
}

/**
 * Compute USD for a single Claude call. Throws when the model isn't in
 * the pricing table — surface the gap rather than silently zero-cost
 * the call and risk a runaway budget.
 */
export function estimateCallCostUsd(
  metrics: UsageMetrics,
  pricing: Record<string, PricingTier> = DEFAULT_PRICING,
): number {
  const tier = pricing[metrics.model];
  if (!tier) {
    throw new Error(
      `estimateCallCostUsd: no pricing entry for model "${metrics.model}". ` +
      `Add it to the pricing table or pass an override.`,
    );
  }
  const cachedIn = metrics.cachedInputTokens ?? 0;
  const freshIn = Math.max(0, metrics.inputTokens - cachedIn);
  return (
    (freshIn / 1_000_000) * tier.inputUsdPerMtok +
    (cachedIn / 1_000_000) * tier.cachedInputUsdPerMtok +
    (metrics.outputTokens / 1_000_000) * tier.outputUsdPerMtok
  );
}

// ─── Gate ───────────────────────────────────────────────────────────────────

export interface BudgetCaps {
  /** Per-run USD cap. `0` (or undefined) means unlimited. */
  perRunUsd: number;
  /** Per-day USD cap. `0` (or undefined) means unlimited. */
  perDayUsd: number;
}

export interface BudgetGateOptions {
  caps: BudgetCaps;
  /** Directory for per-day JSONL ledgers. Omit for in-memory only. */
  dataDir?: string;
  /** Injectable clock — tests freeze time without touching globals. */
  now?: () => Date;
}

export interface BudgetCheckResult {
  ok: boolean;
  reason?: string;
}

interface LedgerLine {
  ts: string;
  usd: number;
  model?: string;
}

const LEDGER_SUBDIR = 'budget';

export class BudgetGate {
  private readonly caps: BudgetCaps;
  private readonly dataDir: string | undefined;
  private readonly nowFn: () => Date;
  private perRunUsd = 0;
  private perDayUsd = 0;
  private currentDay: string;

  constructor(opts: BudgetGateOptions) {
    this.caps = opts.caps;
    this.dataDir = opts.dataDir;
    this.nowFn = opts.now ?? (() => new Date());
    this.currentDay = this.todayKey();
    if (this.dataDir) this.perDayUsd = this.readDayTotal(this.currentDay);
  }

  /**
   * Pre-flight: would adding `plannedUsd` to either counter exceed its cap?
   * Caps of 0 are treated as unlimited.
   */
  canSpend(plannedUsd: number): BudgetCheckResult {
    this.rollDayIfNeeded();
    if (!Number.isFinite(plannedUsd) || plannedUsd < 0) {
      return { ok: false, reason: `planned cost "${plannedUsd}" is not a valid USD amount` };
    }
    if (this.caps.perRunUsd > 0 && this.perRunUsd + plannedUsd > this.caps.perRunUsd) {
      return {
        ok: false,
        reason: `per-run cap exceeded: $${(this.perRunUsd + plannedUsd).toFixed(4)} > $${this.caps.perRunUsd.toFixed(2)}`,
      };
    }
    if (this.caps.perDayUsd > 0 && this.perDayUsd + plannedUsd > this.caps.perDayUsd) {
      return {
        ok: false,
        reason: `per-day cap exceeded: $${(this.perDayUsd + plannedUsd).toFixed(4)} > $${this.caps.perDayUsd.toFixed(2)}`,
      };
    }
    return { ok: true };
  }

  /**
   * Record actual spend after a call returns. Persists when `dataDir`
   * is set. Atomic append per line — concurrent processes won't tear
   * each other's records as long as a single line fits PIPE_BUF.
   */
  record(actualUsd: number, meta: { model?: string } = {}): void {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) return;
    this.rollDayIfNeeded();
    this.perRunUsd += actualUsd;
    this.perDayUsd += actualUsd;
    if (!this.dataDir) return;

    const line: LedgerLine = {
      ts: this.nowFn().toISOString(),
      usd: actualUsd,
    };
    if (meta.model !== undefined) line.model = meta.model;
    const file = this.ledgerFile(this.currentDay);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
  }

  /** Read-only view of current spend + caps. */
  state(): { perRunUsd: number; perDayUsd: number; caps: BudgetCaps } {
    this.rollDayIfNeeded();
    return { perRunUsd: this.perRunUsd, perDayUsd: this.perDayUsd, caps: { ...this.caps } };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private todayKey(): string {
    return this.nowFn().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  }

  private rollDayIfNeeded(): void {
    const today = this.todayKey();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.perDayUsd = this.dataDir ? this.readDayTotal(today) : 0;
    }
  }

  private ledgerFile(day: string): string {
    return path.join(this.dataDir!, LEDGER_SUBDIR, `${day}.jsonl`);
  }

  private readDayTotal(day: string): number {
    if (!this.dataDir) return 0;
    const file = this.ledgerFile(day);
    if (!fs.existsSync(file)) return 0;
    let total = 0;
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const entry = JSON.parse(trimmed) as LedgerLine;
          if (typeof entry.usd === 'number' && Number.isFinite(entry.usd)) total += entry.usd;
        } catch {
          // skip malformed line
        }
      }
    } catch {
      return 0;
    }
    return total;
  }
}
