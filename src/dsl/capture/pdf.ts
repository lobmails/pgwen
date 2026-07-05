/**
 * capture/pdf.ts — PDF text capture DSL steps.
 *
 * Implements the reference framework-compatible patterns for extracting text content from PDFs.
 * Supports file paths, URLs, and base64-encoded PDF blobs from scope bindings.
 *
 * Registered patterns:
 *   I capture the PDF text from file "<path>"
 *   I capture the PDF text from file "<path>" as <binding>
 *   I capture the PDF text from url "<url>"
 *   I capture the PDF text from url "<url>" as <binding>
 *   I capture the base64 encoded PDF text from the <binding>
 *   I capture the base64 encoded PDF text from the <binding> as <name>
 *
 * The default binding name (when "as <name>" is omitted) is "the PDF text",
 * standard behaviour behaviour.
 *
 * PDF text extraction uses pdfjs-dist (Mozilla). All pages are concatenated
 * with newline separators. The extracted text is stored as a transparent
 * (non-masked, non-readonly) scope binding.
 *
 * URL fetching uses the Node.js 18+ global fetch API. The response body is
 * read as an ArrayBuffer and passed directly to pdfjs-dist without writing
 * to disk.
 */

import * as fs from 'fs';
import type { DslRegistry } from '../registry';
import { extractPdfText } from './pdfExtractor';

const DEFAULT_BINDING = 'the PDF text';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerPdfCapture(registry: DslRegistry): void {

  // I capture the PDF text from file "<path>" [as <binding>]
  // Longer "as" form registered first (first-match wins).
  registry.register(
    /^I capture the PDF text from file "([^"]+)" as (.+)$/i,
    async ([filePath, nameRaw], scope) => {
      const name = nameRaw!.trim();
      const buffer = fs.readFileSync(filePath!);
      const text = await extractPdfText(buffer);
      scope.setTransparent(name, text);
    }
  );

  registry.register(
    /^I capture the PDF text from file "([^"]+)"$/i,
    async ([filePath], scope) => {
      const buffer = fs.readFileSync(filePath!);
      const text = await extractPdfText(buffer);
      scope.setTransparent(DEFAULT_BINDING, text);
    }
  );

  // I capture the PDF text from url "<url>" [as <binding>]
  registry.register(
    /^I capture the PDF text from url "([^"]+)" as (.+)$/i,
    async ([urlRaw, nameRaw], scope) => {
      const name = nameRaw!.trim();
      const buffer = await fetchPdfBuffer(urlRaw!);
      const text = await extractPdfText(buffer);
      scope.setTransparent(name, text);
    }
  );

  registry.register(
    /^I capture the PDF text from url "([^"]+)"$/i,
    async ([urlRaw], scope) => {
      const buffer = await fetchPdfBuffer(urlRaw!);
      const text = await extractPdfText(buffer);
      scope.setTransparent(DEFAULT_BINDING, text);
    }
  );

  // I capture the base64 encoded PDF text from the <binding> [as <name>]
  // <binding> is a scope variable containing a base64-encoded PDF blob.
  registry.register(
    /^I capture the base64 encoded PDF text from the (.+) as (.+)$/i,
    async ([bindingRaw, nameRaw], scope) => {
      const binding = bindingRaw!.trim();
      const name = nameRaw!.trim();
      const base64 = scope.get(binding) ?? '';
      const buffer = Buffer.from(base64, 'base64');
      const text = await extractPdfText(buffer);
      scope.setTransparent(name, text);
    }
  );

  registry.register(
    /^I capture the base64 encoded PDF text from the (.+)$/i,
    async ([bindingRaw], scope) => {
      const binding = bindingRaw!.trim();
      const base64 = scope.get(binding) ?? '';
      const buffer = Buffer.from(base64, 'base64');
      const text = await extractPdfText(buffer);
      scope.setTransparent(DEFAULT_BINDING, text);
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch a PDF from a URL and return its content as a Buffer.
 * Uses the Node.js 18+ global fetch API (no external dependency required).
 */
async function fetchPdfBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF from "${url}": HTTP ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
