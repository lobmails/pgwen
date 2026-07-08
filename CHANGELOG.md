# Changelog

All notable changes to pgwen are documented in this file. Follows [Keep a Changelog](https://keepachangelog.com) conventions.

## [Unreleased]

## [1.0.0] — 2026-07-08 — GA release: @Sustained rendering + multi-profile launch + docs cleanup

First stable release. Combines the rc.1 → rc.2 → rc.3 iterations into one GA
milestone. Everything below describes what shipped in this release.

### Added

- **Multi-profile launch (`-p A,B,C`)** — pass a comma-separated list (or repeat `-p`) to run multiple profiles sequentially in one CLI invocation.
  - Each profile runs to completion, then the next.
  - **Fail-fast:** if a profile fails, remaining profiles are marked `Skipped` in the summary (dry-run is the exception — every profile is still resolved so authors see all issues in one go).
  - **Isolated output** — when more than one profile is given, each profile's reports are written under `pgwen/output/<profile>/reports/`. Single-profile runs keep the flat `pgwen/output/reports/` layout unchanged (backward compatible).
  - **Cross-profile summary** — a `Profile results:` block prints at end of run with one line per profile (status + duration, colour-coded).
  - **Single post-execution REPL** — opens once at the end of the whole run (on the last profile, or after any failure), not once per profile.
  - CLI: `parseArgs` now exposes `profiles: string[]` instead of `profile?: string`. The `--help` text and `docs/pages/cli.html` reflect the new form.



### Fixed

- **`@Sustained` now surfaces its assertion message on the step itself.** Previously a sustained-failure step rendered as a plain green pass and the assertion message vanished (it was only reachable via `${pgwen.feature.isSustainedError}`). The step now carries `sustained: true` and preserves its error through `StepResult` and `StepTrace`, so both reporters can render the message inline while the scenario status stays passed.

### Changed

- **Console output** — sustained steps show a bold yellow `Sustained` marker in place of the green `✓`, followed by the assertion message on the next line in red. Sustained-step count is now populated in the totals table (yellow under the `Sustained` column) instead of being hard-coded to `-`. Sustained errors are no longer duplicated in the trailing `- <error>` list.
- **HTML report** — sustained steps render as a green passed step with a yellow `label-warning` `Sustained` badge next to the duration and a red `panel-danger` block containing the assertion message. `buildProgressBar` splits the green passed segment from the new yellow sustained segment. Sustained StepDef panels auto-expand so the failure detail is immediately visible.
- `StatusCounts.sustained` is optional so older callers building the struct manually keep rendering unchanged.

### Docs

- Rewrote the **@Hard / @Soft / @Sustained** section of `docs/pages/annotations.html` to document the visual behaviour and the `pgwen.feature.isSustainedError` / `pgwen.accumulated.errors` escape hatches. Added a usage example.
- FAQ answer for "Are soft assertions supported?" now links to the annotations section.
- Cleaned up three mechanical-rename artefacts in `annotations.html`, `dsl.html`, and `faq.html` (leftovers from the `c9a2e05` scrub). Fixed a broken GitHub URL in `faq.html`.
- Search index entry for `@Sustained` broadened to include the new rendering terms.
- **README rewrite for correctness.** The published README was shipping broken examples:
  - `I browse to "…"` — replaced with `I navigate to "…"` (5 occurrences); the DSL only registers `I navigate to`, so every prior sample would fail with "Undefined step".
  - `@StepDef` scenarios were using the locator-binding text as the *scenario name* rather than as steps *inside* the scenario body — replaced with the correct form (locators as `Given` steps within a `@Context` StepDef). The prior form registered no locators, so every subsequent step against the "bound" element failed with "Unbound reference".
  - Nine relative doc links (`docs/pages/*.html`) rewritten to absolute `https://pgwen.org/pages/*.html` — the relative form is broken when the README is rendered on npmjs.com or GitHub (outside the docs site root).
  - `Learn more` swapped in for the outdated `More information` link text on example.com.
  - `npx pgwen` alone was shown as the run command but requires either a feature path or a profile; the command now includes `pgwen/features/hello.feature` and points at Configuration profiles for multi-feature setups.
  - Expected-output block updated to match pgwen 1.0.0-rc.3's actual console format (`[time] ✓` markers, stats table, `[time] Passed ✓` footer).
- **`docs/pages/first-project.html`** received the same corrections: meta format, DSL step vocabulary (removed `I press the Enter key` — `I enter "…" in …` already presses Enter — and `should have class "completed"` — replaced with `should be checked`), TodoMVC URL switched from the 404 React example to the still-alive jQuery example (`todomvc.com/examples/jquery/`), and expected-output block regenerated.
- **Dark theme for the docs site.** A sun/moon button in the header toggles between light and dark; the choice persists across pages via `localStorage` (key `pgwen-theme`). First-time visitors get the theme their OS asks for via `prefers-color-scheme`. Implemented purely in the existing `docs/assets/css/styles.css` (CSS-variable overrides for `[data-theme="dark"]` + a `prefers-color-scheme: dark` block) and `docs/assets/js/layout.js` (button injection + storage). No HTML pages were touched, so every existing doc page picks up the toggle automatically.

### Tests

- +6 unit tests in `tests/unit/reporting/ConsoleReporter.test.ts` covering yellow label, red assertion line, footer stays `Passed ✓`, totals row count, no duplicate error list, ANSI colour wrapping the `Sustained` column value.
- +6 unit tests in `tests/unit/reporting/HtmlReporter.test.ts` covering the yellow badge, `list-group-item-success` retention, red `panel-danger` block, `buildProgressBar` split, summary `label-success`, `toFeatureTrace` propagation.
- +1 unit test in `tests/unit/engine/CompositorAnnotations.test.ts` pinning the wiring: `StepResult.sustained === true` and `StepResult.error` is preserved.
- New regression suite `tests/integration/sustained.integration.test.ts` (7 tests) — runs the full Runner → Reporters stack against `tests/integration/fixtures/features/Sustained.feature`, verifying runner behaviour, console output, and HTML output end-to-end.

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
