# Security policy

## Supported versions

pgwen is currently in release-candidate status. Security fixes land in the
active `main` branch; downstream consumers pinning to a specific `1.0.0-rc.*`
release should upgrade to the latest RC (or 1.0.0 once tagged) when a fix
lands.

| Version | Supported |
|---|---|
| `1.0.0-rc.*` | ✅ |
| `< 1.0.0-rc` | ❌ (pre-public builds) |

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Report privately
via GitHub's Security Advisory feature on the pgwen repository:
`Security → Report a vulnerability`.

Expected response times:
- Initial acknowledgement: within 5 working days
- Triage + severity assessment: within 10 working days
- Fix ETA (or "won't fix" with rationale): within 30 working days for
  high/critical severity

## Trust model — what pgwen executes

Understanding pgwen's execution surface is critical before running scenarios
authored by anyone you don't fully trust.

### `.feature` and `.meta` files are executable

Gherkin scenarios and their supporting meta files are code. pgwen executes
them via:

- **Playwright browser automation** — same trust boundary as any Playwright
  test suite. Scenarios can navigate any URL, submit forms, upload files,
  read screen contents.
- **`is defined by javascript` bindings** — script is passed to `new
  Function(...)` and executed in-process. Can read/write files, spawn
  processes, hit the network. `arguments[0]` is bound to the current element
  when used with `applied to`.
- **`system process` / `unix system process` bindings** — spawns a child
  process via `child_process.execSync`. `system process` uses the default
  system shell (portable); `unix system process` forces `/bin/sh` (POSIX
  only).
- **`I execute system process` action steps** — same underlying mechanism as
  the bindings above.
- **`where` predicates on `Examples` / `data feeds`** — expression is passed
  to `new Function(...)` for evaluation against each record. Trusted-code
  surface.
- **`I capture the PDF text from url`** — makes outbound HTTP requests.
  Users can hit any URL the process has network access to.
- **`I capture the PDF text from file`** and other filesystem-read steps —
  read any file the process has permission for.

### Consequence

**Never run pgwen scenarios written or modified by an untrusted party
without reviewing them first.** Treat `.feature` and `.meta` files exactly
as you would treat an executable script: only run what you'd trust to run
as your own OS user. The same rule applies to CSV / JSON data feeds that
appear inside `where` predicates or `is defined by javascript` bindings.

For CI systems: gate scenario execution on the same code-review workflow
you'd use for merging code — a PR that modifies `.feature` / `.meta` /
`.conf` files is a code change, not a data change.

## AI-assisted features — data handling

The `pgwen new` scaffolder, `pgwen diagnose` post-failure analyser, and the
runtime `heal` module make outbound HTTP requests to your chosen AI provider
(Claude / OpenAI / Azure OpenAI / GitHub Copilot). Understand what they
send:

- **`pgwen new`** — the answers you supply to the wizard, plus any files
  passed via `--doc`, `--transcript`, `--reference-project`, `--conventions`,
  or `--doc-url`. Screenshots attached via the wizard's prompt are sent as
  base64-encoded image parts.
- **`pgwen diagnose`** — the failing step's locator, a DOM excerpt around
  the target element, the last N git commits touching the meta file (via
  `git log`), and pgwen's classification output. **PII scrubbing runs
  before every AI call** (`src/diagnose/Scrubber.ts`), covering email,
  phone-number, credit-card-number, and API-key shapes. Extend the scrubber
  patterns via `pgwen.heal.scrubber.extraPatterns` in your config for
  domain-specific IDs.
- **Runtime `heal`** — same bundle shape as `diagnose`, plus a live DOM
  scrubbed copy of the current page.

### API key handling

- pgwen never logs API keys to stdout. `src/diagnose/ApiKey.ts` handles all
  key redaction.
- Keys are read from environment variables (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `GITHUB_TOKEN`). Never inline
  them in `pgwen.conf` or `.feature` files.
- The scaffolded project's initial `.env.example` (if generated) lists
  which env vars the project consumes without exposing values.

### Opt-out

Set `PGWEN_AI_PROVIDER=mock` (or run without an API key set for the chosen
provider) to route AI-facing operations through the built-in MockAdapter,
which produces deterministic fixtures without any outbound network traffic.
Useful for CI, offline development, and privacy-sensitive contexts.

## Third-party dependencies

pgwen's runtime dependencies are audited on each release. Current runtime
surface:

- `@cucumber/gherkin`, `@cucumber/messages` — Gherkin parser
- `@xmldom/xmldom` — XML parsing (DOCX extraction, XML DSL bindings)
- `papaparse` — CSV parsing
- `pdfjs-dist` — PDF text extraction
- `xpath` — XPath evaluation
- `playwright` (peer dependency) — the consumer installs and pins this

Report vulnerability advisories via `npm audit` output for the version you
have installed. pgwen tracks security advisories in `@cucumber/*` and
`pdfjs-dist` and rolls minor-version updates as they land.
