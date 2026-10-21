import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localApi } from '../server/local-api.mjs';
import { conditionalMarketService } from '../server/conditional-market-service.mjs';
import { hybridMarketService } from '../server/hybrid-market-service.mjs';
import { canonical, settlementRuleHash } from '../server/settlement-rules.mjs';
import { hybridRecord } from './hybrid-catalog-fixture.ts';

const owner = `0x${'a'.repeat(40)}`, pool = `0x${'5'.repeat(40)}`;
const host = 'localhost:18767', origin = 'http://localhost:18767';

function fakeConditionals(calls: string[]) {
  const record = (name: string) => async (...args: unknown[]) => { calls.push(name); return { name, args }; };
  return { status: () => 'available', list: record('list'), pool: record('pool'), chances: record('chances'),
    quote: record('quote'), prepare: record('prepare'), holdings: record('holdings'), ruleFor: () => { throw Error('none'); },
    questions: { snapshot: record('snapshot'), prepare: record('questionPrepare'), whatIf: record('whatIf') } };
}

async function call(api: any, path: string, { method = 'GET', body = undefined as unknown, requestOrigin = origin as string | null } = {}) {
  const headers: Record<string, string> = { host, 'content-type': 'application/json' };
  if (requestOrigin !== null) headers.origin = requestOrigin;
  const req: any = { url: path, method, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
  let status = 0, text = '';
  const res: any = { writeHead: (value: number) => { status = value; }, end: (value: string) => { text = value; }, setHeader: () => {} };
  await api(req, res, () => { status = 404; });
  return { status, body: text ? JSON.parse(text) : null, text };
}

const apiWith = ({ conditionals = null as any, session = { method: 'passkey', address: owner } as any, approved = true, hybrid = null as any } = {}) =>
  localApi({ conditionals, hybrid, previewAccess: { allows: async () => approved } as any,
    store: { read: async () => session, command: async () => null } as any });

test('conditional routes require a passkey session and approval', async () => {
  const calls: string[] = [];
  for (const path of ['/api/conditionals', `/api/conditionals/${pool}`, `/api/conditionals/${pool}/holdings?wallet=${owner}`]) {
    assert.equal((await call(apiWith({ conditionals: fakeConditionals(calls), session: null }), path)).status, 401, path);
    assert.equal((await call(apiWith({ conditionals: fakeConditionals(calls), session: { method: 'wallet', address: owner } }), path)).status, 401, path);
    assert.equal((await call(apiWith({ conditionals: fakeConditionals(calls), approved: false }), path)).status, 403, path);
  }
  assert.deepEqual(calls, []);
  const api = apiWith({ conditionals: fakeConditionals(calls) });
  assert.equal((await call(api, '/api/conditionals')).body.name, 'list');
  assert.deepEqual((await call(api, `/api/conditionals/${pool}`)).body, { name: 'pool', args: [pool] });
  assert.deepEqual((await call(api, `/api/conditionals/${pool}/holdings?wallet=${owner}`)).body, { name: 'holdings', args: [pool, owner] });
  const body = { condition: [{ eventIndex: 0, side: 'yes' }], target: [{ eventIndex: 1, side: 'yes' }] };
  assert.deepEqual((await call(api, `/api/conditionals/${pool}/chances`, { method: 'POST', body })).body, { name: 'chances', args: [pool, body] });
  assert.deepEqual((await call(api, `/api/conditionals/${pool}/quote`, { method: 'POST', body: { ...body, shares: '1000000', owner } })).body,
    { name: 'quote', args: [pool, { ...body, shares: '1000000', owner }, owner] });
  assert.deepEqual((await call(api, `/api/conditionals/${pool}/action`, { method: 'POST', body: { action: 'buy', input: body, owner } })).body,
    { name: 'prepare', args: [pool, 'buy', body, owner] });
  assert.equal((await call(api, `/api/conditionals/${pool}-1`)).body.name, 'snapshot');
  assert.equal((await call(api, `/api/conditionals/${pool}-1/action`, { method: 'POST', body: { action: 'quote', input: {}, owner } })).body.name, 'questionPrepare');
  assert.equal((await call(api, `/api/conditionals/${pool}-1/what-if`, { method: 'POST', body: { given: [] } })).body.name, 'whatIf');
  for (const [path, method] of [[`/api/conditionals/${pool}/chances`, 'GET'], [`/api/conditionals/${pool}`, 'POST'],
    ['/api/conditionals?x=1', 'GET'], [`/api/conditionals/${pool}/holdings?wallet=${owner}&x=1`, 'GET'],
    [`/api/conditionals/${pool}-32`, 'GET'], [`/api/conditionals/${pool}/other`, 'GET']] as const)
    assert.ok([400, 404, 405].includes((await call(api, path, { method, body: method === 'POST' ? {} : undefined })).status), `${method} ${path}`);
});

test('conditional POST routes require the same origin', async () => {
  const calls: string[] = [];
  const api = apiWith({ conditionals: fakeConditionals(calls) });
  for (const requestOrigin of [null, 'https://evil.example'])
    for (const op of ['chances', 'quote', 'action'])
      assert.equal((await call(api, `/api/conditionals/${pool}/${op}`, { method: 'POST', body: {}, requestOrigin })).status, 403, `${op} ${requestOrigin}`);
  assert.deepEqual(calls, []);
});

test('conditional routes answer 503 when no conditional pool is configured', async () => {
  const api = apiWith();
  assert.equal((await call(api, '/api/conditionals')).status, 503);
  assert.equal((await call(api, `/api/conditionals/${pool}/quote`, { method: 'POST', body: {} })).status, 503);
  const unavailable = fakeConditionals([]);
  unavailable.list = async () => { throw Error('Conditional markets are unavailable.'); };
  unavailable.quote = async () => { throw Error('request to https://secret.example/abc failed'); };
  unavailable.chances = async () => { throw Error('This conditional is too certain to buy'); };
  const failing = apiWith({ conditionals: unavailable });
  assert.equal((await call(failing, '/api/conditionals')).status, 503);
  assert.deepEqual((await call(failing, `/api/conditionals/${pool}/quote`, { method: 'POST', body: {} })).body,
    { error: 'Market request unavailable. Refresh and retry.' });
  assert.deepEqual((await call(failing, `/api/conditionals/${pool}/chances`, { method: 'POST', body: {} })).body,
    { error: 'This conditional is too certain to buy' });
});

test('the public rules route resolves a conditional pool rule', async () => {
  const record = { ...hybridRecord({ commissionBps: 500 }), id: 'cond-rules', conditionalVersion: 1 };
  const conditionals = conditionalMarketService({ catalog: { schema: 'flurbo.conditional-catalog.v1', pricer: `0x${'c'.repeat(40)}`, pools: [record] },
    market: {}, source: {}, evidence: {}, origin: 'https://example.org' });
  const other = { ...hybridRecord({ count: 3, pool: `0x${'6'.repeat(40)}` }), id: 'hybrid-rules' };
  const hybrid = hybridMarketService({ catalog: { schema: 'flurbo.hybrid-catalog.v1', pools: [other] }, market: {}, source: {},
    evidence: {}, origin: 'https://example.org' });
  const api = localApi({ hybrid, conditionals, store: { read: async () => null, command: async () => null } as any });
  const rule = (record.prepared as any).draft.events[0].rule;
  const found = await call(api, `/api/hybrid/rules/0x${settlementRuleHash(rule)}`, { requestOrigin: null });
  assert.equal(found.status, 200);
  assert.equal(found.text, canonical(rule));
  const hybridRule = (other.prepared as any).draft.events[2].rule;
  assert.equal((await call(api, `/api/hybrid/rules/0x${settlementRuleHash(hybridRule)}`, { requestOrigin: null })).text, canonical(hybridRule));
  assert.equal((await call(api, `/api/hybrid/rules/0x${'1'.repeat(64)}`, { requestOrigin: null })).status, 404);
  const alone = localApi({ conditionals, store: { read: async () => null, command: async () => null } as any });
  assert.equal((await call(alone, `/api/hybrid/rules/0x${settlementRuleHash(rule)}`, { requestOrigin: null })).status, 200);
});

test('the market directory is unchanged when conditional pools exist', async () => {
  const hybrid = { list: () => [{ id: `${pool}-0`, pool, question: 'Q' }] };
  const without = await call(apiWith({ hybrid }), '/api/market-directory');
  const withConditionals = await call(apiWith({ hybrid, conditionals: fakeConditionals([]) }), '/api/market-directory');
  assert.equal(without.status, 200);
  assert.deepEqual(withConditionals.body, without.body);
  assert.deepEqual(without.body.hybridMarkets, hybrid.list());
});
