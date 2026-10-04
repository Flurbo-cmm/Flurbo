import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, parseAbiParameters } from 'viem';
import { prepareWidePilot } from '../scripts/prepare-wide-pilot.mjs';
import { registerOraclePool } from '../scripts/register-oracle-pool.mjs';
import { SEPOLIA_KLEROS, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

const h = (x: string) => `0x${x.repeat(64)}`;
const a = (x: string) => `0x${x.repeat(40)}`;
const eventAbi = parseAbiItem('event LogNewQuestion(bytes32 indexed question_id,address indexed user,uint256 template_id,string question,bytes32 indexed content_hash,address arbitrator,uint32 timeout,uint32 opening_ts,uint256 nonce,uint256 created)');
const fields = parseAbiParameters('uint256 template_id,string question,address arbitrator,uint32 timeout,uint32 opening_ts,uint256 nonce,uint256 created');

test('registration checks each Reality creation receipt and live pool binding', async () => {
  const now = Math.floor(Date.now() / 1000);
  const creator = a('1'), relay = a('2'), pool = a('3'), resolver = a('4'), rulesHash = h('a');
  const publication = { schema: 'flurbo.wide-publication.v3', chainId: 10143,
    trustModel: 'trusted-source-relay', rulesReviewed: true, creator, relay,
    title: 'Bound question fixture', closesAt: now + 7200, reportPeriod: 86400,
    liquidityAtoms: '10000000', events: [0, 1].map(i => ({ id: `event-${i}`,
      question: `Did test event ${i} occur?`, observationEndsAt: now + 10800,
      source: { kind: 'reality-sepolia', chainId: 11155111, reality: SEPOLIA_REALITY,
        arbitrator: SEPOLIA_KLEROS, questionId: h(i ? '6' : '5'),
        contentHash: h(i ? '8' : '7'), questionTxHash: h(i ? 'c' : 'b'),
        questionText: `Did test event ${i} occur?␟flurbo-poc␟en`, minTimeout: 3600,
        minBond: '1000' } })) };
  const prepared = prepareWidePilot(publication, now);
  const manifest = { schema: 'flurbo.wide-manifest.v3', status: 'unverified_deployment',
    creator, relay, pool, resolver, rulesHash, configHash: prepared.configHash,
    draftHash: prepared.draftHash, eventCount: 2 };
  const source = { getChainId: async () => 11155111,
    getBlock: async () => ({ timestamp: BigInt(now), number: 500n }),
    getTransactionReceipt: async ({ hash }: any) => {
      const e = publication.events.find(v => v.source.questionTxHash === hash)!;
      return { status: 'success', logs: [{ address: SEPOLIA_REALITY,
        topics: encodeEventTopics({ abi: [eventAbi], eventName: 'LogNewQuestion', args: {
          question_id: e.source.questionId, user: creator, content_hash: e.source.contentHash } }),
        data: encodeAbiParameters(fields, [0n, e.source.questionText, SEPOLIA_KLEROS,
          3600, e.observationEndsAt, 0n, BigInt(now)]) }] };
    },
    readContract: async ({ functionName, args }: any) => {
      const i = publication.events.findIndex(v => v.source.questionId === args?.[0]);
      return ({ realitio: SEPOLIA_REALITY,
        getContentHash: publication.events[i]?.source.contentHash,
        getArbitrator: SEPOLIA_KLEROS, getTimeout: 3600, getOpeningTS: now + 10800,
        getFinalizeTS: 0, getBond: 0n, getMinBond: 1000n, getBestAnswer: h('0'), getHistoryHash: h('0'),
        isFinalized: false, isPendingArbitration: false, getDisputeFee: 1000n,
        arbitrationRequests: [0, a('0'), 0n, 0n] } as any)[functionName];
    } };
  const market = { getChainId: async () => 10143,
    getBlock: async () => ({ timestamp: BigInt(now), number: 600n }),
    getBlockNumber: async () => 600n,
    getBytecode: async ({ blockNumber }: any) => blockNumber >= 420n ? '0x6000' : undefined,
    readContract: async ({ functionName, args }: any) => ({ protocolVersion: 3,
      collateral: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc',
      resolver, settlementRulesHash: rulesHash, eventCount: 2,
      closesAt: BigInt(publication.closesAt), funded: true, resolved: false,
      rulesHash, pool, relay, eventHashes: prepared.eventHashes[Number(args?.[0])],
      observationEnds: BigInt(publication.events[Number(args?.[0] ?? 0)].observationEndsAt),
      reportDeadline: BigInt(now + 10800 + 86400), caseState: { phase: 0, result: 0 } } as any)[functionName] };
  const props = { prepared, manifest, existing: { schema: 'flurbo.oracle-catalog.v1', routes: [] },
    origin: 'https://flurbopm.singu.online', source, market };
  const candidate = await registerOraclePool(props);
  assert.equal(candidate.routes.length, 2);
  assert.equal(candidate.routes[1].eventIndex, 1);
  assert.equal(candidate.routes[0].deploymentBlock, 420);
  await assert.rejects(registerOraclePool({ ...props, prepared: { ...prepared,
    publication: { ...publication, events: [{ ...publication.events[0],
      question: 'A substituted question?' }, publication.events[1]] } } }), /commitments changed|creation receipt mismatch|Reality question/);
});
