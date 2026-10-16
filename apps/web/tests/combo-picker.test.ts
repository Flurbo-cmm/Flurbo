import assert from 'node:assert/strict';
import test from 'node:test';
import { availableToAdd, chosenChips, type ComboState } from '../src/combo-picker-model.ts';

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
