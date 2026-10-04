import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { prepareRealityRelay, realityOutcome, wideResolverAbi } from '../server/reality-relay.mjs';
import { wideCommitments } from '../scripts/prepare-wide-pilot.mjs';

const h = (x: string) => `0x${x.repeat(64)}`;
const a = (x: string) => `0x${x.repeat(40)}`;
const publication = {
  schema: 'flurbo.wide-publication.v3', chainId: 10143, trustModel: 'trusted-source-relay',
  title: 'Bound Reality route', closesAt: 1000, relay: a('9'), reportPeriod: 4000,
  events: Array.from({ length: 32 }, (_, index) => ({
    id: `question-${index}`, observationEndsAt: 1000,
    source: { kind: 'reality-sepolia', chainId: 11155111, reality: a('1'),
      arbitrator: a('2'), questionId: h('5'), contentHash: h('6'),
      minTimeout: 86400, minBond: '1000' },
  })),
};
const route = {
  schema: 'flurbo.reality-route.v2', sourceChainId: 11155111, marketChainId: 10143,
  reality: a('1'), arbitrator: a('2'), pool: a('3'), resolver: a('4'), relay: a('9'),
  questionId: h('5'), contentHash: h('6'), rulesHash: h('7'),
  eventHash: wideCommitments(publication).eventHashes[31], publication,
  eventIndex: 31, minTimeout: 86400, minBond: '1000',
  evidenceURI: 'https://example.org/evidence.json',
};

function clients(answer = h('0'), overrides: Record<string, unknown> = {}) {
  const source = {
    getChainId: async () => 11155111,
    getBlock: async ({ blockTag }: any) => { assert.equal(blockTag, 'finalized'); return { number: 123n, hash: h('a') }; },
    readContract: async ({ functionName, args, blockNumber }: any) => {
      assert.equal(blockNumber, 123n);
      assert.equal(functionName, 'getFinalAnswerIfMatches');
      assert.equal(args[0], route.questionId);
      assert.equal(args[1], route.contentHash);
      assert.equal(args[2].toLowerCase(), route.arbitrator);
      return answer;
    },
  };
  const marketValues: Record<string, unknown> = {
    protocolVersion: 3, collateral: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc', rulesHash: route.rulesHash, pool: route.pool, relay: route.relay, eventCount: 32,
    eventHashes: route.eventHash, observationEnds: 1000n, reportDeadline: 5000n, caseState: { phase: 0 },
    resolver: route.resolver, funded: true, ...overrides,
  };
  const market = {
    getChainId: async () => 10143,
    getBlock: async () => ({ timestamp: 2000n }),
    readContract: async ({ functionName }: any) => marketValues[functionName],
  };
  return [source, market] as const;
}

test('maps Reality boolean and invalid answers', () => {
  assert.equal(realityOutcome(h('0')), 1);
  assert.equal(realityOutcome(`0x${'0'.repeat(63)}1`), 2);
  assert.equal(realityOutcome(h('f')), 3);
  assert.throws(() => realityOutcome(`0x${'0'.repeat(63)}2`), /not boolean/);
});

test('prepares a v3-only final report from a finalized source block for event 31', async () => {
  const [source, market] = clients(`0x${'0'.repeat(63)}1`);
  const result = await prepareRealityRelay(route, source, market);
  assert.equal(result.outcome, 2);
  assert.equal(result.relay.toLowerCase(), route.relay);
  assert.equal(result.evidence.sourceBlockNumber, '123');
  assert.equal(result.transaction.to.toLowerCase(), route.resolver);
  const decoded = decodeFunctionData({ abi: wideResolverAbi, data: result.transaction.data });
  assert.equal(decoded.functionName, 'reportFinal');
  assert.equal(decoded.args?.[0], 31);
  assert.equal(decoded.args?.[1], 2);
  assert.equal(decoded.args?.[2], result.evidenceHash);
  assert.equal(decoded.args?.[3], route.evidenceURI);
});

test('rejects old pool and mismatched question binding', async () => {
  const [source, oldMarket] = clients(h('0'), { protocolVersion: 1 });
  await assert.rejects(prepareRealityRelay(route, source, oldMarket), /binding/);
  const [source2, wrongMarket] = clients(h('0'), { eventHashes: h('9') });
  await assert.rejects(prepareRealityRelay(route, source2, wrongMarket), /binding/);
  const [source3, wrongRelay] = clients(h('0'), { relay: a('a') });
  await assert.rejects(prepareRealityRelay(route, source3, wrongRelay), /binding/);
});

test('rejects a substituted Reality question with the original event hash', async () => {
  const [source, market] = clients(h('0'));
  await assert.rejects(prepareRealityRelay({ ...route, questionId: h('a') }, source, market), /binding/);
  const altered = structuredClone(route);
  altered.publication.events[31].source.questionId = h('a');
  await assert.rejects(prepareRealityRelay(altered, source, market), /binding/);
});

test('rejects nonfinal Reality answer', async () => {
  const [source, market] = clients(h('0'));
  source.readContract = async () => { throw Error('question not finalized'); };
  await assert.rejects(prepareRealityRelay(route, source, market), /not finalized/);
});

