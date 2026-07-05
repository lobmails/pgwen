# Changelog

All notable changes to pgwen are documented in this file. Follows [Keep a Changelog](https://keepachangelog.com) conventions.

## [Unreleased]

## [1.0.0-rc.1] — 2026-07-03 — First public release

### Package identity + license

- Apache-2.0 license. `LICENSE` + `NOTICE` files at repo root; `NOTICE` preserves upstream attribution.
- Package description: *"Standalone Playwright BDD framework — a Gherkin-driven TypeScript engine for test and process automation."*
- `playwright` is a peer dependency (`>=1.40.0`) — consumers install and pin the version.
- `publishConfig` points at public npm.
- `prepublishOnly` runs `yarn build` before every publish so the shipped `dist/` is always current.
- `packageManager` pinned to `yarn@1.22.22`.

### Framework surface

- **BDD DSL** — ~300 step patterns spanning navigation, locator binding, element actions, text / data bindings, assertions, flow control, and data-driven iteration.
- **34 StepDef annotations** — `@StepDef`, `@Context`, `@Finally`, `@Try`, `@Message`, `@Results`, `@Import`, `@Examples`, `@Breakpoint`, `@Number`, `@Delay`, `@Timeout`, `@DryRun`, and more.
- **Locator kinds** — `id`, `name`, `css`, `xpath`, `tag`, `class`, `link text`, `partial link text`, `javascript` (jQuery-style).
- **Data feeds** — CSV, JSON, and Gherkin `Examples` tables. Per-record iteration; per-row result rows.
- **Reports** — HTML (interactive, with drill-down + attachments), JUnit XML (any CI), JSON (machine-readable trace), and CSV (result-per-row).
- **Interactive REPL** — `pgwen --repl`. Ad-hoc step evaluation against a live browser.
- **Debug mode** — `@Breakpoint` steps drop into the REPL with live scope + page.
- **Parallel execution** — configurable worker cap plus a ramp-up interval for rate-limited targets.
- **Dry-run mode** — validates step resolution without touching a browser.
- **Cross-platform paths** — report output normalised across macOS / Linux / Windows.

### AI-assisted features (optional, gated on API key)

- **`pgwen new`** — interactive project scaffolder. Asks up to 12 questions, emits a blueprint you approve, then writes a complete project skeleton with an initial git commit. Providers: Claude (default), OpenAI, Azure OpenAI, GitHub Copilot.
- **`pgwen diagnose`** — post-failure analyser. Reads a scrubbed bundle (locator, DOM excerpt, recent diffs) and proposes a classification + fix. Pattern-level grouping means 500 identical-locator failures cost one AI call, not 500.
- **`@pgwen/fix`** (folded into core at `src/fix/`) — suggest-only mode writes structured fix suggestions to a sidecar directory with a self-contained HTML index. Never modifies source directly. Auto-apply mode gated behind opt-in flags.
- **Runtime `heal`** (opt-in) — mid-run locator repair when a bound selector goes stale.
- **Privacy + safety** — PII scrubbing before every AI call, response caching, budget + rate gates.

### Sidecar packages

- **`@pgwen/migrate`** — one-shot migration helper for consumers moving from a legacy BDD framework. `private: true`, repo-local, not published. Delete-safe: core has zero references to it.

### CI + tests

- **3398 unit tests** (Vitest).
- **19-feature / 125-scenario regression pack** in a sibling repo (`pgwen-regression`), runnable via `yarn test:regression`.
- **CI workflow** — `.github/workflows/regression.yml` runs typecheck + unit tests + build on every PR. Regression pack runs when `PGWEN_REGRESSION_REPO` is configured; skipped gracefully on personal forks without access.

### Docs

- Comprehensive README covering prerequisites, install (npm / yarn / pnpm), the AI-assisted wizard path, the manual "hello world" path, running, report layout, CSV-driven runs, common patterns, and troubleshooting.
- Static HTML docs under `docs/pages/` covering installation, first project, DSL reference, CLI, settings, data-driven runs, debugging, reports, annotations, REPL, tags, diagnose, `pgwen new`, and FAQ.

### Notes

Pre-1.0.0-rc.1 development history (RC candidates, iterative surface additions, internal restructuring) is preserved in git log rather than in this file. This is the first public release; the changelog begins here.
