import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi } from 'viem';
import { AGENT_MAX_QUESTIONS, AGENT_MIN_QUESTIONS, ANALYTICS_MAX_QUESTIONS, agentNamespace, hybridAgentPools, hybridEventRules, hybridPoolManifest,
  hybridPoolService, readHybridPoolAnchor } from '../server/hybrid-pool-service.mjs';
import { settlementRuleHash } from '../server/settlement-rules.mjs';
import { loadSemanticConfig } from '../server/semantic-validation.mjs';
import { settlementSources } from '../shared/settlement-sources.mjs';
import { pilotCall, pilotCash, pilotCashAbi, pilotPoolAbi, COMBINATION_LIMIT_MESSAGE } from '../shared/pilot.mjs';
import { rpcInteger, submitPilot, validatePilotReview } from '../src/pilot.ts';
import { account, hybridRecord, realityCatalog, ruleFor } from './hybrid-catalog-fixture.ts';
import { depthRateWad } from '../shared/ls-lmsr.mjs';
import { code, hash, owner, pool, poolFixture, resolver, rules } from './pool-fixture.ts';

const mechanicalYes = 'YES if the valid source record selected by the committed rule satisfies number gte "4". Missing or ambiguous evidence does not mean NO.';
const mechanicalNo = 'NO if the valid source record selected by the committed rule does not satisfy number gte "4". Missing or ambiguous evidence follows the committed VOID timeout.';
const anchorFor = (record: any) => ({ verifiedBlockHash: hash, codeHashes: { [record.pool.toLowerCase()]: keccak256(code), [record.resolver.toLowerCase()]: keccak256(code) } });
const reviewKeys = ['schema', 'manifest', 'snapshot', 'expiresAt', 'action', 'requested', 'title', 'semanticAssessment', 'amountAtoms', 'quotedCostAtoms', 'impact',
  'minimumReceivedAtoms', 'gasLimit', 'gasPrice', 'maximumFeeWei', 'transaction', 'notice'];
const callName = (params: any[]) => decodeFunctionData({ abi: params[0].to === pool ? pilotPoolAbi : pilotCashAbi, data: params[0].data }).functionName;
// Replace pool or cash reads by function name; everything else goes to the fixture chain.
const reads = (f: ReturnType<typeof poolFixture>, values: Record<string, unknown>) => async (method: string, params: any[] = []) => {
  if (method === 'eth_call' && !params[0].from) {
    const abi = params[0].to === pool ? pilotPoolAbi : pilotCashAbi, { functionName } = decodeFunctionData({ abi, data: params[0].data });
    if (functionName in values) return encodeFunctionResult({ abi, functionName, result: values[functionName] as never });
  }
  return f.rpc(method, params);
};
// A Multicall3-style batch over single reads, counted.
const batched = (rpc: (method: string, params?: any[]) => Promise<any>) => {
  const batches: number[] = [];
  const wrapped: any = (method: string, params: any[] = []) => rpc(method, params);
  wrapped.readBatch = async (calls: any[], tag: string) => {
    batches.push(calls.length);
    return Promise.all(calls.map(async c => decodeFunctionResult({ abi: c.abi, functionName: c.fn,
      data: await rpc('eth_call', [{ to: c.to, data: encodeFunctionData({ abi: c.abi, functionName: c.fn, args: c.args }) }, tag]) })));
  };
  return { rpc: wrapped, batches };
};

test('agent pool constants and namespace', () => {
  assert.equal(AGENT_MIN_QUESTIONS, 2); assert.equal(AGENT_MAX_QUESTIONS, 32); assert.equal(ANALYTICS_MAX_QUESTIONS, 4);
  assert.equal(agentNamespace('0xB5CE32DE7A8631960dd26ab46bB20524d1fF9a44'), 'practice-b5ce32de7a8631960dd26ab46bb20524d1ff9a44');
});

test('the synthetic manifest keeps the legacy constants, lowercase addresses and committed rules', () => {
  const record: any = hybridRecord({ count: 3, pool: getAddress('0x' + 'ab'.repeat(20)), resolver: getAddress('0x' + 'cd'.repeat(20)) });
  const codeHashes = { ['0x' + 'ab'.repeat(20)]: keccak256(code), ['0x' + 'cd'.repeat(20)]: keccak256('0x6001') };
  const manifest: any = hybridPoolManifest(record, { verifiedBlockHash: hash, codeHashes });
  assert.equal(manifest.schema, 'flurbo.pilot-manifest.v1'); assert.equal(manifest.status, 'verified_pilot_snapshot');
  assert.equal(manifest.chainId, 10143); assert.equal(manifest.publication.mode, 'hybrid-v4');
  assert.equal(manifest.pool, '0x' + 'ab'.repeat(20)); assert.equal(manifest.resolver, '0x' + 'cd'.repeat(20));
  assert.equal(manifest.rulesHash, record.rulesHash.toLowerCase()); assert.equal(manifest.draftHash, record.prepared.draftHash.toLowerCase());
  assert.equal(manifest.verifiedBlock, '100'); assert.equal(manifest.verifiedBlockHash, hash);
  assert.deepEqual(manifest.codeHashes, codeHashes);
  assert.equal(manifest.publication.creator, account('1')); assert.equal(manifest.publication.bondAtoms, '1000000');
  assert.equal(manifest.publication.assertionPeriod, 3600); assert.equal(manifest.publication.challengePeriod, 3600);
  assert.equal(manifest.publication.draft.title, 'Explicit test fixtures'); assert.equal(manifest.publication.draft.closesAt, record.prepared.draft.closesAt);
  assert.deepEqual(manifest.publication.settlementRules, record.prepared.draft.events.map((e: any) => e.rule));
  manifest.publication.draft.events.forEach((event: any, i: number) => {
    const source = record.prepared.draft.events[i];
    assert.equal(event.id, source.id); assert.equal(event.question, source.question); assert.equal(event.route, 'mechanical');
    assert.equal(event.yesRule, mechanicalYes); assert.equal(event.noRule, mechanicalNo);
    assert.equal(event.observationStartsAt, null); assert.equal(event.observationEndsAt, source.observationEndsAt);
    assert.equal(event.source.publisher, 'Official publisher'); assert.equal(event.source.referenceUrl, 'https://data.example.org/value');
    assert.equal(event.source.recordId, `settlement-rule:sha256:${settlementRuleHash(source.rule)}`);
  });
  assert.deepEqual(settlementSources(manifest), record.prepared.draft.events.map(() => ({ method: 'json-api.v1', request: 'GET', urls: ['https://data.example.org/value'] })));
});

test('event rules: mechanical with and without a usable decision, and reality questions', () => {
  const end = 1_800_000_000, question = 'Will the official value be at least four?';
  const rule: any = ruleFor('first', end, question);
  rule.source.urls = ['https://data.example.org/value?series=a&period=2027-01'];
  const mechanical = hybridEventRules({ id: 'first', question, route: 'mechanical', observationEndsAt: end, rule });
  assert.equal(mechanical.yesRule, mechanicalYes); assert.equal(mechanical.noRule, mechanicalNo);
  assert.deepEqual(mechanical.source, { publisher: 'Official publisher', referenceUrl: 'https://data.example.org/value', recordId: `settlement-rule:sha256:${settlementRuleHash(rule)}` });
  assert.ok(mechanical.source!.recordId.startsWith('settlement-rule:sha256:')); assert.ok(!mechanical.source!.referenceUrl!.includes('?'));
  const vague = hybridEventRules({ id: 'first', question, route: 'mechanical', observationEndsAt: end, rule: { ...rule, decision: null } });
  assert.equal(vague.yesRule, 'YES if the committed source rule resolves to YES. Missing or ambiguous evidence does not mean NO.');
  assert.equal(vague.noRule, 'NO if the committed source rule resolves to NO. Missing or ambiguous evidence follows the committed VOID timeout.');
  const record: any = realityCatalog().pools[0], event = record.prepared.draft.events[0];
  const reality = hybridEventRules(event);
  assert.equal(reality.yesRule, 'YES if the Reality.eth answer for this question finalises as Yes.');
  assert.equal(reality.noRule, 'NO if the Reality.eth answer for this question finalises as No. An Invalid or unanswered question settles VOID.');
  assert.deepEqual(reality.source, { publisher: 'Reality.eth on Sepolia', referenceUrl: event.source.ruleURI, recordId: `reality:${event.source.questionId}` });
  assert.equal(hybridEventRules({ ...event, source: { ...event.source, ruleURI: undefined } }).source, null);
  const manifest: any = hybridPoolManifest(record, anchorFor(record));
  assert.deepEqual(manifest.publication.settlementRules, [null, null]);
  assert.deepEqual(settlementSources(manifest), [null, null]);
  assert.deepEqual(manifest.publication.draft.events.map((e: any) => e.route), ['reality', 'reality']);
});

test('the deployment anchor is read once from the chain and malformed reads are refused', async () => {
  const record: any = hybridRecord({ pool: getAddress('0x' + 'ab'.repeat(20)), resolver: getAddress('0x' + 'cd'.repeat(20)) });
  const calls: any[] = [];
  const chain = (block: any, codes: Record<string, string>) => async (method: string, params: any[]) => {
    calls.push([method, params]);
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getCode') return codes[params[0]];
    throw Error('Unexpected RPC ' + method);
  };
  const codes = { ['0x' + 'ab'.repeat(20)]: '0x6000', ['0x' + 'cd'.repeat(20)]: '0x6001' };
  const anchor = await readHybridPoolAnchor({ record, rpc: chain({ hash: '0x' + 'AA'.repeat(32) }, codes) });
  assert.deepEqual(anchor, { verifiedBlockHash: '0x' + 'aa'.repeat(32), codeHashes: { ['0x' + 'ab'.repeat(20)]: keccak256('0x6000'), ['0x' + 'cd'.repeat(20)]: keccak256('0x6001') } });
  assert.deepEqual(calls.find(([m]) => m === 'eth_getBlockByNumber')[1], ['0x64', false]);
  assert.ok(calls.filter(([m]) => m === 'eth_getCode').every(([, p]) => p[1] === 'latest'));
  await assert.rejects(readHybridPoolAnchor({ record, rpc: chain(null, codes) }), /^Error: Hybrid deployment block unavailable$/);
  await assert.rejects(readHybridPoolAnchor({ record, rpc: chain({ hash: '0x1234' }, codes) }), /^Error: Hybrid deployment block unavailable$/);
  await assert.rejects(readHybridPoolAnchor({ record, rpc: chain({ hash }, { ...codes, ['0x' + 'cd'.repeat(20)]: '0x' }) }), /^Error: Hybrid contract code unavailable$/);
  await assert.rejects(readHybridPoolAnchor({ record, rpc: chain({ hash }, { ['0x' + 'cd'.repeat(20)]: '0x6001' }) }), /^Error: Hybrid contract code unavailable$/);
});

test('the service refuses a manifest that is not a verified hybrid agent pool', () => {
  const { manifest, rpc } = poolFixture();
  const bad = (change: (m: any) => void) => { const m = structuredClone(manifest); change(m); return () => hybridPoolService({ manifest: m, rpc }); };
  assert.doesNotThrow(() => hybridPoolService({ manifest, rpc }));
  for (const change of [
    (m: any) => { m.schema = 'flurbo.other.v1'; }, (m: any) => { m.status = 'unverified'; }, (m: any) => { m.publication.mode = 'rehearsal'; },
    (m: any) => { m.chainId = 143; }, (m: any) => { m.publication.draft.events = m.publication.draft.events.slice(0, 1); },
    (m: any) => { m.publication.draft.events = Array.from({ length: 33 }, (_, i) => ({ ...m.publication.draft.events[0], id: `e-${i}` })); },
    (m: any) => { delete m.codeHashes[resolver]; }, (m: any) => { m.pool = '0x' + '00'.repeat(20); }, (m: any) => { m.resolver = '0x' + 'AB'.repeat(20); },
  ]) assert.throws(bad(change), /^Error: Verified hybrid pool manifest required$/);
});

test('snapshots verify network, anchor, freshness, code and pool binding at the head block', async () => {
  const now = 1_800_000_000, f = poolFixture(now);
  assert.deepEqual(await f.service.snapshot(), { blockNumber: '100', blockHash: hash, timestamp: now });
  f.options.chain = 143n; await assert.rejects(f.service.snapshot(), /^Error: Wrong network$/); f.options.chain = 10143n;
  f.options.changed = true; await assert.rejects(f.service.snapshot(), /^Error: Deployment anchor changed$/); f.options.changed = false;
  await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: f.rpc, now: () => now + 181 }).snapshot(), /^Error: Stale chain data$/);
  await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: f.rpc, now: () => now - 16 }).snapshot(), /^Error: Stale chain data$/);
  const otherCode = async (method: string, params: any[] = []) => method === 'eth_getCode' && params[0] === resolver ? '0x6001' : f.rpc(method, params);
  await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: otherCode, now: () => now }).snapshot(), /^Error: Contract code changed$/);
  for (const values of [{ settlementRulesHash: '0x' + '66'.repeat(32) }, { resolver: '0x' + '77'.repeat(20) }, { eventCount: 3 }])
    await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: reads(f, values), now: () => now }).snapshot(), /^Error: Pool binding changed$/);
  const checks = { codes: 0, heads: 0 };
  const counted = async (method: string, params: any[] = []) => {
    if (method === 'eth_getCode') checks.codes++;
    if (method === 'eth_chainId') checks.heads++;
    return f.rpc(method, params);
  };
  const reused = hybridPoolService({ manifest: f.manifest, rpc: counted, now: () => now, snapshotReuseMs: 60_000 });
  const [a, b] = [await reused.snapshot({ reuse: true }), await reused.snapshot({ reuse: true })];
  assert.deepEqual(a, b); assert.equal(checks.heads, 1); assert.equal(checks.codes, 2);
  await reused.snapshot(); assert.equal(checks.heads, 2);
  const failing = hybridPoolService({ manifest: f.manifest, rpc: f.rpc, now: () => now, snapshotReuseMs: 60_000 });
  f.options.chain = 143n; await assert.rejects(failing.snapshot({ reuse: true }), /Wrong network/); f.options.chain = 10143n;
  assert.deepEqual(await failing.snapshot({ reuse: true }), a);
});

test('markets read one-share YES and NO buy prices at one verified block', async () => {
  const now = 1_800_000_000, f = poolFixture(now, 3), quoted: any[] = [];
  const watch = async (method: string, params: any[] = []) => {
    if (method === 'eth_call' && callName(params) === 'quoteBuy') quoted.push(decodeFunctionData({ abi: pilotPoolAbi, data: params[0].data }).args);
    return f.rpc(method, params);
  };
  const plain = await hybridPoolService({ manifest: f.manifest, rpc: watch, now: () => now }).markets();
  assert.deepEqual(Object.keys(plain).sort(), ['manifest', 'open', 'prices', 'resolved', 'snapshot']);
  assert.equal(plain.open, true); assert.equal(plain.resolved, false); assert.deepEqual(plain.snapshot, { blockNumber: '100', blockHash: hash, timestamp: now });
  assert.deepEqual(plain.prices, [0, 1, 2].map(event => ({ event, yes: '250000', no: '250000' })));
  assert.deepEqual(quoted.map(a => a.map(String)).sort(), [0, 1, 2].flatMap(e => [[String(2 ** e), '2', '1000000'], [String(2 ** e), '1', '1000000']]).sort());
  const { rpc, batches } = batched(watch);
  const batch = await hybridPoolService({ manifest: f.manifest, rpc, now: () => now }).markets();
  assert.deepEqual(batch.prices, plain.prices); assert.deepEqual(batches, [6]);
  f.options.resolved = true;
  const resolved = await f.service.markets();
  assert.equal(resolved.open, false); assert.equal(resolved.resolved, true); assert.deepEqual(resolved.prices, [0, 1, 2].map(event => ({ event, yes: null, no: null })));
  f.options.resolved = false;
  const closed = structuredClone(f.manifest); closed.publication.draft.closesAt = now - 1;
  const late = await hybridPoolService({ manifest: closed, rpc: f.rpc, now: () => now }).markets();
  assert.equal(late.open, false); assert.deepEqual(late.prices.map((p: any) => [p.yes, p.no]), [[null, null], [null, null], [null, null]]);
});

test('prepare reviews only bounded buys: exact approval first, then the trade', async () => {
  const now = 1_800_000_000, f = poolFixture(now), input = { owner, action: 'buy', scope: 3, mask: '8', quantity: '1000000', slippageBps: 50 };
  const approval = await f.service.prepare(input);
  assert.equal(approval.action, 'approve'); assert.equal(approval.title, 'Approve buy'); assert.equal(approval.amountAtoms, '251250');
  assert.equal(approval.transaction.to, pilotCash);
  const approve = decodeFunctionData({ abi: pilotCashAbi, data: approval.transaction.data });
  assert.equal(approve.functionName, 'approve'); assert.deepEqual(approve.args, [pool, 251250n]);
  f.options.allowance = 1_000_000n;
  const review = await f.service.prepare(input);
  assert.deepEqual(Object.keys(review), reviewKeys);
  assert.equal(review.schema, 'flurbo.pilot-review.v1'); assert.equal(review.action, 'buy'); assert.equal(review.title, 'buy');
  assert.equal(review.expiresAt, review.snapshot.timestamp + 300);
  assert.equal(review.amountAtoms, String((250_000n * 10_050n + 9_999n) / 10_000n)); assert.equal(review.quotedCostAtoms, '250000');
  assert.deepEqual(review.impact, { quoteAtoms: '250000', oneShareAtoms: '250000' }); assert.equal(review.minimumReceivedAtoms, '0');
  assert.deepEqual({ ...review.transaction, data: undefined }, { from: owner, to: pool, data: undefined, value: '0x0', chainId: '0x279f' });
  assert.equal(review.gasLimit, String(100_000n * 120n / 100n)); assert.equal(review.gasPrice, '1000000000');
  assert.equal(review.maximumFeeWei, String(120_000n * 1_000_000_000n));
  const call = decodeFunctionData({ abi: pilotPoolAbi, data: review.transaction.data });
  assert.equal(call.functionName, 'buy'); assert.deepEqual(call.args, [3, 8n, 1_000_000n, 251_250n, BigInt(now + 300)]);
  assert.equal(review.semanticAssessment.mode, 'disabled'); assert.equal(review.semanticAssessment.pool, pool);
  assert.deepEqual(review.requested, input); assert.equal(review.manifest.pool, pool);
});

test('prepare refuses everything except a supported buy', async () => {
  const now = 1_800_000_000, f = poolFixture(now), input = { owner, action: 'buy', scope: 3, mask: '8', quantity: '1000000', slippageBps: 50 };
  f.options.allowance = 1_000_000n;
  await assert.rejects(f.service.prepare({ ...input, event: 0 }), /^Error: Invalid action$/);
  await assert.rejects(f.service.prepare(null as never), /^Error: Invalid action$/);
  for (const action of ['sell', 'redeem', 'assertOutcome', 'finalize']) await assert.rejects(f.service.prepare({ ...input, action }), /^Error: Unsupported action$/);
  await assert.rejects(f.service.prepare({ ...input, slippageBps: 25 }), /^Error: Choose a supported slippage limit$/);
  for (const quantity of ['0', '100000001']) await assert.rejects(f.service.prepare({ ...input, quantity }), /^Error: Unsupported claim or quantity$/);
  await assert.rejects(f.service.prepare({ ...input, scope: 4, mask: '2' }), /^Error: Unsupported claim or quantity$/);
  for (const bad of ['0x' + '00'.repeat(20), 'not-a-wallet']) await assert.rejects(f.service.prepare({ ...input, owner: bad }), /^Error: Invalid wallet$/);
  await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: reads(f, { balanceOf: 1n }), now: () => now }).prepare(input), /^Error: Not enough test AUSD in this wallet$/);
  f.options.failSimulation = true; await assert.rejects(f.service.prepare(input), /Simulation rejected/); f.options.failSimulation = false;
  const fees = (gas: string, price: string) => async (method: string, params: any[] = []) => method === 'eth_estimateGas' ? gas : method === 'eth_gasPrice' ? price : f.rpc(method, params);
  await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: fees('0x' + 12_500_001n.toString(16), '0x3b9aca00'), now: () => now }).prepare(input), /^Error: Gas exceeds policy$/);
  await assert.rejects(hybridPoolService({ manifest: f.manifest, rpc: fees('0x186a0', '0x' + 500_000_000_001n.toString(16)), now: () => now }).prepare(input), /^Error: Gas exceeds policy$/);
});

test('a combination the pool cannot price is refused with the reason, and the semantic check is informational', async () => {
  const now = 1_800_000_000, f = poolFixture(now, 4);
  f.options.allowance = 10_000_000n; f.options.factors = [2, 1, 3, 5, 7].map(scope => ({ scope, values: [0n] }));
  await assert.rejects(f.service.prepare({ owner, action: 'buy', scope: 9, mask: '8', quantity: '1000000', slippageBps: 50 }),
    (error: any) => error.status === 409 && error.message === COMBINATION_LIMIT_MESSAGE);
  const fits = await f.service.prepare({ owner, action: 'buy', scope: 12, mask: '8', quantity: '1000000', slippageBps: 50 });
  assert.equal(fits.action, 'buy'); assert.ok(fits.semanticAssessment);
  loadSemanticConfig({ FLURBO_SEMANTIC_MODE: 'enforce', FLURBO_SEMANTIC_RULES_JSON: JSON.stringify({ schema: 'flurbo.semantic-rules.v1', markets: [{ pool, rulesHash: 'invalid', predicates: [] }] }) });
  try {
    const unchecked = await f.service.prepare({ owner, action: 'buy', scope: 12, mask: '8', quantity: '1000000', slippageBps: 50 });
    assert.equal(unchecked.semanticAssessment, null);
  } finally { loadSemanticConfig({}); }
});

test('the action policy allows only bounded pool trades and an exact cash approval to the pool', () => {
  const { manifest } = poolFixture(), other = '0x' + '99'.repeat(20);
  const buy = (args: readonly unknown[]) => encodeFunctionData({ abi: pilotPoolAbi, functionName: 'buy', args: args as never });
  const trade = buy([3, 8n, 1_000_000n, 251_250n, 1_800_000_300n]);
  assert.equal(pilotCall({ to: pool, data: trade, manifest })?.name, 'buy');
  assert.equal(pilotCall({ to: getAddress(pool), data: trade, manifest })?.name, 'buy');
  for (const to of [resolver, other, pilotCash]) assert.equal(pilotCall({ to, data: trade, manifest }), null);
  assert.equal(pilotCall({ to: pool, data: trade + '00', manifest }), null);
  for (const args of [[4, 2n, 1_000_000n, 1n, 1n], [3, 8n, 0n, 1n, 1n], [3, 8n, 100_000_001n, 1n, 1n], [3, 8n, 1_000_000n, 100_000_001n, 1n]])
    assert.equal(pilotCall({ to: pool, data: buy(args), manifest }), null);
  const approve = (spender: string, amount: bigint) => encodeFunctionData({ abi: pilotCashAbi, functionName: 'approve', args: [spender as `0x${string}`, amount] });
  assert.equal(pilotCall({ to: pilotCash, data: approve(pool, 100_000_000n), manifest })?.name, 'approve');
  for (const data of [approve(pool, 100_000_001n), approve(resolver, 1n), approve(other, 1n)]) assert.equal(pilotCall({ to: pilotCash, data, manifest }), null);
  // Settlement runs through the hybrid resolver's own flow; no resolver call is an agent action.
  const settlement = parseAbi(['function assertOutcome(uint8,uint8,bytes32,string)', 'function finalize(uint8)', 'function deliver()', 'function withdrawBond()']);
  for (const [functionName, args] of [['assertOutcome', [0, 1, hash, 'https://flurbo.singu.online/api/pilot/evidence/0x' + 'ab'.repeat(32)]], ['finalize', [0]], ['deliver', []], ['withdrawBond', []]] as const)
    assert.equal(pilotCall({ to: resolver, data: encodeFunctionData({ abi: settlement, functionName, args: args as never }), manifest }), null, functionName);
});

test('a reviewed buy is checked against the request and tracked before the wallet sends it', async t => {
  const f = poolFixture(); f.options.allowance = 1_000_000n;
  const review = await f.service.prepare({ owner, action: 'buy', scope: 3, mask: '8', quantity: '1000000', slippageBps: 50 });
  validatePilotReview(review);
  assert.throws(() => validatePilotReview({ ...review, amountAtoms: '1' }), /limit/);
  t.mock.method(globalThis, 'fetch', async () => Response.json(review.semanticAssessment));
  let saved: any = null, sends = 0;
  const provider = { request: async ({ method, params = [] }: any) => {
    if (method === 'eth_accounts') return [owner];
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (method === 'eth_getTransactionCount') return 121;
    if (method === 'eth_sendTransaction') { assert.equal(saved.hash, null); assert.equal(params[0].nonce, '0x79'); sends++; return hash; }
    return f.rpc(method, params);
  } };
  await submitPilot(provider, review, owner, value => { saved = value; }, () => true, { namespace: f.namespace });
  assert.equal(sends, 1); assert.equal(saved.hash, hash);
  await assert.rejects(submitPilot(provider, review, owner, () => { throw new Error('storage unavailable'); }, () => true, { namespace: f.namespace })); assert.equal(sends, 1);
  assert.throws(() => validatePilotReview({ ...review, requested: { ...review.requested, quantity: '2000000' } }));
  assert.throws(() => validatePilotReview(review, (review.expiresAt + 1) * 1000));
  assert.throws(() => rpcInteger(Number.MAX_SAFE_INTEGER + 1));
});

test('positions read holdings and payouts in one verified snapshot, batched or not', async () => {
  const now = 1_800_000_000, f = poolFixture(now, 3), claims = [{ scope: 1, mask: '1' }, { scope: 3, mask: '8' }];
  const open = await f.service.positions(owner, claims);
  assert.deepEqual(open.rows, claims.map(c => ({ ...c, quantity: '1000000', payoutAtoms: null })));
  assert.deepEqual(open.snapshot, { blockNumber: '100', blockHash: hash, timestamp: now }); assert.equal(open.owner, owner);
  f.options.resolved = true;
  const settled = reads(f, { payoutFraction: [1n, 4n] });
  const plain = await hybridPoolService({ manifest: f.manifest, rpc: settled, now: () => now }).positions(owner, claims);
  assert.deepEqual(plain.rows, claims.map(c => ({ ...c, quantity: '1000000', payoutAtoms: '250000' })));
  const { rpc, batches } = batched(settled);
  const batch = await hybridPoolService({ manifest: f.manifest, rpc, now: () => now }).positions(owner, claims);
  assert.deepEqual(batch.rows, plain.rows); assert.deepEqual(batches, [2, 2]);
  await assert.rejects(f.service.positions(owner, Array.from({ length: 61 }, () => claims[0])), /^Error: Use pages of at most sixty claims$/);
  await assert.rejects(f.service.positions(owner, [{ scope: 8, mask: '1' }]), /^Error: Unsupported claim$/);
  await assert.rejects(f.service.positions('0x1234', claims), /^Error: Invalid wallet$/);
});

test('agent pools: 2 to 32 question pools are served, analytics only up to 4, unreadable anchors stay pending and are retried', async () => {
  const addr = (d: string) => '0x' + d.repeat(40);
  const records = [hybridRecord({ count: 2, pool: addr('a'), resolver: addr('b') }), hybridRecord({ count: 4, pool: addr('c'), resolver: addr('d') }),
    hybridRecord({ count: 16, pool: addr('e'), resolver: addr('f') })];
  (records[0] as any).keeper = addr('8'); (records[1] as any).answerer = addr('9');
  const catalog = { schema: 'flurbo.hybrid-catalog.v1', pools: records };
  const history = { refresh: async () => ({}) }, payouts = { refresh: async () => ({}) };
  const indexes = new Map([[addr('a'), { history, payouts }]]);
  const logs: string[] = [];
  let failing = true;
  const readAnchor = async ({ record }: any) => {
    if (failing && record.pool === addr('c')) throw Error('upstream said secret-token-123');
    return anchorFor(record);
  };
  const pools = await hybridAgentPools({ catalog, rpc: async () => { throw Error('no chain'); }, indexes, readAnchor, log: (line: string) => { logs.push(line); } });
  assert.deepEqual([...pools.services.keys()], [agentNamespace(addr('a')), agentNamespace(addr('e'))]);
  assert.deepEqual(pools.collections, [{ namespace: agentNamespace(addr('a')), label: 'Explicit test fixtures', pool: addr('a'), closesAt: records[0].prepared.draft.closesAt },
    { namespace: agentNamespace(addr('e')), label: 'Explicit test fixtures', pool: addr('e'), closesAt: records[2].prepared.draft.closesAt }]);
  const wide: any = pools.services.get(agentNamespace(addr('e')));
  assert.equal(wide.analytics, undefined); assert.equal(wide.claimAnalytics, undefined);
  const served: any = pools.services.get(agentNamespace(addr('a')));
  assert.equal(served.index, history); assert.equal(served.payouts, payouts);
  assert.equal(typeof served.analytics, 'function'); assert.equal(typeof served.claimAnalytics, 'function');
  assert.equal(served.manifest.publication.mode, 'hybrid-v4');
  assert.deepEqual(logs, [JSON.stringify({ status: 'agent_pool_unavailable', pool: addr('c') })]);
  assert.equal(pools.pending(), 1);
  assert.equal(await pools.refresh(), 'added 0, pending 1'); assert.equal(logs.length, 1);
  failing = false;
  const collections = pools.collections, services = pools.services;
  assert.equal(await pools.refresh(), 'added 1, pending 0');
  assert.equal(pools.collections, collections); assert.equal(pools.services, services);
  assert.deepEqual([...pools.services.keys()], [agentNamespace(addr('a')), agentNamespace(addr('e')), agentNamespace(addr('c'))]);
  assert.equal(pools.collections[2].namespace, agentNamespace(addr('c')));
  assert.equal(typeof (pools.services.get(agentNamespace(addr('c'))) as any).analytics, 'function');
  assert.equal((pools.services.get(agentNamespace(addr('c'))) as any).index, undefined);
  assert.equal(pools.pending(), 0); assert.equal(await pools.refresh(), 'idle');
  const reserved = new Set([addr('a'), addr('b'), addr('c'), addr('d'), addr('e'), addr('f'), account('1'), account('2'), account('3'), account('6'), account('7'), addr('8'), addr('9')]);
  assert.deepEqual(pools.reservedAddresses, reserved);
  const plain = await hybridAgentPools({ catalog, rpc: async () => { throw Error('no chain'); }, readAnchor: async ({ record }: any) => anchorFor(record), analytics: false });
  assert.equal((plain.services.get(agentNamespace(addr('a'))) as any).analytics, undefined);
  await assert.rejects(hybridAgentPools({ catalog: { schema: 'flurbo.hybrid-catalog.v1', pools: [{ ...records[0], rulesHash: rules }] }, rpc: async () => null }), /commitment/);
});

test('v5 manifests carry the pricing model, initial depth, commission and rate', () => {
  const record: any = hybridRecord({ count: 3, commissionBps: 500 });
  const manifest: any = hybridPoolManifest(record, anchorFor(record));
  assert.equal(manifest.publication.mode, 'hybrid-v4');
  assert.deepEqual(manifest.publication.pricing, { model: 'ls-lmsr.v1', initialDepthAtoms: '10000000', commissionBps: 500,
    depthRateWad: depthRateWad(3, 500).toString() });
  assert.equal(manifest.publication.pricing.depthRateWad, '24044917348149390');
  const fixed: any = hybridPoolManifest(hybridRecord({ count: 3 }), anchorFor(record));
  assert.equal('pricing' in fixed.publication, false);
  const { pricing, ...rest } = manifest.publication;
  assert.deepEqual(Object.keys(rest), Object.keys(fixed.publication));
  assert.doesNotThrow(() => hybridPoolService({ manifest: hybridPoolManifest(hybridRecord({ commissionBps: 500 }),
    anchorFor(hybridRecord({ commissionBps: 500 }))), rpc: async () => null }));
});

test('the service refuses a manifest with an invalid pricing block', () => {
  const record: any = hybridRecord({ commissionBps: 500 });
  const manifest: any = hybridPoolManifest(record, anchorFor(record));
  const bad = (change: (p: any) => void) => {
    const m = structuredClone(manifest); change(m.publication.pricing); return () => hybridPoolService({ manifest: m, rpc: async () => null });
  };
  assert.doesNotThrow(bad(() => {}));
  for (const change of [
    (p: any) => { p.model = 'lmsr.v1'; }, (p: any) => { p.initialDepthAtoms = '0'; }, (p: any) => { p.initialDepthAtoms = 10000000; },
    (p: any) => { p.commissionBps = 99; }, (p: any) => { p.commissionBps = 2001; }, (p: any) => { p.commissionBps = '500'; },
    (p: any) => { p.depthRateWad = '1'; }, (p: any) => { p.depthRateWad = depthRateWad(3, 500).toString(); },
  ]) assert.throws(bad(change), /^Error: Verified hybrid pool manifest required$/);
  const m = structuredClone(manifest); m.publication.pricing = null;
  assert.throws(() => hybridPoolService({ manifest: m, rpc: async () => null }), /^Error: Verified hybrid pool manifest required$/);
});

test('a 16 question pool quotes every question and reviews a buy on event 15', async () => {
  const now = 1_800_000_000, f = poolFixture(now, 16);
  const markets = await f.service.markets();
  assert.equal(markets.prices.length, 16);
  assert.deepEqual(markets.prices.map((p: any) => p.event), Array.from({ length: 16 }, (_, i) => i));
  const review = await f.service.prepare({ owner, action: 'buy', scope: 2 ** 15, mask: '2', quantity: '1000000', slippageBps: 50 });
  assert.equal(review.action, 'approve');
  f.options.allowance = 1_000_000n;
  const buy = await f.service.prepare({ owner, action: 'buy', scope: 2 ** 15, mask: '2', quantity: '1000000', slippageBps: 50 });
  const call = decodeFunctionData({ abi: pilotPoolAbi, data: buy.transaction.data });
  assert.equal(call.functionName, 'buy'); assert.equal(call.args[0], 32768); assert.equal(call.args[1], 2n);
  assert.equal(buy.semanticAssessment.mode, 'disabled');
});
