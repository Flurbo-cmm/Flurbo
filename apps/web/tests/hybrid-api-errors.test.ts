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
