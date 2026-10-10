import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, settlementRuleHash, validateSettlementRule } from '../server/settlement-rules.mjs';
import { archiveSettlementProposal, evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture } from '../server/settlement-evidence.mjs';
import { verifyEvidence } from '../scripts/verify-settlement-evidence.mjs';
import { PDF_PARSER } from '../server/settlement-readers.mjs';
import { normalizePdfText, verifyDerivedCaptures, verifyPdfCapture } from '../server/settlement-pdf.mjs';
import { minimalPdf } from './pdf-fixture.ts';

const T0 = 1_791_000_000, URL_ = 'https://results.example.org/bulletin-12.pdf';
const PAGES = [['Official Results Bulletin 12', 'Turnout was 61.4 percent'], ['Page two text']];
const pdfRule = (reader: any = {}, over: any = {}) => ({ schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Will turnout be at least 60 percent?',
  source: { id: 'bulletin', publisher: 'Electoral commission', urls: [URL_], adapter: 'pdf-text.v1',
    reader: { parser: PDF_PARSER, pages: { first: 1, last: 1 }, anchors: ['Official Results Bulletin 12'], pattern: 'Turnout was ([0-9.]+) percent', ...reader } },
  observation: { series: 'turnout', period: '2026-10', unit: 'percent' }, decision: over.decision ?? { type: 'number', operator: 'gte', value: '60' },
  timing: { scheduledAt: T0, publicationCutoff: T0 + 3600, correctionCutoff: T0 + 3600, observationEndsAt: T0 + 3600, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
  vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
const serve = (body: Uint8Array | ReadableStream, type = 'application/pdf', extra: Record<string, string> = {}) =>
  async () => new Response(body as any, { status: 200, headers: { ...(type ? { 'content-type': type } : {}), ...extra } });
const fetchCapture = (rule: any, bytes: Uint8Array | ReadableStream, type?: string, extra?: Record<string, string>) =>
  retrieveSettlementCapture(rule, URL_, { request: serve(bytes, type, extra) as any, now: () => T0 + 30 });
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };
const rejection = async (promise: Promise<unknown>) => { try { await promise; } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };
const rebuilt = (capture: any, edit: (bundle: any) => void) => {
  const bundle = JSON.parse(capture.body); edit(bundle);
  const body = JSON.stringify(bundle);
  return { ...capture, body, bytes: Buffer.byteLength(body), sha256: digest(body) };
};

test('pdf-text reads one value from official PDF pages', async () => {
  const rule = pdfRule(), capture = await fetchCapture(rule, minimalPdf(PAGES));
  assert.equal(capture.contentType, 'application/json');
  assert.equal(parseSettlementCapture(rule, capture, T0 + 60).value, '61.4');
  const bundle = JSON.parse(capture.body);
  assert.deepEqual(bundle.pages, [{ number: 1, text: 'Official Results Bulletin 12 Turnout was 61.4 percent' }]);
  assert.equal(bundle.schema, 'flurbo.pdf-capture.v1'); assert.equal(bundle.parser, PDF_PARSER);
  assert.equal(bundle.sourceContentType, 'application/pdf'); assert.equal(bundle.pdfSha256, digest(minimalPdf(PAGES)));
  const both = pdfRule({ pages: { first: 1, last: 2 } , pattern: 'Page two (text)', anchors: ['Official Results Bulletin 12', 'percent'] }, { decision: { type: 'category', operator: 'eq', value: 'text' } });
  const wide = await fetchCapture(both, minimalPdf(PAGES));
  assert.deepEqual(JSON.parse(wide.body).pages.map((page: any) => page.number), [1, 2]);
  assert.equal(parseSettlementCapture(both, wide, T0 + 60).value, 'text');
  const ready: any = evaluateSettlement(rule, [capture], { now: T0 + 3600 });
  assert.equal(ready.status, 'ready'); assert.equal(ready.outcome, 2); assert.equal(ready.packet.measuredValue, '61.4');
  assert.equal(await verifyPdfCapture(rule, capture), undefined);
  assert.equal(await verifyDerivedCaptures(rule, [capture]), undefined);
});

test('edited text is caught before evidence is archived', async () => {
  const rule = pdfRule(), capture = await fetchCapture(rule, minimalPdf(PAGES));
  const edited = rebuilt(capture, bundle => { bundle.pages[0].text = bundle.pages[0].text.replace('61.4', '71.4'); });
  assert.equal(parseSettlementCapture(rule, edited, T0 + 60).value, '71.4');
  assert.equal(await rejection(verifyPdfCapture(rule, edited)), 'PDF_TEXT_MISMATCH');
  const stored = new Map<string, any>(), records: any[] = [];
  const base = { rule, expectedRuleHash: settlementRuleHash(rule), now: T0 + 3600, owner: 'fixture', draftHash: 'fixture',
    archive: { put: async (record: any) => { records.push(record); return { hash: '0x' + 'ab'.repeat(32), uri: 'https://example.org/evidence/1' }; } },
    packetStore: { put: async (packet: any, sha256: string) => { stored.set(`https://flurbopm.singu.online/api/settlement/packets/${sha256}`, packet); return { sha256, uri: `https://flurbopm.singu.online/api/settlement/packets/${sha256}` }; },
      get: async (uri: string) => stored.get(uri) } };
  assert.equal(await rejection(archiveSettlementProposal({ ...base, captures: [edited] })), 'PDF_TEXT_MISMATCH');
  assert.equal(records.length, 0);
  const archived = await archiveSettlementProposal({ ...base, captures: [capture] });
  assert.equal(archived.evidence.outcome, 2); assert.equal(records.length, 1);
  assert.equal(await verifyPdfCapture(rule, capture, { installed: 'pdfjs-dist@6.4.299' }).catch((error: any) => error.reason), 'PDF_PARSER_VERSION_MISMATCH');
});

test('the PDF bytes are bound to their hash', async () => {
  const rule = pdfRule(), capture = await fetchCapture(rule, minimalPdf(PAGES));
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.pdfSha256 = 'ab'.repeat(32); }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.pdf = bundle.pdf.slice(0, 40) + '\n' + bundle.pdf.slice(40); }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.pdf = bundle.pdf.replace(/=+$/, ''); }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  const flipped = Buffer.from(minimalPdf(PAGES)); flipped[flipped.length - 20] ^= 1;
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.pdf = flipped.toString('base64'); }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.parser = 'pdfjs-dist@6.4.299'; }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.sourceContentType = 'text/html'; }), T0 + 60)), 'CONTENT_TYPE_MISMATCH');
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.extra = 1; }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  assert.equal(reason(() => parseSettlementCapture(rule, rebuilt(capture, bundle => { bundle.pages = [{ number: 2, text: 'x' }]; }), T0 + 60)), 'PDF_CAPTURE_INVALID');
  assert.equal(reason(() => parseSettlementCapture(rule, { ...capture, contentType: 'text/html' }, T0 + 60)), 'CONTENT_TYPE_MISMATCH');
  const duplicate = capture.body.replace('"schema":"flurbo.pdf-capture.v1"', '"schema":"flurbo.pdf-capture.v1","schema":"flurbo.pdf-capture.v1"');
  assert.equal(reason(() => parseSettlementCapture(rule, { ...capture, body: duplicate, bytes: Buffer.byteLength(duplicate), sha256: digest(duplicate) }, T0 + 60)), 'EXTRACTION_DUPLICATE_FIELD');
  assert.equal(reason(() => parseSettlementCapture(pdfRule({ anchors: ['Not in the bulletin'] }), capture, T0 + 60)), 'OBSERVATION_IDENTITY_MISMATCH');
  assert.equal(reason(() => parseSettlementCapture(pdfRule({ pattern: '([0-9])' }), capture, T0 + 60)), 'EXTRACTION_AMBIGUOUS_OR_MISSING');
  assert.equal(reason(() => parseSettlementCapture(pdfRule({ pattern: 'Turnout was ([0-9.]+) points' }), capture, T0 + 60)), 'EXTRACTION_AMBIGUOUS_OR_MISSING');
});

test('pages, size and type are enforced', async () => {
  assert.equal(await rejection(fetchCapture(pdfRule({ pages: { first: 3, last: 3 } }), minimalPdf(PAGES))), 'PDF_PAGE_MISSING');
  assert.equal(await rejection(fetchCapture(pdfRule({ pages: { first: 1, last: 3 } }), minimalPdf(PAGES))), 'PDF_PAGE_MISSING');
  assert.equal(await rejection(fetchCapture(pdfRule(), Buffer.alloc(1_400_001, 0x41))), 'SOURCE_TOO_LARGE');
  const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_000_000)); controller.enqueue(new Uint8Array(400_001)); controller.close(); } });
  assert.equal(await rejection(fetchCapture(pdfRule(), streamed)), 'SOURCE_TOO_LARGE');
  assert.equal(await rejection(fetchCapture(pdfRule(), minimalPdf(PAGES), 'text/html')), 'CONTENT_TYPE_MISMATCH');
  assert.equal(await rejection(fetchCapture(pdfRule(), minimalPdf(PAGES), '')), 'CONTENT_TYPE_MISMATCH');
  assert.equal(await rejection(fetchCapture(pdfRule(), Buffer.from('hello world, not a document'))), 'PDF_INVALID');
  assert.equal(await rejection(fetchCapture(pdfRule(), Buffer.from('%PDF-1.4\nthis is not a real document\n'))), 'PDF_INVALID');
  assert.equal(await rejection(fetchCapture(pdfRule(), new Uint8Array(0))), 'SOURCE_EMPTY');
  assert.equal(await rejection(fetchCapture(pdfRule(), minimalPdf(PAGES), 'application/pdf', { 'content-range': 'bytes 0-10/30' })), 'SOURCE_PARTIAL_RESPONSE');
  assert.equal((await fetchCapture(pdfRule(), minimalPdf(PAGES), 'application/pdf; charset=binary')).status, 200);
  const sizes = await fetchCapture(pdfRule(), minimalPdf(PAGES));
  assert.ok(sizes.bytes < 2_000_000);
});

test('the parser is pinned', () => {
  assert.equal(PDF_PARSER, 'pdfjs-dist@6.3.289');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies['pdfjs-dist'], '6.3.289');
  const installed = JSON.parse(readFileSync(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url), 'utf8'));
  assert.equal(`pdfjs-dist@${installed.version}`, PDF_PARSER);
  assert.throws(() => validateSettlementRule(pdfRule({ parser: 'pdfjs-dist@6.4.299' })), /Invalid PDF reader/);
  assert.doesNotThrow(() => validateSettlementRule(pdfRule()));
});

test('pdf-text settings are validated before any market can use them', () => {
  const bad: [string, any][] = [
    ['no pages', { pages: undefined }], ['pages out of order', { pages: { first: 3, last: 2 } }], ['page zero', { pages: { first: 0, last: 1 } }],
    ['too many pages', { pages: { first: 1, last: 51 } }], ['fractional page', { pages: { first: 1, last: 1.5 } }], ['extra pages key', { pages: { first: 1, last: 1, step: 1 } }],
    ['no anchors', { anchors: [] }], ['short anchor', { anchors: ['ab'] }], ['unsafe pattern', { pattern: '(\\d+)+x' }], ['pattern without a group', { pattern: 'no group' }],
    ['bad grouping', { grouping: 'dot' }], ['unknown key', { select: '/a' }], ['no parser', { parser: undefined }],
  ];
  for (const [label, reader] of bad) {
    const rule: any = pdfRule(); for (const [key, value] of Object.entries(reader)) { if (value === undefined) delete rule.source.reader[key]; else rule.source.reader[key] = value; }
    assert.throws(() => validateSettlementRule(rule), undefined, label);
  }
  assert.doesNotThrow(() => validateSettlementRule(pdfRule({ pages: { first: 1, last: 50 }, grouping: 'comma' })));
  assert.throws(() => validateSettlementRule({ ...pdfRule(), vintage: 'initial' }), /publication time/);
});

test('page text is normalized to one line of plain characters', () => {
  assert.equal(normalizePdfText('Turnout was  61.4 percent\n‐ up – and − down\r\n'), 'Turnout was 61.4 percent - up - and - down');
  assert.equal(normalizePdfText('  a\t b \n\n c '), 'a b c');
});

test('archiving any other reader skips PDF verification', async () => {
  assert.equal(await verifyDerivedCaptures({ source: { adapter: 'json-api.v1' } }, [{ body: 'not a pdf bundle' }]), undefined);
  const rule: any = { schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Does the first release exceed 4.2 percent?',
    source: { id: 'fixture-source', publisher: 'Fixture Publisher', urls: ['https://data.example.org/release.json'], adapter: 'json-api.v1', reader: { select: '/value', aggregate: 'value' } },
    observation: { series: 'fixture-rate', period: '2026-11', unit: 'percent' }, decision: { type: 'number', operator: 'gt', value: '4.2' },
    timing: { scheduledAt: T0, publicationCutoff: T0 + 3600, correctionCutoff: T0 + 3600, observationEndsAt: T0 + 3600, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
  const body = '{"value":4.0}', capture = { requestedUrl: rule.source.urls[0], finalUrl: rule.source.urls[0], fetchedAt: T0 + 30, status: 200,
    contentType: 'application/json', complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) };
  const records: any[] = [];
  const archived = await archiveSettlementProposal({ rule, expectedRuleHash: settlementRuleHash(rule), captures: [capture], now: T0 + 3600, owner: 'fixture', draftHash: 'fixture',
    archive: { put: async (record: any) => { records.push(record); return { hash: '0x' + 'ab'.repeat(32), uri: 'https://example.org/evidence/1' }; } } });
  assert.equal(archived.evidence.outcome, 1); assert.equal(records.length, 1);
});

test('a replayed packet re-extracts PDF text, so a self-consistent edit is still caught', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-pdf-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rule = pdfRule(), ruleHash = settlementRuleHash(rule), capture = await fetchCapture(rule, minimalPdf(PAGES));
  const packetOf = (captures: any[]) => (evaluateSettlement(rule, captures, { now: T0 + 3600 }) as any).packet;
  const write = async (name: string, packet: unknown) => { const path = join(directory, name); await writeFile(path, JSON.stringify(packet)); return path; };
  const verified = await verifyEvidence(await write('packet.json', packetOf([capture])), { ruleHash });
  assert.deepEqual(verified, { status: 'verified', outcome: 2, measuredValue: '61.4', selectedRecordId: verified.selectedRecordId, adapter: 'pdf-text.v1' });
  const edited = rebuilt(capture, bundle => { bundle.pages[0].text = bundle.pages[0].text.replace('61.4', '41.4'); });
  const forged = packetOf([edited]);
  assert.equal(forged.outcome, 1);
  assert.equal(await rejection(verifyEvidence(await write('forged.json', forged), { ruleHash })), 'PDF_TEXT_MISMATCH');
});
