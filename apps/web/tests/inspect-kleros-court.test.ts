import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem';
import { klerosJurorReadiness, sortitionRootSlot } from '../scripts/inspect-kleros-court.mjs';
import { SEPOLIA_KLEROS_LIQUID, SEPOLIA_KLEROS_SUBCOURT3, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

const juror = '0x1111111111111111111111111111111111111111';

function client(overrides: Record<string, unknown> = {}, total = 10n ** 22n, chain = 11155111) {
  const table: Record<string, unknown> = { realitio: SEPOLIA_REALITY, arbitrator: SEPOLIA_KLEROS_LIQUID,
    arbitratorExtraData: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [3n, 1n]),
    courts: [0n, false, 7400n * 10n ** 18n, 5000n, 2n * 10n ** 16n, 31n],
    stakeOf: 10n ** 22n, jurors: [10n ** 22n, 0n], phase: 2, nextDelayedSetStake: 313n,
    lastDelayedSetStake: 312n, getDisputeFee: 2n * 10n ** 16n, ...overrides };
  return { getChainId: async () => chain, getBytecode: async () => '0x6080',
    getStorageAt: async () => toHex(total, { size: 32 }),
    readContract: async ({ functionName }: any) => table[functionName] };
}
const options = { proxy: SEPOLIA_KLEROS_SUBCOURT3, juror, proxyCodeHash: keccak256('0x6080') };

test('sortition root slots match the live KlerosLiquid layout', () => {
  assert.equal(sortitionRootSlot(0), '0x0e00535308cbf9a7d3380dbed4f223ab4613c58b4b02f94266d197f9c5f3dec2');
  assert.equal(sortitionRootSlot(3n), '0xf574df558a4ef90b0f9140707b04d8bd5a2b90f8b0e4dd892b3084d5906c37fa');
});

test('a sole staker at or above the minimum is ready', async () => {
  const report = await klerosJurorReadiness(client(), options);
  assert.equal(report.ready, true);
  assert.equal(report.sharePercent, '100.00');
  assert.equal(report.subcourtId, 3);
  assert.equal(report.feeWei, '20000000000000000');
  assert.equal(report.delayedStakesPending, false);
});

test('another staker or a stake below the minimum is not ready', async () => {
  const crowded = await klerosJurorReadiness(client({}, 122n * 10n ** 21n), options);
  assert.equal(crowded.ready, false);
  assert.equal(crowded.sharePercent, '8.19');
  const small = await klerosJurorReadiness(client({ stakeOf: 5n * 10n ** 21n, jurors: [5n * 10n ** 21n, 0n] },
    5n * 10n ** 21n), options);
  assert.equal(small.ready, false);
});

test('wrong chain is refused', async () => {
  await assert.rejects(() => klerosJurorReadiness(client({}, 10n ** 22n, 1), options), /Sepolia RPC required/);
});
