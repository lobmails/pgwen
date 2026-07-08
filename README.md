# pgwen

**Write browser tests and process automation in plain English. Run them against a real browser. Get a clean HTML report.**

pgwen is a Playwright-based BDD framework for TypeScript. You describe what you want in Gherkin (`Given / When / Then`) — pgwen turns each line into a Playwright action. No JavaScript required to write scenarios; a single reusable bindings file per project handles the details.

```gherkin
Feature: TodoMVC

  Scenario: Add a todo and see it in the list
    Given the new-todo input can be located by class "new-todo"
    And   the first todo item can be located by css ".todo-list li:first-child"
    When  I navigate to "https://todomvc.com/examples/jquery/"
    And   I enter "First task" in the new-todo input
    Then  the first todo item should contain "First task"
```

That's the whole test. No code file, no helpers, no separate bindings file. Save it, run `pgwen`, get an HTML report.

Every step above is a real pgwen DSL primitive — see the [Manual start](#manual-start--hello-world-in-5-minutes) section for a full walkthrough.

---

## Table of contents

1. [Who is this for?](#who-is-this-for)
2. [What you need before you start](#what-you-need-before-you-start)
3. [Install pgwen](#install-pgwen)
4. [Fastest start — the wizard](#fastest-start--the-wizard)
5. [Manual start — hello world in 5 minutes](#manual-start--hello-world-in-5-minutes)
6. [Running your project](#running-your-project)
7. [What you get — the report](#what-you-get--the-report)
8. [Adding data — CSV-driven runs](#adding-data--csv-driven-runs)
9. [Common patterns](#common-patterns)
10. [Troubleshooting](#troubleshooting)
11. [Where to go next](#where-to-go-next)

---

## Who is this for?

- **QA analysts** who want to write executable specifications without learning a testing framework's API.
- **Business analysts** who own acceptance criteria and want them to run.
- **Developers** who need a fast, low-ceremony automation layer on top of Playwright.
- Anyone building **process-automation projects** (form fill-ins, table extraction, scheduled workflows) who prefers describing behaviour over writing code.

If you can read Gherkin (`Given / When / Then` sentences), you can use pgwen.

---

## What you need before you start

You need three things installed on your computer. Check each one:

### 1. Node.js (version 18 or newer)

Open a terminal and type:

```
node --version
```

- If you see `v18.x.x` or newer → you're good.
- If you see `command not found` or a lower version → download the LTS installer from **[nodejs.org](https://nodejs.org)** and run it.

### 2. A package manager (yarn or npm)

`npm` comes with Node.js — you already have it. Yarn is optional but slightly faster:

```
# Optional — enable yarn if you don't have it
corepack enable
yarn --version
```

Either works. The examples below use `npx` (comes with npm) and `yarn` interchangeably.

### 3. A terminal / command line

- **macOS:** Terminal.app or iTerm2
- **Windows:** Windows Terminal, PowerShell, or WSL
- **Linux:** whatever you already use

That's it. No compiler, no IDE required (though VS Code is nice for editing `.feature` files with the Cucumber extension).

---

## Install pgwen

Create a new folder for your project and install pgwen inside it. Use whichever package manager you prefer — all three work:

```
mkdir my-automation && cd my-automation

# --- npm ---
npm init -y
npm install --save-dev @pgwen/core playwright

# --- yarn (1.x or berry) ---
yarn init -y
yarn add --dev @pgwen/core playwright

# --- pnpm ---
pnpm init
pnpm add --save-dev @pgwen/core playwright
```

Then install the browser Playwright uses:

```
npx playwright install chromium           # npm
yarn dlx playwright install chromium      # yarn
pnpm dlx playwright install chromium      # pnpm
```

That downloads Chromium (~150 MB). Only needed once per machine.

*Firefox and WebKit users:* replace `chromium` with `firefox` or `webkit` (or install all three: `npx playwright install`).

### Running the pgwen command

All three package managers expose the `pgwen` binary the same way — they drop it into `node_modules/.bin/`. You invoke it via your package manager's "run a local binary" form:

| Package manager | Command |
|---|---|
| npm | `npx pgwen <args>` |
| yarn | `yarn pgwen <args>` |
| pnpm | `pnpm pgwen <args>` (or `pnpm exec pgwen <args>`) |

The examples in this README use `npx` for consistency — substitute `yarn` or `pnpm` freely.

> **Heads-up on the naming.** `pgwen new` (space) is the CLI **subcommand** — this is what you type as a consumer. There's also an older script name `pgwen:new` (with colon) that only appears inside the pgwen framework's own `package.json` — it's a shorthand for framework developers running smoke tests against a locally built `dist/`. If you see `pgwen:new` in a doc anywhere, mentally translate to `npx pgwen new`.

---

## Fastest start — the wizard

pgwen ships an AI-assisted scaffolder that asks a few questions and generates a working project for you. **Requires** an Anthropic API key (`ANTHROPIC_API_KEY`).

```
export ANTHROPIC_API_KEY="sk-ant-..."   # macOS / Linux
# or (Windows PowerShell): $env:ANTHROPIC_API_KEY="sk-ant-..."

npx pgwen new
```

The wizard asks up to 12 questions (project type, name, description, environments, whether you have a CSV feed, etc.), proposes a **blueprint** you review + approve, and writes the project files. Anything it couldn't figure out lands in `TODO.md` for you to fill in later.

Prefer OpenAI or Azure OpenAI? Add `--provider openai` (needs `OPENAI_API_KEY`) or `--provider azure-openai` (needs `AZURE_OPENAI_*` — see [docs](https://pgwen.org/pages/new-project.html)).

**Skipping AI entirely?** Continue to the manual start below.

---

## Manual start — hello world in 5 minutes

Create two files in your project folder.

### `pgwen.conf` — the base config

```hocon
project { name = "hello-pgwen" }

pgwen {
  baseDir = "pgwen"
  outDir  = "${pgwen.baseDir}/output"

  target {
    browser = "chromium"
    env     = "test"
  }

  web {
    browser { headless = false }        # see the browser while you're learning
    capture.screenshots.enabled = true
  }
}
```

### `pgwen/features/hello.feature` — your scenario

```gherkin
Feature: My first pgwen project

  Scenario: See the example.com heading
    Given the page heading can be located by tag "h1"
    And   the primary link can be located by tag "a"
    When  I navigate to "https://example.com"
    Then  the page heading should contain "Example Domain"
    And   the primary link should contain "Learn more"
```

That's the whole test. No JavaScript, no separate binding file. Each step is a real pgwen DSL primitive:

- **`<name> can be located by <kind> "<value>"`** registers a locator binding you can reference by `<name>` in later steps. Supported `<kind>`s: `id`, `name`, `css`, `xpath`, `tag`, `class`, `link text`, `partial link text`.
- **`I navigate to "<url>"`** opens the URL in the target browser.
- **`<name> should contain "<text>"`** asserts the located element's text contains the given string. Companion forms: `should be`, `should not be`, `should not contain`, `should match regex`, `should start with`, `should end with`.

Save the two files and skip to *Running your project*.

> **Bigger projects:** as your suite grows, move reusable locator bindings and multi-step flows into a companion `pgwen/features/hello.meta` file — pgwen auto-loads a `*.meta` sitting next to a `*.feature` of the same name. See [Configuration profiles](https://pgwen.org/pages/profiles.html) for the full pattern.

---

## Running your project

From your project folder, point pgwen at the feature file:

```
npx pgwen pgwen/features/hello.feature
```

pgwen opens a browser (because `headless = false`), loads example.com, checks the heading + link, writes a report, and closes.

For projects with multiple features, group them under a profile (see [Configuration profiles](https://pgwen.org/pages/profiles.html)) and run `npx pgwen -p <profile>`. Multiple profiles can be launched sequentially in one command with `npx pgwen -p A,B,C` — each profile runs to completion, then the next, with a cross-profile summary at the end.

You'll see console output like:

```
Feature: My first pgwen project

  Scenario: See the example.com heading

    Given the page heading can be located by tag "h1"          [0ms] ✓
      And the primary link can be located by tag "a"           [0ms] ✓
     When I navigate to "https://example.com"              [1s 245ms] ✓
     Then the page heading should contain "Example Domain"    [43ms] ✓
      And the primary link should contain "Learn more"        [51ms] ✓

             Passed  Failed  Sustained  Skipped  Pending
  1 Scenario   1       -         -         -        -
  5 Steps      5       -         -         -        -

[1s 401ms] Passed ✓
```

If a step fails, pgwen captures a screenshot and marks the failure with a category (e.g. `locator_drift`, `timeout`, `assertion`) that shows up in the report.

---

## What you get — the report

After every run, pgwen writes to `pgwen/output/`:

| File | Purpose |
|---|---|
| `reports/html/index.html` | Human-readable report — open in a browser |
| `reports/junit/*.xml` | JUnit XML for CI systems (Jenkins, GitHub Actions, etc.) |
| `reports/json/results.json` | Full machine-readable trace |
| `results-ALL.csv` / `results-PASSED.csv` / `results-FAILED.csv` | One row per scenario × data-feed record |

Open `pgwen/output/reports/html/index.html` in a browser to see the report. Each scenario is expandable; failed steps carry a diagnosis badge; screenshots + DOM excerpts are attached inline.

---

## Adding data — CSV-driven runs

To run the same scenario against many inputs, add a CSV feed:

**`pgwen/input/greetings.csv`**:
```csv
NAME,GREETING
World,Hello
Everyone,Hi
```

**Update your feature**:
```gherkin
Feature: Greetings

  Scenario: Greet <NAME>
    Given I navigate to "https://example.com?greeting=${GREETING}%20${NAME}"
     Then the page heading should contain "Example"
```

**Point pgwen at the feed**:
```
npx pgwen -i pgwen/input/greetings.csv
```

pgwen runs the scenario once per row, expanding `${NAME}` / `${GREETING}` from each CSV column. Every row becomes an entry in `results-ALL.csv`.

Supports JSON feeds too — see [Data-driven runs](https://pgwen.org/pages/data-driven.html).

---

## Common patterns

### Filling a form and clicking

```gherkin
Given I navigate to "https://example.com/signup"
 When I enter "user@example.com" in the email input
  And I enter "password" in the password input
  And I click the "Sign up" button
 Then the "welcome-banner" element should be displayed
```

The `email input`, `password input`, `"Sign up" button`, and `welcome-banner element` all need corresponding `@StepDef` locator bindings in your `.meta` file.

### Extracting a value

```gherkin
When I capture the account balance by css ".balance"
Then account balance should not be "$0.00"
```

### Waiting for something

```gherkin
When I wait until the loading spinner is not displayed
Then the results table should be displayed
```

pgwen wraps Playwright's smart waiting — you don't need explicit sleeps.

### Calling an API

```gherkin
Given I fetch https://api.example.com/status
 Then the response status should be "200"
  And the response body should contain "operational"
```

See [DSL reference](https://pgwen.org/pages/dsl.html) for the full step vocabulary.

---

## Troubleshooting

**`pgwen: command not found`**
You installed pgwen but the terminal can't find the binary. Run it with `npx pgwen ...` instead of `pgwen ...`, or add a script to `package.json`:
```json
{ "scripts": { "pgwen": "pgwen" } }
```
Then `yarn pgwen` or `npm run pgwen`.

**`Cannot find package 'playwright'`**
Install it separately: `npm install --save-dev playwright && npx playwright install chromium`.

**Browser never opens** on a first run
Playwright needs its browser binaries. Run `npx playwright install --with-deps chromium`.

**"UndefinedStepError" — step "..." was not defined**
Your `.feature` file uses a phrase pgwen doesn't know. Either it's a typo, or you need to add a matching `@StepDef` in the corresponding `.meta` file.

**Scenario is very slow**
Set `pgwen.web.browser.headless = true` in `pgwen.conf` — headless mode is faster once you're done authoring.

**Locator flake — "clicked wrong element"**
Prefer text-based locators (`link text`, `partial link text`) or CSS with specific attributes (`css [data-testid="foo"]`) over `xpath` or ordinal positions.

**Need to debug a step?**
Add `--repl` — pgwen drops into an interactive REPL against the live browser after your scenario finishes. Type Gherkin steps live and watch them run.

---

## Migrating from another BDD framework

If your project already has feature/meta/config files written for a legacy BDD framework, pgwen ships a companion CLI that rewrites in place:

```
npx @pgwen/migrate ./path/to/your-project
```

It rewrites (in this order):

- filesystem: `<legacy>.conf` → `pgwen.conf`, `<legacy>/` → `pgwen/`
- HOCON: top-level block, dotted keys, `${…}` substitutions, `baseDir`
- feature / meta: `${…}` substitutions, `env.*` references
- `package.json`: script keys + values, CLI names, paths, env vars
- `.env` and JSON env config files
- CI pipeline files: `Jenkinsfile`, `azure-pipelines.yml`

Add `--dry-run` (or `-n`) to preview changes without applying them. The migrator is idempotent — re-running on an already-migrated tree is a no-op.

`@pgwen/migrate` lives inside this repo as a private sidecar package. Build it locally:

```
git clone <pgwen-repo>
cd pgwen/pgwen-migrate
yarn build
node dist/cli.js --help
```

---

## Environment variables

A full `.env.example` ships at the repo root. The variables pgwen consumes:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for `pgwen new`, `pgwen diagnose`, runtime `heal` |
| `OPENAI_API_KEY` | OpenAI provider (via `--provider openai`) |
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_DEPLOYMENT` + `AZURE_OPENAI_API_VERSION` + `AZURE_OPENAI_RESOURCE` *or* `AZURE_OPENAI_BASE_URL` | Azure OpenAI provider |
| `GITHUB_TOKEN` | GitHub Copilot provider (adapter exchanges for a Copilot bearer) |
| `PGWEN_AI_PROVIDER` | Pin provider without `--provider` on every invocation |
| `PGWEN_AI_MOCK_FIXTURES` | Point the MockAdapter at a fixture directory for offline / CI runs |
| `PGWEN_ENV` | Environment name → `pgwen/conf/env/<name>.json` |
| `PGWEN_BROWSER` | Browser override (equivalent to `--browser`) |
| `PGWEN_PARALLEL` | Max concurrent workers |
| `PGWEN_VIDEO` | Video capture toggle |
| `PGWEN_REMOTE_URL` | Remote Playwright endpoint (CDP grid) |

Any variable you don't set is either absent (feature disabled) or inherits pgwen's built-in default. `.env` is loaded automatically if present; commit `.env.example` for documentation and gitignore `.env` for secrets.

---

## Where to go next

- **[Installation](https://pgwen.org/pages/installation.html)** — deeper install notes, Playwright browser setup, CI images
- **[Your first project](https://pgwen.org/pages/first-project.html)** — a longer walkthrough (TodoMVC)
- **[DSL reference](https://pgwen.org/pages/dsl.html)** — the full step vocabulary (~125 patterns)
- **[Configuration](https://pgwen.org/pages/settings.html)** — every `pgwen.*` setting, profiles, browser overlays
- **[CLI reference](https://pgwen.org/pages/cli.html)** — all flags and subcommands
- **[Data-driven runs](https://pgwen.org/pages/data-driven.html)** — CSV, JSON, `Examples` tables
- **[Debugging](https://pgwen.org/pages/debugging.html)** — REPL, breakpoints, dry-run
- **[Reports](https://pgwen.org/pages/reports.html)** — HTML report layout + AI diagnosis
- **[FAQ](https://pgwen.org/pages/faq.html)** — common questions

---

## CLI cheat sheet

```
npx pgwen                              Run everything under pgwen/features/
npx pgwen -p test                      Run with profile pgwen/conf/profiles/test.conf
npx pgwen -p Nav,Search                Run Nav then Search sequentially (multi-profile)
npx pgwen -i data.csv                  Feed CSV / JSON / Examples data
npx pgwen --tags "@smoke"              Only run scenarios tagged @smoke
npx pgwen --scenario "exact name"      Only run one scenario
npx pgwen --dry-run                    Validate step resolution without running
npx pgwen --repl                       Interactive Gherkin REPL
npx pgwen --headed                     Show the browser (default respects config)
npx pgwen --browser firefox            Firefox / webkit / chromium
npx pgwen new                          AI-assisted new-project wizard
npx pgwen new --doc <path>             Feed requirements docs into the wizard (repeatable)
npx pgwen new --transcript <path>      Feed meeting transcripts / notes (repeatable)
npx pgwen new --reference-project <p>  Mimic the shape of an existing pgwen project
npx pgwen new --doc-url <url>          Fetch a web page as a reference doc
npx pgwen new --conventions <path>     Organisation conventions (file or directory)
npx pgwen init                         Scaffold a starter project (no AI)
npx pgwen diagnose                     Rerun a failed scenario with Claude analysis
npx pgwen --help                       Full flag reference
```

---

## Contributing

Bug reports and pull requests welcome. See `CHANGELOG.md` for release history. All contributions are Apache-2.0 licensed.

## License

Apache-2.0. See `LICENSE` and `NOTICE` for upstream attribution.
