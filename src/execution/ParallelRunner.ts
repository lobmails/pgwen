/**
 * ParallelRunner.ts — Run feature files in parallel using Promise.all.
 *
 * Each feature file is run concurrently up to maxWorkers at a time.
 * Results are collected and merged into a single ParallelRunResult.
 *
 * Worker isolation: each feature run gets its own Runner, MetaEngine, Scope, etc.
 * No shared mutable state between concurrent runs (Runner holds no state).
 */

import { Runner } from './Runner';
import type { RunOptions, RunResult } from './Runner';
import { buildParallelResult, type ParallelRunResult } from './ParallelRunnerUtils';
import { SyncGate } from './SyncGate';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface ParallelRunOptions extends Omit<RunOptions, 'page'> {
  /** Maximum parallel workers. Default: all files in parallel. */
  maxWorkers?: number;
  /**
   * Seconds to wait between starting each worker within a batch. 0 (default)
   * starts every worker simultaneously up to `maxWorkers`. Non-zero values
   * stagger the starts so a server-side rate limit, login flow, or other
   * shared resource isn't slammed by a synchronised burst.
   *
   * Maps directly to the reference framework's `pgwen.rampup.interval.seconds` setting; projects
   * configure via `pgwen.rampup.interval.seconds` in pgwen.conf.
   *
   * The ramp-up sleep is BETWEEN starts, not before the first one — so with
   * `maxWorkers=4` and `rampupIntervalSeconds=2`: worker 1 starts at t=0,
   * worker 2 at t=2, worker 3 at t=4, worker 4 at t=6. Workers run to
   * completion in parallel from there; the batch waits for all four.
   */
  rampupIntervalSeconds?: number;
  /**
   * Inject sleep for tests so the rampup loop doesn't pin the suite for
   * the full wall-clock interval. Default: setTimeout-based.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type { ParallelRunResult } from './ParallelRunnerUtils';

// ─── Concurrency helper ───────────────────────────────────────────────────────

/**
 * Run all feature files with at most maxConcurrent running at a time.
 * Processes files in batches of maxConcurrent, awaiting each batch before
 * starting the next.
 *
 * A SyncGate is created once per invocation and shared across all concurrent
 * runners so that @Synchronized StepDefs execute exclusively.
 */
async function runWithConcurrency(
  files: string[],
  maxConcurrent: number,
  options: ParallelRunOptions
): Promise<RunResult[]> {
  const runner = new Runner();
  const results: RunResult[] = [];

  // Strip ParallelRunner-specific options and inject a shared SyncGate
  const {
    maxWorkers: _mw,
    rampupIntervalSeconds,
    sleepImpl,
    ...baseOptions
  } = options;
  const syncGate = new SyncGate();
  const runOptions: RunOptions = { ...baseOptions, syncGate };

  // Resolve rampup. Config value (`pgwen.rampup.interval.seconds`) is the
  // project-author-facing knob; the explicit option wins when set so tests
  // and programmatic callers can override.
  const cfgRaw = baseOptions.config?.['pgwen.rampup.interval.seconds'];
  const cfgRampup = cfgRaw !== undefined ? parseFloat(cfgRaw) : NaN;
  const rampupSecs = rampupIntervalSeconds
    ?? (Number.isFinite(cfgRampup) && cfgRampup > 0 ? cfgRampup : 0);
  const rampupMs = rampupSecs > 0 ? rampupSecs * 1000 : 0;
  const sleep = sleepImpl ?? defaultSleep;

  for (let i = 0; i < files.length; i += maxConcurrent) {
    const batch = files.slice(i, i + maxConcurrent);
    const promises: Array<Promise<RunResult[]>> = [];
    for (let j = 0; j < batch.length; j += 1) {
      // Stagger starts BETWEEN workers, not before the first one.
      if (j > 0 && rampupMs > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(rampupMs);
      }
      promises.push(runner.runFeature(batch[j]!, runOptions));
    }
    const batchResults = await Promise.all(promises);
    for (const fileResults of batchResults) results.push(...fileResults);
  }

  return results;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ParallelRunner ───────────────────────────────────────────────────────────

export class ParallelRunner {
  /**
   * Run all given feature files concurrently (up to maxWorkers at a time).
   * Returns a merged result containing per-feature RunResult objects and
   * aggregate pass/fail counts.
   */
  async runParallel(
    featureFiles: string[],
    options: ParallelRunOptions = {}
  ): Promise<ParallelRunResult> {
    if (featureFiles.length === 0) {
      return {
        results: [],
        status: 'passed',
        totalScenarios: 0,
        passedScenarios: 0,
        failedScenarios: 0,
      };
    }

    const maxWorkers = options.maxWorkers ?? featureFiles.length;
    const results = await runWithConcurrency(featureFiles, maxWorkers, options);
    return buildParallelResult(results);
  }
}
