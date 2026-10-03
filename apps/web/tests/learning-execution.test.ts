import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { submitLearning, validateReview, matchReceipt, checkLearningReceipt, readPending, pendingKey, type Pending, type Review } from '../src/learning/execution.ts';
import { poolAbi, cashAbi, learningDeployment as deployment } from '../shared/learning-contracts.mjs';

const hash = '0x' + 'aa'.repeat(32), blockHash = '0x' + 'bb'.repeat(32);
const now = 1790250408000;
const code = '0x6001';
// Unit provider has explicit fixture runtime evidence; no RPC or wallet is contacted.
for (const evidence of Object.values(deployment.runtime_evidence)) evidence.runtime_sha256 = createHash('sha256').update(Buffer.from('6001', 'hex')).digest('hex');
function fixture(approval = false, generatedAt = now) {
  const p = { chainId: '10143', pool: deployment.pool, expectedRevision: '0', deadline: String(Math.floor(generatedAt / 1000) + 300), maxFunding: '515545',
    bias: [{ scope: '1', values: ['0', '366667'] }, { scope: '2', values: ['0', '366667'] }, { scope: '3', values: ['0', '0', '0', '550000'] }] };
  const encoded = { ...p, chainId: 10143n, expectedRevision: 0n, deadline: BigInt(p.deadline), maxFunding: 515545n,
    bias: p.bias.map(f => ({ scope: Number(f.scope), values: f.values.map(BigInt) })) };
  const update = encodeFunctionData({ abi: poolAbi, functionName: 'updateBias', args: [encoded] });
  const review: Review = { schema: 'flurbo.learning-review.v1', action: approval ? 'approval_required' : 'update_simulated', updateSimulated: !approval,
    expiresAt: Number(p.deadline), generatedAt: new Date(generatedAt).toISOString(), fundingAtoms: '515545', reserveAfterAtoms: '55967320',
    movementAtoms: '1283334', quoteBeforeAtoms: '259531', quoteAfterAtoms: '279955', modelSha256: 'fixture', snapshotSha256: 'fixture', quantizationBound: 'fixture',
    snapshot: { chainId: '10143', pool: deployment.pool, blockNumber: '65289000', blockHash, timestamp: String(Math.floor(generatedAt / 1000)), revision: '0' },
    proposal: p, unsignedUpdateData: update, unsignedNextTransaction: { chainId: 10143, from: deployment.updater,
      to: approval ? deployment.cash : deployment.pool, value: '0x0', data: approval ? encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [deployment.pool, 515545n] }) : update }, notice: 'fixture' };
  const pending: Pending = { version: 1, review, nonce: '0x4', hash, startedAt: now };
  return { review, pending };
}
function wallet(review: Review) {
  const calls: any[] = [];
  const flags = { chain: '0x279f', account: deployment.updater, code, anchor: deployment.verified_block_hash,
    revision: 0n, simulation: 515545n, gas: '0x100000', balance: '0xde0b6b3a7640000', reject: false, ambiguous: false };
  return { flags, calls, provider: { async request({ method, params = [] }: { method: string; params?: any[] }) {
    calls.push([method, params]);
    if (method === 'eth_chainId') return flags.chain;
    if (method === 'eth_accounts') return [flags.account];
    if (method === 'eth_getCode') return flags.code;
    if (method === 'eth_getBlockByNumber') return { hash: params[0] === '0x' + deployment.verified_block.toString(16) ? flags.anchor : blockHash,
      timestamp: '0x' + Math.floor(now / 1000).toString(16) };
    if (method === 'eth_call') {
      const abi = params[0].to === deployment.pool ? poolAbi : cashAbi;
      const call = decodeFunctionData({ abi, data: params[0].data });
      return encodeFunctionResult({ abi, functionName: call.functionName, result: call.functionName === 'revision' ? flags.revision : call.functionName === 'approve' ? true : flags.simulation });
    }
    if (method === 'eth_estimateGas') return flags.gas;
    if (method === 'eth_gasPrice') return '0x17d78400';
    if (method === 'eth_getBalance') return flags.balance;
    if (method === 'eth_getTransactionCount') return '0x4';
    assert.equal(method, 'eth_sendTransaction');
    assert.equal(params[0].data, review.unsignedNextTransaction.data);
    if (flags.reject) throw { code: 4001 };
    if (flags.ambiguous) throw Error('Transport lost after send');
    return hash;
  } } };
}

test('each confirmation sends only its reviewed action and persists tracking before the wallet prompt', async () => {
  for (const approval of [true, false]) {
    const { review } = fixture(approval); const w = wallet(review);
    const saved: (Pending | null)[] = []; let authorized = 0;
    await submitLearning(w.provider, review, { authorize: async () => { authorized++; }, current: () => true, now: () => now,
      save: value => { if (!saved.length) assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 0); saved.push(value); } });
    assert.equal(authorized, 2); assert.equal(saved[0]!.hash, null); assert.equal(saved[1]!.hash, hash);
    assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 1);
  }
});
test('wrong account, network, runtime, revision, funding and gas fail before signing', async () => {
  for (const [key, value] of Object.entries({ chain: '0x1', account: deployment.cash, code: '0x6002', anchor: hash,
    revision: 1n, simulation: 515546n, gas: '0xffffff', balance: '0x0' })) {
    const { review } = fixture(); const w = wallet(review); (w.flags as any)[key] = value;
    await assert.rejects(submitLearning(w.provider, review, { authorize: async () => {}, current: () => true, save: () => assert.fail('must not persist before validation'), now: () => now }), undefined, key);
    assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 0);
  }
});
test('numeric pending nonces are preserved exactly as hex for tracking and wallet submission', async () => {
  for (const approval of [true, false]) for (const nonce of [0, 121, Number.MAX_SAFE_INTEGER]) {
    const { review } = fixture(approval); const w = wallet(review);
    const provider = { request: (input: any) => input.method === 'eth_getTransactionCount' ? Promise.resolve(nonce) : w.provider.request(input) };
    const saved: (Pending | null)[] = [];
    await submitLearning(provider, review, { authorize: async () => {}, current: () => true, now: () => now, save: value => saved.push(value) });
    const expected = '0x' + BigInt(nonce).toString(16);
    assert.equal(saved[0]!.nonce, expected); assert.equal(saved[1]!.nonce, expected);
    const sends = w.calls.filter(c => c[0] === 'eth_sendTransaction');
    assert.equal(sends.length, 1); assert.equal(sends[0][1][0].nonce, expected);
  }
});
test('invalid and unsafe pending nonces stop before tracking or signing', async () => {
  for (const nonce of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined, true, {}, '121', '0x', '0x' + 'f'.repeat(65)]) {
    const { review } = fixture(); const w = wallet(review);
    const provider = { request: (input: any) => input.method === 'eth_getTransactionCount' ? Promise.resolve(nonce) : w.provider.request(input) };
    await assert.rejects(submitLearning(provider, review, { authorize: async () => {}, current: () => true, now: () => now,
      save: () => assert.fail('invalid nonce must not create pending tracking') }), /invalid pending nonce/);
    assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 0);
  }
});
test('malformed wallet quantities identify the failed read without exposing provider data or sending', async () => {
  for (const [method, label] of [
    ['eth_chainId', 'chain ID'], ['eth_getBlockByNumber', 'latest block timestamp'],
    ['eth_estimateGas', 'gas estimate'], ['eth_gasPrice', 'gas price'],
    ['eth_getBalance', 'MON balance'], ['eth_getTransactionCount', 'pending nonce'],
  ]) {
    const { review } = fixture(); const w = wallet(review);
    const provider = { async request(input: any) {
      if (input.method === method && method !== 'eth_getBlockByNumber') return { privateProviderDetail: 'must never be displayed' };
      if (method === 'eth_getBlockByNumber' && input.method === method && input.params[0] === 'latest') return null;
      return w.provider.request(input);
    } };
    await assert.rejects(submitLearning(provider, review, { authorize: async () => {}, current: () => true,
      save: () => assert.fail('must not save'), now: () => now }), (error: Error) => {
      assert.ok(error.message.includes(label)); assert.ok(!error.message.includes('privateProviderDetail')); return true;
    });
    assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 0);
  }
});
test('logout, UI invalidation and unavailable storage prevent signing', async () => {
  for (const failure of ['auth', 'generation', 'storage']) {
    const { review } = fixture(); const w = wallet(review);
    await assert.rejects(submitLearning(w.provider, review, { authorize: async () => { if (failure === 'auth') throw Error('expired session'); },
      current: () => failure !== 'generation', save: () => { throw Error('storage blocked'); }, now: () => now }));
    assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 0);
  }
});
test('rejected prompt clears tracking but ambiguous submission stays locked for recovery', async () => {
  for (const key of ['reject', 'ambiguous'] as const) {
    const { review } = fixture(); const w = wallet(review); w.flags[key] = true;
    const saved: (Pending | null)[] = [];
    await assert.rejects(submitLearning(w.provider, review, { authorize: async () => {}, current: () => true, save: value => saved.push(value), now: () => now }));
    assert.equal(w.calls.filter(c => c[0] === 'eth_sendTransaction').length, 1);
    if (key === 'reject') assert.equal(saved.at(-1), null); else assert.equal(saved.at(-1)!.hash, null);
  }
});
test('expiry, substituted calldata, unlimited approval, changed proposal and wrong domain are rejected', () => {
  const mutators = [ (r: Review) => r.expiresAt--, (r: Review) => r.proposal.chainId = '143',
    (r: Review) => r.unsignedNextTransaction.to = deployment.cash, (r: Review) => r.proposal.maxFunding = '999999999999999999',
    (r: Review) => r.proposal.bias[0].values[1] = '366668', (r: Review) => r.snapshot.revision = '1' ];
  for (const mutate of mutators) { const { review } = fixture(); mutate(review); assert.throws(() => validateReview(review, now)); }
  assert.throws(() => validateReview(fixture().review, now + 301000));
});

function receiptFixture(approval = false) {
  const { pending } = fixture(approval); const plan = validateReview(pending.review, now);
  const topics = encodeEventTopics({ abi: approval ? cashAbi : poolAbi, eventName: approval ? 'Approval' : 'BiasUpdated',
    args: approval ? { owner: deployment.updater, spender: deployment.pool } : { revision: 1n, proposalHash: plan.proposalHash } });
  const data = encodeAbiParameters(approval ? [{ type: 'uint256' }] : [{ type: 'uint128' }, { type: 'uint128' }], approval ? [515545n] : [515545n, 55967320n]);
  const tx = { hash, from: deployment.updater, to: plan.to, input: plan.data, value: '0x0' as Hex, nonce: '0x4' as Hex, chainId: '0x279f' as Hex, blockHash, blockNumber: '0x100' as Hex };
  const receipt = { transactionHash: hash, from: deployment.updater, to: plan.to, status: '0x1' as Hex, blockHash, blockNumber: '0x100' as Hex,
    logs: [{ address: plan.to, topics: topics as [Hex, ...Hex[]], data }] };
  return { pending, tx, receipt, canonical: { hash: blockHash } };
}
test('approval and update confirmation require exact calldata, matching event and two canonical blocks', () => {
  for (const approval of [true, false]) {
    const f = receiptFixture(approval);
    assert.equal(matchReceipt(f.pending, f.tx, f.receipt, f.canonical, '0x100'), 'confirming');
    assert.equal(matchReceipt(f.pending, f.tx, f.receipt, f.canonical, '0x101'), 'confirmed');
    assert.equal(matchReceipt(f.pending, f.tx, { ...f.receipt, status: '0x0', logs: [] }, f.canonical, '0x101'), 'reverted');
    for (const wrong of [{ ...f.tx, from: deployment.cash }, { ...f.tx, nonce: '0x5' as Hex }, { ...f.tx, input: '0x' }, { ...f.tx, value: '0x1' as Hex }])
      assert.throws(() => matchReceipt(f.pending, wrong, f.receipt, f.canonical, '0x101'));
    assert.throws(() => matchReceipt(f.pending, f.tx, f.receipt, { hash }, '0x101'));
    assert.throws(() => matchReceipt(f.pending, f.tx, { ...f.receipt, logs: [] }, f.canonical, '0x101'));
  }
  const f = receiptFixture(); f.receipt.logs[0].topics[2] = hash as Hex;
  assert.throws(() => matchReceipt(f.pending, f.tx, f.receipt, f.canonical, '0x101'));
});
test('post-receipt reorg never reports confirmation and missing receipts stay pending', async () => {
  for (const missing of [true, false]) {
    const f = receiptFixture(); let reads = 0;
    const provider = { async request({ method, params }: any) {
      if (method === 'eth_chainId') return '0x279f';
      if (method === 'eth_getBlockByNumber') return params[0] !== '0x100' ? { hash: deployment.verified_block_hash } : { hash: ++reads > 1 ? hash : blockHash };
      if (method === 'eth_getTransactionByHash') return f.tx;
      if (method === 'eth_getTransactionReceipt') return missing ? null : f.receipt;
      if (method === 'eth_blockNumber') return '0x101';
      assert.fail(method);
    } };
    if (missing) assert.equal(await checkLearningReceipt(provider, f.pending), 'pending');
    else await assert.rejects(checkLearningReceipt(provider, f.pending), /reorg/);
  }
});
test('reload restores public tracking even after review expiry and rejects corrupted records', () => {
  const { pending } = fixture(false, now - 600_000); const raw = JSON.stringify(pending);
  assert.throws(() => validateReview(pending.review, now), /expired/);
  assert.deepEqual(readPending({ getItem: key => { assert.equal(key, pendingKey); return raw; } }), pending);
  assert.equal(readPending({ getItem: () => null }), null);
  assert.throws(() => readPending({ getItem: () => '{bad json' }));
  assert.throws(() => readPending({ getItem: () => JSON.stringify({ ...pending, hash: 'not a hash' }) }));
});
