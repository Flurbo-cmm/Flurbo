import { createPublicClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, keccak256, parseAbi, parseAbiItem, parseEther, parseUnits, toHex } from 'viem';
import { validateRealityRoute } from './reality-relay.mjs';
import { pilotIndex } from './pilot-index.mjs';

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
      || route.deploymentBlock !== undefined && (!Number.isSafeInteger(route.deploymentBlock) || route.deploymentBlock < 0)
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
        || route.deploymentBlock !== first.deploymentBlock
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
    poolTitle: route.publication.title, question: route.publication.events[route.eventIndex].question, closesAt: route.publication.closesAt,
    observationEndsAt: route.publication.events[route.eventIndex].observationEndsAt,
    questionTxHash: route.publication.events[route.eventIndex].source.questionTxHash });
  async function marketSummary(id) {
    const route = routeFor(id);
    if (await market.getChainId() !== 10143) throw Error('Oracle RPC chain mismatch');
    const [block, funded, resolved] = await Promise.all([
      market.getBlock(),
      read(market, route.pool, poolAbi, 'funded'),
      read(market, route.pool, poolAbi, 'resolved'),
    ]);
    const marketNow = Number(block.timestamp);
    if (!time(marketNow)) throw Error('Oracle chain time unavailable');
    let yes = null, no = null;
    if (funded && !resolved && marketNow < route.publication.closesAt) {
      const scope = (1 << route.eventIndex) >>> 0;
      const quotes = await Promise.allSettled([
        read(market, route.pool, poolAbi, 'quoteBuy', [scope, 2n, 1_000_000n]),
        read(market, route.pool, poolAbi, 'quoteBuy', [scope, 1n, 1_000_000n]),
      ]);
      if (quotes[0].status === 'fulfilled') yes = BigInt(quotes[0].value).toString();
      if (quotes[1].status === 'fulfilled') no = BigInt(quotes[1].value).toString();
    }
    return { schema: 'flurbo.oracle-market.v1', id, pool: route.pool, marketNow,
      blockNumber: BigInt(block.number).toString(), blockHash: block.hash, funded, resolved,
      prices: { yes, no } };
  }
  function noticePools(command) {
    if (!command) return [];
    const pools = new Map();
    for (const route of routes.values()) {
      const key = route.pool.toLowerCase();
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(route);
    }
    return [...pools].filter(([, group]) => group.every(route => Number.isSafeInteger(route.deploymentBlock))).map(([pool, group]) => {
      const first = group[0], resolver = first.resolver.toLowerCase(), deploymentBlock = first.deploymentBlock;
      let indexPromise = null;
      async function refresh() {
        if (!indexPromise) indexPromise = market.getBlock({ blockNumber: BigInt(deploymentBlock) }).then(block => {
          if (!block?.hash) throw Error('Oracle deployment block unavailable');
          return pilotIndex({ manifest: { pool, resolver, verifiedBlock: deploymentBlock,
            verifiedBlockHash: block.hash.toLowerCase() }, command,
          maxBlocks: 10_000, initialWindowSize: 1000,
          rpc: async (method, params) => {
            try { return await market.request({ method, params }); }
            catch (error) {
              if (method === 'eth_getLogs' && /block range|range.{0,40}(limit|large|exceed)|limit.{0,40}range|too many (results|logs)|response size/i.test(String(error?.message || '')))
                throw Object.assign(Error('Oracle log range rejected'), { code: 'LOG_RANGE_LIMIT' });
              throw error;
            }
          } });
        }).catch(error => { indexPromise = null; throw error; });
        return (await indexPromise).refresh();
      }
      const sorted = [...group].sort((a, b) => a.eventIndex - b.eventIndex);
      const service = {
        manifest: { pool, publication: { draft: { closesAt: first.publication.closesAt,
          events: sorted.map(route => ({ question: route.publication.events[route.eventIndex].question,
            observationEndsAt: route.publication.events[route.eventIndex].observationEndsAt })) } } },
        index: { refresh },
        eventHref: event => `/markets/oracle/${sorted[event].id}`,
        payoutHref: `/markets/oracle/${sorted[0].id}`,
        async status() {
          const [sourceBlock, resolved] = await Promise.all([
            source.getBlock({ blockTag: 'finalized' }), read(market, pool, poolAbi, 'resolved'),
          ]);
          const cases = await Promise.all(sorted.map(async route => {
            const args = [route.questionId], sourceRead = functionName => source.readContract({
              address: getAddress(route.reality), abi: realityAbi, functionName, args,
              blockNumber: sourceBlock.number,
            });
            const [bond, answer, finalizesAt, pending, finalized] = await Promise.all([
              sourceRead('getBond'), sourceRead('getBestAnswer'), sourceRead('getFinalizeTS'),
              sourceRead('isPendingArbitration'), sourceRead('isFinalized'),
            ]);
            const proposal = answer === answerHex('no') ? 1 : answer === answerHex('yes') ? 2
              : answer?.toLowerCase() === answerHex('void') ? 3 : 0;
            const challengeUntil = Number(finalizesAt);
            return { phase: BigInt(bond) > 0n && !pending && !finalized && proposal > 0
              && challengeUntil > Number(sourceBlock.timestamp) ? 1 : 0, proposal, challengeUntil };
          }));
          return { resolved, delivered: resolved, cases };
        },
        async positions(wallet, claims) {
          const resolved = await read(market, pool, poolAbi, 'resolved');
          const rows = await Promise.all(claims.map(async claim => {
            const quantity = BigInt(await read(market, pool, poolAbi, 'holdings',
              [getAddress(wallet), claim.scope, BigInt(claim.mask)]));
            let payoutAtoms = null;
            if (resolved && quantity > 0n) {
              const [num, den] = await read(market, pool, poolAbi, 'payoutFraction',
                [claim.scope, BigInt(claim.mask)]);
              payoutAtoms = (quantity * BigInt(num) / BigInt(den)).toString();
            }
            return { ...claim, quantity: quantity.toString(), payoutAtoms };
          }));
          return { rows };
        },
      };
      return { namespace: `oracle:${pool}`, label: first.publication.title, service };
    });
  }
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
    if (action === 'buy' || action === 'approve' || action === 'sell' || action === 'redeem' || action === 'quote') {
      const side = input?.side;
      if (!['yes', 'no'].includes(side) || typeof input?.quantity !== 'string'
        || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input.quantity)) throw Error('Enter a valid share quantity');
      const quantity = parseUnits(input.quantity, 6);
      if (quantity === 0n || quantity > 1_000_000_000_000n) throw Error('Share quantity out of range');
      const { scope, mask, chosen } = claimFor(route, input);
      const holdings = chosen.length === 1 ? BigInt(side === 'yes' ? snap.user.yesShares : snap.user.noShares)
        : BigInt(await read(market, route.pool, poolAbi, 'holdings',
          [getAddress(owner), scope, BigInt(mask)]));
      if (action === 'quote') {
        if (snap.resolved || snap.marketNow >= snap.closesAt) throw Error('Trading is closed');
        const buyAtoms = BigInt(await read(market, route.pool, poolAbi, 'quoteBuy', [scope, BigInt(mask), quantity]));
        const maxCostAtoms = buyAtoms + (buyAtoms + 99n) / 100n;
        let sellAtoms = null;
        if (holdings >= quantity) {
          try { sellAtoms = BigInt(await read(market, route.pool, poolAbi, 'quoteSell', [scope, BigInt(mask), quantity])).toString(); }
          catch { sellAtoms = null; }
        }
        return { action, buyAtoms: buyAtoms.toString(), maxCostAtoms: maxCostAtoms.toString(), sellAtoms,
          allowanceAtoms: snap.user.allowanceAtoms, cashAtoms: snap.user.cashAtoms, holdingsAtoms: holdings.toString() };
      }
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
  return { list: () => [...routes.values()].map(routePublic), routeFor, marketSummary, noticePools, snapshot, prepare };
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
    async putHybridCase({ pool, resolver, eventIndex, eventHash, requestId, question,
      proposal, counter, proposalEvidenceURI, counterEvidenceURI }) {
      if (![pool, resolver].every(address) || ![eventHash, requestId].every(hex32)
        || !Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex > 31
        || typeof question !== 'string' || question.length < 8 || question.length > 1000
        || ![1, 2, 3].includes(proposal) || ![1, 2, 3].includes(counter) || proposal === counter
        || !publicUrl(proposalEvidenceURI) || !publicUrl(counterEvidenceURI))
        throw Error('Invalid hybrid case evidence');
      const body = JSON.stringify({ schema: 'flurbo.kleros-evidence.v1', name: `Flurbo question ${eventIndex + 1} challenge`,
        description: `${question}\n\nProposed: ${['', 'No', 'Yes', 'Void'][proposal]}. Source evidence: ${proposalEvidenceURI}\n\nChallenged with: ${['', 'No', 'Yes', 'Void'][counter]}. Counterevidence: ${counterEvidenceURI}\n\nRequest ID: ${requestId}`,
        fileURI: proposalEvidenceURI, pool, resolver, eventIndex, eventHash, requestId });
      if (body.length > 12000) throw Error('Hybrid case evidence too large');
      const hash = keccak256(toHex(body));
      await command('SET', key(hash), body, 'NX');
      if (await get(hash) !== body) throw Error('Hybrid case evidence persistence failed');
      return { hash, uri: origin + EVIDENCE_PATH + hash };
    },
    async putHybridRuling({ pool, resolver, eventIndex, eventHash, requestId, sourceCaseId,
      adapter, disputeId, ruling, sourceBlockHash }) {
      if (![pool, resolver, adapter].every(address) || ![eventHash, requestId, sourceCaseId, sourceBlockHash].every(hex32)
        || !Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex > 31
        || !/^(0|[1-9][0-9]*)$/.test(disputeId) || ![1, 2, 3].includes(ruling))
        throw Error('Invalid hybrid ruling evidence');
      const body = JSON.stringify({ schema: 'flurbo.hybrid-ruling-evidence.v1', pool, resolver,
        eventIndex, eventHash, requestId, sourceChainId: 11155111, adapter,
        disputeId, sourceCaseId, ruling, sourceBlockHash });
      const hash = keccak256(toHex(body));
      await command('SET', key(hash), body, 'NX');
      if (await get(hash) !== body) throw Error('Hybrid ruling evidence persistence failed');
      return { hash, uri: origin + EVIDENCE_PATH + hash };
    },
    async putHybridChallenge(route, account, input) {
      if (![route.pool, route.resolver, account].every(address) || !hex32(route.eventHash)
        || !Number.isSafeInteger(route.eventIndex) || route.eventIndex < 0 || route.eventIndex > 31
        || typeof input?.name !== 'string' || input.name.trim().length < 4 || input.name.length > 120
        || typeof input.description !== 'string' || input.description.trim().length < 20
        || input.description.length > 8000 || !publicUrl(input.sourceURL))
        throw Error('Provide a title, public explanation, and HTTPS source URL');
      const body = JSON.stringify({ schema: 'flurbo.hybrid-challenge-evidence.v1',
        name: input.name.trim(), description: input.description.trim(), fileURI: input.sourceURL,
        pool: route.pool, resolver: route.resolver, eventIndex: route.eventIndex,
        eventHash: route.eventHash, uploader: account });
      const hash = keccak256(toHex(body));
      if (await command('GET', key(hash)) !== body) {
        const hour = Math.floor(Date.now() / 3_600_000);
        const count = Number(await command('EVAL', quota, 1, `flurbo:oracle:evidence-quota:${hour}:${account}`));
        if (!Number.isSafeInteger(count) || count > 20) throw Error('Evidence upload limit reached');
        await command('SET', key(hash), body, 'NX');
        if (await get(hash) !== body) throw Error('Evidence persistence failed');
      }
      return { hash, uri: origin + EVIDENCE_PATH + hash };
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


