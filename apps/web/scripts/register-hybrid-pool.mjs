import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { hybridRulesHash } from './prepare-hybrid-pilot.mjs';
import { hybridSettlementCatalog, readHybridSnapshot } from '../server/hybrid-settlement-worker.mjs';
import { SEPOLIA_KLEROS } from '../server/oracle-integration.mjs';

const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const adapterAbi = parseAbi(['function manager() view returns (address)',
  'function arbitrator() view returns (address)', 'function extraData() view returns (bytes)',
  'function arbitrationCost() view returns (uint256)']);
const proxyAbi = parseAbi(['function arbitrator() view returns (address)',
  'function arbitratorExtraData() view returns (bytes)']);

export async function verifyHybridDeployment({ id, prepared, unverified, adapter, manager,
  market, source }) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
    || !address(adapter) || !address(manager)
    || unverified?.schema !== 'flurbo.hybrid-manifest.v4'
    || unverified.status !== 'unverified_deployment' || !address(unverified.pool)
    || !address(unverified.resolver) || !same(unverified.creator, prepared?.creator)
    || !same(unverified.proposer, prepared?.proposer)
    || !same(unverified.relay, prepared?.relay)
    || !same(unverified.draftHash, prepared?.draftHash)
    || !same(unverified.configHash, prepared?.configHash)
    || !same(unverified.rulesHash, hybridRulesHash(prepared, unverified.resolver)))
    throw Error('Hybrid deployment manifest differs from the prepared publication');
  if (await source.getChainId() !== 11155111) throw Error('Sepolia RPC chain mismatch');
  const [block, court, proxyCourt, extraData, proxyExtraData, caseManager, fee, code] = await Promise.all([
    market.getBlock(),
    source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'arbitrator' }),
    source.readContract({ address: SEPOLIA_KLEROS, abi: proxyAbi, functionName: 'arbitrator' }),
    source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'extraData' }),
    source.readContract({ address: SEPOLIA_KLEROS, abi: proxyAbi, functionName: 'arbitratorExtraData' }),
    source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'manager' }),
    source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'arbitrationCost' }),
    source.getBytecode({ address: getAddress(adapter) }),
  ]);
  if (!block?.hash || typeof block.number !== 'bigint' || !same(court, proxyCourt)
    || !same(extraData, proxyExtraData) || !same(caseManager, manager)
    || !code || code === '0x' || fee <= 0n)
    throw Error('Kleros adapter does not match the Sepolia Reality court');
  const record = { id, pool: unverified.pool, resolver: unverified.resolver,
    rulesHash: unverified.rulesHash, deploymentBlock: Number(block.number), adapter, manager,
    prepared };
  hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools: [record] });
  await readHybridSnapshot(record, market);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [id, preparedPath, unverifiedPath, adapter, manager, output] = process.argv.slice(2);
  if (!output || !process.env.FLURBO_TESTNET_RPC_URL?.startsWith('https://')
    || !process.env.FLURBO_SEPOLIA_RPC_URL?.startsWith('https://'))
    throw Error('Usage: FLURBO_TESTNET_RPC_URL and FLURBO_SEPOLIA_RPC_URL, then node register-hybrid-pool.mjs ID PREPARED UNVERIFIED ADAPTER MANAGER OUTPUT');
  const [prepared, unverified, existing] = await Promise.all([
    readFile(preparedPath, 'utf8').then(JSON.parse),
    readFile(unverifiedPath, 'utf8').then(JSON.parse),
    readFile('config/hybrid-markets.json', 'utf8').then(JSON.parse),
  ]);
  hybridSettlementCatalog(existing);
  const market = createPublicClient({ transport: http(process.env.FLURBO_TESTNET_RPC_URL, { timeout: 20_000 }) });
  const source = createPublicClient({ transport: http(process.env.FLURBO_SEPOLIA_RPC_URL, { timeout: 20_000 }) });
  const record = await verifyHybridDeployment({ id, prepared, unverified, adapter, manager, market, source });
  const candidate = hybridSettlementCatalog({ ...existing, pools: [...existing.pools, record] });
  await writeFile(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'verified_hybrid_candidate', pool: record.pool,
    resolver: record.resolver, adapter: record.adapter, events: record.prepared.draft.events.length,
    output }));
}
