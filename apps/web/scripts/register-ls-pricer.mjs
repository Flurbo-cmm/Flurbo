import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, parseAbi } from 'viem';
import { pacedHttp } from './register-hybrid-pool.mjs';
import { candidatePath } from './register-conditional-pool.mjs';
import { conditionalCatalog } from '../server/conditional-market-service.mjs';
import { LS_PRICER_CODE_HASH, PRICER_VERSION, runtimeCodeHash } from '../shared/conditionals.mjs';

const pricerAbi = parseAbi(['function version() view returns (uint8)']);

// Checks a DeployLsPricer output on chain and returns the conditional catalog with its pricer set. The catalog must
// still be empty: the pricer of a catalog with pools is never replaced.
export async function verifyLsPricer({ deployment, catalog, market, codeHash = LS_PRICER_CODE_HASH }) {
  if (deployment?.schema !== 'flurbo.ls-pricer.v1' || !/^0x[0-9a-fA-F]{40}$/.test(deployment.pricer || '')
    || deployment.version !== PRICER_VERSION) throw Error('Pricer deployment file is invalid');
  const current = conditionalCatalog(catalog);
  if (current.pricer !== null || current.pools.length) throw Error('Conditional catalog already has a pricer');
  if (await market.getChainId() !== 10143) throw Error('Monad RPC chain mismatch');
  const pricer = getAddress(deployment.pricer);
  const [code, version] = await Promise.all([market.getBytecode({ address: pricer }),
    market.readContract({ address: pricer, abi: pricerAbi, functionName: 'version' })]);
  if (runtimeCodeHash(code) !== codeHash) throw Error('Pricer code differs from LsPricer');
  if (Number(version) !== PRICER_VERSION) throw Error('Pricer version mismatch');
  return conditionalCatalog({ ...current, pricer });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [pricerPath, output] = process.argv.slice(2);
  if (!output || !process.env.FLURBO_TESTNET_RPC_URL?.startsWith('https://'))
    throw Error('Usage: FLURBO_TESTNET_RPC_URL, then node register-ls-pricer.mjs PRICER_JSON OUTPUT');
  const target = candidatePath(output);
  const [deployment, catalog] = await Promise.all([readFile(pricerPath, 'utf8').then(JSON.parse),
    readFile('config/conditional-markets.json', 'utf8').then(JSON.parse)]);
  const market = createPublicClient({ transport: pacedHttp(process.env.FLURBO_TESTNET_RPC_URL, { timeout: 20_000 }) });
  const candidate = await verifyLsPricer({ deployment, catalog, market });
  await writeFile(target, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'verified_pricer_candidate', pricer: candidate.pricer, codeHash: LS_PRICER_CODE_HASH, output: target }));
}
