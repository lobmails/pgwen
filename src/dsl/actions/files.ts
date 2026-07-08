/**
 * actions/files.ts — File system and file-transfer steps.
 *
 * File I/O operations use Node.js `fs` (no browser involvement).
 * Upload / download steps use the Playwright file-chooser / download APIs.
 *
 * Supported patterns:
 *   I write "<text>" to the file "<filepath>"
 *   I append "<text>" to the file "<filepath>"
 *   I write <textRef> to the file "<filepath>"
 *   I append <textRef> to the file "<filepath>"
 *   I delete the file "<filepath>"
 *   I copy the file "<source>" to "<destination>"
 *   I move the file "<source>" to "<destination>"
 *   I upload the file "<filepath>" to <element>
 *   I click <element> and download the file
 *   I click <element> and download the file as <name>
 *   <name> is defined in the file "<filepath>"   (reads value from properties file)
 *
 * File assertions (same module for cohesion):
 *   the file "<filepath>" should[ not] exist
 *   the file "<filepath>" should[ not] be empty
 *   the file "<filepath>" should[ not] contain "<expression>"
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, copyFileSync, renameSync } from 'fs';
import * as path from 'path';
import type { DslRegistry } from '../registry';
import type { PageLike, FileChooserLike, DownloadLike } from '../locatorUtils';
import { resolveLocator, DslAssertionError } from '../locatorUtils';
import { parseCsvFeed } from '../../data/CsvFeedReader';
import type { Scope } from '../../engine/Scope';

/**
 * Resolve a ref captured from the `to the <ref> file` pattern into a filepath.
 * Mirrors the existing file-assertion convention (see assertions/files.ts:127):
 * try `<ref> file` first, then `<ref>` alone, then fall back to `<ref> file`
 * as a literal path. Lets authors bind paths under names ending in "file"
 * (e.g. `the failed log file`) and reference them with just the prefix
 * (`to the failed log file`).
 */
function resolveFilepathRef(rawRef: string, scope: Scope): string {
  const ref = rawRef.trim();
  return scope.get(`${ref} file`) ?? scope.get(ref) ?? `${ref} file`;
}

/**
 * Copy a file into the scenario's attachment directory under the given name.
 * The output dir is `${pgwen.outdir}/attachments/` (scenario-scoped by the
 * Runner that creates the outdir).
 */
function attachFile(sourcePath: string, attachName: string, scope: Scope): void {
  const outDir = scope.get('pgwen.outdir') ?? '.';
  const path = require('path') as typeof import('path');
  const fs   = require('fs')   as typeof import('fs');
  const dst  = path.join(outDir, 'attachments', attachName);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(sourcePath, dst);
  scope.setTransparent(`attachment.${attachName}`, dst);
}

/**
 * Fetch a URL into a local file. Uses the global fetch (Node 18+) so no
 * new deps. Binary-safe — writes the response body as a Buffer.
 */
async function downloadUrlTo(url: string, filepath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const path = require('path') as typeof import('path');
  const fs   = require('fs')   as typeof import('fs');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buf);
}

export function registerFileActions(registry: DslRegistry): void {

  // ─── Write / Append ───────────────────────────────────────────────────────

  // I write "<text>" to the file "<filepath>"
  registry.register(
    /^I write "([^"]*)" to the file "([^"]+)"$/i,
    async ([text, filepath]) => {
      writeFileSync(filepath!, text!, 'utf-8');
    }
  );

  // I append "<text>" to the file "<filepath>"
  registry.register(
    /^I append "([^"]*)" to the file "([^"]+)"$/i,
    async ([text, filepath]) => {
      appendFileSync(filepath!, text!, 'utf-8');
    }
  );

  // I write/append new line to the file "<filepath>"  — must come before textRef form
  registry.register(
    /^I (write|append) new line to the file "([^"]+)"$/i,
    async ([mode, filepath]) => {
      if (mode!.toLowerCase() === 'write') {
        writeFileSync(filepath!, '\n', 'utf-8');
      } else {
        appendFileSync(filepath!, '\n', 'utf-8');
      }
    }
  );

  // I write <textRef> to the file "<filepath>"
  registry.register(
    /^I write (.+) to the file "([^"]+)"$/i,
    async ([textRef, filepath], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      writeFileSync(filepath!, text, 'utf-8');
    }
  );

  // I append <textRef> to the file "<filepath>"
  registry.register(
    /^I append (.+) to the file "([^"]+)"$/i,
    async ([textRef, filepath], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      appendFileSync(filepath!, text, 'utf-8');
    }
  );

  // ─── pgwen-style write/append: to "<path>" file (no "the") ───────────────
  //     exact syntax: I write "text" to "filepath" file
  //     pgwen also keeps the "to the file" form above for backwards compat.

  // I write/append new line to "<filepath>" file  — before generic textRef form
  registry.register(
    /^I (write|append) new line to "([^"]+)" file$/i,
    async ([mode, filepath]) => {
      if (mode!.toLowerCase() === 'write') {
        writeFileSync(filepath!, '\n', 'utf-8');
      } else {
        appendFileSync(filepath!, '\n', 'utf-8');
      }
    }
  );

  // I write "<text>" to "<filepath>" file
  registry.register(
    /^I (write|append) "([^"]*)" to "([^"]+)" file$/i,
    async ([mode, text, filepath]) => {
      if (mode!.toLowerCase() === 'write') {
        writeFileSync(filepath!, text!, 'utf-8');
      } else {
        appendFileSync(filepath!, text!, 'utf-8');
      }
    }
  );

  // I write <textRef> to "<filepath>" file  (binding reference form)
  registry.register(
    /^I (write|append) (.+) to "([^"]+)" file$/i,
    async ([mode, textRef, filepath], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      if (mode!.toLowerCase() === 'write') {
        writeFileSync(filepath!, text, 'utf-8');
      } else {
        appendFileSync(filepath!, text, 'utf-8');
      }
    }
  );

  // ─── Ref-based file form: to the <fileRef> file ──────────────────────────
  //     I (write|append) new line to the <fileRef> file       — new line via ref
  //     I (write|append) <textRef> to the <fileRef> file       — text + file refs
  //   The <fileRef> resolves through scope; if no binding exists, the token is
  //   used literally as a path. The new-line variant is registered FIRST so
  //   the generic textRef pattern doesn't swallow it.

  // I (write|append) new line to the <fileRef> file
  registry.register(
    /^I (write|append) new line to the (.+) file$/i,
    async ([mode, fileRef], scope) => {
      const filepath = resolveFilepathRef(fileRef!, scope);
      if (mode!.toLowerCase() === 'write') {
        writeFileSync(filepath, '\n', 'utf-8');
      } else {
        appendFileSync(filepath, '\n', 'utf-8');
      }
    }
  );

  // I (write|append) <textRef> to the <fileRef> file
  registry.register(
    /^I (write|append) (.+?) to the (.+) file$/i,
    async ([mode, textRef, fileRef], scope) => {
      const text = scope.get(textRef!.trim()) ?? textRef!.trim();
      const filepath = resolveFilepathRef(fileRef!, scope);
      if (mode!.toLowerCase() === 'write') {
        writeFileSync(filepath, text, 'utf-8');
      } else {
        appendFileSync(filepath, text, 'utf-8');
      }
    }
  );

  // ─── File attach ────────────────────────────────────────────────────────
  //
  //   I attach "<filepath>"            — copies the file into the scenario's
  //                                       attachments directory under its basename
  //   I attach "<filepath>" as "<n>"   — copies as the given attachment name
  //   I attach "<filepath>" as <name>  — name resolved through scope first

  registry.register(
    /^I attach "([^"]+)" as "([^"]+)"$/i,
    async ([filepath, attachName], scope) => {
      attachFile(filepath!, attachName!, scope);
    }
  );

  registry.register(
    /^I attach "([^"]+)" as (.+)$/i,
    async ([filepath, nameRef], scope) => {
      const attachName = scope.get(nameRef!.trim()) ?? nameRef!.trim();
      attachFile(filepath!, attachName, scope);
    }
  );

  registry.register(
    /^I attach "([^"]+)"$/i,
    async ([filepath], scope) => {
      attachFile(filepath!, require('path').basename(filepath!), scope);
    }
  );

  // ─── Download ───────────────────────────────────────────────────────────
  //
  //   I download "<url>" to "<filepath>"
  //   I download "<url>" to <filepathRef>
  //   I download the current URL to "<filepath>"
  //   I download the current URL to <filepathRef>
  //
  // Uses native fetch (Node 18+) — no new deps. For data secured behind
  // session cookies, capture via the browser's page.evaluate instead.

  registry.register(
    /^I download "([^"]+)" to "([^"]+)"$/i,
    async ([url, filepath]) => {
      await downloadUrlTo(url!, filepath!);
    }
  );

  registry.register(
    /^I download "([^"]+)" to (.+)$/i,
    async ([url, fileRef], scope) => {
      const filepath = resolveFilepathRef(fileRef!, scope);
      await downloadUrlTo(url!, filepath);
    }
  );

  registry.register(
    /^I download the current URL to "([^"]+)"$/i,
    async ([filepath], _scope, page) => {
      const url = (page as PageLike).url();
      await downloadUrlTo(url, filepath!);
    }
  );

  registry.register(
    /^I download the current URL to (.+)$/i,
    async ([fileRef], scope, page) => {
      const filepath = resolveFilepathRef(fileRef!, scope);
      const url = (page as PageLike).url();
      await downloadUrlTo(url, filepath);
    }
  );

  // ─── CSV file lookup ──────────────────────────────────────────────────────
  // I lookup <name> in the "<file>" file where "<predicate>"
  // I lookup <name> in "<file>" file where "<predicate>"
  // Loads the CSV file, filters rows where the predicate expression (after scope
  // interpolation) evaluates to true, binds the matched column value to <name>.
  // Predicate form: "'${col}' == 'value'" — interpolation happens in scope context.

  registry.register(
    /^I lookup (.+?) in (?:the )?"([^"]+)" file where "([^"]+)"$/i,
    async ([nameRaw, filePath, predicate], scope) => {
      const name = nameRaw!.trim();
      const resolvedPath = path.resolve(filePath!);
      const records = parseCsvFeed(resolvedPath, { autoTrim: true });
      for (const record of records) {
        // Evaluate predicate: substitute ${col} tokens using record values first,
        // then fall back to scope for any remaining ${...} refs.
        const pred = predicate!.replace(/\$\{([^}]+)\}/g, (_, key: string) =>
          Object.prototype.hasOwnProperty.call(record, key) ? record[key]! : (scope.get(key) ?? '')
        );
        // eslint-disable-next-line no-new-func
        let matched = false;
        try { matched = Boolean(new Function(`return (${pred})`)()); } catch { matched = false; }
        if (matched) {
          // If <name> is a column in the CSV, bind that column's value.
          // Otherwise bind the entire record as JSON (for special lookup patterns).
          if (Object.prototype.hasOwnProperty.call(record, name)) {
            scope.set(name, record[name]!);
          } else {
            const firstVal = Object.values(record)[0] ?? '';
            scope.set(name, firstVal);
          }
          return;
        }
      }
      // No match — leave binding unset (Preserves behaviour)
    }
  );

  // ─── Delete / Copy / Move ────────────────────────────────────────────────

  // I delete the file "<filepath>"
  registry.register(
    /^I delete the file "([^"]+)"$/i,
    async ([filepath]) => {
      unlinkSync(filepath!);
    }
  );

  // I copy the file "<source>" to "<destination>"
  registry.register(
    /^I copy the file "([^"]+)" to "([^"]+)"$/i,
    async ([source, destination]) => {
      copyFileSync(source!, destination!);
    }
  );

  // I move the file "<source>" to "<destination>"
  registry.register(
    /^I move the file "([^"]+)" to "([^"]+)"$/i,
    async ([source, destination]) => {
      renameSync(source!, destination!);
    }
  );

  // ─── Upload / Download ───────────────────────────────────────────────────

  // I upload the file "<filepath>" to <element>
  registry.register(
    /^I upload the file "([^"]+)" to (.+)$/i,
    async ([filepath, elementName], scope, page) => {
      const [fileChooser] = await Promise.all([
        (page as PageLike).waitForEvent('filechooser') as Promise<FileChooserLike>,
        (async () => {
          const loc = await resolveLocator(elementName!.trim(), scope);
          await loc.click();
        })(),
      ]);
      await fileChooser.setFiles(filepath!);
    }
  );

  // I click <element> and download the file [as <name>]
  registry.register(
    /^I click (.+) and download the file(?: as (.+))?$/i,
    async ([elementName, nameRaw], scope, page) => {
      const name = (nameRaw || 'pgwen.download.path').trim();
      const [download] = await Promise.all([
        (page as PageLike).waitForEvent('download') as Promise<DownloadLike>,
        (async () => {
          const loc = await resolveLocator(elementName!.trim(), scope);
          await loc.click();
        })(),
      ]);
      const path = await download.path();
      scope.set(name, path ?? '');
    }
  );

  // ─── Properties file binding ─────────────────────────────────────────────

  // <name> is defined in the file "<filepath>"
  // Reads the first non-comment, non-empty line and binds it to <name>.
  registry.register(
    /^(.+) is defined in the file "([^"]+)"$/i,
    async ([name, filepath], scope) => {
      const content = readFileSync(filepath!, 'utf-8');
      // Support simple key=value properties files — extract value for the given key
      // If name matches a key, use its value; otherwise store the whole file content.
      const key = name!.trim();
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const lineKey = trimmed.slice(0, eqIdx).trim();
          const lineVal = trimmed.slice(eqIdx + 1).trim();
          if (lineKey === key) {
            scope.set(key, lineVal);
            return;
          }
        }
      }
      // Key not found — store first non-comment line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          scope.set(key, trimmed);
          return;
        }
      }
    }
  );

  // ─── File assertions ─────────────────────────────────────────────────────

  // the file "<filepath>" should[ not] exist
  registry.register(
    /^the file "([^"]+)" should (not )?exist$/i,
    async ([filepath, notStr]) => {
      const negate = !!notStr;
      const exists = existsSync(filepath!);
      if (negate ? exists : !exists) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected file "${filepath}" to ${notWord}exist`);
      }
    }
  );

  // the file "<filepath>" should[ not] be empty
  registry.register(
    /^the file "([^"]+)" should (not )?be empty$/i,
    async ([filepath, notStr]) => {
      const negate = !!notStr;
      if (!existsSync(filepath!)) {
        throw new DslAssertionError(`File "${filepath}" does not exist`);
      }
      const content = readFileSync(filepath!, 'utf-8');
      const isEmpty = content.trim().length === 0;
      if (negate ? isEmpty : !isEmpty) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected file "${filepath}" to ${notWord}be empty`);
      }
    }
  );

  // the file "<filepath>" should[ not] contain "<expression>"
  registry.register(
    /^the file "([^"]+)" should (not )?contain "([^"]*)"$/i,
    async ([filepath, notStr, expression]) => {
      const negate = !!notStr;
      if (!existsSync(filepath!)) {
        throw new DslAssertionError(`File "${filepath}" does not exist`);
      }
      const content = readFileSync(filepath!, 'utf-8');
      const contains = content.includes(expression!);
      if (negate ? contains : !contains) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(
          `Expected file "${filepath}" to ${notWord}contain "${expression}"`
        );
      }
    }
  );

  // ─── Unquoted filepath reference forms ───────────────────────────────────
  // Allow scope bindings to be used as file paths without quoting.
  // e.g. "I delete the file downloadedPath" where downloadedPath = "/tmp/file.csv"
  // Registered AFTER all quoted forms so that quoted paths always take priority.

  // I delete the file <filepathRef>
  registry.register(
    /^I delete the file (.+)$/i,
    async ([filepathRef], scope) => {
      const filepath = scope.get(filepathRef!.trim()) ?? filepathRef!.trim();
      unlinkSync(filepath);
    }
  );

  // I copy the file <sourceRef> to <destRef>  — unquoted refs
  registry.register(
    /^I copy the file (.+) to (.+)$/i,
    async ([sourceRef, destRef], scope) => {
      const source = scope.get(sourceRef!.trim()) ?? sourceRef!.trim();
      const dest   = scope.get(destRef!.trim())   ?? destRef!.trim();
      copyFileSync(source, dest);
    }
  );

  // I move the file <sourceRef> to <destRef>  — unquoted refs
  registry.register(
    /^I move the file (.+) to (.+)$/i,
    async ([sourceRef, destRef], scope) => {
      const source = scope.get(sourceRef!.trim()) ?? sourceRef!.trim();
      const dest   = scope.get(destRef!.trim())   ?? destRef!.trim();
      renameSync(source, dest);
    }
  );

  // the file <filepathRef> should[ not] exist  — unquoted ref
  registry.register(
    /^the file (.+) should (not )?exist$/i,
    async ([filepathRef, notStr], scope) => {
      const filepath = scope.get(filepathRef!.trim()) ?? filepathRef!.trim();
      const negate = !!notStr;
      const exists = existsSync(filepath);
      if (negate ? exists : !exists) {
        const notWord = negate ? 'not ' : '';
        throw new DslAssertionError(`Expected file "${filepath}" to ${notWord}exist`);
      }
    }
  );
}
