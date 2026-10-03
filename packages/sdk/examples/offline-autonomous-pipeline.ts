// The autonomous pipeline, offline and deterministic: research -> validated forecast -> strategy ->
// deterministic policy -> the transaction that would be signed. No network, no keys, no signer. The
// forecaster here is a FIXTURE (a fixed reply), not AI; examples/ai-agent.ts uses a real model provider.
// Run: node packages/sdk/examples/offline-autonomous-pipeline.ts
import { createClient, fixtureTransport, FIXTURE_NAMESPACE, FIXTURE_NOW, claimKey, formatAtoms, evaluatePolicy, buildTransaction, buyLimit, MODEL_SCHEMA, EVIDENCE_SCHEMA,
  type Deployment, type QuoteResult, type Claim } from '../src/index.ts';
import { fixtureRetriever, fixtureForecaster, researcher } from '../src/node/research.ts';
import { jointEdgeStrategy } from '../src/node/runner.ts';
import { createHash } from 'node:crypto';

const client = createClient({ transport: fixtureTransport() });
const [entry] = await client.directory();
const market = await client.market(entry.namespace);
console.log(`${market.title} (FIXTURE data, not a live market)`);

// 1. Research. Evidence records come from a retriever; the model can only cite their ids.
const fixtureText = 'Both release branches were tagged on the same day (fixture text).';
const evidence = fixtureRetriever([{ schema: EVIDENCE_SCHEMA, id: 'src-1', url: 'https://example.org/fixture-release-notes', requestedUrl: 'https://example.org/fixture-release-notes',
  finalUrl: 'https://example.org/fixture-release-notes', title: 'Fixture release notes', publisher: 'example.org',
  publisherReleasedAt: FIXTURE_NOW - 3_600, httpLastModified: null, completeDocument: true, capturedBytes: Buffer.byteLength(fixtureText), eventIds: [0, 1],
  contentSha256: createHash('sha256').update(fixtureText).digest('hex'), excerpt: fixtureText }]);
const forecaster = fixtureForecaster(() => JSON.stringify({ schema: MODEL_SCHEMA, abstain: false, abstainReason: null, events: [0, 1], statesPpm: [250_000, 100_000, 100_000, 550_000],
  evidenceIds: ['src-1'], assumptions: ['The two releases share a dependency.'], uncertainty: 'A late fix could split them.',
  explanation: 'Fixture reasoning: both branches were tagged together, so both releases are likely and linked.' }), 'offline-fixture (not AI)');
const research = researcher({ retriever: evidence, forecaster, maxEvidenceAgeSeconds: 14 * 86_400, perCycle: 2, perHour: 10, now: () => FIXTURE_NOW });
const found = await research.research({ pool: market.pool, title: market.title, eventCount: market.events.length,
  events: market.events.slice(0, 2).map(e => ({ index: e.index, question: e.question, yesRule: e.yesRule, noRule: e.noRule, observationEndsAt: e.observationEndsAt })), sources: [] });
if (found.status !== 'ok') { console.log(`Abstained: ${found.reason}`); process.exit(0); }
console.log(`Forecast source: ${found.forecast.source.kind} ${found.forecast.source.name}; joint ppm ${found.forecast.joint.states.join(', ')}`);

// 2. Strategy with executable quotes (fixture quotes stand in for pool.quoteBuy).
const strategy = jointEdgeStrategy({ quantityAtoms: 1_000_000n, slippageBps: 50, minEdgeBps: 500, minEdgeAtoms: 10_000n, maxCostAtoms: 2_000_000n, minEvidence: 1, maxEvidenceAgeDays: 14, includeSingles: true });
const quote = async (claims: Claim[], quantity: bigint) => {
  const out = new Map<string, QuoteResult>();
  for (const c of claims) out.set(claimKey(c), await client.quote(FIXTURE_NAMESPACE, c, quantity, market.events.length));
  return out;
};
const decision = await strategy.decide({ market, forecast: found.forecast, now: FIXTURE_NOW, implied: null, quote });
console.log(`Decision: ${decision.outcome}. ${decision.explanation}`);
if (!decision.proposal) process.exit(0);
const p = decision.proposal, limit = buyLimit(p.quoteAtoms, p.slippageBps);

// 3. Deterministic policy, with a wallet and journal as the runtime would read them.
const verdict = evaluatePolicy({
  policy: { markets: [FIXTURE_NAMESPACE], maxQuantityAtoms: '2000000', maxTradeCostAtoms: '2000000', maxSlippageBps: 50, spend: { totalAtoms: '10000000', windows: [{ seconds: 86_400, atoms: '5000000' }] },
    maxPositionAtoms: '5000000', maxWorstCaseLossAtoms: '5000000', gas: { maxFeeWei: '100000000000000000', reserveWei: '200000000000000000' }, quoteMaxAgeSeconds: 30,
    minSecondsBeforeClose: 120, maxPending: 2, allowSell: false, allowRedeem: false },
  now: FIXTURE_NOW, market: { namespace: FIXTURE_NAMESPACE, pool: market.pool, eventCount: market.events.length, closesAt: market.closesAt, open: market.open, resolved: market.resolved },
  wallet: { nativeBalanceWei: '1000000000000000000', holdings: [] }, journal: [],
  candidate: { action: 'buy', namespace: FIXTURE_NAMESPACE, claim: { scope: p.claim.scope, mask: p.claim.mask.toString() }, quantityAtoms: p.quantityAtoms.toString(), limitAtoms: limit.toString(),
    slippageBps: p.slippageBps, quoteBlockTimestamp: market.snapshot.timestamp, gasLimit: '250000', maxFeePerGas: '100000000000' },
});
console.log(`Policy: ${verdict.ok ? 'passes' : `rejected (${verdict.violations.join(', ')})`}`);

// 4. The exact transaction a live runtime would validate and sign. Here nothing is signed or sent.
const deployment: Deployment = { schema: 'flurbo.agent-deployment.v1', interface: 'flurbo.pilot-pool.v1', namespace: FIXTURE_NAMESPACE, chainId: 10143, pool: market.pool,
  resolver: '0x' + '00'.repeat(19) + '01', collateral: { address: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc', decimals: 6 }, codeHashes: { pool: '0x' + '00'.repeat(32), resolver: '0x' + '00'.repeat(32) },
  rulesHash: '0x' + '00'.repeat(32), closesAt: market.closesAt, eventCount: market.events.length, limits: { maxQuantityAtoms: '100000000', maxLimitAtoms: '100000000', slippageBps: [10, 50, 100], maxDeadlineSeconds: 300 } };
const tx = buildTransaction({ action: 'buy', claim: { scope: p.claim.scope, mask: p.claim.mask }, quantityAtoms: p.quantityAtoms, limitAtoms: limit, deadline: market.snapshot.timestamp + 300 },
  deployment, '0x' + '11'.repeat(20));
console.log(`Would sign: buy ${formatAtoms(p.quantityAtoms)} share(s), paying at most ${formatAtoms(limit)} test AUSD, calldata ${tx.data.slice(0, 18)}... (offline: nothing signed)`);
