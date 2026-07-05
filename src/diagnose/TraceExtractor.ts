/**
 * TraceExtractor.ts — best-effort pre-failure DOM extraction from a
 * Playwright trace.zip (strategy doc §11 + §15b).
 *
 * Pure-Node, zero new dependencies. ZIP reading is implemented against the
 * APPNOTE-defined central-directory layout using only `node:fs/promises`
 * and `node:zlib`. Snapshot decoding is a CONSERVATIVE walker over
 * Playwright's tree-encoded DOM — known shapes are emitted as HTML, all
 * other shapes are silently dropped. The function returns `null` on any
 * unrecoverable problem so the Assembler can fall through to a no-DOM
 * bundle without crashing the run.
 *
 * Returns the HTML serialisation of the LAST `frame-snapshot` event found
 * in the trace, capped at `capBytes` (default 10 KB). The assembler will
 * trim further if needed to fit the §12 bundle budget.
 */

import { promises as fs } from 'fs';
import { inflateRawSync } from 'zlib';

export interface ExtractOptions {
  /** Maximum bytes of HTML to return. Default 10 KB per §11. */
  capBytes?: number;
}

const DEFAULT_CAP_BYTES = 10 * 1024;

/**
 * Extract the most recent pre-failure DOM excerpt from a Playwright
 * trace.zip. Returns `null` if the file is missing, malformed, contains
 * no recognisable frame snapshot, or the snapshot uses a shape this
 * conservative serialiser does not understand.
 */
export async function extractPreFailureDom(
  tracePath: string,
  opts: ExtractOptions = {},
): Promise<string | null> {
  const capBytes = opts.capBytes ?? DEFAULT_CAP_BYTES;

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(tracePath);
  } catch {
    return null;
  }

  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buffer);
  } catch {
    return null;
  }

  // Modern Playwright writes one or more `*.trace` files (e.g. `trace.trace`,
  // `0-trace.trace`). Scan them all in name order — the last frame-snapshot
  // across all of them is what we want.
  const traceFiles = [...entries.keys()].filter((n) => n.endsWith('.trace')).sort();
  let lastSnapshot: unknown = null;
  for (const name of traceFiles) {
    const snap = findLastFrameSnapshot(entries.get(name)!);
    if (snap !== null) lastSnapshot = snap;
  }
  if (lastSnapshot === null) return null;

  const html = serialiseSnapshotToHtml(lastSnapshot);
  if (html === null || html.length === 0) return null;
  return html.length > capBytes ? html.slice(0, capBytes) : html;
}

// ─── ZIP central directory reader ───────────────────────────────────────────
// Implements the subset of PKWare APPNOTE we need: STORED (method 0) and
// DEFLATE (method 8) entries, no ZIP64, no encryption, no spanned archives.
// Anything outside that surface causes `readZipEntries` to throw — caught
// upstream and turned into `null`.

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

interface CentralDirEntry {
  filename: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const eocdOffset = findEOCD(buffer);
  if (eocdOffset < 0) throw new Error('No EOCD record');

  const cdEntryCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = new Map<string, Buffer>();
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let i = 0; i < cdEntryCount; i++) {
    if (cursor + 46 > cdEnd) throw new Error('Central directory truncated');
    if (buffer.readUInt32LE(cursor) !== CD_SIG) throw new Error('Bad CD entry signature');

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const filename = buffer.subarray(cursor + 46, cursor + 46 + fileNameLen).toString('utf8');

    const entry: CentralDirEntry = {
      filename,
      compressionMethod: method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset: localOffset,
    };

    if (!filename.endsWith('/')) {
      entries.set(filename, readEntryData(buffer, entry));
    }

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

function findEOCD(buffer: Buffer): number {
  // EOCD is at most 22 + 65535 bytes from the end (comment field is up to 65535).
  const maxSearch = Math.min(buffer.length, 22 + 0xffff);
  for (let i = buffer.length - 22; i >= buffer.length - maxSearch && i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readEntryData(buffer: Buffer, entry: CentralDirEntry): Buffer {
  const lfhStart = entry.localHeaderOffset;
  if (buffer.readUInt32LE(lfhStart) !== LFH_SIG) throw new Error('Bad LFH signature');
  const fnLen = buffer.readUInt16LE(lfhStart + 26);
  const extraLen = buffer.readUInt16LE(lfhStart + 28);
  const dataStart = lfhStart + 30 + fnLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  const raw = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.filename}`);
}

// ─── Trace.trace scanner ────────────────────────────────────────────────────

/**
 * Parse an NDJSON trace.trace buffer and return the `snapshot` field of
 * the LAST `frame-snapshot` event. Returns `null` if no such event exists
 * or the buffer is unparseable.
 */
export function findLastFrameSnapshot(traceBuffer: Buffer): unknown {
  const text = traceBuffer.toString('utf8');
  let last: unknown = null;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines defensively
    }
    if (
      event !== null &&
      typeof event === 'object' &&
      (event as { type?: unknown }).type === 'frame-snapshot'
    ) {
      const snap = (event as { snapshot?: unknown }).snapshot;
      if (snap !== undefined) last = snap;
    }
  }
  return last;
}

// ─── Snapshot → HTML serialiser ─────────────────────────────────────────────
// Conservative walker over Playwright's tree-encoded DOM. Known shapes:
//   string                       → text node
//   [tagName, {attrs}, ...kids]  → element with attributes
//   [tagName, ...kids]           → element, no attributes
// Anything else (numbers used as dedup refs, namespace markers, null) is
// dropped — that preserves enough structure to be useful as a Claude prompt
// input while never crashing on format drift.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

export function serialiseSnapshotToHtml(snapshot: unknown): string | null {
  // Playwright wraps the tree-encoded DOM in a `html` field; accept either
  // the wrapped object or a bare tree for robustness.
  const tree =
    snapshot !== null && typeof snapshot === 'object' && 'html' in (snapshot as object)
      ? (snapshot as { html: unknown }).html
      : snapshot;

  return serialiseNode(tree);
}

function serialiseNode(node: unknown): string | null {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return escapeText(node);
  if (typeof node === 'number') return ''; // dedup back-reference — drop
  if (typeof node === 'boolean') return '';
  if (!Array.isArray(node)) return ''; // namespace / template marker objects — drop

  if (node.length === 0) return '';
  const head = node[0];
  if (typeof head !== 'string') return ''; // unrecognised shape

  const tag = head.toLowerCase();
  let attrsStr = '';
  let childStart = 1;

  if (node.length > 1 && isPlainAttrObject(node[1])) {
    attrsStr = serialiseAttrs(node[1] as Record<string, unknown>);
    childStart = 2;
  }

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrsStr}>`;
  }

  let childrenHtml = '';
  for (let i = childStart; i < node.length; i++) {
    const piece = serialiseNode(node[i]);
    if (piece !== null) childrenHtml += piece;
  }
  return `<${tag}${attrsStr}>${childrenHtml}</${tag}>`;
}

function isPlainAttrObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function serialiseAttrs(attrs: Record<string, unknown>): string {
  let out = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:.\-]*$/.test(name)) continue; // skip non-ascii / unsafe names
    if (value === true || value === '') {
      out += ` ${name}`;
    } else if (value === false || value === null || value === undefined) {
      // drop
    } else {
      out += ` ${name}="${escapeAttr(String(value))}"`;
    }
  }
  return out;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
