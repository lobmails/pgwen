/**
 * playwright/accessibility.ts — Accessibility snapshot DSL steps.
 *
 * Playwright-exclusive DSL (no WebDriver-style/equivalent).
 *
 * Registers these step patterns:
 *   I capture the accessibility snapshot
 *   I capture the accessibility snapshot as <name>
 *   the accessibility snapshot should contain "<text>"
 *   the accessibility snapshot should not contain "<text>"
 *
 * Snapshots are captured via page.accessibility.snapshot() and stored as
 * JSON strings in scope. The snapshot includes the full ARIA tree:
 * roles, names, states, and hierarchical structure.
 *
 * Usage in .meta files:
 *   Given I capture the accessibility snapshot as dashboard tree
 *   Then the accessibility snapshot should contain "main"
 *   Then the accessibility snapshot should not contain "alert"
 */

import type { DslRegistry } from '../registry';

interface PageLike {
  accessibility?: {
    snapshot: (options?: { interestingOnly?: boolean }) => Promise<AccessibilityNode | null>;
  };
}

interface AccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  level?: number;
  expanded?: boolean;
  disabled?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  children?: AccessibilityNode[];
  [key: string]: unknown;
}

// ─── Scope key ────────────────────────────────────────────────────────────────

const SNAPSHOT_KEY = 'pgwen.accessibility.snapshot';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerAccessibility(registry: DslRegistry): void {

  // I capture the accessibility snapshot
  registry.register(
    /^I capture the accessibility snapshot$/i,
    async (_groups, scope, page) => {
      const json = await captureSnapshot(page);
      scope.setTransparent(SNAPSHOT_KEY, json);
    }
  );

  // I capture the accessibility snapshot as <name>
  registry.register(
    /^I capture the accessibility snapshot as (.+)$/i,
    async ([nameRaw], scope, page) => {
      const name = nameRaw!.trim();
      const json = await captureSnapshot(page);
      scope.setTransparent(SNAPSHOT_KEY, json);
      scope.setTransparent(name, json);
    }
  );

  // the accessibility snapshot should contain "<text>"
  registry.register(
    /^the accessibility snapshot should contain "(.+)"$/i,
    async ([text], scope) => {
      const snapshot = scope.get(SNAPSHOT_KEY) ?? '';
      if (!snapshot.includes(text!)) {
        throw new Error(
          `Accessibility snapshot does not contain "${text}".\nSnapshot: ${snapshot.slice(0, 500)}`
        );
      }
    }
  );

  // the accessibility snapshot should not contain "<text>"
  registry.register(
    /^the accessibility snapshot should not contain "(.+)"$/i,
    async ([text], scope) => {
      const snapshot = scope.get(SNAPSHOT_KEY) ?? '';
      if (snapshot.includes(text!)) {
        throw new Error(
          `Accessibility snapshot should not contain "${text}" but it does.\nSnapshot: ${snapshot.slice(0, 500)}`
        );
      }
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function captureSnapshot(page: unknown): Promise<string> {
  const p = page as PageLike;
  if (!p.accessibility?.snapshot) {
    throw new Error(
      'Accessibility snapshot API is not available. ' +
      'Ensure you are running with a Playwright Page (not in dry-run mode).'
    );
  }
  const snapshot = await p.accessibility.snapshot({ interestingOnly: false });
  return JSON.stringify(snapshot, null, 2);
}
