import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineLegs, rankShifts, scenarioHeading, shiftText } from '../src/what-if-model.ts';
import { legsToCombo } from '../src/combo-picker-model.ts';
import type { WhatIf, WhatIfLeg } from '../src/what-if-client.ts';

const base = (questions: { eventIndex: number; yes: number | null; givenYes: number | null; assumed?: boolean }[], given: WhatIfLeg[], reasons = {}): WhatIf => ({
  schema: 'flurbo.hybrid-what-if.v1', pool: '0x' + '44'.repeat(20), blockNumber: '1', blockHash: '0x' + '9'.repeat(64), observedAt: 1, closed: false,
  unit: 'tenths_of_percentage_point', given, givenChance: 500, claim: null, reasons,
  questions: questions.map(q => ({ assumed: false, ...q })) });
const yes = (eventIndex: number): WhatIfLeg => ({ eventIndex, side: 'yes' });
const no = (eventIndex: number): WhatIfLeg => ({ eventIndex, side: 'no' });

test('rows exclude assumed questions and sort by the largest absolute shift, then by question number', () => {
  const result = base([
    { eventIndex: 0, yes: 612, givenYes: 1000, assumed: true }, { eventIndex: 1, yes: 540, givenYes: 711 },
    { eventIndex: 2, yes: 480, givenYes: 480 }, { eventIndex: 3, yes: 455, givenYes: 420 },
    { eventIndex: 4, yes: 501, givenYes: 536 }, { eventIndex: 5, yes: 377, givenYes: 349 }, { eventIndex: 6, yes: 420, givenYes: 420 },
  ], [yes(0)]);
  const { shown } = rankShifts(result, 10);
  assert.deepEqual(shown.map(row => row.eventIndex), [1, 3, 4, 5, 2, 6]);
  assert.deepEqual(shown[0], { eventIndex: 1, yes: 540, givenYes: 711, shift: 171 });
  assert.equal(shown.find(row => row.eventIndex === 5)!.shift, -28);
  assert.ok(shown.every(row => row.eventIndex !== 0));
  assert.equal(shiftText(171), '+17.1 pts');
  assert.equal(shiftText(-28), '-2.8 pts');
  assert.equal(shiftText(0), '0.0 pts');
});

test('a rare assumption gives no conditional rows and a reason', () => {
  const rare = base([{ eventIndex: 0, yes: 5, givenYes: null, assumed: true }, { eventIndex: 1, yes: 540, givenYes: null }, { eventIndex: 2, yes: 480, givenYes: null }],
    [yes(0)], { givenYes: 'rare_condition' });
  const ranked = rankShifts(rare);
  assert.deepEqual(ranked.shown, []);
  assert.deepEqual(ranked.more, []);
  assert.equal(ranked.rare, true);
  const partial = rankShifts(base([{ eventIndex: 1, yes: 540, givenYes: 600 }, { eventIndex: 2, yes: 480, givenYes: null }], [yes(0)]));
  assert.deepEqual(partial.shown.map(row => row.eventIndex), [1]);
  assert.equal(partial.rare, false);
  assert.deepEqual(rankShifts(base([], [])).shown, []);
});

test('the first five rows are shown and the rest stay behind All questions', () => {
  const many = base(Array.from({ length: 12 }, (_, i) => ({ eventIndex: i, yes: 500, givenYes: 500 + (i + 1) * 10 })), [yes(20)]);
  const { shown, more } = rankShifts(many);
  assert.equal(shown.length, 5);
  assert.equal(more.length, 7);
  assert.deepEqual(shown.map(row => row.eventIndex), [11, 10, 9, 8, 7]);
  assert.deepEqual(more.map(row => row.eventIndex), [6, 5, 4, 3, 2, 1, 0]);
  assert.equal(rankShifts(many, 3).shown.length, 3);
});

test('Combine builds the ticket legs from the assumptions and the chosen row, three at most', () => {
  assert.deepEqual(combineLegs([yes(0)], 4, 'yes'), [yes(0), yes(4)]);
  assert.deepEqual(combineLegs([no(0), yes(2)], 5, 'yes'), [no(0), yes(2), yes(5)]);
  assert.deepEqual(combineLegs([yes(0), yes(2)], 2, 'no'), [yes(0), yes(2)]);
  assert.deepEqual(combineLegs([yes(3), no(0), yes(2)], 5, 'yes', 0), [no(0), yes(2), yes(5)]);
  assert.deepEqual(combineLegs([yes(3), yes(2), yes(1)], 5, 'yes'), [yes(2), yes(1), yes(5)]);
  assert.deepEqual(combineLegs([yes(3), no(0), yes(2)], 5, 'yes').length, 3);
  assert.deepEqual(combineLegs([], 5, 'yes'), [yes(5)]);
  const others = [1, 2, 3, 4, 5].map(eventIndex => ({ id: `0xp-${eventIndex}`, eventIndex }));
  assert.deepEqual(legsToCombo([no(0), yes(2), yes(5)], 0, others),
    { side: 'no', combo: { extra1: '0xp-2', extra1Side: 'yes', extra2: '0xp-5', extra2Side: 'yes' } });
  assert.deepEqual(legsToCombo([yes(2), no(5)], 0, others),
    { side: 'yes', combo: { extra1: '0xp-2', extra1Side: 'yes', extra2: '0xp-5', extra2Side: 'no' } });
  assert.equal(scenarioHeading([yes(0)]), 'If Q1 is Yes');
  assert.equal(scenarioHeading([no(3), yes(0)]), 'If Q1 is Yes and Q4 is No');
  assert.equal(scenarioHeading([yes(0), no(2), yes(5)]), 'If Q1 is Yes, Q3 is No and Q6 is Yes');
});
