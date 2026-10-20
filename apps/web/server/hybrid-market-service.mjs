import { encodeFunctionData, formatUnits, getAddress, parseAbi } from 'viem';
import { hybridSettlementCatalog, readHybridSnapshot } from './hybrid-settlement-worker.mjs';
import { proxyAbi, TEST_AUSD } from './oracle-integration.mjs';
import { hybridRealityAction, hybridRealityAppealAction, hybridRealityClaimAction, hybridRealityReportAction, hybridRealitySnapshot } from './hybrid-reality.mjs';
import { certifiedCells, certifiedClaim, certifiedPair, certifiedScenario, pairInput, scenarioInput, validateFactorSnapshot } from './pair-math.mjs';
import { runPairModel } from './pair-analytics.mjs';
import { simulatePairPurchase } from './pair-sensitivity.mjs';
import { canonical, settlementRuleHash } from './settlement-rules.mjs';
import { claimEvents, encodeClaim } from '../shared/claims.mjs';
import { verifiedLsState } from '../shared/ls-lmsr.mjs';
import { estimatePairs, poolWeb } from '../shared/pool-web.mjs';
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
  const summaryHeads = new Map();
  async function poolSummaries(record) {
    const key = record.pool.toLowerCase(), now = Date.now(), cached = summaryHeads.get(key);
    if (cached && cached.until > now) return cached.promise;
    const promise = (async () => {
      const snapshot = await readHybridSnapshot(record, market, { includeStates: false });
      const open = !snapshot.resolved && snapshot.now < record.prepared.draft.closesAt;
      const count = record.prepared.draft.events.length;
      const prices = open
        ? await Promise.all(Array.from({ length: count }, async (_, index) => {
          const scope = 1n << BigInt(index);
          const quotes = await Promise.allSettled([
            read(record.pool, poolAbi, 'quoteBuy', [scope, 2n, 1_000_000n]),
            read(record.pool, poolAbi, 'quoteBuy', [scope, 1n, 1_000_000n]),
          ]);
          return {
            yes: quotes[0].status === 'fulfilled' ? BigInt(quotes[0].value).toString() : null,
            no: quotes[1].status === 'fulfilled' ? BigInt(quotes[1].value).toString() : null,
          };
        }))
        : Array.from({ length: count }, () => ({ yes: null, no: null }));
      return { snapshot, prices };
    })().catch(err => {
      summaryHeads.delete(key);
      throw err;
    });
    summaryHeads.set(key, { promise, until: now + 6_000 });
    return promise;
  }
  async function marketSummary(id) {
    const route = routeFor(id);
    const { snapshot, prices } = await poolSummaries(route.record);
    return { schema: 'flurbo.hybrid-market.v1', id: route.id, pool: route.pool,
      marketNow: snapshot.now, blockNumber: snapshot.blockNumber.toString(),
      blockHash: snapshot.blockHash, funded: true, resolved: snapshot.resolved,
      prices: prices[route.eventIndex] ?? { yes: null, no: null } };
  }
  const poolStates = new Map();
  async function poolState(record) {
    const key = record.pool.toLowerCase(), now = Date.now(), cached = poolStates.get(key);
    if (cached && cached.until > now) return cached.promise;
    const promise = (async () => {
      const count = record.prepared.draft.events.length;
      const head = await readHybridSnapshot(record, market, { includeStates: false });
      const at = (functionName, args = []) => market.readContract({ address: getAddress(record.pool),
        abi: poolAbi, functionName, args, blockNumber: head.blockNumber });
      const ls = isLsPrepared(record.prepared);
      const [liquidity, order, factors, depth, commissionBps] = await Promise.all([
        at('liquidity'), at('eliminationOrder'), at('factors'),
        ...(ls ? [at('depth'), at('commissionBps')] : []),
      ]);
      const sequence = order.map(Number);
      if (!ls) return { head, at, ls: null, state: { events: count, liquidity: String(liquidity), order: sequence,
        factors: factors.map(f => ({ scope: Number(f.scope), values: f.values.map(String) })) } };
      const committed = { initialDepthAtoms: record.prepared.liquidityAtoms, commissionBps: record.prepared.commissionBps };
      const verified = verifiedLsState(committed, { events: count, a: 0, b: 1, order: sequence,
        factors, liquidity, commissionBps, depth });
      if (!verified) return { head, at, ls: null, state: null };
      return { head, at, ls: verified.ls, state: { events: count, liquidity: verified.state.liquidity,
        order: sequence, factors: verified.state.factors } };
    })().catch(err => {
      poolStates.delete(key);
      throw err;
    });
    poolStates.set(key, { promise, until: now + 6_000 });
    return promise;
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
    const pool = await poolState(record);
    if (!pool.state) throw Error('Hybrid comparison unavailable');
    const { head, at, ls } = pool;
    const state = { ...pool.state, a: input.a, b: input.b };
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
    const pairs = [['no', 'no'], ['no', 'yes'], ['yes', 'no'], ['yes', 'yes']];
    const outcomes = await Promise.all(pairs.map(async ([a, b]) => {
      const { scope, mask } = claimFor(record, input.a, { side: a, rule, claim: [
        { eventIndex: input.a, side: a }, { eventIndex: input.b, side: b },
      ] });
      const joint = claimFor(record, input.a, { side: a, claim: [
        { eventIndex: input.a, side: a }, { eventIndex: input.b, side: b },
      ] });
      let costAtoms = null;
      if (!closed) try { costAtoms = String(await at('quoteBuy', [scope, mask, BigInt(input.quantity)])); }
      catch { costAtoms = null; }
      return { a, b, costAtoms,
        probability: certifiedClaim(state, Number(scope), String(mask)).values.market,
        scenarioProbability: certifiedClaim(state, Number(joint.scope), String(joint.mask)).values.market };
    }));
    const sensitivity = closed ? [] : await Promise.all(['yes', 'no'].map(async answer => {
      try {
        const simulated = simulatePairPurchase(state, answer, ls);
        const cost = String(await at('quoteBuy', [simulated.scope, BigInt(simulated.mask), 1_000_000n]));
        return { answer, costAtoms: cost, values: certifiedPair(simulated.after).values };
      } catch { return { answer, costAtoms: null, values: null }; }
    }));
    const confirmed = await market.getBlock({ blockNumber: head.blockNumber });
    if (!same(confirmed?.hash, head.blockHash)) throw Error('Hybrid comparison expired');
    return { schema: 'flurbo.hybrid-analysis.v1', pool: route.pool, a: input.a, b: input.b, rule,
      quantity: input.quantity, closed, blockNumber: String(head.blockNumber),
      blockHash: head.blockHash, observedAt: head.now, values: certified.values,
      reasons: certified.reasons, outcomes, sensitivity };
  }
  async function web(id) {
    const route = routeFor(id), record = route.record;
    const count = record.prepared.draft.events.length;
    const pool = await poolState(record);
    if (!pool.state) throw Error('Hybrid connections unavailable');
    const { head, state } = pool, tables = state.factors;
    const shells = poolWeb({ events: count, factors: tables, marginals: [], joint: () => null });
    const estimate = estimatePairs(state, shells.edges.map(edge => [edge.a, edge.b]));
    const { prices } = await poolSummaries(record);
    const priced = prices.map(item => item.yes === null ? null : Math.round(Number(item.yes) / 1000));
    const web = poolWeb({ events: count, factors: tables,
      marginals: priced.map((yes, i) => yes ?? estimate?.marginals[i] ?? null),
      joint: (a, b) => estimate?.pairs.get(`${a}-${b}`) ?? null });
    const confirmed = await market.getBlock({ blockNumber: head.blockNumber });
    if (!same(confirmed?.hash, head.blockHash)) throw Error('Hybrid connections expired');
    return { schema: 'flurbo.hybrid-web.v1', pool: route.pool, title: record.prepared.draft.title,
      closesAt: record.prepared.draft.closesAt, blockNumber: String(head.blockNumber),
      blockHash: head.blockHash, observedAt: head.now, estimated: estimate !== null,
      questions: record.prepared.draft.events.map(event => event.question), ...web };
  }
  const legOf = item => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).sort().join() === 'eventIndex,side'
    && Number.isInteger(item.eventIndex) && ['yes', 'no'].includes(item.side);
  const legsOf = (value, count, minimum, maximum) => {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum || !value.every(item => legOf(item)
      && item.eventIndex >= 0 && item.eventIndex < count)
      || new Set(value.map(item => item.eventIndex)).size !== value.length) return null;
    return value.map(({ eventIndex, side }) => ({ eventIndex, side })).sort((x, y) => x.eventIndex - y.eventIndex);
  };
  function whatIfRequest(input, count) {
    const plain = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!plain(input) || Object.keys(input).some(key => !['given', 'claim'].includes(key))) throw Error('Invalid what-if input');
    if (input.claim !== undefined && (!plain(input.claim) || Object.keys(input.claim).some(key => !['legs', 'rule'].includes(key))))
      throw Error('Invalid what-if input');
    const empty = input.given === undefined || Array.isArray(input.given) && input.given.length === 0;
    if (empty && input.claim === undefined) throw Error('Choose an assumption or a combination');
    const given = empty ? [] : legsOf(input.given, count, 1, 3);
    if (!given) throw Error('Choose up to three assumptions');
    if (input.claim === undefined) return { given, claim: null };
    const legs = legsOf(input.claim.legs, count, 1, 3);
    if (!legs) throw Error('Choose up to three answers');
    if (input.claim.rule !== undefined && !['AND', 'OR', 'EXACTLY_ONE'].includes(input.claim.rule))
      throw Error('Choose a supported combination');
    return { given, claim: { legs, rule: legs.length === 1 ? 'AND' : input.claim.rule || 'AND' } };
  }
  const near = (actual, value) => typeof actual === 'number' && Number.isFinite(actual) && actual >= -1e-9 && actual <= 1 + 1e-9
    && (value === null || Math.abs(actual * 1000 - value) <= 0.5 + 1e-6);
  const pricesTogether = (state, scope) => {
    if (state.factors.some(factor => factor.scope === scope)) return true;
    if (state.factors.length >= 64) return false;
    try {
      validateFactorSnapshot({ ...state, factors: [...state.factors,
        { scope, values: Array(2 ** claimEvents(scope).length).fill('0') }] });
      return true;
    } catch { return false; }
  };
  async function whatIf(id, input) {
    const route = routeFor(id), record = route.record;
    const count = record.prepared.draft.events.length;
    const request = whatIfRequest(input, count);
    const pool = await poolState(record);
    if (!pool.state) throw Error('Hybrid comparison unavailable');
    const { head, state } = pool;
    const reasons = {};
    let questions = [], givenChance = null, claim = null;
    if (request.given.length) {
      const assumptions = request.given.map(item => ({ event: item.eventIndex, yes: item.side === 'yes' }));
      const certified = certifiedScenario(state, assumptions);
      const reference = await pairModel(scenarioInput(state, assumptions));
      if (!near(reference?.given, certified.values.given) || !Array.isArray(reference.yes) || !Array.isArray(reference.givenYes)
        || reference.yes.length !== count || reference.givenYes.length !== count
        || certified.questions.some(q => !near(reference.yes[q.event], q.yes) || !near(reference.givenYes[q.event], q.givenYes)))
        throw Error('Hybrid comparison unavailable');
      questions = certified.questions.map(q => ({ eventIndex: q.event, yes: q.yes, givenYes: q.givenYes, assumed: q.assumed }));
      givenChance = certified.values.given;
      Object.assign(reasons, certified.reasons);
    }
    if (request.claim) {
      const { legs, rule } = request.claim;
      const encoded = encodeClaim({ events: count, rule, legs: legs.map(item => ({ event: item.eventIndex, yes: item.side === 'yes' })) });
      const certified = certifiedClaim(state, encoded.scope, encoded.mask);
      const cells = certifiedCells(state, encoded.scope).map(({ state: local, chance }) => ({ state: local,
        answers: legs.map((item, i) => ({ eventIndex: item.eventIndex, side: local >> i & 1 ? 'yes' : 'no' })),
        pays: Boolean(BigInt(encoded.mask) >> BigInt(local) & 1n), chance }));
      const chosen = new Set(legs.map(item => item.eventIndex));
      claim = { scope: encoded.scope, mask: encoded.mask, rule, legs, chance: certified.values.market,
        independent: certified.values.independent, difference: certified.values.difference, cells,
        priceable: pricesTogether(state, encoded.scope),
        addable: legs.length >= 3 ? [] : Array.from({ length: count }, (_, event) => event)
          .filter(event => !chosen.has(event) && pricesTogether(state, encoded.scope + 2 ** event)) };
      if (Object.keys(certified.reasons).length) reasons.claim = certified.reasons;
    }
    const confirmed = await market.getBlock({ blockNumber: head.blockNumber });
    if (!same(confirmed?.hash, head.blockHash)) throw Error('Hybrid comparison expired');
    return { schema: 'flurbo.hybrid-what-if.v1', pool: route.pool, blockNumber: String(head.blockNumber),
      blockHash: head.blockHash, observedAt: head.now,
      closed: head.resolved || head.now >= record.prepared.draft.closesAt, unit: 'tenths_of_percentage_point',
      given: request.given, givenChance, questions, claim, reasons };
  }
  async function snapshot(id, owner = null) {
    const route = routeFor(id);
    if (owner !== null && !address(owner)) throw Error('Invalid wallet address');
    const chain = await readHybridSnapshot(route.record, market, { eventIndex: route.eventIndex });
    const state = chain.states[route.eventIndex];
    const [reality, user, saved] = await Promise.all([
      route.event.route === 'reality' ? hybridRealitySnapshot(source, route.event, owner) : null,
      owner === null ? null : Promise.all([
        read(route.pool, poolAbi, 'holdings', [getAddress(owner), 1n << BigInt(route.eventIndex), 1n]),
        read(route.pool, poolAbi, 'holdings', [getAddress(owner), 1n << BigInt(route.eventIndex), 2n]),
        read(TEST_AUSD, cashAbi, 'balanceOf', [getAddress(owner)]),
        read(TEST_AUSD, cashAbi, 'allowance', [getAddress(owner), getAddress(route.pool)]),
        read(TEST_AUSD, cashAbi, 'allowance', [getAddress(owner), getAddress(route.resolver)]),
        read(route.resolver, resolverAbi, 'credits', [getAddress(owner)]),
      ]).then(([no, yes, cash, tradeAllowance, bondAllowance, credits]) => ({
        wallet: getAddress(owner), noShares: no.toString(), yesShares: yes.toString(),
        cashAtoms: cash.toString(), allowanceAtoms: tradeAllowance.toString(),
        bondAllowanceAtoms: bondAllowance.toString(), bondCreditsAtoms: credits.toString() })),
      route.event.route === 'reality' && command
        ? command('GET', `flurbo:hybrid-answer:v1:${route.event.source.questionId.toLowerCase()}:observation`)
        : null,
    ]);
    let automaticAnswer = null;
    if (reality && saved) {
      const { outcome, evidenceURI, observedAt } = JSON.parse(saved);
      automaticAnswer = { outcome, evidenceURI, observedAt };
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
    const record = route.record;
    if (['answer', 'arbitrate', 'withdrawReality', 'finalizeArbitration', 'evidence', 'appeal', 'claimAppeal', 'claimWinnings'].includes(action)) {
      const snap = await snapshot(id, owner);
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
      const snap = await snapshot(id, owner);
      if (BigInt(snap.user.bondCreditsAtoms) <= 0n) throw Error('No bond credit to collect');
      return { action, reason: `Collect ${formatUnits(BigInt(snap.user.bondCreditsAtoms), 6)} test AUSD bond credit`,
        transaction: tx(10143, owner, route.resolver,
          encodeFunctionData({ abi: resolverAbi, functionName: 'withdrawBond' })) };
    }
    if (action === 'challenge') {
      const snap = await snapshot(id, owner);
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
    if (route.event.route !== 'mechanical' && !['position', 'quote', 'approve', 'buy', 'sell', 'redeem'].includes(action)) {
      await snapshot(id, owner);
      throw Error('Reality action unavailable in this market');
    }
    if (action === 'position') {
      const { scope, mask } = claimFor(record, route.eventIndex, input);
      const [chain, rawHoldings] = await Promise.all([
        readHybridSnapshot(record, market, { includeStates: false }),
        read(route.pool, poolAbi, 'holdings', [getAddress(owner), scope, mask]),
      ]);
      const holdings = BigInt(rawHoldings);
      let payout = null;
      if (chain.resolved && holdings > 0n) {
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
    const wallet = getAddress(owner), closesAt = record.prepared.draft.closesAt;
    const needsCash = ['quote', 'approve', 'buy'].includes(action);
    const [chain, rawHoldings, rawCash, rawAllowance] = await Promise.all([
      readHybridSnapshot(record, market, { includeStates: false }),
      read(route.pool, poolAbi, 'holdings', [wallet, scope, mask]),
      ...(needsCash ? [
        read(TEST_AUSD, cashAbi, 'balanceOf', [wallet]),
        read(TEST_AUSD, cashAbi, 'allowance', [wallet, getAddress(route.pool)]),
      ] : []),
    ]);
    const holdings = BigInt(rawHoldings);
    if (action === 'redeem') {
      if (!chain.resolved || holdings < quantity) throw Error('Shares are not ready to collect');
      const [num, den] = await read(route.pool, poolAbi, 'payoutFraction', [scope, mask]);
      const payout = quantity * BigInt(num) / BigInt(den);
      return { action, amountAtoms: payout.toString(), reason: `Collect about ${formatUnits(payout, 6)} test AUSD`,
        transaction: tx(10143, owner, route.pool,
          encodeFunctionData({ abi: poolAbi, functionName: 'redeem', args: [scope, mask, quantity] })) };
    }
    if (chain.resolved || chain.now >= closesAt) throw Error('Trading is closed');
    if (action === 'sell') {
      if (holdings < quantity) throw Error('Insufficient shares to sell');
      const quoted = BigInt(await read(route.pool, poolAbi, 'quoteSell', [scope, mask, quantity]));
      const minimum = quoted - quoted / 200n;
      return { action, amountAtoms: quoted.toString(), minimumReceivedAtoms: minimum.toString(),
        expiresAt: chain.now + 120,
        reason: `Sell for at least ${formatUnits(minimum, 6)} test AUSD`,
        transaction: tx(10143, owner, route.pool,
          encodeFunctionData({ abi: poolAbi, functionName: 'sell',
            args: [scope, mask, quantity, minimum, BigInt(chain.now + 120)] })) };
    }
    const [rawQuoted, rawSell] = await Promise.all([
      read(route.pool, poolAbi, 'quoteBuy', [scope, mask, quantity]),
      action === 'quote' && holdings >= quantity
        ? read(route.pool, poolAbi, 'quoteSell', [scope, mask, quantity]).catch(() => null)
        : null,
    ]);
    const quoted = BigInt(rawQuoted);
    const maximum = quoted + (quoted + 199n) / 200n;
    const cashAtoms = BigInt(rawCash).toString(), allowanceAtoms = BigInt(rawAllowance).toString();
    if (action === 'quote') {
      const sellAtoms = rawSell === null || rawSell === undefined ? null : BigInt(rawSell).toString();
      return { action, buyAtoms: quoted.toString(), maxCostAtoms: maximum.toString(),
        sellAtoms, minProceedsAtoms: sellAtoms === null ? null
          : (BigInt(sellAtoms) - BigInt(sellAtoms) / 200n).toString(),
        cashAtoms, allowanceAtoms,
        holdingsAtoms: holdings.toString() };
    }
    if (action === 'approve') {
      if (BigInt(allowanceAtoms) >= maximum) throw Error('Approval already covers this trade');
      return { action, amountAtoms: maximum.toString(), reason: `Allow up to ${formatUnits(maximum, 6)} test AUSD`,
        transaction: tx(10143, owner, TEST_AUSD,
          encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [route.pool, maximum] })) };
    }
    if (BigInt(cashAtoms) < maximum || BigInt(allowanceAtoms) < maximum)
      throw Error('Fund and approve this purchase first');
    return { action, amountAtoms: quoted.toString(), maxCostAtoms: maximum.toString(),
      expiresAt: chain.now + 120,
      reason: `Buy ${formatUnits(quantity, 6)} shares for at most ${formatUnits(maximum, 6)} test AUSD`,
      transaction: tx(10143, owner, route.pool,
        encodeFunctionData({ abi: poolAbi, functionName: 'buy',
          args: [scope, mask, quantity, maximum, BigInt(chain.now + 120)] })) };
  }
  function ruleFor(ruleHash) {
    for (const { event } of routes.values())
      if (event.rule && `0x${settlementRuleHash(event.rule)}` === ruleHash) return canonical(event.rule);
    throw Error('Hybrid rule not found');
  }
  return { list, routeFor, ruleFor, marketSummary, snapshot, analysis, web, whatIf, prepare };
}
