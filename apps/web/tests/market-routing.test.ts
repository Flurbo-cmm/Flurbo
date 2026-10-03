import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { productionServer } from '../server/production.mjs';
import { TESTNET } from '../server/network.mjs';
import { learningDeployment } from '../shared/learning-contracts.mjs';

test('learning reads require login; Mera submissions remain disabled across pools', async () => {
  const origin = 'https://flurbo.singu.online';
  const signer = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`); // Test fixture only.
  const originalPool = '0x' + '22'.repeat(20);
  const store = { read: async (id: string) => id === 'fixture' ? { address: signer.address.toLowerCase(), method: 'passkey' } : null };
  const server = productionServer({previewAccess:null,  origin, rpcUrl: TESTNET.rpc, learningDashboardUrl: 'http://127.0.0.1:18768' }, store);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const originalFetch = globalThis.fetch; const urls: string[] = []; let broadcasts = 0, substituted = false;
  globalThis.fetch = async (input, options) => {
    const url = String(input); urls.push(url);
    if (url === TESTNET.rpc) { broadcasts++; return Response.json({ result: '0x' + 'ab'.repeat(32) }); }
    const learning = url.startsWith('http://127.0.0.1:18768/api/');
    assert.ok(learning || url.startsWith('http://127.0.0.1:18765/api/'));
    return Response.json({ environment: 'public_testnet', chain_id: 10143, market_id: learning ? 'learning' : 'original',
      contracts: { pool: learning && !substituted ? learningDeployment.pool : originalPool, cash: TESTNET.cash } });
  };
  function request(path: string, body?: object, signedIn = true): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
        headers: { Host: 'flurbo.singu.online', Origin: origin, Cookie: signedIn ? 'flurbo_session=fixture' : '', 'Content-Type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
      }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const send = async (market: string, to: string, data: string) => request('/api/rpc', { market, method: 'eth_sendRawTransaction', params: [
    await signer.signTransaction({ type: 'legacy', chainId: 10143, nonce: 0, gas: 100000n, gasPrice: 1000000000n, value: 0n, to: to as `0x${string}`, data: data as `0x${string}` }),
  ] });
  const approve = (pool: string) => '0x095ea7b3' + pool.slice(2).padStart(64, '0') + '1'.padStart(64, '0');
  try {
    assert.equal((await request('/api/markets/learning/state', undefined, false)).status, 401); assert.equal(urls.length, 0);
    assert.equal((await request('/api/portfolio?wallet=' + signer.address, undefined, false)).status, 401);
    assert.equal((await request('/api/markets/learning/portfolio?wallet=' + signer.address, undefined, false)).status, 401);
    for (const suffix of ['portfolio?wallet=' + signer.address, 'state?wallet=' + signer.address, 'quote?side=buy&scope=3&mask=8&quantity=1000000', 'transaction?hash=0x' + 'ab'.repeat(32)]) {
      assert.equal((await request('/api/markets/learning/' + suffix)).status, 200);
      assert.equal(urls.at(-1), 'http://127.0.0.1:18768/api/' + suffix);
    }
    assert.equal((await request('/api/state')).value.contracts.pool, originalPool);
    assert.equal((await request('/api/markets/learning/local-wallet-setup', {})).status, 404);
    assert.equal((await send('learning', TESTNET.cash, approve(learningDeployment.pool))).status, 403);
    for (const selector of ['0x3e6b6cde', '0xc39849c5', '0xdf992423']) {
      assert.equal((await send('learning', learningDeployment.pool, selector + '0'.repeat(320))).status, 403);
    }
    const sent = broadcasts; assert.equal(sent, 0);
    assert.equal((await send('learning', TESTNET.cash, approve(originalPool))).status, 403);
    assert.equal((await send('original', TESTNET.cash, approve(learningDeployment.pool))).status, 403);
    assert.equal((await send('learning', originalPool, '0x3e6b6cde')).status, 403);
    for (const selector of ['0xb0a52172', '0xf6c4eade', '0xdeadbeef']) assert.equal((await send('learning', learningDeployment.pool, selector)).status, 403);
    assert.equal((await send('other', learningDeployment.pool, '0x3e6b6cde')).status, 400);
    substituted = true;
    assert.equal((await request('/api/markets/learning/state')).status, 503);
    assert.equal((await send('learning', learningDeployment.pool, '0x3e6b6cde')).status, 403);
    assert.equal(broadcasts, sent);
  } finally { globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
