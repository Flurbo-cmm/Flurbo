import { readFile, writeFile } from 'node:fs/promises';
import { decodeEventLog, parseAbiItem } from 'viem';
import { oracleCatalog, oracleClients, oracleService, SEPOLIA_KLEROS, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';
import { prepareWidePilot } from './prepare-wide-pilot.mjs';

const newQuestion = parseAbiItem('event LogNewQuestion(bytes32 indexed question_id,address indexed user,uint256 template_id,string question,bytes32 indexed content_hash,address arbitrator,uint32 timeout,uint32 opening_ts,uint256 nonce,uint256 created)');
const txHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hasCode = value => typeof value === 'string' && value !== '0x';

async function poolDeploymentBlock(market, pool, specified) {
  const head = await market.getBlockNumber();
  if (specified !== undefined) {
    const block = BigInt(specified);
    if (block < 0n || block > head || !hasCode(await market.getBytecode({ address: pool, blockNumber: block }))
      || block > 0n && hasCode(await market.getBytecode({ address: pool, blockNumber: block - 1n })))
      throw Error('Pool deployment block does not match the on-chain code');
    return Number(block);
  }
  let low = head > 1_000_000n ? head - 1_000_000n : 0n, high = head;
  if (hasCode(await market.getBytecode({ address: pool, blockNumber: low })))
    throw Error('Pool deployment is older than the search window; provide its exact deployment block');
  if (!hasCode(await market.getBytecode({ address: pool, blockNumber: high })))
    throw Error('Pool code is missing on Monad');
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (hasCode(await market.getBytecode({ address: pool, blockNumber: middle }))) high = middle;
    else low = middle;
  }
  return Number(high);
}

export async function registerOraclePool({ prepared, manifest, existing, origin, source, market, deploymentBlock: specifiedDeploymentBlock }) {
  if (prepared?.schema !== 'flurbo.wide-prepared.v3' || manifest?.schema !== 'flurbo.wide-manifest.v3'
    || manifest.status !== 'unverified_deployment' || !/^https:\/\/[a-z0-9.-]+$/i.test(origin || '')
    || !same(prepared.creator, manifest.creator) || !same(prepared.configHash, manifest.configHash)
    || !same(prepared.draftHash, manifest.draftHash) || !same(prepared.publication.relay, manifest.relay)
    || Number(manifest.eventCount) !== prepared.publication.events.length)
    throw Error('Prepared publication and deployment manifest mismatch');
  const recheck = prepareWidePilot(prepared.publication, Math.min(Date.now() / 1000,
    prepared.publication.closesAt - 3601));
  if (!same(recheck.draftHash, prepared.draftHash) || !same(recheck.configHash, prepared.configHash))
    throw Error('Publication commitments changed');
  const deploymentBlock = await poolDeploymentBlock(market, manifest.pool, specifiedDeploymentBlock);
  const routes = prepared.publication.events.map((event, i) => {
    const s = event.source;
    if (s.kind !== 'reality-sepolia' || !same(s.reality, SEPOLIA_REALITY)
      || !same(s.arbitrator, SEPOLIA_KLEROS) || !txHash(s.questionTxHash)
      || s.questionText !== event.question + '\u241fflurbo-poc\u241fen') throw Error('All PoC questions need pinned Reality and Kleros');
    return { schema: 'flurbo.reality-route.v2', id: `oracle-${manifest.pool.slice(2, 10).toLowerCase()}-${i}`,
      sourceChainId: 11155111, marketChainId: 10143, reality: s.reality,
      arbitrator: s.arbitrator, pool: manifest.pool, deploymentBlock, resolver: manifest.resolver,
      relay: manifest.relay, questionId: s.questionId, contentHash: s.contentHash,
      rulesHash: manifest.rulesHash, eventHash: prepared.eventHashes[i], eventIndex: i,
      minTimeout: s.minTimeout, minBond: s.minBond, evidenceOrigin: origin,
      publication: prepared.publication };
  });
  for (const event of prepared.publication.events) {
    const s = event.source;
    const receipt = await source.getTransactionReceipt({ hash: s.questionTxHash });
    if (receipt.status !== 'success') throw Error('Reality question transaction failed');
    let found = false;
    for (const log of receipt.logs) {
      if (!same(log.address, SEPOLIA_REALITY)) continue;
      try {
        const decoded = decodeEventLog({ abi: [newQuestion], data: log.data, topics: log.topics });
        const a = decoded.args;
        if (same(a.question_id, s.questionId) && same(a.content_hash, s.contentHash)
          && same(a.arbitrator, SEPOLIA_KLEROS) && same(a.user, prepared.creator)
          && a.template_id === 0n && a.question === s.questionText
          && Number(a.timeout) >= s.minTimeout && Number(a.opening_ts) === event.observationEndsAt) found = true;
      } catch {}
    }
    if (!found) throw Error('Reality question text or creation receipt mismatch');
  }
  const candidate = oracleCatalog({ schema: 'flurbo.oracle-catalog.v1', routes: [
    ...(existing?.routes || []), ...routes] });
  const service = oracleService({ catalog: candidate, source, market });
  for (const route of routes) await service.snapshot(route.id);
  return candidate;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  const [preparedPath, manifestPath, outputPath] = process.argv.slice(2);
  if (!preparedPath || !manifestPath || !outputPath) throw Error('Usage: node register-oracle-pool.mjs <prepared.json> <unverified.json> <candidate.json>');
  const prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const existing = JSON.parse(await readFile('config/oracle-markets.json', 'utf8'));
  const [source, market] = oracleClients(process.env.FLURBO_SEPOLIA_RPC_URL,
    process.env.FLURBO_TESTNET_RPC_URL);
  const candidate = await registerOraclePool({ prepared, manifest, existing,
    origin: process.env.FLURBO_ORIGIN, source, market,
    ...(process.env.FLURBO_ORACLE_DEPLOYMENT_BLOCK ? { deploymentBlock: process.env.FLURBO_ORACLE_DEPLOYMENT_BLOCK } : {}) });
  await writeFile(outputPath, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: 'verified_oracle_catalog_candidate',
    pool: manifest.pool, eventCount: manifest.eventCount, output: outputPath }) + '\n');
}

