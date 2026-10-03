import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, fixtureTransport, FIXTURE_NAMESPACE, FlurboError, type Transport, type HttpRequest } from '../src/index.ts';
import { browserTransport } from '../src/transport-browser.ts';

const scripted = (responses: (Partial<{ status: number; body: unknown; retryAfter: string | null }> | Error | 'hang')[]) => {
  const calls: HttpRequest[] = [];
  const transport: Transport = { kind: 'live', async send(request) {
    calls.push(request);
    const next = responses.shift();
    if (next === 'hang') return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (next instanceof Error) throw next;
    return { status: next?.status ?? 200, body: next?.body ?? {}, retryAfter: next?.retryAfter ?? null };
  } };
  return { transport, calls };
};
const code = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { return (e as FlurboError).code; } return 'no-error'; };
const noSleep = async () => {};
const directory = { schema: 'flurbo.market-directory.v1', markets: [] };

test('status codes map to typed errors, including invite rejection, without leaking upstream detail', async () => {
  for (const [status, body, expected] of [[401, {}, 'unauthenticated'], [403, { code: 'INVITE_REQUIRED', error: 'x' }, 'invite_required'], [403, {}, 'forbidden'],
    [404, {}, 'not_found'], [409, {}, 'conflict'], [400, {}, 'invalid_input']] as const) {
    const { transport } = scripted([{ status, body }]);
    assert.equal(await code(() => createClient({ transport, sleep: noSleep }).directory()), expected);
  }
  const long = { error: 'x'.repeat(400) };
  const { transport } = scripted([{ status: 400, body: long }]);
  try { await createClient({ transport }).directory(); } catch (e) { assert.equal((e as Error).message, 'The request was rejected.'); }
});

test('reads retry a bounded number of times and honour Retry-After; mutations never retry', async () => {
  const waits: number[] = [], sleep = async (ms: number) => { waits.push(ms); };
  const ok = scripted([{ status: 503 }, { status: 429, retryAfter: '3' }, { status: 200, body: directory }]);
  assert.deepEqual(await createClient({ transport: ok.transport, sleep }).directory(), []);
  assert.equal(ok.calls.length, 3); assert.ok(waits[0] >= 250 && waits[0] < 400); assert.equal(waits[1], 3000);
  const exhausted = scripted([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
  assert.equal(await code(() => createClient({ transport: exhausted.transport, sleep: noSleep }).directory()), 'unavailable');
  assert.equal(exhausted.calls.length, 3);
  const mutation = scripted([{ status: 503 }, { status: 200 }]);
  assert.equal(await code(() => createClient({ transport: mutation.transport, sleep: noSleep }).agents.create({ name: 'x' })), 'unavailable');
  assert.equal(mutation.calls.length, 1, 'a lost response must not create a duplicate record');
  const network = scripted([new Error('socket'), { status: 200, body: directory }]);
  assert.deepEqual(await createClient({ transport: network.transport, sleep: noSleep }).directory(), []);
});

test('timeouts and cancellation surface as typed errors', async () => {
  const slow = scripted(['hang']);
  assert.equal(await code(() => createClient({ transport: slow.transport, timeoutMs: 20, readRetries: 0 }).directory()), 'timeout');
  const controller = new AbortController(), cancelled = scripted(['hang']);
  const pending = createClient({ transport: cancelled.transport, readRetries: 3, sleep: noSleep }).directory(controller.signal);
  controller.abort();
  assert.equal(await code(() => pending), 'aborted');
  assert.equal(cancelled.calls.length, 1, 'cancellation is not retried');
});

test('malformed responses are rejected at runtime; fixture mode is always labelled', async () => {
  const { transport } = scripted([{ status: 200, body: { schema: 'something-else', markets: [] } }]);
  assert.equal(await code(() => createClient({ transport }).directory()), 'invalid_response');
  const wrongPool = scripted([{ status: 200, body: { manifest: { chainId: 10143, pool: '0x' + '77'.repeat(20), publication: { draft: { events: [] } } }, open: true, resolved: false, prices: [] } }]);
  assert.equal(await code(() => createClient({ transport: wrongPool.transport }).market(`practice-${'22'.repeat(20)}`)), 'cross_pool');
  const fixture = createClient({ transport: fixtureTransport() });
  assert.equal(fixture.mode, 'fixture');
  const [entry] = await fixture.directory();
  assert.match(entry.label, /not live/);
  assert.match((await fixture.market(FIXTURE_NAMESPACE)).title, /not live/);
  assert.equal(await code(() => fixture.agents.list()), 'not_found', 'fixture mode never pretends to have account data');
  assert.equal(await code(() => fixture.market('arbitrary' as never)), 'invalid_input');
});

test('the browser transport sends same-origin requests and never handles credentials itself', async () => {
  const seen: { url: string; init: Record<string, unknown> }[] = [];
  const transport = browserTransport({ fetch: async (url, init) => { seen.push({ url, init: init as unknown as Record<string, unknown> });
    return { status: 200, headers: { get: () => null }, json: async () => directory }; } });
  await createClient({ transport }).directory();
  assert.equal(seen[0].url, '/api/market-directory');
  assert.equal(seen[0].init.credentials, 'same-origin');
  assert.equal(JSON.stringify(seen[0].init).includes('Authorization'), false);
});
