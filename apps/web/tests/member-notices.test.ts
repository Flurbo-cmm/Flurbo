import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { memberNotices, noticeDelivery, unsubscribeToken, verifyUnsubscribeToken, PREFS } from '../server/member-notices.mjs';
import { LINKS } from '../server/user-metrics.mjs';

const addr = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(20);
const SECRET = 's'.repeat(40), NOW = 1_791_000_000, POOL = addr(0x70);
const A = addr(0xa1), B = addr(0xb2), C = addr(0xc3), D = addr(0xd4);
const WA = addr(0x11), WB = addr(0x12), WC = addr(0x13), WD = addr(0x14);

function fakeRedis() {
  const kv = new Map<string, string>(), hashes = new Map<string, Map<string, string>>();
  const hash = (k: string) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k)!; };
  const command = async (op: string, ...a: any[]) => {
    switch (op) {
      case 'GET': return kv.get(a[0]) ?? null;
      case 'SET': if (a.includes('NX') && kv.has(a[0])) return null; kv.set(a[0], String(a[1])); return 'OK';
      case 'EXISTS': return kv.has(a[0]) ? 1 : 0;
      case 'INCR': { const n = Number(kv.get(a[0]) || 0) + 1; kv.set(a[0], String(n)); return n; }
      case 'EXPIRE': return 1;
      case 'HGET': return hash(a[0]).get(a[1]) ?? null;
      case 'HSET': hash(a[0]).set(a[1], a[2]); return 1;
      case 'SMEMBERS': return [];
      case 'EVAL': return 1;
      default: throw Error('unexpected ' + op);
    }
  };
  return { kv, hashes, command };
}

// A two-question market. Holdings by wallet and claim; payouts apply once resolved.
function fixture({ phase = 0, delivered = false, closesAt = NOW + 7200, complete = true, limit = '40', contacts = { [A]: 'a@example.com', [B]: 'b@example.com', [C]: 'c@example.com' } as Record<string, string> } = {}) {
  const redis = fakeRedis(), clock = { now: NOW }, sent: any[] = [];
  const held: Record<string, Record<string, { q: string; pay: string }>> = {
    [WA]: { '1:2': { q: '3000000', pay: '3000000' }, '3:8': { q: '1000000', pay: '0' } }, // A: event 0 YES, and a combination
    [WB]: { '1:1': { q: '0', pay: '0' } },                                                // B: bought, then sold everything
    [WC]: { '2:2': { q: '2000000', pay: '0' } },                                          // C: event 1 only, losing
    [WD]: { '1:2': { q: '1000000', pay: '1000000' } },                                    // D: no verified email
  };
  const logs = Object.entries(held).flatMap(([wallet, claims]) => Object.keys(claims).map((k, i) => {
    const [scope, mask] = k.split(':');
    return { name: 'Traded', block: 10 + i, args: { trader: wallet, scope: Number(scope), mask, isBuy: true, quantity: '1000000', collateralAmount: '500000' } };
  }));
  redis.kv.set(`flurbo:pilot:index:v1:${POOL}`, JSON.stringify({ through: complete ? 100 : 50, target: 100, logs }));
  redis.hashes.set(LINKS, new Map([[WA, A], [WB, B], [WC, C], [WD, D]].map(([w, a]) => [w, JSON.stringify({ account: a, at: 1 })])));
  const state = { phase, delivered };
  const service = {
    manifest: { pool: POOL, publication: { draft: { closesAt, events: [{ question: 'Will A happen?' }, { question: 'Will B happen?' }] } } },
    status: async () => ({ snapshot: { timestamp: clock.now }, resolved: state.delivered, delivered: state.delivered,
      cases: [{ phase: state.phase, proposal: 2, challengeUntil: NOW + 3600 }, { phase: 0, proposal: 0, challengeUntil: 0 }] }),
    positions: async (wallet: string, claims: any[]) => ({ rows: claims.map(c => { const h = held[wallet]?.[`${c.scope}:${c.mask}`];
      return { ...c, quantity: h?.q ?? '0', payoutAtoms: state.delivered ? (h?.pay ?? '0') : null }; }) }),
  };
  const notices = memberNotices({ command: redis.command, origin: 'https://flurbo.singu.online', now: () => clock.now,
    env: { FLURBO_NOTIFY_ENABLED: 'true', FLURBO_NOTIFY_DAILY_LIMIT: limit },
    pools: () => [{ namespace: 'pilot', label: 'Release milestones', service }],
    applications: { noticeSecret: SECRET, contacts: async (accounts: string[]) => Object.fromEntries(accounts.filter(a => contacts[a]).map(a => [a, contacts[a]])) },
    send: async (m: any) => { sent.push(m); } })!;
  return { notices, sent, redis, clock, state };
}
const noCopies = (sent: any[]) => { for (const m of sent) { assert.equal(m.to.length, 1); assert.equal('cc' in m || 'bcc' in m, false); } };

test('unsubscribe links carry the account and a signature that cannot be forged', () => {
  const token = unsubscribeToken(SECRET, A.toUpperCase().replace('0X', '0x'));
  assert.equal(verifyUnsubscribeToken(SECRET, token), A);
  assert.equal(verifyUnsubscribeToken(SECRET, token.replace(A, B)), null);
  assert.equal(verifyUnsubscribeToken('other'.repeat(8), token), null);
  assert.equal(verifyUnsubscribeToken(SECRET, 'nonsense'), null);
});

test('a proposed answer and a payout reach each holder once, combined in one email to that member alone', async () => {
  const h = fixture({ phase: 1 });
  assert.equal(await h.notices.tick(), 'sent 1');
  // Only A holds event 0 (C holds event 1; B sold out; D has no verified email).
  assert.deepEqual(h.sent.map(m => m.to[0]), ['a@example.com']);
  assert.match(h.sent[0].text, /"Will A happen\?"\nProposed answer: Yes\. It can be challenged until/);
  assert.match(h.sent[0].subject, /An answer was proposed/);
  assert.equal(await h.notices.tick(), 'idle', 'the stage is finished; nothing is sent twice');
  // Results arrive: A has a payout, C lost, D has no email. A gets one email.
  h.state.phase = 3; h.state.delivered = true;
  assert.equal(await h.notices.tick(), 'sent 1');
  assert.deepEqual(h.sent.map(m => m.to[0]), ['a@example.com', 'a@example.com']);
  assert.match(h.sent[1].text, /about 3 test AUSD to collect/);
  assert.match(h.sent[1].text, /\/api\/notifications\/unsubscribe\/0x[0-9a-f]{40}\.[0-9a-f]{64}/);
  noCopies(h.sent);
  // Three days later, a reminder only while the payout is still uncollected.
  h.clock.now += 72 * 3600;
  assert.equal(await h.notices.tick(), 'sent 1');
  assert.match(h.sent[2].text, /^Reminder: results are final/);
  h.clock.now += 3600;
  assert.equal(await h.notices.tick(), 'idle');
});

test('several notices due at once are combined into a single email', async () => {
  const h = fixture({ phase: 1, delivered: true, closesAt: NOW - 10 });
  await h.notices.setPreferences(A, { closing: true });
  assert.equal(await h.notices.tick(), 'sent 1');
  assert.equal(h.sent[0].subject, 'Updates on your Flurbo predictions');
  assert.match(h.sent[0].text, /An answer was proposed/); assert.match(h.sent[0].text, /to collect/);
});

test('closing reminders are opt-in and only for holders of that market', async () => {
  const h = fixture();
  assert.equal(await h.notices.tick(), 'sent 0', 'nobody opted in');
  const h2 = fixture();
  await h2.notices.setPreferences(A, { closing: true }); await h2.notices.setPreferences(B, { closing: true });
  assert.equal(await h2.notices.tick(), 'sent 1');
  assert.deepEqual(h2.sent.map(m => m.to[0]), ['a@example.com'], 'B sold everything, so it holds nothing here');
  assert.match(h2.sent[0].subject, /Trading closes in about 2 hours: Release milestones/);
  assert.equal(await h2.notices.tick(), 'idle');
});

test('members who turned notices off, or used the unsubscribe link, get nothing', async () => {
  const h = fixture({ phase: 1 });
  await h.notices.setPreferences(A, { challenges: false });
  assert.equal(await h.notices.tick(), 'sent 0');
  const h2 = fixture({ delivered: true });
  assert.ok(await h2.notices.unsubscribe(unsubscribeToken(SECRET, A)));
  assert.deepEqual(JSON.parse(h2.redis.hashes.get(PREFS)!.get(A)!), { payouts: false, challenges: false, closing: false });
  assert.equal(await h2.notices.tick(), 'sent 0');
  assert.equal(await h2.notices.unsubscribe('0x' + '1'.repeat(40) + '.' + 'f'.repeat(64)), null);
  await assert.rejects(h2.notices.setPreferences(A, { payouts: 'yes' } as any));
});

test('an index that has not caught up waits, and the daily limit resumes the next day without duplicates', async () => {
  const h = fixture({ phase: 1, complete: false });
  assert.equal(await h.notices.tick(), 'idle');
  assert.equal(h.sent.length, 0);
  const capped = fixture({ delivered: true, limit: '1', contacts: { [A]: 'a@example.com', [D]: 'd@example.com' } });
  assert.equal(await capped.notices.tick(), 'sent 1; daily limit reached');
  capped.clock.now += 86_400;
  assert.equal(await capped.notices.tick(), 'sent 1');
  assert.deepEqual(capped.sent.map(m => m.to[0]).sort(), ['a@example.com', 'd@example.com']);
  noCopies(capped.sent);
  assert.equal(await capped.notices.tick(), 'idle');
});

test('delivery refuses anything but a single recipient and adds one-click unsubscribe headers', async () => {
  const bodies: any[] = [];
  const deliver = noticeDelivery({ key: 're_test', from: 'Flurbo <team@flurbo.singu.online>' }, (async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true }; }) as any);
  await assert.rejects(deliver({ to: ['a@example.com', 'b@example.com'], subject: 's', text: 't', unsubscribeUrl: 'https://x', key: 'k' }));
  await deliver({ to: ['a@example.com'], subject: 's', text: 't', unsubscribeUrl: 'https://flurbo.singu.online/api/notifications/unsubscribe/x', key: 'k' });
  assert.deepEqual(bodies[0].to, ['a@example.com']);
  assert.equal('cc' in bodies[0] || 'bcc' in bodies[0], false);
  assert.equal(bodies[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('settings need the signed-in member; the unsubscribe link works without signing in or an Origin header', async () => {
  const { productionServer } = await import('../server/production.mjs');
  const { TESTNET } = await import('../server/network.mjs');
  const redis = fakeRedis(), origin = 'https://flurbo.singu.online';
  const applications: any = { noticeSecret: SECRET, noticeEmail: { key: 're_x', from: 'a@b.co' }, contacts: async () => ({}), allows: async () => true,
    handle: async () => ({ application: { verified: true, state: 'approved', email: 'a@example.com' } }) };
  const store: any = { command: redis.command, read: async (id: string) => id === 'member' ? { address: A, method: 'passkey' } : null };
  const server = productionServer({ previewAccess: null, applications, origin, rpcUrl: TESTNET.rpc }, store);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const call = (method: string, path: string, id = '', body?: unknown, withOrigin = true) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'flurbo.singu.online', ...(withOrigin ? { Origin: origin } : {}), Cookie: `flurbo_session=${id}`, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    assert.equal((await call('GET', '/api/account/notifications')).status, 401);
    const got = JSON.parse((await call('GET', '/api/account/notifications', 'member')).text);
    assert.deepEqual([got.email, got.preferences], ['a@example.com', { payouts: true, challenges: true, closing: false }]);
    assert.equal((await call('POST', '/api/account/notifications', 'member', { closing: 'yes' })).status, 400);
    assert.equal(JSON.parse((await call('POST', '/api/account/notifications', 'member', { closing: true })).text).preferences.closing, true);
    const link = `/api/notifications/unsubscribe/${unsubscribeToken(SECRET, A)}`;
    const confirm = await call('GET', link, '', undefined, false);
    assert.equal(confirm.status, 200); assert.match(confirm.text, /Stop all notices/);
    assert.equal(JSON.parse((await call('GET', '/api/account/notifications', 'member')).text).preferences.payouts, true, 'opening the link changes nothing');
    const done = await call('POST', link, '', undefined, false);
    assert.equal(done.status, 200); assert.match(done.text, /You will not get Flurbo notices/);
    assert.deepEqual(JSON.parse((await call('GET', '/api/account/notifications', 'member')).text).preferences, { payouts: false, challenges: false, closing: false });
    assert.equal((await call('POST', `/api/notifications/unsubscribe/${A}.${'0'.repeat(64)}`, '', undefined, false)).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
