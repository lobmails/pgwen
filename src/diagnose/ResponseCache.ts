/**
 * ResponseCache.ts — local file-backed cache of Claude diagnoses
 * (Phase 3 of §16).
 *
 * Key: SHA-256 of a canonical (key-sorted) JSON of the DiagnoseInput.
 * Layout: `<cacheDir>/<aa>/<full-hash>.json`, where `<aa>` is the first
 * 2 hex chars of the hash — keeps any single directory bounded.
 * Default TTL: 7 days. Entries past TTL are treated as cache misses and
 * not returned; `pruneExpiredCache` removes them on disk.
 *
 * Cost lever: a flaky scenario that fails repeatedly with the same
 * bundle fingerprint costs ONE Claude call per TTL window instead of
 * one per run. With a per-run rate cap of ~30 calls, the cache + TTL
 * combination usually means CI cost is bounded by the number of UNIQUE
 * failures, not the number of failed runs.
 *
 * Resilient by design — malformed cache files are silently treated as
 * misses (and not deleted; the next save overwrites them).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { DiagnoseInput, DiagnoseOutput } from './types';

export const DEFAULT_CACHE_TTL_DAYS = 7;
export const DIAGNOSIS_CACHE_SUBDIR = 'diagnosis-cache';

export interface CachedEntry {
  bundleHash: string;
  /** ISO 8601 UTC. */
  savedAt: string;
  ttlDays: number;
  diagnoseOutput: DiagnoseOutput;
  /** Cost telemetry — optional; written when the caller passes them in. */
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

export interface CacheOptions {
  /** Override the default 7-day TTL. */
  ttlDays?: number;
  /** Inject a clock — used only by tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface SaveOptions extends CacheOptions {
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

// ─── Canonical hashing ──────────────────────────────────────────────────────

/**
 * Stable hash of a DiagnoseInput. Object keys are sorted at every level so
 * the cache key is independent of field-insertion order — minor refactors
 * to the bundle assembler do not invalidate every entry.
 */
export function cacheKey(bundle: DiagnoseInput): string {
  const canonical = canonicalStringify(bundle);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (k) => JSON.stringify(k) + ':' + canonicalStringify((value as Record<string, unknown>)[k]),
    );
    return '{' + entries.join(',') + '}';
  }
  return 'null';
}

// ─── Lookup ─────────────────────────────────────────────────────────────────

/**
 * Look up a cached diagnosis for `bundle`. Returns `null` for cache miss,
 * expired entries, and malformed cache files. Does not write or delete.
 */
export function loadCachedDiagnosis(
  bundle: DiagnoseInput,
  cacheDir: string,
  opts: CacheOptions = {},
): CachedEntry | null {
  const hash = cacheKey(bundle);
  const filePath = entryPath(cacheDir, hash);
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let entry: CachedEntry;
  try {
    entry = JSON.parse(raw) as CachedEntry;
  } catch {
    return null; // corrupt cache file
  }

  if (typeof entry.savedAt !== 'string' || typeof entry.ttlDays !== 'number') return null;

  const now = opts.now ?? new Date();
  if (isExpired(entry, now)) return null;

  return entry;
}

function isExpired(entry: CachedEntry, now: Date): boolean {
  const saved = Date.parse(entry.savedAt);
  if (Number.isNaN(saved)) return true;
  const expiryMs = saved + entry.ttlDays * DAY_MS;
  return now.getTime() > expiryMs;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist a diagnosis for `bundle`. Creates the bucket directory if
 * needed. Returns the file path written. Overwrites any previous entry
 * at the same key (including corrupt ones).
 */
export function saveCachedDiagnosis(
  bundle: DiagnoseInput,
  output: DiagnoseOutput,
  cacheDir: string,
  opts: SaveOptions = {},
): string {
  const hash = cacheKey(bundle);
  const filePath = entryPath(cacheDir, hash);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const ttlDays = opts.ttlDays ?? DEFAULT_CACHE_TTL_DAYS;
  const savedAt = (opts.now ?? new Date()).toISOString();

  const entry: CachedEntry = {
    bundleHash: hash,
    savedAt,
    ttlDays,
    diagnoseOutput: output,
  };
  if (opts.tokensIn !== undefined) entry.tokensIn = opts.tokensIn;
  if (opts.tokensOut !== undefined) entry.tokensOut = opts.tokensOut;
  if (opts.model !== undefined) entry.model = opts.model;

  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  return filePath;
}

// ─── Pruning ────────────────────────────────────────────────────────────────

/**
 * Walk `<cacheDir>` and delete every entry past its TTL. Malformed
 * entries are also removed. Returns the number of files deleted.
 */
export function pruneExpiredCache(cacheDir: string, opts: CacheOptions = {}): number {
  if (!fs.existsSync(cacheDir)) return 0;
  const now = opts.now ?? new Date();
  let removed = 0;

  for (const bucket of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(cacheDir, bucket.name);
    for (const file of fs.readdirSync(bucketDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const full = path.join(bucketDir, file.name);
      let entry: CachedEntry | null = null;
      try {
        entry = JSON.parse(fs.readFileSync(full, 'utf8')) as CachedEntry;
      } catch {
        // malformed → drop it
      }
      const expired = entry === null || isExpired(entry, now);
      if (expired) {
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch {
          // ignore unlink errors (concurrent prune, perms, …)
        }
      }
    }
  }
  return removed;
}

// ─── Path layout ────────────────────────────────────────────────────────────

function entryPath(cacheDir: string, hash: string): string {
  // First two hex chars bucket entries so no single directory grows
  // unbounded. With 256 buckets, even a years-old per-project cache stays
  // small per dir.
  return path.join(cacheDir, hash.slice(0, 2), `${hash}.json`);
}
