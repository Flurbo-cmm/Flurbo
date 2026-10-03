#!/usr/bin/env node
// Copies the data moved to Supabase by migration 004 (price history, trade history and payout indexes, operator
// metrics) from Redis. Run it after the migration and before setting FLURBO_SUPABASE_KV=true on the server.
//
//   node apps/web/scripts/move-kv-to-supabase.mjs            dry run: lists the keys it would copy
//   node apps/web/scripts/move-kv-to-supabase.mjs --copy     copies, then checks every value in Supabase
//   node apps/web/scripts/move-kv-to-supabase.mjs --delete   after a checked copy, deletes those keys from Redis
//
// Needs UPSTASH_REDIS_REST_URL/_TOKEN and FLURBO_APPLICATIONS_SUPABASE_URL/_SECRET in the environment. Copying
// twice is safe: values are overwritten with the Redis ones. Nothing outside the moved prefixes is read or changed.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redisCommand } from '../server/redis-session.mjs';
import { supabaseKv, SUPABASE_KV_PREFIXES } from '../server/supabase-kv.mjs';

const pairs = flat => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

async function movedKeys(redis) {
  const keys = [];
  for (const prefix of SUPABASE_KV_PREFIXES) {
    let cursor = '0';
    do { const [next, batch] = await redis('SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', '500'); keys.push(...batch); cursor = String(next); } while (cursor !== '0');
  }
  return [...new Set(keys)].sort();
}

async function readRedis(redis, key) {
  const type = await redis('TYPE', key), ttl = Number(await redis('TTL', key));
  if (type === 'string') return { type, ttl, value: await redis('GET', key) };
  if (type === 'hash') return { type, ttl, value: pairs(await redis('HGETALL', key)).sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
  if (type === 'zset') return { type, ttl, value: pairs(await redis('ZRANGE', key, '0', '-1', 'WITHSCORES')) };
  if (type === 'none') return null;
  throw Error(`${key}: ${type} values are not moved`);
}

export async function moveKv({ redis, kv, copy = false, remove = false, log = console.log }) {
  const keys = await movedKeys(redis), records = new Map();
  for (const key of keys) { const r = await readRedis(redis, key); if (r) records.set(key, r); }
  const counts = {};
  for (const key of records.keys()) { const p = SUPABASE_KV_PREFIXES.find(prefix => key.startsWith(prefix)); counts[p] = (counts[p] ?? 0) + 1; }
  log(JSON.stringify({ keys: records.size, byPrefix: counts }));
  if (!copy && !remove) { log('Dry run. Run with --copy to copy into Supabase.'); return { copied: 0, checked: 0 }; }

  if (copy) for (const [key, { type, ttl, value }] of records) {
    await kv('DEL', key);
    if (type === 'string') await kv('SET', key, value, ...(ttl > 0 ? ['EX', String(ttl)] : []));
    else if (type === 'hash' && value.length) await kv('HSET', key, ...value.flat());
    else if (type === 'zset' && value.length) await kv('ZADD', key, ...value.flatMap(([member, score]) => [score, member]));
  }
  // Check every copied value against Redis before anything is deleted.
  let wrong = 0;
  for (const [key, { type, value }] of records) {
    let copied;
    if (type === 'string') copied = await kv('GET', key);
    else if (type === 'hash') copied = pairs(await kv('HGETALL', key)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    else copied = await kv('ZRANGE', key, '0', '-1');
    const expected = type === 'zset' ? value.map(([member]) => member) : value;
    if (JSON.stringify(copied) !== JSON.stringify(expected)) { wrong++; log(`Mismatch: ${key}`); }
  }
  log(`Checked ${records.size} keys in Supabase. Mismatched: ${wrong}.`);
  if (wrong) throw Error('Copy did not match; nothing was deleted from Redis');
  if (remove) {
    for (const key of records.keys()) await redis('DEL', key);
    log(`Deleted ${records.size} moved keys from Redis.`);
  }
  return { copied: copy ? records.size : 0, checked: records.size };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(a => !['--copy', '--delete'].includes(a))) { console.error('Usage: move-kv-to-supabase.mjs [--copy] [--delete]'); process.exit(1); }
  try {
    await moveKv({ redis: redisCommand(process.env), kv: supabaseKv(process.env), copy: args.includes('--copy'), remove: args.includes('--delete') });
  } catch (error) { console.error(error.message); process.exit(1); }
}
