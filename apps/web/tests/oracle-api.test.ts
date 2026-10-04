import test from 'node:test';
import assert from 'node:assert/strict';
import { localApi } from '../server/local-api.mjs';

const owner = `0x${'a'.repeat(40)}`;
const hash = `0x${'b'.repeat(64)}`;

test('oracle actions and evidence use Flurbo login and origin gates', async () => {
  let logged = false, approved = false, prepared = 0;
  const now = Math.floor(Date.now() / 1000), archives = new Map<string, string[]>();
  const command = async (op: string, ...args: any[]) => {
    if (op === 'ZRANGE') return archives.get(args[0]) || [];
    if (op === 'EVAL') {
      const key = args[2], rows = archives.get(key) || [];
      if (!rows.length) rows.push(args[4]);
      archives.set(key, rows);
      return rows;
    }
    throw Error(`Unexpected ${op}`);
  };
  const oracle = {
    list: () => [{ id: 'oracle-poc-0', pool: owner, poolTitle: 'Test pool', eventIndex: 0, question: 'Did it happen?', closesAt: now + 3600, observationEndsAt: now + 7200 }],
    marketSummary: async () => ({ schema: 'flurbo.oracle-market.v1', id: 'oracle-poc-0', pool: owner,
      marketNow: now, blockNumber: '10', blockHash: hash, funded: true, resolved: false, prices: { yes: '500000', no: '500000' } }),
    snapshot: async () => ({ questionId: hash, finalized: false }),
    routeFor: () => ({ questionId: hash, pool: owner, eventHash: hash, publication: { closesAt: now + 3600 } }),
    prepare: async (_id: string, action: string, _input: unknown, from: string) => {
      prepared++;
      assert.equal(action, 'arbitrate');
      assert.equal(from, owner);
      return { action, transaction: { chainId: 11155111, from: owner, to: owner, data: '0x', value: '0x1' } };
    },
  };
  const oracleEvidenceStore = { get: async () => '{"name":"public evidence"}',
    put: async () => ({ hash, uri: `http://localhost:18767/api/oracle/evidence/${hash}` }) };
  const api = localApi({ oracle, oracleEvidenceStore,
    previewAccess: { allows: () => approved },
    store: { read: async () => logged ? { method: 'passkey', address: owner } : null, command } });
  async function request(path: string, method = 'GET', input?: unknown, origin = 'http://localhost:18767') {
    const req: any = { url: path, method,
      headers: { host: 'localhost:18767', origin, 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (input !== undefined) yield JSON.stringify(input); } };
    let status = 0, body: any;
    const res: any = { writeHead: (value: number) => { status = value; },
      end: (value: string) => { body = value.startsWith('{') ? JSON.parse(value) : value; },
      setHeader: () => {} };
    await api(req, res, () => {});
    return { status, body };
  }
  assert.equal((await request('/api/oracle/markets')).status, 401);
  logged = true;
  assert.equal((await request('/api/oracle/markets')).status, 403);
  approved = true;
  assert.equal((await request('/api/oracle/markets')).status, 200);
  assert.equal((await request('/api/market-directory')).body.oracleMarkets.length, 1);
  assert.equal((await request('/api/oracle/oracle-poc-0/market')).body.prices.yes, '500000');
  const history = await request('/api/oracle/oracle-poc-0/price-history');
  assert.equal(history.status, 200);
  assert.equal(history.body.points[0].prices[0].yes, '500000');
  assert.equal((await request('/api/oracle/oracle-poc-0')).body.questionId, hash);
  const action = { action: 'arbitrate', input: {}, owner };
  assert.equal((await request('/api/oracle/oracle-poc-0/action', 'POST', action,
    'https://another.example')).status, 403);
  assert.equal(prepared, 0);
  assert.equal((await request('/api/oracle/oracle-poc-0/action', 'POST', action)).body.transaction.chainId, 11155111);
  assert.equal(prepared, 1);
  assert.equal((await request('/api/oracle/evidence/' + hash)).body.name, 'public evidence');
});
