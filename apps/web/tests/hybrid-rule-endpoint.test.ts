import test from 'node:test';
import assert from 'node:assert/strict';
import { localApi } from '../server/local-api.mjs';
import { hybridMarketService } from '../server/hybrid-market-service.mjs';
import { canonical, settlementRuleHash } from '../server/settlement-rules.mjs';
import { hybridRulesHash, prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { completedDraft } from './hybrid-reality-fixture.ts';

async function harness() {
  const { draft } = await completedDraft();
  const prepared = prepareHybridPilot(draft);
  const account = (digit: string) => `0x${digit.repeat(40)}`;
  const resolver = account('4');
  const catalog = { schema: 'flurbo.hybrid-catalog.v1', pools: [{ id: 'rule-test', pool: account('5'),
    resolver, rulesHash: hybridRulesHash(prepared, resolver), deploymentBlock: 100,
    keeper: account('8'), answerer: account('9'), prepared }] };
  const hybrid = hybridMarketService({ catalog, market: {}, source: {}, evidence: {},
    origin: 'https://example.org' });
  const api = localApi({ hybrid, store: { read: async () => null, command: async () => null } });
  async function request(path: string) {
    const req: any = { url: path, method: 'GET', headers: { host: 'localhost:18767' },
      async *[Symbol.asyncIterator]() {} };
    let status = 0, body: any, headers: any = {};
    const res: any = { writeHead: (value: number, h: any) => { status = value; headers = h || {}; },
      end: (value: string) => { body = value; }, setHeader: () => {} };
    await api(req, res, () => {});
    return { status, body, headers };
  }
  return { request, rule: draft.events[0].rule };
}

test('public rule endpoint serves the canonical rule without a login', async () => {
  const { request, rule } = await harness();
  const found = await request(`/api/hybrid/rules/0x${settlementRuleHash(rule)}`);
  assert.equal(found.status, 200);
  assert.equal(found.body, canonical(rule));
  assert.equal(found.headers['Content-Type'], 'application/json; charset=utf-8');
});

test('unknown, short and uppercase rule hashes return 404', async () => {
  const { request, rule } = await harness();
  const missing = await request(`/api/hybrid/rules/0x${'1'.repeat(64)}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'Rule unavailable' });
  assert.equal((await request(`/api/hybrid/rules/0x${settlementRuleHash(rule).toUpperCase()}`)).status, 404);
  assert.equal((await request('/api/hybrid/rules/0x1234')).status, 404);
});
