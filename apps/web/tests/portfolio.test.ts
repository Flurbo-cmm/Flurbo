import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amount, describeClaim, describeClaimAnswers } from '../src/portfolio.ts';

test('portfolio labels reproduce AND, OR, NO and custom truth tables without conflating claims', () => {
  assert.equal(describeClaim(3, 8), 'A YES AND B YES');
  assert.equal(describeClaim(3, 14), 'A YES OR B YES');
  assert.equal(describeClaim(128, 1), 'H NO');
  assert.equal(describeClaim(7, 128), 'A YES AND B YES AND C YES');
  assert.equal(describeClaim(3, 6), 'Exactly one of: A YES / B YES');
  assert.equal(amount('12345678901234567890'), '12,345,678,901,234.56789');
  assert.equal(amount('0'), '0');
});

test('claims on question nine and beyond are described', () => {
  assert.equal(describeClaimAnswers(2 ** 9, 2), 'Yes');
  assert.equal(describeClaimAnswers(2 ** 31, 1), 'No');
  assert.equal(describeClaim(2 ** 9 + 1, 8), 'A YES AND J YES');
  assert.match(describeClaimAnswers(2 ** 4 + 2 ** 5, 6), /^Exactly one of:/);
});
