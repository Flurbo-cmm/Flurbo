import { readFile } from 'node:fs/promises';
import { clients, prepareRealityRelay } from '../server/reality-relay.mjs';

const path = process.argv[2];
if (!path) throw Error('Pass an absolute route JSON path');
const route = JSON.parse(await readFile(path, 'utf8'));
const [source, market] = clients(process.env.REALITY_SOURCE_RPC_URL, process.env.FLURBO_TESTNET_RPC_URL);
const result = await prepareRealityRelay(route, source, market);
if (process.argv[3] === '--check-evidence') {
  if (!result.evidenceURI.startsWith('https://')) throw Error('HTTPS evidence URI required for this check');
  const response = await fetch(result.evidenceURI, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || await response.text() !== result.evidenceJson) throw Error('Published evidence differs from the verified answer');
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
