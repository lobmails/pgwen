/**
 * cli/docLoader.ts — Load reference materials for `pgwen new`.
 *
 * Handles four input surfaces the wizard exposes as CLI flags:
 *
 *   --conventions <path>       kind: 'convention'
 *   --doc <path>               kind: 'doc'          (repeatable)
 *   --transcript <path>        kind: 'transcript'   (repeatable)
 *   --reference-project <path> kind: 'reference-project'
 *   --doc-url <url>            kind: 'url'          (repeatable)
 *
 * Each path can be a single file or a directory. Directories are walked
 * recursively; the walker picks up `.md`, `.txt`, `.markdown`, and `.pdf`
 * files (extension set is configurable per call).
 *
 * PDF text extraction reuses `src/dsl/capture/pdfExtractor.ts` — the same
 * `pdfjs-dist` machinery the DSL layer uses for `I capture the PDF text`.
 *
 * URL fetching uses the Node 18+ global `fetch` API. HTML responses are
 * converted to plain text via a light DOM stripper (no external
 * dependency).
 *
 * Reference-project mode walks an existing pgwen project's `pgwen/features/`,
 * `pgwen/meta/`, and `pgwen/conf/profiles/` and produces a single summary
 * doc that Claude uses as a design pattern to mimic.
 *
 * Everything ends up as a uniform `LoadedDoc[]` the wizard injects into
 * the system prompt tagged by kind so Claude can weight each source
 * appropriately.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractPdfText } from '../dsl/capture/pdfExtractor';
import { extractDocxText } from './docxExtractor';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocKind = 'convention' | 'doc' | 'transcript' | 'reference-project' | 'url';

export interface LoadedDoc {
  /** Descriptive source label — absolute file path or URL. */
  path: string;
  /** How Claude should weight and label this content in the prompt. */
  kind: DocKind;
  /** Extracted UTF-8 text. */
  content: string;
  /** Character count for context-window accounting. */
  charCount: number;
}

export interface LoadOptions {
  /** Reject a single file whose on-disk size exceeds this. Default 5 MB. */
  maxBytesPerFile?: number;
  /** Reject a single doc whose extracted text exceeds this. Default 500 000. */
  maxCharsPerDoc?: number;
  /** File extensions to include when walking a directory. */
  extensions?: string[];
  /** Directory names to skip during recursive walks. */
  skipDirs?: string[];
}

export interface UrlLoadOptions {
  /** Fetch timeout in ms. Default 20 000 ms. */
  timeoutMs?: number;
  /** Max response body bytes. Default 5 MB. */
  maxBytes?: number;
}

export interface ContextCheck {
  totalChars: number;
  estimatedTokens: number;
  softExceeded: boolean;
  hardExceeded: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARS_PER_DOC = 500_000;
const DEFAULT_EXTENSIONS = ['.md', '.txt', '.markdown', '.pdf', '.docx'];
const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache', '.yarn']);

/** Soft warning threshold across all loaded docs (~40k tokens). */
export const SOFT_CONTEXT_LIMIT_CHARS = 160_000;

/** Hard rejection threshold across all loaded docs (~100k tokens). */
export const HARD_CONTEXT_LIMIT_CHARS = 400_000;

// ─── Path / file loading ──────────────────────────────────────────────────────

/**
 * Load a filesystem path as one or more `LoadedDoc`.
 * - If the path is a single file, returns a one-element array.
 * - If the path is a directory, walks recursively and returns all matching files.
 * - Empty files are silently skipped.
 * - Missing paths throw with a clear message.
 */
export async function loadPathAsDocs(
  inputPath: string,
  kind: DocKind,
  opts?: LoadOptions,
): Promise<LoadedDoc[]> {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`docLoader: path not found: ${inputPath}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return loadDirectory(resolved, kind, opts);
  }
  const doc = await loadFile(resolved, kind, opts);
  return doc ? [doc] : [];
}

async function loadDirectory(
  dirPath: string,
  kind: DocKind,
  opts?: LoadOptions,
): Promise<LoadedDoc[]> {
  const extensions = new Set(
    (opts?.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
  );
  const skipDirs = new Set([
    ...(opts?.skipDirs ?? []),
    ...DEFAULT_SKIP_DIRS,
  ]);
  const results: LoadedDoc[] = [];
  const visited = new Set<string>();
  await walkDir(dirPath, extensions, skipDirs, visited, results, kind, opts);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkDir(
  dir: string,
  extensions: Set<string>,
  skipDirs: Set<string>,
  visited: Set<string>,
  results: LoadedDoc[],
  kind: DocKind,
  opts?: LoadOptions,
): Promise<void> {
  // Symlink-loop guard via realpath.
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, extensions, skipDirs, visited, results, kind, opts);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.has(ext)) {
        const doc = await loadFile(full, kind, opts);
        if (doc) results.push(doc);
      }
    }
  }
}

async function loadFile(
  filePath: string,
  kind: DocKind,
  opts?: LoadOptions,
): Promise<LoadedDoc | null> {
  const maxBytes = opts?.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxChars = opts?.maxCharsPerDoc ?? DEFAULT_MAX_CHARS_PER_DOC;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new Error(`docLoader: cannot stat ${filePath}: ${errMsg(err)}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `docLoader: file ${filePath} is ${formatBytes(stat.size)} — over the ${formatBytes(maxBytes)} per-file limit. Split it or raise --max-bytes-per-file.`,
    );
  }
  const ext = path.extname(filePath).toLowerCase();
  let content: string;
  try {
    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      content = await extractPdfText(buf);
    } else if (ext === '.docx') {
      const buf = fs.readFileSync(filePath);
      content = extractDocxText(buf);
    } else {
      // .md, .txt, .markdown, or unknown extension → try as UTF-8 text.
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (err) {
    throw new Error(`docLoader: could not read ${filePath}: ${errMsg(err)}`);
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (content.length > maxChars) {
    throw new Error(
      `docLoader: file ${filePath} extracted to ${content.length} chars — over the ${maxChars} per-doc limit.`,
    );
  }
  return {
    path: filePath,
    kind,
    content,
    charCount: content.length,
  };
}

// ─── URL fetching ─────────────────────────────────────────────────────────────

export async function loadUrlAsDoc(
  url: string,
  opts?: UrlLoadOptions,
): Promise<LoadedDoc> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`docLoader: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `docLoader: unsupported URL protocol ${parsed.protocol} — only http and https are allowed.`,
    );
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: ac.signal,
      headers: {
        accept: 'text/html,text/plain,text/markdown,application/pdf,*/*;q=0.5',
        'user-agent': 'pgwen-new/1.0 (+https://github.com/pgwen)',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`docLoader: URL fetch timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new Error(`docLoader: URL fetch failed: ${url} — ${errMsg(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(
      `docLoader: URL ${url} returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  // Enforce max size while streaming when possible; fallback to arrayBuffer size check.
  const buf = await response.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(
      `docLoader: URL ${url} response is ${formatBytes(buf.byteLength)} — over ${formatBytes(maxBytes)} limit.`,
    );
  }

  let content: string;
  if (contentType.includes('application/pdf')) {
    content = await extractPdfText(Buffer.from(buf));
  } else {
    const raw = Buffer.from(buf).toString('utf-8');
    content = contentType.includes('text/html') || raw.trimStart().startsWith('<')
      ? htmlToText(raw)
      : raw;
  }

  return {
    path: url,
    kind: 'url',
    content,
    charCount: content.length,
  };
}

/**
 * Minimal HTML → plain-text converter. Strips scripts, styles, comments,
 * turns block-level closers into newlines, decodes the six most common
 * entities, and collapses whitespace runs. Not a full DOM parser — good
 * enough for docs / spec pages.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|br|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Reference-project walker ─────────────────────────────────────────────────

/**
 * Walk an existing pgwen project and produce a single summary doc describing
 * its features, meta files, and profiles. Claude uses this as a design
 * pattern to mimic (naming style, capability distribution, StepDef shape) —
 * not as content to copy verbatim.
 */
export async function loadReferenceProject(
  projectPath: string,
  opts?: LoadOptions,
): Promise<LoadedDoc | null> {
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(
      `docLoader: reference-project path is not a directory: ${projectPath}`,
    );
  }
  const pgwenDir = fs.existsSync(path.join(resolved, 'pgwen'))
    ? path.join(resolved, 'pgwen')
    : resolved;
  const featureDir = path.join(pgwenDir, 'features');
  const metaDir = fs.existsSync(path.join(pgwenDir, 'meta'))
    ? path.join(pgwenDir, 'meta')
    : featureDir;
  const profileDir = path.join(pgwenDir, 'conf', 'profiles');

  const parts: string[] = [
    `# Reference project pattern`,
    ``,
    `The user is asking you to design a new project that MIMICS THE SHAPE of an`,
    `existing pgwen project. Use this reference for naming conventions, capability`,
    `distribution across meta files, StepDef style, and profile layout. Do NOT`,
    `copy scenarios verbatim — the new project has different requirements.`,
    ``,
    `Source: ${projectPath}`,
    ``,
  ];
  let foundSections = 0;

  if (fs.existsSync(featureDir) && fs.statSync(featureDir).isDirectory()) {
    const features = collectByExt(featureDir, ['.feature']);
    if (features.length > 0) {
      foundSections++;
      parts.push(`## Feature files (${features.length})\n`);
      for (const f of features) {
        const rel = path.relative(pgwenDir, f);
        parts.push(`### ${rel}\n\n\`\`\`gherkin\n${trimTo(safeRead(f), 4000)}\n\`\`\`\n`);
      }
    }
  }

  if (fs.existsSync(metaDir) && fs.statSync(metaDir).isDirectory() && metaDir !== featureDir) {
    const metas = collectByExt(metaDir, ['.meta']);
    if (metas.length > 0) {
      foundSections++;
      parts.push(`## Meta files (${metas.length}, reusable StepDefs)\n`);
      for (const m of metas) {
        const rel = path.relative(pgwenDir, m);
        parts.push(`### ${rel}\n\n\`\`\`gherkin\n${trimTo(safeRead(m), 4000)}\n\`\`\`\n`);
      }
    }
  } else if (fs.existsSync(featureDir)) {
    // Some projects put .meta files next to .feature — pick them up too.
    const metas = collectByExt(featureDir, ['.meta']);
    if (metas.length > 0) {
      foundSections++;
      parts.push(`## Meta files (${metas.length}, reusable StepDefs)\n`);
      for (const m of metas) {
        const rel = path.relative(pgwenDir, m);
        parts.push(`### ${rel}\n\n\`\`\`gherkin\n${trimTo(safeRead(m), 4000)}\n\`\`\`\n`);
      }
    }
  }

  if (fs.existsSync(profileDir) && fs.statSync(profileDir).isDirectory()) {
    const profiles = collectByExt(profileDir, ['.conf']);
    if (profiles.length > 0) {
      foundSections++;
      parts.push(`## Profiles (${profiles.length})\n`);
      for (const p of profiles) {
        const rel = path.relative(pgwenDir, p);
        parts.push(`### ${rel}\n\n\`\`\`\n${trimTo(safeRead(p), 1500)}\n\`\`\`\n`);
      }
    }
  }

  // Only return a doc if we actually found framework structure (features,
  // meta, or profiles). An arbitrary directory should produce null so the
  // caller can warn the user.
  if (foundSections === 0) return null;

  const combined = parts.join('\n');

  const maxChars = opts?.maxCharsPerDoc ?? DEFAULT_MAX_CHARS_PER_DOC;
  const trimmed = combined.length > maxChars
    ? combined.slice(0, maxChars) + '\n\n[…truncated…]'
    : combined;

  return {
    path: projectPath,
    kind: 'reference-project',
    content: trimmed,
    charCount: trimmed.length,
  };
}

// ─── Context-window accounting ────────────────────────────────────────────────

/**
 * Rough char-to-token heuristic — Claude tokenises English prose at
 * roughly 4 characters per token. Treat as a conservative upper bound;
 * dense technical text and code can be slower.
 */
export function estimateTokens(text: string | number): number {
  const charCount = typeof text === 'string' ? text.length : text;
  return Math.ceil(charCount / 4);
}

export function checkContext(docs: LoadedDoc[]): ContextCheck {
  const totalChars = docs.reduce((sum, d) => sum + d.charCount, 0);
  return {
    totalChars,
    estimatedTokens: estimateTokens(totalChars),
    softExceeded: totalChars > SOFT_CONTEXT_LIMIT_CHARS,
    hardExceeded: totalChars > HARD_CONTEXT_LIMIT_CHARS,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectByExt(dir: string, exts: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const lowered = exts.map((e) => e.toLowerCase());
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && lowered.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort();
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return `[docLoader: could not read ${file}]`;
  }
}

function trimTo(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n[…truncated…]';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
