import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localApi } from '../server/local-api.mjs';
import { HYBRID_PORTFOLIO_INPUT_ERRORS } from '../server/hybrid-portfolio.mjs';

const owner = '0x' + 'a'.repeat(40), pool = '0x' + 'A'.repeat(40);

async function call(hybridPortfolio: any, method: string, path: string, input?: unknown, session: any = { method: 'passkey', address: owner }) {
  const api = localApi({ ...(hybridPortfolio ? { hybridPortfolio } : {}), store: { read: async () => session, command: async () => null } as any });
  const req: any = { url: `/api/hybrid/pool/${pool}/${path}`, method,
    headers: { host: 'localhost:18767', origin: 'http://localhost:18767', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (input !== undefined) yield JSON.stringify(input); } };
  let status = 0, body: any;
  const res: any = { writeHead: (value: number) => { status = value; }, end: (value: string) => { body = JSON.parse(value); }, setHeader: () => {} };
  await api(req, res, () => {});
  return { status, body };
}
const ok = { account: async () => ({ ok: 'account' }), positions: async () => ({ ok: 'positions' }),
  history: async () => ({ ok: 'history' }), payouts: async () => ({ ok: 'payouts' }) };

test('pool portfolio routes need a passkey session and a configured service', async () => {
  assert.deepEqual(await call(ok, 'GET', 'account', undefined, null), { status: 401, body: { error: 'Sign in first.' } });
  assert.deepEqual(await call(null, 'GET', 'account'), { status: 503, body: { error: 'Hybrid markets are unavailable.' } });
});

test('account and positions reach the service with the pool and body', async () => {
  const seen: any[] = [];
  const service = { ...ok, account: async (...args: any[]) => { seen.push(args); return { schema: 'account' }; },
    positions: async (...args: any[]) => { seen.push(args); return { schema: 'positions' }; } };
  assert.deepEqual(await call(service, 'GET', 'account'), { status: 200, body: { schema: 'account' } });
  assert.deepEqual(seen[0], [pool]);
  const input = { owner, claims: [{ scope: 1, mask: '2' }] };
  assert.deepEqual(await call(service, 'POST', 'positions', input), { status: 200, body: { schema: 'positions' } });
  assert.deepEqual(seen[1], [pool, owner, input.claims]);
});

test('methods and query strings are enforced', async () => {
  assert.deepEqual(await call(ok, 'POST', 'account', {}), { status: 405, body: { error: 'GET without parameters required.' } });
  assert.deepEqual(await call(ok, 'GET', 'positions'), { status: 405, body: { error: 'POST without parameters required.' } });
  assert.deepEqual(await call(ok, 'GET', `account?wallet=${owner}`), { status: 400, body: { error: 'Unexpected parameter.' } });
  assert.deepEqual(await call(ok, 'POST', 'history', { a: 1 }), { status: 400, body: { error: 'Unexpected input.' } });
});

test('input errors reach the client and other failures stay generic', async () => {
  for (const message of HYBRID_PORTFOLIO_INPUT_ERRORS) {
    const failing = { ...ok, account: async () => { throw Error(message); }, positions: async () => { throw Error(message); } };
    assert.deepEqual(await call(failing, 'GET', 'account'), { status: 400, body: { error: message } });
    assert.deepEqual(await call(failing, 'POST', 'positions', { owner, claims: [] }), { status: 400, body: { error: message } });
  }
  const leaking = { ...ok, account: async () => { throw Error('request to https://secret.example/abc failed'); } };
  assert.deepEqual(await call(leaking, 'GET', 'account'), { status: 503, body: { error: 'Hybrid holdings are temporarily unavailable. Refresh and retry.' } });
});

test('history and payout failures return the documented bodies', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failing = { ...ok, history: async () => { throw Error('rpc down'); },
      payouts: async () => { throw Object.assign(Error('archive'), { code: 'PAYOUT_ARCHIVE_UNAVAILABLE' }); } };
    assert.deepEqual(await call(failing, 'POST', 'history', {}), { status: 503,
      body: { error: 'Trade history is temporarily unavailable. Your on-chain holdings are loaded separately. Retry shortly.' } });
    const message = 'Collected payouts could not be checked. Your current holdings are separate.';
    assert.deepEqual(await call(failing, 'POST', 'collected-payouts', {}), { status: 503, body: { code: 'PAYOUT_ARCHIVE_UNAVAILABLE', error: message } });
    const other = { ...failing, payouts: async () => { throw Error('other'); } };
    assert.deepEqual(await call(other, 'POST', 'collected-payouts', {}), { status: 503, body: { code: 'PAYOUT_READ_FAILED', error: message } });
    const unknown = { ...ok, history: async () => { throw Error('Hybrid pool not found'); } };
    assert.deepEqual(await call(unknown, 'POST', 'history', {}), { status: 400, body: { error: 'Hybrid pool not found' } });
  } finally { console.warn = warn; }
});
