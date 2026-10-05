import { test } from 'node:test';
import assert from 'node:assert/strict';
import { klerosDisputeReport } from '../scripts/inspect-kleros-dispute.mjs';
import { SEPOLIA_KLEROS } from '../server/oracle-integration.mjs';

const COURT = '0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879';
const juror = '0x1111111111111111111111111111111111111111';
const questionId = `0x${'a'.repeat(64)}`;

function client(status: number) {
  const voters = ['0x2222222222222222222222222222222222222222', juror];
  return {
    getBlock: async () => ({ timestamp: 2000n }),
    readContract: async ({ functionName, args = [] }: any) => ({
      arbitrationRequests: [BigInt(status), juror, 7n, 0n], arbitrator: COURT, arbitratorExtraData: '0x',
      getMultipliers: [3000n, 7000n, 5000n, 10000n],
      disputes: [0n, SEPOLIA_KLEROS, 2n ** 256n - 1n, 2n, 1000n, 2n, 0n, false],
      getDispute: [[2n], [0n], [0n], [0n], [0n], [0n]],
      getSubcourt: [[], [30n, 600n, 600n, 600n]], currentRuling: 0n,
      getVote: [voters[Number(args[2])], zero, 0n, false],
    } as Record<string, unknown>)[functionName],
  };
}
const zero = `0x${'0'.repeat(64)}`;

test('klerosDisputeReport lists the juror vote IDs and the castVote command', async () => {
  const report = await klerosDisputeReport(client(1), { questionId, juror });
  assert.equal(report.status, 'disputed');
  assert.equal(report.disputeId, '7');
  assert.equal(report.period, 'Vote');
  assert.deepEqual(report.voteIds, [1]);
  assert.deepEqual(report.choices, { No: 1, Yes: 2, Void: 0 });
  assert.ok(report.castVoteCommand.includes('castVote(uint256,uint256[],uint256,uint256)'));
  assert.ok(report.castVoteCommand.includes("'[1]'"));
  assert.ok(report.castVoteCommand.includes(COURT));
});

test('klerosDisputeReport reports a question without a dispute', async () => {
  assert.deepEqual(await klerosDisputeReport(client(0), { questionId, juror }), { status: 'none' });
});
