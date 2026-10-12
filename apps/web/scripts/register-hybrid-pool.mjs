import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { hybridRulesHash, isLsPrepared } from './prepare-hybrid-pilot.mjs';
import { inspectRealityQuestion } from './inspect-reality-question.mjs';
import { hybridSettlementCatalog, readHybridSnapshot } from '../server/hybrid-settlement-worker.mjs';
import { verifyKlerosProxy } from '../server/hybrid-reality.mjs';
import { KLEROS_PROXY_CODE_HASH, SEPOLIA_KLEROS } from '../server/oracle-integration.mjs';

const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const adapterAbi = parseAbi(['function manager() view returns (address)',
  'function arbitrator() view returns (address)', 'function extraData() view returns (bytes)',
  'function arbitrationCost() view returns (uint256)']);
const proxyAbi = parseAbi(['function arbitrator() view returns (address)',
  'function arbitratorExtraData() view returns (bytes)']);

export async function verifyHybridDeployment({ id, prepared, unverified, adapter = null, manager = null,
  answerer = null, keeper = null, market, source, proxyCodeHash = KLEROS_PROXY_CODE_HASH }) {
  const events = prepared?.draft?.events || [];
  const mechanical = events.some(event => event.route === 'mechanical');
  const reality = events.some(event => event.route === 'reality');
  const answered = events.some(event => event.route === 'reality' && event.rule);
  if (mechanical !== (address(adapter) && address(manager))
    || (reality && !address(keeper)) || (answered && !address(answerer))
    || (answered && [prepared.creator, prepared.proposer, prepared.relay].some(role => same(role, answerer)))
    || (reality && same(keeper, prepared.relay)))
    throw Error('Hybrid deployment roles incomplete');
  const ls = isLsPrepared(prepared);
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
    || unverified?.schema !== (ls ? 'flurbo.hybrid-manifest.v5' : 'flurbo.hybrid-manifest.v4')
    || (ls && (unverified.commissionBps !== prepared.commissionBps
      || String(unverified.initialDepthAtoms) !== prepared.liquidityAtoms))
    || unverified.status !== 'unverified_deployment' || !address(unverified.pool)
    || !address(unverified.resolver) || !same(unverified.creator, prepared?.creator)
    || !same(unverified.proposer, prepared?.proposer)
    || !same(unverified.relay, prepared?.relay)
    || !same(unverified.draftHash, prepared?.draftHash)
    || !same(unverified.configHash, prepared?.configHash)
    || !same(unverified.rulesHash, hybridRulesHash(prepared, unverified.resolver)))
    throw Error('Hybrid deployment manifest differs from the prepared publication');
  if (await source.getChainId() !== 11155111) throw Error('Sepolia RPC chain mismatch');
  for (const event of events) {
    if (event.route !== 'reality') continue;
    const s = event.source;
    const found = await inspectRealityQuestion(source, { txHash: s.questionTxHash,
      creator: prepared.creator, questionText: s.questionText, opening: event.observationEndsAt,
      minTimeout: s.minTimeout, arbitrator: s.arbitrator });
    if (!same(found.questionId, s.questionId) || !same(found.contentHash, s.contentHash)
      || found.minBond !== s.minBond) throw Error('Reality question differs from the publication');
  }
  const arbitrators = [...new Set(events.filter(event => event.route === 'reality')
    .map(event => event.source.arbitrator.toLowerCase()))];
  for (const proxy of arbitrators) await verifyKlerosProxy(source, proxy, proxyCodeHash);
  const block = await market.getBlock();
  if (mechanical) {
    const [court, proxyCourt, extraData, proxyExtraData, caseManager, fee, code] = await Promise.all([
      source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'arbitrator' }),
      source.readContract({ address: SEPOLIA_KLEROS, abi: proxyAbi, functionName: 'arbitrator' }),
      source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'extraData' }),
      source.readContract({ address: SEPOLIA_KLEROS, abi: proxyAbi, functionName: 'arbitratorExtraData' }),
      source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'manager' }),
      source.readContract({ address: getAddress(adapter), abi: adapterAbi, functionName: 'arbitrationCost' }),
      source.getBytecode({ address: getAddress(adapter) }),
    ]);
    if (!same(court, proxyCourt)
      || !same(extraData, proxyExtraData) || !same(caseManager, manager)
      || !code || code === '0x' || fee <= 0n)
      throw Error('Kleros adapter does not match the Sepolia Reality court');
  }
  if (!block?.hash || typeof block.number !== 'bigint') throw Error('Hybrid market block unavailable');
  const record = { id, pool: unverified.pool, resolver: unverified.resolver,
    rulesHash: unverified.rulesHash, deploymentBlock: Number(block.number),
    ...(mechanical ? { adapter, manager } : {}), ...(reality ? { keeper } : {}),
    ...(answered ? { answerer } : {}), prepared };
  hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools: [record] });
  await readHybridSnapshot(record, market);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    adapter: { type: 'string' }, manager: { type: 'string' }, keeper: { type: 'string' },
    answerer: { type: 'string' } } });
  const [id, preparedPath, unverifiedPath, output] = positionals;
  if (!output || !process.env.FLURBO_TESTNET_RPC_URL?.startsWith('https://')
    || !process.env.FLURBO_SEPOLIA_RPC_URL?.startsWith('https://'))
    throw Error('Usage: FLURBO_TESTNET_RPC_URL and FLURBO_SEPOLIA_RPC_URL, then node register-hybrid-pool.mjs ID PREPARED UNVERIFIED OUTPUT [--adapter A --manager M] [--keeper K] [--answerer A]');
  const [prepared, unverified, existing] = await Promise.all([
    readFile(preparedPath, 'utf8').then(JSON.parse),
    readFile(unverifiedPath, 'utf8').then(JSON.parse),
    readFile('config/hybrid-markets.json', 'utf8').then(JSON.parse),
  ]);
  hybridSettlementCatalog(existing);
  const market = createPublicClient({ transport: http(process.env.FLURBO_TESTNET_RPC_URL, { timeout: 20_000 }) });
  const source = createPublicClient({ transport: http(process.env.FLURBO_SEPOLIA_RPC_URL, { timeout: 20_000 }) });
  const record = await verifyHybridDeployment({ id, prepared, unverified, adapter: values.adapter,
    manager: values.manager, keeper: values.keeper, answerer: values.answerer, market, source });
  const candidate = hybridSettlementCatalog({ ...existing, pools: [...existing.pools, record] });
  await writeFile(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'verified_hybrid_candidate', pool: record.pool,
    resolver: record.resolver, adapter: record.adapter ?? null, keeper: record.keeper ?? null,
    answerer: record.answerer ?? null, events: record.prepared.draft.events.length,
    arbitrators: [...new Set(record.prepared.draft.events.filter(event => event.route === 'reality')
      .map(event => event.source.arbitrator.toLowerCase()))], output }));
}
