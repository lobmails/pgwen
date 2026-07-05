/**
 * SyncGate.ts — Async mutex for @Synchronized StepDef serialization.
 *
 * A single SyncGate instance serializes all @Synchronized StepDef executions
 * across concurrent feature runs in a parallel execution session.
 * Non-synchronized steps bypass the gate and run freely.
 *
 * Usage (PlaywrightRunner / ParallelRunner):
 *   const gate = new SyncGate();
 *   // pass gate via RunOptions.syncGate to each concurrent Runner
 *
 * Usage (Compositor):
 *   if (stepDef.annotations.isSynchronized && this.syncGate) {
 *     return this.syncGate.run(() => executeBody());
 *   }
 */

export class SyncGate {
  private lock: Promise<void> = Promise.resolve();

  /**
   * Run the given async function exclusively — no other gate.run() call
   * proceeds while this one is executing.
   *
   * The gate is FIFO: callers queue in arrival order.
   * Errors thrown by fn propagate to the caller; the gate is always released.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the current lock so we wait for whoever holds it
    let releaseNext!: () => void;
    const prevLock = this.lock;
    // The next caller will wait on this new promise
    this.lock = new Promise<void>((r) => { releaseNext = r; });

    // Wait for the previous holder to finish
    await prevLock;

    try {
      return await fn();
    } finally {
      // Unblock the next waiter
      releaseNext();
    }
  }
}
