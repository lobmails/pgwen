/**
 * SuggestionWriter.ts — writes the per-suggestion `.json` + `.patch` pair
 * under `<reportsDir>/suggestions/`. Idempotent: same id → same files,
 * overwritten on rerun (so re-running pgwen-fix after editing a config
 * always reflects the latest validation result).
 *
 * Filename slug pattern mirrors `@pgwen/core`'s diagnosis-history layout:
 *   <feature-slug>__<scenario-slug>__<isoStamp-without-colons>
 * so an operator can correlate sidecars across the diagnose → fix pipeline
 * by eyeballing filenames.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Suggestion } from './types';

const SUGGESTIONS_SUBDIR = 'suggestions';

/**
 * Slugify a free-text name for use in a filename component.
 * Lowercase, ASCII alphanumeric + hyphen, capped at 60 chars.
 * Empty input collapses to "unknown" so the filename always has a token.
 */
export function slugify(input: string): string {
  const lowered = input.toLowerCase().trim();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = replaced.slice(0, 60);
  return truncated.length > 0 ? truncated : 'unknown';
}

export interface SuggestionIdInputs {
  feature_name: string;
  feature_file: string;
  scenario_name: string;
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
}

/**
 * Build the suggestion id — also the filename stem (no extension) for
 * both the `.json` and `.patch` artefacts.
 */
export function buildSuggestionId(inputs: SuggestionIdInputs): string {
  const featureSlug = slugify(
    inputs.feature_name ||
      path.basename(inputs.feature_file, path.extname(inputs.feature_file)),
  );
  const scenarioSlug = slugify(inputs.scenario_name);
  const stamp = inputs.timestamp.replace(/[:.]/g, '-');
  return `${featureSlug}__${scenarioSlug}__${stamp}`;
}

export interface WriteSuggestionResult {
  jsonPath: string;
  patchPath: string;
}

/**
 * Write the `.json` and `.patch` sidecars under `<reportsDir>/suggestions/`.
 * Returns the absolute paths written. Creates the directory tree if needed.
 */
export function writeSuggestion(reportsDir: string, suggestion: Suggestion): WriteSuggestionResult {
  const dir = path.join(reportsDir, SUGGESTIONS_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });

  const jsonPath = path.join(dir, `${suggestion.id}.json`);
  const patchPath = path.join(dir, `${suggestion.id}.patch`);

  fs.writeFileSync(jsonPath, JSON.stringify(suggestion, null, 2) + '\n', 'utf8');
  fs.writeFileSync(patchPath, suggestion.patch.endsWith('\n') ? suggestion.patch : suggestion.patch + '\n', 'utf8');

  return { jsonPath, patchPath };
}

/**
 * Read every `*.json` under `<reportsDir>/suggestions/` and return the
 * decoded `Suggestion`s. Robust to a missing directory (returns `[]`) and
 * to corrupt files (skipped silently).
 *
 * Used by `HtmlReport.renderHtmlReport` and the core HtmlReporter's
 * footer-chip count.
 */
export function readSuggestions(reportsDir: string): Suggestion[] {
  const dir = path.join(reportsDir, SUGGESTIONS_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  const out: Suggestion[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      out.push(JSON.parse(raw) as Suggestion);
    } catch {
      // Skip unreadable / malformed files.
    }
  }
  // Sort newest-first so the HTML index renders the freshest at the top.
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}
