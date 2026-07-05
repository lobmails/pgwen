/**
 * cli/Init.ts — `pgwen init [dir]` subcommand.
 *
 * Scaffolds a fresh pgwen project directory by copying the canonical
 * `pgwen-template/` skeleton into the target dir. Default target is the
 * current working directory. Refuses to write into a non-empty dir unless
 * `--force` is given. `git init` and an initial commit are best-effort.
 *
 * Usage:
 *   pgwen init [dir] [--force] [--template <path>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface InitOptions {
  targetDir: string;
  templateDir: string;
  force: boolean;
}

export interface InitResult {
  targetDir: string;
  filesCopied: string[];
  gitInitialised: boolean;
}

const SKIP_TEMPLATE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'output',
  'pgwen/output',
]);

/**
 * Locate the bundled `pgwen-template/` directory. The template lives as a
 * sibling of the pgwen package root in the monorepo layout. Callers can
 * override via `--template`.
 */
export function defaultTemplateDir(): string {
  // src/cli/Init.ts → ../../.. is the experiment/ root containing pgwen-template
  const here = path.resolve(__dirname, '..', '..');
  const sibling = path.resolve(here, '..', 'pgwen-template');
  return sibling;
}

/**
 * Copy template tree into targetDir. Returns a flat list of relative paths
 * that were written.
 */
export function init(opts: InitOptions): InitResult {
  const { targetDir, templateDir, force } = opts;

  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    throw new Error(`pgwen init: template not found at ${templateDir}`);
  }

  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir).filter((n) => !n.startsWith('.'));
    if (entries.length > 0 && !force) {
      throw new Error(
        `pgwen init: target directory is not empty: ${targetDir}\n` +
        `Pass --force to scaffold into a non-empty directory.`
      );
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const filesCopied: string[] = [];
  copyTree(templateDir, targetDir, '', filesCopied);

  const gitInitialised = tryGitInit(targetDir);

  return { targetDir, filesCopied, gitInitialised };
}

function copyTree(srcRoot: string, dstRoot: string, relPath: string, filesCopied: string[]): void {
  const src = path.join(srcRoot, relPath);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (relPath && SKIP_TEMPLATE_DIRS.has(relPath)) return;
    const dst = path.join(dstRoot, relPath);
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyTree(srcRoot, dstRoot, relPath ? path.join(relPath, child) : child, filesCopied);
    }
  } else {
    const dst = path.join(dstRoot, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    filesCopied.push(relPath);
  }
}

function tryGitInit(targetDir: string): boolean {
  try {
    execSync('git init', { cwd: targetDir, stdio: 'ignore' });
    execSync('git add -A', { cwd: targetDir, stdio: 'ignore' });
    execSync('git commit -m "feat: initial pgwen scaffold via pgwen init"', {
      cwd: targetDir, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * Handle `pgwen init [dir]`. Called from launcher.ts when the first
 * positional argument is `init`.
 */
export function runInit(argv: string[], baseDir: string): void {
  let force = false;
  let templateOverride: string | undefined;
  let target: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--template' && argv[i + 1]) {
      templateOverride = argv[++i];
    } else if (arg && !arg.startsWith('-')) {
      target = arg;
    }
  }

  const targetDir = target
    ? (path.isAbsolute(target) ? target : path.join(baseDir, target))
    : baseDir;

  const templateDir = templateOverride
    ? (path.isAbsolute(templateOverride) ? templateOverride : path.join(baseDir, templateOverride))
    : defaultTemplateDir();

  try {
    const result = init({ targetDir, templateDir, force });
    console.log(`pgwen init: scaffolded ${result.filesCopied.length} file(s) into ${result.targetDir}`);
    if (result.gitInitialised) {
      console.log('pgwen init: git repository initialised with first commit');
    } else {
      console.log('pgwen init: skipped git init (already a repo or git not available)');
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
