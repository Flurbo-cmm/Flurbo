import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { prepareHybridPilot, hybridRulesHash } from '../scripts/prepare-hybrid-pilot.mjs';
import { hybridMarketService } from '../server/hybrid-market-service.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';

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
});
