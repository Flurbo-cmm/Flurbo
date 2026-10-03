import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routedCommand, supabaseKv, SUPABASE_KV_PREFIXES } from '../server/supabase-kv.mjs';
import { priceHistory } from '../server/price-history.mjs';
import { moveKv } from '../scripts/move-kv-to-supabase.mjs';

// An in-memory stand-in for public.flurbo_kv (migration 004), with the same semantics the SQL was checked against.
function fakeSupabase() {
  const strings = new Map<string, string>(), hashes = new Map<string, Map<string, string>>(), zsets = new Map<string, Map<string, number>>();
  const calls: any[] = [];
  const ranked = (k: string) => [...(zsets.get(k) ?? new Map()).entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const run = (op: string, a: any): any => {
    switch (op) {
      case 'get': return strings.get(a.key) ?? null;
      case 'mget': return a.keys.map((k: string) => strings.get(k) ?? null);
      case 'set': if (a.nx && strings.has(a.key)) return null; strings.set(a.key, a.value); return 'OK';
      case 'del': { let n = 0; for (const k of a.keys) { if (strings.delete(k) || hashes.delete(k) || zsets.delete(k)) n++; } return n; }
      case 'hset': { const h = hashes.get(a.key) ?? new Map(); let n = 0; for (let i = 0; i < a.pairs.length; i += 2) { if (!h.has(a.pairs[i])) n++; h.set(a.pairs[i], a.pairs[i + 1]); } hashes.set(a.key, h); return n; }
      case 'hsetnx': { const h = hashes.get(a.key) ?? new Map(); if (h.has(a.field)) return 0; h.set(a.field, a.value); hashes.set(a.key, h); return 1; }
      case 'hget': return hashes.get(a.key)?.get(a.field) ?? null;
      case 'hgetall': return [...(hashes.get(a.key) ?? new Map()).entries()].sort().flat();
      case 'hmget': return a.fields.map((f: string) => hashes.get(a.key)?.get(f) ?? null);
      case 'zadd': { const z = zsets.get(a.key) ?? new Map(); let n = 0; for (let i = 0; i < a.pairs.length; i += 2) { if (!z.has(a.pairs[i + 1])) n++; z.set(a.pairs[i + 1], Number(a.pairs[i])); } zsets.set(a.key, z); return n; }
      case 'zrange': { const all = ranked(a.key), n = all.length; let s = a.start < 0 ? Math.max(n + a.start, 0) : a.start, e = a.stop < 0 ? n + a.stop : Math.min(a.stop, n - 1); return s > e ? [] : all.slice(s, e + 1).map(([m]) => m); }
      case 'price_append': {
        const z = zsets.get(a.key) ?? new Map();
        if (![...z.values()].includes(a.score)) z.set(a.member, a.score);
        for (const [m, s] of z) if (s < a.score - 2592000) z.delete(m);
        zsets.set(a.key, z); const all = ranked(a.key); for (const [m] of all.slice(0, Math.max(0, all.length - 288))) z.delete(m);
        return ranked(a.key).map(([m]) => m);
      }
      case 'cas': { const cur = strings.get(a.key); if ((cur ?? '') !== a.expected) return 0; if (cur === undefined && a.expected !== '') return 0; strings.set(a.key, a.value); return 1; }
    }
    throw Error('unsupported ' + op);
  };
  const request = async (url: any, init: any) => {
    const { p_op, p_args } = JSON.parse(init.body); calls.push({ url: String(url), headers: init.headers, op: p_op, args: p_args });
    return Response.json(run(p_op, p_args));
  };
  return { request, calls, strings, hashes, zsets };
}
// A small Redis stand-in with the types and commands this test uses.
function fakeRedis() {
  const data = new Map<string, any>(), ttl = new Map<string, number>();
  const command = async (op: string, ...a: any[]): Promise<any> => {
    switch (op) {
      case 'PING': return 'PONG';
      case 'GET': return typeof data.get(a[0]) === 'string' ? data.get(a[0]) : null;
      case 'SET': { data.set(a[0], String(a[1])); const ex = a.indexOf('EX'); if (ex > 0) ttl.set(a[0], Number(a[ex + 1])); else ttl.delete(a[0]); return 'OK'; }
      case 'DEL': { let n = 0; for (const k of a) { if (data.delete(k)) n++; ttl.delete(k); } return n; }
      case 'TYPE': { const v = data.get(a[0]); return v === undefined ? 'none' : typeof v === 'string' ? 'string' : v.kind; }
      case 'TTL': return data.has(a[0]) ? ttl.get(a[0]) ?? -1 : -2;
      case 'HSET': { const h = data.get(a[0]) ?? { kind: 'hash', map: new Map() }; for (let i = 1; i < a.length; i += 2) h.map.set(String(a[i]), String(a[i + 1])); data.set(a[0], h); return 1; }
      case 'HGETALL': return [...(data.get(a[0])?.map ?? new Map()).entries()].flat();
      case 'ZADD': { const z = data.get(a[0]) ?? { kind: 'zset', map: new Map() }; for (let i = 1; i < a.length; i += 2) z.map.set(String(a[i + 1]), Number(a[i])); data.set(a[0], z); return 1; }
      case 'ZRANGE': return [...data.get(a[0]).map.entries()].sort((x: any, y: any) => x[1] - y[1]).flatMap(([m, s]: any) => [m, String(s)]);
      case 'SCAN': { const pattern = String(a[a.indexOf('MATCH') + 1]).replace(/\*$/, ''); return ['0', [...data.keys()].filter(k => k.startsWith(pattern))]; }
      case 'EVAL': return 1;
    }
    throw Error('fake redis: ' + op);
  };
  return { command, data };
}
const env = { FLURBO_APPLICATIONS_SUPABASE_URL: 'https://project-ref.supabase.co/', FLURBO_APPLICATIONS_SUPABASE_SECRET: 'sb_secret_test' };

test('the Supabase store speaks the Redis commands those modules use, and never leaks its key', async () => {
  const s = fakeSupabase(), kv = supabaseKv(env, s.request as any);
  assert.equal(await kv('SET', 'flurbo:metrics:v1:x', '1', 'NX', 'EX', '60'), 'OK');
  assert.equal(await kv('SET', 'flurbo:metrics:v1:x', '2', 'NX'), null);
  assert.deepEqual(await kv('MGET', 'flurbo:metrics:v1:x', 'flurbo:metrics:v1:y'), ['1', null]);
  assert.equal(await kv('HSETNX', 'flurbo:metrics:v1:h', 'a', 1), 1);
  assert.deepEqual(await kv('HMGET', 'flurbo:metrics:v1:h', 'a', 'b'), ['1', null]);
  assert.deepEqual(s.calls[0].args, { key: 'flurbo:metrics:v1:x', value: '1', nx: true, ex: 60 });
  assert.equal(s.calls[0].url, 'https://project-ref.supabase.co/rest/v1/rpc/flurbo_kv');
  assert.equal(s.calls[0].headers.apikey, 'sb_secret_test'); assert.equal(s.calls[0].headers.Authorization, undefined);
  await assert.rejects(kv('EVAL', 'return 1', 1, 'flurbo:metrics:v1:x'), /Unsupported script/);
  await assert.rejects(kv('ZRANGE', 'flurbo:prices:v1:x', 0, -1, 'WITHSCORES'), /Unsupported ZRANGE/);
  const failing = supabaseKv(env, (async () => new Response('sb_secret_test detail', { status: 500 })) as any);
  await assert.rejects(failing('GET', 'flurbo:metrics:v1:x'), (e: Error) => !e.message.includes('sb_secret'));
  assert.throws(() => supabaseKv({ ...env, FLURBO_APPLICATIONS_SUPABASE_URL: 'https://evil.example/' }), /Configure/);
});

test('routing sends only moved prefixes to Supabase and refuses mixed commands', async () => {
  const s = fakeSupabase(), r = fakeRedis(); const seen: string[] = [];
  const redis = async (...c: any[]) => { seen.push('redis:' + c[0]); return r.command(...c); };
  const kv = supabaseKv(env, s.request as any), command = routedCommand(redis, async (...c: any[]) => { seen.push('kv:' + c[0]); return kv(...c); });
  await command('PING');
  await command('SET', 'flurbo:auth:v1:session:x', 'v', 'EX', 60);
  await command('GET', 'flurbo:pilot:index:v1:0xpool');
  await command('EVAL', "local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1", 1, 'flurbo:pilot:payouts:v1:0xpool', '', 'x');
  await command('EVAL', "return redis.call('GET',KEYS[1])", 1, 'flurbo:settlement:v1:lock');
  await command('SCAN', '0', 'MATCH', 'flurbo:starter:v2:account:*', 'COUNT', 1000);
  await command('MGET', 'flurbo:metrics:v1:a', 'flurbo:metrics:v1:b');
  assert.deepEqual(seen, ['redis:PING', 'redis:SET', 'kv:GET', 'kv:EVAL', 'redis:EVAL', 'redis:SCAN', 'kv:MGET']);
  await assert.rejects(command('MGET', 'flurbo:metrics:v1:a', 'flurbo:auth:v1:x'), /cannot mix/);
  assert.equal(s.strings.get('flurbo:pilot:payouts:v1:0xpool'), 'x');
  assert.deepEqual(SUPABASE_KV_PREFIXES, ['flurbo:prices:', 'flurbo:pilot:index:', 'flurbo:pilot:payouts:', 'flurbo:metrics:']);
});

test('price history works unchanged on Supabase, and the move script copies and checks before deleting', async () => {
  const s = fakeSupabase(), r = fakeRedis(), kv = supabaseKv(env, s.request as any), command = routedCommand(r.command, kv);
  let t = 1_800_000_000;
  const manifest = { chainId: 10143, pool: '0x' + '22'.repeat(20), rulesHash: '0x' + '55'.repeat(32), publication: { draft: { events: [{}, {}] } } };
  const service = { manifest, markets: async () => ({ manifest, open: true, snapshot: { timestamp: t, blockNumber: '1', blockHash: '0x' + '44'.repeat(32) },
    prices: [{ event: 0, yes: '500000', no: '500000' }, { event: 1, yes: '400000', no: '600000' }] }) };
  const read = async () => (await priceHistory({ service, command, now: () => t }).read()).points.length;
  assert.equal(await read(), 1); t += 60; assert.equal(await read(), 1, 'same five-minute bucket'); t += 300; assert.equal(await read(), 2);
  assert.ok([...s.zsets.keys()][0].startsWith('flurbo:prices:v1:'));
  assert.equal([...r.data.keys()].some(k => k.startsWith('flurbo:prices:')), false, 'nothing written to Redis');
  // Moving existing Redis data: a hash, a string with expiry and a sorted set; other keys are untouched.
  const s2 = fakeSupabase(), r2 = fakeRedis(), kv2 = supabaseKv(env, s2.request as any);
  await r2.command('HSET', 'flurbo:metrics:v1:signins', '0xa', '1', '0xb', '2');
  await r2.command('SET', 'flurbo:metrics:v1:sync', '{"at":1}', 'EX', 600);
  await r2.command('ZADD', 'flurbo:prices:v1:abc', 300, 's1', 600, 's2');
  await r2.command('SET', 'flurbo:auth:v1:session:x', 'keep');
  const logs: string[] = [];
  assert.deepEqual(await moveKv({ redis: r2.command, kv: kv2, log: l => logs.push(l) }), { copied: 0, checked: 0 });
  assert.equal(s2.calls.length, 0, 'dry run writes nothing');
  await assert.rejects(moveKv({ redis: r2.command, kv: kv2, remove: true, log: () => {} }), /nothing was deleted/);
  assert.deepEqual(await moveKv({ redis: r2.command, kv: kv2, copy: true, remove: true, log: () => {} }), { copied: 3, checked: 3 });
  assert.deepEqual(await kv2('HGETALL', 'flurbo:metrics:v1:signins'), ['0xa', '1', '0xb', '2']);
  assert.deepEqual(await kv2('ZRANGE', 'flurbo:prices:v1:abc', 0, -1), ['s1', 's2']);
  assert.equal(await r2.command('GET', 'flurbo:auth:v1:session:x'), 'keep');
  assert.equal(await r2.command('GET', 'flurbo:metrics:v1:sync'), null, 'moved keys deleted from Redis only after the check');
});
