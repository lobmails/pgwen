/**
 * engine/TemplateMatcher.ts — pgwen-style template matching.
 *
 * Matches actual text against a template that may contain placeholder tokens.
 * Supports @{name} / @{*} syntax and pgwen's <name> syntax.
 * Each named placeholder captures any text and the captured values are
 * returned as named bindings so callers can push them into scope.
 * @{*} is a wildcard that matches any text without creating a binding.
 *
 * Example:
 *   template: "Dear @{name}, your order @{orderId} is ready"
 *   actual:   "Dear John, your order ORD-123 is ready"
 *   → bindings: { name: 'John', orderId: 'ORD-123' }
 */

import { readFileSync } from 'fs';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MatchResult {
  matched: boolean;
  /** Captured placeholder bindings: { name: 'John', orderId: 'ORD-123' } */
  bindings: Record<string, string>;
  /** Human-readable diff when match fails (shows expected vs actual) */
  diffMessage?: string;
}

// ─── TemplateMatcher ──────────────────────────────────────────────────────────

export class TemplateMatcher {
  /**
   * Match `actual` text against a template string.
   * `<placeholderName>` in the template matches any text and captures it.
   * Returns matched=true and all bindings if the template fits the actual text.
   */
  static match(template: string, actual: string): MatchResult {
    const placeholders: Array<string | null> = [];

    // Supports both @{name} / @{*} syntax and pgwen's <name> syntax.
    // @{*}  → wildcard: matches anything, does NOT bind a name (null placeholder)
    // @{name} / <name> → captures any text and binds to 'name'
    // Matching is multiline (dotAll) so templates can span newlines.
    const tokenPattern = /@\{([^}]+)\}|<([^>]+)>/g;
    const parts: string[] = [];
    let lastIndex = 0;
    let tokenMatch: RegExpExecArray | null;

    while ((tokenMatch = tokenPattern.exec(template)) !== null) {
      // Literal text before this placeholder
      parts.push(escapeRegex(template.slice(lastIndex, tokenMatch.index)));
      // Group 1 = @{...}, group 2 = <...>
      const name = tokenMatch[1] ?? tokenMatch[2]!;
      if (name === '*') {
        placeholders.push(null);   // wildcard — match but don't bind
      } else {
        placeholders.push(name);
      }
      parts.push('(.*?)');
      lastIndex = tokenMatch.index + tokenMatch[0].length;
    }
    // Remaining literal text after the last placeholder
    parts.push(escapeRegex(template.slice(lastIndex)));

    const regexStr = parts.join('');
    // Use 's' (dotAll) flag so '.' spans newlines in multiline templates
    const regex = new RegExp(`^${regexStr}$`, 's');
    const m = regex.exec(actual);

    if (!m) {
      return {
        matched: false,
        bindings: {},
        diffMessage: [
          'Template match failed.',
          `  Template : ${template}`,
          `  Actual   : ${actual}`,
        ].join('\n'),
      };
    }

    const bindings: Record<string, string> = {};
    for (let i = 0; i < placeholders.length; i++) {
      const name = placeholders[i] ?? null;
      if (name !== null) {
        bindings[name] = m[i + 1] ?? '';
      }
    }

    return { matched: true, bindings };
  }

  /**
   * Match `actual` text against a template loaded from a file path (UTF-8).
   */
  static matchFile(templatePath: string, actual: string): MatchResult {
    const template = readFileSync(templatePath, 'utf-8');
    return TemplateMatcher.match(template, actual);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Escape a string so it can be used as a literal in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
