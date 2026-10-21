import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, getAddress } from 'viem';
import { pacedHttp, verifyHybridDeployment } from './register-hybrid-pool.mjs';
import { conditionalCatalog } from '../server/conditional-market-service.mjs';
import { hybridSettlementCatalog } from '../server/hybrid-settlement-worker.mjs';
import { CONDITIONAL_VERSION, condPoolAbi } from '../shared/conditionals.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const repository = fileURLToPath(new URL('../../../', import.meta.url));

// Registration candidates are reviewed and copied by the operator, so neither script writes under config/.
export function candidatePath(path, cwd = process.cwd(), root = repository) {
  const target = resolve(cwd, path), inside = relative(resolve(root, 'config'), target);
  if (inside === '' || !inside.startsWith('..') && !inside.startsWith(sep) && !/^[a-zA-Z]:/.test(inside))
    throw Error('Write the candidate outside config/ and copy it after review');
  return target;
}

// The hybrid checks of verifyHybridDeployment, then the conditional pricer and version, then both registries together.
export async function verifyConditionalDeployment({ id, prepared, unverified, catalog, hybridCatalog, market, source,
  adapter = null, manager = null, keeper = null, answerer = null, proxyCodeHash }) {
  const current = conditionalCatalog(catalog);
  if (!current.pricer) throw Error('Register the pricer first');
  if (!same(unverified?.pricer, current.pricer) || unverified?.conditionalVersion !== CONDITIONAL_VERSION)
    throw Error('Conditional deployment uses another pricer');
  const record = await verifyHybridDeployment({ id, prepared, unverified, adapter, manager, keeper, answerer, market, source,
    ...(proxyCodeHash ? { proxyCodeHash } : {}) });
  const pool = getAddress(record.pool);
  const [version, pricer] = await Promise.all(['conditionalVersion', 'pricer'].map(functionName =>
    market.readContract({ address: pool, abi: condPoolAbi, functionName })));
  if (Number(version) !== CONDITIONAL_VERSION || !same(pricer, current.pricer)) throw Error('Pool is not a conditional pool on this pricer');
  const candidate = conditionalCatalog({ ...current, pools: [...current.pools, { ...record, conditionalVersion: CONDITIONAL_VERSION }] });
  hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools: [...hybridSettlementCatalog(hybridCatalog).pools, ...candidate.pools] });
  return candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    adapter: { type: 'string' }, manager: { type: 'string' }, keeper: { type: 'string' }, answerer: { type: 'string' } } });
  const [id, preparedPath, unverifiedPath, output] = positionals;
  if (!output || !process.env.FLURBO_TESTNET_RPC_URL?.startsWith('https://')
    || !process.env.FLURBO_SEPOLIA_RPC_URL?.startsWith('https://'))
    throw Error('Usage: FLURBO_TESTNET_RPC_URL and FLURBO_SEPOLIA_RPC_URL, then node register-conditional-pool.mjs ID PREPARED UNVERIFIED OUTPUT [--adapter A --manager M] [--keeper K] [--answerer A]');
  const target = candidatePath(output);
  const [prepared, unverified, catalog, hybridCatalog] = await Promise.all([preparedPath, unverifiedPath,
    'config/conditional-markets.json', 'config/hybrid-markets.json'].map(path => readFile(path, 'utf8').then(JSON.parse)));
  const market = createPublicClient({ transport: pacedHttp(process.env.FLURBO_TESTNET_RPC_URL, { timeout: 20_000 }) });
  const source = createPublicClient({ transport: pacedHttp(process.env.FLURBO_SEPOLIA_RPC_URL, { timeout: 20_000 }) });
  const candidate = await verifyConditionalDeployment({ id, prepared, unverified, catalog, hybridCatalog, market, source,
    adapter: values.adapter, manager: values.manager, keeper: values.keeper, answerer: values.answerer });
  await writeFile(target, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  const record = candidate.pools.at(-1);
  console.log(JSON.stringify({ status: 'verified_conditional_candidate', pool: record.pool, resolver: record.resolver,
    pricer: candidate.pricer, events: record.prepared.draft.events.length, output: target }));
}
