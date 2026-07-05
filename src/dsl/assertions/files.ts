/**
 * assertions/files.ts — File existence and content assertion steps.
 *
 * Implements the DSL file assertion patterns:
 *   the file "<filepath>" should[ not] exist
 *   the file "<filepath>" should[ not] be empty
 *   the file "<filepath>" should[ not] contain "<text>"
 *
 * the reference framework alias forms (used in project meta files):
 *   "<path>" file should[ not] exist
 *   "<path>" file should[ not] be empty
 *   <binding> file should[ not] exist      ← binding resolves to path
 *   <binding> file should[ not] be empty   ← binding resolves to path
 *   I wait until "<path>" file exists
 *   I wait until <binding> file exists
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DslRegistry } from '../registry';
import { DslAssertionError } from '../locatorUtils';

export function registerFileAssertions(registry: DslRegistry): void {
  const reg = registry.withCategory('assertion');

  // the file "<filepath>" should[ not] exist
  reg.register(
    /^the file "([^"]+)" should (not )?exist$/i,
    async ([filepath, notStr]) => {
      const negate = !!notStr;
      const exists = fs.existsSync(filepath!);
      if (negate ? exists : !exists) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}exist`
        );
      }
    }
  );

  // the file "<filepath>" should[ not] be empty
  reg.register(
    /^the file "([^"]+)" should (not )?be empty$/i,
    async ([filepath, notStr]) => {
      const negate = !!notStr;
      let isEmpty: boolean;
      if (!fs.existsSync(filepath!)) {
        isEmpty = true;
      } else {
        const content = fs.readFileSync(filepath!, 'utf-8');
        isEmpty = content.trim().length === 0;
      }
      if (negate ? isEmpty : !isEmpty) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}be empty`
        );
      }
    }
  );

  // the file "<filepath>" should[ not] contain "<text>"
  reg.register(
    /^the file "([^"]+)" should (not )?contain "([^"]*)"$/i,
    async ([filepath, notStr, expected]) => {
      const negate = !!notStr;
      let contains: boolean;
      if (!fs.existsSync(filepath!)) {
        contains = false;
      } else {
        const content = fs.readFileSync(filepath!, 'utf-8');
        contains = content.includes(expected!);
      }
      if (negate ? contains : !contains) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}contain "${expected}"`
        );
      }
    }
  );

  // ─── the reference framework alias forms ────────────────────────────────────────────────────────
  // These match how the reference framework projects actually write file assertions in .meta files.
  // Registered before the generic binding form so specificity is preserved.

  // "<path>" file should[ not] exist
  reg.register(
    /^"([^"]+)" file should (not )?exist$/i,
    async ([filepath, notStr]) => {
      const negate = !!notStr;
      const exists = fs.existsSync(filepath!);
      if (negate ? exists : !exists) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}exist`
        );
      }
    }
  );

  // "<path>" file should[ not] be empty
  reg.register(
    /^"([^"]+)" file should (not )?be empty$/i,
    async ([filepath, notStr]) => {
      const negate = !!notStr;
      let isEmpty: boolean;
      if (!fs.existsSync(filepath!)) {
        isEmpty = true;
      } else {
        const content = fs.readFileSync(filepath!, 'utf-8');
        isEmpty = content.trim().length === 0;
      }
      if (negate ? isEmpty : !isEmpty) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}be empty`
        );
      }
    }
  );

  // <binding> file should[ not] exist   (binding name resolves to path)
  // The regex captures everything before " file should" as ref. Since project bindings
  // are typically named "<word> file" (e.g. "pdf file", "downloaded file"), the
  // captured ref is just the prefix word. Resolve by trying "<ref> file" in scope
  // first, then "<ref>", then fall back to "<ref> file" as a literal path.
  reg.register(
    /^(.+) file should (not )?exist$/i,
    async ([ref, notStr], scope) => {
      const negate = !!notStr;
      const key = ref!.trim();
      const filepath = scope.get(key + ' file') ?? scope.get(key) ?? (key + ' file');
      const exists = fs.existsSync(filepath);
      if (negate ? exists : !exists) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}exist`
        );
      }
    }
  );

  // <binding> file should[ not] be empty   (binding name resolves to path)
  reg.register(
    /^(.+) file should (not )?be empty$/i,
    async ([ref, notStr], scope) => {
      const negate = !!notStr;
      const key = ref!.trim();
      const filepath = scope.get(key + ' file') ?? scope.get(key) ?? (key + ' file');
      let isEmpty: boolean;
      if (!fs.existsSync(filepath)) {
        isEmpty = true;
      } else {
        const content = fs.readFileSync(filepath, 'utf-8');
        isEmpty = content.trim().length === 0;
      }
      if (negate ? isEmpty : !isEmpty) {
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${negate ? 'not ' : ''}be empty`
        );
      }
    }
  );

  // I wait until "<path>" file exists   (polls filesystem until file appears)
  reg.register(
    /^I wait until "([^"]+)" file exists$/i,
    async ([filepath]) => {
      await waitForFile(filepath!);
    }
  );

  // I wait until <binding> file exists   (binding resolves to path)
  // Same binding-name resolution as the exist/empty forms above.
  reg.register(
    /^I wait until (.+) file exists$/i,
    async ([ref], scope) => {
      const key = ref!.trim();
      const filepath = scope.get(key + ' file') ?? scope.get(key) ?? (key + ' file');
      await waitForFile(filepath);
    }
  );

  // <name> should be unique in the "<filepath>" file
  // Reads the CSV file and asserts the scope value of <name> appears exactly once
  // in the column whose header matches <name>.
  reg.register(
    /^(.+) should be unique in the "([^"]+)" file$/i,
    async ([refName, filepath], scope) => {
      const value = scope.get(refName!.trim()) ?? refName!.trim();
      const fullPath = path.resolve(filepath!);
      if (!fs.existsSync(fullPath)) {
        throw new DslAssertionError(`File "${filepath}" not found for uniqueness check`);
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) return; // only header or empty — trivially unique
      const headers = lines[0]!.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const colIndex = headers.findIndex(h => h === refName!.trim());
      const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
      const colValues = colIndex >= 0
        ? rows.map(r => r[colIndex] ?? '').filter(v => v === value)
        : rows.map(r => r.join(',')).filter(r => r.includes(value));
      if (colValues.length > 1) {
        throw new DslAssertionError(
          `Expected "${refName}" to be unique in "${filepath}" but found ${colValues.length} occurrences of "${value}"`
        );
      }
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Poll until a file exists or timeout (default 30s). */
async function waitForFile(filepath: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(filepath)) {
    if (Date.now() - start > timeoutMs) {
      throw new DslAssertionError(`Timed out after ${timeoutMs}ms waiting for file "${filepath}" to exist`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}
