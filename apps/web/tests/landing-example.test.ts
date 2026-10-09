import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { EXAMPLE, conditionalA, jointCells } from '../src/landing/example-market.ts';

test('the example is a coherent joint distribution', () => {
  assert.ok(EXAMPLE.pAB <= Math.min(EXAMPLE.pA, EXAMPLE.pB));
  assert.ok(EXAMPLE.pAB >= EXAMPLE.pA + EXAMPLE.pB - 1);
  const cells = jointCells();
  assert.ok(Math.abs(cells.yy + cells.yn + cells.ny + cells.nn - 1) < 1e-9);
  assert.ok([cells.yy, cells.yn, cells.ny, cells.nn].every(v => v >= 0));
  assert.ok(Math.abs(cells.yy - 0.22) < 1e-9 && Math.abs(cells.yn - 0.18) < 1e-9 && Math.abs(cells.ny - 0.08) < 1e-9 && Math.abs(cells.nn - 0.52) < 1e-9);
});

test('assuming B changes the chance of A', () => {
  assert.equal(conditionalA('none'), 0.40);
  assert.ok(Math.abs(conditionalA('yes') - 22 / 30) < 1e-12);
  assert.ok(Math.abs(conditionalA('no') - 18 / 70) < 1e-12);
  assert.equal((conditionalA('yes') * 100).toFixed(1), '73.3');
  assert.equal((conditionalA('no') * 100).toFixed(1), '25.7');
});

test('the proof links point at the live hybrid-reality-2 pool and its Reality.eth question', async () => {
  const registry = JSON.parse(await readFile(new URL('../../../config/hybrid-markets.json', import.meta.url), 'utf8'));
  const pool = registry.pools.find((p: any) => p.id === 'hybrid-reality-2');
  assert.ok(pool);
  assert.equal(EXAMPLE.proofPool, pool.pool);
  assert.equal(EXAMPLE.proofQuestionTx, pool.prepared.draft.events[0].source.questionTxHash);
});
