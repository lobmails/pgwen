/**
 * src/heal/HealCache.ts — Phase 3.5 module.
 *
 * In-process, per-scenario heal cache. Maps (scenarioId, bindingName)
 * to the healed selector so a step that fired heal during a setup
 * StepDef doesn't pay the heal cost again when the same binding is
 * exercised by a later step in the same scenario.
 *
 * Strategy §A3: heal cache is NOT cross-run — it dies with the
 * process. Cross-run heal state is what @pgwen/fix is for.
 *
 * Cooldown semantics (strategy §6.10): if the same binding name has
 * been healed within `cooldown.seconds`, don't re-heal — surface as
 * failure. This catches the case where the AI's first heal was
 * wrong. Different scenarios may heal the same binding name
 * differently; the cache key is `scenarioId + ':' + bindingName`.
 *
 * This module is small enough that Phase 3.1 ships the full
 * implementation — no separate shell.
 */

import type { HealSelector } from './types';

interface CacheEntry {
  selector: HealSelector;
  healedAt: Date;
}

export class HealCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** Build the cache key for a (scenario, binding) pair. */
  static bindingKey(scenarioId: string, bindingName: string): string {
    return `${scenarioId}:${bindingName}`;
  }

  /** Record a successful heal. Overwrites prior entries for the same key. */
  record(scenarioId: string, bindingName: string, selector: HealSelector, healedAt: Date): void {
    this.entries.set(HealCache.bindingKey(scenarioId, bindingName), { selector, healedAt });
  }

  /** Lookup the healed selector for this binding (if any). */
  lookup(scenarioId: string, bindingName: string): HealSelector | undefined {
    return this.entries.get(HealCache.bindingKey(scenarioId, bindingName))?.selector;
  }

  /**
   * True when this binding is in cooldown — i.e. it was healed within
   * the configured `cooldown.seconds` of `now`. The pipeline uses this
   * to refuse a SECOND heal attempt on a binding whose first heal
   * already proved unreliable.
   *
   * `cooldownSeconds <= 0` disables the cooldown entirely (treats
   * every binding as immediately re-healable).
   */
  isInCooldown(
    scenarioId: string,
    bindingName: string,
    cooldownSeconds: number,
    now: Date,
  ): boolean {
    if (cooldownSeconds <= 0) return false;
    const entry = this.entries.get(HealCache.bindingKey(scenarioId, bindingName));
    if (!entry) return false;
    const ageMs = now.getTime() - entry.healedAt.getTime();
    return ageMs < cooldownSeconds * 1000;
  }

  /** Number of cached heals — used by tests. */
  size(): number {
    return this.entries.size;
  }

  /** Clear everything — for testing only. */
  clear(): void {
    this.entries.clear();
  }
}
