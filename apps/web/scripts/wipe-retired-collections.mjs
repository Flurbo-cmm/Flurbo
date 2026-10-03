import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { redisCommand } from '../server/redis-session.mjs';
import { monitorIdentity } from '../server/settlement-monitor.mjs';

// One-off removal of stored server data for the collections in config/retired-collections.json.
// Contracts, on-chain holdings, accounts, wallet links and agents are not touched. Dry run by
// default; --delete removes exactly the listed keys. Stored values are never printed.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
// Only per-market data under these prefixes is deleted. Any other key that mentions a retired
// pool is reported for manual review and left in place.
const DELETABLE = ['flurbo:pilot:index:', 'flurbo:pilot:payouts:', 'flurbo:pilot:evidence:', 'flurbo:prices:', 'flurbo:monitor:', 'flurbo:activity:', 'flurbo:evidence-beta:'];

export function retiredKeys(m) {
  const monitor = 'flurbo:monitor:v1:' + sha(monitorIdentity(m));
  return [`flurbo:pilot:index:v1:${m.pool}`, `flurbo:pilot:payouts:v1:${m.pool}`, 'flurbo:prices:v1:' + sha(`${m.chainId}:${m.pool}:${m.rulesHash}`),
    `${monitor}:state`, `${monitor}:lock`, `flurbo:activity:v1:${m.pool}:${m.rulesHash}`];
}

async function scan(command, pattern) {
  const keys = [];
  let cursor = '0';
  do { const [next, batch] = await command('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500); cursor = String(next); keys.push(...batch); } while (cursor !== '0');
  return keys;
}

export async function findRetiredData({ command, manifests, keep }) {
  const kept = new Set(keep.map(pool => pool.toLowerCase()));
  for (const m of manifests) if (!/^0x[0-9a-f]{40}$/.test(m.pool) || kept.has(m.pool)) throw Error('Refusing to touch a kept or invalid collection');
  const found = new Map();
  const add = (key, pool, reason) => { if (!found.has(key)) found.set(key, { key, pool, reason, deletable: DELETABLE.some(p => key.startsWith(p)) }); };
  for (const m of manifests) {
    for (const key of retiredKeys(m)) if (Number(await command('EXISTS', key)) === 1) add(key, m.pool, 'market data');
    for (const key of await scan(command, `flurbo:*${m.pool}*`)) add(key, m.pool, 'key names the pool');
  }
  // Evidence is content addressed; its body names the collection's draft.
  const drafts = new Map(manifests.map(m => [m.draftHash, m.pool]));
  for (const key of await scan(command, 'flurbo:pilot:evidence:v1:0x*')) {
    let draft = null;
    try { draft = JSON.parse(await command('GET', key))?.draftHash; } catch { /* Not evidence; leave it. */ }
    if (drafts.has(draft)) add(key, drafts.get(draft), 'published evidence');
  }
  return [...found.values()];
}

export async function wipeRetiredCollections({ command, retired, keep, remove = false }) {
  const rows = await findRetiredData({ command, manifests: retired.map(c => c.manifest), keep });
  let deleted = 0;
  if (remove) for (const row of rows) if (row.deletable) deleted += Number(await command('DEL', row.key));
  return { mode: remove ? 'deleted' : 'dry-run', collections: retired.map(c => ({ label: c.label, pool: c.manifest.pool })),
    keys: rows, deletable: rows.filter(r => r.deletable).length, deleted, leftForReview: rows.filter(r => !r.deletable).map(r => r.key) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length === 1 && args[0] !== '--delete') throw Error('usage');
    const record = JSON.parse(await readFile(resolve(root, 'config/retired-collections.json'), 'utf8'));
    const pilot = JSON.parse(await readFile(resolve(root, 'config/pilot-testnet.json'), 'utf8'));
    if (record.schema !== 'flurbo.retired-collections.v1') throw Error('record');
    const result = await wipeRetiredCollections({ command: redisCommand(process.env), retired: record.collections,
      keep: [pilot.pool, ...record.keep], remove: args[0] === '--delete' });
    console.log(JSON.stringify(result, null, 2));
  })().catch(error => {
    console.error(JSON.stringify({ error: 'wipe-failed', message: error.message === 'usage' ? 'Usage: node apps/web/scripts/wipe-retired-collections.mjs [--delete]'
      : 'Check Upstash REST credentials in this shell and config/retired-collections.json. Details withheld.' }));
    process.exitCode = 1;
  });
}
