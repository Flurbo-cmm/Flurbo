import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { prepareHybridPilot, hybridRulesHash } from '../scripts/prepare-hybrid-pilot.mjs';
import { hybridMarketService } from '../server/hybrid-market-service.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';
import { runPairModel } from '../server/pair-analytics.mjs';
import { certifiedCells, certifiedClaim, certifiedPair, certifiedScenario } from '../server/pair-math.mjs';
import { simulatePairPurchase } from '../server/pair-sensitivity.mjs';
import { encodeClaim } from '../shared/claims.mjs';
import { depthRateWad, lsAnalyticsState } from '../shared/ls-lmsr.mjs';
import { hybridRecord } from './hybrid-catalog-fixture.ts';
import { rustExample } from './rust-example.ts';

const at = 1_800_000_000;
const account = (digit: string) => `0x${digit.repeat(40)}`;
const pool = account('5'), resolver = account('4'), owner = account('8');
const question = 'Will the official value be at least four?';
const rule = (id: string) => ({ schema: 'flurbo.settlement-rule.v1', eventId: id, question,
  source: { id: 'official-source', publisher: 'Official publisher',
    urls: ['https://data.example.org/value'], adapter: 'json-api.v1',
    reader: { select: '/value', aggregate: 'value' } },
  observation: { series: 'official-value', period: '2027-01', unit: 'units' },
  decision: { type: 'number', operator: 'gte', value: '4' },
  timing: { scheduledAt: at, publicationCutoff: at + 3600,
    correctionCutoff: at + 3600, observationEndsAt: at + 3600,
    assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
  vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });

test('settled combined shares can be read and redeemed from either market', async () => {
  let open = false;
  const prepared = prepareHybridPilot({ schema: 'flurbo.hybrid-publication.v4', chainId: 10143,
    rulesReviewed: true, creator: account('1'), proposer: account('2'), relay: account('3'),
    title: 'Combined payout test', closesAt: at - 3600, assertionPeriod: 3600,
    challengePeriod: 3600, reportPeriod: 86400, arbitrationPeriod: 30 * 86400,
    bondAtoms: '1000000', liquidityAtoms: '10000000',
    events: ['first', 'second'].map(id => ({ id, question, observationEndsAt: at + 3600,
      route: 'mechanical', rule: rule(id) })) });
  const rulesHash = hybridRulesHash(prepared, resolver);
  const catalog = { schema: 'flurbo.hybrid-catalog.v1', pools: [{ id: 'combined-test', pool,
    resolver, rulesHash, deploymentBlock: 100, adapter: account('6'), manager: account('7'),
    prepared }] };
  const market = {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n,
      timestamp: BigInt(open ? at - 7200 : at + 86400) }),
    readContract: async ({ address, functionName, args = [] }: {
      address: string; functionName: string; args?: (number | bigint | string)[]
    }) => {
      const isPool = address.toLowerCase() === pool.toLowerCase();
      const values: Record<string, unknown> = {
        protocolVersion: isPool ? 3n : 4n, rulesHash, draftHash: prepared.draftHash,
        pool, proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n,
        eventCount: 2n, resolver, settlementRulesHash: rulesHash,
        collateral: TEST_AUSD, funded: true, resolved: !open, delivered: !open,
        liquidity: 10000000n, eliminationOrder: [0, 1], factors: [],
        quoteBuy: BigInt(args[2] || 0) / 2n, quoteSell: BigInt(args[2] || 0) / 3n,
        eventHashes: prepared.eventHashes[Number(args[0])],
        observationEnds: BigInt(at + 3600), routes: 0n,
        caseState: { phase: 3n, proposal: 2n, counter: 0n, result: 2n,
          challengeUntil: 0n, arbitrationUntil: 0n,
          requestId: `0x${'0'.repeat(64)}`, sourceCaseId: `0x${'0'.repeat(64)}` },
        holdings: BigInt(args[1] || 0) === 3n && BigInt(args[2] || 0) === 8n ? 25000000n : 0n,
        payoutFraction: [1n, 1n], balanceOf: 0n, allowance: 0n, credits: 0n,
      };
      if (!(functionName in values)) throw Error(`Unexpected ${functionName}`);
      return values[functionName];
    },
  };
  const service = hybridMarketService({ catalog, market, source: {}, evidence: {},
    origin: 'https://example.org', pairModel: async () => ({ a: .5, b: .5, joint: .25,
      givenYes: .5, givenNo: .5, independent: .25, difference: 0 }) });
  const claim = [{ eventIndex: 0, side: 'yes' }, { eventIndex: 1, side: 'yes' }];
  const position = await service.prepare(`${pool}-0`, 'position', { side: 'yes', claim }, owner);
  assert.equal(position.holdingsAtoms, '25000000');
  assert.equal(position.payoutAtoms, '25000000');
  const second = await service.prepare(`${pool}-1`, 'position', { side: 'yes', claim }, owner);
  assert.equal(second.holdingsAtoms, position.holdingsAtoms);
  const plan = await service.prepare(`${pool}-0`, 'redeem',
    { side: 'yes', claim, quantity: '25000000' }, owner);
  const decoded = decodeFunctionData({ abi: parseAbi([
    'function redeem(uint32,uint256,uint128) returns (uint128)']), data: plan.transaction.data });
  assert.deepEqual(decoded.args, [3, 8n, 25000000n]);
  open = true;
  const quote = await service.prepare(`${pool}-0`, 'quote', { side: 'yes', claim,
    quantity: '2000000' }, owner);
  assert.equal(quote.buyAtoms, '1000000');
  assert.equal(quote.maxCostAtoms, '1005000');
  assert.equal(quote.sellAtoms, '666666');
  assert.equal(quote.minProceedsAtoms, '663333');
  const sale = await service.prepare(`${pool}-0`, 'sell', { side: 'yes', claim,
    quantity: '2000000' }, owner);
  assert.equal(sale.minimumReceivedAtoms, '663333');
  assert.equal(sale.expiresAt, at - 7200 + 120);
  const analysis = await service.analysis(`${pool}-0`, { a: 0, b: 1, quantity: '1000000' });
  assert.equal(analysis.values.givenYes, 500);
  assert.deepEqual(analysis.outcomes.map(item => item.probability), [250, 250, 250, 250]);
  assert.deepEqual(analysis.outcomes.map(item => item.costAtoms), ['500000', '500000', '500000', '500000']);
  const alternatives = await service.analysis(`${pool}-0`,
    { a: 0, b: 1, quantity: '1000000', rule: 'OR' });
  assert.deepEqual(alternatives.outcomes.map(item => item.probability), [750, 750, 750, 750]);
  assert.deepEqual(alternatives.outcomes.map(item => item.scenarioProbability), [250, 250, 250, 250]);
});

test('reality snapshot includes rule URI and the automatic answer', async () => {
  const { at: base, catalog: build, pool: poolAddress, resolver: resolverAddress } = await import('./hybrid-catalog-fixture.ts');
  const catalog = build(['reality', 'reality']);
  const record = catalog.pools[0], events: any[] = record.prepared.draft.events;
  const stored = JSON.stringify({ outcome: 2, evidenceURI: 'https://example.org/evidence/0x1', observedAt: base + 3700,
    answer: `0x${'0'.repeat(63)}1`, questionId: events[0].source.questionId, extra: 'ignored' });
  const reads: string[] = [];
  const market = { getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: BigInt(base + 3700) }),
    readContract: async ({ address, functionName, args = [] }: any) => {
      const isPool = address.toLowerCase() === poolAddress.toLowerCase();
      const values: Record<string, unknown> = { protocolVersion: isPool ? 3n : 4n, rulesHash: record.rulesHash,
        draftHash: record.prepared.draftHash, pool: poolAddress, proposer: record.prepared.proposer,
        relay: record.prepared.relay, bond: 1000000n, eventCount: 2n, resolver: resolverAddress,
        settlementRulesHash: record.rulesHash, collateral: TEST_AUSD, funded: true, resolved: false,
        delivered: false, routes: 1n, eventHashes: record.prepared.eventHashes[Number(args[0])],
        observationEnds: BigInt(base + 3600),
        caseState: { phase: 0n, proposal: 0n, counter: 0n, result: 0n, challengeUntil: 0n,
          arbitrationUntil: 0n, requestId: `0x${'0'.repeat(64)}`, sourceCaseId: `0x${'0'.repeat(64)}` } };
      return values[functionName];
    } };
  const source = { getChainId: async () => 11155111, getBlock: async () => ({ timestamp: BigInt(base + 3700) }),
    readContract: async ({ functionName, args = [] }: any) => {
      const item = events[args[0] === events[1].source.questionId ? 1 : 0].source;
      const values: Record<string, unknown> = { getContentHash: item.contentHash, getArbitrator: item.arbitrator,
        getOpeningTS: BigInt(base + 3600), getTimeout: 3600n, getMinBond: 100000000000000n, getBond: 0n,
        getFinalizeTS: 0n, getBestAnswer: `0x${'0'.repeat(64)}`, getHistoryHash: `0x${'0'.repeat(64)}`,
        isPendingArbitration: false, isFinalized: false, getDisputeFee: 10n ** 16n, realitio: item.reality,
        arbitrationRequests: [0n, resolverAddress, 0n, 0n], balanceOf: 0n };
      return values[functionName];
    } };
  const command = async (op: string, name: string) => {
    reads.push(name);
    return name === `flurbo:hybrid-answer:v1:${events[0].source.questionId}:observation` ? stored : null;
  };
  const service = hybridMarketService({ catalog, market, source, evidence: {}, origin: 'https://example.org', command });
  const first = await service.snapshot(`${poolAddress}-0`);
  assert.equal(first.automaticAnswer.outcome, 2);
  assert.deepEqual(Object.keys(first.automaticAnswer).sort(), ['evidenceURI', 'observedAt', 'outcome']);
  assert.equal(first.ruleURI, events[0].source.ruleURI);
  assert.equal(first.ruleAdapter, 'json-api.v1');
  const second = await service.snapshot(`${poolAddress}-1`);
  assert.equal(second.automaticAnswer, null);
  assert.equal(second.ruleAdapter, 'json-api.v1');
  let sourceReads = 0, eventHashReads = 0;
  const openMarket = {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: BigInt(base - 7200) }),
    readContract: async (request: any) => {
      if (request.functionName === 'eventHashes') eventHashReads += 1;
      if (request.functionName === 'quoteBuy') return BigInt(request.args[2]) / 2n;
      if (request.functionName === 'quoteSell') return BigInt(request.args[2]) / 3n;
      if (['holdings', 'balanceOf', 'allowance'].includes(request.functionName)) return 1000000n;
      return market.readContract(request);
    },
  };
  const trackedSource = { ...source, readContract: async (request: any) => { sourceReads += 1; return source.readContract(request); } };
  const fastService = hybridMarketService({ catalog, market: openMarket, source: trackedSource,
    evidence: {}, origin: 'https://example.org', command });
  const [summary0, summary1] = await Promise.all([
    fastService.marketSummary(`${poolAddress}-0`),
    fastService.marketSummary(`${poolAddress}-1`),
  ]);
  assert.equal(summary0.prices.yes, '500000');
  assert.equal(summary1.prices.no, '500000');
  assert.equal(eventHashReads, 2);
  assert.equal(sourceReads, 0);
  const readsBeforeQuote = reads.length;
  const fastQuote = await fastService.prepare(`${poolAddress}-0`, 'quote',
    { side: 'yes', quantity: '2000000' }, owner);
  assert.equal(fastQuote.buyAtoms, '1000000');
  assert.equal(eventHashReads, 2);
  assert.equal(sourceReads, 0);
  assert.equal(reads.length, readsBeforeQuote);
});

function lsMarket(change: Record<string, unknown> = {}) {
  const prepared = prepareHybridPilot({ schema: 'flurbo.hybrid-publication.v5', chainId: 10143,
    rulesReviewed: true, creator: account('1'), proposer: account('2'), relay: account('3'),
    title: 'Liquidity-sensitive test', closesAt: at - 3600, assertionPeriod: 3600,
    challengePeriod: 3600, reportPeriod: 86400, arbitrationPeriod: 30 * 86400,
    bondAtoms: '1000000', liquidityAtoms: '10000000', commissionBps: 500,
    events: ['first', 'second'].map(id => ({ id, question, observationEndsAt: at + 3600,
      route: 'mechanical', rule: rule(id) })) });
  const rulesHash = hybridRulesHash(prepared, resolver);
  const catalog = { schema: 'flurbo.hybrid-catalog.v1', pools: [{ id: 'ls-test', pool,
    resolver, rulesHash, deploymentBlock: 100, adapter: account('6'), manager: account('7'), prepared }] };
  const input = { events: 2, a: 0, b: 1, initialDepthAtoms: '10000000', commissionBps: 500, order: [0, 1],
    factors: [{ scope: 3, values: ['0', '0', '0', '10000000'] }] };
  const expected = lsAnalyticsState(input);
  const values: Record<string, unknown> = { rulesHash, draftHash: prepared.draftHash,
    pool, proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n,
    eventCount: 2n, resolver, settlementRulesHash: rulesHash, collateral: TEST_AUSD, funded: true,
    resolved: false, delivered: false, liquidity: 10000000n, commissionBps: 500, sponsor: prepared.creator, depth: expected.depthWad,
    eliminationOrder: [0, 1], factors: [{ scope: 3, values: [0n, 0n, 0n, 10000000n] }],
    observationEnds: BigInt(at + 3600), routes: 0n,
    caseState: { phase: 0n, proposal: 0n, counter: 0n, result: 0n, challengeUntil: 0n, arbitrationUntil: 0n,
      requestId: `0x${'0'.repeat(64)}`, sourceCaseId: `0x${'0'.repeat(64)}` }, ...change };
  const market = {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: BigInt(at - 7200) }),
    readContract: async ({ address, functionName, args = [] }: any) => {
      if (functionName === 'protocolVersion') return address.toLowerCase() === pool.toLowerCase() ? values.poolVersion ?? 5n : 4n;
      if (functionName === 'quoteBuy') return BigInt(args[2]) / 2n;
      if (functionName === 'eventHashes') return prepared.eventHashes[Number(args[0])];
      if (!(functionName in values)) throw Error(`Unexpected ${functionName}`);
      return values[functionName];
    },
  };
  const service = hybridMarketService({ catalog, market, source: {}, evidence: {}, origin: 'https://example.org',
    pairModel: input => runPairModel(input, { file: rustExample('pair_analytics') }) });
  return { service, expected, ls: { initialDepthWad: 10n ** 19n, rateWad: depthRateWad(2, 500) } };
}

test('analysis on a protocol 5 pool uses the on-chain depth and agrees with the formula', async () => {
  const { service, expected, ls } = lsMarket();
  const analysis = await service.analysis(`${pool}-0`, { a: 0, b: 1, quantity: '1000000' });
  assert.deepEqual(analysis.values, certifiedPair(expected.state).values);
  assert.deepEqual(analysis.outcomes.map(item => item.probability),
    [[0, 0], [0, 1], [1, 0], [1, 1]].map(([a, b]) => certifiedClaim(expected.state, 3, String(1 << (a + 2 * b))).values.market));
  for (const item of analysis.sensitivity)
    assert.deepEqual(item.values, certifiedPair(simulatePairPurchase(expected.state, item.answer, ls).after).values);
});

test('analysis fails closed when the on-chain depth or commission differs', async () => {
  for (const change of [{ depth: lsMarket().expected.depthWad + 1n }, { depth: lsMarket().expected.depthWad - 1n }])
    await assert.rejects(lsMarket(change).service.analysis(`${pool}-0`, { a: 0, b: 1, quantity: '1000000' }),
      /Hybrid comparison unavailable/);
  for (const change of [{ commissionBps: 1000 }, { liquidity: 20000000n }, { poolVersion: 3n }])
    await assert.rejects(lsMarket(change).service.analysis(`${pool}-0`, { a: 0, b: 1, quantity: '1000000' }),
      /Hybrid (comparison unavailable|pool differs from verified catalog)/);
});

test('web returns schema flurbo.hybrid-web.v1 with block number and at most 32 nodes', async () => {
  const { service, expected } = lsMarket();
  const web = await service.web(`${pool}-0`);
  assert.equal(web.schema, 'flurbo.hybrid-web.v1');
  assert.equal(web.pool, pool);
  assert.equal(web.blockNumber, '200');
  assert.ok(web.nodes.length >= 1 && web.nodes.length <= 32);
  assert.equal(web.nodes.length, 2);
  assert.deepEqual(web.nodes.map((node: any) => node.yes), [500, 500]);
  assert.equal(web.edges.length, 1);
  assert.deepEqual([web.edges[0].a, web.edges[0].b, web.edges[0].scope], [0, 1, 3]);
  assert.equal(web.edges[0].difference, web.edges[0].joint - web.edges[0].independent);
  assert.equal(web.questions.length, 2);
  assert.ok(expected.depthWad > 0n);
});

test('web fails closed when the on-chain depth differs', async () => {
  await assert.rejects(lsMarket({ depth: lsMarket().expected.depthWad + 1n }).service.web(`${pool}-0`),
    /Hybrid (connections unavailable|pool differs from verified catalog)/);
});

type Table = { scope: number; values: bigint[] };
const chainTables = (count: number): Table[] => Array.from({ length: count - 1 }, (_, i) =>
  ({ scope: 3 * 2 ** i, values: [0n, 0n, 0n, BigInt((i % 5 + 1) * 1_000_000)] }));
const realModel = (input: string) => runPairModel(input, { file: rustExample('pair_analytics') });

function wideMarket({ count = 16, tables = chainTables(count), commissionBps = 500 as number | null, pairModel = realModel, closed = false } = {}) {
  const record: any = hybridRecord({ count, pool, resolver, commissionBps });
  const catalog = { schema: 'flurbo.hybrid-catalog.v1', pools: [record] };
  const order = Array.from({ length: count }, (_, i) => i);
  const strings = tables.map(t => ({ scope: t.scope, values: t.values.map(String) }));
  const lsState = commissionBps === null ? null : lsAnalyticsState({ events: count, a: 0, b: 1, initialDepthAtoms: '10000000',
    commissionBps, order, factors: strings });
  const state = lsState ? lsState.state : { events: count, a: 0, b: 1, liquidity: '10000000', order, factors: strings };
  const reads: { functionName: string; blockNumber?: bigint }[] = [];
  const values: Record<string, unknown> = { rulesHash: record.rulesHash, draftHash: record.prepared.draftHash,
    pool, proposer: record.prepared.proposer, relay: record.prepared.relay, bond: 1000000n,
    eventCount: BigInt(count), resolver, settlementRulesHash: record.rulesHash, collateral: TEST_AUSD, funded: true,
    resolved: closed, delivered: closed, liquidity: 10000000n, commissionBps: commissionBps ?? 0, sponsor: record.prepared.creator,
    depth: lsState?.depthWad ?? 0n, eliminationOrder: order, factors: tables,
    observationEnds: BigInt(record.prepared.draft.events[0].observationEndsAt), routes: 0n, payoutFraction: [1n, 1n], holdings: 0n,
    caseState: { phase: 0n, proposal: 0n, counter: 0n, result: 0n, challengeUntil: 0n, arbitrationUntil: 0n,
      requestId: `0x${'0'.repeat(64)}`, sourceCaseId: `0x${'0'.repeat(64)}` } };
  const market = {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: BigInt(closed ? at + 86400 : at - 7200) }),
    readContract: async ({ address, functionName, args = [], blockNumber }: any) => {
      reads.push({ functionName, blockNumber });
      if (functionName === 'protocolVersion') return address.toLowerCase() === pool.toLowerCase() ? (commissionBps === null ? 3n : 5n) : 4n;
      if (functionName === 'quoteBuy') return BigInt(args[2]) / 2n;
      if (functionName === 'eventHashes') return record.prepared.eventHashes[Number(args[0])];
      if (!(functionName in values)) throw Error(`Unexpected ${functionName}`);
      return values[functionName];
    },
  };
  const service = hybridMarketService({ catalog, market, source: {}, evidence: {}, origin: 'https://example.org', pairModel });
  return { service, state, reads };
}
const leg = (eventIndex: number, side: 'yes' | 'no') => ({ eventIndex, side });

test('analysis serves a 16-question pool and matches the certified pair', async () => {
  const { service, state } = wideMarket();
  for (const [a, b] of [[0, 7], [3, 4], [15, 2]]) {
    const analysis = await service.analysis(`${pool}-${a}`, { a, b, quantity: '1000000' });
    assert.equal(analysis.schema, 'flurbo.hybrid-analysis.v1');
    assert.deepEqual(analysis.values, certifiedPair({ ...state, a, b }).values, `${a}-${b}`);
    assert.equal(analysis.outcomes.length, 4);
    assert.ok(analysis.values.a !== null && analysis.values.joint !== null);
  }
});

test('what-if returns every question with and without up to three assumptions', async () => {
  const { service, state } = wideMarket();
  const result = await service.whatIf(`${pool}-0`, { given: [leg(3, 'no'), leg(0, 'yes'), leg(9, 'yes')] });
  const certified = certifiedScenario(state, [{ event: 0, yes: true }, { event: 3, yes: false }, { event: 9, yes: true }]);
  assert.equal(result.schema, 'flurbo.hybrid-what-if.v1');
  assert.equal(result.pool, pool);
  assert.equal(result.blockNumber, '200');
  assert.equal(result.blockHash, `0x${'9'.repeat(64)}`);
  assert.equal(result.unit, 'tenths_of_percentage_point');
  assert.equal(result.closed, false);
  assert.deepEqual(result.given, [leg(0, 'yes'), leg(3, 'no'), leg(9, 'yes')]);
  assert.equal(result.givenChance, certified.values.given);
  assert.equal(result.questions.length, 16);
  assert.deepEqual(result.questions, certified.questions.map(q => ({ eventIndex: q.event, yes: q.yes, givenYes: q.givenYes, assumed: q.assumed })));
  assert.equal(result.claim, null);
  const lone = await service.whatIf(`${pool}-0`, { given: [leg(0, 'yes')] });
  const next = lone.questions.find((q: any) => q.eventIndex === 1);
  assert.equal(lone.questions.find((q: any) => q.eventIndex === 0).givenYes, 1000);
  assert.ok(next.givenYes > next.yes);
});

test('what-if prices a three-question combination against independence with its outcome cells', async () => {
  const { service, state } = wideMarket();
  const legs = [leg(5, 'yes'), leg(0, 'yes'), leg(1, 'no')];
  const result = await service.whatIf(`${pool}-0`, { claim: { legs, rule: 'OR' } });
  const encoded = encodeClaim({ events: 16, rule: 'OR', legs: [{ event: 0, yes: true }, { event: 1, yes: false }, { event: 5, yes: true }] });
  const certified = certifiedClaim(state, encoded.scope, encoded.mask);
  assert.deepEqual(result.given, []);
  assert.equal(result.givenChance, null);
  assert.deepEqual(result.questions, []);
  const claim = result.claim;
  assert.equal(claim.scope, encoded.scope);
  assert.equal(claim.mask, encoded.mask);
  assert.equal(claim.rule, 'OR');
  assert.deepEqual(claim.legs, [leg(0, 'yes'), leg(1, 'no'), leg(5, 'yes')]);
  assert.deepEqual([claim.chance, claim.independent, claim.difference], [certified.values.market, certified.values.independent, certified.values.difference]);
  const cells = certifiedCells(state, encoded.scope);
  assert.equal(claim.cells.length, 8);
  claim.cells.forEach((cell: any, i: number) => {
    assert.equal(cell.state, i);
    assert.equal(cell.chance, cells[i].chance);
    assert.equal(cell.pays, Boolean(BigInt(encoded.mask) >> BigInt(i) & 1n));
    assert.deepEqual(cell.answers, [leg(0, i & 1 ? 'yes' : 'no'), leg(1, i & 2 ? 'yes' : 'no'), leg(5, i & 4 ? 'yes' : 'no')]);
  });
  assert.equal(claim.priceable, true);
  assert.deepEqual(claim.addable, []);
  const pair = await service.whatIf(`${pool}-0`, { claim: { legs: [leg(0, 'yes'), leg(1, 'yes')] } });
  assert.equal(pair.claim.rule, 'AND');
  assert.equal(pair.claim.cells.length, 4);
  assert.ok(pair.claim.addable.length > 0 && !pair.claim.addable.includes(0) && !pair.claim.addable.includes(1));
  const single = await service.whatIf(`${pool}-0`, { claim: { legs: [leg(2, 'no')] } });
  assert.equal(single.claim.cells.length, 2);
  assert.equal(single.claim.rule, 'AND');
});

test('what-if marks a combination the pool cannot price and lists only questions that can still be added', async () => {
  const tables: Table[] = [{ scope: 7, values: Array.from({ length: 8 }, (_, i) => BigInt(i * 100_000)) },
    { scope: 12, values: [0n, 0n, 0n, 500_000n] }, { scope: 24, values: [0n, 0n, 0n, 500_000n] }];
  const { service } = wideMarket({ count: 5, tables, commissionBps: null });
  const ask = (legs: ReturnType<typeof leg>[]) => service.whatIf(`${pool}-0`, { claim: { legs } }).then((r: any) => r.claim);
  const unpriceable = await ask([leg(0, 'yes'), leg(4, 'yes')]);
  assert.equal(unpriceable.priceable, false);
  assert.equal(unpriceable.cells.length, 4);
  const linked = await ask([leg(0, 'yes'), leg(1, 'yes')]);
  assert.equal(linked.priceable, true);
  assert.deepEqual(linked.addable, [2]);
  assert.ok(!linked.addable.includes(4));
  assert.deepEqual((await ask([leg(3, 'no'), leg(4, 'yes')])).addable, [2]);
  const named = await ask([leg(0, 'yes'), leg(1, 'yes'), leg(2, 'no')]);
  assert.equal(named.priceable, true);
  assert.deepEqual(named.addable, []);
});

test('what-if rejects empty, duplicate, out-of-pool, four-leg and unknown-key input', async () => {
  const { service } = wideMarket({ count: 5, tables: chainTables(5), commissionBps: null });
  const ask = (input: unknown) => service.whatIf(`${pool}-0`, input as never);
  const cases: [unknown, string][] = [
    [null, 'Invalid what-if input'], [[], 'Invalid what-if input'], ['x', 'Invalid what-if input'],
    [{}, 'Choose an assumption or a combination'], [{ given: [] }, 'Choose an assumption or a combination'],
    [{ given: [leg(0, 'yes')], extra: 1 }, 'Invalid what-if input'],
    [{ claim: { legs: [leg(0, 'yes')], rule: 'AND', extra: 1 } }, 'Invalid what-if input'],
    [{ given: [leg(0, 'yes'), leg(0, 'no')] }, 'Choose up to three assumptions'],
    [{ given: [leg(9, 'yes')] }, 'Choose up to three assumptions'],
    [{ given: [leg(0, 'yes'), leg(1, 'yes'), leg(2, 'yes'), leg(3, 'yes')] }, 'Choose up to three assumptions'],
    [{ given: [{ eventIndex: 0, side: 'maybe' }] }, 'Choose up to three assumptions'],
    [{ given: [{ eventIndex: 0.5, side: 'yes' }] }, 'Choose up to three assumptions'],
    [{ given: 'x' }, 'Choose up to three assumptions'],
    [{ claim: { legs: [] } }, 'Choose up to three answers'],
    [{ claim: { legs: [leg(1, 'yes'), leg(1, 'no')] } }, 'Choose up to three answers'],
    [{ claim: { legs: [leg(7, 'yes')] } }, 'Choose up to three answers'],
    [{ claim: { legs: [leg(0, 'yes'), leg(1, 'yes'), leg(2, 'yes'), leg(3, 'yes')] } }, 'Choose up to three answers'],
    [{ claim: { legs: [leg(0, 'yes'), leg(1, 'yes')], rule: 'AT_LEAST_TWO' } }, 'Choose a supported combination'],
    [{ claim: { legs: [leg(0, 'yes'), leg(1, 'yes')], rule: 'MAYBE' } }, 'Choose a supported combination'],
  ];
  for (const [input, message] of cases) await assert.rejects(ask(input), { message }, JSON.stringify(input));
  await assert.rejects(service.whatIf(`${pool}-9`, { given: [leg(0, 'yes')] }), /Hybrid market not found/);
});

test('what-if fails closed when the reference model disagrees', async () => {
  const shifted = async (input: string) => {
    const result = await realModel(input);
    return { ...result, givenYes: result.givenYes.map((v: number) => v + 0.01) };
  };
  await assert.rejects(wideMarket({ pairModel: shifted }).service.whatIf(`${pool}-0`, { given: [leg(0, 'yes')] }), /Hybrid comparison unavailable/);
  const moved = async (input: string) => ({ ...(await realModel(input)), given: 0.9 });
  await assert.rejects(wideMarket({ pairModel: moved }).service.whatIf(`${pool}-0`, { given: [leg(0, 'yes')] }), /Hybrid comparison unavailable/);
  const broken = async () => ({ given: 0.5, yes: [], givenYes: [] });
  await assert.rejects(wideMarket({ pairModel: broken as never }).service.whatIf(`${pool}-0`, { given: [leg(0, 'yes')] }), /Hybrid comparison unavailable/);
  const fine = await wideMarket().service.whatIf(`${pool}-0`, { given: [leg(0, 'yes')] });
  assert.equal(fine.questions.length, 16);
});

test('analysis, web and what-if read the pool state once per block within six seconds', async () => {
  const { service, reads } = wideMarket();
  await service.analysis(`${pool}-0`, { a: 0, b: 1, quantity: '1000000' });
  await service.web(`${pool}-0`);
  await service.whatIf(`${pool}-0`, { given: [leg(0, 'yes')] });
  await service.whatIf(`${pool}-4`, { claim: { legs: [leg(4, 'yes'), leg(5, 'no')] } });
  const pinned = (name: string) => reads.filter(r => r.functionName === name && r.blockNumber !== undefined);
  for (const name of ['liquidity', 'eliminationOrder', 'factors', 'depth', 'commissionBps']) assert.equal(pinned(name).length, 1, name);
  assert.ok(pinned('factors').every(r => r.blockNumber === 200n));
});
