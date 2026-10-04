import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeClaim, validateClaim } from '../shared/claims.mjs';
import { combinationFits } from '../shared/pilot.mjs';

test('event 31 has an unsigned scope and keeps local claim masks', () => {
  const high = 2 ** 31;
  assert.deepEqual(encodeClaim({ events: 32, legs: [{ event: 31, yes: true }], rule: 'AND' }),
    { schema: 'flurbo.claim.v1', scope: high, mask: '2' });
  assert.deepEqual(validateClaim(high + 1, '8', 32), [0, 31]);
  assert.equal(combinationFits(32, Array.from({ length: 32 }, (_, i) => i), [], high + 1), true);
});
