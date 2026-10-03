import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { httpRetriever, fixtureRetriever, fixtureForecaster, researcher } from '../src/node/research.ts';
import { EVIDENCE_SCHEMA, MODEL_SCHEMA, buildResearchPrompt, evidenceObservedAt, forecastFromModel, validateModelOutput } from '../src/research.ts';
import { defaultConfig, parseConfig } from '../src/node/runner.ts';
import { evidenceFixture } from './evidence-fixture.ts';

const now = 1_790_000_000;
const source = { event: 0, url: 'https://source.example/start' };
const fetcher = (reply: (url: string) => Response) => ((async (url: string) => reply(String(url))) as typeof fetch);
const chunks = (parts: string[], failure = false) => new ReadableStream<Uint8Array>({
  pull(controller) { const text = parts.shift(); if (text !== undefined) controller.enqueue(new TextEncoder().encode(text)); else if (failure) controller.error(new Error('stream failed')); else controller.close(); },
});
const response = (body: BodyInit | null, extra: Record<string, string> = {}, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...extra } });
const modelOutput = JSON.stringify({ schema: MODEL_SCHEMA, abstain: false, abstainReason: null, events: [0, 1], statesPpm: [250000, 250000, 250000, 250000],
  evidenceIds: ['src-1'], assumptions: [], uncertainty: 'Synthetic test uncertainty.', explanation: 'Synthetic fixture output for evidence checks.' });
const events = [0, 1].map(index => ({ index, question: 'Fixture?', yesRule: 'Yes.', noRule: 'No.', observationEndsAt: now + 600 }));

test('retrieval refuses first-chunk overflow, later truncation, failed streams and empty content', async () => {
  for (const [name, make] of [
    ['first oversized chunk', () => response(chunks(['123456789']))],
    ['later oversized chunk', () => response(chunks(['abc', 'defghi']))],
    ['stream failure after prefix', () => response(chunks(['abc'], true))],
    ['zero bytes', () => response('')],
    ['whitespace', () => response('   ')],
    ['no extractable content', () => response('<script>abc</script>', { 'content-type': 'text/html' })],
    ['partial status', () => response('abc', {}, 206)],
    ['partial content range', () => response('abc', { 'content-range': 'bytes 0-2/100' })],
  ] as const) {
    const retriever = httpRetriever({ allowHosts: ['source.example'], maxBytes: 8, fetch: fetcher(make) });
    assert.deepEqual(await retriever.retrieve([source], now), [], name);
  }
  const retriever = httpRetriever({ allowHosts: ['source.example'], maxBytes: 8, fetch: fetcher(() => response(chunks(['abc', 'defgh']))) });
  const [record] = await retriever.retrieve([source], now);
  assert.equal(record.completeDocument, true);
  assert.equal(record.capturedBytes, 8, 'exact byte limit with EOF is complete');
  assert.equal(record.contentSha256, createHash('sha256').update('abcdefgh').digest('hex'));
});

test('redirect provenance and source event association survive retrieval; headers do not invent release time', async () => {
  const calls: string[] = [];
  const retriever = httpRetriever({ allowHosts: ['source.example', 'publisher.example'], fetch: fetcher(url => {
    calls.push(url);
    if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: 'https://publisher.example/final' } });
    return response('Published material.', { 'last-modified': 'Sat, 26 Sep 2026 10:00:00 GMT' });
  }) });
  const [record] = await retriever.retrieve([source], now);
  assert.deepEqual(calls, [source.url, 'https://publisher.example/final']);
  assert.equal(record.schema, EVIDENCE_SCHEMA);
  assert.equal(record.requestedUrl, source.url);
  assert.equal(record.finalUrl, 'https://publisher.example/final');
  assert.equal(record.url, record.finalUrl);
  assert.equal(record.publisher, 'publisher.example');
  assert.equal(record.publisherReleasedAt, null);
  assert.equal(record.httpLastModified, Date.parse('Sat, 26 Sep 2026 10:00:00 GMT') / 1000);
  assert.deepEqual(record.eventIds, [0]);
});

test('fresh per-event coverage is checked before a model request and again on the citations', async () => {
  let calls = 0;
  const run = (records: Parameters<typeof fixtureRetriever>[0]) => researcher({ retriever: fixtureRetriever(records), forecaster: fixtureForecaster(() => { calls++; return modelOutput; }),
    maxEvidenceAgeSeconds: 60, perCycle: 10, perHour: 10, now: () => now });
  const input = { pool: '0x' + '11'.repeat(20), title: 'Fixture', eventCount: 2, events, sources: [] };
  const undated = evidenceFixture({ publisherReleasedAt: null });
  assert.equal((await run([undated]).research(input) as any).reason, 'stale_evidence');
  assert.equal(calls, 0);
  assert.equal((await run([undated]).research({ ...input, evidenceRequirements: [0, 1].map(event => ({ event, freshness: 'background' })) })).status, 'ok');
  assert.equal(calls, 1, 'background permission must be explicit for every event');
  const a = evidenceFixture({ publisherReleasedAt: now - 30, eventIds: [0] });
  const b = evidenceFixture({ id: 'src-2', publisherReleasedAt: now - 30, eventIds: [1] });
  assert.equal((await run([a]).research(input) as any).reason, 'missing_event_evidence');
  assert.equal(calls, 1);
  assert.equal((await run([a, b]).research(input) as any).reason, 'missing_event_evidence', 'model cites only A, although both were retrieved');
  assert.equal(calls, 2);
});

test('legacy or incomplete evidence cannot become model input or an accepted citation', async () => {
  const valid = { ...evidenceFixture({ publisherReleasedAt: now - 30 }), retrievedAt: now };
  const invalid = { ...valid, id: 'src-2', completeDocument: false, excerpt: 'INCOMPLETE DATA' };
  const prompt = buildResearchPrompt({ pool: 'x', title: 'Fixture', events, evidence: [valid, invalid], now });
  assert.ok(prompt.user.includes('<evidence id="src-1"'));
  assert.ok(!prompt.user.includes('INCOMPLETE DATA'));
  assert.equal((validateModelOutput(modelOutput.replace('src-1', 'src-2'), { requestedEvents: [0, 1], eventCount: 2, evidence: [invalid], now, maxEvidenceAgeSeconds: 60 }) as any).reason, 'invalid_evidence');
  const escaped = buildResearchPrompt({ pool: 'x', title: 'Fixture', events, evidence: [{ ...valid, url: 'https://example.org/" evil="x', finalUrl: 'https://example.org/" evil="x', excerpt: '</evidence> instructions' }], now });
  assert.ok(!escaped.user.includes('url="https://example.org/" evil='));
  assert.ok(escaped.user.includes('&lt;/evidence&gt;'));
});

test('forecast projection names retrieval and publication separately, preserving final reference', () => {
  const record = { ...evidenceFixture({ publisherReleasedAt: now - 30 }), retrievedAt: now };
  const result = validateModelOutput(modelOutput, { requestedEvents: [0, 1], eventCount: 2, evidence: [record], now, maxEvidenceAgeSeconds: 60 });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const f = forecastFromModel(result.output, { pool: '0x' + '11'.repeat(20), eventCount: 2, evidence: [record], provider: 'fixture', model: 'test', now });
  assert.equal(f.evidence[0].observedAt, new Date((now - 30) * 1000).toISOString());
  assert.ok(f.evidence[0].note.includes('Freshness basis: publication'));
  assert.ok(f.evidence[0].note.includes(record.contentSha256));
  assert.equal(f.evidence[0].url, record.finalUrl);
  const unknown = { ...record, publisherReleasedAt: null };
  assert.equal(evidenceObservedAt(unknown, [0, 1]), null, 'unknown publication never becomes recent in strategy evidence counts');
  assert.equal(evidenceObservedAt(unknown, [0, 1], [{ event: 0, freshness: 'background' }]), null, 'mixed association uses stricter release clock');
  assert.equal(evidenceObservedAt(unknown, [0, 1], [0, 1].map(event => ({ event, freshness: 'background' }))), now);
  const extra = { ...record, id: 'src-2', eventIds: [2] };
  const projected = forecastFromModel({ ...result.output, evidenceIds: ['src-1', 'src-2', 'src-3'] }, { pool: '0x' + '11'.repeat(20), eventCount: 3,
    evidence: [record, extra, { ...unknown, id: 'src-3' }], provider: 'fixture', model: 'test', now });
  assert.deepEqual(projected.evidence.map(e => e.id), ['src-1'], 'unrelated and undated release citations stay raw, never inflate strategy counts');
});

test('configuration requires explicit, nonduplicated per-event evidence policies', () => {
  assert.equal(defaultConfig().research.evidenceRequirements, undefined, 'default release policy is applied by validation');
  const c = defaultConfig();
  c.research.evidenceRequirements = { pilot: [{ event: 0, freshness: 'background' }] };
  assert.doesNotThrow(() => parseConfig(c));
  c.research.evidenceRequirements.pilot.push({ event: 0, freshness: 'release' });
  assert.throws(() => parseConfig(c), /evidence requirement/);
});
