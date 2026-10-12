import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ATOM_TO_WAD, depthRateWad, depthWad, lsAnalyticsState } from '../shared/ls-lmsr.mjs';
import { runPairModel } from '../server/pair-analytics.mjs';
import { certifiedPair, pairInput } from '../server/pair-math.mjs';
import { simulatePairPurchase } from '../server/pair-sensitivity.mjs';
import { rustExample } from './rust-example.ts';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/ls-lmsr.json', import.meta.url), 'utf8'));
const wad = (factors: { scope: number; values: string[] }[]) =>
  factors.map(f => ({ scope: f.scope, values: f.values.map(v => BigInt(v) * ATOM_TO_WAD) }));

test('depth rate and depth match the contract formula', () => {
  assert.equal(depthRateWad(2, 500), 36067376022224085n);
  for (const row of fixtures.rates) assert.equal(depthRateWad(row.events, row.commissionBps), BigInt(row.rateWad));
  for (const row of fixtures.depths) {
    const rate = depthRateWad(row.events, row.commissionBps);
    assert.equal(depthWad(BigInt(row.initialDepthAtoms) * ATOM_TO_WAD, rate, wad(row.factors)), BigInt(row.depthWad));
  }
  assert.equal(depthWad(10n ** 19n, depthRateWad(2, 500), [{ scope: 1, values: ['0', String(10n ** 18n)] }]),
    10018033688011112042n);
});

test('commission and event count outside the contract range fail closed', () => {
  for (const [events, bps] of [[2, 99], [2, 2001], [2, 1.5], [0, 500], [33, 500]])
    assert.throws(() => depthRateWad(events, bps));
  assert.throws(() => depthWad(0n, 1n, [{ scope: 15, values: Array(16).fill('0') }]));
  assert.throws(() => depthWad(0n, 1n, [{ scope: 3, values: ['0', '0'] }]));
});

test('LS analytics state is the WAD-unit fixed-depth state at the current depth', () => {
  for (const row of fixtures.probabilities) {
    const result = lsAnalyticsState(row.input);
    assert.deepEqual(result.state, row.state, row.name);
    assert.equal(result.depthWad, BigInt(row.state.liquidity), row.name);
    assert.equal(result.rateWad, depthRateWad(row.input.events, row.input.commissionBps), row.name);
    assert.deepEqual(certifiedPair(row.state).values, row.displayed, row.name);
  }
});

test('Rust elimination agrees with the Decimal LS fixtures', async () => {
  for (const row of fixtures.probabilities) {
    const result = await runPairModel(pairInput(row.state), { file: rustExample('pair_analytics') });
    for (const [key, expected] of Object.entries(row.precise))
      assert.ok(Math.abs(result[key] - Number(expected)) < 2e-13, `${row.name} ${key}`);
  }
});

test('one-share LS sensitivity recomputes depth after the trade', () => {
  const input = fixtures.probabilities.find((row: any) => row.name === 'ls-positive-relationship').input;
  const { state } = lsAnalyticsState(input);
  const ls = { initialDepthWad: BigInt(input.initialDepthAtoms) * ATOM_TO_WAD, rateWad: depthRateWad(input.events, input.commissionBps) };
  for (const answer of ['yes', 'no']) {
    const result = simulatePairPurchase(state, answer, ls);
    assert.equal(result.quantity, '1000000');
    assert.equal(result.after.liquidity, depthWad(ls.initialDepthWad, ls.rateWad, result.after.factors).toString());
    assert.ok(BigInt(result.after.liquidity) > BigInt(state.liquidity));
    const merged = result.after.factors.find((f: any) => f.scope === 3);
    const added = merged.values.map((v: string, i: number) => BigInt(v) - BigInt(state.factors[0].values[i]));
    assert.deepEqual(added, [0n, 1n, 2n, 3n].map(i => i === (answer === 'yes' ? 3n : 2n) ? 10n ** 18n : 0n));
  }
  assert.throws(() => simulatePairPurchase({ ...state, liquidity: String(10n ** 18n - 1n) }, 'yes', ls), /quantity limit/);
  const unchanged = simulatePairPurchase({ events: 2, a: 0, b: 1, liquidity: '10000000', order: [0, 1], factors: [] }, 'yes');
  assert.equal(unchanged.after.liquidity, '10000000');
  assert.deepEqual(unchanged.after.factors, [{ scope: 3, values: ['0', '0', '0', '1000000'] }]);
});
