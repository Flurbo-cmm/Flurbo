import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { starterConfig, starterFunds } from '../server/starter-funds.mjs';

const KEY = '0x' + '12'.repeat(32), A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), W1 = '0x' + 'c3'.repeat(20), W2 = '0x' + 'd4'.repeat(20);

function harness({ balance = 0n, failSend = false, lostReply = false, visibleAfter = 0, limit = '50' } = {}) {
  const db = new Map<string, string>(), sent: any[] = [], clock = { now: Date.parse('2026-10-02T10:00:00Z') };
  const command = async (op: string, ...args: any[]) => {
    if (op === 'INCR' || op === 'DECR') { const n = Number(db.get(args[0]) || 0) + (op === 'INCR' ? 1 : -1); db.set(args[0], String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    if (op === 'GET') return db.get(args[0]) ?? null;
    if (op === 'DEL') { let n = 0; for (const k of args) n += db.delete(k) ? 1 : 0; return n; }
    if (op === 'SET') { if (args[2] === 'NX' && db.has(args[0])) return null; db.set(args[0], args[1]); return 'OK'; }
    throw Error('unexpected ' + op);
  };
  // A small chain: broadcast transactions use up their nonce; each becomes visible to lookups only after
  // `visibleAfter` further lookups, like a node that has not indexed it yet.
  const state = { balance, failSend, lostReply, visibleAfter };
  const broadcast = new Map<string, { nonce: number; lookups: number }>(), used = new Set<number>();
  const client: any = { getChainId: async () => 10143, getBalance: async () => state.balance,
    getTransactionCount: async () => used.size,
    getTransaction: async ({ hash }: any) => {
      const tx = broadcast.get(hash);
      if (!tx || tx.lookups++ < state.visibleAfter) throw Error('not found');
      return { hash };
    } };
  const wallet: any = {
    prepareTransactionRequest: async (tx: any) => { let nonce = 0; while (used.has(nonce)) nonce++; return { ...tx, nonce }; },
    signTransaction: async (tx: any) => '0x02' + tx.to.slice(2) + String(tx.nonce).padStart(4, '0'),
    sendRawTransaction: async ({ serializedTransaction }: any) => {
      if (state.failSend) throw Error('rpc down');
      const { keccak256 } = await import('viem'), hash = keccak256(serializedTransaction), nonce = Number(serializedTransaction.slice(-4));
      if (broadcast.has(hash)) throw Error('already known');
      if (used.has(nonce)) throw Error('nonce too low');
      used.add(nonce); broadcast.set(hash, { nonce, lookups: 0 });
      sent.push({ to: '0x' + serializedTransaction.slice(4, 44), value: parseEther('0.5'), hash });
      if (state.lostReply) throw Error('timeout');
      return hash;
    },
  };
  const starter = starterFunds({ config: starterConfig({ FLURBO_STARTER_PRIVATE_KEY: KEY, FLURBO_STARTER_DAILY_LIMIT: limit }), command,
    rpcUrl: 'https://testnet-rpc.monad.xyz', client, wallet, now: () => clock.now, sleep: async () => {} })!;
  const dayCount = () => [...db.entries()].filter(([k]) => k.includes(':day:')).map(([, v]) => Number(v))[0] ?? 0;
  const kept = () => [...db.keys()].filter(k => k.includes(':unsent:')).length;
  return { starter, db, sent, state, clock, dayCount, kept };
}

test('configuration is off without a key and rejects unsafe values', () => {
  assert.equal(starterConfig({}), null);
  assert.equal(starterConfig({ FLURBO_STARTER_PRIVATE_KEY: KEY })!.amount, parseEther('0.5'));
  assert.throws(() => starterConfig({ FLURBO_STARTER_PRIVATE_KEY: 'not-a-key' }));
  assert.throws(() => starterConfig({ FLURBO_STARTER_PRIVATE_KEY: KEY, FLURBO_STARTER_MON: '5' }));
  assert.throws(() => starterConfig({ FLURBO_STARTER_PRIVATE_KEY: KEY, FLURBO_STARTER_DAILY_LIMIT: '0' }));
});

test('each account and each wallet receives the free MON once, ever', async () => {
  const h = harness();
  assert.equal((await h.starter.status(A)).status, 'available');
  assert.equal((await h.starter.send(A, W1)).amountMon, '0.5');
  assert.equal(h.sent[0].to, W1); assert.equal(h.sent[0].value, parseEther('0.5'));
  assert.equal((await h.starter.status(A)).status, 'sent');
  await assert.rejects(h.starter.send(A, W2), (e: any) => e.status === 409 && e.code === 'ALREADY_SENT');
  await assert.rejects(h.starter.send(B, W1), (e: any) => e.status === 409 && e.code === 'ALREADY_SENT');
  assert.equal(h.dayCount(), 1, 'refused repeats do not use the daily cap');
  await h.starter.send(B, W2);
  // Days later, with the wallet empty again, it is still refused: the faucet takes over.
  h.clock.now += 5 * 86_400_000;
  await assert.rejects(h.starter.send(A, W1), (e: any) => e.code === 'ALREADY_SENT');
  assert.equal(h.sent.length, 2);
});

test('funded wallets, the daily cap and failed sends are handled without losing a retry', async () => {
  const funded = harness({ balance: parseEther('0.1') });
  await assert.rejects(funded.starter.send(A, W1), (e: any) => e.code === 'HAS_MON');
  assert.equal((await funded.starter.status(A)).status, 'available', 'an already funded wallet does not use up the one-time grant');
  const capped = harness({ limit: '1' });
  await capped.starter.send(A, W1);
  assert.equal((await capped.starter.status(B)).status, 'exhausted');
  await assert.rejects(capped.starter.send(B, W2), (e: any) => e.status === 429 && e.code === 'DAILY_LIMIT' && /Monad faucet/.test(e.message));
  assert.equal([...capped.db.keys()].some(k => k.includes(`:account:${B}`)), false);
  const failing = harness({ failSend: true });
  await assert.rejects(failing.starter.send(A, W1), (e: any) => e.status === 503);
  assert.equal([...failing.db.keys()].some(k => k.includes(':account:') || k.includes(':wallet:')), false);
  assert.equal(failing.dayCount(), 0, 'a send that never happened gives its daily-cap slot back');
  assert.equal(capped.dayCount(), 1, 'a refused request over the cap does not inflate the count');
  await assert.rejects(harness().starter.send('bad', W1), (e: any) => e.status === 400);
});

test('the route only funds a wallet linked to the signed-in account', async () => {
  const { productionServer } = await import('../server/production.mjs');
  const { TESTNET } = await import('../server/network.mjs');
  const { request: httpRequest } = await import('node:http');
  const login = '0x' + '99'.repeat(20), origin = 'https://flurbo.singu.online', calls: string[][] = [];
  const store: any = {
    read: async (id: string) => id === 'fixture' ? { address: login, method: 'passkey' } : null,
    command: async (op: string, ...args: any[]) => (op === 'SMEMBERS' ? [W1] : op === 'EVAL' ? 1 : null),
  };
  const starter = { amountMon: '0.5', send: async (a: string, w: string) => { calls.push([a, w]); return { hash: '0x' + '1'.repeat(64), amountMon: '0.5' }; } };
  const server = productionServer({ previewAccess: null, origin, rpcUrl: TESTNET.rpc, starter }, store);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const post = (body: unknown, cookie = 'flurbo_session=fixture') => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/fund/starter', method: 'POST', headers: { Host: 'flurbo.singu.online', Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    assert.equal((await post({ wallet: W1 }, '')).status, 401);
    assert.equal((await post({ wallet: W2 })).status, 403);
    assert.equal((await post({ wallet: W1, extra: 1 })).status, 400);
    const ok = await post({ wallet: W1 });
    assert.equal(ok.status, 200); assert.equal(ok.json.amountMon, '0.5');
    assert.deepEqual(calls, [[login, W1]]);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('linking a new wallet sends the free MON automatically, once, without blocking the link', async () => {
  const { productionServer } = await import('../server/production.mjs');
  const { TESTNET } = await import('../server/network.mjs');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { request: httpRequest } = await import('node:http');
  const login = '0x' + '77'.repeat(20), origin = 'https://flurbo.singu.online', wallet = privateKeyToAccount(('0x' + '42'.repeat(32)) as `0x${string}`);
  const kv = new Map<string, string>(), sets = new Map<string, Set<string>>();
  const command = async (op: string, ...args: any[]) => {
    if (op === 'SET') { kv.set(args[0], args[1]); return 'OK'; }
    if (op === 'GETDEL') { const v = kv.get(args[0]) ?? null; kv.delete(args[0]); return v; }
    if (op === 'GET') return kv.get(args[0]) ?? null;
    if (op === 'SMEMBERS') return [...(sets.get(args[0]) || [])];
    if (op === 'EVAL') {
      const n = Number(args[1]), keys = args.slice(2, 2 + n), argv = args.slice(2 + n);
      if (String(args[0]).includes('SADD')) { if (!sets.has(keys[0])) sets.set(keys[0], new Set()); sets.get(keys[0])!.add(argv[1]); }
      return 1;
    }
    return null;
  };
  const store: any = { read: async (id: string) => id === 'fixture' ? { address: login, method: 'passkey' } : null, command };
  const sends: string[][] = [];
  const starter = { amountMon: '0.5', send: async (a: string, w: string) => { sends.push([a, w]); return { hash: '0x' + '1'.repeat(64), amountMon: '0.5' }; },
    status: async () => ({ status: sends.length ? 'sent' : 'available', amountMon: '0.5' }) };
  const server = productionServer({ previewAccess: null, origin, rpcUrl: TESTNET.rpc, starter }, store);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'flurbo.singu.online', Origin: origin, Cookie: 'flurbo_session=fixture', 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const link = async () => {
    const challenge = await call('POST', '/api/account/wallets/challenge', { wallet: wallet.address });
    assert.equal(challenge.status, 200);
    return call('POST', '/api/account/wallets/verify', { id: challenge.json.id, signature: await wallet.signMessage({ message: challenge.json.message }) });
  };
  try {
    assert.equal((await call('GET', '/api/fund/starter')).json.status, 'available');
    const linked = await link();
    assert.equal(linked.status, 200); assert.deepEqual(linked.json.wallets, [wallet.address.toLowerCase()]);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(sends, [[login, wallet.address.toLowerCase()]]);
    assert.equal((await call('GET', '/api/fund/starter')).json.status, 'sent');
    // Re-linking an already linked wallet does not trigger another send.
    assert.equal((await link()).status, 200);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sends.length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('a broadcast whose reply is lost still counts as sent, so a retry cannot pay twice', async () => {
  const h = harness({ lostReply: true });
  const result = await h.starter.send(A, W1);
  assert.equal(result.hash, h.sent[0].hash);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.starter.status(A)).status, 'sent');
  await assert.rejects(h.starter.send(A, W1), (e: any) => e.code === 'ALREADY_SENT');
  assert.equal(h.dayCount(), 1); assert.equal(h.kept(), 0);
});

test('a transaction that becomes visible a few seconds late is still recognised', async () => {
  const h = harness({ lostReply: true, visibleAfter: 2 });
  await h.starter.send(A, W1);
  assert.equal(h.sent.length, 1); assert.equal((await h.starter.status(A)).status, 'sent'); assert.equal(h.kept(), 0);
});

test('a send that landed but stayed invisible is recognised on retry, never sent again', async () => {
  const h = harness({ lostReply: true, visibleAfter: 99 });
  await assert.rejects(h.starter.send(A, W1), (e: any) => e.status === 503);
  assert.equal(h.sent.length, 1); assert.equal(h.kept(), 1); assert.equal(h.dayCount(), 0);
  h.state.lostReply = false; h.state.visibleAfter = 0;
  const retry = await h.starter.send(A, W1);
  assert.equal(retry.hash, h.sent[0].hash);
  assert.equal(h.sent.length, 1, 'no second payment');
  assert.equal(h.kept(), 0); assert.equal(h.dayCount(), 1);
});

test('a retry rebroadcasts the same signed transaction instead of signing a new one', async () => {
  const h = harness({ failSend: true });
  await assert.rejects(h.starter.send(A, W1), (e: any) => e.status === 503);
  const keptHash = JSON.parse([...h.db.entries()].find(([k]) => k.includes(':unsent:'))![1]).hash;
  h.state.failSend = false;
  const retry = await h.starter.send(A, W1);
  assert.equal(retry.hash, keptHash);
  assert.equal(h.sent.length, 1); assert.equal(h.kept(), 0);
});

test('a kept transaction whose nonce was used by another send is replaced by a fresh one', async () => {
  const h = harness({ failSend: true });
  await assert.rejects(h.starter.send(A, W1), (e: any) => e.status === 503);
  h.state.failSend = false;
  await h.starter.send(B, W2); // takes the same nonce, so the kept transaction can never land
  const retry = await h.starter.send(A, W1);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent.map(t => t.to), [W2, W1]);
  assert.equal(retry.hash, h.sent[1].hash); assert.equal(h.kept(), 0);
});
