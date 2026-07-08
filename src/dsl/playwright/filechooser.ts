/**
 * playwright/filechooser.ts — File chooser DSL steps.
 *
 * Playwright-exclusive DSL (no WebDriver-style/equivalent).
 *
 * Registers these step patterns:
 *   I select file "<path>" in file chooser
 *   I select files "<path1>, <path2>, ..." in file chooser
 *
 * These steps register a one-shot `page.once('filechooser', handler)` listener,
 * which fires when the next action (e.g. clicking an upload button) opens a
 * native file picker dialog.
 *
 * Usage in .meta files:
 *   Given I select file "uploads/report.csv" in file chooser
 *   When I click the upload button
 *
 *   Given I select files "uploads/img1.png, uploads/img2.png" in file chooser
 *   When I click the attach button
 *
 * The files argument accepts a single path (unquoted within the outer quotes) or a
 * comma-separated list of paths. Leading/trailing whitespace around each path is
 * stripped before passing to Playwright's `fileChooser.setFiles()`.
 */

import type { DslRegistry } from '../registry';
import type { PageLike, FileChooserLike } from '../locatorUtils';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerFileChooser(registry: DslRegistry): void {

  // I select file "<path>" in file chooser
  registry.register(
    /^I select file "([^"]+)" in file chooser$/i,
    async ([filePath], _scope, page) => {
      (page as PageLike).once('filechooser', (fileChooser: FileChooserLike) => {
        void fileChooser.setFiles(filePath!.trim());
      });
    }
  );

  // I select files "<path1>, <path2>, ..." in file chooser
  registry.register(
    /^I select files "([^"]+)" in file chooser$/i,
    async ([filesRaw], _scope, page) => {
      const files = filesRaw!.split(',').map((f) => f.trim()).filter(Boolean);
      (page as PageLike).once('filechooser', (fileChooser: FileChooserLike) => {
        void fileChooser.setFiles(files);
      });
    }
  );
}
