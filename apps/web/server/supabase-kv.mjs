import { appendPriceSample } from './price-history.mjs';

// Rebuildable, non-critical data kept in Supabase instead of Redis, to save Redis commands (migration 004):
// price history, the trade history and payout indexes, and operator metrics. Everything else, including sessions,
// agents, wallet links, settlement state and email dedupe, stays in Redis, where it needs atomic scripts.
export const SUPABASE_KV_PREFIXES = Object.freeze(['flurbo:prices:', 'flurbo:pilot:index:', 'flurbo:pilot:payouts:', 'flurbo:metrics:']);

// The index compare-and-swap scripts in pilot-index.mjs and payout-index.mjs.
const CAS = /^local current=redis\.call\('GET',KEYS\[1\]\); if \(current or ''\)~=ARGV\[1\] then return 0 end; redis\.call\('SET',KEYS\[1\],ARGV\[2\]\); return 1$/;

// Translates the Redis commands those modules use into public.flurbo_kv operations.
function operation(name, args) {
  switch (name) {
    case 'GET': return ['get', { key: args[0] }];
    case 'MGET': return ['mget', { keys: args }];
    case 'SET': {
      const [key, value, ...options] = args, upper = options.map(o => String(o).toUpperCase()), op = { key, value: String(value) };
      if (upper.includes('NX')) op.nx = true;
      const ex = upper.indexOf('EX');
      if (ex >= 0) op.ex = Number(options[ex + 1]);
      if (upper.some(o => !['NX', 'EX'].includes(o) && !/^\d+$/.test(o))) throw Error('Unsupported SET option');
      return ['set', op];
    }
    case 'DEL': return ['del', { keys: args }];
    case 'HSET': return ['hset', { key: args[0], pairs: args.slice(1).map(String) }];
    case 'HSETNX': return ['hsetnx', { key: args[0], field: String(args[1]), value: String(args[2]) }];
    case 'HGET': return ['hget', { key: args[0], field: String(args[1]) }];
    case 'HGETALL': return ['hgetall', { key: args[0] }];
    case 'HMGET': return ['hmget', { key: args[0], fields: args.slice(1).map(String) }];
    case 'ZADD': return ['zadd', { key: args[0], pairs: args.slice(1).map(String) }];
    case 'ZRANGE':
      if (args.length !== 3) throw Error('Unsupported ZRANGE options');
      return ['zrange', { key: args[0], start: Number(args[1]), stop: Number(args[2]) }];
    case 'EVAL': {
      const [script, count, key, ...rest] = args;
      if (Number(count) !== 1) throw Error('Unsupported script');
      if (script === appendPriceSample) return ['price_append', { key, score: Number(rest[0]), member: String(rest[1]) }];
      if (CAS.test(script)) return ['cas', { key, expected: String(rest[0] ?? ''), value: String(rest[1]) }];
      throw Error('Unsupported script');
    }
    default: throw Error(`Unsupported command ${name}`);
  }
}

// A Redis-compatible command function backed by Supabase. Uses the same project and service key as the access
// applications (FLURBO_APPLICATIONS_SUPABASE_URL and _SECRET). Errors never include the key or upstream details.
export function supabaseKv(env = process.env, request = fetch) {
  const url = new URL(env.FLURBO_APPLICATIONS_SUPABASE_URL || 'https://invalid.example');
  const key = env.FLURBO_APPLICATIONS_SUPABASE_SECRET;
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.port
    || url.search || url.hash || url.pathname !== '/' || !key) throw Error('Configure the Supabase URL and service key for moved data');
  const endpoint = new URL('/rest/v1/rpc/flurbo_kv', url);
  return async (name, ...args) => {
    const [op, payload] = operation(String(name).toUpperCase(), args);
    let response;
    try {
      response = await request(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
        headers: { 'Content-Type': 'application/json', apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) },
        body: JSON.stringify({ p_op: op, p_args: payload }) });
    } catch { throw Error('Supabase data store unavailable'); }
    if (!response.ok) throw Error('Supabase data store rejected the request');
    return response.json();
  };
}

// Keys a Redis command touches, for routing. Commands without keys (PING) stay in Redis.
function keysOf(name, args) {
  if (name === 'EVAL' || name === 'EVALSHA') return args.slice(2, 2 + Number(args[1]));
  if (['MGET', 'DEL', 'EXISTS', 'UNLINK'].includes(name)) return args;
  if (name === 'SCAN') { const at = args.findIndex(a => String(a).toUpperCase() === 'MATCH'); return at >= 0 ? [String(args[at + 1])] : ['']; }
  if (name === 'PING') return [];
  return args.length ? [args[0]] : [];
}

// Sends each command to Supabase when every key it touches has a moved prefix, and to Redis when none does. A
// command mixing both is refused, so no operation is ever split across stores.
export function routedCommand(redis, kv, prefixes = SUPABASE_KV_PREFIXES) {
  const moved = key => prefixes.some(prefix => String(key).startsWith(prefix));
  return async (...command) => {
    const name = String(command[0]).toUpperCase(), keys = keysOf(name, command.slice(1));
    const flags = keys.map(moved);
    if (!flags.length || flags.every(f => !f)) return redis(...command);
    if (flags.every(Boolean)) return kv(...command);
    throw Error('A command cannot mix Redis and Supabase keys');
  };
}
