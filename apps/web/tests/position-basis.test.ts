import assert from 'node:assert/strict';
import test from 'node:test';
import { sellOutcome } from '../src/position-basis.ts';
import { positionKey, type TradeActivity } from '../src/portfolio-performance.ts';

const pool = '0x' + '44'.repeat(20), owner = '0x' + '11'.repeat(20);
let index = 0;
const trade = (action: TradeActivity['action'], quantity: bigint, cash: bigint, scope = 1, mask = '2'): TradeActivity =>
  ({ namespace: 'hybrid-' + pool, pool, owner, scope, mask, quantity, cash, action, hash: '0x' + String(index).padStart(64, '0'), index: index++, block: 100 + index });
const key = (scope = 1, mask = '2') => positionKey(pool, owner, scope, mask);

test('a full sale compares proceeds with everything paid', () => {
  assert.deepEqual(sellOutcome([trade('Buy', 5_000_000n, 2_800_000n)], key(), 5_000_000n, 3_000_000n),
    { paid: 2_800_000n, proceeds: 3_000_000n, difference: 200_000n });
});

test('a partial sale uses the average cost', () => {
  const trades = [trade('Buy', 2_000_000n, 1_000_000n), trade('Buy', 2_000_000n, 1_400_000n)];
  assert.deepEqual(sellOutcome(trades, key(), 1_000_000n, 500_000n), { paid: 600_000n, proceeds: 500_000n, difference: -100_000n });
});

test('earlier sales leave the remaining cost to the remaining shares', () => {
  const trades = [trade('Buy', 4_000_000n, 2_000_000n), trade('Sell', 2_000_000n, 1_500_000n)];
  assert.deepEqual(sellOutcome(trades, key(), 2_000_000n, 900_000n), { paid: 1_000_000n, proceeds: 900_000n, difference: -100_000n });
});

test('returns null when the history holds fewer shares than are being sold', () => {
  assert.equal(sellOutcome([trade('Buy', 1_000_000n, 500_000n)], key(), 2_000_000n, 900_000n), null);
  assert.equal(sellOutcome([], key(), 1_000_000n, 500_000n), null);
});

test('returns null when the history disagrees with the shares held now', () => {
  const trades = [trade('Buy', 3_000_000n, 1_500_000n)];
  assert.notEqual(sellOutcome(trades, key(), 1_000_000n, 600_000n, 3_000_000n), null);
  assert.equal(sellOutcome(trades, key(), 1_000_000n, 600_000n, 4_000_000n), null);
});

test('combined claims use their own key', () => {
  const trades = [trade('Buy', 1_000_000n, 300_000n, 3, '8'), trade('Buy', 1_000_000n, 900_000n, 1, '2')];
  assert.equal(sellOutcome(trades, key(3, '8'), 1_000_000n, 400_000n)!.paid, 300_000n);
  assert.equal(sellOutcome(trades, key(1, '2'), 1_000_000n, 400_000n)!.paid, 900_000n);
});

test('difference is exactly proceeds minus paid with no rounding drift', () => {
  const trades = [trade('Buy', 3n, 10n)];
  const result = sellOutcome(trades, key(), 1n, 4n)!;
  assert.equal(result.paid, 3n);
  assert.equal(result.difference, result.proceeds - result.paid);
  assert.equal(Object.is(Number(result.difference), -0), false);
});
