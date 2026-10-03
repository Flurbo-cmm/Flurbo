import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configurePracticeCollections } from '../../../apps/web/server/practice-collections.mjs';
import { validateSettlementManifest } from '../../../apps/web/server/settlement-publication.mjs';

const args = process.argv.slice(2);
if (args.length !== 2) throw Error('Usage: bun scripts/bundle-wave2.ts <f2|f3> <path-to-collections.json>');
const poolName = args[0].toLowerCase();
const input = args[1];

if (!['f2', 'f3'].includes(poolName)) throw Error('Invalid pool name. Supported: f2, f3');

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL(`target/deployments/wave2-${poolName}-testnet.json`, root), 'utf8'));
validateSettlementManifest(manifest);
if (!manifest.publication.draft.clusterId.startsWith(`wave2-${poolName}-`)) throw Error(`Expected the verified wave2-${poolName} manifest`);

const previous = JSON.parse(await readFile(resolve(input), 'utf8'));
if (!Array.isArray(previous) || previous.some(row => row.manifest?.pool === manifest.pool || row.label === `wave2-${poolName}`)) throw Error(`Invalid bundle or wave2-${poolName} already registered`);

const entries = [...previous, { label: `wave2-${poolName}`, manifest }];
// Setting the active pool as requested (only if F3, otherwise keep as is or let operator decide).
// The plan says F3 is the active pool for 4 Oct.
const activePool = poolName === 'f3' ? manifest.pool : previous.find(p => p.label === 'wave2-f3')?.manifest.pool || manifest.pool;

await configurePracticeCollections({ env: { FLURBO_PRACTICE_COLLECTIONS_JSON: JSON.stringify(entries), FLURBO_PRACTICE_ACTIVE_POOL: activePool },
  rpcUrl: 'https://testnet-rpc.monad.xyz', command: async () => null });
await writeFile(new URL(`target/deployments/wave2-${poolName}-collections.json`, root), JSON.stringify(entries) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'bundle_ready', pool: manifest.pool, rulesHash: manifest.rulesHash, collections: entries.map(row => ({ label: row.label, pool: row.manifest.pool })) }, null, 2));
