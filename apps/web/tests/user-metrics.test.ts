import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { userMetrics, describeClaim, SIGNINS, LINKS, BLOCK_TIMES } from '../server/user-metrics.mjs';
import { encodeClaim } from '../shared/claims.mjs';
import { agentWalletKey, accountDigest } from '../server/agents/agent-store.mjs';

const addr = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(20);
const NOW = Date.parse('2026-10-05T12:00:00Z'), HOUR = 3_600_000, DAY = 24 * HOUR;

// Just enough of Upstash's command surface for the metrics module.
function fakeRedis() {
  const kv = new Map<string, string>(), hashes = new Map<string, Map<string, string>>(), calls: string[] = [];
  const hash = (k: string) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k)!; };
  const command = async (op: string, ...a: any[]) => {
    calls.push(op);
    switch (op) {
      case 'GET': return kv.get(a[0]) ?? null;
      case 'SET': if (a.includes('NX') && kv.has(a[0])) return null; kv.set(a[0], String(a[1])); return 'OK';
      case 'DEL': return a.reduce((n: number, k: string) => n + (kv.delete(k) ? 1 : 0), 0);
      case 'MGET': return a.map((k: string) => kv.get(k) ?? null);
      case 'SCAN': { const re = new RegExp('^' + String(a[2]).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return ['0', [...kv.keys()].filter(k => re.test(k))]; }
      case 'HSETNX': { const h = hash(a[0]); if (h.has(a[1])) return 0; h.set(a[1], String(a[2])); return 1; }
      case 'HSET': { const h = hash(a[0]); for (let i = 1; i < a.length; i += 2) h.set(String(a[i]), String(a[i + 1])); return 1; }
      case 'HGETALL': return [...hash(a[0]).entries()].flat();
      case 'HMGET': return a.slice(1).map((f: string) => hash(a[0]).get(String(f)) ?? null);
      default: throw Error('unexpected ' + op);
    }
  };
  return { kv, hashes, calls, command };
}

const claim = (legs: { event: number; yes: boolean }[], rule = 'AND') => encodeClaim({ events: 4, legs, rule });

test('claims are classified as a single answer or a combination with its payout rule', () => {
  assert.deepEqual(describeClaim(1, '2'), { legs: 1, kind: 'single', rule: null, answer: 'YES' });
  assert.deepEqual(describeClaim(4, '1'), { legs: 1, kind: 'single', rule: null, answer: 'NO' });
  for (const [legs, rule] of [[[{ event: 0, yes: true }, { event: 2, yes: false }], 'AND'], [[{ event: 1, yes: true }, { event: 3, yes: true }], 'OR'],
    [[{ event: 0, yes: false }, { event: 1, yes: true }], 'EXACTLY_ONE'], [[{ event: 0, yes: true }, { event: 1, yes: true }, { event: 2, yes: false }], 'AT_LEAST_TWO']] as const) {
    const c = claim([...legs], rule);
    const d = describeClaim(c.scope, c.mask);
    assert.equal(d.kind, 'combined'); assert.equal(d.rule, rule, rule); assert.equal(d.legs, legs.length);
  }
});

function fixture({ digestEnv = {} as Record<string, string>, deliver = null as any } = {}) {
  const redis = fakeRedis(), OPERATOR = addr(0x0a);
  const alice = addr(0xa1), bob = addr(0xb2), carol = addr(0xc3), dave = addr(0xd4), legacyMember = addr(0xe5);
  const aliceWallet = addr(0x11), bobWallet = addr(0x12), operatorWallet = addr(0x13), stranger = addr(0x14), agentWallet = addr(0x15), creator = addr(0x16);
  const pool = addr(0x70), started = 100;
  const single = claim([{ event: 0, yes: true }]), pair = claim([{ event: 0, yes: true }, { event: 1, yes: false }]);
  const trade = (block: number, trader: string, c: { scope: number; mask: string }, isBuy = true, cost = '2000000') =>
    ({ address: pool, block, blockHash: '0x' + String(block).padStart(64, '0'), hash: '0x' + String(block).padStart(64, '1'), index: 0, name: 'Traded',
      args: { trader, scope: c.scope, mask: c.mask, isBuy, quantity: '1000000', collateralAmount: cost } });
  const logs = [trade(110, aliceWallet, single), trade(111, aliceWallet, pair), trade(112, aliceWallet, pair), trade(113, bobWallet, single),
    trade(114, operatorWallet, pair), trade(115, stranger, single), trade(116, agentWallet, pair), trade(117, bobWallet, single, false, '900000'),
    trade(118, creator, single)];
  redis.kv.set(`flurbo:pilot:index:v1:${pool}`, JSON.stringify({ through: 200, target: 200, hash: '0x', logs }));
  const times: [number, number][] = [[110, NOW - 3 * DAY], [111, NOW - 2 * DAY], [112, NOW - HOUR], [113, NOW - 10 * DAY], [114, NOW - HOUR], [115, NOW - HOUR], [116, NOW - HOUR], [117, NOW - HOUR], [118, NOW - HOUR]];
  redis.hashes.set(BLOCK_TIMES, new Map(times.map(([b, t]) => [String(b), String(t)])));
  redis.hashes.set(SIGNINS, new Map([[alice, String(NOW - 5 * DAY)], [bob, String(NOW - 12 * DAY)], [carol, String(NOW - 2 * HOUR)], [OPERATOR, String(NOW - 20 * DAY)]]));
  // Alice linked after this shipped; Bob's link predates it and is found through the wallet-link lookup.
  redis.hashes.set(LINKS, new Map([[aliceWallet, JSON.stringify({ account: alice, at: NOW - 4 * DAY })]]));
  redis.kv.set(`flurbo:starter:v2:account:${alice}`, JSON.stringify({ wallet: aliceWallet, hash: '0x' + 'ab'.repeat(32), at: NOW - 4 * DAY }));
  redis.kv.set(agentWalletKey(agentWallet), JSON.stringify({ owner: accountDigest(carol), agentId: 'agent-1' }));
  const applications = { stats: async () => ({ total: 4, rows: [
    { account: alice, state: 'approved', decision: 'approved', createdAt: new Date(NOW - 5 * DAY).toISOString(), verifiedAt: new Date(NOW - 5 * DAY).toISOString(), approvedAt: new Date(NOW - 4 * DAY).toISOString() },
    { account: bob, state: 'approved', decision: 'approved', createdAt: new Date(NOW - 12 * DAY).toISOString(), verifiedAt: new Date(NOW - 12 * DAY).toISOString(), approvedAt: new Date(NOW - 11 * DAY).toISOString() },
    { account: carol, state: 'pending', decision: null, createdAt: new Date(NOW - HOUR).toISOString(), verifiedAt: new Date(NOW - HOUR).toISOString(), approvedAt: null },
    { account: dave, state: 'unverified', decision: null, createdAt: new Date(NOW - HOUR).toISOString(), verifiedAt: null, approvedAt: null },
  ] }) };
  const links = { ownerOf: async (wallet: string) => wallet === bobWallet ? bob : wallet === operatorWallet ? OPERATOR : null };
  const refreshes: string[] = [];
  const service = { manifest: { pool, verifiedBlock: String(started), publication: { draft: { closesAt: 1 } } },
    index: { refresh: async () => { refreshes.push('refresh'); return { through: 200, target: 200, complete: true, logs }; } } };
  const metrics = userMetrics({ command: redis.command, origin: 'https://flurbo.singu.online', links, applications, operatorAccount: OPERATOR,
    reservedWallets: new Set([creator]), pools: () => [{ namespace: 'pilot', label: 'Release milestones', service }], now: () => NOW,
    env: { FLURBO_TESTNET_APPROVED_ACCOUNTS: legacyMember, FLURBO_MONITOR_EMAIL_TO: 'to@example.com', FLURBO_MONITOR_EMAIL_FROM: 'from@example.com', FLURBO_MONITOR_RESEND_KEY: 're_test', ...digestEnv },
    rpc: async (method: string, params: any[]) => ({ timestamp: '0x' + (Math.floor(NOW / 1000)).toString(16), method, params }), deliver })!;
  return { redis, metrics, refreshes, people: { alice, bob, carol, dave, legacyMember, OPERATOR, stranger, agentWallet } };
}

test('the funnel counts members only, maps every trading wallet to its owner, and splits single and combined bets', async () => {
  const { metrics, redis, people } = fixture();
  const r = await metrics.report();
  const f = Object.fromEntries(r.funnel.map((s: any) => [s.key, s.count]));
  // Alice, Bob, Carol, Dave and the older approval list; the operator is team and excluded.
  assert.deepEqual(f, { signedIn: 5, requested: 4, granted: 3, linked: 2, funded: 1, traded: 2, active7d: 1 });
  assert.equal(r.funnel[1].detail.emailVerified, 3);
  const alice = r.users.find((u: any) => u.account === people.alice), bob = r.users.find((u: any) => u.account === people.bob);
  assert.deepEqual([alice.trades.buys, alice.trades.singles, alice.trades.combined, alice.trades.spentAtoms], [3, 1, 2, '6000000']);
  assert.deepEqual(alice.trades.byRule, { SINGLE: 1, AND: 2 });
  assert.deepEqual([bob.trades.buys, bob.trades.sells, bob.trades.receivedAtoms], [1, 1, '900000']);
  assert.equal(r.users.find((u: any) => u.account === people.OPERATOR).team, true);
  // A wallet nobody linked is flagged; the agent wallet is attributed to its owner; the deployer's trade is team.
  assert.deepEqual(r.unlinked.map((u: any) => u.wallet), [people.stranger]);
  assert.deepEqual(r.agents.map((a: any) => [a.agentId, a.account, a.trades.combined]), [['agent-1', people.carol, 1]]);
  assert.equal(r.totals.buys, 6); // Alice 3, Bob 1, stranger 1, agent 1
  assert.deepEqual([r.last24h.bets, r.last24h.combined, r.last24h.signIns, r.last24h.requests], [1, 1, 1, 2]);
  const today = r.daily.at(-1);
  assert.equal(today.day, '2026-10-05'); assert.equal(today.bets, 1); assert.equal(today.combined, 1);
  assert.equal(r.markets[0].traders, 4); assert.equal(r.markets[0].scanned.complete, true);
  // Bob's older link is cached for next time, and no email address is ever part of the report.
  assert.match(redis.hashes.get(LINKS)!.get(addr(0x12))!, new RegExp(people.bob));
  assert.doesNotMatch(JSON.stringify(r), /@/);
});

test('sign-ins keep the first date, links keep the first owner, and the scan records bet times', async () => {
  const { metrics, redis, refreshes } = fixture();
  const who = addr(0x42);
  await metrics.recordSignIn(who.toUpperCase().replace('0X', '0x'));
  const first = redis.hashes.get(SIGNINS)!.get(who);
  await metrics.recordSignIn(who);
  assert.equal(redis.hashes.get(SIGNINS)!.get(who), first);
  await metrics.recordLink(who, addr(0x43)); await metrics.recordLink(addr(0x44), addr(0x43));
  assert.equal(JSON.parse(redis.hashes.get(LINKS)!.get(addr(0x43))!).account, who);
  await metrics.recordSignIn('not-an-address');
  redis.hashes.get(BLOCK_TIMES)!.delete('118');
  const sync = await metrics.sync({ budgetMs: 5_000 });
  assert.equal(sync.complete, true); assert.equal(sync.timedBlocks, 1); assert.deepEqual(refreshes, ['refresh']);
  assert.equal(redis.hashes.get(BLOCK_TIMES)!.get('118'), String(Math.floor(NOW / 1000) * 1000));
});

test('the daily summary email goes out once per day after its time, and retries after a failed send', async () => {
  const sent: any[] = [];
  let failing = true;
  const deliver = async (item: any) => { if (failing) throw Error('resend down'); sent.push(item); return 'id'; };
  const off = fixture({ deliver });
  assert.equal(await off.metrics.digest(), 'disabled');
  const early = fixture({ digestEnv: { FLURBO_METRICS_DIGEST: 'true', FLURBO_METRICS_DIGEST_UTC: '13:00' }, deliver });
  assert.equal(await early.metrics.digest(), 'not_due');
  const due = fixture({ digestEnv: { FLURBO_METRICS_DIGEST: 'true' }, deliver });
  await assert.rejects(due.metrics.digest());
  failing = false;
  assert.equal(await due.metrics.digest(), 'sent_now');
  assert.equal(await due.metrics.digest(), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'flurbo-metrics-2026-10-05');
  assert.match(sent[0].body.text, /Made at least one bet: 2/);
  assert.match(sent[0].body.text, /Wallets that traded without a linked Flurbo account: 1/);
  assert.deepEqual(sent[0].body.to, ['to@example.com']);
});

test('metrics routes are for the operator passkey only, and trading requires a linked wallet', async () => {
  const { productionServer } = await import('../server/production.mjs');
  const { TESTNET } = await import('../server/network.mjs');
  const { DEFAULT_TESTING_OPERATOR } = await import('../server/testing-access.mjs');
  const redis = fakeRedis(), origin = 'https://flurbo.singu.online', member = addr(0x31), linked = addr(0x32), other = addr(0x33);
  const wallets = new Map([[member, [linked]]]);
  const baseCommand = redis.command;
  const command = async (op: string, ...a: any[]) => {
    if (op === 'SMEMBERS') return [...(wallets.get(member) || [])];
    if (op === 'EVAL') return 1;
    return baseCommand(op, ...a);
  };
  const prepared: any[] = [];
  const service = { manifest: { pool: addr(0x70), resolver: addr(0x71), verifiedBlock: '1', draftHash: 'x', publication: { draft: { events: [{ id: 'e0' }], closesAt: 1 } } },
    prepare: async (input: any) => { prepared.push(input.action); return input; } };
  const store: any = { command, read: async (id: string) => id === 'operator' ? { address: DEFAULT_TESTING_OPERATOR, method: 'passkey', expiresAt: Date.now() + 60_000 } : id === 'member' ? { address: member, method: 'passkey' } : null };
  const server = productionServer({ previewAccess: null, origin, rpcUrl: TESTNET.rpc, pilot: service }, store);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const call = (method: string, path: string, id: string, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'flurbo.singu.online', Origin: origin, Cookie: `flurbo_session=${id}`, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await call('GET', '/api/admin/metrics', '')).status, 401);
    assert.equal((await call('GET', '/api/admin/metrics', 'member')).status, 403);
    assert.equal((await call('POST', '/api/admin/metrics/sync', 'member', {})).status, 403);
    const report = await call('GET', '/api/admin/metrics', 'operator');
    assert.equal(report.status, 200); assert.equal(report.json.schema, 'flurbo.user-metrics.v1');
    assert.equal((await call('GET', '/api/admin/metrics?x=1', 'operator')).status, 400);
    for (const action of ['buy', 'sell']) {
      const refused = await call('POST', '/api/pilot/prepare', 'member', { action, owner: other });
      assert.equal(refused.status, 403); assert.equal(refused.json.code, 'WALLET_NOT_LINKED');
      assert.equal((await call('POST', '/api/pilot/prepare', 'member', { action, owner: linked.toUpperCase().replace('0X', '0x') })).status, 200);
    }
    // Loading linked wallets records an older link for the metrics without changing the response.
    assert.deepEqual((await call('GET', '/api/account/wallets', 'member')).json.wallets, [linked]);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(JSON.parse(redis.hashes.get(LINKS)!.get(linked)!).account, member);
    // Redeeming is never blocked, so winnings cannot be stranded in an unlinked wallet.
    assert.equal((await call('POST', '/api/pilot/prepare', 'member', { action: 'redeem', owner: other })).status, 200);
    assert.deepEqual(prepared, ['buy', 'sell', 'redeem']);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('the trade scan takes a capped number of steps per run, leaving RPC capacity for members', async () => {
  const redis = fakeRedis(), steps: string[] = [];
  const pool = (n: number, through: number) => { let at = through; return { namespace: 'p' + n, label: 'P' + n, service: { manifest: { pool: addr(0x70 + n), verifiedBlock: '0' },
    index: { refresh: async () => { steps.push('p' + n); at += 1000; return { through: at, target: 100_000, complete: false, logs: [] }; } } } }; };
  const metrics = userMetrics({ command: redis.command, origin: 'x', pools: () => [pool(1, 0), pool(2, 0)], now: () => NOW, env: {} })!;
  const first = await metrics.sync();
  assert.equal(first.steps, 3); assert.deepEqual(steps, ['p1', 'p2', 'p1']); assert.equal(first.complete, false);
  const more = userMetrics({ command: redis.command, origin: 'x', pools: () => [pool(1, 0)], now: () => NOW, env: { FLURBO_METRICS_SCAN_STEPS: '5' } })!;
  assert.equal((await more.sync()).steps, 5);
});

test('links made before metrics shipped are counted when the member next loads their wallets, without overwriting dated links', async () => {
  const { metrics, redis, people } = fixture();
  const older = addr(0x51), dated = addr(0x11);
  const datedBefore = redis.hashes.get(LINKS)!.get(dated);
  await metrics.recordExistingLinks(people.dave, [older.toUpperCase().replace('0X', '0x'), 'nonsense']);
  await metrics.recordExistingLinks(people.dave, [older]);
  await metrics.recordExistingLinks(people.bob, [dated]);
  assert.deepEqual(JSON.parse(redis.hashes.get(LINKS)!.get(older)!), { account: people.dave, at: null });
  assert.equal(redis.hashes.get(LINKS)!.get(dated), datedBefore);
  assert.equal(redis.calls.filter(c => c === 'HSETNX').length, 2, 'each wallet is written once per process');
  const r = await metrics.report();
  assert.equal(r.users.find((u: any) => u.account === people.dave).wallets, 1);
  assert.equal(r.funnel.find((s: any) => s.key === 'linked').count, 3);
});
