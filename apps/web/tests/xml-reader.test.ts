import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { digest, validateSettlementRule } from '../server/settlement-rules.mjs';
import { parseSettlementCapture, retrieveSettlementCapture } from '../server/settlement-evidence.mjs';
import { XML_PARSER } from '../server/settlement-readers.mjs';

const T0 = 1_791_000_000, FEED = 'https://regulator.example.org/feed.xml';
const rule = (reader: any, over: any = {}) => ({ schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Will the regulator publish two notices?',
  source: { id: 'feed', publisher: 'Regulator', urls: [FEED], adapter: 'xml-feed.v1', reader: { parser: XML_PARSER, ...reader } },
  observation: { series: 'notices', period: '2026-10', unit: 'notices' }, decision: over.decision ?? { type: 'number', operator: 'gte', value: '2' },
  timing: { scheduledAt: T0, publicationCutoff: T0 + 3600, correctionCutoff: T0 + 3600, observationEndsAt: T0 + 3600, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
  vintage: over.vintage ?? 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
const capture = (r: any, body: string, contentType = 'application/rss+xml; charset=utf-8', fetchedAt = T0 + 30) => ({ requestedUrl: FEED, finalUrl: FEED, fetchedAt, status: 200,
  contentType, complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) });
const read = (r: any, body: string, type?: string) => parseSettlementCapture(validateSettlementRule(r), capture(r, body, type), T0 + 60).value;
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };
const seconds = (text: string) => String(Date.parse(text) / 1000);

const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Regulator notices</title>${items}</channel></rss>`;
const ITEMS = `<item><title>Policy rate unchanged</title><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><guid>1</guid></item>
<item><title>Press &amp; media</title><pubDate>Tue, 06 Oct 2026 12:30:00 +0000</pubDate><guid>2</guid></item>
<item><title>Older note</title><pubDate>Fri, 02 Oct 2026 09:00:00 GMT</pubDate><guid>3</guid></item>`;
const window = [{ path: '/pubDate', op: 'gte', value: seconds('2026-10-05T00:00:00Z'), format: 'rfc-2822' },
  { path: '/pubDate', op: 'lt', value: seconds('2026-10-07T00:00:00Z'), format: 'rfc-2822' }];
const count = { arrays: ['rss.channel.item'], select: '/rss/channel/item', aggregate: 'count', filter: window };
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:uuid:60a76c80</id><title>Updates</title>
<entry><title type="html">Hello &amp; welcome</title><link href="https://example.org/a" rel="alternate"/><id>urn:1</id><count>007</count></entry></feed>`;

test('xml-feed counts RSS items in a window', () => {
  assert.equal(read(rule(count), rss(ITEMS)), '2');
  assert.equal(read(rule({ ...count, filter: undefined, aggregate: 'count' }), rss(ITEMS)), '3');
  const one = rss('<item><title>Only</title><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>');
  assert.equal(read(rule(count), one), '1');
  assert.equal(reason(() => read(rule({ ...count, arrays: undefined }), one)), 'EXTRACTION_NOT_A_LIST');
  assert.equal(read(rule({ arrays: ['rss.channel.item'], select: '/rss/channel/item', aggregate: 'count', filter: [{ path: '/title', op: 'contains', value: 'Press' }] }), rss(ITEMS)), '1');
  assert.equal(read(rule({ arrays: ['rss.channel.item'], select: '/rss/channel/item', aggregate: 'only', field: '/guid', filter: [{ path: '/title', op: 'eq', value: 'Press & media' }] }), rss(ITEMS)), '2');
  assert.equal(read(rule(count), '﻿' + rss(ITEMS)), '2');
  for (const type of ['application/xml', 'text/xml; charset=utf-8', 'application/atom+xml', 'application/rss+xml'])
    assert.equal(read(rule(count), rss(ITEMS), type), '2', type);
});

test('xml-feed reads Atom attributes and text', () => {
  const category = { decision: { type: 'category', operator: 'eq', value: 'https://example.org/a' } };
  const link = { parser: XML_PARSER, arrays: ['feed.entry'], select: '/feed/entry/0/link/@href', aggregate: 'value', checks: [{ path: '/feed/id', equals: 'urn:uuid:60a76c80' }] };
  assert.equal(read(rule(link, category), ATOM, 'application/atom+xml'), 'https://example.org/a');
  assert.equal(reason(() => read(rule({ ...link, checks: [{ path: '/feed/id', equals: 'urn:uuid:other' }] }, category), ATOM, 'application/atom+xml')), 'OBSERVATION_IDENTITY_MISMATCH');
  assert.equal(read(rule({ arrays: ['feed.entry'], select: '/feed/entry/0/title/#text', aggregate: 'value' }, { decision: { type: 'category', operator: 'eq', value: 'x' } }), ATOM, 'application/atom+xml'), 'Hello & welcome');
  assert.equal(read(rule({ arrays: ['feed.entry'], select: '/feed/entry/0/title/@type', aggregate: 'value' }, { decision: { type: 'category', operator: 'eq', value: 'x' } }), ATOM, 'application/atom+xml'), 'html');
  assert.equal(read(rule({ arrays: ['feed.entry'], select: '/feed/entry/0/count', aggregate: 'value' }, { decision: { type: 'number', operator: 'gte', value: '1' } }), ATOM, 'application/atom+xml'), '7');
  assert.equal(reason(() => read(rule({ arrays: ['feed.entry'], select: '/feed/entry/0/title', aggregate: 'value' }, category), ATOM, 'application/atom+xml')), 'VALUE_INVALID');
  assert.equal(reason(() => read(rule({ arrays: ['feed.entry'], select: '/feed/entry/1/link/@href', aggregate: 'value' }, category), ATOM, 'application/atom+xml')), 'EXTRACTION_MISSING_FIELD');
  const stamp = rule({ select: '/rss/channel/item/pubDate', aggregate: 'value', valueFormat: 'rfc-2822' }, { decision: { type: 'timestamp', operator: 'gte', value: 1 } });
  assert.equal(read(stamp, rss('<item><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>')), Date.parse('2026-10-05T10:00:00Z') / 1000);
  const initial = rule({ select: '/rss/channel/item/guid', aggregate: 'value', publishedAt: { path: '/rss/channel/lastBuildDate', format: 'rfc-2822' } },
    { vintage: 'initial', decision: { type: 'number', operator: 'gte', value: '1' } });
  const built = Date.parse('2026-10-15T10:00:00Z') / 1000;
  const published = parseSettlementCapture(initial, capture(initial, rss('<lastBuildDate>Thu, 15 Oct 2026 10:00:00 GMT</lastBuildDate><item><guid>9</guid></item>'), 'application/rss+xml', built + 5), built + 10);
  assert.equal(published.publishedAt, built); assert.equal(published.value, '9');
});

test('unsafe or invalid XML is refused', () => {
  const r = rule(count);
  const entity = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "expanded">]><rss version="2.0"><channel><item><title>&x;</title></item></channel></rss>';
  assert.equal(reason(() => read(r, entity)), 'XML_DOCTYPE_REFUSED');
  assert.equal(reason(() => read(r, entity.replace('<!DOCTYPE', '<!doctype'))), 'XML_DOCTYPE_REFUSED');
  assert.equal(reason(() => read(r, '<rss><!ENTITY x "y"><channel/></rss>')), 'XML_DOCTYPE_REFUSED');
  assert.equal(reason(() => read(r, rss(ITEMS).replace('</channel></rss>', '</channel>'))), 'EXTRACTION_INVALID_XML');
  assert.equal(reason(() => read(r, '<rss><channel><item></channel></rss>')), 'EXTRACTION_INVALID_XML');
  assert.equal(reason(() => read(r, 'plain text, not xml')), 'EXTRACTION_INVALID_XML');
  assert.equal(reason(() => read(r, rss(ITEMS), 'application/json')), 'CONTENT_TYPE_MISMATCH');
  assert.equal(reason(() => read(r, rss(ITEMS), 'text/html')), 'CONTENT_TYPE_MISMATCH');
  assert.equal(reason(() => read(r, rss(ITEMS), '')), 'CONTENT_TYPE_MISMATCH');
});

test('the XML parser is pinned', () => {
  assert.equal(XML_PARSER, 'fast-xml-parser@5.11.1');
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies['fast-xml-parser'], '5.11.1');
  assert.equal(JSON.parse(readFileSync(new URL('../node_modules/fast-xml-parser/package.json', import.meta.url), 'utf8')).version, '5.11.1');
  assert.throws(() => validateSettlementRule(rule({ ...count, parser: 'fast-xml-parser@5.12.0' })), /Invalid XML reader/);
  assert.throws(() => validateSettlementRule(rule({ ...count, parser: undefined })), /Invalid XML reader/);
});

test('xml-feed settings are validated before any market can use them', () => {
  const base = { arrays: ['rss.channel.item'], select: '/rss/channel/item', aggregate: 'count' };
  const bad: [string, any, any?][] = [
    ['no select', { ...base, select: undefined }], ['no aggregate', { ...base, aggregate: undefined }], ['select without a slash', { ...base, select: 'item' }],
    ['no arrays entries', { ...base, arrays: [] }], ['duplicate arrays', { ...base, arrays: ['a', 'a'] }], ['nine arrays', { ...base, arrays: Array.from({ length: 9 }, (_, i) => `a${i}`) }],
    ['arrays with a space', { ...base, arrays: ['rss channel'] }], ['arrays not text', { ...base, arrays: [1] }], ['arrays leading digit', { ...base, arrays: ['1rss'] }],
    ['request body', { ...base, request: { method: 'POST', body: '{}' } }], ['derived value', { ...base, derive: { op: 'sum', select: '/a', aggregate: 'value' } }],
    ['unknown key', { ...base, anchors: ['abc'] }], ['bad filter', { ...base, filter: [{ path: '/t', op: 'gt', value: 'abc' }] }],
    ['count of a category', base, { decision: { type: 'category', operator: 'eq', value: 'x' } }],
    ['bad publication format', { select: '/a', aggregate: 'value', publishedAt: { path: '/p', format: 'rfc-3339' } }, { vintage: 'initial' }],
  ];
  assert.doesNotThrow(() => validateSettlementRule(rule(base)));
  assert.doesNotThrow(() => validateSettlementRule(rule({ select: '/a', aggregate: 'value', checks: [{ path: '/b', equals: 'x' }] }, { decision: { type: 'category', operator: 'eq', value: 'x' } })));
  for (const [label, reader, over] of bad) assert.throws(() => validateSettlementRule(rule(reader, over)), undefined, label);
});

test('xml-feed requests ask for feed media types and refuse redirects', async () => {
  const seen: any[] = [], subject = rule(count);
  const request = async (_url: string, init: any) => { seen.push(init); return new Response(rss(ITEMS), { status: 200, headers: { 'content-type': 'application/rss+xml' } }); };
  const got = await retrieveSettlementCapture(subject, FEED, { request: request as any, now: () => T0 + 30 });
  assert.equal(seen[0].headers.Accept, 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8');
  assert.equal(seen[0].redirect, 'error'); assert.equal('method' in seen[0], false);
  assert.equal(parseSettlementCapture(subject, got, T0 + 60).value, '2');
});

test('loading the readers does not load the XML parser', async () => {
  const rulesUrl = new URL('../server/settlement-rules.mjs', import.meta.url).href, evidenceUrl = new URL('../server/settlement-evidence.mjs', import.meta.url).href;
  const json = { ...rule({ select: '/a', aggregate: 'value' }), source: { id: 'source-1', publisher: 'Example', urls: ['https://data.example.org/value'], adapter: 'json-api.v1', reader: { select: '/a', aggregate: 'value' } } };
  const script = `
    import { createRequire } from 'node:module';
    const rules = await import(${JSON.stringify(rulesUrl)}), evidence = await import(${JSON.stringify(evidenceUrl)});
    const loaded = () => Object.keys(createRequire(import.meta.url).cache).filter(path => path.includes('fast-xml-parser')).length;
    rules.validateSettlementRule(JSON.parse(process.argv[1]));
    const before = loaded();
    const xml = JSON.parse(process.argv[2]), body = '<rss><channel><item><title>a</title></item></channel></rss>';
    evidence.parseSettlementCapture(xml, { requestedUrl: xml.source.urls[0], finalUrl: xml.source.urls[0], fetchedAt: 1791000030, status: 200,
      contentType: 'application/xml', complete: true, body, bytes: Buffer.byteLength(body), sha256: rules.digest(body) }, 1791000060);
    console.log(JSON.stringify({ before, after: loaded() }));`;
  const xml = rule({ arrays: ['rss.channel.item'], select: '/rss/channel/item', aggregate: 'count' });
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(json), JSON.stringify(xml)], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.deepEqual(JSON.parse(result.stdout), { before: 0, after: 1 });
});
