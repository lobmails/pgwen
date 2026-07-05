/**
 * pdfExtractor.ts — PDF text extraction helper using pdfjs-dist.
 *
 * Isolated in its own module so unit tests can mock it via vi.mock().
 * Uses dynamic import to load the ESM-only pdfjs-dist from a CommonJS context.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsLib = Record<string, any>;

let _cached: PdfjsLib | undefined;

async function loadPdfjsLib(): Promise<PdfjsLib> {
  if (_cached) return _cached;
  // Dynamic import of ESM module from CommonJS context (Node.js 18+).
  // The legacy build includes polyfills for non-browser environments.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib = await (import('pdfjs-dist/legacy/build/pdf.mjs' as string) as Promise<PdfjsLib>);
  _cached = lib;
  return lib;
}

/**
 * Extract all text content from a PDF supplied as a Buffer or Uint8Array.
 * Pages are separated by newlines. Whitespace is preserved as-is within each page.
 */
export async function extractPdfText(buffer: Buffer | Uint8Array): Promise<string> {
  const pdfjsLib = await loadPdfjsLib();

  // Disable the Web Worker — not needed for Node.js text-only extraction.
  pdfjsLib['GlobalWorkerOptions'].workerSrc = '';

  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib['getDocument']({
    data,
    useSystemFonts: true,
    // Disable eval-based optimisations (not available in Node.js)
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  const pages: string[] = [];
  for (let i = 1; i <= (pdf.numPages as number); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Each item is either a TextItem (has .str) or a TextMarkedContent (no .str)
    const pageText = (content.items as Array<{ str?: string }>)
      .map((item) => item.str ?? '')
      .join(' ');
    pages.push(pageText);
  }

  return pages.join('\n').trim();
}
