/**
 * Classifier.ts — rule-based failure classifier.
 *
 * Pure function. No I/O, no AI dependency. Runs after a step has failed
 * and annotates the existing failure with an operational class an on-call
 * engineer cares about. See pgwen-ai-fix-strategy.md §6.
 *
 * Output is consumed by reporters (HTML badge, JSON field) and, when the
 * AI diagnose layer is enabled, by `pgwen diagnose` as a prior the AI
 * either confirms or refines.
 */

export type FailureClass =
  | 'LOCATOR_NOT_FOUND'
  | 'ASSERTION_FAILED'
  | 'TIMEOUT'
  | 'AUTH_FAILURE'
  | 'NAVIGATION_FAILURE'
  | 'UNKNOWN';

export type FailureConfidence = 'high' | 'medium' | 'low';

export interface FailureClassification {
  class: FailureClass;
  confidence: FailureConfidence;
  /** Human-readable evidence list — what signals fired. */
  signals: string[];
}

export type HandlerCategory =
  | 'locator-action'
  | 'assertion'
  | 'navigation'
  | 'wait'
  | 'input'
  | 'capture'
  | 'control'
  | 'binding'
  | 'unknown';

export interface ClassifyInput {
  stepText: string;
  errorClass: string;
  errorMessage: string;
  handlerCategory?: HandlerCategory;
  pageUrl?: string;
  /** HTTP status observed during the failing window, when known. */
  networkStatus?: number;
}

const LOCATOR_ACTION_RE = /locator\.(waitFor|click|fill|hover|press|check|uncheck|selectOption|focus|type|tap|dblclick)/;
const PAGE_WAIT_RE = /page\.(waitForURL|waitForLoadState|waitForFunction|waitForResponse|waitForRequest|waitForSelector)/;
const NAV_NET_ERR_RE = /net::ERR_[A-Z_]+/;
const NAV_HTTP_5XX_RE = /\b5\d{2}\b/;
const AUTH_URL_RE = /\/(login|signin|signon|auth|oidc|sso)\b/i;
const AUTH_TEXT_RE = /(invalid credentials|session expired|unauthorized|not authenti[cs]ated|access denied|forbidden)/i;

export function classifyFailure(input: ClassifyInput): FailureClassification {
  const { stepText, errorClass, errorMessage, handlerCategory, pageUrl, networkStatus } = input;
  const msg = errorMessage ?? '';

  // ─── 1. ASSERTION_FAILED (deterministic) ──────────────────────────────────
  if (errorClass === 'DslAssertionError' || handlerCategory === 'assertion') {
    const signals: string[] = [];
    if (errorClass === 'DslAssertionError') signals.push('errorClass=DslAssertionError');
    if (handlerCategory === 'assertion') signals.push('handlerCategory=assertion');
    return { class: 'ASSERTION_FAILED', confidence: 'high', signals };
  }

  // ─── 2. NAVIGATION_FAILURE (deterministic when both signals match) ────────
  if (handlerCategory === 'navigation' && (NAV_NET_ERR_RE.test(msg) || NAV_HTTP_5XX_RE.test(msg))) {
    const signals: string[] = ['handlerCategory=navigation'];
    if (NAV_NET_ERR_RE.test(msg)) signals.push(`errorMessage matched ${NAV_NET_ERR_RE.exec(msg)?.[0]}`);
    if (NAV_HTTP_5XX_RE.test(msg)) signals.push(`errorMessage contained HTTP 5xx`);
    return { class: 'NAVIGATION_FAILURE', confidence: 'high', signals };
  }

  // ─── 3. LOCATOR_NOT_FOUND (deterministic) ─────────────────────────────────
  if (errorClass === 'TimeoutError' && LOCATOR_ACTION_RE.test(msg) && handlerCategory === 'locator-action') {
    return {
      class: 'LOCATOR_NOT_FOUND',
      confidence: 'high',
      signals: [
        'errorClass=TimeoutError',
        `errorMessage matched ${LOCATOR_ACTION_RE.exec(msg)?.[0]}`,
        'handlerCategory=locator-action',
      ],
    };
  }

  // ─── 4. TIMEOUT (deterministic) ───────────────────────────────────────────
  if (errorClass === 'TimeoutError' && (PAGE_WAIT_RE.test(msg) || /pgwen.*withTimeout/i.test(msg) || handlerCategory === 'wait')) {
    const signals: string[] = ['errorClass=TimeoutError'];
    if (PAGE_WAIT_RE.test(msg)) signals.push(`errorMessage matched ${PAGE_WAIT_RE.exec(msg)?.[0]}`);
    if (/pgwen.*withTimeout/i.test(msg)) signals.push('pgwen withTimeout wrapper triggered');
    if (handlerCategory === 'wait') signals.push('handlerCategory=wait');
    return { class: 'TIMEOUT', confidence: 'high', signals };
  }

  // ─── 5. AUTH_FAILURE (heuristic — needs 2+ signals for medium) ────────────
  const authSignals: string[] = [];
  if (networkStatus === 401 || networkStatus === 403) {
    authSignals.push(`networkStatus=${networkStatus}`);
  }
  if (pageUrl && AUTH_URL_RE.test(pageUrl)) {
    authSignals.push(`pageUrl matched ${AUTH_URL_RE.exec(pageUrl)?.[0]}`);
  }
  if (AUTH_TEXT_RE.test(msg) || AUTH_TEXT_RE.test(stepText)) {
    const m = AUTH_TEXT_RE.exec(msg) ?? AUTH_TEXT_RE.exec(stepText);
    authSignals.push(`auth-related text matched "${m?.[0]}"`);
  }
  if (authSignals.length >= 2) {
    return { class: 'AUTH_FAILURE', confidence: 'medium', signals: authSignals };
  }
  if (authSignals.length === 1) {
    return { class: 'AUTH_FAILURE', confidence: 'low', signals: authSignals };
  }

  // ─── 6. UNKNOWN ───────────────────────────────────────────────────────────
  return {
    class: 'UNKNOWN',
    confidence: 'low',
    signals: [
      `errorClass=${errorClass || '(unset)'}`,
      `handlerCategory=${handlerCategory ?? '(unset)'}`,
    ],
  };
}

// ─── Post-hoc reclassification by locator-binding ancestor ───────────────────

/**
 * Minimal shape we need from StepResult. Declared locally to avoid a circular
 * import — the engine's Compositor already depends on this module.
 */
export interface StepResultLike {
  stepText: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  children?: StepResultLike[];
  failureClass?: FailureClassification;
}

export interface ReclassifyContext {
  /** Configured locator wait in milliseconds — pgwen.web.wait.seconds * 1000. */
  waitMs: number;
  /**
   * Minimum fraction of `waitMs` a failing step must have taken to be treated
   * as a locator timeout. Default 0.9 — a step that ran for at least one full
   * wait window is overwhelmingly likely to have timed out on a locator (not
   * a genuine assertion mismatch, which fails fast).
   *
   * The check is an asymmetric lower bound rather than a symmetric tolerance
   * because `pgwen.web.assertions.maxStrikes` can retry the underlying wait
   * (default 3), so an actual locator timeout often takes 2–3× the configured
   * wait. Without the lower-bound semantics, retried timeouts escape the
   * reclassifier and stay misclassified as ASSERTION_FAILED.
   */
  minWaitFraction?: number;
  /**
   * Cross-scenario binding success statistics. When provided AND the matched
   * binding has `passed > 0`, the ASSERTION_FAILED → LOCATOR_NOT_FOUND flip
   * is REFUSED — the binding works elsewhere in this run, so the failure is
   * far more likely environmental than a locator drift. The decision is
   * recorded as a new signal on the step (`binding_success_rate_in_run: …`)
   * so AI mode + `@pgwen/fix` can act on it. Treat the map as opaque; the
   * reclassifier handles lookup internally.
   */
  bindingStats?: import('./BindingStats').BindingStatsMap;
}

const LOCATOR_BINDING_RE = /^(.+?)\s+can be located by\s+/i;

/**
 * Post-process a StepResult tree: rewrite ASSERTION_FAILED leaves whose
 * underlying cause was really a locator-binding timeout.
 *
 * Heuristic (per strategy doc §6 follow-up, Session 85 finding):
 *   1. Step is `failed` and currently classified ASSERTION_FAILED.
 *   2. Step's `durationMs` ≥ `waitMs * minWaitFraction` — i.e. the assertion
 *      waited at least one full locator window before giving up. Multiple
 *      strikes (assertion retries) push the duration past `waitMs`, so the
 *      check is a lower bound, not a tolerance band.
 *   3. A `<name> can be located by …` step earlier in the same children-list
 *      declared an element whose name appears (substring) in the failing
 *      step's text.
 *
 * When all three hold, the classification is rewritten to LOCATOR_NOT_FOUND
 * (medium confidence) with two appended signals so downstream tooling
 * (HTML badge, AI prior, @pgwen/fix) can act on it. Operates in place.
 *
 * Returns true when at least one reclassification happened.
 */
export function reclassifyByLocatorAncestor(
  results: StepResultLike[],
  ctx: ReclassifyContext,
): boolean {
  const minFraction = ctx.minWaitFraction ?? 0.9;
  const threshold = ctx.waitMs * minFraction;
  let changed = false;

  const walk = (siblings: StepResultLike[]): void => {
    const seenBindings: string[] = [];
    for (const step of siblings) {
      const m = LOCATOR_BINDING_RE.exec(step.stepText);
      if (m && m[1]) seenBindings.push(m[1].trim());

      if (
        step.status === 'failed' &&
        step.failureClass?.class === 'ASSERTION_FAILED' &&
        step.durationMs !== undefined &&
        step.durationMs >= threshold
      ) {
        const stepLower = step.stepText.toLowerCase();
        const matched = seenBindings.find((name) =>
          stepLower.includes(name.toLowerCase()),
        );
        if (matched) {
          // Sibling-success-rate gate: if the matched binding worked in any
          // other scenario in this run, this failure is almost certainly NOT
          // a locator drift. Refuse the flip; record the rate so AI mode +
          // @pgwen/fix can act on the same signal.
          const siblings = ctx.bindingStats?.byName.get(matched.toLowerCase().trim());
          if (siblings && siblings.passed > 0) {
            step.failureClass = {
              ...step.failureClass,
              signals: [
                ...step.failureClass.signals,
                `binding_success_rate_in_run="${matched}" ${siblings.passed}/${siblings.total} (rate=${siblings.rate.toFixed(2)})`,
                `refused locator reclassification — binding works in ${siblings.passed} sibling scenario(s)`,
              ],
            };
            // Do NOT flip the class — leave as ASSERTION_FAILED.
            continue;
          }

          const newSignals = [
            ...step.failureClass.signals,
            `derived from locator-binding ancestor "${matched}"`,
            `durationMs=${step.durationMs} ≥ waitMs=${ctx.waitMs} (× ${minFraction})`,
          ];
          if (siblings) {
            newSignals.push(
              `binding_success_rate_in_run="${matched}" ${siblings.passed}/${siblings.total} (rate=${siblings.rate.toFixed(2)})`,
            );
          }
          step.failureClass = {
            class: 'LOCATOR_NOT_FOUND',
            confidence: 'medium',
            signals: newSignals,
          };
          changed = true;
        }
      }

      if (step.children && step.children.length > 0) {
        walk(step.children);
      }
    }
  };

  walk(results);
  return changed;
}
