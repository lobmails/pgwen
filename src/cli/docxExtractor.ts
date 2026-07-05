/**
 * cli/docxExtractor.ts — Extract plain text from a .docx file.
 *
 * DOCX is a ZIP archive containing `word/document.xml`. We parse the ZIP
 * sequentially from the local file headers (no need to walk the central
 * directory for a single named entry), inflate the compressed content
 * with Node's built-in `zlib.inflateRawSync`, then pull `<w:t>` text runs
 * out of the XML via `@xmldom/xmldom` (already a pgwen dependency).
 *
 * Zero new npm dependencies. Handles the typical DOCX shape produced by
 * MS Word, Google Docs, and LibreOffice. Doesn't attempt to preserve
 * formatting, tables, or ordering beyond what the source XML gives us —
 * this is a text-only extractor for feeding requirements docs into
 * Claude, not a full DOCX renderer.
 *
 * Limitations (return a helpful error rather than mis-extract):
 *   - Encrypted / password-protected DOCX
 *   - ZIP64 (files > 4 GB — irrelevant for text docs)
 *   - Non-DEFLATE compression methods
 */

import * as zlib from 'zlib';
import { DOMParser } from '@xmldom/xmldom';

const LFH_SIGNATURE = 0x04034b50;  // "PK\3\4"
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const TARGET_ENTRY = 'word/document.xml';

interface ZipEntry {
  fileName: string;
  compressionMethod: number;    // 0=stored, 8=deflate
  compressedSize: number;
  uncompressedSize: number;
  bitFlag: number;
  data: Buffer;
}

/**
 * Extract plain-text body from a DOCX buffer. Concatenates all `<w:t>`
 * runs in document order with newlines between paragraphs.
 */
export function extractDocxText(buffer: Buffer): string {
  const entry = findZipEntry(buffer, TARGET_ENTRY);
  if (!entry) {
    throw new Error(
      `docxExtractor: DOCX is missing ${TARGET_ENTRY} — the archive may be corrupt or not a Word document.`,
    );
  }
  const xml = inflateEntry(entry);
  return extractWordText(xml);
}

// ─── ZIP parsing ─────────────────────────────────────────────────────────────

/**
 * Walk local file headers from the start of the buffer until we find
 * `TARGET_ENTRY`, then return its record (name + compressed data view).
 */
function findZipEntry(buffer: Buffer, targetName: string): ZipEntry | null {
  let offset = 0;
  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === CENTRAL_DIR_SIGNATURE) {
      // Reached the central directory without finding target.
      return null;
    }
    if (signature !== LFH_SIGNATURE) {
      // Not a local file header — scan forward a byte. In practice the
      // first header is always at offset 0, and each subsequent header
      // follows the previous entry's data. Falling back to byte-scan
      // handles unusual archives (unknown extra fields, etc.).
      offset++;
      continue;
    }

    // Local file header layout (all little-endian):
    //   0  4  local file header signature = 0x04034b50 (already read)
    //   4  2  version needed to extract
    //   6  2  general purpose bit flag
    //   8  2  compression method
    //  10  2  last mod file time
    //  12  2  last mod file date
    //  14  4  crc-32
    //  18  4  compressed size
    //  22  4  uncompressed size
    //  26  2  file name length (n)
    //  28  2  extra field length (m)
    //  30 n  file name
    //  30+n m extra field
    //  30+n+m  compressed data (compressed size bytes)
    if (offset + 30 > buffer.length) return null;
    const bitFlag = buffer.readUInt16LE(offset + 6);
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    let compressedSize = buffer.readUInt32LE(offset + 18);
    let uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLen;
    if (nameEnd > buffer.length) return null;
    const fileName = buffer.subarray(nameStart, nameEnd).toString('utf-8');
    const dataStart = nameEnd + extraLen;

    // When bit 3 (0x0008) is set, sizes are 0 in the LFH and appear in a
    // data descriptor after the file data. We'd need to scan for the
    // data descriptor signature (0x08074b50) to find the end. Most DOCX
    // files don't use this — but if we hit it, we can still try scanning
    // for the next signature.
    if (compressedSize === 0 && (bitFlag & 0x08) !== 0) {
      // Scan forward for the next local file header, central-dir header,
      // or data-descriptor signature to bound the compressed data.
      const scanFrom = dataStart;
      let scan = scanFrom;
      while (scan < buffer.length - 4) {
        const sig = buffer.readUInt32LE(scan);
        if (sig === 0x08074b50) {
          // Data descriptor found. Sizes follow.
          compressedSize = buffer.readUInt32LE(scan + 8);
          uncompressedSize = buffer.readUInt32LE(scan + 12);
          break;
        }
        if (sig === LFH_SIGNATURE || sig === CENTRAL_DIR_SIGNATURE) {
          compressedSize = scan - scanFrom;
          break;
        }
        scan++;
      }
      if (compressedSize === 0) return null;
    }

    if (fileName === targetName) {
      if (dataStart + compressedSize > buffer.length) return null;
      return {
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        bitFlag,
        data: buffer.subarray(dataStart, dataStart + compressedSize),
      };
    }

    offset = dataStart + compressedSize;
  }
  return null;
}

function inflateEntry(entry: ZipEntry): string {
  if ((entry.bitFlag & 0x01) !== 0) {
    throw new Error(
      `docxExtractor: DOCX is password-protected — decrypt it first.`,
    );
  }
  if (entry.compressionMethod === 0) {
    return entry.data.toString('utf-8');
  }
  if (entry.compressionMethod === 8) {
    try {
      const inflated = zlib.inflateRawSync(entry.data);
      return inflated.toString('utf-8');
    } catch (err) {
      throw new Error(
        `docxExtractor: could not inflate ${entry.fileName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(
    `docxExtractor: unsupported compression method ${entry.compressionMethod} for ${entry.fileName} (only stored/deflate supported).`,
  );
}

// ─── XML → plain text ────────────────────────────────────────────────────────

/**
 * Extract text from a Word `document.xml` payload. Walks `<w:t>` runs in
 * document order, inserts a newline between paragraphs (`<w:p>`), and
 * inserts a tab between table cells (`<w:tc>`).
 *
 * The `w:` prefix is technically namespaced (`xmlns:w=".../wordprocessingml"`)
 * but for our purposes literal tag-name matching is fine — MS Word always
 * emits the `w:` prefix; other generators use it too.
 */
export function extractWordText(xml: string): string {
  // xmldom's default DOMParser prints warnings to stderr on malformed
  // input but recovers gracefully. We don't set a custom handler because
  // the type surface differs between xmldom versions; the defaults are
  // fine for text extraction where a best-effort read is preferable to
  // a hard throw on minor validation issues.
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Walk from the document element (skips the Document wrapper's node-type
  // quirks between xmldom and DOM lib types).
  const buffer: string[] = [];
  const root = doc.documentElement;
  if (root) walkNode(root, buffer);
  return buffer
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkNode(node: any, out: string[]): void {
  // ELEMENT_NODE = 1, TEXT_NODE = 3, DOCUMENT_NODE = 9
  if (node.nodeType === 1) {
    const tag = localName(node.nodeName);
    if (tag === 't') {
      // <w:t> text run.
      out.push(node.textContent ?? '');
      return;
    }
    if (tag === 'tab') {
      out.push('\t');
      return;
    }
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    // Recurse into children.
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) {
        walkNode(children.item(i), out);
      }
    }
    // Structural markers → whitespace after their content.
    if (tag === 'p') out.push('\n');
    else if (tag === 'tc') out.push('\t');
    else if (tag === 'tr') out.push('\n');
    return;
  }
  if (node.nodeType === 9 && node.childNodes) {
    for (let i = 0; i < node.childNodes.length; i++) {
      walkNode(node.childNodes.item(i), out);
    }
  }
}

/** Strip a namespace prefix like `w:t` → `t`. */
function localName(qname: string): string {
  const idx = qname.indexOf(':');
  return idx >= 0 ? qname.slice(idx + 1) : qname;
}
