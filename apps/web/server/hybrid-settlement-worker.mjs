import { createWalletClient, defineChain, getAddress, http, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prepareHybridPilot, hybridRulesHash, isLsPrepared } from '../scripts/prepare-hybrid-pilot.mjs';
import { canonical, settlementRuleHash } from './settlement-rules.mjs';
import { archiveSettlementProposal, evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture } from './settlement-evidence.mjs';
import { verifyPublicSettlementEvidence } from './deterministic-evidence.mjs';
import { realityAbi as fullRealityAbi, SEPOLIA_REALITY, TEST_AUSD } from './oracle-integration.mjs';
import { hybridRealitySnapshot, REALITY_ANSWERS } from './hybrid-reality.mjs';

const monad = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: {
  name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const sepolia = defineChain({ id: 11155111, name: 'Sepolia', nativeCurrency: {
  name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } } });
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
  'function funded() view returns (bool)', 'function resolved() view returns (bool)',
  'function liquidity() view returns (uint128)', 'function commissionBps() view returns (uint16)',
  'function sponsor() view returns (address)', 'function surplus() view returns (uint128)',
  'function withdrawSurplus() returns (uint128)']);
const cashAbi = parseAbi(['function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const realityAbi = parseAbi(['function isFinalized(bytes32) view returns (bool)',
  'function getFinalAnswerIfMatches(bytes32,bytes32,address,uint32,uint256) view returns (bytes32)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const hash32 = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
export const realityAnswerBytes = Object.freeze({ 1: REALITY_ANSWERS.no, 2: REALITY_ANSWERS.yes, 3: REALITY_ANSWERS.void });
export function hybridRealityOutcome(answer) {
  if (!hash32(answer)) throw Error('Reality answer is malformed');
  const value = BigInt(answer);
  return value === 0n ? 1 : value === 1n ? 2 : 3;
}
const PUBLIC_ERRORS = new Map([
  ['Hybrid settlement transaction reverted', 'TX_REVERTED'],
  ['Hybrid settlement transaction hash invalid', 'TX_HASH_INVALID'],
  ['Hybrid proposer needs test AUSD bond', 'PROPOSER_BOND_LOW'],
  ['Hybrid Reality RPC chain mismatch', 'SEPOLIA_RPC_WRONG_CHAIN'],
  ['Hybrid Reality evidence URI mismatch', 'EVIDENCE_URI_MISMATCH'],
  ['Hybrid market RPC chain mismatch', 'MONAD_RPC_WRONG_CHAIN'],
  ['Hybrid pool differs from verified catalog', 'POOL_MISMATCH'],
  ['Hybrid event differs from verified catalog', 'EVENT_MISMATCH'],
  ['Hybrid case count mismatch', 'CASE_COUNT_MISMATCH'],
  ['Automatic answer observation conflict', 'OBSERVATION_CONFLICT'],
  ['Invalid automatic answer transaction record', 'ANSWER_RECORD_INVALID'],
  ['Sepolia answer transaction reverted; manual review required', 'ANSWER_REVERTED'],
  ['Confirmed Sepolia answer has no bond; manual review required', 'ANSWER_NO_BOND'],
  ['Sepolia answer transaction missing; manual review required', 'ANSWER_TX_MISSING'],
  ['Reality answer bond mismatch', 'ANSWER_BOND_MISMATCH'],
  ['Sepolia answer signer needs ETH for bond and gas', 'ANSWERER_ETH_LOW'],
  ['Sepolia answer submission uncertain; inspect the signer before retrying', 'ANSWER_SUBMISSION_UNCERTAIN'],
  ['Reality answer is malformed', 'REALITY_ANSWER_MALFORMED'],
  ['Reality credit withdrawal reverted', 'WITHDRAW_REVERTED'],
  ['Hybrid relay wallet needs MON for gas', 'RELAY_GAS_LOW'],
  ['Hybrid proposer wallet needs MON for gas', 'PROPOSER_GAS_LOW'],
  ['Hybrid settlement submission uncertain; inspect the wallet before retrying', 'SUBMISSION_UNCERTAIN']]);
export function publicHybridError(error, stage) {
  const code = PUBLIC_ERRORS.get(error?.message);
  return code ? { code, message: error.message }
    : { code: `${stage.toUpperCase()}_FAILED`, message: 'Hybrid settlement source or transaction request failed' };
}
const REJECTED = new Set(['InsufficientFundsError', 'EstimateGasExecutionError', 'IntrinsicGasTooHighError',
  'IntrinsicGasTooLowError', 'NonceTooLowError', 'NonceTooHighError', 'FeeCapTooLowError', 'ExecutionRevertedError']);
function rejection(error) {
  for (let e = error, depth = 0; e && depth < 8; e = e.cause, depth++) if (REJECTED.has(e.name)) return e.name;
  return null;
}
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
      || (pool.prepared?.draft?.events?.some(event => event.route === 'reality') && !address(pool.keeper))
      || (pool.prepared?.draft?.events?.some(event => event.route === 'reality' && event.rule) && !address(pool.answerer))
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

export function nextHybridActions(snapshot) {
  if (snapshot.delivered || snapshot.resolved) return [];
  const { states, now, prepared } = snapshot;
  if (states.length !== prepared.draft.events.length) throw Error('Hybrid case count mismatch');
  if (states.every(state => Number(state.phase) === 3)) return [{ kind: 'deliver' }];
  const actions = [];
  for (let event = 0; event < states.length; event++) {
    const state = states[event], publication = prepared.draft.events[event];
    if (Number(state.phase) === 0) {
      const deadline = publication.observationEndsAt + (publication.route === 'mechanical'
        ? prepared.draft.assertionPeriod : prepared.draft.reportPeriod);
      if (now >= deadline) actions.push({ kind: 'finalize', event });
    } else if (Number(state.phase) === 1 && now >= Number(state.challengeUntil))
      actions.push({ kind: 'finalize', event });
    else if (Number(state.phase) === 2 && /^0x0{64}$/i.test(state.sourceCaseId)
      && now >= Number(state.arbitrationUntil)) actions.push({ kind: 'finalize', event });
  }
  for (let event = 0; event < states.length; event++) {
    const publication = prepared.draft.events[event];
    if (Number(states[event].phase) === 0 && now >= publication.observationEndsAt
      && !actions.some(action => action.event === event))
      actions.push({ kind: publication.route === 'mechanical' ? 'propose' : 'reality', event });
  }
  return actions;
}

export function nextHybridAction(snapshot) { return nextHybridActions(snapshot)[0] ?? null; }

// What the capture loop does for one rule right now. A credentialed source is never fetched here: its proof is
// made by the operator's prover and uploaded, so the worker only records that it is still waiting.
export function hybridCaptureStep(rule, at, retained) {
  if (at < rule.timing.scheduledAt || at > rule.timing.publicationCutoff) return 'outside-window';
  if (retained) return 'retained';
  return rule.source.adapter === 'proof-http.v1' ? 'proof-pending' : 'fetch';
}

export function planRealityAnswer({ now, opensAt, bondWei, finalized, pendingArbitration, observation }) {
  if (now < opensAt) return 'waiting_open';
  if (finalized || pendingArbitration || BigInt(bondWei || 0) > 0n) return 'already_answered';
  return observation ? 'answer' : 'waiting_source';
}

export async function buildRealityObservation({ rule, questionId, captures, attempt, now, archive,
  packetStore, owner, draftHash, origin, request = fetch }) {
  const ruleHash = settlementRuleHash(rule), t = rule.timing;
  const evaluatedAt = Math.min(now, t.observationEndsAt + t.assertionPeriod - 1);
  const fresh = rule.vintage === 'first-observed-snapshot'
    || (attempt?.ok && attempt.at <= now && now - attempt.at <= 900);
  let archived = null;
  if (captures.length && fresh && now >= t.observationEndsAt)
    archived = await archiveSettlementProposal({ rule, expectedRuleHash: ruleHash, captures,
      now: evaluatedAt, archive, owner, draftHash, packetStore });
  let outcome, evidence;
  if (archived?.evidence) {
    await verifyPublicSettlementEvidence(archived.evidence, archive, { origin, request });
    outcome = archived.evidence.outcome; evidence = archived.evidence;
  } else if (now > t.publicationCutoff && now >= t.observationEndsAt) {
    outcome = 3;
    evidence = await archive.put({ eventId: rule.eventId, outcome,
      statement: `${rule.question} No valid source capture was recorded before the publication cutoff; the published rule result is VOID.`,
      sourceURL: rule.source.urls[0], attachment: JSON.stringify({ schema: 'flurbo.missing-capture.v1',
        ruleHash: `0x${ruleHash}`, attempt: attempt || null }) }, owner, draftHash);
  } else return null;
  return { schema: 'flurbo.hybrid-answer-observation.v1', questionId, outcome,
    answer: realityAnswerBytes[outcome], evidenceHash: evidence.hash, evidenceURI: evidence.uri,
    observedAt: now };
}

const verifiedPools = new WeakMap();
const inFlightHeads = new WeakMap();

function poolVerificationKey(record) {
  const p = record?.prepared;
  return [record?.pool, record?.resolver, record?.rulesHash, p?.schema, p?.draftHash, p?.configHash,
    p?.creator, p?.proposer, p?.relay, p?.liquidityAtoms ?? '', p?.commissionBps ?? '',
    p?.draft?.bondAtoms ?? '', ...(p?.eventHashes || []),
    ...(p?.draft?.events || []).map(e => `${e.observationEndsAt}:${e.route}`)].join(':').toLowerCase();
}

async function ensureHybridPoolVerified(record, market) {
  let map = verifiedPools.get(market);
  if (!map) { map = new Map(); verifiedPools.set(market, map); }
  const key = poolVerificationKey(record);
  const existing = map.get(key);
  if (existing === true) return;
  if (existing) return existing;
  const task = (async () => {
    const resolver = getAddress(record.resolver), pool = getAddress(record.pool);
    const readResolver = (functionName, args = []) => market.readContract({ address: resolver, abi: resolverAbi, functionName, args });
    const readPool = functionName => market.readContract({ address: pool, abi: poolAbi, functionName });
    const ls = isLsPrepared(record.prepared), prepared = record.prepared, size = prepared.draft.events.length;
    const [[chainId, version, rulesHash, draftHash, linkedPool, proposer, relay, bond, count,
      poolVersion, poolResolver, poolRulesHash, collateral, poolCount, funded,
      liquidity, commissionBps, sponsor], events] = await Promise.all([
      Promise.all([
        market.getChainId(),
        readResolver('protocolVersion'), readResolver('rulesHash'), readResolver('draftHash'),
        readResolver('pool'), readResolver('proposer'), readResolver('relay'), readResolver('bond'),
        readResolver('eventCount'), readPool('protocolVersion'), readPool('resolver'),
        readPool('settlementRulesHash'), readPool('collateral'), readPool('eventCount'),
        readPool('funded'),
        ...(ls ? [readPool('liquidity'), readPool('commissionBps'), readPool('sponsor')] : []),
      ]),
      Promise.all(Array.from({ length: size }, (_, event) => Promise.all([
        readResolver('eventHashes', [event]), readResolver('observationEnds', [event]),
        readResolver('routes', [event]),
      ]))),
    ]);
    if (chainId !== 10143) throw Error('Hybrid market RPC chain mismatch');
    if (Number(version) !== 4 || Number(poolVersion) !== (ls ? 5 : 3) || Number(count) !== size
      || Number(poolCount) !== size || !funded || !same(rulesHash, record.rulesHash)
      || !same(poolRulesHash, record.rulesHash) || !same(draftHash, prepared.draftHash)
      || !same(linkedPool, pool) || !same(poolResolver, resolver)
      || !same(proposer, prepared.proposer) || !same(relay, prepared.relay)
      || !same(collateral, TEST_AUSD) || bond !== BigInt(prepared.draft.bondAtoms))
      throw Error('Hybrid pool differs from verified catalog');
    if (ls && (BigInt(liquidity) !== BigInt(prepared.liquidityAtoms) || Number(commissionBps) !== prepared.commissionBps
      || !same(sponsor, prepared.creator)))
      throw Error('Hybrid pool differs from verified catalog');
    for (let event = 0; event < size; event++) {
      const [eventHash, observationEnds, route] = events[event];
      if (!same(eventHash, prepared.eventHashes[event])
        || Number(observationEnds) !== prepared.draft.events[event].observationEndsAt
        || Number(route) !== (prepared.draft.events[event].route === 'mechanical' ? 0 : 1))
        throw Error('Hybrid event differs from verified catalog');
    }
    map.set(key, true);
  })();
  map.set(key, task);
  try { await task; } catch (err) { map.delete(key); throw err; }
}

export async function readHybridSnapshot(record, market, { includeStates = true, eventIndex = null } = {}) {
  const resolver = getAddress(record.resolver), pool = getAddress(record.pool);
  const readResolver = (functionName, args = []) => market.readContract({ address: resolver, abi: resolverAbi, functionName, args });
  const readPool = functionName => market.readContract({ address: pool, abi: poolAbi, functionName });
  const prepared = record.prepared, size = prepared.draft.events.length;
  if (!includeStates) {
    let heads = inFlightHeads.get(market);
    if (!heads) { heads = new Map(); inFlightHeads.set(market, heads); }
    const key = pool.toLowerCase();
    let pending = heads.get(key);
    if (!pending) {
      pending = Promise.all([
        ensureHybridPoolVerified(record, market),
        market.getBlock(), readPool('resolved'), readResolver('delivered'),
      ]).finally(() => heads.delete(key));
      heads.set(key, pending);
    }
    const [, head, resolved, delivered] = await pending;
    if (!hash32(head?.hash) || typeof head.number !== 'bigint')
      throw Error('Hybrid pool differs from verified catalog');
    return { now: Number(head.timestamp), blockNumber: head.number,
      blockHash: head.hash, states: [], prepared, resolved, delivered };
  }
  if (Number.isInteger(eventIndex) && eventIndex >= 0 && eventIndex < size) {
    const [, head, resolved, delivered, state] = await Promise.all([
      ensureHybridPoolVerified(record, market),
      market.getBlock(), readPool('resolved'), readResolver('delivered'),
      readResolver('caseState', [eventIndex]),
    ]);
    if (!hash32(head?.hash) || typeof head.number !== 'bigint')
      throw Error('Hybrid pool differs from verified catalog');
    const states = Array(size).fill(null);
    states[eventIndex] = state;
    return { now: Number(head.timestamp), blockNumber: head.number,
      blockHash: head.hash, states, prepared, resolved, delivered };
  }
  const [, head, resolved, delivered, ...states] = await Promise.all([
    ensureHybridPoolVerified(record, market),
    market.getBlock(), readPool('resolved'), readResolver('delivered'),
    ...Array.from({ length: size }, (_, event) => readResolver('caseState', [event])),
  ]);
  if (!hash32(head?.hash) || typeof head.number !== 'bigint')
    throw Error('Hybrid pool differs from verified catalog');
  return { now: Number(head.timestamp), blockNumber: head.number,
    blockHash: head.hash, states, prepared, resolved, delivered };
}

export function hybridSettlementWorker({ pools, market, source, command, archive, captureStore,
  packetStore, oracleEvidence, origin, marketRpcUrl, proposerPrivateKey, relayPrivateKey,
  proposerWallet = null, relayWallet = null, relaySend = task => task(), request = fetch,
  answererPrivateKey = null, answererWallet = null, sourceRpcUrl = null, minWithdrawWei = 100_000_000_000_000n,
  minSweepAtoms = 1_000_000n,
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
  const answered = pools.some(pool => pool.prepared.draft.events.some(event =>
    event.route === 'reality' && event.rule));
  let answerer = null;
  if (answered) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(answererPrivateKey || '') || !sourceRpcUrl?.startsWith('https://'))
      throw Error('Hybrid answer wallet differs from catalog');
    answerer = privateKeyToAccount(answererPrivateKey);
    if (same(answerer.address, proposer.address) || same(answerer.address, relay.address)
      || pools.some(pool => pool.prepared.draft.events.some(event => event.route === 'reality' && event.rule)
        && !same(pool.answerer, answerer.address)))
      throw Error('Hybrid answer wallet differs from catalog');
  }
  const answererClient = answerer ? answererWallet || createWalletClient({ account: answerer, chain: sepolia,
    transport: http(sourceRpcUrl, { timeout: 20_000 }) }) : null;
  const answers = new Map(), eventErrors = new Map(), sweeps = new Map();
  const proposerClient = proposerWallet || createWalletClient({ account: proposer, chain: monad,
    transport: http(marketRpcUrl, { timeout: 20_000 }) });
  const relayClient = relayWallet || createWalletClient({ account: relay, chain: monad,
    transport: http(marketRpcUrl, { timeout: 20_000 }) });
  let timer = null, running = false, cycles = 0, lastError = null, lastFinishedAt = null;

  const gasError = account => Error(same(account.address, relay.address)
    ? 'Hybrid relay wallet needs MON for gas' : 'Hybrid proposer wallet needs MON for gas');
  async function requireGas(account, tx) {
    const [gas, price, balance] = await Promise.all([market.estimateContractGas(tx), market.getGasPrice(),
      market.getBalance({ address: account.address })]);
    if (balance < gas * price * 12n / 10n) throw gasError(account);
  }

  async function send(record, action, event, wallet, account, target, abi, functionName, args) {
    const journal = key(record.pool, action, event);
    const saved = await command('GET', journal);
    if (saved) {
      if (saved === 'preparing') return 'pending';
      const receipt = await market.getTransactionReceipt({ hash: saved }).catch(() => null);
      if (!receipt) return 'pending';
      if (receipt.status !== 'success') {
        await command('DEL', journal);
        throw Error('Hybrid settlement transaction reverted');
      }
      return 'confirmed';
    }
    const tx = { account, chain: monad, address: getAddress(target), abi, functionName, args };
    await market.simulateContract(tx);
    await requireGas(account, tx);
    if (await command('SET', journal, 'preparing', 'EX', 900, 'NX') !== 'OK') return 'pending';
    let hash;
    try {
      hash = same(account.address, relay.address) ? await relaySend(() => wallet.writeContract(tx)) : await wallet.writeContract(tx);
    } catch (error) {
      const rejected = rejection(error);
      if (!rejected) throw Error('Hybrid settlement submission uncertain; inspect the wallet before retrying', { cause: error });
      await command('DEL', journal);
      throw rejected === 'InsufficientFundsError' ? gasError(account) : error;
    }
    if (!hash32(hash)) throw Error('Hybrid settlement transaction hash invalid');
    await command('SET', journal, hash, 'EX', 86400);
    return 'submitted';
  }

  async function collect(record, snapshot, fail) {
    for (let event = 0; event < snapshot.states.length; event++) {
      try {
        const item = record.prepared.draft.events[event];
        if ((item.route !== 'mechanical' && !item.rule) || Number(snapshot.states[event].phase) !== 0) continue;
        const rule = item.rule, at = now(), ruleHash = settlementRuleHash(rule);
        const retained = at >= rule.timing.scheduledAt && at <= rule.timing.publicationCutoff
          && rule.vintage === 'first-observed-snapshot'
          && (await captureStore.list(ruleHash)).some(capture => {
            try { parseSettlementCapture(rule, capture, at); return true; } catch { return false; }
          });
        const step = hybridCaptureStep(rule, at, retained);
        if (step === 'proof-pending') {
          await captureStore.recordAttempt(ruleHash, { at, ok: false, issues: ['PROOF_CAPTURE_PENDING'] });
          continue;
        }
        if (step !== 'fetch') continue;
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
      } catch (error) { fail(event, 'capture', error); }
    }
  }

  async function propose(record, event) {
    const item = record.prepared.draft.events[event], rule = item.rule;
    const ruleHash = settlementRuleHash(rule), at = now();
    const attempt = await captureStore.latestAttempt(ruleHash);
    const captures = await captureStore.list(ruleHash);
    if (!captures.length || (rule.vintage !== 'first-observed-snapshot'
      && (!attempt?.ok || at - attempt.at > 900 || attempt.at > at))) return null;
    const result = evaluateSettlement(rule, captures, { now: at });
    if (result.status !== 'ready') return null;
    const archived = await archiveSettlementProposal({ rule, expectedRuleHash: ruleHash,
      captures, now: at, archive, owner: proposer.address,
      draftHash: record.prepared.draftHash, packetStore });
    if (!archived.evidence) return null;
    await verifyPublicSettlementEvidence(archived.evidence, archive, { origin, request });
    const bond = BigInt(record.prepared.draft.bondAtoms);
    const [balance, allowance] = await Promise.all([
      market.readContract({ address: TEST_AUSD, abi: cashAbi, functionName: 'balanceOf', args: [proposer.address] }),
      market.readContract({ address: TEST_AUSD, abi: cashAbi, functionName: 'allowance',
        args: [proposer.address, record.resolver] }),
    ]);
    if (balance < bond) throw Error('Hybrid proposer needs test AUSD bond');
    if (allowance < bond)
      return send(record, 'approve', event, proposerClient, proposer, TEST_AUSD,
        cashAbi, 'approve', [getAddress(record.resolver), bond]);
    return send(record, 'propose', event, proposerClient, proposer, record.resolver,
      resolverAbi, 'propose', [event, archived.evidence.outcome, archived.evidence.hash, archived.evidence.uri]);
  }

  async function reportReality(record, event) {
    if (await source.getChainId() !== 11155111) throw Error('Hybrid Reality RPC chain mismatch');
    const item = record.prepared.draft.events[event], reality = item.source;
    const block = await source.getBlock({ blockTag: 'finalized' });
    if (!hash32(block?.hash) || typeof block.number !== 'bigint') return null;
    const finalized = await source.readContract({ address: getAddress(reality.reality), abi: realityAbi,
      functionName: 'isFinalized', args: [reality.questionId], blockNumber: block.number });
    if (!finalized) return null;
    const answer = await source.readContract({ address: getAddress(reality.reality), abi: realityAbi,
      functionName: 'getFinalAnswerIfMatches', args: [reality.questionId, reality.contentHash,
        getAddress(reality.arbitrator), reality.minTimeout, BigInt(reality.minBond)],
      blockNumber: block.number });
    const outcome = hybridRealityOutcome(answer);
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
    return send(record, 'reality', event, relayClient, relay, record.resolver,
      resolverAbi, 'reportReality', [event, outcome, evidenceHash, uri]);
  }

  const observationKey = question => `flurbo:hybrid-answer:v1:${question}:observation`;
  const transactionKey = question => `flurbo:hybrid-answer:v1:${question}:transaction`;

  async function answer(record, event) {
    if (await source.getChainId() !== 11155111) throw Error('Hybrid Reality RPC chain mismatch');
    const item = record.prepared.draft.events[event], rule = item.rule;
    const q = item.source.questionId.toLowerCase(), clock = now();
    let stored = await command('GET', observationKey(q));
    if (!stored) {
      const ruleHash = settlementRuleHash(rule);
      const built = await buildRealityObservation({ rule, questionId: q,
        captures: await captureStore.list(ruleHash), attempt: await captureStore.latestAttempt(ruleHash),
        now: clock, archive, packetStore, owner: answerer.address, draftHash: record.prepared.draftHash,
        origin, request });
      if (built) {
        await command('SET', observationKey(q), JSON.stringify(built), 'NX');
        stored = await command('GET', observationKey(q));
      }
    }
    const observation = stored ? JSON.parse(stored) : null;
    if (observation && observation.questionId?.toLowerCase() !== q)
      throw Error('Automatic answer observation conflict');
    const state = await hybridRealitySnapshot(source, item, null);
    const plan = planRealityAnswer({ now: state.sourceNow, opensAt: state.opensAt, bondWei: state.bondWei,
      finalized: state.finalized, pendingArbitration: state.pendingArbitration, observation });
    if (plan !== 'answer') { answers.set(`${record.pool}-${event}`, plan); return plan; }
    const existing = await command('GET', transactionKey(q));
    let result;
    if (existing) {
      if (existing === 'preparing') result = 'submission_uncertain';
      else {
        const saved = JSON.parse(existing);
        if (!hash32(saved?.hash) || !Number.isSafeInteger(saved?.sentAt))
          throw Error('Invalid automatic answer transaction record');
        try {
          const receipt = await source.getTransactionReceipt({ hash: saved.hash });
          if (receipt.status !== 'success') throw Error('Sepolia answer transaction reverted; manual review required');
          if (clock - saved.sentAt > 300) throw Error('Confirmed Sepolia answer has no bond; manual review required');
          result = 'confirming';
        } catch (error) {
          if (error?.name !== 'TransactionReceiptNotFoundError') throw error;
          if (clock - saved.sentAt > 1800) throw Error('Sepolia answer transaction missing; manual review required');
          result = 'submitted';
        }
      }
    } else {
      const value = BigInt(state.nextBondWei);
      if (value <= 0n || value !== BigInt(item.source.minBond)) throw Error('Reality answer bond mismatch');
      const balance = await source.getBalance({ address: answerer.address });
      if (balance <= value) throw Error('Sepolia answer signer needs ETH for bond and gas');
      const simulated = await source.simulateContract({ address: getAddress(item.source.reality),
        abi: fullRealityAbi, functionName: 'submitAnswer', args: [q, observation.answer, 0n], value,
        account: answerer });
      const lock = transactionKey(q);
      if (await command('SET', lock, 'preparing', 'NX') !== 'OK') result = 'submission_uncertain';
      else {
        try {
          const hash = await answererClient.writeContract({ ...simulated.request, account: answerer, chain: sepolia });
          await command('SET', lock, JSON.stringify({ hash, sentAt: clock }));
          result = 'submitted';
        } catch (error) {
          throw Error('Sepolia answer submission uncertain; inspect the signer before retrying', { cause: error });
        }
      }
    }
    answers.set(`${record.pool}-${event}`, result);
    return result;
  }

  async function withdrawRealityCredit() {
    const reality = getAddress(SEPOLIA_REALITY);
    const balance = BigInt(await source.readContract({ address: reality, abi: fullRealityAbi,
      functionName: 'balanceOf', args: [answerer.address] }));
    if (balance < minWithdrawWei) return 'idle';
    const journal = `flurbo:hybrid-answer:v1:withdraw:${answerer.address.toLowerCase()}:${balance}`;
    const saved = await command('GET', journal);
    if (saved === 'preparing') return 'pending';
    if (saved) {
      const receipt = await source.getTransactionReceipt({ hash: saved }).catch(() => null);
      if (!receipt) return 'pending';
      if (receipt.status !== 'success') {
        await command('DEL', journal);
        throw Error('Reality credit withdrawal reverted');
      }
      return 'confirmed';
    }
    const simulated = await source.simulateContract({ address: reality, abi: fullRealityAbi,
      functionName: 'withdraw', account: answerer });
    if (await command('SET', journal, 'preparing', 'EX', 1800, 'NX') !== 'OK') return 'pending';
    const hash = await answererClient.writeContract({ ...simulated.request, account: answerer, chain: sepolia });
    if (!hash32(hash)) throw Error('Hybrid settlement transaction hash invalid');
    await command('SET', journal, hash, 'EX', 86400);
    return 'submitted';
  }

  const STAGE = { reality: 'report', propose: 'propose', finalize: 'finalize', deliver: 'deliver' };
  const line = (id, { event, stage, code, message }) =>
    `${id}${event === null ? '' : ` event ${event}`} ${stage} ${code}: ${message}`;
  const ordered = failures => [...failures].sort(([a], [b]) => a === 'pool' ? -1 : b === 'pool' ? 1 : Number(a) - Number(b));

  function remember(id, failures) {
    const before = eventErrors.get(id) || new Map(), after = new Map();
    for (const [slot, failure] of ordered(failures)) {
      const old = before.get(slot);
      const kept = old && old.stage === failure.stage && old.code === failure.code;
      after.set(slot, { ...failure, since: kept ? old.since : new Date().toISOString() });
      if (!kept || old.message !== failure.message) console.error(`Hybrid settlement ${line(id, failure)}`);
    }
    if (after.size) eventErrors.set(id, after); else eventErrors.delete(id);
  }

  async function tick() {
    if (running) return;
    running = true; cycles++;
    try {
      for (const record of pools) {
        const failures = new Map();
        const fail = (event, stage, error) => failures.set(event === null ? 'pool' : String(event),
          { event, stage, ...publicHybridError(error, stage) });
        try {
          const snapshot = await readHybridSnapshot(record, market);
          if (!snapshot.delivered && !snapshot.resolved) {
            await collect(record, snapshot, fail);
            let monadSent = false;
            for (const action of nextHybridActions(snapshot)) {
              const event = action.event ?? null, item = event === null ? null : record.prepared.draft.events[event];
              let stage = action.kind === 'reality' && item.rule ? 'answer' : STAGE[action.kind];
              try {
                if (action.kind === 'reality' && item.rule) await answer(record, event);
                if (monadSent) continue;
                stage = STAGE[action.kind];
                const result = action.kind === 'propose' ? await propose(record, event)
                  : action.kind === 'reality' ? await reportReality(record, event)
                    : await send(record, action.kind, event ?? 'all', relayClient, relay, record.resolver, resolverAbi,
                      action.kind, event === null ? [] : [event]);
                if (result === 'submitted') monadSent = true;
              } catch (error) { fail(event, stage, error); }
            }
          }
          if (isLsPrepared(record.prepared) && snapshot.now >= record.prepared.draft.closesAt) {
            try {
              const surplus = await market.readContract({ address: getAddress(record.pool), abi: poolAbi, functionName: 'surplus' });
              sweeps.set(record.id, surplus < minSweepAtoms ? 'idle' : await send(record, 'sweep',
                snapshot.resolved ? 'settled' : 'closed', relayClient, relay, record.pool, poolAbi, 'withdrawSurplus', []));
            } catch (error) { fail(null, 'sweep', error); }
          }
        } catch (error) { fail(null, 'snapshot', error); }
        remember(record.id, failures);
      }
      if (answerer) {
        const failures = new Map();
        try { await withdrawRealityCredit(); }
        catch (error) { failures.set('pool', { event: null, stage: 'withdraw', ...publicHybridError(error, 'withdraw') }); }
        remember('answerer', failures);
      }
      lastError = [...pools.map(record => record.id), 'answerer'].filter(id => eventErrors.has(id))
        .flatMap(id => [...eventErrors.get(id).values()].map(failure => line(id, failure))).join('; ') || null;
    } catch (error) {
      lastError = publicHybridError(error, 'worker').message;
      console.error(lastError);
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }

  return { tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, pools: pools.length,
      proposer: proposer.address, relay: relay.address, answerer: answerer?.address ?? null,
      answers: Object.fromEntries(answers), sweeps: Object.fromEntries(sweeps), lastError, lastFinishedAt,
      events: Object.fromEntries([...eventErrors].map(([id, failures]) => [id, Object.fromEntries(
        [...failures].map(([slot, { stage, code, since }]) => [slot, { stage, code, since }]))])) }; },
  };
}
