import { encodeFunctionData, formatUnits, getAddress, parseAbi } from 'viem';
import { hybridSettlementCatalog, readHybridSnapshot } from './hybrid-settlement-worker.mjs';
import { proxyAbi, TEST_AUSD } from './oracle-integration.mjs';
import { hybridRealityAction, hybridRealityAppealAction, hybridRealityClaimAction, hybridRealityReportAction, hybridRealitySnapshot } from './hybrid-reality.mjs';
import { certifiedClaim, certifiedPair, pairInput } from './pair-math.mjs';
import { runPairModel } from './pair-analytics.mjs';
import { simulatePairPurchase } from './pair-sensitivity.mjs';
import { canonical, settlementRuleHash } from './settlement-rules.mjs';
import { encodeClaim } from '../shared/claims.mjs';
import { verifiedLsState } from '../shared/ls-lmsr.mjs';
import { isLsPrepared } from '../scripts/prepare-hybrid-pilot.mjs';

const poolAbi = parseAbi(['function holdings(address,uint32,uint256) view returns (uint128)',
  'function liquidity() view returns (uint128)',
  'function depth() view returns (uint256)',
  'function commissionBps() view returns (uint16)',
  'function eliminationOrder() view returns (uint8[])',
  'function factors() view returns ((uint32 scope,uint128[] values)[])',
  'function quoteBuy(uint32,uint256,uint128) view returns (uint128)',
  'function quoteSell(uint32,uint256,uint128) view returns (uint128)',
  'function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function sell(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function payoutFraction(uint32,uint256) view returns (uint256,uint256)',
  'function redeem(uint32,uint256,uint128) returns (uint128)']);
const resolverAbi = parseAbi(['function challenge(uint8,uint8,bytes32,string)',
  'function withdrawBond()', 'function credits(address) view returns (uint256)']);
const cashAbi = parseAbi(['function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)']);
const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const hash = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const tx = (chainId, from, to, data) => ({ chainId, from: getAddress(from),
  to: getAddress(to), data, value: '0x0' });

function claimFor(record, eventIndex, input) {
  const chosen = input?.claim === undefined ? [{ eventIndex, side: input?.side }] : input.claim;
  const count = record.prepared.draft.events.length;
  if (!Array.isArray(chosen) || chosen.length < 1 || chosen.length > 3
    || chosen.some(item => !Number.isInteger(item?.eventIndex) || item.eventIndex < 0
      || item.eventIndex >= count || !['yes', 'no'].includes(item.side))
    || !chosen.some(item => item.eventIndex === eventIndex && item.side === input?.side))
    throw Error('Select one to three outcomes in this pool');
  const ordered = [...chosen].sort((a, b) => a.eventIndex - b.eventIndex);
  if (ordered.some((item, i) => i > 0 && item.eventIndex === ordered[i - 1].eventIndex))
    throw Error('Choose each question once');
  const rule = ordered.length === 1 ? 'AND' : input?.rule || 'AND';
  if (!['AND', 'OR', 'EXACTLY_ONE'].includes(rule)) throw Error('Choose a supported combination');
  const encoded = encodeClaim({ events: count, rule,
    legs: ordered.map(item => ({ event: item.eventIndex, yes: item.side === 'yes' })) });
  return { scope: BigInt(encoded.scope), mask: BigInt(encoded.mask), chosen: ordered };
}

export function hybridMarketService({ catalog, market, source, evidence, origin, pairModel = runPairModel, command = null }) {
  const pools = hybridSettlementCatalog(catalog).pools;
  const routes = new Map(pools.flatMap(record => record.prepared.draft.events.map((event, eventIndex) => {
    const id = `${record.pool}-${eventIndex}`;
    return [id.toLowerCase(), { id, record, event, eventIndex, pool: record.pool, resolver: record.resolver,
      eventHash: record.prepared.eventHashes[eventIndex] }];
  })));
  const routeFor = id => {
    const route = routes.get(id?.toLowerCase());
    if (!route) throw Error('Hybrid market not found');
    return route;
  };
  const list = () => [...routes.values()].map(({ id, record, event, eventIndex }) => ({
    id, pool: record.pool, poolTitle: record.prepared.draft.title, eventIndex,
    question: event.question, route: event.route, closesAt: record.prepared.draft.closesAt,
    observationEndsAt: event.observationEndsAt }));
  const read = (address_, abi, functionName, args = []) => market.readContract({
    address: getAddress(address_), abi, functionName, args });
  async function marketSummary(id) {
    const route = routeFor(id);
    const snapshot = await readHybridSnapshot(route.record, market);
    const open = !snapshot.resolved && snapshot.now < route.record.prepared.draft.closesAt;
    let yes = null, no = null;
    if (open) {
      const scope = 1n << BigInt(route.eventIndex);
      const quotes = await Promise.allSettled([
        read(route.pool, poolAbi, 'quoteBuy', [scope, 2n, 1_000_000n]),
        read(route.pool, poolAbi, 'quoteBuy', [scope, 1n, 1_000_000n]),
      ]);
      if (quotes[0].status === 'fulfilled') yes = BigInt(quotes[0].value).toString();
      if (quotes[1].status === 'fulfilled') no = BigInt(quotes[1].value).toString();
    }
    return { schema: 'flurbo.hybrid-market.v1', id: route.id, pool: route.pool,
      marketNow: snapshot.now, blockNumber: snapshot.blockNumber.toString(),
      blockHash: snapshot.blockHash, funded: true, resolved: snapshot.resolved,
      prices: { yes, no } };
  }
  async function analysis(id, input) {
    const route = routeFor(id), record = route.record;
    const count = record.prepared.draft.events.length;
    if (!input || !Number.isInteger(input.a) || !Number.isInteger(input.b)
      || input.a === input.b || input.a < 0 || input.b < 0
      || input.a >= count || input.b >= count || typeof input.quantity !== 'string'
      || !/^[1-9]\d{0,7}$/.test(input.quantity)
      || input.rule !== undefined && !['AND', 'OR', 'EXACTLY_ONE'].includes(input.rule)
      || BigInt(input.quantity) > 20_000_000n) throw Error('Choose two questions and up to twenty shares');
    const rule = input.rule || 'AND';
    const head = await readHybridSnapshot(record, market);
    const at = (functionName, args = []) => market.readContract({ address: getAddress(route.pool),
      abi: poolAbi, functionName, args, blockNumber: head.blockNumber });
    const ls = isLsPrepared(record.prepared);
    const [liquidity, order, factors, depth, commissionBps] = await Promise.all([
      at('liquidity'), at('eliminationOrder'), at('factors'),
      ...(ls ? [at('depth'), at('commissionBps')] : []),
    ]);
    const committed = { initialDepthAtoms: record.prepared.liquidityAtoms, commissionBps: record.prepared.commissionBps };
    const verified = ls ? verifiedLsState(committed, { events: count, a: input.a, b: input.b,
      order: order.map(Number), factors, liquidity, commissionBps, depth }) : null;
    if (ls && !verified) throw Error('Hybrid comparison unavailable');
    const state = verified ? verified.state : { events: count, a: input.a, b: input.b, liquidity: String(liquidity),
      order: order.map(Number), factors: factors.map(f => ({ scope: Number(f.scope),
        values: f.values.map(String) })) };
    const encoded = pairInput(state), certified = certifiedPair(state);
    const reference = await pairModel(encoded);
    for (const [key, value] of Object.entries(certified.values)) {
      const actual = reference?.[key];
      if (typeof actual !== 'number' || !Number.isFinite(actual)
        || actual < (key === 'difference' ? -1 : 0) || actual > 1
        || value !== null && Math.round(Math.abs(actual) * 1000) * Math.sign(actual) !== value)
        throw Error('Hybrid comparison unavailable');
    }
    const closed = head.resolved || head.now >= record.prepared.draft.closesAt;
    const outcomes = [];
    for (const a of ['no', 'yes']) for (const b of ['no', 'yes']) {
      const { scope, mask } = claimFor(record, input.a, { side: a, rule, claim: [
        { eventIndex: input.a, side: a }, { eventIndex: input.b, side: b },
      ] });
      const joint = claimFor(record, input.a, { side: a, claim: [
        { eventIndex: input.a, side: a }, { eventIndex: input.b, side: b },
      ] });
      let costAtoms = null;
      if (!closed) try { costAtoms = String(await at('quoteBuy', [scope, mask, BigInt(input.quantity)])); }
      catch { costAtoms = null; }
      outcomes.push({ a, b, costAtoms,
        probability: certifiedClaim(state, Number(scope), String(mask)).values.market,
        scenarioProbability: certifiedClaim(state, Number(joint.scope), String(joint.mask)).values.market });
    }
    const sensitivity = [];
    if (!closed) for (const answer of ['yes', 'no']) {
      try {
        const simulated = simulatePairPurchase(state, answer, verified?.ls ?? null);
        const cost = String(await at('quoteBuy', [simulated.scope, BigInt(simulated.mask), 1_000_000n]));
        sensitivity.push({ answer, costAtoms: cost, values: certifiedPair(simulated.after).values });
      } catch { sensitivity.push({ answer, costAtoms: null, values: null }); }
    }
    const confirmed = await market.getBlock({ blockNumber: head.blockNumber });
    if (!same(confirmed?.hash, head.blockHash)) throw Error('Hybrid comparison expired');
    return { schema: 'flurbo.hybrid-analysis.v1', pool: route.pool, a: input.a, b: input.b, rule,
      quantity: input.quantity, closed, blockNumber: String(head.blockNumber),
      blockHash: head.blockHash, observedAt: head.now, values: certified.values,
      reasons: certified.reasons, outcomes, sensitivity };
  }
  async function snapshot(id, owner = null) {
    const route = routeFor(id);
    if (owner !== null && !address(owner)) throw Error('Invalid wallet address');
    const chain = await readHybridSnapshot(route.record, market);
    const state = chain.states[route.eventIndex];
    const reality = route.event.route === 'reality'
      ? await hybridRealitySnapshot(source, route.event, owner) : null;
    const user = owner === null ? null : await Promise.all([
      read(route.pool, poolAbi, 'holdings', [getAddress(owner), 1n << BigInt(route.eventIndex), 1n]),
      read(route.pool, poolAbi, 'holdings', [getAddress(owner), 1n << BigInt(route.eventIndex), 2n]),
      read(TEST_AUSD, cashAbi, 'balanceOf', [getAddress(owner)]),
      read(TEST_AUSD, cashAbi, 'allowance', [getAddress(owner), getAddress(route.pool)]),
      read(TEST_AUSD, cashAbi, 'allowance', [getAddress(owner), getAddress(route.resolver)]),
      read(route.resolver, resolverAbi, 'credits', [getAddress(owner)]),
    ]).then(([no, yes, cash, tradeAllowance, bondAllowance, credits]) => ({
      wallet: getAddress(owner), noShares: no.toString(), yesShares: yes.toString(),
      cashAtoms: cash.toString(), allowanceAtoms: tradeAllowance.toString(),
      bondAllowanceAtoms: bondAllowance.toString(), bondCreditsAtoms: credits.toString() }));
    let automaticAnswer = null;
    if (reality && command) {
      const saved = await command('GET', `flurbo:hybrid-answer:v1:${route.event.source.questionId.toLowerCase()}:observation`);
      if (saved) {
        const { outcome, evidenceURI, observedAt } = JSON.parse(saved);
        automaticAnswer = { outcome, evidenceURI, observedAt };
      }
    }
    return { schema: 'flurbo.hybrid-snapshot.v1', ...list().find(item => item.id === route.id),
      resolver: route.resolver, eventHash: route.eventHash,
      rulesHash: route.record.rulesHash, adapter: route.record.adapter,
      ruleAdapter: route.event.rule?.source.adapter ?? null,
      source: route.event.route === 'mechanical' ? {
        publisher: route.event.rule.source.publisher, urls: route.event.rule.source.urls,
        adapter: route.event.rule.source.adapter } : route.event.source,
      route: route.event.route, marketNow: chain.now, funded: true, resolved: chain.resolved,
      delivered: chain.delivered, assertionDeadline: route.event.observationEndsAt
        + route.record.prepared.draft.assertionPeriod,
      reportDeadline: route.event.observationEndsAt + route.record.prepared.draft.reportPeriod,
      bondAtoms: route.record.prepared.draft.bondAtoms,
      phase: Number(state.phase), proposal: Number(state.proposal), counter: Number(state.counter),
      result: Number(state.result), challengeUntil: Number(state.challengeUntil),
      arbitrationUntil: Number(state.arbitrationUntil), requestId: state.requestId,
      sourceCaseId: state.sourceCaseId, proposalEvidenceHash: state.evidenceHash,
      proposalEvidenceURI: state.evidenceHash && !/^0x0{64}$/i.test(state.evidenceHash)
        ? `${origin}/api/pilot/evidence/${state.evidenceHash}` : null,
      ruleURI: route.event.source?.ruleURI ?? null, automaticAnswer, reality, user };
  }

  async function prepare(id, action, input, owner) {
    const route = routeFor(id);
    if (!address(owner)) throw Error('Select a MetaMask wallet');
    const snap = await snapshot(id, owner);
    const record = route.record;
    if (['answer', 'arbitrate', 'withdrawReality', 'finalizeArbitration', 'evidence', 'appeal', 'claimAppeal', 'claimWinnings'].includes(action)) {
      if (route.event.route !== 'reality' || !snap.reality)
        throw Error('Reality action unavailable in this market');
      if (action === 'finalizeArbitration')
        return hybridRealityReportAction(source, route.event, owner, snap.reality);
      if (action === 'claimWinnings')
        return hybridRealityClaimAction(source, route.event, owner, snap.reality);
      if (action === 'appeal' || action === 'claimAppeal')
        return hybridRealityAppealAction(source, action, input, owner, snap.reality);
      if (action === 'evidence') {
        if (!snap.reality.pendingArbitration || !hash(input?.hash))
          throw Error('Evidence submission unavailable');
        const uri = await evidence.uriFor({ questionId: snap.reality.questionId,
          pool: route.pool }, input.hash);
        return { action, reason: 'Submit public evidence to Kleros',
          transaction: tx(11155111, owner, snap.reality.arbitrator,
            encodeFunctionData({ abi: proxyAbi,
              functionName: 'submitEvidence', args: [BigInt(snap.reality.questionId), uri] })) };
      }
      return hybridRealityAction(id, action, input, owner, snap.reality);
    }
    if (action === 'withdrawBond') {
      if (BigInt(snap.user.bondCreditsAtoms) <= 0n) throw Error('No bond credit to collect');
      return { action, reason: `Collect ${formatUnits(BigInt(snap.user.bondCreditsAtoms), 6)} test AUSD bond credit`,
        transaction: tx(10143, owner, route.resolver,
          encodeFunctionData({ abi: resolverAbi, functionName: 'withdrawBond' })) };
    }
    if (action === 'challenge') {
      if (route.event.route !== 'mechanical' || snap.phase !== 1
        || snap.marketNow >= snap.challengeUntil || same(owner, record.prepared.proposer)
        || ![1, 2, 3].includes(input?.counter) || input.counter === snap.proposal
        || !hash(input.evidenceHash) || typeof input.evidenceURI !== 'string'
        || input.evidenceURI !== `${origin}/api/oracle/evidence/${input.evidenceHash}`)
        throw Error('Challenge is unavailable for this question');
      const saved = JSON.parse(await evidence.get(input.evidenceHash));
      if (saved.schema !== 'flurbo.hybrid-challenge-evidence.v1'
        || !same(saved.pool, route.pool) || !same(saved.resolver, route.resolver)
        || !same(saved.eventHash, route.eventHash) || saved.eventIndex !== route.eventIndex)
        throw Error('Challenge evidence belongs to another question');
      const bond = BigInt(snap.bondAtoms);
      if (BigInt(snap.user.cashAtoms) < bond) throw Error('Wallet needs the challenge bond');
      if (BigInt(snap.user.bondAllowanceAtoms) < bond)
        return { action: 'approveBond', reason: `Allow ${formatUnits(bond, 6)} test AUSD challenge bond`,
          transaction: tx(10143, owner, TEST_AUSD,
            encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [route.resolver, bond] })) };
      return { action, reason: 'Challenge this answer and open a Kleros case',
        transaction: tx(10143, owner, route.resolver,
          encodeFunctionData({ abi: resolverAbi, functionName: 'challenge',
            args: [route.eventIndex, input.counter, input.evidenceHash, input.evidenceURI] })) };
    }
    if (route.event.route !== 'mechanical' && !['position', 'quote', 'approve', 'buy', 'sell', 'redeem'].includes(action))
      throw Error('Reality action unavailable in this market');
    if (action === 'position') {
      const { scope, mask } = claimFor(record, route.eventIndex, input);
      const holdings = BigInt(await read(route.pool, poolAbi, 'holdings',
        [getAddress(owner), scope, mask]));
      let payout = null;
      if (snap.resolved && holdings > 0n) {
        const [num, den] = await read(route.pool, poolAbi, 'payoutFraction', [scope, mask]);
        payout = holdings * BigInt(num) / BigInt(den);
      }
      return { action, holdingsAtoms: holdings.toString(), payoutAtoms: payout?.toString() ?? null };
    }
    if (!['quote', 'approve', 'buy', 'sell', 'redeem'].includes(action)
      || !/^[1-9]\d*$/.test(input?.quantity || '')
      || BigInt(input.quantity) > (action === 'redeem' ? 1_000_000_000_000n : 20_000_000n))
      throw Error(action === 'redeem' ? 'Share quantity out of range' : 'Enter one to twenty shares');
    const quantity = BigInt(input.quantity), { scope, mask } = claimFor(record, route.eventIndex, input);
    const holdings = BigInt(await read(route.pool, poolAbi, 'holdings', [getAddress(owner), scope, mask]));
    if (action === 'redeem') {
      if (!snap.resolved || holdings < quantity) throw Error('Shares are not ready to collect');
      const [num, den] = await read(route.pool, poolAbi, 'payoutFraction', [scope, mask]);
      const payout = quantity * BigInt(num) / BigInt(den);
      return { action, amountAtoms: payout.toString(), reason: `Collect about ${formatUnits(payout, 6)} test AUSD`,
        transaction: tx(10143, owner, route.pool,
          encodeFunctionData({ abi: poolAbi, functionName: 'redeem', args: [scope, mask, quantity] })) };
    }
    if (snap.resolved || snap.marketNow >= snap.closesAt) throw Error('Trading is closed');
    if (action === 'sell') {
      if (holdings < quantity) throw Error('Insufficient shares to sell');
      const quoted = BigInt(await read(route.pool, poolAbi, 'quoteSell', [scope, mask, quantity]));
      const minimum = quoted - quoted / 200n;
      return { action, amountAtoms: quoted.toString(), minimumReceivedAtoms: minimum.toString(),
        expiresAt: snap.marketNow + 120,
        reason: `Sell for at least ${formatUnits(minimum, 6)} test AUSD`,
        transaction: tx(10143, owner, route.pool,
          encodeFunctionData({ abi: poolAbi, functionName: 'sell',
            args: [scope, mask, quantity, minimum, BigInt(snap.marketNow + 120)] })) };
    }
    const quoted = BigInt(await read(route.pool, poolAbi, 'quoteBuy', [scope, mask, quantity]));
    const maximum = quoted + (quoted + 199n) / 200n;
    if (action === 'quote') {
      let sellAtoms = null;
      if (holdings >= quantity) {
        try { sellAtoms = BigInt(await read(route.pool, poolAbi, 'quoteSell', [scope, mask, quantity])).toString(); }
        catch { sellAtoms = null; }
      }
      return { action, buyAtoms: quoted.toString(), maxCostAtoms: maximum.toString(),
        sellAtoms, minProceedsAtoms: sellAtoms === null ? null
          : (BigInt(sellAtoms) - BigInt(sellAtoms) / 200n).toString(),
        cashAtoms: snap.user.cashAtoms, allowanceAtoms: snap.user.allowanceAtoms,
        holdingsAtoms: holdings.toString() };
    }
    if (action === 'approve') {
      if (BigInt(snap.user.allowanceAtoms) >= maximum) throw Error('Approval already covers this trade');
      return { action, amountAtoms: maximum.toString(), reason: `Allow up to ${formatUnits(maximum, 6)} test AUSD`,
        transaction: tx(10143, owner, TEST_AUSD,
          encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [route.pool, maximum] })) };
    }
    if (BigInt(snap.user.cashAtoms) < maximum || BigInt(snap.user.allowanceAtoms) < maximum)
      throw Error('Fund and approve this purchase first');
    return { action, amountAtoms: quoted.toString(), maxCostAtoms: maximum.toString(),
      expiresAt: snap.marketNow + 120,
      reason: `Buy ${formatUnits(quantity, 6)} shares for at most ${formatUnits(maximum, 6)} test AUSD`,
      transaction: tx(10143, owner, route.pool,
        encodeFunctionData({ abi: poolAbi, functionName: 'buy',
          args: [scope, mask, quantity, maximum, BigInt(snap.marketNow + 120)] })) };
  }
  function ruleFor(ruleHash) {
    for (const { event } of routes.values())
      if (event.rule && `0x${settlementRuleHash(event.rule)}` === ruleHash) return canonical(event.rule);
    throw Error('Hybrid rule not found');
  }
  return { list, routeFor, ruleFor, marketSummary, snapshot, analysis, prepare };
}
