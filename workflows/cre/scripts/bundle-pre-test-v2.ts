import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configurePracticeCollections } from '../../../apps/web/server/practice-collections.mjs';
import { validateSettlementManifest } from '../../../apps/web/server/settlement-publication.mjs';
// Adds the verified pre-test-v2 manifest to a saved copy of the current production collection bundle.
const input = process.argv[2];
if (process.argv.length !== 3 || !input) throw Error('Supply the saved current production collection bundle (FLURBO_PRACTICE_COLLECTIONS_JSON) as a file.');
const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('target/deployments/pre-test-v2-testnet.json', root), 'utf8'));
validateSettlementManifest(manifest);
if (!manifest.publication.draft.clusterId.startsWith('pre-test-v2-')) throw Error('Expected the verified pre-test-v2 manifest');
const previous = JSON.parse(await readFile(resolve(input), 'utf8'));
if (!Array.isArray(previous) || previous.some(row => row.manifest?.pool === manifest.pool || row.label === 'pre-test-v2')) throw Error('Invalid bundle or pre-test-v2 already registered');
const entries = [...previous, { label: 'pre-test-v2', manifest }];
await configurePracticeCollections({ env: { FLURBO_PRACTICE_COLLECTIONS_JSON: JSON.stringify(entries), FLURBO_PRACTICE_ACTIVE_POOL: manifest.pool },
  rpcUrl: 'https://testnet-rpc.monad.xyz', command: async () => null });
await writeFile(new URL('target/deployments/pre-test-v2-collections.json', root), JSON.stringify(entries) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'bundle_ready', pool: manifest.pool, rulesHash: manifest.rulesHash, collections: entries.map(row => ({ label: row.label, pool: row.manifest.pool })) }, null, 2));
