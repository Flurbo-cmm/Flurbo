import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaim, quantityAtoms } from './market-model.ts';
test('AND and OR keep event order and answer truth tables', () => {
  assert.deepEqual(makeClaim({ 3: false, 0: true }, 'all'), { scope: 9, mask: '2', events: [0, 3] });
  assert.equal(makeClaim({ 0: true, 1: true }, 'all').mask, '8');
  assert.equal(makeClaim({ 0: true, 1: true }, 'any').mask, '14');
  assert.throws(() => makeClaim({}, 'all'));
  assert.throws(() => makeClaim({ 0: true, 1: true, 2: true, 3: true }, 'all'));
});
test('amounts are exact and never round the requested size', () => {
  assert.equal(quantityAtoms('10.000001'), '10000001');
  for (const value of ['0', '-1', 'NaN', '1e3', '0.0000001', '01', '']) assert.throws(() => quantityAtoms(value));
});
