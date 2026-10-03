import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareDecimal, digest, settlementRuleHash, settlementTimeline, validateSettlementRule } from '../server/settlement-rules.mjs';
import { archiveSettlementProposal, evaluateSettlement, parseSettlementCapture, replaySettlement, retrieveSettlementCapture, verifySettlementPacket } from '../server/settlement-evidence.mjs';
import { historicalSettlementReplay } from '../scripts/replay-settlement.mjs';
import { historicalChainInput } from '../scripts/replay-settlement-chain.mjs';

const url = 'https://data.example.org/releases/test.json';
const start = 1800000000;
function rule(): any {
  return { schema: 'flurbo.settlement-rule.v1', eventId: 'employment', question: 'Does the initial rate exceed 4.2 percent?',
    source: { id: 'official-test-source', publisher: 'Synthetic fixture publisher', urls: [url], adapter: 'json-record.v1',
      fields: Object.fromEntries(['id', 'series', 'period', 'unit', 'publishedAt', 'kind', 'value', 'supersedesId'].map(key => [key, `/${key}`])) },
    observation: { series: 'unemployment', period: '2026-11', unit: 'percent' },
    decision: { type: 'number', operator: 'gt', value: '4.2' },
    timing: { scheduledAt: start, publicationCutoff: start + 3600, correctionCutoff: start + 7200, observationEndsAt: start + 7200,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'initial-with-corrections', missingPolicy: 'resolver-timeout-void' };
}
function capture(overrides: any = {}, sourceUrl = url): any {
  const record = { id: 'initial-1', series: 'unemployment', period: '2026-11', unit: 'percent', publishedAt: start,
    kind: 'initial', value: '4.6', supersedesId: '', ...overrides };
  const body = JSON.stringify(record);
  return { requestedUrl: sourceUrl, finalUrl: sourceUrl, fetchedAt: Math.max(record.publishedAt + 10, start + 7200), status: 200,
    contentType: 'application/json; charset=utf-8', complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) };
}
const evaluate = (captures: any[], at = start + 7200, r = rule()) => evaluateSettlement(r, captures, { now: at });

test('exact comparisons, threshold equality and canonical rule hash', () => {
  assert.equal(compareDecimal('9007199254740993.000000000000000001', '9007199254740993'), 1);
  assert.equal(compareDecimal('-0.01', '-0.1'), 1);
  assert.equal(compareDecimal('4.20', '4.2'), 0);
  for (const value of ['4.2e0', 4.2, 'NaN', '04.2', 'Infinity']) assert.throws(() => compareDecimal(value, '4.2'));
  const r = rule(), reordered = Object.fromEntries(Object.entries(r).reverse());
  assert.equal(settlementRuleHash(r), settlementRuleHash(reordered));
  assert.equal(evaluate([capture({ value: '4.2' })]).outcome, 1);
  r.decision.operator = 'gte'; assert.equal(evaluate([capture({ value: '4.2' })], start + 7200, r).outcome, 2);
});
test('unsupported sources, ambiguous rules and incompatible fixed deadlines fail before launch', () => {
  for (const mutate of [(r:any) => r.source.adapter = 'llm', (r:any) => r.source.urls = ['http://example.org'],
    (r:any) => r.source.fields.value = 'value', (r:any) => r.timing.challengePeriod = 10,
    (r:any) => r.timing.observationEndsAt++, (r:any) => r.vintage = 'latest', (r:any) => r.decision.operator = 'approximately',
    (r:any) => r.extra = true, (r:any) => r.missingPolicy = 'guess-no']) {
    const r = rule(); mutate(r); assert.throws(() => validateSettlementRule(r));
  }
  const t = settlementTimeline(rule(), start - 3600);
  assert.equal(t.minimumLockSeconds, 14400);
  assert.equal(t.assertionDeadlineExclusive, start + 10800);
});
test('ordinary, delayed, cancelled and missing releases follow distinct paths', () => {
  assert.equal(evaluate([capture()]).outcome, 2);
  assert.equal(evaluate([capture({ publishedAt: start + 1800 })]).outcome, 2);
  assert.equal(evaluate([capture({ publishedAt: start + 3601 })]).reason, 'RELEASE_AFTER_PUBLICATION_CUTOFF');
  assert.equal(evaluate([capture({ kind: 'cancelled', value: null })]).reason, 'SOURCE_CANCELLED');
  assert.equal(evaluate([]).reason, 'RELEASE_UNAVAILABLE');
  assert.equal(evaluate([capture()], start + 7199).reason, 'OBSERVATION_WINDOW_OPEN');
  assert.equal(evaluate([], start + 10800).reason, 'ASSERTION_DEADLINE_PASSED');
  assert.equal(evaluate([], start + 10800).timeoutOutcome, 3);
});
test('corrections cross threshold; revision, late correction and strict initial policy do not replace it', () => {
  const initial = capture(), correction = capture({ id: 'correction-1', kind: 'correction', supersedesId: 'initial-1', publishedAt: start + 1800, value: '4.1' });
  const result = evaluate([initial, correction]);
  assert.equal(result.outcome, 1); assert.equal(result.packet.selectedRecordId, 'correction-1');
  assert.equal(result.packet.records.length, 2); assert.equal(result.packet.captures.length, 2);
  assert.equal(evaluate([initial, capture({ id: 'revision', kind: 'revision', publishedAt: start + 1800, value: '4.1' })]).outcome, 2);
  assert.equal(evaluate([initial, capture({ id: 'late', kind: 'correction', supersedesId: 'initial-1', publishedAt: start + 7201, value: '4.1' })], start + 7220).outcome, 2);
  const strict = rule(); strict.vintage = 'initial'; strict.timing.correctionCutoff = strict.timing.observationEndsAt = strict.timing.publicationCutoff;
  assert.equal(evaluate([initial, correction].map(c => ({ ...c, fetchedAt: start + 4000 })), start + 4000, strict).outcome, 2);
});
test('correction notice needs linked replacement; branches and source conflicts remain unresolved', () => {
  const notice = capture({ id: 'notice', kind: 'correction-notice', supersedesId: 'initial-1', publishedAt: start + 1800, value: null });
  assert.equal(evaluate([capture(), notice]).reason, 'CORRECTION_WITHOUT_REPLACEMENT');
  const replacement = capture({ id: 'replacement', kind: 'correction', supersedesId: 'notice', publishedAt: start + 2000, value: '4.0' });
  assert.equal(evaluate([capture(), notice, replacement]).outcome, 1);
  assert.equal(evaluate([capture(), capture({ value: '4.1' })]).reason, 'INITIAL_SOURCE_CONFLICT');
  const branch = capture({ id: 'correction', kind: 'correction', supersedesId: 'some-other-release', publishedAt: start + 1800 });
  assert.equal(evaluate([capture(), branch]).reason, 'CORRECTION_CHAIN_INVALID');
});
test('bad transport, empty records, wrong period and publisher future dates never become NO', () => {
  for (const mutate of [(c:any) => c.complete = false, (c:any) => c.bytes++, (c:any) => c.body = '',
    (c:any) => c.finalUrl = 'https://untrusted.example.org', (c:any) => c.sha256 = '0'.repeat(64),
    (c:any) => c.contentType = 'text/html', (c:any) => c.fetchedAt = start - 1]) {
    const c = capture(); mutate(c); const result = evaluate([c]);
    assert.equal(result.status, 'unresolved'); assert.equal(result.outcome, undefined);
  }
  assert.deepEqual(evaluate([capture({ period: '2026-10' })]).issues, ['OBSERVATION_IDENTITY_MISMATCH']);
  assert.equal(evaluateSettlement(rule(), [capture()], { now: start + 7200, finalized: true }).reason, 'ALREADY_FINALIZED');
});
test('duplicate JSON keys, escaped duplicates and deeply nested payloads fail closed', () => {
  for (const duplicate of ['"value":"4.0",', '"v\\u0061lue":"4.0",']) {
    const c = capture(); c.body = '{' + duplicate + c.body.slice(1); c.bytes = Buffer.byteLength(c.body); c.sha256 = digest(c.body);
    assert.deepEqual(evaluate([c]).issues, ['EXTRACTION_DUPLICATE_FIELD']);
  }
  const c = capture(); c.body = '{"nested":' + '['.repeat(66) + '0' + ']'.repeat(66) + ',' + c.body.slice(1); c.bytes = Buffer.byteLength(c.body); c.sha256 = digest(c.body);
  assert.deepEqual(evaluate([c]).issues, ['EXTRACTION_TOO_DEEP']);
});
test('correction monitoring requires complete source coverage and post-cutoff retrieval', () => {
  const stale = capture(); stale.fetchedAt = start + 10;
  assert.equal(evaluate([stale]).reason, 'CORRECTION_MONITOR_STALE');
  const r = rule(); r.source.urls.push('https://data.example.org/releases/corrections.json');
  assert.equal(evaluate([capture()], start + 7200, r).reason, 'SOURCE_COVERAGE_MISSING');
  assert.equal(evaluate([capture(), capture({}, r.source.urls[1])], start + 7200, r).outcome, 2);
});
test('proposal archive seam binds the immutable rule and retains evidence-backed NO', async () => {
  const r = rule(), captures = [capture({ value: '4.0' })], records: any[] = [];
  const archive = { put: async (record: any) => { records.push(record); return { hash: '0x' + 'ab'.repeat(32), uri: 'https://example.org/evidence/1' }; } };
  const args = { rule: r, expectedRuleHash: settlementRuleHash(r), captures, now: start + 7200, archive, owner: 'fixture', draftHash: 'fixture' };
  const result = await archiveSettlementProposal(args);
  assert.equal(result.evidence.outcome, 1); assert.equal(records.length, 1);
  const { packet, packetHash } = JSON.parse(records[0].attachment);
  assert.equal(verifySettlementPacket(packet, { packetHash, expectedRuleHash: args.expectedRuleHash }).outcome, 1);
  packet.outcome = 2; assert.throws(() => verifySettlementPacket(packet, { packetHash, expectedRuleHash: args.expectedRuleHash }));
  await assert.rejects(archiveSettlementProposal({ ...args, expectedRuleHash: 'different' }));
  assert.equal((await archiveSettlementProposal({ ...args, captures: [] })).evidence, null);
  assert.equal(records.length, 1);
  const historical = replaySettlement(r, captures, { asOf: start + 7200, replayedAt: start + 9000 });
  assert.throws(() => verifySettlementPacket(historical.packet, { packetHash: historical.packetHash, expectedRuleHash: args.expectedRuleHash }));
});
test('large evidence packets need verified durable storage before the bounded archive is written', async () => {
  const r = rule(), c = capture();
  c.body = c.body.slice(0, -1) + ',"extra":"' + 'x'.repeat(15000) + '"}'; c.bytes = Buffer.byteLength(c.body); c.sha256 = digest(c.body);
  let writes = 0;
  const archive = { put: async (record:any) => { writes++; assert.ok(record.attachment.length <= 12000); return { hash: 'fixture', uri: 'https://example.org/fixture' }; } };
  const args = { rule: r, expectedRuleHash: settlementRuleHash(r), captures: [c], now: start + 7200, archive, owner: 'fixture', draftHash: 'fixture' };
  await assert.rejects(archiveSettlementProposal(args), /PACKET_STORE_REQUIRED/); assert.equal(writes, 0);
  let retained: any;
  const packetStore = { put: async (packet:any, sha256:string) => { retained = structuredClone(packet); return { sha256, uri: 'https://example.org/packets/' + sha256 }; }, get: async () => retained };
  assert.equal((await archiveSettlementProposal({ ...args, packetStore })).evidence.outcome, 2); assert.equal(writes, 1);
  await assert.rejects(archiveSettlementProposal({ ...args, packetStore: { ...packetStore, get: async () => ({ ...retained, outcome: 1 }) } }), /PACKET_BINDING_FAILED/);
  assert.equal(writes, 1);
});
test('general framework supports categorical and timestamp questions without Ethereum dependencies', () => {
  const category = rule(); category.decision = { type: 'category', operator: 'eq', value: 'home-win' };
  assert.equal(evaluate([capture({ value: 'home-win' })], start + 7200, category).outcome, 2);
  assert.equal(evaluate([capture({ value: 'away-win' })], start + 7200, category).outcome, 1);
  const time = rule(); time.decision = { type: 'timestamp', operator: 'lt', value: start + 300 };
  assert.equal(evaluate([capture({ value: start + 299 })], start + 7200, time).outcome, 2);
  assert.equal(evaluate([capture({ value: start + 300 })], start + 7200, time).outcome, 1);
});
test('bounded retriever rejects oversized first chunks, interrupted streams, redirects and malformed UTF-8', async () => {
  const request = (body: any, options: any = {}) => async () => new Response(body, { headers: { 'content-type': 'application/json' }, ...options });
  const valid = capture();
  assert.equal((await retrieveSettlementCapture(rule(), url, { request: request(valid.body), now: () => start + 10 })).sha256, valid.sha256);
  await assert.rejects(retrieveSettlementCapture(rule(), url, { request: request(new Uint8Array(2_000_001)) }), /TOO_LARGE/);
  await assert.rejects(retrieveSettlementCapture(rule(), url, { request: request('') }), /EMPTY/);
  await assert.rejects(retrieveSettlementCapture(rule(), url, { request: request(Uint8Array.from([0xff])) }), /ENCODING/);
  await assert.rejects(retrieveSettlementCapture(rule(), url, { request: request('', { status: 302 }) }), /FETCH_FAILED/);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); controller.error(Error('connection lost')); } });
  await assert.rejects(retrieveSettlementCapture(rule(), url, { request: request(stream) }), /connection lost/);
});
test('retriever rejects partial 200s and unencoded length mismatch and cancels oversized sources', async () => {
  const run = (body:string, headers:any) => retrieveSettlementCapture(rule(), url, { request: async () => new Response(body, { headers }) });
  await assert.rejects(run('partial', { 'content-range': 'bytes 0-6/50' }), /PARTIAL_RESPONSE/);
  await assert.rejects(run('partial', { 'content-length': '50' }), /LENGTH_MISMATCH/);
  await assert.rejects(run('partial', { 'content-length': '2' }), /LENGTH_MISMATCH/);
  await assert.rejects(run('partial', { 'content-length': '-1' }), /LENGTH_INVALID/);
  // fetch exposes decoded bytes for encoded bodies, so compressed Content-Length is not a decoded-length check.
  assert.equal((await run('decoded', { 'content-encoding': 'gzip', 'content-length': '50' })).bytes, 7);
  let cancelled = false, signal: AbortSignal | undefined;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); }, cancel() { cancelled = true; } });
  await assert.rejects(retrieveSettlementCapture(rule(), url, { request: async (_url:any, options:any) => { signal = options.signal; return new Response(body); } }), /TOO_LARGE/);
  assert.equal(cancelled, true); assert.equal(signal?.aborted, true);
});
test('official historical BLS and FOMC captures parse reproducibly, with retrospective labeling', async () => {
  const bls = JSON.parse(await readFile(new URL('./fixtures/settlement/bls-november-2025.json', import.meta.url), 'utf8'));
  const fed = JSON.parse(await readFile(new URL('./fixtures/settlement/fed-december-2025.json', import.meta.url), 'utf8'));
  const release = Date.parse('2025-12-16T13:30:00Z') / 1000;
  const r = rule(); r.source = { id: 'bls', publisher: 'Bureau of Labor Statistics', urls: [bls.requestedUrl], adapter: 'bls-employment-html.v1' };
  r.observation = { series: 'LNS14000000', period: '2025-11', unit: 'percent' };
  r.vintage = 'initial'; r.timing = { ...r.timing, scheduledAt: release - 11 * 86400, publicationCutoff: release + 3600, correctionCutoff: release + 3600, observationEndsAt: release + 3600 };
  assert.equal(parseSettlementCapture(r, bls, bls.fetchedAt).value, '4.6');
  assert.equal(parseSettlementCapture(r, bls, bls.fetchedAt).publishedAt, release);
  const replay = replaySettlement(r, [bls], { asOf: release + 3600, replayedAt: bls.fetchedAt });
  assert.equal(replay.outcome, 2); assert.equal(replay.liveSubmissionEligible, false);
  assert.equal(replay.packet.context, 'retrospective-replay');
  assert.equal(evaluateSettlement(r, [bls], { now: release + 3600 }).status, 'unresolved');
  const f = rule(); f.source = { id: 'federal-reserve', publisher: 'Federal Reserve Board', urls: [fed.requestedUrl], adapter: 'fomc-statement-html.v1' };
  f.observation = { series: 'announced-target-upper-bound', period: '2025-12-10', unit: 'percent' };
  const record = parseSettlementCapture(f, fed, fed.fetchedAt);
  assert.equal(record.value, '3.75'); assert.equal(record.publishedAt, Date.parse('2025-12-10T19:00:00Z') / 1000);
  // Synthetic markup mutations must fail instead of selecting another date in the page.
  const body = fed.body.replace(/(<p[^>]*class="article__time"[^>]*>)[\s\S]*?(<\/p>)/, '$1December 11, 2025$2');
  assert.notEqual(body, fed.body);
  assert.throws(() => parseSettlementCapture(f, { ...fed, body, bytes: Buffer.byteLength(body), sha256: digest(body) }, fed.fetchedAt), /IDENTITY_MISMATCH/);
  const mismatchedURL = structuredClone(f); mismatchedURL.source.urls = [fed.requestedUrl.replace('20251210', '20251211')];
  assert.throws(() => validateSettlementRule(mismatchedURL));
});
test('historical chain input is derived from checked evidence and cannot relabel or mutate ready packets', async () => {
  const report = await historicalSettlementReplay();
  const input = historicalChainInput(report);
  assert.deepEqual(input.short.events.map((event:any) => event.finalOutcome), [3, 2]);
  assert.deepEqual(input.long.events.map((event:any) => event.finalOutcome), [2, 2]);
  assert.equal(input.short.expectedPayout, 500000); assert.equal(input.long.expectedPayout, 1000000);
  assert.equal(input.long.events[0].evidenceHash, '0x' + report.policies[2].atObservationEnd.packetHash);
  assert.equal(input.long.events[1].ruleHash, '0x' + settlementRuleHash(report.fomc.packet.rule));
  assert.equal(input.short.actions.some((action:any) => action.kind === 1 && action.eventIndex === 0), false);
  const modified = structuredClone(report); modified.fomc.packet.measuredValue = '3.5';
  assert.throws(() => historicalChainInput(modified));
  const live = structuredClone(report); live.liveSubmissionEligible = true;
  assert.throws(() => historicalChainInput(live));
});
