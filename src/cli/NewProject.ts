#!/usr/bin/env node
/**
 * cli/NewProject.ts — pgwen:new — Claude-powered project scaffolding CLI.
 *
 * Usage:
 *   yarn pgwen:new [--template <path>] [--output <dir>] [--mode <flow>] [--conventions <file>]
 *
 * Launches an interactive Q&A session. Collects project requirements and basic
 * configuration, calls the Claude API, and generates a new project repository
 * baseline at the specified output directory.
 *
 * Input modes (--mode):
 *   guided  (default)  step-by-step questions with help text per prompt
 *   paste              skip the granular questions; paste a single requirements
 *                      blob (Jira ticket, test plan, rough notes — anything) and
 *                      let Claude extract structure from it
 *   expert             use sensible defaults; only ask for the project name + paste
 *                      block; non-interactive feel
 *
 * Organisation conventions (--conventions <file>):
 *   When given, the file content is inlined into the system prompt so Claude
 *   follows the org's patterns (login flows, internal APIs, naming, result
 *   tracking, etc.). Without it, Claude uses generic pgwen best practices and
 *   leaves TODO comments for org-specific bits.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   Required — Claude API key
 *
 * No SDK dependency — uses native fetch (Node 18+).
 */

import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PGWEN_LOGO_LINES } from '../reporting/ConsoleReporter';
import { buildSystemPrompt, buildUserMessage, type ProjectContext } from './NewProjectPrompt';
import { writeProjectRepo, parseTurnResponse, type ClaudeReadyResponse, type ClaudeTurnResponse, type ClaudeBlueprintResponse } from './NewProjectWriter';
import { selectAdapter, resolveProvider } from '../diagnose/ai/selectAdapter';
import type { AiChatMessage, AiClient } from '../diagnose/ai/types';
import {
  loadPathAsDocs,
  loadUrlAsDoc,
  loadReferenceProject,
  checkContext,
  type LoadedDoc,
} from './docLoader';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const USE_COLORS = process.stdout.isTTY;
const c = {
  cyan:   (s: string) => USE_COLORS ? `\x1b[36m${s}\x1b[0m` : s,
  green:  (s: string) => USE_COLORS ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s: string) => USE_COLORS ? `\x1b[33m${s}\x1b[0m` : s,
  red:    (s: string) => USE_COLORS ? `\x1b[31m${s}\x1b[0m` : s,
  bold:   (s: string) => USE_COLORS ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    (s: string) => USE_COLORS ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ─── CLI args ─────────────────────────────────────────────────────────────────

type Mode = 'guided' | 'paste' | 'expert';

interface CliArgs {
  templateDir: string;
  outputDir: string;
  mode: Mode;
  conventionsFile: string;
  /** --doc <path> — repeatable. Reference documentation (file or dir; .md / .txt / .pdf). */
  docPaths: string[];
  /** --transcript <path> — repeatable. Meeting transcripts (file or dir; same extensions as --doc). */
  transcriptPaths: string[];
  /** --reference-project <path> — existing pgwen project to mimic in shape. */
  referenceProjectPath: string;
  /** --doc-url <url> — repeatable. Web references (HTML → text, or application/pdf). */
  docUrls: string[];
  /** --allow-oversized — skip the hard context-window rejection. Default false. */
  allowOversized: boolean;
  /**
   * Override `pgwen.diagnose.ai.provider` for this scaffold run. One of
   * "claude" (default) | "openai" | "azure-openai" | "copilot".
   * Note: pgwen:new still uses its own hand-rolled fetch for the multi-
   * turn conversation today; the adapter wiring lands in phase G. This
   * arg is parsed here so the flag is documented + parsed consistently;
   * actual routing kicks in at phase G.
   */
  provider: string;
}

function parseArgs(argv?: string[]): CliArgs {
  const args = argv ?? process.argv.slice(2);
  let templateDir = '';
  let outputDir = '';
  let mode: Mode = 'guided';
  let conventionsFile = '';
  const docPaths: string[] = [];
  const transcriptPaths: string[] = [];
  let referenceProjectPath = '';
  const docUrls: string[] = [];
  let allowOversized = false;
  let provider = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--template' || arg === '-t') && args[i + 1]) {
      templateDir = path.resolve(args[++i]!);
    } else if ((arg === '--output' || arg === '-o') && args[i + 1]) {
      outputDir = path.resolve(args[++i]!);
    } else if (arg === '--mode' && args[i + 1]) {
      const m = args[++i]!.toLowerCase();
      if (m === 'guided' || m === 'paste' || m === 'expert') mode = m;
    } else if ((arg === '--conventions' || arg === '-C') && args[i + 1]) {
      conventionsFile = path.resolve(args[++i]!);
    } else if (arg === '--doc' && args[i + 1]) {
      docPaths.push(path.resolve(args[++i]!));
    } else if (arg === '--transcript' && args[i + 1]) {
      transcriptPaths.push(path.resolve(args[++i]!));
    } else if (arg === '--reference-project' && args[i + 1]) {
      referenceProjectPath = path.resolve(args[++i]!);
    } else if (arg === '--doc-url' && args[i + 1]) {
      docUrls.push(args[++i]!);
    } else if (arg === '--allow-oversized') {
      allowOversized = true;
    } else if (arg === '--provider' && args[i + 1]) {
      provider = args[++i]!.trim();
    }
  }

  return {
    templateDir, outputDir, mode, conventionsFile,
    docPaths, transcriptPaths, referenceProjectPath, docUrls, allowOversized,
    provider,
  };
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

interface AskOpts {
  help?: string;          // dim-grey explanation shown under the question
  example?: string;       // dim-grey example input
  default?: string;
}

async function ask(rl: readline.Interface, question: string, opts: AskOpts = {}): Promise<string> {
  if (opts.help)    console.log(c.dim(`    ${opts.help}`));
  if (opts.example) console.log(c.dim(`    Example: ${opts.example}`));
  const hint = opts.default ? c.dim(` [${opts.default}]`) : '';
  return new Promise(resolve => {
    rl.question(`${c.cyan('?')} ${question}${hint}: `, answer => {
      resolve(answer.trim() || (opts.default ?? ''));
    });
  });
}

async function askYesNo(rl: readline.Interface, question: string, opts: AskOpts & { defaultYes?: boolean } = {}): Promise<boolean> {
  const defaultYes = opts.defaultYes ?? false;
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(rl, `${question} ${c.dim(`(${hint})`)}`, { ...opts, default: '' });
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

async function askMultiline(rl: readline.Interface, prompt: string, help?: string): Promise<string> {
  console.log(`\n${c.cyan('?')} ${prompt}`);
  if (help) console.log(c.dim(`    ${help}`));
  console.log(c.dim('    Paste anything (Jira ticket, test plan, rough notes). Enter a blank line when done.\n'));
  const lines: string[] = [];
  return new Promise(resolve => {
    const onLine = (line: string) => {
      if (line === '' && lines.length > 0) {
        rl.removeListener('line', onLine);
        resolve(lines.join('\n'));
      } else {
        lines.push(line);
      }
    };
    rl.on('line', onLine);
  });
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(mode: Mode): void {
  console.log('');
  for (const line of PGWEN_LOGO_LINES) {
    console.log(c.cyan(line));
  }
  console.log('');
  console.log(c.bold('  pgwen:new') + c.dim(`  — Claude-powered project scaffolding (${mode} mode)`));
  console.log('');
  if (mode === 'guided') {
    console.log(c.dim('  Step-by-step Q&A. Each prompt includes a hint about what to enter.'));
    console.log(c.dim('  Generated code is a starting point — review locators and steps before running.'));
  } else if (mode === 'paste') {
    console.log(c.dim('  Paste your requirements (Jira ticket / test plan / rough notes).'));
    console.log(c.dim('  Claude will infer the structure. Best for BAs and analysts.'));
  } else {
    console.log(c.dim('  Expert mode — defaults assumed where possible. Only essentials asked.'));
  }
  console.log('');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(ctx: ProjectContext, outputDir: string, templateDir: string): void {
  console.log('');
  console.log(c.bold('  Summary'));
  console.log(c.dim('  ───────────────────────────────────────────'));
  console.log(`  Project name        : ${c.green(ctx.projectName)}`);
  console.log(`  Description     : ${ctx.description || c.dim('(inferred from requirements)')}`);
  console.log(`  Environments    : ${ctx.environments}`);
  console.log(`  Cron scheduled  : ${ctx.cronExpression ? c.yellow(ctx.cronExpression) : 'no'}`);
  console.log(`  CSV feed        : ${ctx.hasCsvFeed ? `yes — columns: ${(ctx.csvColumns ?? []).join(', ')}` : 'no'}`);
  if (ctx.integrations && ctx.integrations.length > 0) {
    console.log(`  Integrations    : ${ctx.integrations.join(', ')}`);
  }
  if (ctx.notificationChannels?.test || ctx.notificationChannels?.prod) {
    const parts: string[] = [];
    if (ctx.notificationChannels.test) parts.push(`test=${ctx.notificationChannels.test}`);
    if (ctx.notificationChannels.prod) parts.push(`prod=${ctx.notificationChannels.prod}`);
    console.log(`  Notifications   : ${parts.join(', ')}`);
  }
  if (ctx.conventions) {
    console.log(`  Conventions     : ${c.yellow('loaded from --conventions file')}`);
  }
  console.log(`  Template        : ${c.dim(templateDir || '(none — generic scaffold)')}`);
  console.log(`  Output dir      : ${c.dim(path.join(outputDir, ctx.projectName))}`);
  if (ctx.imageDataUrls?.length) {
    console.log(`  Screenshots     : ${ctx.imageDataUrls.length} image(s) attached`);
  }
  console.log(c.dim('  ───────────────────────────────────────────'));
  console.log('');
}

// ─── AI provider call (multi-provider) ───────────────────────────────────────

const MAX_TURNS = 10;
/**
 * Hard cap on TOTAL questions asked across the whole pgwen:new session.
 * Non-technical users get frustrated past ~10 questions. Once this is
 * reached, the conversation loop intercepts the next `question` turn
 * and prompts the AI to emit a blueprint with TODO entries for the
 * unknowns instead — those land in TODO.md for manual configuration.
 */
const QUESTION_CAP = 12;

export interface RunConversationResult {
  ready: ClaudeReadyResponse;
  /** Present when a blueprint was approved (always true in the normal flow). */
  blueprint?: ClaudeBlueprintResponse;
}

/**
 * Provider precedence (highest first):
 *   1. `--provider <name>` CLI flag
 *   2. `PGWEN_AI_PROVIDER` env (so CI pipelines can pin a provider
 *      without rewriting commands)
 *   3. Default "claude"
 *
 * Per-provider API key env vars (looked up in order based on chosen provider):
 *   claude       → ANTHROPIC_API_KEY
 *   openai       → OPENAI_API_KEY
 *   azure-openai → AZURE_OPENAI_API_KEY
 *   copilot      → GITHUB_TOKEN
 */
function resolveProviderName(cliFlag: string): string | undefined {
  const trimmed = cliFlag.trim();
  if (trimmed.length > 0) return trimmed;
  const env = process.env['PGWEN_AI_PROVIDER'];
  return env && env.trim().length > 0 ? env.trim() : undefined;
}

function envKeyForProvider(provider: string): string {
  switch (provider) {
    case 'openai':       return 'OPENAI_API_KEY';
    case 'azure-openai': return 'AZURE_OPENAI_API_KEY';
    case 'copilot':      return 'GITHUB_TOKEN';
    case 'claude':
    default:             return 'ANTHROPIC_API_KEY';
  }
}

function buildAdapter(providerFlag: string): { adapter: AiClient; providerName: string } {
  const requested = resolveProviderName(providerFlag);
  const providerName = resolveProvider(requested);
  const envName = envKeyForProvider(providerName);
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(
      `${envName} environment variable is not set.\n` +
      `Provider "${providerName}" requires this env var.\n` +
      `Export it before running: export ${envName}=<your-key>`,
    );
  }

  // Azure needs deployment + apiVersion; read from env so users can run
  // pgwen:new without committing those to a config file.
  if (providerName === 'azure-openai') {
    const deployment = process.env['AZURE_OPENAI_DEPLOYMENT'];
    const apiVersion = process.env['AZURE_OPENAI_API_VERSION'] ?? '2024-08-01-preview';
    const resource = process.env['AZURE_OPENAI_RESOURCE'];
    const baseUrl = process.env['AZURE_OPENAI_BASE_URL'];
    if (!deployment) {
      throw new Error(
        'AZURE_OPENAI_DEPLOYMENT environment variable is not set.\n' +
        'Provider "azure-openai" requires this env var (the deployment name).',
      );
    }
    if (!resource && !baseUrl) {
      throw new Error(
        'AZURE_OPENAI_RESOURCE or AZURE_OPENAI_BASE_URL environment variable must be set ' +
        'for provider "azure-openai".',
      );
    }
    return {
      adapter: selectAdapter({
        provider: providerName,
        apiKey,
        azureOpenai: { deployment, apiVersion, ...(resource !== undefined ? { resource } : {}) },
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      }),
      providerName,
    };
  }

  return {
    adapter: selectAdapter({ provider: providerName, apiKey }),
    providerName,
  };
}

/** Build the initial user message — text + any attached screenshots. */
function buildInitialUserMessage(ctx: ProjectContext): AiChatMessage {
  return {
    role: 'user',
    content: buildUserMessage(ctx),
    ...(ctx.imageDataUrls && ctx.imageDataUrls.length > 0
      ? { images: ctx.imageDataUrls }
      : {}),
  };
}

/**
 * Render Claude's proposed blueprint for user review. Match the colour
 * scheme used elsewhere in the CLI: cyan headings, dim sub-text.
 */
function renderBlueprint(bp: ClaudeBlueprintResponse): void {
  console.log(c.cyan(c.bold('  ┌─ Blueprint ────────────────────────────────────────────────────────')));
  console.log(c.bold(`  │ ${bp.summary}`));
  console.log(c.cyan('  │'));
  console.log(c.cyan('  │ Folder structure:'));
  for (const line of bp.folder_structure.split('\n')) console.log(c.dim(`  │   ${line}`));
  console.log(c.cyan('  │'));
  console.log(c.cyan('  │ Selected capabilities:'));
  for (const item of bp.selected_capabilities) console.log(`  │   ${c.green('✓')} ${item}`);
  if (bp.excluded_capabilities.length > 0) {
    console.log(c.cyan('  │'));
    console.log(c.cyan('  │ Excluded capabilities:'));
    for (const item of bp.excluded_capabilities) console.log(`  │   ${c.dim('·')} ${c.dim(item)}`);
  }
  console.log(c.cyan('  │'));
  console.log(c.cyan('  │ Scripts:'));
  for (const [key, val] of Object.entries(bp.scripts)) {
    console.log(`  │   ${c.bold(key)}: ${c.dim(val)}`);
  }
  if (bp.sample_files.length > 0) {
    console.log(c.cyan('  │'));
    console.log(c.cyan('  │ Sample files:'));
    for (const f of bp.sample_files) {
      console.log(`  │   ${c.bold(f.path)}`);
      for (const line of f.preview.split('\n').slice(0, 6)) {
        console.log(c.dim(`  │       ${line}`));
      }
      if (f.preview.split('\n').length > 6) console.log(c.dim('  │       …'));
    }
  }
  if (bp.ci_cd && bp.ci_cd.trim().length > 0) {
    console.log(c.cyan('  │'));
    console.log(c.cyan('  │ CI/CD:'));
    for (const line of bp.ci_cd.split('\n')) console.log(c.dim(`  │   ${line}`));
  }
  if (bp.assumptions.length > 0) {
    console.log(c.cyan('  │'));
    console.log(c.cyan('  │ Assumptions:'));
    for (const a of bp.assumptions) console.log(`  │   ${c.dim('·')} ${a}`);
  }
  if (bp.risks.length > 0) {
    console.log(c.cyan('  │'));
    console.log(c.yellow('  │ Risks:'));
    for (const r of bp.risks) console.log(`  │   ${c.yellow('⚠')} ${r}`);
  }
  if (bp.todos.length > 0) {
    console.log(c.cyan('  │'));
    console.log(c.cyan('  │ TODOs (written to TODO.md for you to complete manually):'));
    for (const t of bp.todos) console.log(`  │   ${c.cyan('☐')} ${t}`);
  }
  console.log(c.cyan(c.bold('  └────────────────────────────────────────────────────────────────────')));
}

/**
 * Run the multi-turn conversation. Loops up to MAX_TURNS, handling each
 * Claude response type (question / warning / blueprint / ready) interactively.
 * Returns the final "ready" response with summary + files.
 *
 * A "ready" response is rejected unless a preceding "blueprint" was approved
 * by the user — this guard is unconditional and applies in every CLI mode.
 */
export const NEW_PROJECT_QUESTION_CAP = QUESTION_CAP;

export async function runConversation(
  ctx: ProjectContext,
  rl: readline.Interface,
  adapter: AiClient,
  providerName: string,
): Promise<RunConversationResult> {
  const systemPrompt = buildSystemPrompt(ctx.conventions, ctx.referenceDocs);
  const messages: AiChatMessage[] = [buildInitialUserMessage(ctx)];

  let blueprintApproved = false;
  let approvedBlueprint: ClaudeBlueprintResponse | undefined;
  // Total questions asked across the whole conversation. Hard cap at
  // QUESTION_CAP; once reached, any further `question` response is
  // intercepted and Claude is forced to emit a blueprint with TODOs
  // for the unknowns.
  let questionsAsked = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(c.dim(`  [turn ${turn}/${MAX_TURNS}] Calling ${providerName}…`));
    const result = await adapter.chat({
      systemPrompt,
      messages,
      maxTokens: 16000,
    });
    const raw = result.text;
    let parsed: ClaudeTurnResponse;
    try {
      parsed = parseTurnResponse(raw);
    } catch (err) {
      // Persist the raw response so the user can debug parse failures.
      const debugPath = path.join(os.tmpdir(), `pgwen-new-debug-turn-${turn}-${Date.now()}.txt`);
      fs.writeFileSync(debugPath, raw, 'utf-8');
      console.error(c.dim(`  Raw turn-${turn} response saved to: ${debugPath}`));
      throw err;
    }

    if (parsed.type === 'ready') {
      if (!blueprintApproved) {
        // Mandatory blueprint gate: refuse the `ready` and prompt Claude
        // to emit a blueprint first. This applies in every mode — even
        // --mode expert.
        console.log('');
        console.log(c.yellow(`  ⚠  ${providerName} attempted to generate without an approved blueprint.`));
        console.log(c.dim(`     Asking it to propose a blueprint for review first...`));
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            'STOP — do not emit "ready" yet. The CLI requires a "blueprint" response that the user explicitly approves before any files are generated. Please emit a "blueprint" turn now per the contract.',
        });
        console.log('');
        continue;
      }
      console.log('');
      console.log(c.green(`  Ready to generate (${Object.keys(parsed.files).length} files)`));
      return { ready: parsed, ...(approvedBlueprint !== undefined ? { blueprint: approvedBlueprint } : {}) };
    }

    // Append Claude's response to the history so it has context next turn.
    messages.push({ role: 'assistant', content: raw });

    if (parsed.type === 'question') {
      // Hard cap: never let the AI ask more than QUESTION_CAP total.
      // Past the cap, intercept + force a blueprint with TODOs for
      // anything still unknown.
      if (questionsAsked >= QUESTION_CAP) {
        console.log('');
        console.log(c.yellow(`  ⚠  Question cap (${QUESTION_CAP}) reached — asking ${providerName} for a blueprint.`));
        console.log(c.dim(`     Any remaining unknowns will be added to TODO.md for manual config.`));
        messages.push({
          role: 'user',
          content:
            `STOP — you have reached the ${QUESTION_CAP}-question cap. Do NOT ask another question. ` +
            `Emit a "blueprint" turn now using sensible defaults for anything you don't yet know. ` +
            `For each unknown, add a concrete actionable entry to the blueprint's "todos" array ` +
            `(format: "Set <config-key> in <file> to <expected-value>; matters because <reason>"). ` +
            `The CLI writes "todos" to TODO.md in the generated repo for the user to complete manually.`,
        });
        console.log('');
        continue;
      }
      console.log('');
      const remaining = QUESTION_CAP - questionsAsked;
      // Render batched or single question — same path, normalized to array.
      const help = parsed.help ? `\n    ${c.dim(parsed.help)}` : '';
      const newQuestions = Math.min(parsed.questions.length, remaining);
      // If a batch would exceed the cap, we still answer them all in
      // this turn (truncating mid-batch would be confusing) but the
      // counter will then exceed the cap and next turn's interceptor
      // forces the blueprint.
      questionsAsked += parsed.questions.length;
      const capNotice = parsed.questions.length === 1
        ? c.dim(`    (question ${questionsAsked}/${QUESTION_CAP})`)
        : c.dim(`    (${newQuestions} of ${remaining} remaining before cap)`);
      if (parsed.questions.length === 1) {
        console.log(c.cyan(`  ?`) + c.bold(` ${parsed.questions[0]!}`) + help);
        console.log(capNotice);
        const answer = await ask(rl, '  Your answer', {});
        messages.push({ role: 'user', content: answer });
      } else {
        console.log(c.cyan(`  ?`) + c.bold(` ${providerName} has ${parsed.questions.length} questions:`) + help);
        console.log(capNotice);
        const answers: string[] = [];
        for (let i = 0; i < parsed.questions.length; i++) {
          console.log(c.dim(`    ${i + 1}/${parsed.questions.length}`));
          console.log(`    ${parsed.questions[i]!}`);
          // eslint-disable-next-line no-await-in-loop
          const a = await ask(rl, `    Answer ${i + 1}`, {});
          answers.push(a);
        }
        const combined = parsed.questions
          .map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${answers[i]!}`)
          .join('\n\n');
        messages.push({ role: 'user', content: combined });
      }
      console.log('');
      continue;
    }

    if (parsed.type === 'blueprint') {
      console.log('');
      renderBlueprint(parsed);
      console.log('');
      const approve = await askYesNo(rl, '  Approve this blueprint?', { defaultYes: true });
      if (approve) {
        blueprintApproved = true;
        approvedBlueprint = parsed;
        messages.push({
          role: 'user',
          content:
            'Blueprint approved. Emit the "ready" response now with the full files map exactly as outlined in the blueprint.',
        });
      } else {
        console.log(c.dim(`  Type the changes you want — Claude will revise the blueprint.`));
        const feedback = await ask(rl, '  Revisions', {});
        messages.push({
          role: 'user',
          content: `Blueprint NOT approved. Revisions: ${feedback}\n\nPlease emit a revised "blueprint" turn incorporating these changes.`,
        });
      }
      console.log('');
      continue;
    }

    if (parsed.type === 'warning') {
      console.log('');
      console.log(c.yellow(`  ⚠  ${parsed.risk}`));
      console.log(c.dim(`     ${parsed.detail}`));
      console.log('');
      console.log(c.bold(`     Options:`));
      parsed.options.forEach((opt, i) => {
        console.log(`       ${c.cyan(String(i + 1))}. ${opt}`);
      });
      console.log(c.dim(`       Or type a custom answer.`));
      const selection = await ask(rl, '  Choose (number or text)', {});
      const asNum = parseInt(selection, 10);
      const chosen = !isNaN(asNum) && asNum >= 1 && asNum <= parsed.options.length
        ? parsed.options[asNum - 1]!
        : selection;
      messages.push({ role: 'user', content: `Selection: ${chosen}` });
      console.log('');
      continue;
    }
  }

  throw new Error(
    `Conversation did not reach "ready" within ${MAX_TURNS} turns. ` +
    `The last Claude response was still asking for clarification — narrow ` +
    `your requirements or rerun with --mode expert to apply defaults.`
  );
}

// ─── Image loading ────────────────────────────────────────────────────────────

function loadImages(filePaths: string[]): string[] {
  const dataUrls: string[] = [];
  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath.trim());
    if (!fs.existsSync(resolved)) {
      console.warn(c.yellow(`  Warning: image file not found, skipping: ${resolved}`));
      continue;
    }
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mime = mimeMap[ext] ?? 'image/png';
    const data = fs.readFileSync(resolved).toString('base64');
    dataUrls.push(`data:${mime};base64,${data}`);
  }
  return dataUrls;
}

// ─── Conventions file loader ──────────────────────────────────────────────────

function loadConventions(conventionsFile: string): string | undefined {
  if (!conventionsFile) return undefined;
  if (!fs.existsSync(conventionsFile)) {
    console.warn(c.yellow(`  Warning: conventions file not found: ${conventionsFile}`));
    return undefined;
  }
  const stat = fs.statSync(conventionsFile);
  // Directory-form: concatenate every .md / .txt / .markdown file under
  // the tree. PDF is intentionally not supported here — the DIRECTORY
  // shortcut is for a set of small markdown files that describe org
  // conventions. Use `--doc` for anything larger or PDF-based.
  if (stat.isDirectory()) {
    console.log(c.dim(`  Loading conventions directory: ${conventionsFile}`));
    const parts = collectTextFilesRecursive(conventionsFile);
    if (parts.length === 0) return undefined;
    const combined = parts
      .map(({ file, text }) => `## ${path.basename(file)}\n\n${text}`)
      .join('\n\n');
    console.log(c.dim(`  Loaded ${parts.length} convention file(s) (${combined.length} chars)`));
    return combined;
  }
  const content = fs.readFileSync(conventionsFile, 'utf-8');
  console.log(c.dim(`  Loaded conventions from ${conventionsFile} (${content.length} chars)`));
  return content;
}

/** Sync recursive walk for `--conventions <dir>`. Text-only extensions. */
function collectTextFilesRecursive(root: string): Array<{ file: string; text: string }> {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache', '.yarn']);
  const EXTS = new Set(['.md', '.txt', '.markdown']);
  const visited = new Set<string>();
  const out: Array<{ file: string; text: string }> = [];
  function walk(dir: string): void {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!EXTS.has(ext)) continue;
        try {
          const text = fs.readFileSync(full, 'utf-8');
          if (text.trim().length > 0) out.push({ file: full, text });
        } catch {
          /* ignore unreadable entries */
        }
      }
    }
  }
  walk(root);
  return out;
}

interface LoadAllReferenceDocsArgs {
  docPaths: string[];
  transcriptPaths: string[];
  referenceProjectPath: string;
  docUrls: string[];
  allowOversized: boolean;
}

/**
 * Load every reference material the user provided via CLI flags into a
 * single `LoadedDoc[]`. Runs sequentially so error messages arrive in a
 * predictable order; the wizard prints a per-source summary line as each
 * batch lands. Throws when the combined content blows past the hard
 * context-window limit unless `--allow-oversized` was set.
 */
async function loadAllReferenceDocs(args: LoadAllReferenceDocsArgs): Promise<LoadedDoc[]> {
  const all: LoadedDoc[] = [];

  for (const p of args.docPaths) {
    const docs = await loadPathAsDocs(p, 'doc');
    if (docs.length > 0) {
      console.log(c.dim(`  Loaded ${docs.length} doc file(s) from ${p} (${totalChars(docs)} chars)`));
    } else {
      console.warn(c.yellow(`  Warning: no readable docs under ${p}`));
    }
    all.push(...docs);
  }

  for (const p of args.transcriptPaths) {
    const docs = await loadPathAsDocs(p, 'transcript');
    if (docs.length > 0) {
      console.log(c.dim(`  Loaded ${docs.length} transcript file(s) from ${p} (${totalChars(docs)} chars)`));
    } else {
      console.warn(c.yellow(`  Warning: no readable transcripts under ${p}`));
    }
    all.push(...docs);
  }

  if (args.referenceProjectPath) {
    const doc = await loadReferenceProject(args.referenceProjectPath);
    if (doc) {
      console.log(c.dim(`  Loaded reference project ${args.referenceProjectPath} (${doc.charCount} chars)`));
      all.push(doc);
    } else {
      console.warn(c.yellow(`  Warning: reference project ${args.referenceProjectPath} had no feature/meta/profile content`));
    }
  }

  for (const url of args.docUrls) {
    try {
      const doc = await loadUrlAsDoc(url);
      console.log(c.dim(`  Loaded ${url} (${doc.charCount} chars)`));
      all.push(doc);
    } catch (err) {
      console.warn(c.yellow(`  Warning: could not load ${url} — ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  if (all.length > 0) {
    const check = checkContext(all);
    if (check.hardExceeded && !args.allowOversized) {
      throw new Error(
        `Combined reference material is ${check.totalChars} chars (~${check.estimatedTokens} tokens) — over the hard limit. ` +
        `Drop some inputs, or pass --allow-oversized if you know your provider can absorb it.`,
      );
    }
    if (check.softExceeded) {
      console.warn(c.yellow(
        `  Warning: ${check.totalChars} chars of reference material (~${check.estimatedTokens} tokens) is on the heavy side — Claude may summarise aggressively.`,
      ));
    }
  }

  return all;
}

function totalChars(docs: LoadedDoc[]): number {
  return docs.reduce((s, d) => s + d.charCount, 0);
}

// ─── Q&A: guided mode ─────────────────────────────────────────────────────────

async function collectGuided(rl: readline.Interface, conventions: string | undefined): Promise<ProjectContext> {
  console.log(c.bold('  Project identity'));
  console.log('');

  const projectName = await ask(rl, 'Project repo name', {
    help: 'kebab-case name for the new repo directory.',
    example: 'todomvc-project',
  });
  if (!projectName) {
    throw new Error('Project name is required.');
  }

  const description = await ask(rl, 'One-line description', {
    help: 'What does this project do? Keep it short — README opens with this line.',
    example: 'Adds a TodoMVC item, marks it complete, and asserts the count.',
  });

  console.log('');
  console.log(c.bold('  Requirements'));
  const requirements = await askMultiline(
    rl,
    'Describe what the project should do',
    'Anything goes: pasted ticket, list of test cases, rough notes, a single sentence.',
  );

  const imagePaths = await ask(rl, 'Screenshot/mockup file paths', {
    help: 'Optional. Comma-separated paths to PNG/JPG/WEBP files. Press Enter to skip.',
    example: 'docs/mockup.png,docs/state-flow.jpg',
  });
  const imageDataUrls = imagePaths
    ? loadImages(imagePaths.split(',').map(p => p.trim()).filter(Boolean))
    : [];

  console.log('');
  console.log(c.bold('  Configuration'));
  console.log('');

  const envAnswer = await ask(rl, 'Environments', {
    help: 'Which environments to scaffold env configs for. Multiple comma-separated, or pick a preset:',
    example: '1=test+prod, 2=test only, 3=prod only, custom: "test,staging,prod"',
    default: '1',
  });
  let environments: string;
  if (envAnswer === '1') environments = 'test,prod';
  else if (envAnswer === '2') environments = 'test';
  else if (envAnswer === '3') environments = 'prod';
  else environments = envAnswer;

  const isCronScheduled = await askYesNo(rl, 'Is this project cron-scheduled?', {
    help: 'If yes, the README will include the cron expression and pgwen.conf will get a comment.',
  });
  let cronExpression: string | undefined;
  if (isCronScheduled) {
    cronExpression = await ask(rl, 'Cron expression', {
      help: 'Standard cron 5-field expression.',
      example: '0 6 * * 1-5  (6am Mon-Fri)',
    });
  }

  const hasCsvFeed = await askYesNo(rl, 'Does this project consume a CSV input feed?', { defaultYes: true });
  let csvColumns: string[] | undefined;
  if (hasCsvFeed) {
    const colsAnswer = await ask(rl, 'CSV column names', {
      help: 'Comma-separated. These become the CSV header and are referenced as ${COLUMN} in features.',
      example: 'ORDER_ID,STATUS',
      default: 'ORDER_ID',
    });
    csvColumns = colsAnswer.split(',').map(s => s.trim()).filter(Boolean);
  }

  const integrationsAnswer = await ask(rl, 'Optional integrations', {
    help: 'Comma-separated tags Claude should honour. Free-form — use whatever names your conventions file expects.',
    example: 'object-storage, internal-alerts, sensitive-data',
  });
  const integrations = integrationsAnswer
    ? integrationsAnswer.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  console.log('');
  console.log(c.bold('  Notifications (optional)'));
  console.log('');

  const testChannel = await ask(rl, 'Test notification channel', {
    help: 'Where test-run success/failure alerts should go. Leave blank to skip.',
    example: 'team-projects-test',
  });
  const prodChannel = await ask(rl, 'Prod notification channel', {
    help: 'Where prod-run alerts should go. Leave blank to skip.',
    example: 'team-projects-alerts',
  });
  const notificationChannels = (testChannel || prodChannel)
    ? {
      ...(testChannel ? { test: testChannel } : {}),
      ...(prodChannel ? { prod: prodChannel } : {}),
    }
    : undefined;

  return {
    projectName,
    description,
    requirements,
    environments,
    ...(cronExpression ? { cronExpression } : {}),
    hasCsvFeed,
    ...(csvColumns ? { csvColumns } : {}),
    ...(integrations ? { integrations } : {}),
    ...(notificationChannels ? { notificationChannels } : {}),
    ...(conventions ? { conventions } : {}),
    imageDataUrls,
  };
}

// ─── Q&A: paste mode ──────────────────────────────────────────────────────────

async function collectPaste(rl: readline.Interface, conventions: string | undefined): Promise<ProjectContext> {
  console.log(c.bold('  Project identity'));
  console.log('');

  const projectName = await ask(rl, 'Project repo name', {
    help: 'kebab-case name for the new repo directory.',
    example: 'todomvc-project',
  });
  if (!projectName) {
    throw new Error('Project name is required.');
  }

  console.log('');
  console.log(c.bold('  Requirements'));
  const requirements = await askMultiline(
    rl,
    'Paste the project requirements',
    'Jira ticket, test plan, rough notes, anything. Claude will infer environments, CSV columns, scheduling, integrations from the content.',
  );

  const imagePaths = await ask(rl, 'Screenshot/mockup file paths', {
    help: 'Optional. Comma-separated. Press Enter to skip.',
  });
  const imageDataUrls = imagePaths
    ? loadImages(imagePaths.split(',').map(p => p.trim()).filter(Boolean))
    : [];

  return {
    projectName,
    description: '',
    requirements,
    environments: 'test,prod',
    hasCsvFeed: false,
    ...(conventions ? { conventions } : {}),
    imageDataUrls,
  };
}

// ─── Q&A: expert mode ─────────────────────────────────────────────────────────

async function collectExpert(rl: readline.Interface, conventions: string | undefined): Promise<ProjectContext> {
  const projectName = await ask(rl, 'Project repo name', { example: 'todomvc-project' });
  if (!projectName) throw new Error('Project name is required.');

  const requirements = await askMultiline(
    rl,
    'Requirements',
    'Minimal viable: a sentence or two on what to build.',
  );

  return {
    projectName,
    description: '',
    requirements,
    environments: 'test,prod',
    hasCsvFeed: true,
    csvColumns: ['ORDER_ID'],
    ...(conventions ? { conventions } : {}),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printNewProjectHelp(): void {
  console.log(`
pgwen new — AI-assisted project scaffolder

Usage:
  pgwen new [options]

Modes:
  --mode guided       Step-by-step Q&A with per-prompt help  (default)
  --mode paste        Skip granular questions; paste one requirements blob
  --mode expert       Minimal Q&A — project name + paste block only

Reference materials (each injected as a labelled block in Claude's prompt):
  --conventions <path>       Org conventions (file or dir). Overrides defaults.
  --doc <path>               Requirements docs (repeatable; file or dir).
                             .md / .markdown / .txt / .pdf / .docx supported.
  --transcript <path>        Meeting transcripts (repeatable; same file types).
  --reference-project <path> Existing pgwen project to mimic in shape.
  --doc-url <url>            HTTP/HTTPS URL — HTML → text, or application/pdf.
  --allow-oversized          Bypass the ~100k-token hard context guard.

Paths:
  --template, -t <path>      Template project whose fixed files get copied.
  --output, -o <dir>         Parent dir; new repo lives at <output>/<project-name>/.

AI provider (default: claude — needs ANTHROPIC_API_KEY):
  --provider <name>          claude | openai | azure-openai | copilot
                             (or set PGWEN_AI_PROVIDER env var)

  -h, --help                 Show this help

Examples:
  pgwen new
  pgwen new --mode expert --doc ./spec.pdf
  pgwen new --reference-project ../my-earlier-project
  pgwen new --provider openai --conventions ./team-conventions/
`);
}

export async function main(argv?: string[]): Promise<void> {
  const args = argv ?? process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printNewProjectHelp();
    return;
  }

  const {
    templateDir: argTemplate,
    outputDir: argOutput,
    mode,
    conventionsFile,
    docPaths,
    transcriptPaths,
    referenceProjectPath,
    docUrls,
    allowOversized,
    provider: cliProvider,
  } = parseArgs(argv);

  printBanner(mode);

  const conventions = loadConventions(conventionsFile);
  const referenceDocs = await loadAllReferenceDocs({
    docPaths, transcriptPaths, referenceProjectPath, docUrls, allowOversized,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    // ── Defaults ──────────────────────────────────────────────────────────────
    // No assumption about a specific template; the user supplies their own
    // path or the scaffolder falls back to a minimal generic skeleton.
    const defaultTemplate = argTemplate || '';
    const defaultOutput = argOutput || process.cwd();

    // ── Q&A ───────────────────────────────────────────────────────────────────
    let ctx: ProjectContext;
    if (mode === 'paste')     ctx = await collectPaste(rl, conventions);
    else if (mode === 'expert') ctx = await collectExpert(rl, conventions);
    else                       ctx = await collectGuided(rl, conventions);

    // Attach loaded reference docs (from --doc / --transcript / --reference-project /
    // --doc-url) to the context so runConversation → buildSystemPrompt can inject them.
    if (referenceDocs.length > 0) {
      ctx.referenceDocs = referenceDocs;
    }

    console.log('');
    console.log(c.bold('  Paths'));
    console.log('');

    const templateDir = await ask(rl, 'Template project path (optional, generic if blank)', {
      help: 'Path to an existing project repo whose conf/browsers and any other fixed files should be copied.',
      default: defaultTemplate,
    });
    const outputDir = await ask(rl, 'Output parent directory', {
      help: 'New repo will be created at <output>/<project-name>/.',
      default: defaultOutput,
    });

    // ── Summary + confirm ─────────────────────────────────────────────────────
    printSummary(ctx, outputDir, templateDir);

    const confirmed = await askYesNo(rl, 'Generate project repo with the above settings?', { defaultYes: true });
    if (!confirmed) {
      console.log(c.yellow('\n  Cancelled.'));
      process.exit(0);
    }

    // ── Resolve AI provider + adapter ─────────────────────────────────────────
    // Provider selection precedence: --provider CLI flag > PGWEN_AI_PROVIDER env
    // > default "claude". The chosen adapter requires its own API key env var
    // (see envKeyForProvider).
    let adapter: AiClient;
    let providerName: string;
    try {
      ({ adapter, providerName } = buildAdapter(cliProvider));
    } catch (err) {
      rl.close();
      console.error(c.red(`\n  ${(err as Error).message}`));
      process.exit(1);
    }

    // ── Run multi-turn conversation ───────────────────────────────────────────
    // The selected AI provider can ask clarifying questions, flag design risks,
    // propose a blueprint for approval, then emit the final file payload. The
    // readline interface stays open for the duration because question / warning /
    // blueprint turns prompt the user inline.
    console.log('');
    console.log(c.dim(`  Starting ${providerName} conversation…`));

    let conversationResult: RunConversationResult;
    try {
      conversationResult = await runConversation(ctx, rl, adapter, providerName);
    } catch (err) {
      rl.close();
      console.error(c.red(`\n  Conversation failed: ${(err as Error).message}`));
      process.exit(1);
    }
    const claudeResponse = conversationResult.ready;
    const approvedBlueprint = conversationResult.blueprint;

    rl.close();

    console.log('');
    console.log(c.dim(`  ${claudeResponse.summary}`));
    console.log('');

    const { outputPath, filesWritten } = writeProjectRepo(
      claudeResponse,
      ctx.projectName,
      outputDir,
      templateDir,
      // Pass the approved blueprint's todos through so TODO.md is written
      // even when the `ready` payload doesn't itself include the file.
      approvedBlueprint && approvedBlueprint.todos.length > 0
        ? { todos: approvedBlueprint.todos }
        : {},
    );

    // ── Done ──────────────────────────────────────────────────────────────────
    console.log(c.green(`  Project repo created: ${outputPath}`));
    console.log('');
    console.log(c.bold(`  Files generated (${filesWritten.length}):`));
    for (const f of filesWritten) {
      console.log(`    ${c.dim(f)}`);
    }
    console.log('');
    console.log(c.dim('  Next steps:'));
    console.log(c.dim('    1. Review and update locators in pgwen/meta/<BotName>.meta'));
    console.log(c.dim('    2. Update pgwen/conf/env/*.json with real URLs and channel names'));
    if (ctx.hasCsvFeed) {
      console.log(c.dim('    3. Add your input data to pgwen/input/input-feed.csv'));
      console.log(c.dim('    4. Run: yarn pgwen:dryRun  to validate step resolution'));
    } else {
      console.log(c.dim('    3. Run: yarn pgwen:dryRun  to validate step resolution'));
    }
    console.log('');

  } catch (err) {
    rl.close();
    console.error(c.red(`\n  Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

// Auto-run only when executed directly (e.g. `node dist/cli/NewProject.js` or via
// the `pgwen:new` npm script). Importing this module from launcher.ts to
// dispatch the `pgwen new` subcommand does NOT trigger this.
if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
