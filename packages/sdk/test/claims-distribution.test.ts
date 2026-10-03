import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allOf, anyOf, exactlyOne, atLeastTwo, describe, encode, assertClaim, assertSamePool, claimShape, paysIn, payoutFraction, winningCombinations, CHAIN_ID,
  jointFromPair, independentJoint, marginal, both, claimProbability, frechetBounds, assertJoint, parseDecimal, formatAtoms, parseAtoms, FlurboError } from '../src/index.ts';

const pool = '0x' + '22'.repeat(20), other = '0x' + '33'.repeat(20);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as FlurboError).code; } return 'no-error'; };

test('claim encoding matches the deployed contract (scope bits, ascending local states)', () => {
  // Handoff table: A Yes (1,2), A No (1,1), A Yes AND B Yes (3,8), A Yes OR B Yes (3,14).
  assert.deepEqual([allOf(pool, 4, [{ event: 0, yes: true }]).scope, allOf(pool, 4, [{ event: 0, yes: true }]).mask], [1, 2n]);
  assert.equal(allOf(pool, 4, [{ event: 0, yes: false }]).mask, 1n);
  const and = allOf(pool, 4, [{ event: 1, yes: true }, { event: 0, yes: true }]);
  assert.deepEqual([and.scope, and.mask, claimShape(and, 4)], [3, 8n, 'AND']);
  const or = anyOf(pool, 4, [{ event: 0, yes: true }, { event: 1, yes: true }]);
  assert.deepEqual([or.scope, or.mask, claimShape(or, 4)], [3, 14n, 'OR']);
  // Canonical rules beyond AND/OR come from the shared encoder: exactly one (XOR) is mask 6.
  const xor = exactlyOne(pool, 4, [{ event: 0, yes: true }, { event: 1, yes: true }]);
  assert.deepEqual([xor.scope, xor.mask, claimShape(xor, 4)], [3, 6n, 'EXACTLY_ONE']);
  const two = atLeastTwo(pool, 4, [{ event: 0, yes: true }, { event: 1, yes: true }, { event: 2, yes: true }]);
  assert.deepEqual([two.scope, two.mask], [7, 232n]);
  assert.deepEqual(describe(two, 4), { rule: 'AT_LEAST_TWO', legs: [{ event: 0, yes: true }, { event: 1, yes: true }, { event: 2, yes: true }] });
  assert.equal(describe({ ...xor, mask: 5n }, 4), null, 'masks without a named rule are never renamed');
  // Showcase: "A No AND D Yes" was scope 9 mask 4.
  const showcase = allOf(pool, 4, [{ event: 0, yes: false }, { event: 3, yes: true }]);
  assert.deepEqual([showcase.scope, showcase.mask], [9, 4n]);
  assert.deepEqual(winningCombinations(showcase, 4), [[{ event: 0, yes: false }, { event: 3, yes: true }]]);
  assert.equal(paysIn(showcase, 0b1000), true); assert.equal(paysIn(showcase, 0b1001), false);
});

test('unsupported and cross-pool claims are rejected', () => {
  assert.equal(code(() => assertClaim({ chainId: CHAIN_ID, pool, scope: 15, mask: 1n }, 4)), 'unsupported_claim');   // four events
  assert.equal(code(() => assertClaim({ chainId: CHAIN_ID, pool, scope: 3, mask: 0n }, 4)), 'unsupported_claim');    // never pays
  assert.equal(code(() => assertClaim({ chainId: CHAIN_ID, pool, scope: 3, mask: 15n }, 4)), 'unsupported_claim');   // always pays
  assert.equal(code(() => assertClaim({ chainId: CHAIN_ID, pool, scope: 16, mask: 1n }, 4)), 'unsupported_claim');   // no such event
  assert.equal(code(() => assertClaim({ chainId: 1, pool, scope: 1, mask: 1n }, 4)), 'unsupported_claim');
  assert.equal(code(() => allOf(pool, 4, [{ event: 0, yes: true }, { event: 0, yes: false }])), 'unsupported_claim');
  assert.equal(code(() => anyOf(pool, 4, [{ event: 0, yes: true }])), 'unsupported_claim');
  assert.equal(code(() => encode(pool, 4, [{ event: 0, yes: true }], 'AT_LEAST_TWO')), 'unsupported_claim');
  assert.equal(code(() => assertSamePool([allOf(pool, 4, [{ event: 0, yes: true }]), allOf(other, 4, [{ event: 0, yes: true }])])), 'cross_pool');
});

test('payout fractions follow the published VOID rules (September and Showcase settlements)', () => {
  const allVoid = { yesMask: 0, voidMask: 0b1111 };
  // September: all four events VOID. Fork-verified fractions 8/16, 8/16, 4/16, 2/16.
  const cases: [number, bigint, bigint][] = [[1, 2n, 8n], [2, 1n, 8n], [3, 8n, 4n], [14, 4n, 2n]];
  for (const [scope, mask, numerator] of cases) assert.deepEqual(payoutFraction({ chainId: CHAIN_ID, pool, scope, mask }, 4, allVoid), { numerator, denominator: 16n });
  // Showcase: A No, B C D Yes (yesMask 14). "A No AND D Yes" paid in full.
  assert.deepEqual(payoutFraction({ chainId: CHAIN_ID, pool, scope: 9, mask: 4n }, 4, { yesMask: 14, voidMask: 0 }), { numerator: 1n, denominator: 1n });
  assert.deepEqual(payoutFraction({ chainId: CHAIN_ID, pool, scope: 1, mask: 2n }, 4, { yesMask: 14, voidMask: 0 }), { numerator: 0n, denominator: 1n });
  assert.equal(code(() => payoutFraction({ chainId: CHAIN_ID, pool, scope: 1, mask: 2n }, 4, { yesMask: 1, voidMask: 1 })), 'invalid_input');
});

test('joint forecasts are exact, normalized and bounded by Fréchet limits', () => {
  const j = jointFromPair({ a: 1, b: 0, pA: 570_000n, pB: 620_000n, pBoth: 450_000n });
  assert.deepEqual(j.events, [0, 1]);
  assert.deepEqual(j.states, [260_000n, 170_000n, 120_000n, 450_000n]);
  assert.equal(marginal(j, 0), 620_000n); assert.equal(marginal(j, 1), 570_000n); assert.equal(both(j, 0, 1), 450_000n);
  assert.equal(claimProbability(j, anyOf(pool, 4, [{ event: 0, yes: true }, { event: 1, yes: true }])), 740_000n);
  assert.deepEqual(frechetBounds(700_000n, 600_000n), { low: 300_000n, high: 600_000n });
  assert.equal(code(() => jointFromPair({ a: 0, b: 1, pA: 700_000n, pB: 600_000n, pBoth: 299_999n })), 'invalid_forecast');
  assert.equal(code(() => jointFromPair({ a: 0, b: 1, pA: 700_000n, pB: 600_000n, pBoth: 600_001n })), 'invalid_forecast');
  assert.equal(code(() => assertJoint({ events: [0, 1], states: [1n, 1n, 1n, 1n] })), 'invalid_forecast');
  assert.equal(code(() => assertJoint({ events: [1, 0], states: [250_000n, 250_000n, 250_000n, 250_000n] })), 'invalid_forecast');
  // Property: every valid pair round-trips its marginals and joint exactly.
  let seed = 7;
  const rand = (max: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return BigInt(seed % (max + 1)); };
  for (let i = 0; i < 500; i++) {
    const pA = rand(1_000_000), pB = rand(1_000_000), { low, high } = frechetBounds(pA, pB), pBoth = low + rand(Number(high - low));
    const joint = jointFromPair({ a: 0, b: 2, pA, pB, pBoth });
    assert.deepEqual([marginal(joint, 0), marginal(joint, 2), both(joint, 0, 2)], [pA, pB, pBoth]);
  }
  const ind = independentJoint([2, 0, 1], [333_333n, 500_000n, 250_000n]);
  assert.equal(ind.states.reduce((a, b) => a + b, 0n), 1_000_000n);
  assert.deepEqual(ind.events, [0, 1, 2]);
});

test('atoms never pass through floating point', () => {
  assert.equal(parseDecimal('1.25'), 1_250_000n); assert.equal(parseDecimal('0.000001'), 1n);
  assert.equal(code(() => parseDecimal('0.0000001')), 'invalid_input'); assert.equal(code(() => parseDecimal('1e3')), 'invalid_input');
  assert.equal(formatAtoms(-1_500_000n), '-1.5'); assert.equal(formatAtoms(1n), '0.000001');
  assert.equal(code(() => parseAtoms(12 as unknown)), 'invalid_input'); assert.equal(code(() => parseAtoms('1.5')), 'invalid_input');
  assert.equal(parseAtoms('340282366920938463463374607431768211455'), (1n << 128n) - 1n);
  assert.equal(code(() => parseAtoms('340282366920938463463374607431768211456')), 'invalid_input');
});
