/**
 * reporting/ScreenshotCapture.ts — Screenshot-on-failure capture for pgwen.
 *
 * Captures a full-page PNG screenshot via a Playwright page reference and
 * writes it to the specified output path.  Called by PlaywrightRunner after a
 * feature run completes with a failed status, before the browser context is
 * closed.
 *
 * Output path convention (mirrors the reference framework):
 *   <outputDir>/reports/html/attachments/screenshots/<slug>.png
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Minimal page interface (no top-level playwright import) ──────────────────

export interface ScreenshotPage {
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
}

// ─── ScreenshotCapture ────────────────────────────────────────────────────────

export class ScreenshotCapture {
  /**
   * Capture a full-page screenshot and save it to `outputPath`.
   * The parent directory is created if it does not exist.
   * Returns the resolved output path on success, or null if capture fails.
   */
  static async capture(
    page: ScreenshotPage,
    outputPath: string,
    options: { fullPage?: boolean } = {}
  ): Promise<string | null> {
    try {
      const dir = path.dirname(outputPath);
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: outputPath, fullPage: options.fullPage ?? true });
      return outputPath;
    } catch {
      return null;
    }
  }
}
