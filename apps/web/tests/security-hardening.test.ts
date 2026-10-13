import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { HttpRequestError } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { localApi } from '../server/local-api.mjs';
import { SessionStore } from '../server/session.mjs';
import { RedisSessionStore } from '../server/redis-session.mjs';
import { requestLimits, expensivePath, CapacityError, limitConcurrency } from '../server/request-limits.mjs';
import { clientAddressReader } from '../server/client-address.mjs';
import { redactUrls, publicStatus } from '../server/redact.mjs';
import { hybridArbitrationWorker } from '../server/hybrid-arbitration-worker.mjs';
import { productionServer } from '../server/production.mjs';
import { previewAccess } from '../server/preview-access.mjs';
import { proofCaptureService } from '../server/proof-captures.mjs';
import { configureApplications } from '../server/access-applications.mjs';
import { DEFAULT_TESTING_OPERATOR } from '../server/testing-access.mjs';
import { fakeRedis } from './agent-fixture.ts';

const origin = 'https://flurbopm.singu.online', host = 'flurbopm.singu.online';
const attacker = '198.51.100.66', visitor = '203.0.113.20';
const T0 = 1_800_000_000_000;

type Reply = { status: number; cookies: string[]; text: string; json: () => any };
type Call = { method?: string; ip?: string; cookie?: string; body?: object; raw?: string; headers?: Record<string, string> };
function call(api: any, path: string, { method, ip = visitor, cookie, body, raw, headers = {} }: Call = {}): Promise<Reply> {
  const verb = method ?? (body || raw !== undefined ? 'POST' : 'GET');
  const payload = raw ?? (body ? JSON.stringify(body) : '');
  const req = {
    url: path, method: verb, socket: { remoteAddress: '10.0.0.1' },
    headers: { host, 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}),
      ...(verb !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers },
    setEncoding() {},
    async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload); },
  };
  return new Promise(resolve => {
    const cookies: string[] = []; let status = 0, text = '';
    const res = {
      headersSent: false,
      setHeader(name: string, value: string | string[]) { if (name.toLowerCase() === 'set-cookie') cookies.push(...[value].flat()); },
      writeHead(s: number) { status = s; this.headersSent = true; },
      end(chunk?: string | Buffer) { if (chunk) text += String(chunk); resolve({ status, cookies, text, json: () => JSON.parse(text) }); },
    };
    api(req, res, () => resolve({ status: -1, cookies, text, json: () => null }));
  });
}
const hosted = (options: any = {}) => localApi({ publicOrigin: origin, rpcUrl: 'https://testnet-rpc.monad.xyz',
  store: new SessionStore(), sharedLimits: false, previewAccess: null, applications: null, now: () => T0, ...options });
const randomCookie = () => '__Host-flurbo_session=' + randomBytes(32).toString('base64url');
async function signIn(store: { challenge: Function; verify: Function }) {
  const account = privateKeyToAccount(generatePrivateKey());
  const { id, message } = await store.challenge(account.address, origin);
  const session = await store.verify(id, await account.signMessage({ message }), origin);
  return { address: account.address.toLowerCase(), cookie: '__Host-flurbo_session=' + session.sessionId };
}
const tally = (list: number[]) => list.reduce((m: Record<number, number>, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});

test('client address reads the configured header and groups IPv6 by /64', () => {
  const read = clientAddressReader();
  assert.equal(read({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } }), '198.51.100.7');
  assert.equal(read({ headers: { 'x-forwarded-for': '::ffff:198.51.100.7' } }), '198.51.100.7');
  assert.equal(read({ headers: { 'x-forwarded-for': '2001:db8:1:2:aaaa::1' } }), read({ headers: { 'x-forwarded-for': '2001:db8:1:2:bbbb::9' } }));
  assert.notEqual(read({ headers: { 'x-forwarded-for': '2001:db8:1:2::1' } }), read({ headers: { 'x-forwarded-for': '2001:db8:1:3::1' } }));
  assert.equal(read({ headers: { 'x-forwarded-for': 'not-an-address' }, socket: { remoteAddress: '203.0.113.5' } }), '203.0.113.5');
  assert.equal(read({ headers: {} }), 'unknown');
  assert.equal(clientAddressReader('x-forwarded-for-last')({ headers: { 'x-forwarded-for': '192.0.2.1, 198.51.100.7' } }), '198.51.100.7');
  assert.equal(clientAddressReader('cf-connecting-ip')({ headers: { 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '192.0.2.1' } }), '198.51.100.8');
  assert.throws(() => clientAddressReader('x-real-ip'));
});

test('a full limiter evicts per-client counters instead of refusing everyone, and keeps site-wide counters', () => {
  let t = T0; const limits = requestLimits({ now: () => t });
  for (let i = 0; i < 5; i++) limits.localTake('site-wide', 5);
  for (let i = 0; i < 30_000; i++) limits.localTake('client:' + i, 1);
  limits.localTake('client:late-arrival', 1);
  assert.throws(() => limits.localTake('site-wide', 5), CapacityError);
  assert.equal(limits.localCount('site-wide'), 6);
  t += 60_000; limits.localTake('site-wide', 5); assert.equal(limits.localCount('site-wide'), 1);
});

test('hybrid analysis, transaction preparation and indexer reads count as expensive', () => {
  const id = '0x' + 'a'.repeat(40) + '-0';
  for (const path of [`/api/hybrid/${id}/analysis`, `/api/hybrid/${id}/action`, '/api/oracle/route-1/action', '/api/envio'])
    assert.equal(expensivePath(path), true, path);
  assert.equal(expensivePath(`/api/hybrid/${id}/market`), false);
  assert.equal(expensivePath('/api/agents/actions'), false);
});

test('pair calculations run at most two at a time and refuse a long queue', async () => {
  let active = 0, peak = 0; const release: Array<() => void> = [];
  const run = limitConcurrency(async () => { active++; peak = Math.max(peak, active);
    await new Promise<void>(r => release.push(r)); active--; return 'ok'; }, { concurrency: 2, queued: 3 });
  const calls = Array.from({ length: 5 }, () => run());
  await new Promise(r => setImmediate(r));
  assert.equal(active, 2);
  await assert.rejects(run(), /busy/);
  while (release.length || active) { release.shift()?.(); await new Promise(r => setImmediate(r)); }
  assert.deepEqual(await Promise.all(calls), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(peak, 2);
});

test('URLs in public status keep only their host', () => {
  const text = 'HTTP request failed.\nURL: https://eth-sepolia.g.alchemy.com/v2/SECRETTOKEN\nRequest body: {"method":"eth_call"}';
  assert.equal(redactUrls(text), 'HTTP request failed.\nURL: https://eth-sepolia.g.alchemy.com\nRequest body: {"method":"eth_call"}');
  assert.equal(redactUrls('see wss://name.monad-testnet.quiknode.pro/abc123/ now'), 'see wss://name.monad-testnet.quiknode.pro now');
  const status = publicStatus({ a: { lastError: text, cycles: 3, list: ['https://u:p@host.example/x?k=1'] }, b: null, c: 'x'.repeat(5000) });
  assert.deepEqual(status.a, { lastError: redactUrls(text), cycles: 3, list: ['https://host.example'] });
  assert.equal(status.b, null); assert.ok(status.c.length <= 1000);
});

test('the arbitration worker never reports an RPC URL after a transport error', async () => {
  const managerKey = generatePrivateKey(), relayKey = generatePrivateKey();
  const route = { id: 'arbitration-test', pool: '0x' + '1'.repeat(40), resolver: '0x' + '2'.repeat(40), adapter: '0x' + '3'.repeat(40),
    manager: privateKeyToAccount(managerKey).address, relay: privateKeyToAccount(relayKey).address,
    rulesHash: '0x' + 'a'.repeat(64), eventHash: '0x' + 'b'.repeat(64), eventIndex: 0, deploymentBlock: 100,
    question: 'Did the official source report the exact result?' };
  const fail = async () => { throw new HttpRequestError({ url: 'https://eth-sepolia.g.alchemy.com/v2/SECRETTOKEN', status: 429, body: { method: 'eth_chainId' } }); };
  const client = { getChainId: fail, readContract: fail };
  const worker = hybridArbitrationWorker({ routes: [route], market: client, source: client, command: async () => null,
    evidence: { putHybridCase: async () => null, putHybridRuling: async () => null },
    marketRpcUrl: 'https://testnet-rpc.monad.xyz', sourceRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    managerPrivateKey: managerKey, relayPrivateKey: relayKey });
  const logged: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try { await worker.tick(); } finally { console.error = original; }
  const status = JSON.stringify(worker.status());
  assert.ok(!status.includes('SECRETTOKEN') && !status.includes('/v2/'), status);
  assert.equal(worker.status().lastError, 'Hybrid arbitration source or transaction request failed');
  assert.ok(logged.length > 0 && logged.every(line => !line.includes('SECRETTOKEN')), logged.join('\n'));
});

test('the public health check redacts worker URLs and sends hardened headers', async () => {
  const server = productionServer({ origin, rpcUrl: 'https://testnet-rpc.monad.xyz', previewAccess: null,
    hybridArbitration: { status: () => ({ lastError: 'HTTP request failed.\nURL: https://eth-sepolia.g.alchemy.com/v2/SECRETTOKEN' }) },
    hybridCourt: { status: () => ({ lastError: 'see https://name.monad-testnet.quiknode.pro/abc123/ now', cycles: 2 }) } }, new SessionStore(), 'missing-static-root');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const get = (path: string) => new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
    httpRequest({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject).end();
  });
  try {
    const health = await get('/healthz');
    assert.equal(health.status, 200);
    assert.ok(!health.body.includes('SECRETTOKEN') && !health.body.includes('abc123'), health.body);
    assert.equal(JSON.parse(health.body).hybrid_court.cycles, 2);
    assert.match(health.body, /eth-sepolia\.g\.alchemy\.com/);
    assert.match(health.headers['strict-transport-security'], /max-age=31536000; includeSubDomains/);
    assert.equal(health.headers['cross-origin-opener-policy'], 'same-origin');
    assert.match(health.headers['permissions-policy'], /camera=\(\)/);
    assert.equal((await get('/envio')).status, 404, 'the unauthenticated indexer path is gone');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('one anonymous client cannot block sign-in for other visitors', async () => {
  const { command } = fakeRedis();
  const api = hosted({ store: new RedisSessionStore(command) });
  const address = () => privateKeyToAccount(generatePrivateKey()).address;
  const challenges: number[] = [];
  for (let i = 0; i < 70; i++) challenges.push((await call(api, '/api/auth/challenge', { ip: attacker, body: { address: address() } })).status);
  assert.ok(tally(challenges)[429] >= 60, JSON.stringify(tally(challenges)));
  assert.equal((await call(api, '/api/auth/challenge', { ip: visitor, body: { address: address() } })).status, 200);
  const flood: number[] = [];
  for (let i = 0; i < 400; i++) flood.push((await call(api, '/api/auth/session', { ip: attacker })).status);
  assert.ok(tally(flood)[429] >= 250, JSON.stringify(tally(flood)));
  assert.equal((await call(api, '/api/auth/session', { ip: visitor })).status, 200);
  assert.equal((await call(api, '/api/auth/challenge', { ip: '192.0.2.10', body: { address: address() } })).status, 200);
});

test('a flood of unknown session cookies neither locks out members nor multiplies session reads', async () => {
  const { command } = fakeRedis(); let lookups = 0;
  const counted = async (op: string, ...args: any[]) => { if (op === 'GET' && String(args[0]).startsWith('flurbo:auth:v1:session:')) lookups++; return command(op, ...args); };
  const store = new RedisSessionStore(counted), api = hosted({ store });
  const member = await signIn(store);
  lookups = 0;
  const flood: number[] = [];
  for (let i = 0; i < 5000; i++) flood.push((await call(api, '/api/account/access', { ip: attacker, cookie: randomCookie() })).status);
  assert.ok(lookups <= 60, `session reads caused by the flood: ${lookups}`);
  assert.ok(tally(flood)[429] >= 4900, JSON.stringify(tally(flood)));
  assert.equal((await call(api, '/api/account/access', { ip: '192.0.2.44', cookie: member.cookie })).status, 200);
  for (let i = 0; i < 300; i++) assert.equal((await call(api, '/api/network', { ip: '192.0.2.44', cookie: member.cookie })).status, i < 239 ? 200 : 429);
});

test('members keep working while made-up cookies from many addresses flood the whole site', async () => {
  const { command } = fakeRedis(); let lookups = 0;
  const counted = async (op: string, ...args: any[]) => { if (op === 'GET' && String(args[0]).startsWith('flurbo:auth:v1:session:')) lookups++; return command(op, ...args); };
  const store = new RedisSessionStore(counted, Date.now, { cacheMs: 0 }), api = hosted({ store });
  const member = await signIn(store);
  assert.equal((await call(api, '/api/network', { ip: '192.0.2.44', cookie: member.cookie })).status, 200);
  lookups = 0;
  for (let i = 0; i < 2000; i++) await call(api, '/api/network', { ip: `198.18.${i >> 8}.${i & 255}`, cookie: randomCookie() });
  assert.ok(lookups <= 600, `session reads caused by the flood: ${lookups}`);
  assert.equal((await call(api, '/api/network', { ip: '192.0.2.44', cookie: member.cookie })).status, 200);
});

test('signed-in accounts without approval cannot use up the approved members budget', async () => {
  const store = new SessionStore();
  const member = await signIn(store);
  const api = hosted({ store, previewAccess: previewAccess({ FLURBO_TESTNET_APPROVED_ACCOUNTS: member.address }) });
  const sybils = await Promise.all(Array.from({ length: 6 }, () => signIn(store)));
  for (const sybil of sybils) for (let i = 0; i < 240; i++) await call(api, '/api/auth/session', { ip: attacker, cookie: sybil.cookie });
  assert.equal((await call(api, '/api/network', { ip: visitor, cookie: member.cookie })).status, 200);
  assert.equal((await call(api, '/api/network', { ip: attacker, cookie: sybils[0].cookie })).status, 429);
});

test('bad agent credentials from one address neither block runtimes elsewhere nor multiply storage reads', async () => {
  const { command } = fakeRedis(); let reads = 0;
  const counted = async (op: string, ...args: any[]) => { if (op === 'GET' || op === 'MGET') reads++; return command(op, ...args); };
  const api = hosted({ store: new RedisSessionStore(counted) });
  const token = () => `fla1_${randomBytes(8).toString('hex')}_${randomBytes(32).toString('base64url')}`;
  const runtime = (ip: string) => call(api, '/api/agent-runtime/v1/session', { ip, headers: { authorization: 'Bearer ' + token(), 'flurbo-agent-protocol': '1' } });
  const flood: number[] = [];
  for (let i = 0; i < 500; i++) flood.push((await runtime(attacker)).status);
  assert.ok(reads <= 70, `credential reads caused by the flood: ${reads}`);
  assert.ok(tally(flood)[429] >= 400, JSON.stringify(tally(flood)));
  assert.equal((await runtime('192.0.2.80')).status, 401);
});

test('proof uploads without the token neither read the body nor use up the uploader budget', async () => {
  const token = 'k'.repeat(40);
  const proofCaptures = proofCaptureService({ rules: new Map(), captureStore: { put: async () => ({}) }, token });
  const api = hosted({ proofCaptures });
  const body = JSON.stringify({ ruleHash: 'a'.repeat(64), capture: {} });
  for (let i = 0; i < 100; i++) assert.notEqual((await call(api, '/api/settlement/proof-captures', { ip: attacker, raw: body, headers: { authorization: 'Bearer wrong' } })).status, 404);
  assert.equal((await call(api, '/api/settlement/proof-captures', { ip: '192.0.2.90', raw: body, headers: { authorization: 'Bearer ' + token } })).status, 404, 'reaches the rule check');
});

test('webhook deliveries are limited per sender before the body is read', async () => {
  const api = hosted();
  const statuses: number[] = [];
  for (let i = 0; i < 200; i++) statuses.push((await call(api, '/api/alchemy/webhook', { ip: attacker, raw: '{}', headers: { 'x-alchemy-signature': 'f'.repeat(64) } })).status);
  assert.ok(tally(statuses)[429] > 0, JSON.stringify(tally(statuses)));
  assert.notEqual((await call(api, '/api/alchemy/webhook', { ip: '192.0.2.70', raw: '{}', headers: { 'x-alchemy-signature': 'f'.repeat(64) } })).status, 429);
});

test('the indexer proxy needs a signed-in approved account', async () => {
  const store = new SessionStore();
  const member = await signIn(store), applicant = await signIn(store);
  const api = hosted({ store, previewAccess: previewAccess({ FLURBO_TESTNET_APPROVED_ACCOUNTS: member.address }),
    envioUrl: 'https://indexer.hyperindex.xyz/v1/graphql' });
  const original = globalThis.fetch; let upstream = 0;
  globalThis.fetch = (async () => { upstream++; return Response.json({ data: { Trade: [] } }); }) as typeof fetch;
  try {
    const query = { kind: 'trades', pool: '0x' + 'a'.repeat(40), limit: 5 };
    assert.equal((await call(api, '/api/envio', { body: query })).status, 401);
    assert.equal((await call(api, '/api/envio', { body: query, cookie: applicant.cookie })).status, 403);
    const ok = await call(api, '/api/envio', { body: query, cookie: member.cookie });
    assert.equal(ok.status, 200); assert.deepEqual(ok.json(), { data: { Trade: [] } }); assert.equal(upstream, 1);
    assert.equal((await call(api, '/api/envio', { body: query, cookie: member.cookie, headers: { origin: 'https://evil.example' } })).status, 403);
  } finally { globalThis.fetch = original; }
});

test('approval notices do not use the daily verification email budget', async () => {
  const actions: string[] = [];
  const request = (async (url: string | URL, init: any) => {
    if (String(url).includes('/rest/v1/rpc/flurbo_application')) {
      const { p_action } = JSON.parse(init.body); actions.push(p_action);
      if (p_action === 'notification') return Response.json({ id: 'notice-1', email: 'member@example.com', expired: false });
      if (p_action === 'submit') return Response.json({ send: true, application: { state: 'unverified' } });
      return Response.json({});
    }
    return Response.json({ id: 'email-1' });
  }) as typeof fetch;
  const applications = configureApplications({ FLURBO_APPLICATIONS_ENABLED: 'true', FLURBO_APPLICATIONS_SUPABASE_URL: 'https://ref.supabase.co/',
    FLURBO_APPLICATIONS_SUPABASE_SECRET: 'sb_secret_test', FLURBO_APPLICATIONS_RESEND_KEY: 're_test', FLURBO_APPLICATIONS_EMAIL_FROM: 'team@example.com',
    FLURBO_APPLICATIONS_CODE_SECRET: 's'.repeat(32) }, request)!;
  await applications.handle({ action: 'admin/notify', account: DEFAULT_TESTING_OPERATOR, operator: true, input: { account: '0x' + 'cd'.repeat(20) } });
  assert.deepEqual(actions, ['notification', 'notified']);
  actions.length = 0;
  await applications.handle({ action: 'submit', account: '0x' + 'ef'.repeat(20), input: { email: 'person@example.com', noticeAccepted: true } });
  assert.deepEqual(actions, ['submit', 'email_budget']);
});

test('one address cannot send verification emails for many accounts', async () => {
  const store = new SessionStore(); let submitted = 0, t = T0;
  const applications = { allows: async () => false, handle: async ({ action, budget }: any) => {
    if (action === 'submit') { await budget('email'); submitted++; } return { application: null }; } };
  const api = hosted({ store, applications, now: () => t });
  const accounts = await Promise.all(Array.from({ length: 24 }, () => signIn(store)));
  const statuses: number[] = [];
  for (const account of accounts) {
    t += 61_000;
    statuses.push((await call(api, '/api/account/application/submit', { ip: attacker, cookie: account.cookie,
      body: { email: 'someone@example.com', noticeAccepted: true } })).status);
  }
  assert.equal(submitted, 20); assert.equal(tally(statuses)[429], 4);
  assert.equal((await call(api, '/api/account/application/submit', { ip: visitor, cookie: (await signIn(store)).cookie,
    body: { email: 'other@example.com', noticeAccepted: true } })).status, 200);
});

test('hosted sessions use host-only cookies and still accept the earlier cookie name', async () => {
  const store = new SessionStore(), api = hosted({ store });
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await call(api, '/api/auth/challenge', { body: { address: account.address } });
  assert.match(challenge.cookies[0], /^__Host-flurbo_challenge=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=300; Secure$/);
  const verified = await call(api, '/api/auth/verify', { cookie: challenge.cookies[0].split(';')[0],
    body: { signature: await account.signMessage({ message: challenge.json().message }) } });
  assert.equal(verified.status, 200);
  assert.match(verified.cookies[0], /^__Host-flurbo_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure$/);
  assert.ok(verified.cookies.some(c => /^flurbo_session=; .*Path=\/api; Max-Age=0/.test(c)), 'the earlier cookie is cleared');
  const sessionId = verified.cookies[0].split(';')[0].split('=')[1];
  assert.equal((await call(api, '/api/auth/session', { cookie: '__Host-flurbo_session=' + sessionId })).json().session.address, account.address.toLowerCase());
  assert.equal((await call(api, '/api/auth/session', { cookie: 'flurbo_session=' + sessionId })).json().session.address, account.address.toLowerCase());
  const local = localApi({ store: new SessionStore() });
  const localChallenge = await new Promise<Reply>(resolve => {
    const cookies: string[] = []; let status = 0, text = '';
    local({ url: '/api/auth/challenge', method: 'POST', headers: { host: 'localhost:18767', origin: 'http://localhost:18767', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ address: account.address })); } },
    { setHeader(_n: string, v: string) { cookies.push(...[v].flat()); }, writeHead(s: number) { status = s; }, end(c?: string) { text = String(c); resolve({ status, cookies, text, json: () => JSON.parse(text) }); } }, () => {});
  });
  assert.match(localChallenge.cookies[0], /^flurbo_challenge=[^;]+; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=300$/, 'local development keeps plain names');
});
