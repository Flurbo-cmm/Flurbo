import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, validateSettlementRule } from '../server/settlement-rules.mjs';
import { evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture, verifySettlementPacket } from '../server/settlement-evidence.mjs';
import { exactDecimal, parseExactJSON } from '../server/settlement-readers.mjs';

const T0 = 1_791_000_000;
function rule(adapter: string, reader: any, over: any = {}) {
  return { schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Will the value be at least the threshold?',
    source: { id: 'source-1', publisher: 'Example publisher', urls: [over.url ?? 'https://data.example.org/value'], adapter, reader },
    observation: { series: 'example-series', period: '2026-09', unit: 'units' },
    decision: over.decision ?? { type: 'number', operator: 'gte', value: '4' },
    timing: { scheduledAt: over.scheduledAt ?? T0, publicationCutoff: T0 + 3600, correctionCutoff: T0 + 3600, observationEndsAt: T0 + 3600,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: over.vintage ?? 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
}
const capture = (r: any, body: string, contentType: string, fetchedAt = T0 + 30) => ({ requestedUrl: r.source.urls[0], finalUrl: r.source.urls[0], fetchedAt,
  status: 200, contentType, complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) });
const read = (r: any, body: string, type = 'application/json') => parseSettlementCapture(validateSettlementRule(r), capture(r, body, type), T0 + 60).value;
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };
const settle = (r: any, body: string, type = 'application/json', fetchedAt = T0 + 30) => evaluateSettlement(r, [capture(r, body, type, fetchedAt)], { now: T0 + 3600 });

test('exact JSON keeps decimals exact and refuses ambiguity', () => {
  assert.equal(exactDecimal('3.61230'), '3.6123'); assert.equal(exactDecimal('1.5e-3'), '0.0015'); assert.equal(exactDecimal('-2E2'), '-200');
  assert.equal(reason(() => parseExactJSON('{"a":1,"a":2}')), 'EXTRACTION_DUPLICATE_FIELD');
  assert.equal(reason(() => parseExactJSON('{"a":1}x')), 'EXTRACTION_INVALID_JSON');
  assert.equal(reason(() => exactDecimal('0.1234567890123456789')), 'VALUE_PRECISION_UNSUPPORTED');
});

test('json-api reads a value, counts, totals and single matches from any public JSON API', () => {
  const nbp = '{"table":"A","code":"USD","rates":[{"no":"190/A/NBP/2026","effectiveDate":"2026-09-30","mid":3.6123}]}';
  assert.equal(read(rule('json-api.v1', { select: '/rates/0/mid', aggregate: 'value', checks: [{ path: '/code', equals: 'USD' }] }), nbp), '3.6123');
  assert.equal(reason(() => read(rule('json-api.v1', { select: '/rates/0/mid', aggregate: 'value', checks: [{ path: '/code', equals: 'EUR' }] }), nbp)), 'OBSERVATION_IDENTITY_MISMATCH');
  const quakes = JSON.stringify({ type: 'FeatureCollection', features: [4.6, 3.1, 5.2, null, 4.5].map((mag, i) => ({ id: `q${i}`, properties: { mag, place: i === 2 ? 'Japan' : 'Chile' } })) });
  const count = (filter: any) => read(rule('json-api.v1', { select: '/features', aggregate: 'count', ...(filter ? { filter } : {}) }), quakes);
  assert.equal(count(null), '5'); assert.equal(count([{ path: '/properties/mag', op: 'gte', value: '4.5' }]), '3');
  assert.equal(count([{ path: '/properties/mag', op: 'gte', value: '4.5' }, { path: '/properties/place', op: 'eq', value: 'Japan' }]), '1');
  const total = (aggregate: string) => read(rule('json-api.v1', { select: '/features', aggregate, field: '/properties/mag', filter: [{ path: '/properties/mag', op: 'gt', value: '0' }] }), quakes);
  assert.deepEqual(['sum', 'max', 'min'].map(total), ['17.4', '5.2', '3.1']);
  const only = { select: '/features', aggregate: 'only', field: '/properties/mag', filter: [{ path: '/properties/place', op: 'eq', value: 'Chile' }] };
  assert.equal(reason(() => read(rule('json-api.v1', only), quakes)), 'EXTRACTION_AMBIGUOUS_OR_MISSING');
  assert.equal(read(rule('json-api.v1', { ...only, filter: [{ path: '/id', op: 'eq', value: 'q2' }] }), quakes), '5.2');
  // A missing value is not an answer: the capture is not retained and the bot keeps checking.
  assert.equal(reason(() => read(rule('json-api.v1', { select: '/features/3/properties/mag', aggregate: 'value' }), quakes)), 'VALUE_MISSING');
  assert.equal(reason(() => read(rule('json-api.v1', { select: '/rates/0/mid', aggregate: 'value' }), nbp, 'text/html')), 'CONTENT_TYPE_MISMATCH');
  assert.equal(read(rule('json-api.v1', { select: '/v', aggregate: 'value', scale: 6 }), '{"v":"3612300"}'), '3.6123');
});

test('a snapshot settles from the first retained capture; a release published before the window never settles', () => {
  const snapshot = rule('json-api.v1', { select: '/value', aggregate: 'value' });
  const ready: any = settle(snapshot, '{"value":4.25}');
  assert.equal(ready.status, 'ready'); assert.equal(ready.outcome, 2); assert.equal(ready.packet.measuredValue, '4.25');
  assert.equal(verifySettlementPacket(ready.packet, { packetHash: ready.packetHash, expectedRuleHash: ready.ruleHash }).status, 'ready');
  const initial = rule('json-api.v1', { select: '/value', aggregate: 'value', publishedAt: { path: '/released', format: 'iso-datetime' } }, { vintage: 'initial' });
  const before = new Date((T0 - 600) * 1000).toISOString(), after = new Date((T0 + 60) * 1000).toISOString();
  assert.equal(settle(initial, `{"value":3.9,"released":"${before}"}`, 'application/json', T0 + 120).reason, 'RELEASED_BEFORE_OBSERVATION_WINDOW');
  const released: any = settle(initial, `{"value":3.9,"released":"${after}"}`, 'application/json', T0 + 120);
  assert.equal(released.status, 'ready'); assert.equal(released.outcome, 1);
});

test('stat-table reads official statistics as CSV, SDMX-JSON and JSON-stat', () => {
  const fred = 'observation_date,CPIAUCSL\n2026-07-01,322.1\n2026-08-01,323.456\n2026-09-01,.\n';
  const csv = (period: string) => read(rule('stat-table.v1', { format: 'csv', select: { observation_date: period }, valueColumn: 'CPIAUCSL' }), fred, 'text/csv');
  assert.equal(csv('2026-08-01'), '323.456');
  assert.equal(reason(() => csv('2026-09-01')), 'VALUE_MISSING', 'not yet published');
  assert.equal(reason(() => csv('2026-10-01')), 'VALUE_MISSING');
  const quoted = 'country,"series name",value\r\n"Poland","CPI, all items","4.1"\r\nPoland,"CPI, all items",4.2\r\n';
  assert.equal(reason(() => read(rule('stat-table.v1', { format: 'csv', select: { country: 'Poland' }, valueColumn: 'value' }), quoted, 'text/csv')), 'EXTRACTION_AMBIGUOUS_OR_MISSING');
  assert.equal(read(rule('stat-table.v1', { format: 'csv', select: { 'series name': 'CPI, all items', value: '4.1' }, valueColumn: 'value' }), quoted, 'text/csv'), '4.1');
  const sdmx = JSON.stringify({ header: {}, dataSets: [{ series: { '0:1': { observations: { '0': [2.1], '1': [1.9], '2': [null] } } } }],
    structure: { dimensions: { series: [{ id: 'FREQ', values: [{ id: 'M' }] }, { id: 'REF_AREA', values: [{ id: 'DE' }, { id: 'U2' }] }],
      observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-07' }, { id: '2026-08' }, { id: '2026-09' }] }] } } }).replace('2.1', '2.10');
  const ecb = (period: string, select: any = { REF_AREA: 'U2' }) => read(rule('stat-table.v1', { format: 'sdmx-json', select, period }), sdmx, 'application/vnd.sdmx.data+json;version=1.0.0');
  assert.equal(ecb('2026-08'), '1.9'); assert.equal(reason(() => ecb('2026-09')), 'VALUE_MISSING');
  assert.equal(reason(() => ecb('2026-08', {})), 'SDMX_SERIES_AMBIGUOUS');
  const sdmx2 = JSON.stringify({ data: { dataSets: [{ series: { '0:0': { observations: { '0': [5] } } } }],
    structures: [{ dimensions: { series: [{ id: 'A', values: [{ id: 'x' }] }, { id: 'B', values: [{ id: 'y' }] }], observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026' }] }] } }] } });
  assert.equal(read(rule('stat-table.v1', { format: 'sdmx-json', select: {}, period: '2026' }), sdmx2), '5');
  const jsonStat = JSON.stringify({ version: '2.0', class: 'dataset', id: ['unit', 'geo', 'time'], size: [1, 2, 2],
    dimension: { unit: { category: { index: { RCH_A: 0 } } }, geo: { category: { index: { EA20: 0, DE: 1 } } }, time: { category: { index: ['2026-08', '2026-09'] } } },
    value: { '0': 2.2, '1': 2.0, '2': 1.9 } });
  const eurostat = (geo: string, time: string) => read(rule('stat-table.v1', { format: 'json-stat', select: { geo, time } }), jsonStat);
  assert.deepEqual([eurostat('EA20', '2026-08'), eurostat('EA20', '2026-09'), eurostat('DE', '2026-08')], ['2.2', '2', '1.9']);
  assert.equal(reason(() => eurostat('DE', '2026-09')), 'VALUE_MISSING');
});

test('html-text needs every anchor and exactly one match', () => {
  const page = '<html><body><h1>Monthly Report &ndash; September 2026</h1><p>The index rose to <b>1,234.5</b> points.</p><p>Released 2026-10-01</p></body></html>';
  const base = { anchors: ['Monthly Report - September 2026'], pattern: 'index rose to ([0-9,.]+) points', grouping: 'comma' };
  assert.equal(read(rule('html-text.v1', base), page, 'text/html; charset=utf-8'), '1234.5');
  assert.equal(reason(() => read(rule('html-text.v1', { ...base, anchors: ['August 2026'] }), page, 'text/html')), 'OBSERVATION_IDENTITY_MISMATCH');
  assert.equal(reason(() => read(rule('html-text.v1', { ...base, pattern: '(\\d)' }), page, 'text/html')), 'EXTRACTION_AMBIGUOUS_OR_MISSING');
  const category = rule('html-text.v1', { anchors: ['Monthly Report'], pattern: 'index (rose|fell) to' }, { decision: { type: 'category', operator: 'eq', value: 'rose' } });
  assert.equal(read(category, page, 'text/html'), 'rose');
});

test('reader settings are validated before any market can use them', () => {
  const bad = [
    ['json-api.v1', { select: 'no-slash', aggregate: 'value' }],
    ['json-api.v1', { select: '/a', aggregate: 'sum' }],
    ['json-api.v1', { select: '/a', aggregate: 'count', filter: [{ path: '/x', op: 'gt', value: 'abc' }] }],
    ['stat-table.v1', { format: 'csv', select: {}, valueColumn: 'v' }],
    ['stat-table.v1', { format: 'sdmx-json', select: {} }],
    ['html-text.v1', { anchors: ['Report'], pattern: '(\\d+)+x' }],
    ['html-text.v1', { anchors: ['Report'], pattern: 'no group' }],
    ['evm-rpc.v1', { chainId: 143, at: T0 - 60, metric: 'tx-count', finalitySeconds: 10 }],
    ['evm-rpc.v1', { chainId: 143, at: T0 - 60, metric: 'call', call: { to: '0x' + '1'.repeat(40), data: '0x1234', returns: 'uint256' }, finalitySeconds: 10 }],
  ];
  for (const [adapter, reader] of bad) assert.throws(() => validateSettlementRule(rule(adapter as string, reader)), undefined, JSON.stringify(reader));
  assert.throws(() => validateSettlementRule(rule('json-api.v1', { select: '/a', aggregate: 'value' }, { vintage: 'initial' })), /publication time/);
  assert.throws(() => validateSettlementRule(rule('evm-rpc.v1', { chainId: 143, at: T0 + 60, metric: 'balance', address: '0x' + '1'.repeat(40), finalitySeconds: 10 })), /after their observation time/);
  assert.throws(() => validateSettlementRule({ ...rule('json-api.v1', { select: '/a', aggregate: 'value' }), source: { ...rule('json-api.v1', {}).source, fields: {} } }));
});

// A small EVM chain: 0.4-second blocks, so several blocks share one timestamp second.
function chain({ start = T0 - 1000, height = 3000, chainId = 143 } = {}) {
  const ts = (n: number) => start + Math.floor(n * 0.4), txs = (n: number) => n % 7, h = (n: number) => '0x' + n.toString(16).padStart(64, '0'), x = (v: number | bigint) => '0x' + BigInt(v).toString(16);
  const block = (n: number) => n > height || n < 0 ? null : { number: x(n), timestamp: x(ts(n)), hash: h(n), parentHash: h(n - 1), gasUsed: x(1000 + n), gasLimit: x(30_000_000), baseFeePerGas: x(50), transactions: Array.from({ length: txs(n) }, (_, i) => h(n * 10 + i)) };
  let calls = 0;
  const request = async (_url: string, init: any) => {
    calls++;
    const { id, method, params } = JSON.parse(init.body);
    const n = (tag: string) => tag === 'latest' ? height : Number(BigInt(tag));
    const result = method === 'eth_chainId' ? x(chainId) : method === 'eth_getBlockByNumber' ? block(n(params[0]))
      : method === 'eth_getBlockTransactionCountByNumber' ? x(txs(n(params[0]))) : method === 'eth_getBalance' ? x(5n * 10n ** 18n + 25n * 10n ** 16n)
      : method === 'eth_getTransactionCount' ? x(42) : method === 'eth_call' ? '0x' + (123_456n * 10n ** 15n).toString(16).padStart(64, '0')
      : method === 'eth_getLogs' ? Array.from({ length: n(params[0].toBlock) - n(params[0].fromBlock) + 1 }, () => ({ removed: false })) : undefined;
    const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result }));
    return { status: 200, redirected: false, arrayBuffer: async () => bytes.buffer } as any;
  };
  const first = (target: number) => { let n = 0; while (ts(n) < target) n++; return n; };
  return { request, ts, txs, first, calls: () => calls };
}
const evm = (reader: any, over: any = {}) => rule('evm-rpc.v1', { chainId: 143, finalitySeconds: 30, ...reader }, { url: 'https://rpc.example.org/', scheduledAt: T0, ...over });

test('evm-rpc reads contract calls, balances, nonces and block fields at the first block at or after a time', async () => {
  const c = chain(), at = T0 - 500;
  const get = async (reader: any) => { const r = validateSettlementRule(evm({ at, ...reader })); const cap = await retrieveSettlementCapture(r, r.source.urls[0], { request: c.request, now: () => T0 + 30 }); return parseSettlementCapture(r, cap, T0 + 60).value; };
  assert.equal(await get({ metric: 'call', call: { to: '0x' + 'ab'.repeat(20), data: '0x18160ddd', returns: 'uint256' }, scale: 18 }), '123.456');
  assert.equal(await get({ metric: 'balance', address: '0x' + 'cd'.repeat(20), scale: 18 }), '5.25');
  assert.equal(await get({ metric: 'nonce', address: '0x' + 'cd'.repeat(20) }), '42');
  assert.equal(await get({ metric: 'block-field', field: 'transactions' }), String(c.txs(c.first(at))));
});

test('evm-rpc counts transactions and logs across a time range, and its evidence cannot be altered', async () => {
  const c = chain(), at = T0 - 800, until = T0 - 700;
  const B = c.first(at), E = c.first(until);
  let expected = 0; for (let n = B; n < E; n += 5) expected += c.txs(n);
  const r = validateSettlementRule(evm({ at, until, metric: 'tx-count', stride: 5 }));
  const cap = await retrieveSettlementCapture(r, r.source.urls[0], { request: c.request, now: () => T0 + 30 });
  const ready: any = evaluateSettlement(r, [cap], { now: T0 + 3600 });
  assert.equal(ready.status, 'ready'); assert.equal(ready.packet.measuredValue, String(expected));
  assert.equal(verifySettlementPacket(ready.packet, { packetHash: ready.packetHash, expectedRuleHash: ready.ruleHash }).status, 'ready');
  const logs = validateSettlementRule(evm({ at, until, metric: 'log-count', logs: { address: '0x' + 'ef'.repeat(20), topics: ['0x' + '1'.repeat(64), null] } }));
  const logCap = await retrieveSettlementCapture(logs, logs.source.urls[0], { request: c.request, now: () => T0 + 30 });
  assert.equal(parseSettlementCapture(logs, logCap, T0 + 60).value, String(E - B));
  // Changing any recorded response or boundary is detected.
  const tamper = (edit: (bundle: any) => void) => { const bundle = JSON.parse(cap.body); edit(bundle); const body = JSON.stringify(bundle); return reason(() => parseSettlementCapture(r, { ...cap, body, bytes: Buffer.byteLength(body), sha256: digest(body) }, T0 + 60)); };
  // exchanges: [0] chain ID, [1..2] blocks around the start, [3..4] blocks around the end, then the counts.
  assert.equal(tamper(b => { b.exchanges[2].response.result.timestamp = '0x1'; }), 'EVM_BOUNDARY_INVALID');
  assert.equal(tamper(b => { b.exchanges[1].response.result.number = '0x2'; }), 'EVM_BOUNDARY_INVALID');
  assert.equal(tamper(b => { b.exchanges.at(-1).response.result = '0xffff'; }), 'no error', 'a changed count parses but changes the packet hash');
  assert.equal(tamper(b => { b.exchanges.pop(); }), 'EVM_CAPTURE_INVALID');
  assert.equal(tamper(b => { b.chainId = 1; }), 'EVM_CAPTURE_INVALID');
});

test('evm-rpc waits for blocks that do not exist yet and for finality', async () => {
  const c = chain({ height: 100 }), future = rule('evm-rpc.v1', { chainId: 143, at: T0 + 1000, metric: 'nonce', address: '0x' + 'cd'.repeat(20), finalitySeconds: 30 }, { url: 'https://rpc.example.org/', scheduledAt: T0 + 1000 });
  await assert.rejects(retrieveSettlementCapture(validateSettlementRule(future), 'https://rpc.example.org/', { request: c.request, now: () => T0 }), (e: any) => e.reason === 'EVM_BLOCK_NOT_YET_AVAILABLE');
  const c2 = chain(), fresh = validateSettlementRule(evm({ at: T0 - 5, metric: 'nonce', address: '0x' + 'cd'.repeat(20), finalitySeconds: 600 }));
  const cap = await retrieveSettlementCapture(fresh, fresh.source.urls[0], { request: c2.request, now: () => T0 + 30 });
  assert.equal(reason(() => parseSettlementCapture(fresh, cap, T0 + 60)), 'EVM_NOT_FINAL');
  const wrong = chain({ chainId: 1 }), r = validateSettlementRule(evm({ at: T0 - 500, metric: 'nonce', address: '0x' + 'cd'.repeat(20) }));
  await assert.rejects(retrieveSettlementCapture(r, r.source.urls[0], { request: wrong.request, now: () => T0 + 30 }), (e: any) => e.reason === 'EVM_CHAIN_MISMATCH');
});

test('web readers ask for the right format', async () => {
  const seen: string[] = [];
  const request = async (_url: string, init: any) => { seen.push(init.headers.Accept); return new Response('a,b\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } }); };
  const r = validateSettlementRule(rule('stat-table.v1', { format: 'csv', select: { a: '1' }, valueColumn: 'b' }));
  const cap = await retrieveSettlementCapture(r, r.source.urls[0], { request: request as any, now: () => T0 + 5 });
  assert.equal(parseSettlementCapture(r, cap, T0 + 10).value, '2');
  assert.match(seen[0], /text\/csv/);
});

test('the rule check says whether a market would still be a prediction', async () => {
  const { checkRule } = await import('../scripts/check-settlement-rule.mjs');
  const request = async () => new Response('{"value":5}', { status: 200, headers: { 'content-type': 'application/json' } });
  const future = rule('json-api.v1', { select: '/value', aggregate: 'value' }, { scheduledAt: T0 + 600 });
  const reading = await checkRule(future, { now: T0, request: request as any });
  assert.equal(reading.status, 'ok'); assert.equal(reading.sources[0].result, 'current-reading', 'a snapshot rule is decided inside its window');
  const released = rule('json-api.v1', { select: '/value', aggregate: 'value', publishedAt: { path: '/at', format: 'unix-seconds' } }, { scheduledAt: T0 + 600, vintage: 'initial' });
  const known = async () => new Response(`{"value":5,"at":${T0 - 60}}`, { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal((await checkRule(released, { now: T0, request: known as any })).status, 'already-public', 'a release published before the window is a known answer');
  const missing = async () => new Response('{"other":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  const waiting = await checkRule(future, { now: T0, request: missing as any });
  assert.equal(waiting.status, 'ok'); assert.equal(waiting.sources[0].result, 'not-yet-available');
  assert.equal((await checkRule({ ...future, decision: { type: 'number', operator: 'gte', value: 'x' } }, { now: T0 })).status, 'invalid');
  const broken = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  assert.equal((await checkRule(future, { now: T0, request: broken as any })).status, 'source-error');
});

test('a snapshot of an interval must wait for late additions before its window opens', async () => {
  const { settlementRuleAuthoringIssues, assertSettlementRuleAuthoring, SNAPSHOT_SETTLE_SECONDS } = await import('../server/settlement-rules.mjs');
  const { checkRule } = await import('../scripts/check-settlement-rule.mjs');
  const end = T0 - SNAPSHOT_SETTLE_SECONDS, count = { select: '/features', aggregate: 'count' };
  const interval = (scheduledAt: number) => ({ ...rule('json-api.v1', count, { scheduledAt }),
    observation: { series: 'catalogue-count', period: `${new Date((end - 3600) * 1000).toISOString().replace('.000Z', 'Z')}/${new Date(end * 1000).toISOString().replace('.000Z', 'Z')}`, unit: 'events' } });
  assert.deepEqual(settlementRuleAuthoringIssues(interval(T0)), [], 'three hours after the interval is enough');
  const early = interval(end + 35 * 60);
  assert.match(settlementRuleAuthoringIssues(early)[0], /opens 35 minutes after .* at least 3 hours/);
  assert.throws(() => assertSettlementRuleAuthoring(early), /event-1: The capture window opens 35 minutes/);
  const report = await checkRule(early, { now: T0 - 7200 });
  assert.equal(report.status, 'invalid'); assert.match(report.message, /at least 3 hours/);
  // Existing pools still settle: the settlement validator itself is unchanged.
  assert.equal(validateSettlementRule(early).eventId, 'event-1');
  // Chain readers wait for finality instead, and a single dated release (not an interval) is not affected.
  const chain = { ...rule('evm-rpc.v1', { chainId: 143, at: end - 3600, until: end, metric: 'tx-count', stride: 25, finalitySeconds: 60 },
    { scheduledAt: end + 300, url: 'https://rpc.monad.xyz/' }), observation: { ...early.observation, unit: 'transactions' } };
  assert.deepEqual(settlementRuleAuthoringIssues(chain), []);
  assert.deepEqual(settlementRuleAuthoringIssues(rule('json-api.v1', { select: '/value', aggregate: 'value' }, { scheduledAt: T0 })), []);
});

test('a market can mix readers and still binds every rule on-chain', async () => {
  const { settlementEvent, validateSettlementPublication, settlementBindings } = await import('../server/settlement-publication.mjs');
  const close = T0 - 600;
  const rules = [rule('json-api.v1', { select: '/value', aggregate: 'value' }), { ...evm({ at: T0 - 300, metric: 'nonce', address: '0x' + 'cd'.repeat(20) }), eventId: 'event-2' },
    { ...rule('stat-table.v1', { format: 'csv', select: { date: '2026-09-01' }, valueColumn: 'v' }), eventId: 'event-3' }];
  const publication = { schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', creator: '0x' + '11'.repeat(20), rulesReviewed: true,
    reviewers: [1, 2, 3].map(i => ({ name: `R${i}`, address: '0x' + String(i).repeat(40) })), bondAtoms: '1000000', assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600,
    settlementRules: rules, draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: 'mixed', title: 'Mixed', closesAt: close,
      events: rules.map(settlementEvent), exceptionPolicy: null, disputeModel: 'reviewer-panel', disputePolicy: null } };
  assert.equal(validateSettlementPublication(publication).length, 3);
  const before = settlementBindings(publication).draftHash;
  publication.settlementRules[1] = { ...rules[1], source: { ...rules[1].source, reader: { ...rules[1].source.reader, finalitySeconds: 31 } } };
  assert.throws(() => validateSettlementPublication(publication), /committed draft event/, 'changing any reader setting breaks the on-chain commitment');
  assert.match(before, /^0x[0-9a-f]{64}$/);
});

test('evm-rpc retries a rate-limited public RPC instead of failing the capture', async () => {
  const c = chain(); let refused = 0;
  const flaky = async (url: string, init: any) => {
    if (JSON.parse(init.body).method === 'eth_getTransactionCount' && refused < 2) { refused++; return { status: 429, headers: new Headers({ 'retry-after': '0' }), body: null } as any; }
    return c.request(url, init);
  };
  const r = validateSettlementRule(evm({ at: T0 - 500, metric: 'nonce', address: '0x' + 'cd'.repeat(20) }));
  const cap = await retrieveSettlementCapture(r, r.source.urls[0], { request: flaky as any, now: () => T0 + 30 });
  assert.equal(refused, 2); assert.equal(parseSettlementCapture(r, cap, T0 + 60).value, '42');
});
