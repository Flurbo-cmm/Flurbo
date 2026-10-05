import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData } from 'viem';
import { hybridRealityAction, hybridRealityAppealAction, hybridRealityClaimAction, hybridRealityReportAction, hybridRealitySnapshot } from '../server/hybrid-reality.mjs';
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
    { pendingArbitration: true, disputeStatus: 2, questionId,
      historyHash: last, bondWei: '100000000000000', arbitrator: SEPOLIA_KLEROS });
  assert.equal(decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data }).functionName, 'reportAnswer');
  await assert.rejects(() => hybridRealityReportAction(source,
    { source: { ...event.source, questionTxHash: `0x${'5'.repeat(64)}` } }, owner,
    { pendingArbitration: true, disputeStatus: 2, questionId,
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

test('appeal requires a Disputed request', async () => {
  const source = { readContract: async ({ functionName }: { functionName: string }) =>
    functionName === 'arbitrator' ? `0x${'9'.repeat(40)}` : [2000n, 2600n],
  simulateContract: async () => ({}) };
  const state = { pendingArbitration: true, sourceNow: 2100, disputeId: '4', questionId,
    arbitrator: SEPOLIA_KLEROS };
  const plan = await hybridRealityAppealAction(source, 'appeal', { ruling: 1, amountEth: '0.01' },
    owner, { ...state, disputeStatus: 1 });
  assert.equal(decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data }).functionName, 'fundAppeal');
  await assert.rejects(() => hybridRealityAppealAction(source, 'appeal', { ruling: 1, amountEth: '0.01' },
    owner, { ...state, disputeStatus: 2 }), /No appealable Kleros dispute/);
});

test('snapshot exposes court state and links for a disputed question', async () => {
  const table: Record<string, unknown> = { ...answers, isPendingArbitration: true, getBond: 200000000000000n,
    arbitrationRequests: [1n, owner, 7n, 0n], arbitrator: SEPOLIA_KLEROS, arbitratorExtraData: '0x',
    getMultipliers: [3000n, 7000n, 5000n, 10000n],
    disputes: [0n, SEPOLIA_KLEROS, 2n ** 256n - 1n, 3n, 1000n, 1n, 0n, false],
    getDispute: [[1n], [0n], [0n], [1n], [0n], [0n]], getSubcourt: [[], [30n, 600n, 600n, 600n]],
    currentRuling: 2n, appealPeriod: [1000n, 1600n], appealCost: 10n ** 16n };
  const source = { getChainId: async () => 11155111, getBlock: async () => ({ timestamp: 1100n }),
    readContract: async ({ functionName }: { functionName: string }) => table[functionName] };
  const state = await hybridRealitySnapshot(source, { ...event, source: { ...event.source,
    questionTxHash: `0x${'5'.repeat(64)}` } }, owner);
  assert.equal(state.court.periodLabel, 'Appeal');
  assert.equal(state.court.appeal.loserEnd, 1300);
  assert.equal(state.court.appeal.winnerTotalWei, (10n ** 16n + 10n ** 16n * 3000n / 10000n).toString());
  assert.equal(state.court.currentRuling, 2);
  assert.ok(state.links.reality.includes(`${SEPOLIA_REALITY.toLowerCase()}-`));
  assert.ok(state.links.questionTx.endsWith(`0x${'5'.repeat(64)}`));
  assert.equal(state.links.courtContract?.toLowerCase(), `https://sepolia.etherscan.io/address/${SEPOLIA_KLEROS}#events`);
  const calm = await hybridRealitySnapshot({ ...source, readContract: async (call: { functionName: string }) =>
    call.functionName === 'arbitrationRequests' ? [0n, owner, 0n, 0n] : table[call.functionName] }, event, owner);
  assert.equal(calm.court, null);
  assert.equal(calm.links.courtContract, null);
});
