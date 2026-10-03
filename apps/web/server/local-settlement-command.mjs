import { mkdir, open, readFile, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { leaseScript } from './settlement-store.mjs';
import { captureHistoryScript } from './settlement-persistence.mjs';

const MAX_FILE_BYTES = 64_000_000;
const MAX_VALUE_BYTES = 16_000_000;
const MAX_KEYS = 4096;
const quotaScripts = new Set([
  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n",
  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
]);
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const safeKey = key => typeof key === 'string' && /^flurbo:(?:monitor:v1:|pilot:evidence(?:-quota)?:|settlement:v1:)[a-zA-Z0-9:._-]{1,240}$/.test(key);
const fail = message => { throw Error(message); };

// Deliberately not a general Redis replacement. Only the settlement journal/lease,
// evidence archive, source history and their quotas are available. No auth/agent keys.
// Pass explicitly into a local rehearsal. Production continues to use Redis.
export async function createLocalSettlementCommand({ directory, now = Date.now }) {
  if (typeof directory !== 'string' || !directory || resolve(directory) !== directory) fail('Absolute isolated rehearsal directory required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink() || root.toLowerCase() !== directory.toLowerCase()) fail('Rehearsal storage cannot use symbolic links');
  const statePath = join(root, 'state.json'), lockPath = join(root, 'state.lock');
  const regular = async path => {
    try { const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink()) fail('Unsafe rehearsal storage file'); return st; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const load = async () => {
    const stat = await regular(statePath);
    if (!stat) return { schema: 'flurbo.local-settlement-state.v1', entries: {} };
    if (stat.size > MAX_FILE_BYTES) fail('Rehearsal state capacity exceeded');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state?.schema !== 'flurbo.local-settlement-state.v1' || !state.entries || Array.isArray(state.entries)
      || typeof state.entries !== 'object' || Object.keys(state.entries).length > MAX_KEYS) fail('Invalid rehearsal state');
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!safeKey(key) || !entry || typeof entry.value !== 'string' || Buffer.byteLength(entry.value) > MAX_VALUE_BYTES
        || (entry.expiresAt !== null && !integer(entry.expiresAt))) fail('Invalid rehearsal state entry');
    }
    return state;
  };
  const save = async state => {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > MAX_FILE_BYTES || Object.keys(state.entries).length > MAX_KEYS) fail('Rehearsal state capacity exceeded');
    const temporary = join(root, `state-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    try { await regular(statePath); await rename(temporary, statePath); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    // fsync the rename where supported. Windows directory handles do not expose fsync.
    if (process.platform !== 'win32') { const folder = await open(root, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
  };
  // A filesystem lock protects each atomic command across processes. An orphaned lock
  // fails closed; an operator must stop all workers and inspect it, never auto-steal it.
  const transaction = async operation => {
    const deadline = Date.now() + 5000;
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code !== 'EEXIST') throw error; await regular(lockPath); if (Date.now() >= deadline) fail('Rehearsal storage locked; stop workers and inspect state.lock'); await delay(20); }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); await lock.sync();
      const state = await load(), at = now();
      if (!integer(at)) fail('Invalid rehearsal storage clock');
      for (const [key, entry] of Object.entries(state.entries)) if (entry.expiresAt !== null && entry.expiresAt <= at) delete state.entries[key];
      const result = operation(state.entries, at);
      await save(state);
      return result;
    } finally { await lock.close(); await unlink(lockPath); }
  };
  return async (name, ...args) => transaction((entries, at) => {
    const value = key => entries[key]?.value ?? null;
    const key = index => { if (!safeKey(args[index])) fail('Rehearsal command key is outside the settlement namespace'); return args[index]; };
    const put = (k, text, expiresAt = null) => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_VALUE_BYTES) fail('Invalid bounded rehearsal value');
      entries[k] = { value: text, expiresAt }; return 'OK';
    };
    if (name === 'PING' && args.length === 0) return 'PONG';
    if (name === 'GET' && args.length === 1) return value(key(0));
    if (name === 'DEL' && args.length === 1) { const k = key(0), had = !!entries[k]; delete entries[k]; return Number(had); }
    if (name === 'SET' && args.length >= 2) {
      const k = key(0); let nx = false, expires = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === 'NX' && !nx) nx = true;
        else if (['PX', 'EX'].includes(args[i]) && expires === null && integer(args[i + 1]) && Number(args[i + 1]) > 0) { const scale = args[i] === 'PX' ? 1 : 1000; expires = at + Number(args[++i]) * scale; }
        else fail('Unsupported rehearsal SET option');
      }
      if (expires !== null && !integer(expires)) fail('Invalid rehearsal expiry');
      if (nx && entries[k]) return null;
      return put(k, args[1], expires);
    }
    if (name !== 'EVAL') fail('Unsupported local settlement command');
    const [script, count, ...tail] = args;
    if (!Number.isSafeInteger(count) || count < 1 || count > 2 || tail.length < count) fail('Invalid local settlement script');
    const keys = tail.slice(0, count), argv = tail.slice(count);
    if (keys.some(k => !safeKey(k))) fail('Rehearsal script key is outside the settlement namespace');
    if (script === leaseScript && count === 2 && argv.length === 3) {
      const [token, op, data] = argv;
      if (value(keys[0]) !== token) return 0;
      if (op === 'release') { delete entries[keys[0]]; return 1; }
      if (!['renew', 'save'].includes(op)) fail('Invalid monitor lease operation');
      entries[keys[0]].expiresAt = at + 300000;
      if (op === 'save') put(keys[1], data);
      return 1;
    }
    if (quotaScripts.has(script) && count === 1 && argv.length === 0) {
      const previous = value(keys[0]);
      if (previous !== null && !/^(0|[1-9][0-9]*)$/.test(previous)) fail('Invalid evidence quota');
      const n = Number(previous || '0') + 1;
      if (!Number.isSafeInteger(n)) fail('Invalid evidence quota');
      put(keys[0], String(n), entries[keys[0]]?.expiresAt ?? at + (script.includes('7200') ? 7200000 : 60000));
      return n;
    }
    if (script === captureHistoryScript && count === 1 && argv.length === 2) {
      const prior = value(keys[0]), state = prior === null ? { schema: 'flurbo.settlement-captures.v1', entries: [] } : JSON.parse(prior);
      if (state.schema !== 'flurbo.settlement-captures.v1' || !Array.isArray(state.entries)) fail('Invalid capture history');
      const incoming = JSON.parse(argv[1]);
      if (argv[0] === 'attempt') {
        if (state.attempt && state.attempt.at > incoming.at) return 0;
        state.attempt = incoming;
      } else if (argv[0] === 'capture') {
        const existing = state.entries.find(entry => entry.id === incoming.id);
        if (existing) { existing.first = Math.min(existing.first, incoming.first); existing.last = Math.max(existing.last, incoming.last); }
        else { if (state.entries.length >= 50) fail('Capture history capacity reached'); state.entries.push(incoming); }
      } else fail('Invalid capture operation');
      put(keys[0], JSON.stringify(state)); return 1;
    }
    fail('Unsupported local settlement script');
  });
}
