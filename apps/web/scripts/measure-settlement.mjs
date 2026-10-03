import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pilotRpc } from '../server/pilot.mjs';
import { measureSettlement } from '../server/settlement-latency.mjs';

// Read-only. Prints due-to-confirmed latency for every automatic action in the given collections.
// Usage: node apps/web/scripts/measure-settlement.mjs [path/to/manifest-or-bundle.json ...]
const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function runMeasurement({ paths = process.argv.slice(2), env = process.env } = {}) {
  const files = paths.length ? paths : ['config/pilot-testnet.json', 'target/deployments/showcase-v0-collections.json'];
  const manifests = [];
  for (const file of files) {
    const value = JSON.parse(await readFile(resolve(root, file), 'utf8'));
    manifests.push(...(Array.isArray(value) ? value.map(r => r.manifest || r) : [value.manifest || value]));
  }
  const rpc = pilotRpc(env.FLURBO_ALCHEMY_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz');
  const signer = env.FLURBO_RESOLUTION_SIGNER_ADDRESS || '0x632a158d5eccc10f864ab94cec99511e1cc514f3';
  const results = [];
  for (const manifest of manifests) {
    try { results.push(await measureSettlement({ manifest, rpc, signer })); }
    catch { results.push({ pool: manifest.pool, error: 'measurement-failed' }); }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMeasurement().then(r => console.log(JSON.stringify(r, null, 2))).catch(() => { console.error('{"error":"measurement-failed"}'); process.exitCode = 1; });
}
