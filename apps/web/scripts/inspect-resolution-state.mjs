import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { redisCommand } from '../server/redis-session.mjs';
import { monitorIdentity } from '../server/settlement-monitor.mjs';
import { jsonRpc } from '../server/settlement-alarm.mjs';

// Read-only pre-push inspection of the worker journal, signer lease and per-pool monitor state.
// Only GET and PTTL reach Redis. Raw signed transactions, credentials and endpoints are never printed.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const READ_ONLY = new Set(['GET', 'PTTL']);
const hashKey = identity => 'flurbo:monitor:v1:' + createHash('sha256').update(identity).digest('hex');
const iso = t => Number.isFinite(t) ? new Date(t * 1000).toISOString() : null;

export function readOnly(command) {
  return (op, ...args) => { if (!READ_ONLY.has(op)) throw new Error('Inspection is read-only'); return command(op, ...args); };
}

export async function inspectResolutionState({ command, rpc, manifests, signer, now = Math.floor(Date.now() / 1000) }) {
  const read = readOnly(command);
  const journalKey = hashKey('resolution-worker-v1:' + signer.toLowerCase());
  const raw = await read('GET', journalKey + ':state');
  const stored = raw ? JSON.parse(raw) : null;
  const book = stored?.schema === 'flurbo.resolution-journals.v2' ? stored.pools : stored ? { [stored.pool]: stored } : {};
  const pools = [];
  for (const entry of Object.values(book || {})) {
    let chain = null;
    if (entry?.pending?.hash) {
      try {
        const receipt = await rpc('eth_getTransactionReceipt', [entry.pending.hash]);
        chain = receipt ? { included: true, success: receipt.status === '0x1', block: String(BigInt(receipt.blockNumber)) } : { included: false };
      } catch { chain = { included: 'unknown' }; }
    }
    pools.push({ pool: entry?.pool ?? null, schema: entry?.schema ?? null,
      pending: entry?.pending ? { hash: entry.pending.hash, action: entry.pending.action ?? null, event: entry.pending.event ?? null, outcome: entry.pending.outcome ?? null, chain } : null,
      ownedEvents: Object.keys(entry?.owned || {}).map(Number),
      owned: Object.fromEntries(Object.entries(entry?.owned || {}).map(([event, value]) => [event, { outcome: value?.outcome, evidenceHash: value?.evidenceHash }])),
      deferred: Object.fromEntries(Object.entries(entry?.deferred || {}).map(([k, v]) => [k, iso(v)])),
      last: entry?.last ? { hash: entry.last.hash, success: entry.last.success, at: iso(entry.last.at) } : null });
  }
  const leaseMs = await read('PTTL', journalKey + ':lock');
  const monitors = [];
  for (const m of manifests) {
    const key = hashKey(monitorIdentity(m));
    const state = JSON.parse(await read('GET', key + ':state') || 'null');
    const checkedAt = state?.checkpoint?.checkedAt;
    monitors.push({ pool: m.pool, status: state?.report?.status ?? null, checkedAt: iso(checkedAt),
      ageSeconds: Number.isSafeInteger(checkedAt) ? now - checkedAt : null, queued: Array.isArray(state?.queue) ? state.queue.length : null,
      identityMatches: state?.checkpoint ? state.checkpoint.identity === monitorIdentity(m) : null });
  }
  return { signer: signer.toLowerCase(), journal: stored ? { schema: stored.schema ?? 'legacy-single-pool', pools } : null,
    signerLease: leaseMs > 0 ? { held: true, expiresInSeconds: Math.ceil(leaseMs / 1000) } : { held: false },
    anyPending: pools.some(p => p.pending), monitors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
    const bundle = await json('target/deployments/showcase-v0-collections.json');
    const manifests = [await json('config/pilot-testnet.json'), ...bundle.map(r => r.manifest || r)];
    const result = await inspectResolutionState({ command: redisCommand(process.env), rpc: jsonRpc('https://testnet-rpc.monad.xyz'), manifests,
      signer: process.env.FLURBO_RESOLUTION_SIGNER_ADDRESS || '0x632a158d5eccc10f864ab94cec99511e1cc514f3' });
    console.log(JSON.stringify(result, null, 2));
  })().catch(() => { console.error('{"error":"inspection-failed","message":"Check Upstash REST credentials in this shell. Details withheld."}'); process.exitCode = 1; });
}
