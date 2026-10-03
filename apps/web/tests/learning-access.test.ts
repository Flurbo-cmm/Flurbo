import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { SessionStore } from '../server/session.mjs';
import { productionServer } from '../server/production.mjs';

test('learning status requires Mera login and proposal preparation requires the configured Mera operator', async () => {
  const origin = 'https://flurbo.singu.online';
  const admin = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
  const visitor = privateKeyToAccount(('0x' + '22'.repeat(32)) as `0x${string}`);
  const store = new SessionStore();
  async function login(signer: typeof admin) {
    const challenge = await store.challenge(signer.address, origin, 'passkey');
    const result = await store.verify(challenge.id, await signer.signMessage({ message: challenge.message }), origin);
    return 'flurbo_session=' + result.sessionId;
  }
  const adminCookie = await login(admin), visitorCookie = await login(visitor);
  let reads = 0, preparations = 0;
  const server = productionServer({previewAccess:null,  origin, rpcUrl: 'https://testnet-rpc.monad.xyz',
    testingOperatorAccount: admin.address.toLowerCase(), learningOperatorAccount: admin.address.toLowerCase(), learningPool: {
      async status() { reads++; return { schema: 'flurbo.learning-pool.v1' }; },
      async prepare() { preparations++; return { schema: 'flurbo.learning-review.v1' }; },
    } }, store);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  function request(path: string, cookie = '', data?: unknown, requestOrigin = origin): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: data === undefined ? 'GET' : 'POST',
        headers: { Host: 'flurbo.singu.online', Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  try {
    assert.equal((await request('/api/learning/pool')).status, 401);
    assert.equal((await request('/api/learning/proposal', '', {})).status, 401);
    assert.equal(reads + preparations, 0);
    assert.equal((await request('/api/learning/pool', visitorCookie)).status, 403);
    assert.equal((await request('/api/learning/proposal', visitorCookie, {})).status, 403);
    assert.equal((await request('/api/learning/proposal', visitorCookie, { address: admin.address })).status, 403);
    assert.equal((await request('/api/learning/pool', adminCookie)).body.operator, true);
    assert.equal((await request('/api/learning/proposal', adminCookie, {}, 'https://evil.example')).status, 403);
    assert.equal((await request('/api/learning/proposal?pool=anything', adminCookie, {})).status, 400);
    for (const body of [null, [], { pool: 'untrusted' }, { command: 'send' }]) assert.equal((await request('/api/learning/proposal', adminCookie, body)).status, 400);
    assert.equal((await request('/api/learning/proposal', adminCookie)).status, 405);
    assert.equal((await request('/api/learning/pool', adminCookie, {})).status, 405);
    assert.equal(preparations, 0);
    assert.equal((await request('/api/learning/proposal', adminCookie, {})).status, 200);
    assert.equal(preparations, 1);
    await store.revoke(adminCookie.split('=')[1]);
    assert.equal((await request('/api/learning/proposal', adminCookie, {})).status, 401);
    assert.equal(preparations, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
