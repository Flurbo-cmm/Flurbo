import test from 'node:test';
import assert from 'node:assert/strict';
import { localApi } from '../server/local-api.mjs';

const owner = `0x${'a'.repeat(40)}`;
const id = `${owner}-0`;

async function post(message: string) {
  const hybrid = { prepare: async () => { throw Error(message); } };
  const api = localApi({ hybrid, store: { read: async () => ({ method: 'passkey', address: owner }),
    command: async () => null } });
  const req: any = { url: `/api/hybrid/${id}/action`, method: 'POST',
    headers: { host: 'localhost:18767', origin: 'http://localhost:18767', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ action: 'finalizeArbitration', owner }); } };
  let status = 0, body: any;
  const res: any = { writeHead: (value: number) => { status = value; }, end: (value: string) => { body = JSON.parse(value); },
    setHeader: () => {} };
  await api(req, res, () => {});
  return { status, body };
}

test('Kleros and Reality validation messages reach the client unchanged', async () => {
  for (const message of ['Kleros ruling is not ready to report', 'Bond must meet the current minimum',
    'Evidence submission unavailable', 'Appeal contribution must be positive', 'No appealable Kleros dispute',
    'This wallet did not post an answer bond', 'Sepolia keeper unavailable'])
    assert.deepEqual(await post(message), { status: 400, body: { error: message } });
});

test('unexpected failures stay generic', async () => {
  const result = await post('request to https://secret.example/abc failed');
  assert.equal(result.body.error, 'Market request unavailable. Refresh and retry.');
});

test('the what-if route needs an approved passkey session, accepts POST only and hides upstream errors', async () => {
  const inputs: unknown[] = [];
  const hybrid = { whatIf: async (_id: string, input: any) => {
    inputs.push(input);
    if (input.fail) throw Error('request to https://secret.example/abc failed');
    if (input.bad) throw Error('Choose up to three assumptions');
    return { schema: 'flurbo.hybrid-what-if.v1' };
  } };
  const call = async ({ method = 'POST', session = { method: 'passkey', address: owner } as any, approved = true, body = { given: [] } as any, query = '' }) => {
    const api = localApi({ hybrid, previewAccess: { allows: async () => approved } as any,
      store: { read: async () => session, command: async () => null } as any });
    const req: any = { url: `/api/hybrid/${id}/what-if${query}`, method,
      headers: { host: 'localhost:18767', origin: 'http://localhost:18767', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
    let status = 0, payload: any;
    const res: any = { writeHead: (value: number) => { status = value; }, end: (value: string) => { payload = JSON.parse(value); }, setHeader: () => {} };
    await api(req, res, () => {});
    return { status, payload };
  };
  assert.equal((await call({ session: null })).status, 401);
  assert.equal((await call({ session: { method: 'wallet', address: owner } })).status, 401);
  assert.equal((await call({ approved: false })).status, 403);
  assert.equal((await call({ method: 'GET' })).status, 405);
  assert.equal((await call({ query: '?x=1' })).status, 405);
  assert.equal(inputs.length, 0);
  assert.deepEqual(await call({}), { status: 200, payload: { schema: 'flurbo.hybrid-what-if.v1' } });
  assert.deepEqual(await call({ body: { bad: true } }), { status: 400, payload: { error: 'Choose up to three assumptions' } });
  assert.equal((await call({ body: { fail: true } })).payload.error, 'Market request unavailable. Refresh and retry.');
  assert.equal(inputs.length, 3);
});
