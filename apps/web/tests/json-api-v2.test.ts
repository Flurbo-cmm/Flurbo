import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, validateSettlementRule } from '../server/settlement-rules.mjs';
import { evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture } from '../server/settlement-evidence.mjs';

const T0 = 1_791_000_000;
function rule(adapter: string, reader: any, over: any = {}) {
  return { schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Will the value be at least the threshold?',
    source: { id: 'source-1', publisher: 'Example publisher', urls: [over.url ?? 'https://data.example.org/value'], adapter, reader },
    observation: { series: 'example-series', period: '2026-09', unit: 'units' },
    decision: over.decision ?? { type: 'number', operator: 'gte', value: '4' },
    timing: { scheduledAt: T0, publicationCutoff: T0 + 3600, correctionCutoff: T0 + 3600, observationEndsAt: T0 + 3600, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: over.vintage ?? 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
}
const capture = (r: any, body: string, contentType: string, fetchedAt = T0 + 30) => ({ requestedUrl: r.source.urls[0], finalUrl: r.source.urls[0], fetchedAt,
  status: 200, contentType, complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) });
const read = (r: any, body: string, type = 'application/json') => parseSettlementCapture(validateSettlementRule(r), capture(r, body, type), T0 + 60).value;
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };
const v2 = (reader: any, over?: any) => rule('json-api.v2', reader, over);
const seconds = (text: string) => String(Date.parse(text) / 1000);

test('json-api.v2 reproduces every json-api.v1 reading', () => {
  const both = (reader: any, body: string, over?: any) => [read(rule('json-api.v1', reader, over), body), read(v2(reader, over), body)];
  const nbp = '{"table":"A","code":"USD","rates":[{"no":"190/A/NBP/2026","effectiveDate":"2026-09-30","mid":3.6123}]}';
  assert.deepEqual(both({ select: '/rates/0/mid', aggregate: 'value', checks: [{ path: '/code', equals: 'USD' }] }, nbp), ['3.6123', '3.6123']);
  assert.equal(reason(() => read(v2({ select: '/rates/0/mid', aggregate: 'value', checks: [{ path: '/code', equals: 'EUR' }] }), nbp)), 'OBSERVATION_IDENTITY_MISMATCH');
  const quakes = JSON.stringify({ type: 'FeatureCollection', features: [4.6, 3.1, 5.2, null, 4.5].map((mag, i) => ({ id: `q${i}`, properties: { mag, place: i === 2 ? 'Japan' : 'Chile' } })) });
  const count = (filter: any) => both({ select: '/features', aggregate: 'count', ...(filter ? { filter } : {}) }, quakes);
  assert.deepEqual(count(null), ['5', '5']);
  assert.deepEqual(count([{ path: '/properties/mag', op: 'gte', value: '4.5' }]), ['3', '3']);
  assert.deepEqual(count([{ path: '/properties/mag', op: 'gte', value: '4.5' }, { path: '/properties/place', op: 'eq', value: 'Japan' }]), ['1', '1']);
  for (const [aggregate, expected] of [['sum', '17.4'], ['max', '5.2'], ['min', '3.1']])
    assert.deepEqual(both({ select: '/features', aggregate, field: '/properties/mag', filter: [{ path: '/properties/mag', op: 'gt', value: '0' }] }, quakes), [expected, expected]);
  const only = { select: '/features', aggregate: 'only', field: '/properties/mag', filter: [{ path: '/properties/place', op: 'eq', value: 'Chile' }] };
  assert.equal(reason(() => read(v2(only), quakes)), 'EXTRACTION_AMBIGUOUS_OR_MISSING');
  assert.deepEqual(both({ ...only, filter: [{ path: '/id', op: 'eq', value: 'q2' }] }, quakes), ['5.2', '5.2']);
  assert.equal(reason(() => read(v2({ select: '/features/3/properties/mag', aggregate: 'value' }), quakes)), 'VALUE_MISSING');
  assert.equal(reason(() => read(v2({ select: '/rates/0/mid', aggregate: 'value' }), nbp, 'text/html')), 'CONTENT_TYPE_MISMATCH');
  assert.deepEqual(both({ select: '/v', aggregate: 'value', scale: 6 }, '{"v":"3612300"}'), ['3.6123', '3.6123']);
  assert.deepEqual(both({ select: '/features', aggregate: 'count', scale: 1 }, quakes), ['0.5', '0.5']);
  const category = { decision: { type: 'category', operator: 'eq', value: 'open' } };
  assert.deepEqual(both({ select: '/status', aggregate: 'value' }, '{"status":"open"}', category), ['open', 'open']);
  const initial = { select: '/value', aggregate: 'value', publishedAt: { path: '/released', format: 'iso-datetime' } };
  const released = new Date((T0 + 60) * 1000).toISOString(), body = `{"value":3.9,"released":"${released}"}`;
  const evaluate = (r: any) => evaluateSettlement(r, [capture(r, body, 'application/json', T0 + 120)], { now: T0 + 3600 }) as any;
  assert.equal(evaluate(v2(initial, { vintage: 'initial' })).outcome, evaluate(rule('json-api.v1', initial, { vintage: 'initial' })).outcome);
});

test('POST bodies reach the source exactly', async () => {
  const graphql = '{"query":"{ proposal(id:\\"0x1\\"){ state scores } }"}';
  const post = v2({ request: { method: 'POST', body: graphql }, select: '/data/proposal/scores/0', aggregate: 'value' }, { url: 'https://hub.example.org/graphql' });
  const seen: any[] = [];
  const request = async (url: string, init: any) => {
    seen.push({ url, init });
    return new Response('{"data":{"proposal":{"state":"closed","scores":[12.5,3]}}}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const got = await retrieveSettlementCapture(post, post.source.urls[0], { request: request as any, now: () => T0 + 30 });
  assert.equal(seen[0].init.method, 'POST'); assert.equal(seen[0].init.body, graphql);
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json'); assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.Accept, 'application/json');
  assert.equal(parseSettlementCapture(post, got, T0 + 60).value, '12.5');
});

test('GET readers send the same request as before', async () => {
  const seen: any[] = [];
  const request = async (_url: string, init: any) => { seen.push(init); return new Response('{"value":4}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  for (const adapter of ['json-api.v1', 'json-api.v2']) {
    const get = rule(adapter, { select: '/value', aggregate: 'value' });
    await retrieveSettlementCapture(get, get.source.urls[0], { request: request as any, now: () => T0 + 30 });
  }
  for (const init of seen) {
    assert.equal('method' in init, false); assert.equal('body' in init, false);
    assert.deepEqual(init.headers, { Accept: 'application/json', 'Cache-Control': 'no-cache' });
    assert.equal(init.redirect, 'error');
  }
});

test('derived values combine two selections exactly', () => {
  const body = '{"a":"10.5","b":0.25,"items":[{"v":1},{"v":2}]}';
  const derived = (op: string, extra: any = {}) => v2({ select: '/a', aggregate: 'value', derive: { op, select: '/b', aggregate: 'value' }, ...extra });
  assert.equal(read(derived('difference'), body), '10.25');
  assert.equal(read(derived('sum'), body), '10.75');
  assert.equal(read(derived('difference', { scale: 2 }), body), '0.1025');
  const lists = v2({ select: '/items', aggregate: 'sum', field: '/v', derive: { op: 'difference', select: '/items', aggregate: 'count' } });
  assert.equal(read(lists, body), '1');
  const negative = v2({ select: '/b', aggregate: 'value', derive: { op: 'difference', select: '/a', aggregate: 'value' } });
  assert.equal(read(negative, body), '-10.25');
  const cancel = v2({ select: '/a', aggregate: 'value', derive: { op: 'difference', select: '/a', aggregate: 'value' } });
  assert.equal(read(cancel, body), '0');
  assert.equal(reason(() => read(v2({ select: '/a', aggregate: 'value', derive: { op: 'sum', select: '/missing', aggregate: 'value' } }), body)), 'EXTRACTION_MISSING_FIELD');
});

test('time filters and contains count items in a window', () => {
  const feed = JSON.stringify({ items: [
    { title: 'Policy rate unchanged', published: 'Mon, 05 Oct 2026 10:00:00 GMT' },
    { title: 'Press release', published: 'Tue, 06 Oct 2026 12:30:00 +0000' },
    { title: 'Older note', published: 'Fri, 02 Oct 2026 09:00:00 GMT' },
    { title: 'Evening note', published: 'Wed, 07 Oct 2026 23:30:00 -0500' }] });
  const window = [{ path: '/published', op: 'gte', value: seconds('2026-10-05T00:00:00Z'), format: 'rfc-2822' },
    { path: '/published', op: 'lt', value: seconds('2026-10-07T00:00:00Z'), format: 'rfc-2822' }];
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: window }), feed), '2');
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: [{ path: '/title', op: 'contains', value: 'rate' }] }), feed), '1');
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: [...window, { path: '/title', op: 'contains', value: 'Press' }] }), feed), '1');
  const offset = [{ path: '/published', op: 'eq', value: seconds('2026-10-08T04:30:00Z'), format: 'rfc-2822' }];
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: offset }), feed), '1');
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: [{ path: '/at', op: 'gte', value: seconds('2026-10-01T00:00:00Z'), format: 'iso-datetime' }] }), JSON.stringify({ items: [{ at: '2026-10-05T10:00:00Z' }] })), '1');
  const missingOk = JSON.stringify({ items: [{ title: 'No date' }, { published: 'Mon, 05 Oct 2026 10:00:00 GMT' }] });
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: window }), missingOk), '1');
  const invalid = JSON.stringify({ items: [{ published: 'Mon, 31 Feb 2026 10:00:00 GMT' }] });
  assert.equal(reason(() => read(v2({ select: '/items', aggregate: 'count', filter: window }), invalid)), 'TIME_INVALID');
  for (const text of ['Oct 5 2026', '05 Oct 2026 10:00 PST', 'Mon, 05 Oct 2026 24:00:00 GMT', 'Mon, 05 Oct 2026 10:60:00 GMT', 'Mon, 05 Oct 2026 10:00:00 +2460', ''])
    assert.equal(reason(() => read(v2({ select: '/items', aggregate: 'count', filter: window }), JSON.stringify({ items: [{ published: text }] }))), 'TIME_INVALID', text);
  const noWeekday = JSON.stringify({ items: [{ published: '5 Oct 2026 10:00 GMT' }] });
  assert.equal(read(v2({ select: '/items', aggregate: 'count', filter: window }), noWeekday), '1');
  const stamp = v2({ select: '/published', aggregate: 'value', valueFormat: 'rfc-2822' }, { decision: { type: 'timestamp', operator: 'gte', value: 1 } });
  assert.equal(read(stamp, '{"published":"Mon, 05 Oct 2026 10:00:00 GMT"}'), Date.parse('2026-10-05T10:00:00Z') / 1000);
  const initial = v2({ select: '/value', aggregate: 'value', publishedAt: { path: '/released', format: 'rfc-2822' } }, { vintage: 'initial' });
  const body = '{"value":4,"released":"Thu, 15 Oct 2026 10:00:00 GMT"}';
  assert.equal(parseSettlementCapture(initial, capture(initial, body, 'application/json', Date.parse('2026-10-15T10:00:00Z') / 1000 + 5), Date.parse('2026-10-15T10:00:00Z') / 1000 + 10).publishedAt, Date.parse('2026-10-15T10:00:00Z') / 1000);
});

test('json-api.v2 settings are validated', () => {
  const base = { select: '/a', aggregate: 'value' };
  const bad: [string, any, any?][] = [
    ['mutation query', { ...base, request: { method: 'POST', body: '{"query":"mutation { x }"}' } }],
    ['indented mutation', { ...base, request: { method: 'POST', body: '{"query":"  Mutation Vote { x }"}' } }],
    ['GET request object', { ...base, request: { method: 'GET', body: '{}' } }],
    ['POST without a body', { ...base, request: { method: 'POST' } }],
    ['body that is not an object', { ...base, request: { method: 'POST', body: '[1]' } }],
    ['body with a repeated key', { ...base, request: { method: 'POST', body: '{"a":1,"a":2}' } }],
    ['body that is not JSON', { ...base, request: { method: 'POST', body: 'query' } }],
    ['oversized body', { ...base, request: { method: 'POST', body: JSON.stringify({ q: 'x'.repeat(4000) }) } }],
    ['GET with body', { ...base, body: '{}' }],
    ['derive with a category decision', { ...base, derive: { op: 'sum', select: '/b', aggregate: 'value' } }, { decision: { type: 'category', operator: 'eq', value: 'a' } }],
    ['derive with another op', { ...base, derive: { op: 'product', select: '/b', aggregate: 'value' } }],
    ['derive without a selection', { ...base, derive: { op: 'sum', aggregate: 'value' } }],
    ['derive with an unknown key', { ...base, derive: { op: 'sum', select: '/b', aggregate: 'value', scale: 1 } }],
    ['derive that sums without a field', { ...base, derive: { op: 'sum', select: '/b', aggregate: 'sum' } }],
    ['format with a non-integer value', { select: '/a', aggregate: 'count', filter: [{ path: '/t', op: 'gte', value: '1.5', format: 'unix-seconds' }] }],
    ['format with an unknown format', { select: '/a', aggregate: 'count', filter: [{ path: '/t', op: 'gte', value: '1', format: 'rfc-3339' }] }],
    ['contains with format', { select: '/a', aggregate: 'count', filter: [{ path: '/t', op: 'contains', value: '1', format: 'unix-seconds' }] }],
    ['ordered op with text', { select: '/a', aggregate: 'count', filter: [{ path: '/t', op: 'gt', value: 'abc' }] }],
    ['unknown filter key', { select: '/a', aggregate: 'count', filter: [{ path: '/t', op: 'eq', value: 'x', extra: 1 }] }],
    ['unknown reader key', { ...base, parser: 'x' }],
    ['unknown publication format', { ...base, publishedAt: { path: '/p', format: 'rfc-3339' } }, { vintage: 'initial' }],
  ];
  assert.doesNotThrow(() => validateSettlementRule(v2({ ...base, request: { method: 'POST', body: '{"query":"{ x }"}' } })));
  assert.doesNotThrow(() => validateSettlementRule(v2({ ...base, derive: { op: 'difference', select: '/b', aggregate: 'value' } })));
  for (const [label, reader, over] of bad) assert.throws(() => validateSettlementRule(v2(reader, over)), undefined, label);
  assert.throws(() => validateSettlementRule(v2({ select: '/a', aggregate: 'value', valueFormat: 'rfc-2822' })), /Timestamp values need a value format/);
  assert.throws(() => validateSettlementRule(rule('json-api.v1', { select: '/a', aggregate: 'value', valueFormat: 'rfc-2822' }, { decision: { type: 'timestamp', operator: 'gte', value: 1 } })), /Timestamp values need a value format/);
});
