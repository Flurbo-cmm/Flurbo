import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amount, describeClaim } from '../src/portfolio.ts';

test('portfolio labels reproduce AND, OR, NO and custom truth tables without conflating claims', () => {
  assert.equal(describeClaim(3, 8), 'A YES AND B YES');
  assert.equal(describeClaim(3, 14), 'A YES OR B YES');
  assert.equal(describeClaim(128, 1), 'H NO');
  assert.equal(describeClaim(7, 128), 'A YES AND B YES AND C YES');
  assert.equal(describeClaim(3, 6), 'Exactly one of: A YES / B YES');
  assert.equal(amount('12345678901234567890'), '12,345,678,901,234.56789');
  assert.equal(amount('0'), '0');
});
