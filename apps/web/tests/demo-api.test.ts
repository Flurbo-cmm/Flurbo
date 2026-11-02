import test from 'node:test';
import assert from 'node:assert/strict';
import { localApi } from '../server/local-api.mjs';
import { demoApi, demoPoolList } from '../server/demo-api.mjs';

const live = `0x${'a'.repeat(40)}`, settled = `0x${'c'.repeat(40)}`, cond = `0x${'d'.repeat(40)}`, hidden = `0x${'b'.repeat(40)}`;
const owner = `0x${'e'.repeat(40)}`;
const question = (pool: string, eventIndex: number, title = 'Pool title') => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: title, eventIndex,
  question: `Question ${eventIndex + 1}`, route: 'reality', closesAt: 100, observationEndsAt: 200 });
const pools = [{ pool: live, kind: 'hybrid', role: 'live' }, { pool: settled, kind: 'hybrid', role: 'settled' },
  { pool: cond, kind: 'conditional', role: 'live' }] as const;

function services() {
  const calls: string[] = [];
  const hybrid = {
    list: () => [question(live, 0, 'Devcon Week'), question(live, 1, 'Devcon Week'), question(settled, 0, 'Settled pool'), question(hidden, 0, 'Hidden')],
    snapshot: async (id: string, wallet: unknown) => { calls.push(`snapshot ${id} ${wallet}`);
      return { schema: 'flurbo.hybrid-snapshot.v1', id, user: { wallet: owner, cashAtoms: '5' } }; },
    marketSummary: async (id: string) => { calls.push(`market ${id}`); return { id, prices: { yes: '1', no: '2' } }; },
    whatIf: async (id: string, input: any) => { calls.push(`what-if ${id} ${JSON.stringify(input)}`);
      if (input.fail) throw Error('request to https://secret.example/abc failed');
      if (input.bad) throw Error('Choose up to three assumptions');
      return { schema: 'flurbo.hybrid-what-if.v1', pool: live }; },
    prepare: async () => { calls.push('prepare'); return {}; },
  };
  const conditionals = {
    questions: {
      list: () => [question(cond, 0, 'France 2027'), question(cond, 1, 'France 2027')],
      snapshot: async (id: string, wallet: unknown) => { calls.push(`cond snapshot ${id} ${wallet}`); return { id }; },
      whatIf: async (id: string) => { calls.push(`cond what-if ${id}`); return { schema: 'flurbo.hybrid-what-if.v1' }; },
    },
    pool: async (pool: string) => { calls.push(`pool ${pool}`); return { pool }; },
    chances: async (pool: string, input: unknown) => { calls.push(`chances ${pool} ${JSON.stringify(input)}`); return { values: {} }; },
    quote: async () => { calls.push('quote'); return {}; },
    holdings: async () => { calls.push('holdings'); return {}; },
    prepare: async () => { calls.push('cond prepare'); return {}; },
  };
  const priceHistory = async (id: string) => { calls.push(`history ${id}`); return { points: [] }; };
  return { calls, hybrid, conditionals, priceHistory };
}

async function request(api: any, method: string, path: string, body?: unknown) {
  const req: any = { url: path, method,
    headers: { host: 'localhost:18767', origin: 'http://localhost:18767', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
  let status = 0, payload: any;
  const res: any = { writeHead: (value: number) => { status = value; }, end: (value: string) => { payload = JSON.parse(value); }, setHeader: () => {} };
  await api(req, res, () => {});
  return { status, payload };
}

function anonymousApi(extra: Record<string, unknown> = {}) {
  const s = services();
  const api = localApi({ hybrid: s.hybrid, conditionals: s.conditionals, demoPools: [...pools],
    store: { read: async () => null, command: async () => null } as any, ...extra });
  return { api, ...s };
}

test('the demo pool list accepts known pools and refuses anything else', () => {
  const catalogs = { hybrid: [{ pool: live.toUpperCase().replace('0X', '0x') }, { pool: settled }], conditional: [{ pool: cond }] };
  assert.deepEqual(demoPoolList(undefined, catalogs), []);
  assert.deepEqual(demoPoolList(null, catalogs), []);
  assert.deepEqual(demoPoolList({ schema: 'flurbo.demo-pools.v1', pools: [...pools] }, catalogs), [...pools]);
  for (const value of [
    { schema: 'other', pools: [] },
    { schema: 'flurbo.demo-pools.v1', pools: [{ pool: hidden, kind: 'hybrid', role: 'live' }] },
    { schema: 'flurbo.demo-pools.v1', pools: [{ pool: cond, kind: 'hybrid', role: 'live' }] },
    { schema: 'flurbo.demo-pools.v1', pools: [{ pool: live, kind: 'hybrid', role: 'trading' }] },
    { schema: 'flurbo.demo-pools.v1', pools: [{ pool: live, kind: 'hybrid', role: 'live', extra: true }] },
    { schema: 'flurbo.demo-pools.v1', pools: [{ pool: live, kind: 'hybrid', role: 'live' }, { pool: live, kind: 'hybrid', role: 'live' }] },
  ]) assert.throws(() => demoPoolList(value, catalogs), /Invalid demo pool list/);
});

test('an anonymous visitor reads the demo directory of listed pools only', async () => {
  const { api } = anonymousApi();
  const { status, payload } = await request(api, 'GET', '/api/demo');
  assert.equal(status, 200);
  assert.equal(payload.schema, 'flurbo.demo.v1');
  assert.deepEqual(payload.pools.map((p: any) => [p.pool, p.kind, p.role, p.title, p.questions.length]),
    [[live, 'hybrid', 'live', 'Devcon Week', 2], [settled, 'hybrid', 'settled', 'Settled pool', 1], [cond, 'conditional', 'live', 'France 2027', 2]]);
  assert.ok(!JSON.stringify(payload).includes(hidden));
});

test('a question snapshot is read without a wallet and never carries account data', async () => {
  const { api, calls } = anonymousApi();
  const result = await request(api, 'GET', `/api/demo/hybrid/${live}-1`);
  assert.equal(result.status, 200);
  assert.equal(result.payload.user, undefined);
  assert.deepEqual(calls, [`snapshot ${live}-1 null`]);
  assert.equal((await request(api, 'GET', `/api/demo/hybrid/${live}-1?wallet=${owner}`)).status, 400);
  const cond0 = await request(api, 'GET', `/api/demo/hybrid/${cond}-0`);
  assert.equal(cond0.status, 200);
  assert.ok(calls.includes(`cond snapshot ${cond}-0 null`));
});

test('pools that are not listed are not found and are never read', async () => {
  const { api, calls } = anonymousApi();
  for (const path of [`/api/demo/hybrid/${hidden}-0`, `/api/demo/hybrid/${hidden}-0/market`, `/api/demo/conditionals/${hidden}`,
    `/api/demo/conditionals/${live}`, `/api/demo/unknown`])
    assert.equal((await request(api, 'GET', path)).status, 404, path);
  assert.deepEqual(calls, []);
});

test('only read routes exist: no trade, holdings, quote or action route is reachable', async () => {
  const { api, calls } = anonymousApi();
  for (const [method, path] of [['POST', `/api/demo/hybrid/${live}-0/action`], ['POST', `/api/demo/hybrid/${live}-0/evidence`],
    ['GET', `/api/demo/conditionals/${cond}/holdings`], ['POST', `/api/demo/conditionals/${cond}/quote`],
    ['POST', `/api/demo/conditionals/${cond}/action`], ['POST', `/api/demo/hybrid/${live}-0/analysis`]])
    assert.equal((await request(api, method, path, {})).status, 404, `${method} ${path}`);
  assert.equal((await request(api, 'POST', `/api/demo/hybrid/${live}-0`, {})).status, 405);
  assert.equal((await request(api, 'GET', `/api/demo/hybrid/${live}-0/what-if`)).status, 405);
  assert.equal((await request(api, 'POST', `/api/demo/conditionals/${cond}`, {})).status, 405);
  assert.equal((await request(api, 'GET', `/api/demo/conditionals/${cond}/chances`)).status, 405);
  assert.deepEqual(calls.filter(call => /prepare|quote|holdings/.test(call)), []);
});

test('what if, market, price history and conditional chances answer for listed pools', async () => {
  const { api, calls } = anonymousApi({ store: { read: async () => null, command: async () => null } });
  assert.equal((await request(api, 'POST', `/api/demo/hybrid/${live}-0/what-if`, { given: [{ eventIndex: 0, side: 'yes' }] })).status, 200);
  assert.equal((await request(api, 'GET', `/api/demo/hybrid/${live}-0/market`)).status, 200);
  assert.equal((await request(api, 'POST', `/api/demo/hybrid/${cond}-0/what-if`, { given: [] })).status, 200);
  assert.equal((await request(api, 'GET', `/api/demo/conditionals/${cond}`)).status, 200);
  const legs = { condition: [{ eventIndex: 0, side: 'yes' }], target: [{ eventIndex: 1, side: 'yes' }] };
  assert.equal((await request(api, 'POST', `/api/demo/conditionals/${cond}/chances`, legs)).status, 200);
  assert.ok(calls.includes(`what-if ${live}-0 {"given":[{"eventIndex":0,"side":"yes"}]}`));
  assert.ok(calls.includes(`cond what-if ${cond}-0`));
  assert.ok(calls.includes(`pool ${cond}`));
  assert.ok(calls.includes(`chances ${cond} ${JSON.stringify(legs)}`));
});

test('validation messages pass through and unexpected failures stay generic', async () => {
  const { api } = anonymousApi();
  assert.deepEqual(await request(api, 'POST', `/api/demo/hybrid/${live}-0/what-if`, { bad: true }),
    { status: 400, payload: { error: 'Choose up to three assumptions' } });
  const failed = await request(api, 'POST', `/api/demo/hybrid/${live}-0/what-if`, { fail: true });
  assert.equal(failed.status, 400);
  assert.equal(failed.payload.error, 'Market request unavailable. Refresh and retry.');
});

test('reads are cached for the time to live, per path and per input', async () => {
  const s = services();
  let clock = 1_000_000;
  const demo = demoApi({ pools: [...pools], hybrid: s.hybrid, conditionals: s.conditionals, priceHistory: s.priceHistory, now: () => clock });
  const read = (method: string, path: string, input?: unknown) => demo.handle({ method, path, search: '', input });
  await read('GET', `/api/demo/hybrid/${live}-0`);
  await read('GET', `/api/demo/hybrid/${live}-0`);
  await read('POST', `/api/demo/hybrid/${live}-0/what-if`, { given: [] });
  await read('POST', `/api/demo/hybrid/${live}-0/what-if`, { given: [] });
  await read('POST', `/api/demo/hybrid/${live}-0/what-if`, { given: [{ eventIndex: 1, side: 'no' }] });
  await read('GET', `/api/demo/hybrid/${live}-0/price-history`);
  await read('GET', `/api/demo/hybrid/${live}-0/price-history`);
  assert.equal(s.calls.filter(call => call.startsWith('snapshot')).length, 1);
  assert.equal(s.calls.filter(call => call.startsWith('what-if')).length, 2);
  assert.equal(s.calls.filter(call => call.startsWith('history')).length, 1);
  clock += 30_001;
  await read('GET', `/api/demo/hybrid/${live}-0`);
  assert.equal(s.calls.filter(call => call.startsWith('snapshot')).length, 2);
});

test('a failed read is not cached', async () => {
  const s = services();
  const demo = demoApi({ pools: [...pools], hybrid: s.hybrid, conditionals: s.conditionals, priceHistory: s.priceHistory });
  await demo.handle({ method: 'POST', path: `/api/demo/hybrid/${live}-0/what-if`, search: '', input: { fail: true } });
  await demo.handle({ method: 'POST', path: `/api/demo/hybrid/${live}-0/what-if`, search: '', input: { fail: true } });
  assert.equal(s.calls.filter(call => call.startsWith('what-if')).length, 2);
});

test('price history without storage is unavailable, and the demo is off without a pool list', async () => {
  const s = services();
  const demo = demoApi({ pools: [...pools], hybrid: s.hybrid, conditionals: s.conditionals, priceHistory: null });
  assert.equal((await demo.handle({ method: 'GET', path: `/api/demo/hybrid/${live}-0/price-history`, search: '' })).status, 503);
  const api = localApi({ hybrid: s.hybrid, store: { read: async () => null, command: async () => null } as any });
  assert.equal((await request(api, 'GET', '/api/demo')).status, 404);
});

test('the signed-in hybrid routes still need an approved session', async () => {
  const { api } = anonymousApi();
  assert.equal((await request(api, 'GET', `/api/hybrid/${live}-0`)).status, 401);
  assert.equal((await request(api, 'GET', `/api/conditionals/${cond}`)).status, 401);
});

test('the committed demo pool list matches the committed catalogs', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (name: string) => JSON.parse(await readFile(new URL(`../../../config/${name}`, import.meta.url), 'utf8'));
  const [list, hybrid, conditional] = await Promise.all([read('demo-pools.json'), read('hybrid-markets.json'), read('conditional-markets.json')]);
  const result = demoPoolList(list, { hybrid: hybrid.pools, conditional: conditional.pools });
  assert.deepEqual(result.map(entry => [entry.kind, entry.role]), [['hybrid', 'live'], ['conditional', 'live'], ['hybrid', 'settled']]);
});
