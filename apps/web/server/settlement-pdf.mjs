import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './settlement-rules.mjs';
import { MAX_PDF_BYTES, PDF_PARSER, parsePdfBundle } from './settlement-readers.mjs';

// PDF retrieval and the async checks that the synchronous pdf-text.v1 reader cannot do. The parser is imported
// only here and only when a PDF is actually read, so loading the readers (for example in the CRE bundle) never
// loads pdfjs-dist. Only settlement-evidence.mjs imports this file.
const MAX_CAPTURE_BYTES = 2_000_000;
const EXTRACTION_TIMEOUT_MS = 30_000;
const FONT_DIR = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/').replace(/\/?$/, '/');
const issue = reason => { throw Object.assign(Error(reason), { reason }); };
let pdfjs = null, installed = null;
const installedParser = () => installed ??= `pdfjs-dist@${JSON.parse(readFileSync(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url), 'utf8')).version}`;

export function normalizePdfText(text) {
  return text.replace(/[   ]/g, ' ').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
}

export async function extractPdfPages(bytes, { first, last }) {
  if (installedParser() !== PDF_PARSER) issue('PDF_PARSER_VERSION_MISMATCH');
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    stopAtErrors: true, standardFontDataUrl: FONT_DIR });
  let timer;
  try {
    const read = (async () => {
      const document = await task.promise;
      if (last > document.numPages) issue('PDF_PAGE_MISSING');
      const pages = [];
      for (let number = first; number <= last; number++) {
        const page = await document.getPage(number), content = await page.getTextContent();
        pages.push({ number, text: normalizePdfText(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')) });
        page.cleanup();
      }
      return pages;
    })();
    read.catch(() => {});
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('PDF_INVALID'), { reason: 'PDF_INVALID' })), EXTRACTION_TIMEOUT_MS); });
    return await Promise.race([read, limit]);
  } catch (error) {
    if (typeof error?.reason === 'string') throw error;
    return issue('PDF_INVALID');
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}

// Same transport rules as retrieveSettlementCapture (200, no redirect, no partial content, declared and streamed
// length), but the raw bytes are kept and bundled with the page text extracted from them.
export async function retrievePdfCapture(rule, url, { request = fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const controller = new AbortController();
  const response = await request(url, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    headers: { Accept: 'application/pdf', 'Cache-Control': 'no-cache' } });
  try {
    if (response.status !== 200 || !response.body || response.redirected || (response.url && response.url !== url)) issue('SOURCE_FETCH_FAILED');
    if (response.headers.has('content-range')) issue('SOURCE_PARTIAL_RESPONSE');
    const type = response.headers.get('content-type') ?? '';
    if (!/^application\/pdf(?:;|$)/i.test(type)) issue('CONTENT_TYPE_MISMATCH');
    const encoded = response.headers.get('content-encoding'), length = response.headers.get('content-length');
    let declared;
    if (length !== null && (!encoded || encoded.toLowerCase() === 'identity')) {
      if (!/^(?:0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))) issue('SOURCE_LENGTH_INVALID');
      declared = Number(length); if (declared > MAX_PDF_BYTES) issue('SOURCE_TOO_LARGE');
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_PDF_BYTES) issue('SOURCE_TOO_LARGE'); chunks.push(chunk); }
    if (declared !== undefined && declared !== bytes) issue('SOURCE_LENGTH_MISMATCH');
    if (!bytes) issue('SOURCE_EMPTY');
    const raw = Buffer.concat(chunks);
    if (raw.subarray(0, 5).toString('latin1') !== '%PDF-') issue('PDF_INVALID');
    const pages = await extractPdfPages(raw, rule.source.reader.pages);
    const body = JSON.stringify({ schema: 'flurbo.pdf-capture.v1', parser: PDF_PARSER, sourceContentType: type, pdf: raw.toString('base64'), pdfSha256: digest(raw), pages });
    if (Buffer.byteLength(body) > MAX_CAPTURE_BYTES) issue('SOURCE_TOO_LARGE');
    return { requestedUrl: url, finalUrl: url, fetchedAt: now(), status: 200, contentType: 'application/json', complete: true,
      bytes: Buffer.byteLength(body), body, sha256: digest(body) };
  } catch (error) {
    controller.abort();
    try { if (response.body && !response.body.locked) await response.body.cancel(); } catch { /* Retain the original retrieval failure. */ }
    throw error;
  }
}

// The reader trusts the page text it is given. Before evidence is archived, extract the text again from the raw
// bytes with the pinned parser and require it to be identical.
export async function verifyPdfCapture(rule, capture, { installed: version = installedParser() } = {}) {
  if (version !== PDF_PARSER) issue('PDF_PARSER_VERSION_MISMATCH');
  const { raw, pages } = parsePdfBundle(rule, capture);
  if (canonical(await extractPdfPages(raw, rule.source.reader.pages)) !== canonical(pages)) issue('PDF_TEXT_MISMATCH');
}

export async function verifyDerivedCaptures(rule, captures) {
  if (rule.source.adapter !== 'pdf-text.v1' || !Array.isArray(captures)) return;
  for (const capture of captures) await verifyPdfCapture(rule, capture);
}
