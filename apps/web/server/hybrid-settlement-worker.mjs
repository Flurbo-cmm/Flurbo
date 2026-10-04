import { createWalletClient, defineChain, getAddress, http, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prepareHybridPilot, hybridRulesHash } from '../scripts/prepare-hybrid-pilot.mjs';
import { canonical, settlementRuleHash } from './settlement-rules.mjs';
import { archiveSettlementProposal, evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture } from './settlement-evidence.mjs';
import { verifyPublicSettlementEvidence } from './deterministic-evidence.mjs';
import { realityOutcome } from './reality-relay.mjs';
import { SEPOLIA_REALITY, TEST_AUSD } from './oracle-integration.mjs';

const monad = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: {
  name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const resolverAbi = parseAbi([
  'function protocolVersion() pure returns (uint8)', 'function rulesHash() view returns (bytes32)',
  'function draftHash() view returns (bytes32)', 'function pool() view returns (address)',
  'function proposer() view returns (address)', 'function relay() view returns (address)',
  'function bond() view returns (uint128)', 'function eventCount() view returns (uint8)',
  'function eventHashes(uint256) view returns (bytes32)', 'function observationEnds(uint256) view returns (uint64)',
  'function routes(uint256) view returns (uint8)', 'function assertionDeadline(uint8) view returns (uint64)',
  'function reportDeadline(uint8) view returns (uint64)',
  'function caseState(uint8) view returns ((uint8 phase,uint8 proposal,uint8 counter,uint8 result,address challenger,bytes32 evidenceHash,bytes32 counterEvidenceHash,bytes32 requestId,bytes32 sourceCaseId,uint64 challengeUntil,uint64 arbitrationUntil))',
  'function delivered() view returns (bool)', 'function propose(uint8,uint8,bytes32,string)',
  'function reportReality(uint8,uint8,bytes32,string)', 'function finalize(uint8)', 'function deliver()',
]);
const poolAbi = parseAbi(['function protocolVersion() pure returns (uint8)',
  'function resolver() view returns (address)', 'function settlementRulesHash() view returns (bytes32)',
  'function collateral() view returns (address)', 'function eventCount() view returns (uint8)',
  'function funded() view returns (bool)', 'function resolved() view returns (bool)']);
const cashAbi = parseAbi(['function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const realityAbi = parseAbi(['function isFinalized(bytes32) view returns (bool)',
  'function getFinalAnswerIfMatches(bytes32,bytes32,address,uint32,uint256) view returns (bytes32)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const hash32 = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const key = (pool, action, event) => `flurbo:hybrid-settlement:v1:${pool.toLowerCase()}:${action}:${event}`;

export function hybridSettlementCatalog(value) {
  if (value?.schema !== 'flurbo.hybrid-catalog.v1' || !Array.isArray(value.pools)
    || value.pools.length > 16) throw Error('Invalid hybrid catalog');
  const ids = new Set(), addresses = new Set();
  for (const pool of value.pools) {
    if (typeof pool?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pool.id)
      || !address(pool.pool) || !address(pool.resolver) || !hash32(pool.rulesHash)
      || (pool.prepared?.draft?.events?.some(event => event.route === 'mechanical')
        && (!address(pool.adapter) || !address(pool.manager)))
      || !Number.isSafeInteger(pool.deploymentBlock) || pool.deploymentBlock < 1
      || ids.has(pool.id) || addresses.has(pool.pool.toLowerCase())) throw Error('Invalid hybrid pool');
    const prepared = pool.prepared;
    const repeated = prepareHybridPilot({ ...prepared?.draft, proposer: prepared?.proposer,
      relay: prepared?.relay, rulesReviewed: true });
    if (canonical(repeated) !== canonical(prepared)
      || !same(pool.rulesHash, hybridRulesHash(prepared, pool.resolver)))
      throw Error('Hybrid catalog publication differs from its commitment');
    ids.add(pool.id); addresses.add(pool.pool.toLowerCase());
  }
  return value;
}

export function nextHybridAction(snapshot) {
  if (snapshot.delivered || snapshot.resolved) return null;
  const { states, now, prepared } = snapshot;
  if (states.length !== prepared.draft.events.length) throw Error('Hybrid case count mismatch');
  if (states.every(state => Number(state.phase) === 3)) return { kind: 'deliver' };
  for (let event = 0; event < states.length; event++) {
    const state = states[event], publication = prepared.draft.events[event];
    if (Number(state.phase) === 0) {
      const deadline = publication.observationEndsAt + (publication.route === 'mechanical'
        ? prepared.draft.assertionPeriod : prepared.draft.reportPeriod);
      if (now >= deadline) return { kind: 'finalize', event };
    } else if (Number(state.phase) === 1 && now >= Number(state.challengeUntil))
      return { kind: 'finalize', event };
    else if (Number(state.phase) === 2 && /^0x0{64}$/i.test(state.sourceCaseId)
      && now >= Number(state.arbitrationUntil))
      return { kind: 'finalize', event };
  }
  for (let event = 0; event < states.length; event++) {
    const publication = prepared.draft.events[event];
    if (Number(states[event].phase) === 0 && now >= publication.observationEndsAt)
      return { kind: publication.route === 'mechanical' ? 'propose' : 'reality', event };
  }
  return null;
}

export async function readHybridSnapshot(record, market) {
  if (await market.getChainId() !== 10143) throw Error('Hybrid market RPC chain mismatch');
  const resolver = getAddress(record.resolver), pool = getAddress(record.pool);
  const readResolver = (functionName, args = []) => market.readContract({ address: resolver, abi: resolverAbi, functionName, args });
  const readPool = functionName => market.readContract({ address: pool, abi: poolAbi, functionName });
  const [head, version, rulesHash, draftHash, linkedPool, proposer, relay, bond, count,
    poolVersion, poolResolver, poolRulesHash, collateral, poolCount, funded, resolved, delivered] = await Promise.all([
    market.getBlock(), readResolver('protocolVersion'), readResolver('rulesHash'), readResolver('draftHash'),
    readResolver('pool'), readResolver('proposer'), readResolver('relay'), readResolver('bond'),
    readResolver('eventCount'), readPool('protocolVersion'), readPool('resolver'),
    readPool('settlementRulesHash'), readPool('collateral'), readPool('eventCount'),
    readPool('funded'), readPool('resolved'), readResolver('delivered'),
  ]);
  const prepared = record.prepared, size = prepared.draft.events.length;
  if (!hash32(head?.hash) || typeof head.number !== 'bigint'
    || Number(version) !== 4 || Number(poolVersion) !== 3 || Number(count) !== size
    || Number(poolCount) !== size || !funded || !same(rulesHash, record.rulesHash)
    || !same(poolRulesHash, record.rulesHash) || !same(draftHash, prepared.draftHash)
    || !same(linkedPool, pool) || !same(poolResolver, resolver)
    || !same(proposer, prepared.proposer) || !same(relay, prepared.relay)
    || !same(collateral, TEST_AUSD) || bond !== BigInt(prepared.draft.bondAtoms))
    throw Error('Hybrid pool differs from verified catalog');
  const states = [];
  for (let event = 0; event < size; event++) {
    const [eventHash, observationEnds, route, state] = await Promise.all([
      readResolver('eventHashes', [event]), readResolver('observationEnds', [event]),
      readResolver('routes', [event]), readResolver('caseState', [event]),
    ]);
    if (!same(eventHash, prepared.eventHashes[event])
      || Number(observationEnds) !== prepared.draft.events[event].observationEndsAt
      || Number(route) !== (prepared.draft.events[event].route === 'mechanical' ? 0 : 1))
      throw Error('Hybrid event differs from verified catalog');
    states.push(state);
  }
  return { now: Number(head.timestamp), blockNumber: head.number,
    blockHash: head.hash, states, prepared, resolved, delivered };
}

export function hybridSettlementWorker({ pools, market, source, command, archive, captureStore,
  packetStore, oracleEvidence, origin, marketRpcUrl, proposerPrivateKey, relayPrivateKey,
  proposerWallet = null, relayWallet = null, relaySend = task => task(), request = fetch,
  now = () => Math.floor(Date.now() / 1000),
  intervalMs = 120_000 }) {
  hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools });
  if (!pools.length || !market || !source || typeof command !== 'function' || !archive?.put
    || !archive?.get || !captureStore?.put || !captureStore?.list || !captureStore?.recordAttempt
    || !captureStore?.latestAttempt || !packetStore?.put || !packetStore?.get
    || !oracleEvidence?.putRelay || !origin?.startsWith('https://')
    || !marketRpcUrl?.startsWith('https://')
    || !/^0x[0-9a-fA-F]{64}$/.test(proposerPrivateKey || '')
    || !/^0x[0-9a-fA-F]{64}$/.test(relayPrivateKey || ''))
    throw Error('Hybrid settlement worker configuration incomplete');
  const proposer = privateKeyToAccount(proposerPrivateKey), relay = privateKeyToAccount(relayPrivateKey);
  if (same(proposer.address, relay.address) || pools.some(pool =>
    !same(pool.prepared.proposer, proposer.address) || !same(pool.prepared.relay, relay.address)))
    throw Error('Hybrid settlement wallet roles differ from catalog');
  const proposerClient = proposerWallet || createWalletClient({ account: proposer, chain: monad,
    transport: http(marketRpcUrl, { timeout: 20_000 }) });
  const relayClient = relayWallet || createWalletClient({ account: relay, chain: monad,
    transport: http(marketRpcUrl, { timeout: 20_000 }) });
  let timer = null, running = false, cycles = 0, lastError = null, lastFinishedAt = null;

  async function send(record, action, event, wallet, account, target, abi, functionName, args) {
    const journal = key(record.pool, action, event);
    const saved = await command('GET', journal);
    if (saved) {
      if (saved === 'preparing') return false;
      const receipt = await market.getTransactionReceipt({ hash: saved }).catch(() => null);
      if (!receipt) return false;
      if (receipt.status !== 'success') {
        await command('DEL', journal);
        throw Error('Hybrid settlement transaction reverted');
      }
      return true;
    }
    const tx = { account, chain: monad, address: getAddress(target), abi, functionName, args };
    await market.simulateContract(tx);
    if (await command('SET', journal, 'preparing', 'EX', 900, 'NX') !== 'OK') return false;
    const hash = same(account.address, relay.address)
      ? await relaySend(() => wallet.writeContract(tx)) : await wallet.writeContract(tx);
    if (!hash32(hash)) throw Error('Hybrid settlement transaction hash invalid');
    await command('SET', journal, hash, 'EX', 86400);
    return false;
  }

  async function collect(record, snapshot) {
    for (let event = 0; event < snapshot.states.length; event++) {
      const item = record.prepared.draft.events[event];
      if (item.route !== 'mechanical' || Number(snapshot.states[event].phase) !== 0) continue;
      const rule = item.rule, at = now(), ruleHash = settlementRuleHash(rule);
      if (at < rule.timing.scheduledAt || at > rule.timing.publicationCutoff) continue;
      if (rule.vintage === 'first-observed-snapshot'
        && (await captureStore.list(ruleHash)).some(capture => {
          try { parseSettlementCapture(rule, capture, at); return true; } catch { return false; }
        })) continue;
      const issues = [];
      for (const url of rule.source.urls) {
        try {
          const capture = await retrieveSettlementCapture(rule, url, { request, now });
          parseSettlementCapture(rule, capture, now());
          await captureStore.put(ruleHash, capture);
        } catch (error) { issues.push(/^[A-Z0-9_]{1,96}$/.test(error?.reason || '')
          ? error.reason : 'SOURCE_CAPTURE_FAILED'); }
      }
      await captureStore.recordAttempt(ruleHash, { at: now(), ok: !issues.length, issues: [...new Set(issues)] });
    }
  }

  async function propose(record, event) {
    const item = record.prepared.draft.events[event], rule = item.rule;
    const ruleHash = settlementRuleHash(rule), at = now();
    const attempt = await captureStore.latestAttempt(ruleHash);
    const captures = await captureStore.list(ruleHash);
    if (!captures.length || (rule.vintage !== 'first-observed-snapshot'
      && (!attempt?.ok || at - attempt.at > 900 || attempt.at > at))) return;
    const result = evaluateSettlement(rule, captures, { now: at });
    if (result.status !== 'ready') return;
    const archived = await archiveSettlementProposal({ rule, expectedRuleHash: ruleHash,
      captures, now: at, archive, owner: proposer.address,
      draftHash: record.prepared.draftHash, packetStore });
    if (!archived.evidence) return;
    await verifyPublicSettlementEvidence(archived.evidence, archive, { origin, request });
    const bond = BigInt(record.prepared.draft.bondAtoms);
    const [balance, allowance] = await Promise.all([
      market.readContract({ address: TEST_AUSD, abi: cashAbi, functionName: 'balanceOf', args: [proposer.address] }),
      market.readContract({ address: TEST_AUSD, abi: cashAbi, functionName: 'allowance',
        args: [proposer.address, record.resolver] }),
    ]);
    if (balance < bond) throw Error('Hybrid proposer needs test AUSD bond');
    if (allowance < bond) {
      await send(record, 'approve', event, proposerClient, proposer, TEST_AUSD,
        cashAbi, 'approve', [getAddress(record.resolver), bond]);
      return;
    }
    await send(record, 'propose', event, proposerClient, proposer, record.resolver,
      resolverAbi, 'propose', [event, archived.evidence.outcome, archived.evidence.hash, archived.evidence.uri]);
  }

  async function reportReality(record, event) {
    if (await source.getChainId() !== 11155111) throw Error('Hybrid Reality RPC chain mismatch');
    const item = record.prepared.draft.events[event], reality = item.source;
    const finalized = await source.readContract({ address: getAddress(reality.reality), abi: realityAbi,
      functionName: 'isFinalized', args: [reality.questionId] });
    if (!finalized) return;
    const block = await source.getBlock({ blockTag: 'finalized' });
    if (!hash32(block?.hash) || typeof block.number !== 'bigint') return;
    const answer = await source.readContract({ address: getAddress(reality.reality), abi: realityAbi,
      functionName: 'getFinalAnswerIfMatches', args: [reality.questionId, reality.contentHash,
        getAddress(reality.arbitrator), reality.minTimeout, BigInt(reality.minBond)],
      blockNumber: block.number });
    const outcome = realityOutcome(answer);
    const evidence = JSON.stringify({ schema: 'flurbo.reality-evidence.v2', sourceChainId: 11155111,
      sourceBlockNumber: block.number.toString(), sourceBlockHash: block.hash.toLowerCase(),
      reality: getAddress(reality.reality), arbitrator: getAddress(reality.arbitrator),
      questionId: reality.questionId.toLowerCase(), contentHash: reality.contentHash.toLowerCase(),
      finalAnswer: answer.toLowerCase(), minTimeout: reality.minTimeout, minBond: reality.minBond,
      marketChainId: 10143, pool: getAddress(record.pool), resolver: getAddress(record.resolver),
      relay: relay.address, rulesHash: record.rulesHash.toLowerCase(), eventIndex: event,
      eventHash: record.prepared.eventHashes[event].toLowerCase() });
    const evidenceHash = keccak256(toHex(evidence));
    const uri = await oracleEvidence.putRelay(evidence);
    if (uri !== `${origin}/api/oracle/evidence/${evidenceHash}`)
      throw Error('Hybrid Reality evidence URI mismatch');
    await send(record, 'reality', event, relayClient, relay, record.resolver,
      resolverAbi, 'reportReality', [event, outcome, evidenceHash, uri]);
  }

  async function tick() {
    if (running) return;
    running = true; cycles++;
    try {
      for (const record of pools) {
        const snapshot = await readHybridSnapshot(record, market);
        if (snapshot.delivered || snapshot.resolved) continue;
        await collect(record, snapshot);
        const action = nextHybridAction(snapshot);
        if (!action) continue;
        if (action.kind === 'propose') await propose(record, action.event);
        else if (action.kind === 'reality') await reportReality(record, action.event);
        else await send(record, action.kind, action.event ?? 'all', relayClient, relay,
          record.resolver, resolverAbi, action.kind, action.event === undefined ? [] : [action.event]);
        break;
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Hybrid settlement cycle failed';
      console.error(lastError);
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }

  return { tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, pools: pools.length,
      proposer: proposer.address, relay: relay.address, lastError, lastFinishedAt }; },
  };
}
