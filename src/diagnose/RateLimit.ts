/**
 * RateLimit.ts — sliding-window call-rate cap (Phase 4b of §16).
 *
 * In-process only. Per-project rate limiting across concurrent pgwen runs
 * would need a cross-process counter (file lock, Redis, etc.) — out of
 * scope for the diagnose loop, where a single CI job is one process.
 *
 * Default window is 30 calls / 5 minutes — generous for typical CI but
 * tight enough to stop a runaway `@Retry` loop from melting the Claude
 * bill. Tune via `callsPerWindow` and `windowMs`.
 *
 * Sliding window (not fixed): each call records its timestamp; older
 * timestamps drop out as time advances. Avoids the "burst at window
 * boundary" failure mode of fixed windows.
 */

export interface RateLimitOptions {
  /** Max calls allowed within `windowMs` of any moment. */
  callsPerWindow: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Inject clock — tests freeze time without touching `Date.now`. */
  now?: () => number;
}

export interface RateLimitState {
  /** Calls inside the current sliding window. */
  used: number;
  /** Calls remaining before the gate closes. */
  remaining: number;
  /** Earliest call in the window expires at this ms timestamp. */
  resetAtMs: number;
}

export class RateLimit {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;
  private timestamps: number[] = [];

  constructor(opts: RateLimitOptions) {
    if (!Number.isInteger(opts.callsPerWindow) || opts.callsPerWindow <= 0) {
      throw new Error('callsPerWindow must be a positive integer');
    }
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
      throw new Error('windowMs must be a positive number');
    }
    this.capacity = opts.callsPerWindow;
    this.windowMs = opts.windowMs;
    this.nowFn = opts.now ?? Date.now;
  }

  /**
   * Pre-flight + reserve. Returns true and records the call, or false
   * when the window is full. Atomic — never half-reserves.
   */
  tryAcquire(): boolean {
    const now = this.nowFn();
    this.evictBefore(now - this.windowMs);
    if (this.timestamps.length >= this.capacity) return false;
    this.timestamps.push(now);
    return true;
  }

  /** Current usage view; never mutates the bucket. */
  state(): RateLimitState {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    const active = this.timestamps.filter((t) => t > cutoff);
    const used = active.length;
    const oldest = active[0];
    const resetAtMs = oldest !== undefined ? oldest + this.windowMs : now;
    return {
      used,
      remaining: Math.max(0, this.capacity - used),
      resetAtMs,
    };
  }

  private evictBefore(cutoff: number): void {
    // Timestamps are appended in monotonic order so the head is oldest.
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}
