/**
 * src/heal/HealConfig.ts — read `pgwen.heal.*` from the flat-keyed config
 * dict produced by the launcher's HOCON parser. Pattern mirrors
 * `diagnose/AiConfig.ts` — pgwen never throws on a bad heal value;
 * malformed config falls back to the safe (heal=off) default.
 *
 * Strategy reference: pgwen-ai-heal-strategy.md §10.
 *
 * NOTE: when `pgwen.heal.enabled` is absent or anything other than the
 * literal string "true" (case-insensitive), heal stays OFF. The strict
 * opt-in is non-negotiable (strategy §1, §A5).
 */

import type { DiagnoseConfidence } from '../diagnose/types';
import { DEFAULT_HEAL_CONFIG, type HealConfig } from './types';

export type Config = Record<string, string | undefined>;

const KEY_ENABLED = 'pgwen.heal.enabled';
const KEY_MODE = 'pgwen.heal.mode';
const KEY_MAX_PER_STEP = 'pgwen.heal.budget.maxAttemptsPerStep';
const KEY_MAX_PER_SCENARIO = 'pgwen.heal.budget.maxAttemptsPerScenario';
const KEY_MAX_PER_RUN = 'pgwen.heal.budget.maxAttemptsPerRun';
const KEY_MAX_USD = 'pgwen.heal.budget.maxUsdPerRun';
const KEY_CONFIDENCE = 'pgwen.heal.confidence.minimum';
const KEY_VALIDATE_ONE_MATCH = 'pgwen.heal.validation.requireExactOneMatch';
const KEY_VALIDATE_TAG = 'pgwen.heal.validation.requireTagMatch';
const KEY_COOLDOWN = 'pgwen.heal.cooldown.seconds';
const KEY_RECENT_DIFFS = 'pgwen.heal.recentDiffs.enabled';
const KEY_SCRUBBER_EXTRA = 'pgwen.heal.scrubber.extraPatterns';
const KEY_REPORT_HTML = 'pgwen.heal.report.includeInHtml';

/**
 * Build a typed HealConfig from the flat-key config dict. Every
 * malformed value falls back to its DEFAULT_HEAL_CONFIG counterpart —
 * heal-off is always the safe landing.
 */
export function healConfigFromConfig(config: Config): HealConfig {
  return {
    enabled: readBool(config[KEY_ENABLED], DEFAULT_HEAL_CONFIG.enabled),
    mode: readMode(config[KEY_MODE], DEFAULT_HEAL_CONFIG.mode),
    budget: {
      maxAttemptsPerStep: readPositiveInt(
        config[KEY_MAX_PER_STEP], DEFAULT_HEAL_CONFIG.budget.maxAttemptsPerStep,
      ),
      maxAttemptsPerScenario: readPositiveInt(
        config[KEY_MAX_PER_SCENARIO], DEFAULT_HEAL_CONFIG.budget.maxAttemptsPerScenario,
      ),
      maxAttemptsPerRun: readPositiveInt(
        config[KEY_MAX_PER_RUN], DEFAULT_HEAL_CONFIG.budget.maxAttemptsPerRun,
      ),
      maxUsdPerRun: readNonNegativeNumber(
        config[KEY_MAX_USD], DEFAULT_HEAL_CONFIG.budget.maxUsdPerRun,
      ),
    },
    confidence: {
      minimum: readConfidence(
        config[KEY_CONFIDENCE], DEFAULT_HEAL_CONFIG.confidence.minimum,
      ),
    },
    validation: {
      requireExactOneMatch: readBool(
        config[KEY_VALIDATE_ONE_MATCH], DEFAULT_HEAL_CONFIG.validation.requireExactOneMatch,
      ),
      requireTagMatch: readBool(
        config[KEY_VALIDATE_TAG], DEFAULT_HEAL_CONFIG.validation.requireTagMatch,
      ),
    },
    cooldown: {
      seconds: readPositiveInt(
        config[KEY_COOLDOWN], DEFAULT_HEAL_CONFIG.cooldown.seconds,
      ),
    },
    recentDiffs: {
      enabled: readBool(
        config[KEY_RECENT_DIFFS], DEFAULT_HEAL_CONFIG.recentDiffs.enabled,
      ),
    },
    scrubber: {
      extraPatterns: readStringList(
        config[KEY_SCRUBBER_EXTRA], DEFAULT_HEAL_CONFIG.scrubber.extraPatterns,
      ),
    },
    report: {
      includeInHtml: readBool(
        config[KEY_REPORT_HTML], DEFAULT_HEAL_CONFIG.report.includeInHtml,
      ),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function readMode(raw: string | undefined, fallback: HealConfig['mode']): HealConfig['mode'] {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'session' || v === 'persist') return v;
  return fallback;
}

function readConfidence(
  raw: string | undefined,
  fallback: DiagnoseConfidence,
): DiagnoseConfidence {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return fallback;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Parse a comma-or-newline-separated string list. Returns the fallback
 * when the raw value is undefined or yields zero non-empty tokens.
 * Used for `pgwen.heal.scrubber.extraPatterns`.
 */
function readStringList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const tokens = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return tokens.length > 0 ? tokens : fallback;
}
