import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseComparison, runComparison, SCENARIOS, MODELS } from '../server/learning-comparison.mjs';

function fixture() {
  const rows = ['scenario,seed,step,model,mse_all_claims,kl_joint,p_ab,p_abc'];
  for (const scenario of SCENARIOS) for (const seed of [7, 19, 41]) for (let step = 0; step <= 4000; step += 100) for (const model of MODELS) {
    rows.push(`${scenario},${seed},${step},${model},${(seed / 1000 + step / 1e6).toFixed(10)},0.2000000000,0.3000000000,0.2000000000`);
  }
  return rows.join('\n') + '\n';
}
test('comparison aggregates every scenario, seed and model without claiming live execution', () => {
  const report = parseComparison(fixture());
  assert.equal(report.observations, 2460); assert.equal(report.summaries.length, 20);
  assert.equal(report.input, 'synthetic'); assert.equal(report.changesExecutablePrices, false);
  assert.equal(report.outputSha256.length, 64);
  for (const row of report.summaries) {
    assert.ok(Math.abs(row.initialMse - 67 / 3000) < 1e-10);
    assert.ok(Math.abs(row.finalMse - (67 / 3000 + .004)) < 1e-10);
    assert.equal(row.finalMseMin, .011); assert.equal(row.finalMseMax, .045);
  }
});
test('partial, duplicated, reordered, nonfinite and incoherent results are rejected', () => {
  const valid = fixture(), rows = valid.trim().split('\n');
  for (const invalid of [rows.slice(0, -1).join('\n'), valid + rows[1],
    [rows[0], rows[2], rows[1], ...rows.slice(3)].join('\n'),
    valid.replace('0.0070000000', 'NaN'), valid.replace('0.0070000000', '-0.1000000000'),
    valid.replace('0.3000000000,0.2000000000', '0.3000000000,0.9000000000'),
    valid.replace('higher_order,7,0', 'stationary,7,0'), 'x'.repeat(512_001)]) assert.throws(() => parseComparison(invalid));
});
test('a missing Rust executable rejects rather than supplying invented results', async () => {
  await assert.rejects(runComparison({binary: 'missing-flurbo-comparison-executable'}));
});
test('actual Rust release executable produces the complete report', {skip: !process.env.FLURBO_TEST_RUST_BINARY}, async () => {
  const report = await runComparison({binary: process.env.FLURBO_TEST_RUST_BINARY, commit: 'a'.repeat(40)});
  assert.equal(report.observations, 2460); assert.equal(report.summaries.length, 20);
  assert.equal(report.sourceCommit, 'a'.repeat(40)); assert.match(report.binarySha256, /^[0-9a-f]{64}$/);
  assert.ok(report.summaries.some((row: {scenario: string}) => row.scenario === 'higher_order'));
});
