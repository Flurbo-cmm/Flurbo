import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWide, scopeEvents, payoutFractionWide, CHAIN_ID } from '../src/index.ts';

const pool = '0x' + '22'.repeat(20);

test('SDK evaluates highest event bit and 32 VOID results without global enumeration', () => {
  const high = encodeWide(pool, 32, [{ event: 31, yes: true }], 'AND');
  assert.equal(high.scope, 2 ** 31);
  assert.deepEqual(scopeEvents(high.scope), [31]);
  const pair = encodeWide(pool, 32, [{ event: 0, yes: true }, { event: 31, yes: true }], 'OR');
  assert.equal(pair.scope, 2 ** 31 + 1);
  assert.deepEqual(payoutFractionWide(high, 32, { yesMask: 0, voidMask: 2 ** 32 - 1 }),
    { numerator: 2n ** 31n, denominator: 2n ** 32n });
  assert.deepEqual(payoutFractionWide({ chainId: CHAIN_ID, pool, scope: pair.scope, mask: pair.mask }, 32,
    { yesMask: 1, voidMask: 2 ** 32 - 2 }),
    { numerator: 2n ** 31n, denominator: 2n ** 31n });
});
