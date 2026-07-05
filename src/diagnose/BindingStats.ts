/**
 * BindingStats.ts — cross-scenario binding success-rate signal.
 *
 * Purpose: a binding that resolved successfully in N>0 sibling scenarios
 * during the same run is almost certainly not drifted. Any failure that
 * happens to involve that binding is more likely environmental (timing,
 * data, auth state, page-not-loaded) than a locator change. Without this
 * signal, the rule-based classifier flips ALL such failures to
 * LOCATOR_NOT_FOUND, generating false positives the user explicitly
 * flagged ("if a locator worked on 10 of 20 tests, this could be a case
 * of false flag on locator issue").
 *
 * Pure: no I/O, operates on the same shapes the classifier already uses.
 * Computes per-binding pass/fail counts across all scenarios in a feature
 * (or a whole report) and exposes them to:
 *   1. The ancestor reclassifier — refuses the ASSERTION→LOCATOR flip when
 *      passed > 0; records the decision as a new signal on the step.
 *   2. The diagnose bundle (assembler) — Claude weighs the rate explicitly.
 *   3. The @pgwen/fix minimum-diff validator — hard reject when rate ≥ 0.5.
 *
 * Scenario "status" determines the per-binding count: a binding declared
 * in a passing scenario contributes to `passed`, in a failing scenario to
 * `failed`. Bindings used by a `skipped` scenario contribute nothing.
 */

import type { StepResultLike } from './Classifier';

/** Per-binding aggregate across the scenarios scanned. */
export interface BindingStats {
  /** First-seen casing of the binding name (preserved for display). */
  bindingName: string;
  /** Scenarios that declared this binding AND passed. */
  passed: number;
  /** Scenarios that declared this binding AND failed. */
  failed: number;
  /** passed + failed. Skipped scenarios are not counted. */
  total: number;
  /**
   * passed / total when total > 0, else 0. Pre-computed for convenience —
   * the rate gates in the classifier + validator read this directly.
   */
  rate: number;
}

export interface BindingStatsMap {
  /** Keyed by lowercase trimmed binding name (lookup-stable). */
  byName: Map<string, BindingStats>;
}

const LOCATOR_BINDING_RE = /^(.+?)\s+can be located by\s+/i;

/** Minimal scenario shape for the stat-builder. Mirrors `ScenarioRunResult`. */
export interface ScenarioLike {
  status: 'passed' | 'failed' | 'skipped';
  steps: StepResultLike[];
}

/**
 * Walk a scenario's step tree, returning every binding-name declaration
 * found. Includes nested StepDef bodies — a binding declared deep inside
 * a StepDef chain still counts as "used by this scenario".
 *
 * Returns the raw display-cased names; the caller normalises for lookup.
 */
export function collectBindingNames(steps: StepResultLike[]): string[] {
  const out: string[] = [];
  const walk = (siblings: StepResultLike[]): void => {
    for (const step of siblings) {
      const m = LOCATOR_BINDING_RE.exec(step.stepText);
      if (m && m[1]) out.push(m[1].trim());
      if (step.children && step.children.length > 0) walk(step.children);
    }
  };
  walk(steps);
  return out;
}

/**
 * Build a cross-scenario `BindingStatsMap`. A binding declared in N
 * scenarios contributes to the stats as: passed += scenarios where status
 * === 'passed', failed += scenarios where status === 'failed'.
 *
 * Empty input yields an empty map — callers don't need to special-case
 * "no scenarios in this run".
 */
export function computeBindingStats(scenarios: ScenarioLike[]): BindingStatsMap {
  const byName = new Map<string, BindingStats>();
  for (const sc of scenarios) {
    if (sc.status !== 'passed' && sc.status !== 'failed') continue;
    const seen = new Set<string>();
    for (const name of collectBindingNames(sc.steps)) {
      const key = name.toLowerCase().trim();
      // Count each binding at most once per scenario — a scenario that
      // declares the same name multiple times still only contributes one
      // pass/fail vote to the stats.
      if (seen.has(key)) continue;
      seen.add(key);
      let s = byName.get(key);
      if (!s) {
        s = { bindingName: name, passed: 0, failed: 0, total: 0, rate: 0 };
        byName.set(key, s);
      }
      if (sc.status === 'passed') s.passed += 1;
      else s.failed += 1;
      s.total = s.passed + s.failed;
      s.rate = s.total > 0 ? s.passed / s.total : 0;
    }
  }
  return { byName };
}

/**
 * Lookup helper. Returns `undefined` when no stats exist for the name —
 * callers treat that as "no sibling data", not "binding is broken".
 */
export function lookupBindingStats(
  stats: BindingStatsMap | undefined,
  bindingName: string,
): BindingStats | undefined {
  if (!stats) return undefined;
  return stats.byName.get(bindingName.toLowerCase().trim());
}
