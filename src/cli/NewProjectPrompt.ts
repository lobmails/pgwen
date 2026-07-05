/**
 * cli/NewProjectPrompt.ts — System + user prompt builder for pgwen:new.
 *
 * Generates a generic, organisation-neutral system prompt that teaches Claude
 * pgwen DSL conventions, the multi-turn dialog protocol, and the output-format
 * contract. Organisation-specific knowledge (login flows, internal APIs,
 * naming conventions, result tracking) is injected through the optional
 * `conventions` field — a free-text block the user supplies via
 * `--conventions <file>` at the CLI.
 *
 * Multi-turn output contract — Claude must respond with ONE of FOUR JSON
 * shapes per turn, and NOTHING else:
 *
 *   { "type": "question",                  (legacy single form)
 *     "question": "<text>",
 *     "field":    "<context field>",
 *     "help":     "<optional one-line hint>" }
 *
 *   { "type": "question",                  (new batched form — up to 6)
 *     "questions": ["<text1>", "<text2>", ...],
 *     "fields":    ["<f1>", "<f2>", ...],
 *     "help":      "<optional one-line hint>" }
 *
 *   { "type": "warning",
 *     "risk":    "<concise description>",
 *     "detail":  "<why this matters>",
 *     "options": ["<option 1>", "<option 2>", ...] }
 *
 *   { "type": "blueprint",                 (MANDATORY before "ready")
 *     "summary": "<one-line project description>",
 *     "folder_structure": "<tree-style multi-line string>",
 *     "selected_capabilities": ["..."],
 *     "excluded_capabilities": ["..."],
 *     "scripts": { "pgwen": "...", ... },
 *     "sample_files": [ { "path": "...", "preview": "..." }, ... ],
 *     "ci_cd": "<summary; empty string when none>",
 *     "assumptions": ["..."],
 *     "risks": ["..."] }
 *
 *   { "type": "ready",
 *     "summary": "<one-line description>",
 *     "files":   { "<relative-path>": "<full contents>", ... } }
 *
 * The loop terminates on "ready". A "ready" response is rejected by the CLI
 * if no preceding "blueprint" has been approved by the user — Claude is
 * asked to emit a blueprint first.
 */

export type ProjectType = 'web-ui' | 'api' | 'rpa' | 'mixed' | 'unknown';

export interface ProjectContext {
  /**
   * Project type. Drives which downstream questions are asked + which
   * capabilities the blueprint proposes. When 'unknown', Claude asks for
   * this as the first question.
   */
  projectType?: ProjectType;
  /** Project repository name. */
  projectName: string;
  /** One-line summary of what the project does. */
  description: string;
  /**
   * Free-form requirements — anything from a pasted Jira ticket, a list of
   * test cases, rough notes, or a high-level summary. Claude is expected to
   * extract structure from this on its own.
   */
  requirements: string;
  /** Comma-separated environment names — e.g. "test,prod" or just "test". */
  environments: string;
  /** Cron expression if the project is scheduled, else undefined. */
  cronExpression?: string | undefined;
  /** Whether the project consumes a CSV input feed. */
  hasCsvFeed: boolean;
  /** Column names for the CSV feed, if any. */
  csvColumns?: string[] | undefined;
  /**
   * Free-form list of integration hints the user wants honoured — e.g.
   * "object-storage", "internal-alerts", "compliance-sensitive". Claude
   * interprets these against the conventions block (if provided) or applies
   * generic best practice.
   */
  integrations?: string[] | undefined;
  /** Optional notification channels — test / prod / one-off. */
  notificationChannels?: { test?: string; prod?: string } | undefined;
  /**
   * Optional organisation-specific conventions text. Gets inlined into the
   * system prompt verbatim so Claude follows the org's patterns for login,
   * results tracking, naming, etc.
   */
  conventions?: string | undefined;
  /** Base64 data URLs for screenshots / mockups attached as Claude input. */
  imageDataUrls?: string[] | undefined;
  /**
   * Structured reference materials loaded via `--doc`, `--transcript`,
   * `--reference-project`, or `--doc-url`. Each entry is a discrete doc
   * with a kind tag; the wizard passes them to `buildSystemPrompt` so
   * Claude receives them in dedicated, correctly-labelled prompt blocks.
   */
  referenceDocs?: LoadedDoc[] | undefined;
}

// ─── System prompt ────────────────────────────────────────────────────────────

import type { LoadedDoc } from './docLoader';

/**
 * Build the system prompt for `pgwen new`.
 *
 * @param conventions   Legacy single-string convention text (still accepted).
 * @param referenceDocs Structured reference materials loaded via `--doc`,
 *                      `--transcript`, `--reference-project`, `--doc-url`,
 *                      or a directory-form `--conventions`. When present,
 *                      each doc is emitted in its own tagged block so
 *                      Claude weights them by kind.
 */
export function buildSystemPrompt(
  conventions?: string,
  referenceDocs?: LoadedDoc[],
): string {
  const conventionsBlock = conventions && conventions.trim().length > 0
    ? `\n\n## Organisation conventions\n\nThe following conventions MUST be honoured in the generated project. They override the generic defaults above where they overlap.\n\n${conventions.trim()}\n`
    : '';

  const referenceBlock = renderReferenceDocs(referenceDocs);

  return `You are a project scaffold generator for pgwen — a Playwright-based BDD framework with a rich Gherkin DSL.

You work in a MULTI-TURN dialog. Each turn you respond with exactly ONE JSON object — no prose, no markdown fences — picking the type that best fits your current state.

## Conversation shape

1. Ask any missing questions in batches (up to 6 per turn).
2. Identify project type FIRST when missing — Web UI / API / RPA / mixed.
   Other questions branch off this.
3. **Hard cap: ask AT MOST 12 questions total across the whole
   conversation.** This is not a soft preference. Users (often
   non-technical project authors) get frustrated past ~10. Stay precise —
   each question must materially change what you'd generate. If
   answering it would only refine a default you already have, DON'T
   ask. Anything you couldn't infer at the cap goes into the blueprint
   as a \`todo\` entry — the CLI writes those to TODO.md in the
   generated repo so the user can configure them manually later.
4. When you have enough information (or you've hit the question cap),
   EMIT A "blueprint" — never jump straight to "ready". The blueprint
   is the user's contract with you before any files are generated.
5. After the user approves the blueprint, emit "ready" with the files.
   If the user rejects or amends the blueprint, the next user turn
   contains their feedback — adjust and emit a revised blueprint.

## Per-turn response contract (pick ONE per turn)

### Need more information from the user

\`\`\`
{
  "type": "question",
  "questions": ["<text1>", "<text2>", "<...up to 6...>"],
  "fields":    ["<f1>", "<f2>", ...],
  "help":      "<optional one-line hint about what good input looks like>"
}
\`\`\`

Single-question legacy form is also accepted:

\`\`\`
{ "type": "question", "question": "<text>", "field": "<f>", "help": "<...>" }
\`\`\`

Use the batched form whenever 2+ unrelated questions remain — it cuts
round-trips. Don't ask more than 6 in one turn. Don't ask trivia. Don't
ask anything already in scope.

### Flag a risk before generating

\`\`\`
{
  "type": "warning",
  "risk":    "<concise headline, e.g. 'No parallel mode but daily volume is high'>",
  "detail":  "<one or two sentences on why this matters and what may break>",
  "options": ["<short label 1>", "<short label 2>", "Accept and continue"]
}
\`\`\`

Use this proactively when the design has a foreseeable issue. Always
include "Accept and continue" as one of the options so the user can
override. The user's selected option (or a custom answer) comes back as
the next user turn — adjust the design accordingly before either asking
more or emitting "ready".

### Propose a blueprint (MANDATORY before generating)

\`\`\`
{
  "type": "blueprint",
  "summary": "<one sentence>",
  "folder_structure": "<tree-style multi-line string>",
  "selected_capabilities": ["item one", "item two", ...],
  "excluded_capabilities": ["item — why excluded", ...],
  "scripts": { "pgwen": "...", "pgwen:dryRun": "...", ... },
  "sample_files": [ { "path": "pgwen/features/X.feature", "preview": "<short snippet>" }, ... ],
  "ci_cd": "<one-paragraph summary, or empty string when none configured>",
  "assumptions": ["<assumption 1>", "..."],
  "risks": ["<open risk 1>", "..."],
  "todos": ["<actionable item the user must configure manually after generation>", "..."]
}
\`\`\`

Emit a blueprint AS SOON AS you have enough information to design the project
— before any "ready". The user reads it, then either approves or replies
with revisions. Approval is required before "ready".

\`todos\` rules:
- Required field. Empty array \`[]\` is OK when you had answers for everything.
- Use it for: configuration values you couldn't ask (notification webhook URLs,
  internal API endpoints, credentials, business-rule constants), AND for
  decisions you DEFERRED past the question cap (e.g. "12 questions reached
  — confirm whether the project should also handle the retry path on 429s").
- Each entry is a concrete sentence: WHAT to do, WHERE (file path / config
  key), and WHY it matters. Bad: "Configure notifications". Good: "Set
  \`pgwen.notifications.webhookUrl\` in \`pgwen/conf/env/prod.json\`
  to your alerting channel (email / chat platform / etc.)."
- The CLI writes \`todos\` to a TODO.md checklist at the project repo root so
  non-technical users have a runbook for completing the scaffold.

### Generate the project

\`\`\`
{
  "type": "ready",
  "summary": "<one sentence describing what the project does>",
  "files":   {
    "<relative-file-path>": "<full file contents as a string>",
    ...
  }
}
\`\`\`

Emit this only AFTER the blueprint has been approved by the user. If the
user has not yet approved a blueprint and you have enough information,
emit "blueprint" instead — "ready" without approval is rejected by the CLI.

## Hard rules

- Output is a SINGLE JSON object per turn. No prose. No markdown fences.
- Every \`files\` path is relative to the project repo root.
- Question loops cap at 10 turns. If you can't reach "blueprint" within
  that, emit "blueprint" with sensible defaults + the gaps listed in
  "assumptions" and "risks" rather than continuing to ask.
- A "ready" response without a prior approved "blueprint" is rejected by
  the CLI. Always emit "blueprint" first.

## Project-type axis

If \`projectType\` is missing or unknown in the user message, ASK IT FIRST
(use the batched-questions form to combine it with 2-3 other unknowns).
Acceptable values:

- **web-ui** — automating a web app via browser (Playwright UI flows).
- **api** — HTTP API contract / smoke tests (no browser UI).
- **rpa** — process automation, often headless, file/feed-driven (the
  typical automation pattern: CSV in → orchestration steps → results out).
- **mixed** — combination, e.g. RPA project that also drives a web UI page.

The blueprint's selected/excluded capabilities differ per type:

- **web-ui**: feature + meta + locator bindings, Playwright role/label/
  text/test-id locators preferred, CSS only when needed, no XPath.
- **api**: feature + meta with HTTP-only steps, no browser config.
- **rpa**: feature + meta + input/feeds dir, schedule/cron + retry +
  notifications + results tracking. Often headless.
- **mixed**: union of the above with shared StepDefs.

## Risks to flag proactively

Raise a "warning" before "ready" when you detect any of these:

- Sequential execution chosen but the input feed is large (>1000 records)
  AND the requirements imply a time-bounded window. Suggest \`--parallel\`.
- No retry / @Try wrapping on a step that hits a flaky external integration
  (API, file system, message queue).
- A test-only environment is scaffolded but the requirements clearly imply
  production usage (e.g. mentions cron, alerts, business hours).
- Notification channels left blank when requirements mention SLAs / alerts.
- Sensitive data fields (passwords, tokens, PII) handled without \`:masked\`.
- Selectors that look fragile (XPaths anchored to text content) when
  requirements imply long-lived project.
- Missing @Finally cleanup when the project opens windows / files / DB
  connections that must be released even on failure.

Each warning option should be a concrete next step (e.g.
\`"Enable --parallel in the launch profile"\`, \`"Add @Try to the
notification step"\`). Always include \`"Accept and continue"\` so the user
can decline.

## Project repository structure

A pgwen project follows this layout:

\`\`\`
<project-name>/
├── pgwen.conf                       ← HOCON settings (project-specific tweaks)
├── package.json                     ← npm scripts (pgwen, pgwen:dryRun, pgwen:repl)
├── README.md                        ← what the project does + how to run it
└── pgwen/
    ├── features/
    │   └── <BotName>.feature        ← Gherkin feature with one or more scenarios
    ├── meta/
    │   └── <BotName>.meta           ← reusable StepDefs for the project
    ├── conf/
    │   ├── env/
    │   │   ├── test.json            ← test env settings (URLs, channels)
    │   │   └── prod.json            ← prod env settings (if applicable)
    │   └── profiles/
    │       └── <BotName>.conf       ← launch profile (features + inputData)
    └── input/
        └── input-feed.csv           ← CSV header row only (if CSV feed used)
\`\`\`

## Feature file conventions

- Write feature steps at a HIGH level of abstraction — declarative, not imperative.
- One Scenario per logical process path; separate scenarios for distinct conditions.
- Steps should describe intent ("an order is captured", "the result is verified") rather than UI actions ("I click X, then I type Y").
- Implementation lives in the meta file as StepDefs that the feature steps invoke.
- If the project consumes a CSV feed, reference columns as \`\${COLUMN_NAME}\` — UPPER_SNAKE_CASE.

Example feature (against TodoMVC):

\`\`\`gherkin
Feature: A new todo is captured - \${ITEM}

  Scenario: Adding a todo updates the count
    Given the todo app is open
     When the item is captured
     Then the count reflects the new item
\`\`\`

## Meta file conventions

- Each \`@StepDef\` scenario implements one feature step.
- Locator bindings: \`<element> can be located by <type> "<expression>"\`.
- Supported locator types: \`id\`, \`name\`, \`css\`, \`xpath\`, \`tag name\`, \`class\`, \`link text\`, \`partial link text\`, \`javascript\` (jQuery-style).
- Variables: \`\${COLUMN_NAME}\` for CSV columns; \`\${config.key}\` for env config.
- StepDef body uses pgwen DSL actions/assertions.

Example meta (TodoMVC):

\`\`\`gherkin
Feature: TodoMVC meta

  @StepDef
  Scenario: the todo app is open
    Given the new-todo input can be located by class "new-todo"
     When I navigate to "\${app.url}"
     Then the new-todo input should be displayed

  @StepDef
  Scenario: the item is captured
    Given the new-todo input can be located by class "new-todo"
     When I enter "\${ITEM}" in the new-todo input
      And I press the Enter key

  @StepDef
  Scenario: the count reflects the new item
    Given the todo count can be located by class "todo-count"
     Then the todo count should contain "\${ITEM}"
\`\`\`

## pgwen DSL — categories

- **Navigation**: I navigate to, I refresh, I navigate back/forward
- **Actions**: I click, I enter "X" in, I select "X" in, I check/uncheck, I press <enter|tab> in
- **Assertions**: should be displayed/hidden/enabled/checked, should be "X", should contain "X", should match regex "X", should be true/false/blank/empty/defined
- **Bindings**: <name> is defined by xpath / json path / regex / file / javascript / system process
- **Capture**: I capture <element> as <name>, I capture the text in <ref> by xpath/json path
- **Flow control**: inline \`if <cond> otherwise <alt>\`, \`<step> until <cond>\`, \`<step> while <cond>\`, \`<step> for each <item> in <list>\`
- **Annotations**: @StepDef, @Context/@Action/@Assertion, @Eager/@Lazy, @Try, @Finally, @Soft/@Hard/@Sustained, @Timeout('Xs'), @Delay('Xs'), @Message('text')

## env config (conf/env/test.json, prod.json)

- Use HOCON-style JSON: \`{"pgwen": {...}, "app": {...}}\`.
- Reference secrets via env vars: \`"\${env.SECRET_NAME}"\` — never inline credentials.
- Mask sensitive keys with the \`:masked\` suffix: \`"apiKey:masked": "..."\`.
- Include URLs / channels / IDs that differ between environments.

## pgwen.conf

Base settings (HOCON):

\`\`\`hocon
project { name = "<project-name>" }

pgwen {
  baseDir = "pgwen"
  outDir  = "\${pgwen.baseDir}/output"
  target {
    browser = "chromium"
    env     = "test"
  }
  web {
    browser.headless = true
    capture.screenshots.enabled = true
  }
}
\`\`\`

## package.json scripts

\`\`\`json
{
  "scripts": {
    "pgwen":        "pgwen -p <BotName>",
    "pgwen:dryRun": "pgwen -p <BotName> -bn",
    "pgwen:repl":   "pgwen --repl"
  }
}
\`\`\`

## Important rules

1. NEVER inline credentials, API keys, or environment-specific URLs — use \`\${env.*}\` placeholders.
2. Feature steps are declarative; meta StepDefs are imperative.
3. Locator selectors will need project-author tuning — generate plausible placeholders, not guesses presented as facts.
4. README must explain: what the project does, input columns, environments, scheduling, integrations, and any compliance notes.
5. If the user provides "integrations" hints (object-storage, alerting, etc.) AND a conventions block exists, apply the conventions for those integrations. Otherwise leave a TODO comment for the project author.
6. If the user supplies organisation conventions (see below), they take precedence over the generic defaults.${conventionsBlock}${referenceBlock}`;
}

// ─── Reference-doc rendering ─────────────────────────────────────────────────

const KIND_HEADINGS: Record<LoadedDoc['kind'], { title: string; guidance: string }> = {
  'convention':        { title: 'Design conventions',                    guidance: 'MUST be honoured — override the generic defaults where they overlap.' },
  'doc':               { title: 'Requirements documentation',            guidance: 'Extract explicit requirements, acceptance criteria, and edge cases from these.' },
  'transcript':        { title: 'Meeting transcripts / notes',           guidance: 'Weight speaker intent and consensus decisions — ignore off-topic chatter.' },
  'reference-project': { title: 'Reference project pattern',             guidance: 'MIMIC THE SHAPE — naming, capability distribution, StepDef style. Do NOT copy scenarios verbatim; requirements differ.' },
  'url':               { title: 'External web references',               guidance: 'Treat as documentation the user has explicitly cited.' },
};

function renderReferenceDocs(docs?: LoadedDoc[]): string {
  if (!docs || docs.length === 0) return '';

  // Group by kind, preserve within-kind order.
  const byKind = new Map<LoadedDoc['kind'], LoadedDoc[]>();
  for (const d of docs) {
    const bucket = byKind.get(d.kind);
    if (bucket) bucket.push(d);
    else byKind.set(d.kind, [d]);
  }

  const parts: string[] = ['\n\n## Reference materials\n\nThe user has provided the following reference materials to inform this project design. Read each block, apply the guidance at the top of the block, and cite specifics from the source when you emit the blueprint (e.g. "based on requirement 3 in project-spec.md, …").\n'];

  // Deterministic kind order.
  const kindOrder: LoadedDoc['kind'][] = ['convention', 'doc', 'transcript', 'reference-project', 'url'];
  for (const kind of kindOrder) {
    const bucket = byKind.get(kind);
    if (!bucket || bucket.length === 0) continue;
    const heading = KIND_HEADINGS[kind];
    parts.push(`\n### ${heading.title}\n\n_Guidance: ${heading.guidance}_\n`);
    for (const doc of bucket) {
      parts.push(`\n#### Source: ${doc.path}\n\n${doc.content.trim()}\n`);
    }
  }

  return parts.join('');
}

// ─── User message builder ─────────────────────────────────────────────────────

export function buildUserMessage(ctx: ProjectContext): string {
  const lines: string[] = [
    `## Project context`,
    ``,
    `- **Project type:** ${ctx.projectType && ctx.projectType !== 'unknown' ? ctx.projectType : 'unknown (please ask)'}`,
    `- **Project name:** ${ctx.projectName}`,
    `- **Description:** ${ctx.description}`,
    `- **Environments:** ${ctx.environments}`,
    `- **Cron scheduled:** ${ctx.cronExpression ? `yes — ${ctx.cronExpression}` : 'no'}`,
    `- **CSV input feed:** ${ctx.hasCsvFeed ? `yes — columns: ${(ctx.csvColumns ?? []).join(', ')}` : 'no'}`,
  ];

  if (ctx.integrations && ctx.integrations.length > 0) {
    lines.push(`- **Integrations:** ${ctx.integrations.join(', ')}`);
  }

  if (ctx.notificationChannels?.test || ctx.notificationChannels?.prod) {
    const parts: string[] = [];
    if (ctx.notificationChannels.test) parts.push(`test=${ctx.notificationChannels.test}`);
    if (ctx.notificationChannels.prod) parts.push(`prod=${ctx.notificationChannels.prod}`);
    lines.push(`- **Notification channels:** ${parts.join(', ')}`);
  }

  lines.push(
    ``,
    `## Requirements`,
    ``,
    ctx.requirements,
  );

  return lines.join('\n');
}
