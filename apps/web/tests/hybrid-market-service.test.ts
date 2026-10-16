import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { prepareHybridPilot, hybridRulesHash } from '../scripts/prepare-hybrid-pilot.mjs';
import { hybridMarketService } from '../server/hybrid-market-service.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';
import { runPairModel } from '../server/pair-analytics.mjs';
import { certifiedClaim, certifiedPair } from '../server/pair-math.mjs';
import { simulatePairPurchase } from '../server/pair-sensitivity.mjs';
import { depthRateWad, lsAnalyticsState } from '../shared/ls-lmsr.mjs';
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
