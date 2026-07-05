/**
 * cli/NewProjectWriter.ts — Write Claude-generated project files to disk.
 *
 * Takes the JSON response from Claude (files map) and:
 *   1. Creates the output directory
 *   2. Copies fixed template files (browser configs, any other org-supplied
 *      boilerplate the user pointed at via --template)
 *   3. Writes all Claude-generated files
 *   4. Initialises a git repo with an initial commit
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union over the four response types Claude can emit per turn.
 * See NewProjectPrompt for the protocol definition.
 *
 * `question` is normalized post-parse: whether Claude sent `question: "..."` or
 * `questions: ["...","..."]`, the parser always produces `questions: string[]`.
 * The single-string field is also preserved for backwards-compatible callers.
 */
export type ClaudeTurnResponse =
  | ClaudeQuestionResponse
  | { type: 'warning';  risk: string; detail: string; options: string[] }
  | ClaudeBlueprintResponse
  | ClaudeReadyResponse;

export interface ClaudeQuestionResponse {
  type: 'question';
  /** Normalized: always >=1. Single-question form lifts the string into [string]. */
  questions: string[];
  /** Legacy convenience: first element of `questions`. */
  question: string;
  /** Optional per-question field hints (parallel to `questions`). */
  fields?: string[];
  help?: string;
}

export interface ClaudeBlueprintResponse {
  type: 'blueprint';
  /** One-sentence description shown above the blueprint. */
  summary: string;
  /** Tree-style folder structure (multi-line string, monospace-friendly). */
  folder_structure: string;
  /** Bullet list of capabilities the project will include. */
  selected_capabilities: string[];
  /** Bullet list of capabilities deliberately left out + brief why. */
  excluded_capabilities: string[];
  /** npm/yarn script entries: { "pgwen": "pgwen -p X", ... } */
  scripts: Record<string, string>;
  /** Path + preview snippet of each major file Claude plans to write. */
  sample_files: Array<{ path: string; preview: string }>;
  /** CI/CD pipeline summary. Empty string when none configured. */
  ci_cd: string;
  /** Assumptions Claude made; user should sanity-check. */
  assumptions: string[];
  /** Open risks; user can override or supply more context. */
  risks: string[];
  /**
   * Things Claude could not infer + wants the user to configure manually
   * later (because the question cap was reached, or the answer needs
   * org-specific knowledge Claude doesn't have). Each entry should be a
   * concrete actionable item — file path / config key / what value to
   * set. Written to TODO.md in the generated project repo so non-technical
   * users have a checklist to work through after the scaffold lands.
   * Empty array is acceptable when Claude had enough info for everything.
   */
  todos: string[];
}

export interface ClaudeReadyResponse {
  type: 'ready';
  summary: string;
  files: Record<string, string>;
}

/** Legacy alias — kept for backwards compatibility with existing call sites. */
export type ClaudeResponse = ClaudeReadyResponse;

export interface WriteResult {
  outputPath: string;
  filesWritten: string[];
}

// ─── Main writer ──────────────────────────────────────────────────────────────

/**
 * Optional carry-over information from the approved blueprint that the
 * writer materialises alongside Claude's `files` map. Today only `todos`
 * is honoured — written to TODO.md so non-technical users have a
 * concrete checklist for everything pgwen:new couldn't infer (e.g.
 * because the question cap was reached or the answer needs
 * org-specific knowledge).
 */
export interface WriteProjectRepoExtras {
  /**
   * Approved-blueprint todos. When non-empty, a `TODO.md` is written at
   * the project repo root with one checkbox per entry plus a short header.
   * When Claude's `files` already includes TODO.md, our content is
   * appended below Claude's so neither source is lost.
   */
  todos?: string[];
}

/**
 * Write all generated files into outputDir/<projectName>/.
 * Copies template fixed files first, then overlays Claude-generated files.
 */
export function writeProjectRepo(
  claudeResponse: ClaudeResponse,
  projectName: string,
  outputParentDir: string,
  templateDir: string,
  extras: WriteProjectRepoExtras = {},
): WriteResult {
  const outputPath = path.join(outputParentDir, projectName);

  if (fs.existsSync(outputPath)) {
    throw new Error(`Directory already exists: ${outputPath}`);
  }

  fs.mkdirSync(outputPath, { recursive: true });

  const filesWritten: string[] = [];

  // ── 1. Copy fixed template files (structure + config boilerplate) ──────────
  copyTemplateFixedFiles(templateDir, outputPath, filesWritten);

  // ── 2. Write Claude-generated files (overwrite where needed) ──────────────
  for (const [relPath, content] of Object.entries(claudeResponse.files)) {
    const absPath = path.join(outputPath, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    filesWritten.push(relPath);
  }

  // ── 2b. Write TODO.md from the approved blueprint's `todos`, if any. ───────
  if (extras.todos && extras.todos.length > 0) {
    const todoPath = path.join(outputPath, 'TODO.md');
    const todoBody = renderTodoMarkdown(extras.todos, projectName);
    if (fs.existsSync(todoPath)) {
      // Claude already wrote a TODO.md — append rather than overwrite so
      // neither source is lost. Section header separates the two.
      const prior = fs.readFileSync(todoPath, 'utf-8');
      fs.writeFileSync(
        todoPath,
        prior.replace(/\s+$/, '') + '\n\n' + todoBody,
        'utf-8',
      );
    } else {
      fs.writeFileSync(todoPath, todoBody, 'utf-8');
      filesWritten.push('TODO.md');
    }
  }

  // ── 3. Git init + initial commit ──────────────────────────────────────────
  initGit(outputPath, projectName);

  return { outputPath, filesWritten };
}

// ─── Template file copy ───────────────────────────────────────────────────────

/**
 * Copy files from the template repo that are always carried over verbatim.
 * Claude-generated files with the same path will overwrite these.
 */
function copyTemplateFixedFiles(templateDir: string, outputPath: string, filesWritten: string[]): void {
  // Directories/files to carry over from the template project repo
  const fixed: string[] = [
    'pgwen/conf/browsers',
  ];

  for (const rel of fixed) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(outputPath, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyRecursive(src, dst, filesWritten, rel);
  }

  // Ensure all required directory stubs exist even if template doesn't have them
  for (const dir of ['pgwen/input', 'pgwen/output']) {
    fs.mkdirSync(path.join(outputPath, dir), { recursive: true });
  }

  // Write a .gitkeep so git tracks the empty input dir
  const gitkeep = path.join(outputPath, 'pgwen/input/.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, '', 'utf-8');
    filesWritten.push('pgwen/input/.gitkeep');
  }

  // Standard .gitignore for a pgwen project repo
  const gitignore = path.join(outputPath, '.gitignore');
  fs.writeFileSync(gitignore, [
    'node_modules/',
    'pgwen/output/',
    '*.log',
    '.DS_Store',
  ].join('\n') + '\n', 'utf-8');
  filesWritten.push('.gitignore');
}

/**
 * Render the approved blueprint's `todos` as a friendly markdown
 * checklist. Non-technical users open `TODO.md` after the project is
 * generated; each line should be a concrete actionable step.
 */
export function renderTodoMarkdown(todos: string[], projectName: string): string {
  const lines: string[] = [
    `# TODO — ${projectName}`,
    '',
    'This project was scaffolded by `pgwen:new`. The items below are things',
    'the AI could NOT infer from the questionnaire and need your manual',
    'attention before the project will work end-to-end.',
    '',
    'Tick each box once done. Anything you discard, delete the line.',
    '',
  ];
  for (const todo of todos) {
    const trimmed = todo.trim();
    if (trimmed.length === 0) continue;
    lines.push(`- [ ] ${trimmed}`);
  }
  lines.push('');
  return lines.join('\n');
}

function copyRecursive(src: string, dst: string, filesWritten: string[], relBase: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(
        path.join(src, child),
        path.join(dst, child),
        filesWritten,
        path.join(relBase, child)
      );
    }
  } else {
    fs.copyFileSync(src, dst);
    filesWritten.push(relBase);
  }
}

// ─── Git init ─────────────────────────────────────────────────────────────────

function initGit(repoPath: string, projectName: string): void {
  // Argv-form (execFileSync with args array) — never shells out. Prevents
  // shell-injection via crafted project names like `x"; rm -rf ~; #`.
  const opts = { cwd: repoPath, stdio: 'ignore' as const };
  const message = `feat: initial scaffold for ${projectName} via pgwen new`;
  try {
    execFileSync('git', ['init'], opts);
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('git', ['commit', '-m', message], opts);
  } catch {
    // Git init failure is non-fatal — files are written, just not committed
  }
}

// ─── Claude response parser ───────────────────────────────────────────────────

/**
 * Parse and validate one per-turn Claude response into a ClaudeTurnResponse.
 * Strips markdown code fences if Claude wrapped the JSON anyway. Supports the
 * three discriminated shapes (question / warning / ready) AND the legacy
 * single-call response that omits the `type` field (treated as "ready" when
 * it has summary + files).
 */
export function parseTurnResponse(raw: string): ClaudeTurnResponse {
  // Strip markdown code fences if Claude wrapped the JSON anyway
  let text = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text);
  if (fenceMatch) text = fenceMatch[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Claude returned non-JSON output. First 500 chars:\n${text.slice(0, 500)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Claude response is not a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj['type'];

  if (type === 'question') {
    // Two wire forms — additive: `question: "..."` (legacy single) or
    // `questions: ["...", "..."]` (new batched, capped at 6 by the prompt).
    // We normalize to `questions: string[]` and preserve the singular field
    // for callers that read it.
    let questions: string[];
    if (Array.isArray(obj['questions'])) {
      const arr = (obj['questions'] as unknown[]).filter((q) => typeof q === 'string') as string[];
      if (arr.length === 0) {
        throw new Error('"question" response had "questions" array but no string entries.');
      }
      if (arr.length > 6) {
        throw new Error(`"question" response has ${arr.length} questions (max 6 per batch).`);
      }
      questions = arr;
    } else if (typeof obj['question'] === 'string') {
      questions = [obj['question'] as string];
    } else {
      throw new Error('"question" response missing both "question" string and "questions" array.');
    }
    return {
      type: 'question',
      questions,
      question: questions[0]!,
      ...(Array.isArray(obj['fields'])
        ? { fields: (obj['fields'] as unknown[]).filter((f) => typeof f === 'string') as string[] }
        : typeof obj['field'] === 'string'
          ? { fields: [obj['field'] as string] }
          : {}),
      ...(typeof obj['help']  === 'string' ? { help:  obj['help']  as string } : {}),
    };
  }

  if (type === 'blueprint') {
    const required: Record<string, string> = {
      summary: 'string',
      folder_structure: 'string',
      ci_cd: 'string',
    };
    for (const [key, kind] of Object.entries(required)) {
      if (typeof obj[key] !== kind) {
        throw new Error(`"blueprint" response missing required ${kind} field "${key}".`);
      }
    }
    const arrayFields = ['selected_capabilities', 'excluded_capabilities', 'assumptions', 'risks'] as const;
    for (const k of arrayFields) {
      if (!Array.isArray(obj[k])) {
        throw new Error(`"blueprint" response missing required array field "${k}".`);
      }
    }
    if (typeof obj['scripts'] !== 'object' || obj['scripts'] === null || Array.isArray(obj['scripts'])) {
      throw new Error('"blueprint" response missing required object field "scripts".');
    }
    if (!Array.isArray(obj['sample_files'])) {
      throw new Error('"blueprint" response missing required array field "sample_files".');
    }
    // `todos` is required-but-may-be-empty. Older Claude responses
    // pre-dating the cap mechanism omit it — default to [] rather than
    // erroring so legacy transcripts replay cleanly.
    const todos = Array.isArray(obj['todos'])
      ? (obj['todos'] as unknown[]).map(String)
      : [];
    return {
      type: 'blueprint',
      summary: obj['summary'] as string,
      folder_structure: obj['folder_structure'] as string,
      selected_capabilities: (obj['selected_capabilities'] as unknown[]).map(String),
      excluded_capabilities: (obj['excluded_capabilities'] as unknown[]).map(String),
      scripts: obj['scripts'] as Record<string, string>,
      sample_files: (obj['sample_files'] as unknown[]).map((entry) => {
        const e = entry as Record<string, unknown>;
        return {
          path: String(e['path'] ?? ''),
          preview: String(e['preview'] ?? ''),
        };
      }),
      ci_cd: obj['ci_cd'] as string,
      assumptions: (obj['assumptions'] as unknown[]).map(String),
      risks: (obj['risks'] as unknown[]).map(String),
      todos,
    };
  }

  if (type === 'warning') {
    if (
      typeof obj['risk']   !== 'string' ||
      typeof obj['detail'] !== 'string' ||
      !Array.isArray(obj['options'])
    ) {
      throw new Error('"warning" response missing required fields risk/detail/options.');
    }
    return {
      type: 'warning',
      risk:    obj['risk']   as string,
      detail:  obj['detail'] as string,
      options: (obj['options'] as unknown[]).map(String),
    };
  }

  // Either type === 'ready' (new contract) or no type field at all (legacy).
  if (type === 'ready' || type === undefined) {
    if (typeof obj['summary'] !== 'string' || typeof obj['files'] !== 'object' || obj['files'] === null) {
      throw new Error('"ready" response missing required "summary" or "files" fields.');
    }
    return {
      type: 'ready',
      summary: obj['summary'] as string,
      files:   obj['files']   as Record<string, string>,
    };
  }

  throw new Error(`Unknown Claude response type: "${String(type)}"`);
}

/**
 * Legacy parser — assumes the response is a single "ready" payload.
 * Wraps parseTurnResponse and throws if Claude emitted question/warning.
 */
export function parseClaudeResponse(raw: string): ClaudeResponse {
  const parsed = parseTurnResponse(raw);
  if (parsed.type !== 'ready') {
    throw new Error(`Expected a "ready" response but Claude emitted "${parsed.type}".`);
  }
  return parsed;
}
