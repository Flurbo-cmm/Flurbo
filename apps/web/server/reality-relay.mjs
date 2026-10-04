import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, toHex } from 'viem';
import { wideCommitments } from '../scripts/prepare-wide-pilot.mjs';

export const realityAbi = parseAbi([
  'function getFinalAnswerIfMatches(bytes32,bytes32,address,uint32,uint256) view returns (bytes32)',
]);
export const wideResolverAbi = parseAbi([
  'function protocolVersion() pure returns (uint8)',
  'function rulesHash() view returns (bytes32)',
  'function pool() view returns (address)',
  'function relay() view returns (address)',
  'function eventHashes(uint256) view returns (bytes32)',
  'function observationEnds(uint256) view returns (uint64)',
  'function reportDeadline(uint8) view returns (uint64)',
  'function eventCount() view returns (uint8)',
  'function caseState(uint8) view returns ((uint8 phase,uint8 result,bytes32 evidenceHash))',
  'function reportFinal(uint8,uint8,bytes32,string)',
]);
export const widePoolAbi = parseAbi([
  'function protocolVersion() pure returns (uint8)',
  'function collateral() view returns (address)',
  'function resolver() view returns (address)',
  'function eventCount() view returns (uint8)',
  'function funded() view returns (bool)',
]);

const hex32 = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
const nonZeroHash = value => hex32(value) && !/^0x0{64}$/i.test(value);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const cleanUrl = value => {
  try {
    const url = new URL(value);
    return value.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(value) && !url.username && !url.password
      && ((url.protocol === 'https:' && url.hostname) || (url.protocol === 'ipfs:' && url.hostname));
  } catch { return false; }
};

export function validateRealityRoute(route) {
  if (!route || route.schema !== 'flurbo.reality-route.v2' || route.sourceChainId !== 11155111
    || route.marketChainId !== 10143 || !address(route.reality) || !address(route.arbitrator)
    || !address(route.pool) || !address(route.resolver) || !address(route.relay)
    || !nonZeroHash(route.questionId) || !nonZeroHash(route.contentHash)
    || !nonZeroHash(route.rulesHash) || !nonZeroHash(route.eventHash)
    || !Number.isInteger(route.eventIndex) || route.eventIndex < 0 || route.eventIndex > 31
    || !Number.isInteger(route.minTimeout) || route.minTimeout < 3600
    || typeof route.minBond !== 'string' || !/^[1-9][0-9]*$/.test(route.minBond)
    || !(cleanUrl(route.evidenceURI) || cleanUrl(route.evidenceOrigin))) throw Error('Invalid Reality route');
  const publication = route.publication;
  const event = publication?.events?.[route.eventIndex];
  const source = event?.source;
  if (publication?.schema !== 'flurbo.wide-publication.v3'
    || publication.chainId !== route.marketChainId
    || publication.trustModel !== 'trusted-source-relay'
    || !Array.isArray(publication.events) || publication.events.length < 2
    || publication.events.length > 32 || !same(publication.relay ?? '', route.relay)
    || source?.kind !== 'reality-sepolia' || source.chainId !== route.sourceChainId
    || !same(source.reality ?? '', route.reality)
    || !same(source.arbitrator ?? '', route.arbitrator)
    || !same(source.questionId ?? '', route.questionId)
    || !same(source.contentHash ?? '', route.contentHash)
    || source.minTimeout !== route.minTimeout || source.minBond !== route.minBond)
    throw Error('Reality publication binding mismatch');
  let committed;
  try { committed = wideCommitments(publication).eventHashes[route.eventIndex]; }
  catch { throw Error('Reality publication binding mismatch'); }
  if (!hex32(committed) || !same(committed, route.eventHash))
    throw Error('Reality publication binding mismatch');
  return route;
}

export function realityOutcome(answer) {
  if (!hex32(answer)) throw Error('Reality answer is malformed');
  const value = BigInt(answer);
  if (value === 0n) return 1;
  if (value === 1n) return 2;
  if (value === (1n << 256n) - 1n) return 3;
  throw Error('Reality answer is not boolean or invalid');
}

export async function prepareRealityRelay(route, source, market) {
  validateRealityRoute(route);
  const [sourceChain, marketChain] = await Promise.all([source.getChainId(), market.getChainId()]);
  if (sourceChain !== route.sourceChainId || marketChain !== route.marketChainId) throw Error('RPC chain mismatch');
  const sourceBlock = await source.getBlock({ blockTag: 'finalized' });
  if (typeof sourceBlock?.number !== 'bigint' || !nonZeroHash(sourceBlock.hash)) throw Error('Finalized source block unavailable');
  const read = (client, contract, abi, functionName, args = [], blockNumber) =>
    client.readContract({ address: getAddress(contract), abi, functionName, args,
      ...(blockNumber === undefined ? {} : { blockNumber }) });
  const [answer, version, rulesHash, pool, relay, eventCount, eventHash, observationEnds,
    reportDeadline, caseState, poolVersion, poolCollateral, poolResolver, poolCount, funded] = await Promise.all([
    read(source, route.reality, realityAbi, 'getFinalAnswerIfMatches',
      [route.questionId, route.contentHash, getAddress(route.arbitrator), route.minTimeout, BigInt(route.minBond)], sourceBlock.number),
    read(market, route.resolver, wideResolverAbi, 'protocolVersion'),
    read(market, route.resolver, wideResolverAbi, 'rulesHash'),
    read(market, route.resolver, wideResolverAbi, 'pool'),
    read(market, route.resolver, wideResolverAbi, 'relay'),
    read(market, route.resolver, wideResolverAbi, 'eventCount'),
    read(market, route.resolver, wideResolverAbi, 'eventHashes', [BigInt(route.eventIndex)]),
    read(market, route.resolver, wideResolverAbi, 'observationEnds', [BigInt(route.eventIndex)]),
    read(market, route.resolver, wideResolverAbi, 'reportDeadline', [route.eventIndex]),
    read(market, route.resolver, wideResolverAbi, 'caseState', [route.eventIndex]),
    read(market, route.pool, widePoolAbi, 'protocolVersion'),
    read(market, route.pool, widePoolAbi, 'collateral'),
    read(market, route.pool, widePoolAbi, 'resolver'),
    read(market, route.pool, widePoolAbi, 'eventCount'),
    read(market, route.pool, widePoolAbi, 'funded'),
  ]);
  if (version !== 3 || poolVersion !== 3
    || !same(poolCollateral, '0xa9012a055bd4e0edff8ce09f960291c09d5322dc')
    || !same(rulesHash, route.rulesHash)
    || !same(pool, route.pool) || !same(poolResolver, route.resolver) || !same(relay, route.relay)
    || !same(eventHash, route.eventHash) || eventCount !== poolCount
    || eventCount !== route.publication.events.length || route.eventIndex >= eventCount
    || BigInt(route.publication.events[route.eventIndex].observationEndsAt) !== observationEnds
    || !funded || Number(caseState.phase ?? caseState[0]) !== 0) throw Error('New pool binding or phase mismatch');
  const head = await market.getBlock();
  if (head.timestamp < observationEnds || head.timestamp >= reportDeadline) throw Error('Outside report window');
  const outcome = realityOutcome(answer);
  const evidence = {
    schema: 'flurbo.reality-evidence.v2', sourceChainId: route.sourceChainId,
    sourceBlockNumber: sourceBlock.number.toString(), sourceBlockHash: sourceBlock.hash.toLowerCase(),
    reality: getAddress(route.reality), arbitrator: getAddress(route.arbitrator),
    questionId: route.questionId.toLowerCase(), contentHash: route.contentHash.toLowerCase(),
    finalAnswer: answer.toLowerCase(), minTimeout: route.minTimeout, minBond: route.minBond,
    marketChainId: route.marketChainId, pool: getAddress(route.pool),
    resolver: getAddress(route.resolver), relay: getAddress(route.relay),
    rulesHash: route.rulesHash.toLowerCase(), eventIndex: route.eventIndex,
    eventHash: route.eventHash.toLowerCase(),
  };
  const evidenceJson = JSON.stringify(evidence);
  const evidenceHash = keccak256(toHex(evidenceJson));
  const evidenceURI = route.evidenceOrigin
    ? route.evidenceOrigin + '/api/oracle/evidence/' + evidenceHash : route.evidenceURI;
  if (!cleanUrl(evidenceURI)) throw Error('Invalid relay evidence URI');
  const data = encodeFunctionData({ abi: wideResolverAbi, functionName: 'reportFinal',
    args: [route.eventIndex, outcome, evidenceHash, evidenceURI] });
  return { outcome, evidence, evidenceJson, evidenceHash, evidenceURI, relay: getAddress(route.relay),
    transaction: { to: getAddress(route.resolver), data } };
}

export function clients(sourceRpc, marketRpc) {
  if (!sourceRpc?.startsWith('https://') || !marketRpc?.startsWith('https://')) throw Error('HTTPS RPC URLs required');
  return [createPublicClient({ transport: http(sourceRpc) }), createPublicClient({ transport: http(marketRpc) })];
}
