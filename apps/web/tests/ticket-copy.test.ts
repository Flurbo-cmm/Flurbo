import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_LABEL, quoteErrorMessage, ruleHelp, sellBlockedMessage, tradeSummary } from '../src/ticket-copy.ts';

test('a failed quote says whether the pool cannot price the combination', () => {
  assert.match(quoteErrorMessage(true), /cannot price this combination/i);
  assert.doesNotMatch(quoteErrorMessage(true), /refresh/i);
  assert.match(quoteErrorMessage(false), /refresh/i);
});

test('each combination rule explains when it pays', () => {
  assert.match(ruleHelp('AND'), /every selected answer/i);
  assert.match(ruleHelp('OR'), /one or more/i);
  assert.match(ruleHelp('EXACTLY_ONE'), /all .* loss/i);
});

test('selling with nothing held explains the position, not a generic error', () => {
  assert.equal(sellBlockedMessage('0'), 'You hold no shares of this prediction in this wallet.');
  assert.equal(sellBlockedMessage('1000000'), 'You hold 1 share of this prediction. Lower the amount to sell.');
  assert.equal(sellBlockedMessage('2500000'), 'You hold 2.5 shares of this prediction. Lower the amount to sell.');
});

test('the approval button says a second wallet step follows', () => {
  assert.match(APPROVAL_LABEL, /Review AUSD approval/);
  assert.match(APPROVAL_LABEL, /step 1 of 2/);
});

test('trade summary names every question, side and the rule', () => {
  const legs = [{ question: 'A?', side: 'yes' as const }, { question: 'B?', side: 'no' as const }];
  assert.equal(tradeSummary('2', 'AND', legs), '2 shares · AND · A?: Yes · B?: No');
  assert.equal(tradeSummary('1', 'EXACTLY_ONE', legs), '1 share · EXACTLY ONE · A?: Yes · B?: No');
  assert.equal(tradeSummary('1', 'AND', [legs[0]]), '1 share · A?: Yes');
});
