import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { formatUnits } from 'viem';
import { CONDITIONAL_COPY, chanceText, decisionView, holdingLine, pairable, payoffRows } from '../src/conditional-view.ts';
import { COMBINATION_LIMIT_MESSAGE } from '../shared/pilot.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/conditionals.json', import.meta.url), 'utf8'));
const five = fixtures.find((r: any) => r.name === 'state_five_b_given_a');
const condition = { eventIndex: 0, side: 'yes' as const }, target = { eventIndex: 1, side: 'yes' as const };

test('payoffRows gives the three outcomes with amounts and the Void line', () => {
  const view = payoffRows({ condition, target, shares: BigInt(five.shares), payAtoms: BigInt(five.priceAtoms) });
  assert.deepEqual(view.rows.map(row => row.key), ['both', 'conditionOnly', 'refund']);
  assert.deepEqual(view.rows.map(row => row.atoms), [5_000_000n, 0n, BigInt(five.priceAtoms)]);
  assert.deepEqual(view.rows.map(row => row.amount), ['5 test AUSD', '0 test AUSD', `${formatUnits(BigInt(five.priceAtoms), 6)} test AUSD`]);
  assert.equal(view.rows[2].amount, '3.652518 test AUSD');
  assert.deepEqual(view.rows.map(row => row.when), ['Q1 is Yes and Q2 is Yes', 'Q1 is Yes and Q2 is No', 'Q1 is No']);
  assert.deepEqual(view.rows.map(row => row.verb), ['Pays', 'Pays', 'Refunds']);
  assert.equal(view.voidLine, 'If a question is Void, the payout averages its two answers, as for every Flurbo prediction.');
  const no = payoffRows({ condition: { eventIndex: 2, side: 'no' }, target: { eventIndex: 0, side: 'no' }, shares: 2_000_000n, payAtoms: 1_500_000n });
  assert.deepEqual(no.rows.map(row => row.when), ['Q3 is No and Q1 is No', 'Q3 is No and Q1 is Yes', 'Q3 is Yes']);
});

test('decisionView pairs the condition chance with both conditional chances', () => {
  const view = decisionView({ condition: { eventIndex: 0, side: 'yes' }, target, values: { condition: 754, target: 608, given: 643, givenNot: 500 }, reasons: {} });
  assert.equal(view.condition.label, 'Chance Q1 is Yes');
  assert.equal(view.condition.value, '75.4%');
  assert.deepEqual(view.branches.map(b => [b.side, b.label, b.value, b.then]), [['yes', 'If Yes', '64.3%', 'Q2 is Yes'], ['no', 'If No', '50.0%', 'Q2 is Yes']]);
  assert.equal(view.gap, 'The pool puts Q2 Yes 14.3 points higher if Q1 is Yes than if it is No.');
  assert.deepEqual(view.branches.map(b => b.selected), [true, false]);
  const flipped = decisionView({ condition: { eventIndex: 0, side: 'no' }, target, values: { condition: 246, target: 608, given: 500, givenNot: 643 }, reasons: {} });
  assert.equal(flipped.condition.label, 'Chance Q1 is No');
  assert.equal(flipped.condition.value, '24.6%');
  assert.deepEqual(flipped.branches.map(b => b.value), ['64.3%', '50.0%']);
  assert.deepEqual(flipped.branches.map(b => b.selected), [false, true]);
  assert.equal(flipped.gap, view.gap);
  const lower = decisionView({ condition: { eventIndex: 0, side: 'yes' }, target, values: { condition: 500, target: 400, given: 300, givenNot: 500 }, reasons: {} });
  assert.equal(lower.gap, 'The pool puts Q2 Yes 20.0 points lower if Q1 is Yes than if it is No.');
  const same = decisionView({ condition: { eventIndex: 0, side: 'yes' }, target, values: { condition: 500, target: 500, given: 500, givenNot: 500 }, reasons: {} });
  assert.equal(same.gap, 'The pool gives Q2 Yes the same chance either way.');
});

test('decisionView shows Not available for a null value with its reason', () => {
  const view = decisionView({ condition, target, values: { condition: 0, target: 608, given: null, givenNot: 500 },
    reasons: { given: 'rare_condition' } });
  assert.equal(view.branches[0].value, 'Not available');
  assert.equal(view.branches[0].reason, CONDITIONAL_COPY.rareCondition);
  assert.equal(view.gap, null);
  const rounding = decisionView({ condition, target, values: { condition: null, target: 608, given: 643, givenNot: null },
    reasons: { condition: 'rounding_uncertain', givenNot: 'rounding_uncertain' } });
  assert.equal(rounding.condition.value, 'Not available');
  assert.equal(rounding.condition.reason, CONDITIONAL_COPY.roundingUncertain);
  assert.equal(rounding.branches[1].reason, CONDITIONAL_COPY.roundingUncertain);
  assert.equal(chanceText(null), 'Not available');
  assert.equal(chanceText(1000), '100.0%');
  assert.equal(chanceText(0), '0.0%');
});

test('pairable marks questions that cannot pair with the combination limit message', () => {
  const questions = [{ eventIndex: 0, question: 'A', pairable: [1] }, { eventIndex: 1, question: 'B', pairable: [0, 2] },
    { eventIndex: 2, question: 'C', pairable: [1] }];
  assert.deepEqual(pairable(questions, 0), [{ eventIndex: 1, question: 'B', disabled: false, note: null },
    { eventIndex: 2, question: 'C', disabled: true, note: COMBINATION_LIMIT_MESSAGE }]);
  assert.deepEqual(pairable(questions, 1).map(q => q.disabled), [false, false]);
  assert.deepEqual(pairable(questions, null), []);
});

test('holdingLine describes a held conditional in plain words', () => {
  assert.equal(holdingLine({ condition: { rule: 'AND', legs: [{ event: 0, yes: true }] }, target: { rule: 'AND', legs: [{ event: 1, yes: true }] } }),
    'If Q1 is Yes, then Q2 is Yes');
  assert.equal(holdingLine({ condition: { rule: 'AND', legs: [{ event: 0, yes: true }, { event: 2, yes: false }] }, target: { rule: 'OR', legs: [{ event: 1, yes: true }, { event: 3, yes: true }] } }),
    'If Q1 is Yes and Q3 is No, then Q2 is Yes or Q4 is Yes');
  assert.equal(holdingLine({ condition: null, target: null }), 'A conditional prediction in this pool');
});

test('the copy has no em dashes and none of the build terms of docs-content.test.ts', () => {
  const texts = [...Object.values(CONDITIONAL_COPY),
    ...payoffRows({ condition, target, shares: 1_000_000n, payAtoms: 600_000n }).rows.flatMap(row => [row.when, row.amount, row.verb]),
    payoffRows({ condition, target, shares: 1_000_000n, payAtoms: 600_000n }).voidLine,
    decisionView({ condition, target, values: { condition: 754, target: 608, given: 643, givenNot: 500 }, reasons: {} }).gap!];
  const terms = [/LMSR/i, /logarithmic/i, /scoring rule/i, /variable elimination/i, /factor(?:ed|s)\b/i, /induced width/i,
    /elimination order/i, /cost function/i, /truth table/i, /bitmap/i, /\bRedis\b/i, /Upstash/i, /\bRender\b/, /worker/i, /keeper/i, /litepaper/i];
  const banned = [/\bbet/i, /wager/i, /\bodds\b/i, /jackpot/i, /gambl/i, /parlay/i];
  for (const text of texts) {
    assert.doesNotMatch(text, /[\u2014\u2013]/, text);
    assert.doesNotMatch(text, /!/, text);
    for (const term of [...terms, ...banned]) assert.doesNotMatch(text, term, text);
  }
  assert.ok(CONDITIONAL_COPY.spread.includes('Conditionals on unlikely conditions cost more above the pool\'s chance.'));
});
