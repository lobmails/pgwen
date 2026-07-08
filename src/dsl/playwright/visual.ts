/**
 * playwright/visual.ts — Visual diff DSL steps (screenshot comparison).
 *
 * Playwright-exclusive DSL (no WebDriver-style/equivalent).
 *
 * Registers these step patterns:
 *   I save the page snapshot as "<name>"
 *   the page should match the snapshot "<name>"
 *   I save the element <element> snapshot as "<name>"
 *   the element <element> should match the snapshot "<name>"
 *
 * Snapshots are stored as PNG files in a configurable directory
 * (default: process.cwd()/snapshots). On first run, saving a snapshot creates
 * the baseline. Subsequent runs compare against the saved baseline.
 *
 * Usage in .meta files:
 *   Given I save the page snapshot as "dashboard-baseline"
 *   Then the page should match the snapshot "dashboard-baseline"
 *   Given I save the element header snapshot as "header-baseline"
 *   Then the element header should match the snapshot "header-baseline"
 */

import * as fs from 'fs';
import * as path from 'path';
import { toPosixPath } from '../../util/paths';
import type { DslRegistry } from '../registry';
import { resolveLocator } from '../locatorUtils';
import type { Scope } from '../../engine/Scope';

interface PageLike {
  screenshot: (options?: ScreenshotOptions) => Promise<Buffer>;
}

interface LocatorLike {
  screenshot: (options?: ScreenshotOptions) => Promise<Buffer>;
}

interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
}

// ─── Snapshot directory ────────────────────────────────────────────────────────

function snapshotDir(scope: Scope): string {
  // Allow override via scope/config; fall back to cwd/snapshots
  return scope.get('pgwen.visual.snapshot.dir') ?? path.join(process.cwd(), 'snapshots');
}

function snapshotPath(scope: Scope, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  return toPosixPath(path.join(snapshotDir(scope), `${safeName}.png`));
}

// ─── Comparison ───────────────────────────────────────────────────────────────

/**
 * Compare two PNG buffers. Returns the number of differing bytes.
 * Two buffers with no differences return 0.
 */
function bufferDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerVisual(registry: DslRegistry): void {

  // I save the page snapshot as "<name>"
  registry.register(
    /^I save the page snapshot as "(.+)"$/i,
    async ([nameRaw], scope, page) => {
      const name = nameRaw!.trim();
      const filePath = snapshotPath(scope, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const buf = await (page as PageLike).screenshot({ type: 'png', fullPage: true });
      fs.writeFileSync(filePath, buf);
    }
  );

  // the page should match the snapshot "<name>"
  registry.register(
    /^the page should match the snapshot "(.+)"$/i,
    async ([nameRaw], scope, page) => {
      const name = nameRaw!.trim();
      const filePath = snapshotPath(scope, name);
      if (!fs.existsSync(filePath)) {
        // Auto-save baseline on first run
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const buf = await (page as PageLike).screenshot({ type: 'png', fullPage: true });
        fs.writeFileSync(filePath, buf);
        return;
      }
      const baseline = fs.readFileSync(filePath);
      const actual = await (page as PageLike).screenshot({ type: 'png', fullPage: true });
      const diff = bufferDiff(baseline, actual);
      if (diff > 0) {
        throw new Error(
          `Page screenshot does not match baseline "${name}" (${diff} byte(s) differ).\n` +
          `Baseline: ${filePath}\n` +
          `Delete the baseline file to regenerate it.`
        );
      }
    }
  );

  // I save the element <element> snapshot as "<name>"
  registry.register(
    /^I save the element (.+?) snapshot as "(.+)"$/i,
    async ([elementName, nameRaw], scope, page) => {
      const name = nameRaw!.trim();
      const filePath = snapshotPath(scope, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const loc = await resolveLocator(elementName!, scope);
      const buf = await (loc as unknown as LocatorLike).screenshot({ type: 'png' });
      fs.writeFileSync(filePath, buf);
    }
  );

  // the element <element> should match the snapshot "<name>"
  registry.register(
    /^the element (.+?) should match the snapshot "(.+)"$/i,
    async ([elementName, nameRaw], scope) => {
      const name = nameRaw!.trim();
      const filePath = snapshotPath(scope, name);
      const loc = await resolveLocator(elementName!, scope);
      if (!fs.existsSync(filePath)) {
        // Auto-save baseline on first run
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const buf = await (loc as unknown as LocatorLike).screenshot({ type: 'png' });
        fs.writeFileSync(filePath, buf);
        return;
      }
      const baseline = fs.readFileSync(filePath);
      const actual = await (loc as unknown as LocatorLike).screenshot({ type: 'png' });
      const diff = bufferDiff(baseline, actual);
      if (diff > 0) {
        throw new Error(
          `Element "${elementName}" screenshot does not match baseline "${name}" (${diff} byte(s) differ).\n` +
          `Baseline: ${filePath}\n` +
          `Delete the baseline file to regenerate it.`
        );
      }
    }
  );
}
