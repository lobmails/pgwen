/**
 * execution/ParallelRunnerUtils.ts — Shared result aggregation utilities.
 *
 * Extracted so both ParallelRunner (headless/no-browser) and PlaywrightRunner
 * (parallel-with-browser) can produce a consistent ParallelRunResult.
 */

import type { RunResult } from './Runner';

export interface ParallelRunResult {
  results: RunResult[];
  /** Overall status across all features. */
  status: 'passed' | 'failed';
  /** Total scenarios across all features. */
  totalScenarios: number;
  /** Total passed scenarios. */
  passedScenarios: number;
  /** Total failed scenarios. */
  failedScenarios: number;
}

export function buildParallelResult(results: RunResult[]): ParallelRunResult {
  let totalScenarios = 0;
  let passedScenarios = 0;
  let failedScenarios = 0;

  for (const r of results) {
    for (const s of r.scenarios) {
      totalScenarios++;
      if (s.status === 'passed') passedScenarios++;
      else if (s.status === 'failed') failedScenarios++;
    }
  }

  const status = results.some((r) => r.status === 'failed') ? 'failed' : 'passed';

  return { results, status, totalScenarios, passedScenarios, failedScenarios };
}
