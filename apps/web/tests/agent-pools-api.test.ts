import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { localApi } from '../server/local-api.mjs';
import { DEFAULT_TESTING_OPERATOR } from '../server/testing-access.mjs';
import { poolFixture, pool, owner } from './pool-fixture.ts';

const approved = '0x' + 'ab'.repeat(20), pending = '0x' + 'cd'.repeat(20), host = 'localhost:18767';
const sessions: Record<string, { address: string; method: string }> = {
  approved: { address: approved, method: 'passkey' }, pending: { address: pending, method: 'passkey' },
  operator: { address: DEFAULT_TESTING_OPERATOR, method: 'passkey' } };
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

async function harness() {
  const f = poolFixture(), forwarded: string[] = [];
  // The upstream Monad RPC the namespace proxy forwards to.
  const upstream = createServer((req, res) => {
    let text = ''; req.on('data', c => text += c); req.on('end', () => {
      const call = JSON.parse(text); forwarded.push(call.method);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(call.method === 'eth_call' ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'execution reverted: secret detail' } } : { jsonrpc: '2.0', id: call.id, result: '0x279f' }));
    });
  });
  const upstreamPort = await listen(upstream);
  const agentPools = { collections: [{ namespace: f.namespace, label: 'Explicit test fixtures', pool, closesAt: f.manifest.publication.draft.closesAt }],
    services: new Map([[f.namespace, f.service]]),
    reservedAddresses: new Set([pool, f.manifest.resolver, f.record.prepared.proposer, f.record.prepared.relay]) };
  const evidenceHash = '0x' + 'ab'.repeat(32);
  const evidence = { get: async (hash: string) => { if (hash !== evidenceHash) throw Error('Evidence unavailable'); return '{"evidence":true}'; } };
  const store = { read: async (id: string) => sessions[id] ?? null };
  const api = localApi({ store, rpcUrl: `http://127.0.0.1:${upstreamPort}`, agentPools, evidence,
    previewAccess: { allows: (s: any) => s?.address === approved, applicationUrl: null } } as any);
  const server = createServer((req, res) => api(req, res, () => { res.writeHead(404); res.end(); }));
  const port = await listen(server);
  const call = (path: string, id = '', body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; data: any; headers: any }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { host, origin: `http://${host}`, 'content-type': 'application/json', cookie: 'flurbo_session=' + id } }, res => {
        let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode!, data: text ? JSON.parse(text) : null, headers: res.headers }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { f, agentPools, evidenceHash, call, forwarded, stop: async () => { await close(server); await close(upstream); } };
}

test('the market directory lists the agent pools under the v1 schema', async () => {
  const h = await harness();
  try {
    const directory = await h.call('/api/market-directory', 'approved');
    assert.equal(directory.status, 200);
    assert.equal(directory.data.schema, 'flurbo.market-directory.v1');
    assert.deepEqual(directory.data.markets, h.agentPools.collections);
    assert.ok(Array.isArray(directory.data.oracleMarkets)); assert.ok(Array.isArray(directory.data.hybridMarkets));
    assert.equal((await h.call('/api/market-directory')).status, 401);
    assert.equal((await h.call('/api/market-directory', 'pending')).status, 403);
  } finally { await h.stop(); }
});

test('the namespace RPC proxy is read-only, logged in and limited to served agent pools', async () => {
  const h = await harness(), ns = h.f.namespace;
  try {
    const chain = await h.call(`/api/${ns}/rpc`, 'approved', { method: 'eth_chainId', params: [] });
    assert.equal(chain.status, 200); assert.deepEqual(chain.data, { result: '0x279f' });
    assert.deepEqual(h.forwarded, ['eth_chainId']);
    const raw = await h.call(`/api/${ns}/rpc`, 'approved', { method: 'eth_sendRawTransaction', params: ['0x00'] });
    assert.equal(raw.status, 403); assert.equal(raw.data.error, 'Mera is account-only. Send transactions through MetaMask.');
    assert.equal((await h.call(`/api/${ns}/rpc`, 'approved', { method: 'eth_sign', params: [] })).status, 400);
    assert.equal((await h.call(`/api/${ns}/rpc`, 'approved', { method: 'eth_chainId' })).status, 400);
    const rejected = await h.call(`/api/${ns}/rpc`, 'approved', { method: 'eth_call', params: [{}, 'latest'] });
    assert.equal(rejected.status, 400); assert.equal(rejected.data.error, 'Monad rejected the request. Check tracking before retrying.');
    const unknown = await h.call(`/api/practice-${'99'.repeat(20)}/rpc`, 'approved', { method: 'eth_chainId', params: [] });
    assert.equal(unknown.status, 404); assert.equal(unknown.data.error, 'That market collection is not available.');
    assert.equal((await h.call(`/api/${ns}/rpc`, '', { method: 'eth_chainId', params: [] })).status, 401);
    assert.equal((await h.call(`/api/${ns}/rpc`, 'pending', { method: 'eth_chainId', params: [] })).status, 403);
    assert.deepEqual(h.forwarded, ['eth_chainId', 'eth_call']);
  } finally { await h.stop(); }
});

test('validate-trade answers a claim-bound assessment for the served pool', async () => {
  const h = await harness(), ns = h.f.namespace;
  try {
    const ok = await h.call(`/api/${ns}/validate-trade`, 'approved', { scope: 3, mask: '8', quantityAtoms: '1000000' });
    assert.equal(ok.status, 200); assert.equal(ok.data.mode, 'disabled'); assert.equal(ok.data.pool, pool);
    assert.equal(ok.data.scope, 3); assert.equal(ok.data.mask, '8');
    const bad = await h.call(`/api/${ns}/validate-trade`, 'approved', { scope: 3 });
    assert.equal(bad.status, 400); assert.equal(bad.data.code, 'INVALID_INPUT');
    assert.equal((await h.call(`/api/practice-${'99'.repeat(20)}/validate-trade`, 'approved', { scope: 3, mask: '8', quantityAtoms: '1' })).status, 404);
  } finally { await h.stop(); }
});

test('the agent pages read a served pool through GET markets', async () => {
  const h = await harness(), ns = h.f.namespace;
  try {
    const markets = await h.call(`/api/${ns}/markets`, 'approved');
    assert.equal(markets.status, 200); assert.equal(markets.data.manifest.pool, pool); assert.equal(markets.data.open, true);
    assert.equal(markets.data.prices.length, 2);
    assert.equal((await h.call(`/api/${ns}/markets`)).status, 401);
    const unknown = await h.call(`/api/practice-${'99'.repeat(20)}/markets`, 'approved');
    assert.equal(unknown.status, 404); assert.equal(unknown.data.error, 'That market collection is not available.');
  } finally { await h.stop(); }
});

test('every other pilot and namespace route is gone', async () => {
  const h = await harness(), ns = h.f.namespace;
  try {
    for (const [method, path] of [['GET', '/api/pilot/status'], ['GET', '/api/pilot/markets'], ['POST', '/api/pilot/prepare'], ['POST', '/api/pilot/rpc'],
      ['POST', '/api/pilot/validate-trade'], ['GET', `/api/${ns}/status`], ['GET', `/api/${ns}/account`], ['POST', `/api/${ns}/prepare`], ['POST', `/api/${ns}/positions`],
      ['POST', `/api/${ns}/history`], ['POST', `/api/${ns}/collected-payouts`], ['GET', `/api/${ns}/price-history`], ['POST', `/api/${ns}/analytics`],
      ['POST', `/api/${ns}/claim-analytics`], ['POST', `/api/${ns}/thesis`], ['POST', `/api/${ns}/evidence`], ['POST', `/api/${ns}/markets`],
      ['GET', `/api/practice-${'99'.repeat(20)}/status`], ['GET', '/api/practice-collections'], ['GET', '/api/evidence-beta']]) {
      const answer = await h.call(path, 'approved', method === 'POST' ? { owner, action: 'buy' } : undefined, method);
      assert.equal(answer.status, 404, `${method} ${path}`);
      assert.equal(answer.data.error, path === '/api/evidence-beta' ? 'Unknown workspace endpoint' : 'Unknown endpoint', `${method} ${path}`);
      assert.equal((await h.call(path, '', method === 'POST' ? {} : undefined, method)).status, 401, `anonymous ${method} ${path}`);
    }
  } finally { await h.stop(); }
});

test('published evidence stays public and immutable under both legacy paths', async () => {
  const h = await harness(), ns = h.f.namespace;
  try {
    for (const path of [`/api/pilot/evidence/${h.evidenceHash}`, `/api/${ns}/evidence/${h.evidenceHash}`]) {
      const answer = await h.call(path);
      assert.equal(answer.status, 200, path); assert.deepEqual(answer.data, { evidence: true });
      assert.equal(answer.headers['cache-control'], 'public, max-age=31536000, immutable');
    }
    assert.equal((await h.call(`/api/pilot/evidence/0x${'cd'.repeat(32)}`)).status, 503);
  } finally { await h.stop(); }
});

test('semantic status lists the agent pools for the testing operator', async () => {
  const h = await harness();
  try {
    const status = await h.call('/api/semantic-status', 'operator');
    assert.equal(status.status, 200); assert.deepEqual(status.data.markets.map((m: any) => m.namespace), [h.f.namespace]);
    assert.equal((await h.call('/api/semantic-status', 'approved')).status, 403);
  } finally { await h.stop(); }
});
