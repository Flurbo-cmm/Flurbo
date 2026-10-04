import { createPublicClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, keccak256, parseAbi, parseAbiItem, parseEther, parseUnits, toHex } from 'viem';
import { validateRealityRoute } from './reality-relay.mjs';

export const SEPOLIA_REALITY = '0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA';
export const SEPOLIA_KLEROS = '0x05b942faecfb3924970e3a28e0f230910cedff45';
export const EVIDENCE_PATH = '/api/oracle/evidence/';
export const TEST_AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
const ZERO = `0x${'0'.repeat(64)}`;
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hex32 = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value > 0;
const publicUrl = value => {
  try {
    const u = new URL(value);
    return typeof value === 'string' && value.length <= 512 && u.protocol === 'https:' && !!u.hostname
      && !u.username && !u.password && !/[\s\u0000-\u001f\u007f]/.test(value);
  } catch { return false; }
};

export const realityAbi = parseAbi([
  'function getContentHash(bytes32) view returns (bytes32)',
  'function getArbitrator(bytes32) view returns (address)',
  'function getTimeout(bytes32) view returns (uint32)',
  'function getOpeningTS(bytes32) view returns (uint32)',
  'function getFinalizeTS(bytes32) view returns (uint32)',
  'function getBond(bytes32) view returns (uint256)',
  'function getMinBond(bytes32) view returns (uint256)',
  'function getBestAnswer(bytes32) view returns (bytes32)',
  'function getHistoryHash(bytes32) view returns (bytes32)',
  'function isFinalized(bytes32) view returns (bool)',
  'function isPendingArbitration(bytes32) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function submitAnswer(bytes32,bytes32,uint256) payable',
  'function claimWinnings(bytes32,bytes32[],address[],uint256[],bytes32[])',
  'function withdraw()',
]);
export const proxyAbi = parseAbi([
  'function realitio() view returns (address)',
  'function getDisputeFee(bytes32) view returns (uint256)',
  'function requestArbitration(bytes32,uint256) payable returns (uint256)',
  'function submitEvidence(uint256,string)',
  'function reportAnswer(bytes32,bytes32,bytes32,address)',
  'function arbitrationRequests(uint256) view returns (uint8 status,address requester,uint256 disputeID,uint256 ruling)',
  'function arbitrator() view returns (address)',
  'function arbitratorExtraData() view returns (bytes)',
  'function getMultipliers() pure returns (uint256 winner,uint256 loser,uint256 loserPeriod,uint256 denominator)',
  'function fundAppeal(uint256,uint256) payable returns (bool)',
  'function getTotalWithdrawableAmount(uint256,address,uint256) view returns (uint256)',
  'function withdrawFeesAndRewardsForAllRounds(uint256,address,uint256)',
]);
export const answerEvent = parseAbiItem('event LogNewAnswer(bytes32 answer,bytes32 indexed question_id,bytes32 history_hash,address indexed user,uint256 bond,uint256 ts,bool is_commitment)');
export const courtAbi = parseAbi([
  'function appealPeriod(uint256) view returns (uint256 start,uint256 end)',
  'function currentRuling(uint256) view returns (uint256)',
  'function appealCost(uint256,bytes) view returns (uint256)',
]);
export const poolAbi = parseAbi([
  'function protocolVersion() pure returns (uint8)',
  'function collateral() view returns (address)',
  'function resolver() view returns (address)',
  'function settlementRulesHash() view returns (bytes32)',
  'function eventCount() view returns (uint8)',
  'function closesAt() view returns (uint64)',
  'function funded() view returns (bool)',
  'function resolved() view returns (bool)',
  'function holdings(address,uint32,uint256) view returns (uint128)',
  'function quoteBuy(uint32,uint256,uint128) view returns (uint128)',
  'function quoteSell(uint32,uint256,uint128) view returns (uint128)',
  'function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function sell(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function payoutFraction(uint32,uint256) view returns (uint256 numerator,uint256 denominator)',
  'function redeem(uint32,uint256,uint128) returns (uint128)',
]);
export const resolverAbi = parseAbi([
  'function protocolVersion() pure returns (uint8)',
  'function rulesHash() view returns (bytes32)',
  'function pool() view returns (address)',
  'function relay() view returns (address)',
  'function eventCount() view returns (uint8)',
  'function eventHashes(uint256) view returns (bytes32)',
  'function observationEnds(uint256) view returns (uint64)',
  'function reportDeadline(uint8) view returns (uint64)',
  'function caseState(uint8) view returns ((uint8 phase,uint8 result,bytes32 evidenceHash))',
]);
export const cashAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

export function oracleCatalog(value) {
  if (value?.schema !== 'flurbo.oracle-catalog.v1' || !Array.isArray(value.routes) || value.routes.length > 256)
    throw Error('Invalid oracle catalog');
  const ids = new Set(), events = new Set(), pools = new Map();
  for (const route of value.routes) {
    validateRealityRoute(route);
    if (typeof route.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(route.id)
      || ids.has(route.id) || !same(route.reality, SEPOLIA_REALITY)
      || !same(route.arbitrator, SEPOLIA_KLEROS)) throw Error('Invalid oracle route');
    const event = route.pool.toLowerCase() + ':' + route.eventIndex;
    if (events.has(event)) throw Error('Duplicate oracle event');
    ids.add(route.id); events.add(event);
    const pool = route.pool.toLowerCase();
    if (!pools.has(pool)) pools.set(pool, []);
    pools.get(pool).push(route);
  }
  for (const routes of pools.values()) {
    const first = routes[0];
    if (routes.length !== first.publication.events.length
      || routes.some(route => route.publication.events.length !== routes.length
        || !same(route.rulesHash, first.rulesHash) || !same(route.resolver, first.resolver)
        || !same(route.relay, first.relay) || !same(route.pool, first.pool)
        || !Number.isInteger(route.eventIndex) || route.eventIndex >= routes.length))
      throw Error('Incomplete oracle pool routes');
  }
  return value;
}

export function oracleClients(sourceRpc, marketRpc) {
  if (!publicUrl(sourceRpc) || !publicUrl(marketRpc)) throw Error('HTTPS oracle RPC URLs required');
  return [createPublicClient({ transport: http(sourceRpc, { timeout: 12_000 }) }),
    createPublicClient({ transport: http(marketRpc, { timeout: 12_000 }) })];
}

const answerHex = outcome => outcome === 'no' ? ZERO
  : outcome === 'yes' ? `0x${'0'.repeat(63)}1`
  : outcome === 'void' ? `0x${'f'.repeat(64)}` : null;
const toWire = value => typeof value === 'bigint' ? value.toString() : value;
const tx = (chainId, from, to, data, value = 0n) => ({ chainId, from: getAddress(from), to: getAddress(to), data, value: `0x${value.toString(16)}` });

export function oracleService({ catalog, source, market, evidence = null }) {
  const routes = new Map(oracleCatalog(catalog).routes.map(route => [route.id, route]));
  const routeFor = id => {
    const route = routes.get(id);
    if (!route) throw Error('Oracle market not found');
    return route;
  };
  const read = (client, address, abi, functionName, args = []) =>
    client.readContract({ address: getAddress(address), abi, functionName, args });
  const routePublic = route => ({ id: route.id, pool: route.pool, eventIndex: route.eventIndex,
    question: route.publication.events[route.eventIndex].question, closesAt: route.publication.closesAt,
    observationEndsAt: route.publication.events[route.eventIndex].observationEndsAt });
  async function snapshot(id, owner = null) {
    const route = routeFor(id), q = route.questionId, bit = route.eventIndex;
    if (owner !== null && !address(owner)) throw Error('Invalid wallet address');
    const sourceChain = await source.getChainId(), marketChain = await market.getChainId();
    if (sourceChain !== 11155111 || marketChain !== 10143) throw Error('Oracle RPC chain mismatch');
    const [proxyReality, contentHash, arbitrator, timeout, opening, finalizes, bond, minBond,
      bestAnswer, historyHash, finalized, pending, disputeFee, poolVersion, poolCollateral, poolResolver, poolRules, poolCount,
      closesAt, funded, resolved, resolverVersion, resolverRules, resolverPool, relay, resolverCount,
      eventHash, observationEnds, reportDeadline, caseState, sourceBlock, marketBlock] = await Promise.all([
      read(source, route.arbitrator, proxyAbi, 'realitio'),
      read(source, route.reality, realityAbi, 'getContentHash', [q]),
      read(source, route.reality, realityAbi, 'getArbitrator', [q]),
      read(source, route.reality, realityAbi, 'getTimeout', [q]),
      read(source, route.reality, realityAbi, 'getOpeningTS', [q]),
      read(source, route.reality, realityAbi, 'getFinalizeTS', [q]),
      read(source, route.reality, realityAbi, 'getBond', [q]),
      read(source, route.reality, realityAbi, 'getMinBond', [q]),
      read(source, route.reality, realityAbi, 'getBestAnswer', [q]),
      read(source, route.reality, realityAbi, 'getHistoryHash', [q]),
      read(source, route.reality, realityAbi, 'isFinalized', [q]),
      read(source, route.reality, realityAbi, 'isPendingArbitration', [q]),
      read(source, route.arbitrator, proxyAbi, 'getDisputeFee', [q]),
      read(market, route.pool, poolAbi, 'protocolVersion'),
      read(market, route.pool, poolAbi, 'collateral'),
      read(market, route.pool, poolAbi, 'resolver'),
      read(market, route.pool, poolAbi, 'settlementRulesHash'),
      read(market, route.pool, poolAbi, 'eventCount'),
      read(market, route.pool, poolAbi, 'closesAt'),
      read(market, route.pool, poolAbi, 'funded'),
      read(market, route.pool, poolAbi, 'resolved'),
      read(market, route.resolver, resolverAbi, 'protocolVersion'),
      read(market, route.resolver, resolverAbi, 'rulesHash'),
      read(market, route.resolver, resolverAbi, 'pool'),
      read(market, route.resolver, resolverAbi, 'relay'),
      read(market, route.resolver, resolverAbi, 'eventCount'),
      read(market, route.resolver, resolverAbi, 'eventHashes', [BigInt(bit)]),
      read(market, route.resolver, resolverAbi, 'observationEnds', [BigInt(bit)]),
      read(market, route.resolver, resolverAbi, 'reportDeadline', [bit]),
      read(market, route.resolver, resolverAbi, 'caseState', [bit]),
      source.getBlock(), market.getBlock(),
    ]);
    if (!same(proxyReality, route.reality) || !same(contentHash, route.contentHash)
      || !hex32(historyHash)
      || !same(arbitrator, route.arbitrator) || Number(timeout) < route.minTimeout
      || BigInt(minBond) < BigInt(route.minBond) || poolVersion !== 3 || resolverVersion !== 3
      || !same(poolCollateral, TEST_AUSD) || !same(poolResolver, route.resolver) || !same(poolRules, route.rulesHash)
      || !same(resolverRules, route.rulesHash) || !same(resolverPool, route.pool)
      || !same(relay, route.relay) || poolCount !== resolverCount
      || poolCount !== route.publication.events.length || !same(eventHash, route.eventHash)
      || Number(closesAt) !== route.publication.closesAt
      || Number(observationEnds) !== route.publication.events[bit].observationEndsAt
      || !funded) throw Error('Oracle deployment binding mismatch');
    const sourceNow = Number(sourceBlock.timestamp), marketNow = Number(marketBlock.timestamp);
    if (!time(sourceNow) || !time(marketNow)) throw Error('Oracle chain time unavailable');
    const currentBond = BigInt(bond), minimumBond = BigInt(minBond);
    const minimumNext = [minimumBond, currentBond * 2n, 1n].reduce((a, b) => a > b ? a : b);
    const arbitrationId = BigInt(q);
    const details = await read(source, route.arbitrator, proxyAbi, 'arbitrationRequests', [arbitrationId]);
    const requester = details[1];
    const dispute = address(requester) && !/^0x0{40}$/i.test(requester)
      ? { status: Number(details[0]), requester, disputeId: toWire(details[2]), ruling: toWire(details[3]) }
      : null;
    const user = owner === null ? null : await Promise.all([
      read(source, route.reality, realityAbi, 'balanceOf', [getAddress(owner)]),
      read(market, route.pool, poolAbi, 'holdings', [getAddress(owner), 1 << bit, 1]),
      read(market, route.pool, poolAbi, 'holdings', [getAddress(owner), 1 << bit, 2]),
      read(market, TEST_AUSD, cashAbi, 'balanceOf', [getAddress(owner)]),
      read(market, TEST_AUSD, cashAbi, 'allowance', [getAddress(owner), getAddress(route.pool)]),
    ]).then(([credit, no, yes, cash, allowance]) => ({ wallet: getAddress(owner),
      creditedEthWei: toWire(credit), noShares: toWire(no), yesShares: toWire(yes),
      cashAtoms: toWire(cash), allowanceAtoms: toWire(allowance) }));
    const phase = Number(caseState.phase ?? caseState[0]);
    const reported = Number(caseState.result ?? caseState[1]);
    return { ...routePublic(route), schema: 'flurbo.oracle-snapshot.v1', sourceChainId: 11155111,
      reality: getAddress(route.reality), arbitrator: getAddress(route.arbitrator), questionId: q,
      historyHash,
      contentHash: route.contentHash, rulesHash: route.rulesHash, eventHash: route.eventHash,
      resolver: getAddress(route.resolver), relay: getAddress(route.relay),
      answer: bestAnswer === ZERO && currentBond === 0n ? null : bestAnswer,
      answerLabel: currentBond === 0n ? null : bestAnswer === answerHex('no') ? 'No'
        : bestAnswer === answerHex('yes') ? 'Yes' : bestAnswer.toLowerCase() === answerHex('void') ? 'Void' : 'Unsupported answer',
      bondWei: currentBond.toString(), minBondWei: minimumBond.toString(), nextBondWei: minimumNext.toString(),
      disputeFeeWei: BigInt(disputeFee).toString(), opensAt: Number(opening), finalizesAt: Number(finalizes),
      sourceNow, marketNow, sourceBlock: toWire(sourceBlock.number), marketBlock: toWire(marketBlock.number),
      finalized, pendingArbitration: pending, dispute, reportDeadline: Number(reportDeadline),
      phase, reported, funded, resolved, user };
  }
  async function appealWindow(route, snap) {
    if (snap.dispute?.status !== 2 || !snap.pendingArbitration) throw Error('No appealable Kleros dispute');
    const court = await read(source, route.arbitrator, proxyAbi, 'arbitrator');
    const [start, end] = await read(source, court, courtAbi, 'appealPeriod', [BigInt(snap.dispute.disputeId)]);
    if (BigInt(snap.sourceNow) < BigInt(start) || BigInt(snap.sourceNow) >= BigInt(end))
      throw Error('Appeal funding window closed');
    return { opensAt: Number(start), endsAt: Number(end) };
  }
  function claimFor(route, input) {
    const chosen = input?.claim === undefined
      ? [{ eventIndex: route.eventIndex, side: input?.side }]
      : input.claim;
    if (!Array.isArray(chosen) || chosen.length < 1 || chosen.length > 3
      || chosen.some(item => !item || !Number.isInteger(item.eventIndex)
        || item.eventIndex < 0 || item.eventIndex >= route.publication.events.length
        || !['yes', 'no'].includes(item.side))
      || !chosen.some(item => item.eventIndex === route.eventIndex && item.side === input?.side))
      throw Error('Select one to three outcomes from this pool');
    const ordered = [...chosen].sort((a, b) => a.eventIndex - b.eventIndex);
    if (ordered.some((item, i) => i > 0 && item.eventIndex === ordered[i - 1].eventIndex))
      throw Error('Select each question once');
    let scope = 0, state = 0;
    ordered.forEach((item, i) => {
      scope = (scope | (1 << item.eventIndex)) >>> 0;
      if (item.side === 'yes') state |= 1 << i;
    });
    return { scope, mask: 1 << state, chosen: ordered };
  }
  async function answerHistory(route) {
    const q = route.questionId;
    const creation = await source.getTransactionReceipt({ hash: route.publication.events[route.eventIndex].source.questionTxHash });
    if (creation.status !== 'success') throw Error('Reality creation receipt unavailable');
    const latest = await source.getBlockNumber();
    const from = BigInt(creation.blockNumber);
    if (latest < from || latest - from > 1_000_000n) throw Error('Reality answer history exceeds the supported scan');
    const logs = [];
    for (let start = from; start <= latest; start += 10_000n) {
      const end = start + 9_999n > latest ? latest : start + 9_999n;
      logs.push(...await source.getLogs({ address: getAddress(route.reality), event: answerEvent,
        args: { question_id: q }, fromBlock: start, toBlock: end }));
    }
    return logs.map(log => log.args);
  }
  async function prepare(id, action, input, owner) {
    const route = routeFor(id);
    if (!address(owner)) throw Error('Select a MetaMask wallet');
    const snap = await snapshot(id, owner), q = route.questionId;
    if (action === 'answer') {
      const encoded = answerHex(input?.answer);
      if (!encoded || typeof input?.bondEth !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.bondEth)) throw Error('Enter a valid answer and ETH bond');
      if (snap.finalized || snap.pendingArbitration || snap.sourceNow < snap.opensAt
        || snap.bondWei !== '0' && snap.sourceNow >= snap.finalizesAt) throw Error('Reality answer window closed');
      const amount = parseEther(input.bondEth);
      if (amount < BigInt(snap.nextBondWei)) throw Error('Bond must meet the current minimum');
      return { action, amountWei: amount.toString(), reason: `Post ${input.answer.toUpperCase()} with ${input.bondEth} Sepolia ETH bond`,
        transaction: tx(11155111, owner, route.reality,
          encodeFunctionData({ abi: realityAbi, functionName: 'submitAnswer', args: [q, encoded, BigInt(snap.bondWei)] }), amount) };
    }
    if (action === 'arbitrate') {
      if (snap.finalized || snap.pendingArbitration || snap.bondWei === '0'
        || snap.sourceNow >= snap.finalizesAt) throw Error('Arbitration request window closed');
      const fee = BigInt(snap.disputeFeeWei);
      if (fee <= 0n) throw Error('Kleros arbitration fee unavailable');
      return { action, amountWei: fee.toString(), reason: `Request Kleros arbitration for ${formatEther(fee)} Sepolia ETH`,
        transaction: tx(11155111, owner, route.arbitrator,
          encodeFunctionData({ abi: proxyAbi, functionName: 'requestArbitration', args: [q, BigInt(snap.bondWei)] }), fee) };
    }
    if (action === 'evidence') {
      if (!snap.pendingArbitration || !hex32(input?.hash) || !evidence) throw Error('Evidence submission unavailable');
      const uri = await evidence.uriFor(route, input.hash);
      return { action, amountWei: '0', reason: 'Submit your public evidence to the Kleros proxy',
        transaction: tx(11155111, owner, route.arbitrator,
          encodeFunctionData({ abi: proxyAbi, functionName: 'submitEvidence', args: [BigInt(q), uri] })) };
    }
    if (action === 'finalizeArbitration') {
      if (!snap.pendingArbitration || snap.dispute?.status !== 3)
        throw Error('Kleros ruling is not ready to report');
      const logs = await answerHistory(route);
      if (!logs.length) throw Error('Reality answer history unavailable');
      const last = logs.at(-1), before = logs.length > 1 ? logs.at(-2).history_hash : ZERO;
      if (!same(last.history_hash, snap.historyHash) || BigInt(last.bond) !== BigInt(snap.bondWei)
        || !address(last.user) || !hex32(last.answer)) throw Error('Reality answer history mismatch');
      const args = [q, before, last.answer, getAddress(last.user)];
      await source.simulateContract({ address: getAddress(route.arbitrator), abi: proxyAbi,
        functionName: 'reportAnswer', args, account: getAddress(owner) });
      return { action, amountWei: '0', reason: 'Report the final Kleros ruling back to Reality',
        transaction: tx(11155111, owner, route.arbitrator,
          encodeFunctionData({ abi: proxyAbi, functionName: 'reportAnswer', args })) };
    }
    if (action === 'appeal') {
      const ruling = Number(input?.ruling);
      if (![0, 1, 2].includes(ruling) || typeof input?.amountEth !== 'string'
        || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.amountEth))
        throw Error('Select a ruling and enter a valid Sepolia ETH contribution');
      const amount = parseEther(input.amountEth);
      if (amount === 0n) throw Error('Appeal contribution must be positive');
      const window = await appealWindow(route, snap);
      const data = encodeFunctionData({ abi: proxyAbi, functionName: 'fundAppeal',
        args: [BigInt(q), BigInt(ruling)] });
      await source.simulateContract({ address: getAddress(route.arbitrator), abi: proxyAbi,
        functionName: 'fundAppeal', args: [BigInt(q), BigInt(ruling)], account: getAddress(owner), value: amount });
      return { action, ...window, amountWei: amount.toString(),
        reason: `Contribute ${input.amountEth} Sepolia ETH to the ${['Refuse to rule', 'No', 'Yes'][ruling]} appeal`,
        transaction: tx(11155111, owner, route.arbitrator, data, amount) };
    }
    if (action === 'claimAppeal') {
      const ruling = Number(input?.ruling);
      if (![0, 1, 2].includes(ruling) || !snap.dispute) throw Error('Select a disputed ruling');
      const available = BigInt(await read(source, route.arbitrator, proxyAbi,
        'getTotalWithdrawableAmount', [BigInt(q), getAddress(owner), BigInt(ruling)]));
      if (available === 0n) throw Error('No appeal rewards available for this ruling');
      return { action, amountWei: '0', rewardWei: available.toString(),
        reason: `Claim ${formatEther(available)} Sepolia ETH in appeal fees and rewards`,
        transaction: tx(11155111, owner, route.arbitrator, encodeFunctionData({
          abi: proxyAbi, functionName: 'withdrawFeesAndRewardsForAllRounds',
          args: [BigInt(q), getAddress(owner), BigInt(ruling)] })) };
    }
    if (action === 'withdraw') {
      if (!snap.user || BigInt(snap.user.creditedEthWei) === 0n) throw Error('No credited Reality balance to withdraw');
      return { action, amountWei: '0', reason: `Withdraw ${formatEther(BigInt(snap.user.creditedEthWei))} credited Sepolia ETH`,
        transaction: tx(11155111, owner, route.reality,
          encodeFunctionData({ abi: realityAbi, functionName: 'withdraw' })) };
    }
    if (action === 'claimWinnings') {
      if (!snap.finalized || same(snap.historyHash, ZERO)) throw Error('Reality bonds are not ready to claim');
      const logs = await answerHistory(route);
      const current = logs.findLastIndex(item => same(item.history_hash, snap.historyHash));
      if (current < 0) throw Error('Reality answer history mismatch');
      if (!logs.slice(0, current + 1).some(item => same(item.user, owner)))
        throw Error('This wallet did not post an answer bond');
      const selected = [];
      for (let i = current; i >= 0 && selected.length < 32; i--) {
        const item = logs[i];
        if (!address(item.user) || !hex32(item.answer) || !hex32(item.history_hash))
          throw Error('Reality answer history mismatch');
        selected.push({ answer: item.answer, user: getAddress(item.user), bond: BigInt(item.bond),
          previous: i === 0 ? ZERO : logs[i - 1].history_hash });
      }
      const args = [q, selected.map(item => item.previous), selected.map(item => item.user),
        selected.map(item => item.bond), selected.map(item => item.answer)];
      await source.simulateContract({ address: getAddress(route.reality), abi: realityAbi,
        functionName: 'claimWinnings', args, account: getAddress(owner) });
      return { action, amountWei: '0', reason: 'Process Reality answer bonds and credit eligible winners',
        transaction: tx(11155111, owner, route.reality,
          encodeFunctionData({ abi: realityAbi, functionName: 'claimWinnings', args })) };
    }
    if (action === 'position') {
      const { scope, mask } = claimFor(route, input);
      const holdings = await read(market, route.pool, poolAbi, 'holdings',
        [getAddress(owner), scope, BigInt(mask)]);
      return { action, scope, mask, holdingsAtoms: BigInt(holdings).toString() };
    }
    if (action === 'buy' || action === 'approve' || action === 'sell' || action === 'redeem') {
      const side = input?.side;
      if (!['yes', 'no'].includes(side) || typeof input?.quantity !== 'string'
        || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input.quantity)) throw Error('Enter a valid share quantity');
      const quantity = parseUnits(input.quantity, 6);
      if (quantity === 0n || quantity > 1_000_000_000_000n) throw Error('Share quantity out of range');
      const { scope, mask, chosen } = claimFor(route, input);
      const holdings = chosen.length === 1 ? BigInt(side === 'yes' ? snap.user.yesShares : snap.user.noShares)
        : BigInt(await read(market, route.pool, poolAbi, 'holdings',
          [getAddress(owner), scope, BigInt(mask)]));
      if (action === 'redeem') {
        if (!snap.resolved || holdings < quantity)
          throw Error('Shares are not ready to redeem');
        const [num, den] = await read(market, route.pool, poolAbi, 'payoutFraction', [scope, BigInt(mask)]);
        const payout = quantity * BigInt(num) / BigInt(den);
        return { action, amountAtoms: payout.toString(), reason: `Redeem ${input.quantity} selected shares for about ${Number(payout) / 1e6} test AUSD`,
          transaction: tx(10143, owner, route.pool, encodeFunctionData({ abi: poolAbi,
            functionName: 'redeem', args: [scope, BigInt(mask), quantity] })) };
      }
      if (snap.resolved || snap.marketNow >= snap.closesAt) throw Error('Trading is closed');
      if (action === 'sell') {
        if (holdings < quantity)
          throw Error('Insufficient shares to sell');
        const quotedSell = BigInt(await read(market, route.pool, poolAbi, 'quoteSell', [scope, BigInt(mask), quantity]));
        const minProceeds = quotedSell - quotedSell / 100n;
        return { action, amountAtoms: quotedSell.toString(), minProceedsAtoms: minProceeds.toString(),
          reason: `Sell ${input.quantity} selected shares for at least ${formatUnits(minProceeds, 6)} test AUSD`,
          transaction: tx(10143, owner, route.pool, encodeFunctionData({ abi: poolAbi,
            functionName: 'sell', args: [scope, BigInt(mask), quantity, minProceeds, BigInt(snap.marketNow + 120)] })) };
      }
      const quoted = await read(market, route.pool, poolAbi, 'quoteBuy', [scope, BigInt(mask), quantity]);
      const maxCost = BigInt(quoted) + (BigInt(quoted) + 99n) / 100n;
      if (action === 'approve') {
        if (BigInt(snap.user.allowanceAtoms) >= maxCost) throw Error('Approval already covers this purchase');
        return { action, amountAtoms: maxCost.toString(), reason: `Approve at most ${Number(maxCost) / 1e6} test AUSD for this pool`,
          transaction: tx(10143, owner, TEST_AUSD,
            encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [route.pool, maxCost] })) };
      }
      if (BigInt(snap.user.cashAtoms) < maxCost || BigInt(snap.user.allowanceAtoms) < maxCost)
        throw Error('Fund your wallet and approve this purchase first');
      return { action, amountAtoms: BigInt(quoted).toString(), maxCostAtoms: maxCost.toString(),
        reason: `Buy ${input.quantity} selected shares for at most ${Number(maxCost) / 1e6} test AUSD`,
        transaction: tx(10143, owner, route.pool, encodeFunctionData({ abi: poolAbi,
          functionName: 'buy', args: [scope, BigInt(mask), quantity, maxCost, BigInt(snap.marketNow + 120)] })) };
    }
    throw Error('Unsupported oracle action');
  }
  return { list: () => [...routes.values()].map(routePublic), routeFor, snapshot, prepare };
}

export function oracleEvidence(command, origin) {
  if (typeof command !== 'function' || typeof origin !== 'string' || !/^https:\/\//.test(origin))
    throw Error('Durable public evidence storage required');
  const key = hash => `flurbo:oracle:evidence:v1:${hash}`;
  const quota = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n";
  async function get(hash) {
    if (!hex32(hash)) throw Error('Invalid evidence hash');
    const body = await command('GET', key(hash.toLowerCase()));
    if (typeof body !== 'string' || keccak256(toHex(body)) !== hash.toLowerCase()) throw Error('Evidence unavailable');
    return body;
  }
  return {
    get,
    async putRelay(evidenceJson) {
      if (typeof evidenceJson !== 'string' || evidenceJson.length > 12000) throw Error('Invalid relay evidence');
      const body = JSON.parse(evidenceJson);
      if (body.schema !== 'flurbo.reality-evidence.v2') throw Error('Invalid relay evidence');
      const hash = keccak256(toHex(evidenceJson));
      await command('SET', key(hash), evidenceJson, 'NX');
      if (await get(hash) !== evidenceJson) throw Error('Relay evidence persistence failed');
      return origin + EVIDENCE_PATH + hash;
    },
    uriFor: async (route, hash) => {
      const body = JSON.parse(await get(hash));
      if (!same(body.questionId, route.questionId) || !same(body.pool, route.pool))
        throw Error('Evidence belongs to another question');
      return origin + EVIDENCE_PATH + hash.toLowerCase();
    },
    async put(route, account, input) {
      if (typeof input?.name !== 'string' || input.name.trim().length < 4 || input.name.length > 120
        || typeof input?.description !== 'string' || input.description.trim().length < 20
        || input.description.length > 8000 || !publicUrl(input.sourceURL))
        throw Error('Provide a title, public explanation, and HTTPS source URL');
      const body = JSON.stringify({ schema: 'flurbo.kleros-evidence.v1', name: input.name.trim(),
        description: input.description.trim(), fileURI: input.sourceURL, questionId: route.questionId,
        pool: route.pool, eventIndex: route.eventIndex });
      const hash = keccak256(toHex(body));
      if (await command('GET', key(hash)) !== body) {
        const hour = Math.floor(Date.now() / 3_600_000);
        const count = Number(await command('EVAL', quota, 1, `flurbo:oracle:evidence-quota:${hour}:${account}`));
        if (!Number.isSafeInteger(count) || count > 20) throw Error('Evidence upload limit reached');
        await command('SET', key(hash), body, 'NX');
        if (await command('GET', key(hash)) !== body) throw Error('Evidence persistence failed');
      }
      return { hash, uri: origin + EVIDENCE_PATH + hash };
    },
  };
}


