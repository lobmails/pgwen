/**
 * FailureFingerprint.ts — group semantically-equivalent failures so the AI
 * pipeline calls Claude once per pattern instead of once per failure.
 *
 * Why this exists (strategy doc §17): a single broken locator can fail 500
 * scenarios in one run. Without grouping, the AI pipeline issues 500 Claude
 * calls — each producing essentially the same proposal. The ResponseCache
 * doesn't help because every bundle differs in scenario name / DOM excerpt /
 * recent diffs, so the bundle hashes never collide.
 *
 * The fingerprint is conservative: a key composition that two failures
 * having to share to be "the same pattern" is the *fix*, not just the
 * symptom. Today that means:
 *
 *   - For failures whose locator binding could be resolved (i.e. LocatorIndex
 *     returned a binding for the failing step): the binding file:line + the
 *     selector strategy + the selector value. Same binding declaration ⇒
 *     same fix target. The class (LOCATOR_NOT_FOUND, etc.) is included so
 *     two failures with the same binding but radically different error
 *     classes don't share a key by accident.
 *
 *   - For failures with no resolvable locator: a per-failure unique key
 *     (effectively no grouping). Includes feature_file + scenario + step
 *     text so the group is always singleton. This is the safe default —
 *     don't merge across patterns we can't precisely identify.
 *
 * Determinism: `groupFailures` sorts inputs lexicographically before
 * hashing, so the chosen "representative" of each group is stable across
 * runs of the same input. That keeps the ResponseCache useful (same
 * representative → same bundle hash) and makes test snapshots predictable.
 */

import { createHash } from 'crypto';
import type { FailureToDiagnose, LocatorLookup } from './AiPipeline';

/** What we need from a resolved locator to compose a useful fingerprint. */
export interface ResolvedLocatorForFingerprint {
  binding_file: string;
  binding_line: number;
  selector_strategy: string;
  selector_value: string;
}

/**
 * Build the fingerprint string for one failure. `locator` is the binding
 * resolved by LocatorIndex (when found), or `null` otherwise. Pure: a given
 * (failure, locator) pair always hashes to the same value.
 */
export function fingerprintFailure(
  failure: FailureToDiagnose,
  locator: ResolvedLocatorForFingerprint | null,
): string {
  const parts: string[] = [];
  parts.push(`class=${failure.prior?.class ?? 'UNCLASSIFIED'}`);
  parts.push(`error_class=${failure.step.errorClass}`);
  if (locator) {
    parts.push(`locator_file=${locator.binding_file}`);
    parts.push(`locator_line=${locator.binding_line}`);
    parts.push(`selector_strategy=${locator.selector_strategy}`);
    parts.push(`selector_value=${locator.selector_value}`);
  } else {
    parts.push(`feature=${failure.feature.file}`);
    parts.push(`scenario=${failure.scenario.name}`);
    parts.push(`step=${failure.step.text}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export interface FailureGroup {
  /** Stable hash; identifies the pattern across runs. */
  fingerprint: string;
  /** The lex-smallest failure in the group — sent to Claude on behalf of all. */
  representative: FailureToDiagnose;
  /**
   * All failures sharing this fingerprint, including the representative.
   * Ordered the same as the sorted input — first element is the
   * representative.
   */
  instances: FailureToDiagnose[];
}

/**
 * Group a list of failures by fingerprint. Stable: same input always
 * produces the same groups in the same order.
 *
 * `lookup` is the LocatorLookup closure the caller already uses for the AI
 * pipeline — passing it here means the locator metadata is parsed at most
 * once per (failure, lookup-cache) pair.
 */
export function groupFailures(
  failures: ReadonlyArray<FailureToDiagnose>,
  lookup: LocatorLookup,
): FailureGroup[] {
  const sorted = [...failures].sort(compareFailures);
  const byFp = new Map<string, FailureGroup>();
  for (const f of sorted) {
    const found = lookup(f);
    const loc: ResolvedLocatorForFingerprint | null = found
      ? {
          binding_file: found.binding_file,
          binding_line: found.binding_line,
          selector_strategy: found.selector_strategy,
          selector_value: found.selector_value,
        }
      : null;
    const fp = fingerprintFailure(f, loc);
    const existing = byFp.get(fp);
    if (existing) {
      existing.instances.push(f);
    } else {
      byFp.set(fp, { fingerprint: fp, representative: f, instances: [f] });
    }
  }
  return Array.from(byFp.values());
}

function compareFailures(a: FailureToDiagnose, b: FailureToDiagnose): number {
  if (a.feature.file !== b.feature.file) return a.feature.file < b.feature.file ? -1 : 1;
  if (a.scenario.name !== b.scenario.name) return a.scenario.name < b.scenario.name ? -1 : 1;
  return a.step.text < b.step.text ? -1 : a.step.text > b.step.text ? 1 : 0;
}

/**
 * Project a FailureToDiagnose into the minimal shape downstream consumers
 * (sidecars, FixInputEntry.instances) need to remember each affected case.
 */
export function projectInstance(f: FailureToDiagnose): {
  feature_file: string;
  feature_name: string;
  scenario_name: string;
  step_text: string;
} {
  return {
    feature_file: f.feature.file,
    feature_name: f.feature.name,
    scenario_name: f.scenario.name,
    step_text: f.step.text,
  };
}
