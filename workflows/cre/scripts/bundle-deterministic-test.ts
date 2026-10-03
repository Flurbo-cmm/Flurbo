import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configurePracticeCollections } from '../../../apps/web/server/practice-collections.mjs';
import { validateSettlementManifest } from '../../../apps/web/server/settlement-publication.mjs';
const input = process.argv[2];
if (process.argv.length !== 3 || !input) throw Error('Supply the saved current complete collection bundle path; use an explicit empty array file for a local-only standalone test.');
const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('target/deployments/deterministic-test-testnet.json', root), 'utf8'));
validateSettlementManifest(manifest);
if (!manifest.publication.draft.clusterId.startsWith('usgs-test-v1-')) throw Error('Expected the verified official-source test recipe');
const previous = JSON.parse(await readFile(resolve(input), 'utf8'));
if (!Array.isArray(previous) || previous.some(row => row.manifest?.pool === manifest.pool || row.label === 'Source test')) throw Error('Invalid bundle or source test already registered');
const entries = [...previous, {label: 'Source test', manifest}];
await configurePracticeCollections({env: {FLURBO_PRACTICE_COLLECTIONS_JSON: JSON.stringify(entries), FLURBO_PRACTICE_ACTIVE_POOL: manifest.pool},
  rpcUrl: 'https://testnet-rpc.monad.xyz', command: async () => null});
await writeFile(new URL('target/deployments/deterministic-test-collections.json', root), JSON.stringify(entries, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: 'bundle_ready', pool: manifest.pool, rulesHash: manifest.rulesHash,
  collections: entries.map(row => ({label: row.label, pool: row.manifest.pool})),
  notice: 'No hosting settings changed. Use this complete bundle for the local website and monitor. Never replace a production bundle with an incomplete local bundle.'}, null, 2));
