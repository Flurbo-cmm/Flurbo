import assert from 'node:assert/strict';
import test from 'node:test';
import { addExtra, availableToAdd, chosenChips, claimToCombo, legCount, readComboSearch, removeExtra, suggestedLinks, writeComboSearch,
  type ComboState } from '../src/combo-picker-model.ts';
import { encodeClaim } from '../shared/claims.mjs';

const others = ['rain', 'snow', 'wind', 'hail'].map(id => ({ id, question: `Will it ${id} on Saturday?` }));
const state = (change: Partial<ComboState> = {}): ComboState => ({ extra1: '', extra2: '', extra1Side: 'yes', extra2Side: 'yes', ...change });

test('chosenChips returns chips in selection order with their answers', () => {
  assert.deepEqual(chosenChips(others, state()), []);
  assert.deepEqual(chosenChips(others, state({ extra1: 'wind', extra1Side: 'no', extra2: 'rain' })),
    [{ id: 'wind', question: 'Will it wind on Saturday?', side: 'no', slot: 1 }, { id: 'rain', question: 'Will it rain on Saturday?', side: 'yes', slot: 2 }]);
});

test('chosenChips skips a chosen id that is not in the pool', () => {
  assert.deepEqual(chosenChips(others, state({ extra1: 'gone' })), []);
});

test('availableToAdd excludes chosen questions and is empty when two are chosen', () => {
  assert.deepEqual(availableToAdd(others, state({ extra1: 'snow' })).map(item => item.id), ['rain', 'wind', 'hail']);
  assert.deepEqual(availableToAdd(others, state({ extra1: 'snow', extra2: 'rain' })), []);
});

test('availableToAdd filters by search text ignoring case', () => {
  assert.deepEqual(availableToAdd(others, state(), 'WIND').map(item => item.id), ['wind']);
  assert.deepEqual(availableToAdd(others, state(), '  ').length, 4);
});

const pool = Array.from({ length: 8 }, (_, eventIndex) => ({ id: `0xpool-${eventIndex}`, eventIndex }));
const anchor = 0, rest = pool.filter(item => item.eventIndex !== anchor);
const links = [{ other: 3, difference: 96 }, { other: 5, difference: -74 }, { other: 2, difference: 51 }, { other: 7, difference: 12 }];

test('suggestions are the strongest links, skip chosen questions and questions the pool cannot add, at most three', () => {
  const found = suggestedLinks(links, state(), rest, null);
  assert.deepEqual(found.map(item => item.eventIndex), [3, 5, 2]);
  assert.deepEqual(found[0], { id: '0xpool-3', eventIndex: 3, difference: 96 });
  assert.deepEqual(suggestedLinks(links, state({ extra1: '0xpool-3' }), rest, null).map(item => item.eventIndex), [5, 2, 7]);
  assert.deepEqual(suggestedLinks(links, state(), rest, [2, 7]).map(item => item.eventIndex), [2, 7]);
  assert.deepEqual(suggestedLinks(links, state(), rest, null, 2).map(item => item.eventIndex), [3, 5]);
  assert.deepEqual(suggestedLinks([{ other: 9, difference: 5 }, ...links], state(), rest, null).map(item => item.eventIndex), [3, 5, 2]);
});

test('suggestions are empty for a pool with no links and with three answers chosen', () => {
  assert.deepEqual(suggestedLinks([], state(), rest, null), []);
  assert.deepEqual(suggestedLinks(links, state({ extra1: '0xpool-3', extra2: '0xpool-5' }), rest, null), []);
  assert.equal(legCount(state()), 1);
  assert.equal(legCount(state({ extra1: 'a' })), 2);
  assert.equal(legCount(state({ extra1: 'a', extra2: 'b' })), 3);
});

test('removing the first added question keeps the second in place with its answer', () => {
  const full = state({ extra1: 'rain', extra1Side: 'yes', extra2: 'wind', extra2Side: 'no' });
  assert.deepEqual(removeExtra(full, 1), state({ extra1: 'wind', extra1Side: 'no' }));
  assert.deepEqual(removeExtra(full, 2), state({ extra1: 'rain', extra1Side: 'yes' }));
  assert.deepEqual(removeExtra(state({ extra1: 'rain' }), 1), state());
  assert.deepEqual(addExtra(state(), 'rain'), state({ extra1: 'rain' }));
  assert.deepEqual(addExtra(state({ extra1: 'rain', extra1Side: 'no' }), 'wind'), state({ extra1: 'rain', extra1Side: 'no', extra2: 'wind' }));
  assert.deepEqual(addExtra(full, 'hail'), full);
});

test('a held claim fills the slip only when it includes this question and has a named rule', () => {
  const claim = (rule: 'AND' | 'OR' | 'EXACTLY_ONE', legs: { event: number; yes: boolean }[]) => encodeClaim({ events: 8, rule, legs });
  const held = claim('AND', [{ event: 0, yes: true }, { event: 2, yes: false }]);
  assert.deepEqual(claimToCombo(held.scope, held.mask, 8, 0, rest), { side: 'yes', rule: 'AND', combo: state({ extra1: '0xpool-2', extra1Side: 'no' }) });
  assert.equal(claimToCombo(held.scope, held.mask, 8, 1, pool.filter(item => item.eventIndex !== 1)), null);
  const three = claim('OR', [{ event: 0, yes: false }, { event: 4, yes: true }, { event: 6, yes: true }]);
  assert.deepEqual(claimToCombo(three.scope, three.mask, 8, 4, pool.filter(item => item.eventIndex !== 4)),
    { side: 'yes', rule: 'OR', combo: state({ extra1: '0xpool-0', extra1Side: 'no', extra2: '0xpool-6' }) });
  const single = claim('AND', [{ event: 0, yes: false }]);
  assert.deepEqual(claimToCombo(single.scope, single.mask, 8, 0, rest), { side: 'no', rule: 'AND', combo: state() });
  assert.equal(claimToCombo(3, '3', 8, 0, rest), null);
  assert.equal(claimToCombo(3, 'nonsense', 8, 0, rest), null);
});

test('the URL round-trips one, two and three answers with every rule', () => {
  const cases: { side: 'yes' | 'no'; combo: ComboState; rule: 'AND' | 'OR' | 'EXACTLY_ONE' }[] = [
    { side: 'yes', combo: state(), rule: 'AND' },
    { side: 'no', combo: state({ extra1: '0xpool-4', extra1Side: 'no' }), rule: 'AND' },
    { side: 'yes', combo: state({ extra1: '0xpool-4', extra1Side: 'yes' }), rule: 'OR' },
    { side: 'no', combo: state({ extra1: '0xpool-2', extra1Side: 'yes', extra2: '0xpool-7', extra2Side: 'no' }), rule: 'EXACTLY_ONE' },
    { side: 'yes', combo: state({ extra1: '0xpool-2', extra1Side: 'no', extra2: '0xpool-7', extra2Side: 'yes' }), rule: 'AND' },
  ];
  for (const item of cases) {
    const params = new URLSearchParams('shares=2&trade=sell');
    writeComboSearch(params, item, rest);
    assert.equal(params.get('shares'), '2');
    assert.deepEqual(readComboSearch('?' + params, rest), item);
    assert.equal(params.has('rule'), !!item.combo.extra1);
    assert.equal(params.has('third'), !!item.combo.extra2);
  }
  const cleared = new URLSearchParams('answer=yes&other=2&otherAnswer=no&third=7&thirdAnswer=no&rule=OR');
  writeComboSearch(cleared, { side: 'yes', combo: state(), rule: 'AND' }, rest);
  assert.equal(cleared.toString(), 'answer=yes');
  assert.deepEqual(readComboSearch('?other=99&third=2&rule=NOPE', rest), { side: 'yes', combo: state({ extra1: '0xpool-2' }), rule: 'AND' });
  assert.deepEqual(readComboSearch('?other=2&third=2', rest).combo, state({ extra1: '0xpool-2' }));
});
