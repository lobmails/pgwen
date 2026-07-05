/**
 * src/heal/HealGate.ts — heal-attempt gates as pure functions.
 *
 * Implements the pre-Claude gates from strategy §6. Post-Claude
 * gates (confidence floor, exact-one-match, tag-class match) live in
 * HealValidator and HealPipeline, not here.
 *
 * Order (matches §6 numbering):
 *   1. `enabled`           — config.enabled = true (strict opt-in, §A5)
 *   2. `apiKey`            — ApiKey.resolveApiKey returned something
 *   3. `stepShape`         — failing step is a locator-binding wait
 *   3a. `noHealAnnotation` — @NoHeal annotation on scenario/feature
 *   3b. (@Try)             — failing step ancestor is @Try-wrapped (§A12)
 *   4. `failureClass`      — classifier said LOCATOR_NOT_FOUND (or
 *                            ASSERTION_FAILED w/ locator ancestor)
 *   5. `budget`            — per-step / -scenario / -run counts + USD
 *  10. `cooldown`          — same binding healed recently
 *
 * Each gate returns `{allow: true}` or `{allow: false, deniedBy,
 * outcome, reason}`. `shouldAttempt` runs them in strategy order and
 * returns the first deny — caller records the deny in telemetry and
 * skips the heal attempt.
 *
 * Decisions are pure: no I/O, no clock except what's passed in. Tests
 * inject `ctx.now`.
 */

import type { GateResult, HealConfig } from './types';

/**
 * Inputs the gate stack needs BEFORE any Claude call.
 *
 * `apiKey === null` deliberately distinguishes from `apiKey === ''`:
 * null means "resolver returned no key"; empty string is a user
 * misconfiguration that also denies.
 */
export interface HealGateContext {
  config: HealConfig;
  binding_name: string;
  apiKey: string | null;
  failure_class:
    | 'LOCATOR_NOT_FOUND'
    | 'ASSERTION_FAILED'
    | 'TIMEOUT'
    | 'NAVIGATION_FAILURE'
    | 'AUTH_FAILURE'
    | 'UNKNOWN';
  /** True when the failing step (or an ancestor) has a `can be located by` binding wait. */
  is_locator_step_shape: boolean;
  /**
   * True when the failing step OR an ancestor StepDef carries `@Try`.
   * Author has opted into failure-tolerance; don't burn API on it (§A12).
   */
  is_try_wrapped: boolean;
  /** True when scenario or feature is `@NoHeal`-annotated. */
  is_no_heal_annotated: boolean;
  /**
   * For gate 4: when failure_class === 'ASSERTION_FAILED', heal also
   * fires if there's an underlying locator-binding ancestor whose wait
   * timed out. This flag carries that determination.
   */
  has_locator_ancestor_timeout: boolean;
  attempts: {
    perStep: number;
    perScenario: number;
    perRun: number;
  };
  usd_spent_this_run: number;
  /** Last heal time for this binding (cooldown check). */
  last_healed_at?: Date;
  /** Test injection. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Single entry point. Runs every gate in §6 order; first deny wins.
 * Returns `{allow:true}` only when every gate passes.
 */
export function shouldAttempt(ctx: HealGateContext): GateResult {
  // 1. Opt-in.
  if (!ctx.config.enabled) {
    return deny('enabled', 'gate_disabled', 'pgwen.heal.enabled = false (default)');
  }

  // 2. API key resolvable.
  if (ctx.apiKey === null || ctx.apiKey.trim().length === 0) {
    return deny('apiKey', 'gate_no_api_key', 'no AI provider API key resolved');
  }

  // 3. Step shape — failing step must be locator-binding.
  if (!ctx.is_locator_step_shape) {
    return deny(
      'stepShape',
      'gate_step_shape',
      'failing step is not a `can be located by` binding wait',
    );
  }

  // 3a. @NoHeal annotation — explicit per-scenario opt-out (§A11).
  if (ctx.is_no_heal_annotated) {
    return deny(
      'noHealAnnotation',
      'gate_annotation_excluded',
      '@NoHeal annotation present on scenario or feature',
    );
  }

  // 3b. @Try wrapper — author marked the step acceptable-to-fail (§A12).
  if (ctx.is_try_wrapped) {
    return deny(
      'stepShape',
      'gate_annotation_excluded',
      '@Try-wrapped step — heal would burn API on an acceptable-to-fail step',
    );
  }

  // 4. Failure class — must be LOCATOR_NOT_FOUND, or
  //    ASSERTION_FAILED w/ locator-binding ancestor that timed out.
  if (!isHealableFailureClass(ctx)) {
    return deny(
      'failureClass',
      'gate_failure_class',
      `classifier verdict ${ctx.failure_class} is not in {LOCATOR_NOT_FOUND, ASSERTION_FAILED-w/-locator-ancestor}`,
    );
  }

  // 5. Budget gates — per-step / -scenario / -run + USD cap.
  const budgetDeny = checkBudget(ctx);
  if (budgetDeny) return budgetDeny;

  // 10. Cooldown — has the same binding been healed too recently?
  const cooldownDeny = checkCooldown(ctx);
  if (cooldownDeny) return cooldownDeny;

  // Every pre-Claude gate passed. Post-Claude gates (confidence,
  // exact-one-match, tag-class) fire in HealValidator + HealPipeline.
  return { allow: true };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function deny(
  by: GateResult['deniedBy'] & string,
  outcome: GateResult['outcome'] & string,
  reason: string,
): GateResult {
  return { allow: false, deniedBy: by, outcome, reason };
}

function isHealableFailureClass(ctx: HealGateContext): boolean {
  if (ctx.failure_class === 'LOCATOR_NOT_FOUND') return true;
  if (ctx.failure_class === 'ASSERTION_FAILED' && ctx.has_locator_ancestor_timeout) return true;
  return false;
}

function checkBudget(ctx: HealGateContext): GateResult | null {
  const b = ctx.config.budget;
  if (ctx.attempts.perStep >= b.maxAttemptsPerStep) {
    return deny(
      'budget',
      'gate_budget',
      `per-step attempts ${ctx.attempts.perStep} >= cap ${b.maxAttemptsPerStep}`,
    );
  }
  if (ctx.attempts.perScenario >= b.maxAttemptsPerScenario) {
    return deny(
      'budget',
      'gate_budget',
      `per-scenario attempts ${ctx.attempts.perScenario} >= cap ${b.maxAttemptsPerScenario}`,
    );
  }
  if (ctx.attempts.perRun >= b.maxAttemptsPerRun) {
    return deny(
      'budget',
      'gate_budget',
      `per-run attempts ${ctx.attempts.perRun} >= cap ${b.maxAttemptsPerRun}`,
    );
  }
  // USD cap. The default is non-zero; a zero or negative value in
  // config disables this check (matches diagnose's BudgetCaps
  // semantics where 0 means "unlimited").
  if (b.maxUsdPerRun > 0 && ctx.usd_spent_this_run >= b.maxUsdPerRun) {
    return deny(
      'budget',
      'gate_budget',
      `USD spent $${ctx.usd_spent_this_run.toFixed(4)} >= cap $${b.maxUsdPerRun.toFixed(2)}`,
    );
  }
  return null;
}

function checkCooldown(ctx: HealGateContext): GateResult | null {
  const cooldownSec = ctx.config.cooldown.seconds;
  if (cooldownSec <= 0) return null;
  if (!ctx.last_healed_at) return null;
  const now = ctx.now ?? new Date();
  const ageMs = now.getTime() - ctx.last_healed_at.getTime();
  if (ageMs < cooldownSec * 1000) {
    return deny(
      'cooldown',
      'gate_cooldown',
      `binding "${ctx.binding_name}" healed ${Math.round(ageMs / 1000)}s ago; cooldown window is ${cooldownSec}s`,
    );
  }
  return null;
}
