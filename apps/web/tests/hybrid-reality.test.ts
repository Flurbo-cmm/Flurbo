import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData } from 'viem';
import { hybridRealityAction, hybridRealityClaimAction, hybridRealityReportAction, hybridRealitySnapshot } from '../server/hybrid-reality.mjs';
import { proxyAbi, realityAbi, SEPOLIA_KLEROS, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

const owner = '0x1111111111111111111111111111111111111111';
const questionId = `0x${'1'.repeat(64)}`;
const contentHash = `0x${'2'.repeat(64)}`;
const event = { observationEndsAt: 2000, source: { reality: SEPOLIA_REALITY,
  arbitrator: SEPOLIA_KLEROS, questionId, contentHash,
  minTimeout: 3600, minBond: '100000000000000' } };
const answers = {
  getContentHash: contentHash, getArbitrator: SEPOLIA_KLEROS, getOpeningTS: 2000n,
  getTimeout: 3600n, getMinBond: 100000000000000n, getBond: 0n,
  getFinalizeTS: 0n, getBestAnswer: `0x${'0'.repeat(64)}`,
  getHistoryHash: `0x${'3'.repeat(64)}`,
  isPendingArbitration: false, isFinalized: false,
  getDisputeFee: 500000000000000n, realitio: SEPOLIA_REALITY,
  arbitrationRequests: [0n, owner, 0n, 0n], balanceOf: 0n,
};

test('Reality source binding and Sepolia answer transaction', async () => {
  const source = { getChainId: async () => 11155111,
    getBlock: async () => ({ timestamp: 2100n }),
    readContract: async ({ functionName }: { functionName: keyof typeof answers }) => answers[functionName] };
  const state = await hybridRealitySnapshot(source, event, owner);
  assert.equal(state.nextBondWei, '100000000000000');
  const plan = hybridRealityAction('market', 'answer', { answer: 'yes', bondEth: '0.0001' }, owner, state);
  assert.equal(plan.transaction.chainId, 11155111);
  assert.equal(plan.transaction.value, '0x5af3107a4000');
  assert.equal(decodeFunctionData({ abi: realityAbi, data: plan.transaction.data }).functionName, 'submitAnswer');
  await assert.rejects(() => hybridRealitySnapshot({ ...source,
    readContract: async ({ functionName }: { functionName: keyof typeof answers }) =>
      functionName === 'getContentHash' ? `0x${'3'.repeat(64)}` : answers[functionName] }, event, owner),
  /published source/);
});

test('Kleros challenge is available only during the Reality answer window', () => {
  const state = { chainId: 11155111, reality: SEPOLIA_REALITY, arbitrator: SEPOLIA_KLEROS,
    questionId, sourceNow: 2100, opensAt: 2000, finalizesAt: 2500,
    bondWei: '100000000000000', nextBondWei: '200000000000000',
    disputeFeeWei: '500000000000000', pendingArbitration: false, finalized: false,
    creditedEthWei: '0' };
  const plan = hybridRealityAction('market', 'arbitrate', {}, owner, state);
  assert.equal(plan.transaction.to.toLowerCase(), SEPOLIA_KLEROS.toLowerCase());
  assert.equal(decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data }).functionName, 'requestArbitration');
  assert.throws(() => hybridRealityAction('market', 'arbitrate', {}, owner,
    { ...state, pendingArbitration: true }), /window closed/);
});

test('Kleros ruling report binds the last Reality answer history', async () => {
  const last = `0x${'4'.repeat(64)}`;
  const source = {
    getTransactionReceipt: async () => ({ status: 'success', to: SEPOLIA_REALITY, blockNumber: 100n }),
    getBlockNumber: async () => 110n,
    getLogs: async () => [{ args: { history_hash: last, answer: `0x${'0'.repeat(63)}1`,
      user: owner, bond: 100000000000000n } }],
    simulateContract: async () => ({}),
  };
  const plan = await hybridRealityReportAction(source,
    { source: { ...event.source, questionTxHash: `0x${'5'.repeat(64)}` } }, owner,
    { pendingArbitration: true, disputeStatus: 3, questionId,
      historyHash: last, bondWei: '100000000000000', arbitrator: SEPOLIA_KLEROS });
  assert.equal(decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data }).functionName, 'reportAnswer');
  await assert.rejects(() => hybridRealityReportAction(source,
    { source: { ...event.source, questionTxHash: `0x${'5'.repeat(64)}` } }, owner,
    { pendingArbitration: true, disputeStatus: 3, questionId,
      historyHash: `0x${'6'.repeat(64)}`, bondWei: '100000000000000', arbitrator: SEPOLIA_KLEROS }),
  /history mismatch/);
});

test('bond claim uses the verified answer history and requires an answer by the wallet', async () => {
  const first = `0x${'4'.repeat(64)}`, last = `0x${'5'.repeat(64)}`;
  const source = {
    getTransactionReceipt: async () => ({ status: 'success', to: SEPOLIA_REALITY, blockNumber: 100n }),
    getBlockNumber: async () => 110n,
    getLogs: async () => [
      { args: { history_hash: first, answer: `0x${'0'.repeat(64)}`, user: owner,
        bond: 100000000000000n } },
      { args: { history_hash: last, answer: `0x${'0'.repeat(63)}1`,
        user: '0x2222222222222222222222222222222222222222', bond: 200000000000000n } },
    ],
    simulateContract: async () => ({}),
  };
  const published = { source: { ...event.source, questionTxHash: `0x${'6'.repeat(64)}` } };
  const state = { finalized: true, historyHash: last, questionId, reality: SEPOLIA_REALITY };
  const plan = await hybridRealityClaimAction(source, published, owner, state);
  const decoded = decodeFunctionData({ abi: realityAbi, data: plan.transaction.data });
  assert.equal(decoded.functionName, 'claimWinnings');
  assert.deepEqual(decoded.args?.[1], [first, `0x${'0'.repeat(64)}`]);
  await assert.rejects(() => hybridRealityClaimAction(source, published,
    '0x3333333333333333333333333333333333333333', state), /did not post/);
});
