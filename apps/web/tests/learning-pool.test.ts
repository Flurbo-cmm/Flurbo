import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { decodeFunctionData, encodeFunctionResult, encodeFunctionData } from 'viem';
import { learningService, learningRpc, loadLearningModel, buildHostedProposal, validateLearningManifest,
  poolAbi, engineAbi, cashAbi } from '../server/learning-pool.mjs';

const deployment = JSON.parse(await readFile(new URL('../../../config/learning-testnet.json', import.meta.url), 'utf8'));
const timestamp = 1790250408;
const code = '0x6001';
const sha = createHash('sha256').update(Buffer.from('6001', 'hex')).digest('hex');
const bias = [{ scope: '1', values: ['0', '366667'] }, { scope: '2', values: ['0', '366667'] }, { scope: '3', values: ['0', '0', '0', '550000'] }];

function fixture() {
  const manifest = structuredClone(deployment);
  for (const entry of Object.values(manifest.runtime_evidence) as any[]) entry.runtime_sha256 = sha;
  const flags = { chain: '0x279f', code, reorg: false, changedRevision: false, allowance: 0n, balance: 20_000_000n,
    needed: 600_000n, spent: 0n, cooldown: false, failSimulation: false, expired: false };
  const calls: any[] = [];
  let clock = timestamp * 1000;
  const rpc = async (batch: any[]) => batch.map(([method, params]) => {
    calls.push([method, params]);
    if (method === 'eth_chainId') return flags.chain;
    if (method === 'eth_getCode') return flags.code;
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === '0x' + deployment.verified_block.toString(16)) return { hash: deployment.verified_block_hash };
      return { number: '0x3e441a3', timestamp: '0x' + (flags.expired ? timestamp - 1000 : timestamp).toString(16),
        hash: '0x' + (flags.reorg && params[0] !== 'latest' ? 'bb' : 'aa').repeat(32) };
    }
    assert.equal(method, 'eth_call', 'No signing or write RPC is permitted');
    const tx = params[0];
    const abi = tx.to === manifest.pool ? poolAbi : tx.to === manifest.cash ? cashAbi : engineAbi;
    const decoded = decodeFunctionData({ abi, data: tx.data });
    const name = decoded.functionName;
    let result: any;
    if (abi === poolAbi) result = ({ revision: params[1] === 'latest' && flags.changedRevision ? 1n : 0n,
      lastUpdateAt: BigInt(timestamp), updateCount: flags.cooldown ? 1n : 0n, fundingEpoch: BigInt(Math.floor(timestamp / 3600)),
      epochFundingSpent: flags.spent, pricingReserve: 55_451_775n, actualRequiredCollateral: 0n, funded: true,
      resolved: false, factors: [], biasFactors: [], quoteBuy: 259531n, updateBias: flags.needed } as any)[name];
    if (abi === cashAbi) result = name === 'balanceOf' ? String(decoded.args![0]).toLowerCase() === manifest.pool ? 55_451_775n : flags.balance : name === 'allowance' ? flags.allowance : true;
    if (abi === engineAbi) result = name === 'reserve' ? 55_451_775n + flags.needed : [{ collateral: 279999n, factorsAfter: [], maxLiabilityAfter: 1_000_000n }, 56_000_000n];
    if (flags.failSimulation && tx.from) throw new Error('simulation rejected');
    return encodeFunctionResult({ abi, functionName: name, result });
  });
  const builder = async (input: any) => ({ schema: 'flurbo.unsigned-learning-proposal.v1',
    proposal: { chainId: '10143', pool: manifest.pool, expectedRevision: input.snapshot.revision, deadline: input.deadline, maxFunding: input.maxFunding, bias },
    modelSha256: 'model', snapshotSha256: 'snapshot', diagnostics: { totalVariationUpperBound: '1/10000000', movementBoundAtoms: '1283334' } });
  const service = learningService({ manifest, rpc, builder, now: () => clock, modelReport: () => ({ model: { fixture: true } }) });
  return { service, rpc, flags, calls, advance: () => { clock += 16_000; } };
}

test('pinned pool status is cached briefly and has separate identity', async () => {
  const { service, calls } = fixture();
  const state = await service.status(); const count = calls.length;
  assert.equal(state.pool, deployment.pool); assert.equal(state.covered, true); assert.equal(state.open, true);
  assert.equal(state.revision, '0'); assert.equal(state.changesExecutablePrices, false);
  await service.status(); assert.equal(calls.length, count);
  for (const [method, params] of calls) if (method === 'eth_call' || method === 'eth_getCode') assert.equal(params.at(-1), '0x3e441a3');
});

test('approval plan does not claim the update has been simulated or sent', async () => {
  const { service } = fixture(); const review = await service.prepare();
  assert.equal(review.action, 'approval_required'); assert.equal(review.updateSimulated, false);
  assert.equal(review.fundingAtoms, '600000'); assert.equal(review.proposal.maxFunding, '600000');
  assert.equal(review.unsignedNextTransaction.to, deployment.cash);
  assert.equal(review.unsignedNextTransaction.data, encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [deployment.pool, 600000n] }));
  assert.equal(review.quoteBeforeAtoms, '259531'); assert.equal(review.quoteAfterAtoms, '279999');
  await assert.rejects(service.prepare(), /Wait before/);
});

test('sufficient allowance enables exact update simulation with matching revision and funding', async () => {
  const { service, flags, calls } = fixture(); flags.allowance = 600_000n;
  const review = await service.prepare(); assert.equal(review.action, 'update_simulated');
  assert.equal(review.updateSimulated, true); assert.equal(review.unsignedNextTransaction.to, deployment.pool);
  const update = decodeFunctionData({ abi: poolAbi, data: review.unsignedUpdateData });
  assert.equal((update.args![0] as any).expectedRevision, 0n);
  assert.equal((update.args![0] as any).maxFunding, 600_000n);
  assert.ok(calls.every(([method]) => !method.includes('send')));
});

test('chain, code, reorg, stale revision, balance, cap, cooldown and simulation failures reject preparation', async () => {
  for (const [key, value] of Object.entries({ chain: '0x1', code: '0x6002', reorg: true, changedRevision: true,
    balance: 0n, needed: 1_000_001n, spent: 9_500_000n, cooldown: true, failSimulation: true, expired: true })) {
    const { service, flags } = fixture(); (flags as any)[key] = value;
    await assert.rejects(service.prepare(), undefined, key);
  }
});

test('manifest cannot substitute the active market, authority, collateral or missing runtime evidence', () => {
  for (const [key, value] of Object.entries({ pool: '0x' + '11'.repeat(20), updater: deployment.cash, cash: deployment.pool,
    chain_id: 143, event_count: 2, max_bias_movement_atoms: 20_000_000, status: 'verified_snapshot', runtime_evidence: {} })) {
    assert.throws(() => validateLearningManifest({ ...deployment, [key]: value }), key);
  }
});

test('RPC adapter rejects write methods, duplicate IDs and cross-network endpoints', async () => {
  assert.throws(() => learningRpc('http://127.0.0.1:18545'));
  assert.throws(() => learningRpc('https://rpc.monad.xyz'));
  let fetches = 0;
  const rpc = learningRpc('https://testnet-rpc.monad.xyz', async (_url: string, options: any) => {
    fetches++; const batch = JSON.parse(options.body);
    return Response.json(batch.map(() => ({ jsonrpc: '2.0', id: batch[0].id, result: '0x279f' })));
  });
  await assert.rejects(rpc([['eth_sendTransaction', []]])); assert.equal(fetches, 0);
  await assert.rejects(rpc([['eth_chainId', []], ['eth_chainId', []]]), /Invalid RPC batch/);
});

test('actual Rust fixture and Python quantizer produce a bounded eight-event proposal', {
  skip: !process.env.FLURBO_TEST_LEARNING_BINARY || !process.env.FLURBO_TEST_PYTHON,
}, async () => {
  const report = await loadLearningModel(process.env.FLURBO_TEST_LEARNING_BINARY);
  assert.equal(report.model.events, 8);
  const snapshot = { schema: 'flurbo.funded-snapshot.v1', chainId: '10143', pool: deployment.pool,
    events: 8, decimals: 6, liquidity: '10000000', order: [0,1,2,3,4,5,6,7], factors: [], biasFactors: [],
    revision: '0', maxBiasMovement: '2000000', timestamp: String(timestamp), closesAt: String(timestamp + 86400),
    blockNumber: '65287411', blockHash: '0x' + 'aa'.repeat(32) };
  const result = await buildHostedProposal({ model: report.model, snapshot, maxFunding: '1000000', deadline: String(timestamp + 300) }, process.env.FLURBO_TEST_PYTHON);
  assert.equal(result.proposal.bias.length, 3);
  assert.ok(BigInt(result.diagnostics.movementBoundAtoms) <= 2_000_000n);
  assert.equal(result.diagnostics.impliedDistribution.length, 256);
  await assert.rejects(buildHostedProposal({ model: report.model, snapshot: { ...snapshot, maxBiasMovement: '1' }, maxFunding: '1000000', deadline: String(timestamp + 300) }, process.env.FLURBO_TEST_PYTHON));
});
