/**
 * dsl/playwright/video.ts — Video recording DSL steps for pgwen.
 *
 * Video recording in Playwright is a BrowserContext-level setting configured
 * before test execution begins (via pgwen.conf or the BrowserConfig layer).
 * These DSL steps provide:
 *   - Runtime scope flags that project authors can set in meta to express intent
 *   - A step to capture the saved video path for use in @Finally steps
 *   - Assertions that verify expected recording mode
 *
 * The scope keys written by these steps are:
 *   pgwen.video.mode     — the desired recording mode: on | retain-on-failure | off
 *   pgwen.video.path     — path to the saved video file (populated by PlaywrightRunner
 *                          after context.close(); readable in post-execution steps)
 *
 * Config alternative (preferred for project-wide settings in pgwen.conf):
 *   pgwen.web.capture.video = "on"               # record always
 *   pgwen.web.capture.video = "retain-on-failure" # keep only on failure (default)
 *   pgwen.web.capture.video = "off"              # disable video
 *
 * DSL alternative (per-test override in meta, expressed in plain Gherkin):
 *   When I enable video recording
 *   When I set video recording to "retain-on-failure"
 *   Then I capture the video path as savedVideoPath
 *   Then the video should be recorded
 */

import type { DslRegistry } from '../registry';
import type { Scope } from '../../engine/Scope';

// ─── Types ────────────────────────────────────────────────────────────────────

type VideoMode = 'on' | 'retain-on-failure' | 'off';

// Minimal interface — page.video() is only available when video recording is
// enabled on the BrowserContext that owns the page.
interface PageWithVideo {
  video(): { path(): Promise<string | null> } | null;
}

// ─── registerVideoActions ─────────────────────────────────────────────────────

export function registerVideoActions(registry: DslRegistry): void {

  // ─── Mode control ─────────────────────────────────────────────────────────

  /**
   * Set the desired video recording mode for the current test.
   * Writes `pgwen.video.mode` to scope. PlaywrightRunner reads this override
   * (when present) in preference to the project-level pgwen.conf setting.
   *
   * Usage in meta:
   *   When I set video recording to "on"
   *   When I set video recording to "retain-on-failure"
   *   When I set video recording to "off"
   */
  registry.register(
    /^I set video recording to "([^"]+)"$/i,
    async ([rawMode = ''], scope: Scope) => {
      const mode = normaliseMode(rawMode);
      scope.set('pgwen.video.mode', mode);
    }
  );

  /**
   * Enable video recording for the current test.
   * Equivalent to: I set video recording to "on"
   *
   * Usage in meta:
   *   When I enable video recording
   */
  registry.register(
    /^I enable video recording$/i,
    async (_groups, scope: Scope) => {
      scope.set('pgwen.video.mode', 'on');
    }
  );

  /**
   * Disable video recording for the current test.
   * Equivalent to: I set video recording to "off"
   *
   * Usage in meta:
   *   When I disable video recording
   */
  registry.register(
    /^I disable video recording$/i,
    async (_groups, scope: Scope) => {
      scope.set('pgwen.video.mode', 'off');
    }
  );

  /**
   * Set video to retain only on test failure.
   * Equivalent to: I set video recording to "retain-on-failure"
   *
   * Usage in meta:
   *   When I set video to retain on failure
   */
  registry.register(
    /^I set video to retain on failure$/i,
    async (_groups, scope: Scope) => {
      scope.set('pgwen.video.mode', 'retain-on-failure');
    }
  );

  // ─── Path capture ──────────────────────────────────────────────────────────

  /**
   * Capture the video file path into a named scope binding.
   *
   * The path is read first from scope key `pgwen.video.path` (set by
   * PlaywrightRunner after context.close() finalises the recording).
   * If not available (e.g. recording is off or path not yet set), the step
   * falls back to page.video()?.path() which may return null during execution.
   *
   * Best used in a @Finally step after execution completes.
   *
   * Usage in meta:
   *   Then I capture the video path as videoPath
   *   Then I capture the video file path as recordedVideo
   */
  registry.register(
    /^I capture the video(?: file)? path as (.+)$/i,
    async ([rawName = ''], scope: Scope, page: unknown) => {
      const name = rawName.trim();

      // Prefer explicit path set by PlaywrightRunner after context close
      const explicitPath = scope.get('pgwen.video.path');
      if (explicitPath !== undefined) {
        scope.set(name, explicitPath);
        return;
      }

      // Fall back to page.video()?.path() when available (during execution)
      try {
        const p = (page as PageWithVideo).video?.();
        const filePath = p ? await p.path() : null;
        scope.set(name, filePath ?? '');
      } catch {
        scope.set(name, '');
      }
    }
  );

  // ─── Assertions ────────────────────────────────────────────────────────────

  /**
   * Assert that video recording is enabled (mode is not "off").
   * Reads the `pgwen.video.mode` scope binding set by I enable/set video steps,
   * or falls back to checking the Playwright page.video() reference.
   *
   * Usage in meta:
   *   Then the video should be recorded
   *   Then the video should not be recorded
   */
  registry.register(
    /^the video should( not)? be recorded$/i,
    async ([notFlag], scope: Scope, page: unknown) => {
      const negate = notFlag !== undefined && notFlag !== '';
      const mode = scope.get('pgwen.video.mode');

      // If mode was explicitly set in scope, use that
      if (mode !== undefined) {
        const isEnabled = mode !== 'off';
        if (negate && isEnabled) {
          throw new Error(`Expected video recording to be disabled but mode is "${mode}"`);
        }
        if (!negate && !isEnabled) {
          throw new Error(`Expected video recording to be enabled but mode is "off"`);
        }
        return;
      }

      // Fall back to checking page.video() reference
      try {
        const videoRef = (page as PageWithVideo).video?.();
        const isRecording = videoRef !== null && videoRef !== undefined;
        if (negate && isRecording) {
          throw new Error('Expected video recording to be disabled but a video reference exists');
        }
        if (!negate && !isRecording) {
          throw new Error('Expected video recording to be enabled but no video reference exists (check pgwen.conf: pgwen.web.capture.video)');
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Expected')) throw err;
        // If page.video is not available (dry run, no browser) — treat as not recording
        if (negate) return; // not recording → assertion passes
        throw new Error('Expected video recording to be enabled but no browser page is available');
      }
    }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseMode(raw: string): VideoMode {
  const lower = raw.trim().toLowerCase();
  if (lower === 'on' || lower === 'always') return 'on';
  if (lower === 'off' || lower === 'never' || lower === 'disabled') return 'off';
  return 'retain-on-failure';
}
