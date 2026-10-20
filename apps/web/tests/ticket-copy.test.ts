import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as copy from '../src/ticket-copy.ts';
import { APPROVAL_LABEL, RULE_OPTIONS, TICKET_INTRO, balanceLabel, monadTxUrl, payoutSentence, positionLine, quoteErrorMessage, quoteWaitText,
  rulePhrase, ruleWord, sellBlockedMessage, tradeSummary } from '../src/ticket-copy.ts';

test('a failed combined quote says whether the pool cannot price it or the read failed', () => {
  assert.match(quoteErrorMessage('unpriceable'), /cannot price these questions together/i);
  assert.match(quoteErrorMessage('unpriceable'), /remove an answer/i);
  assert.doesNotMatch(quoteErrorMessage('unpriceable'), /refresh/i);
  assert.match(quoteErrorMessage('unavailable'), /refresh/i);
  assert.doesNotMatch(quoteErrorMessage('unavailable'), /combination|together|price these/i);
});

test('rule labels fit any number of answers', () => {
  assert.deepEqual(RULE_OPTIONS.map(option => option.label), ['All correct', 'At least one', 'Exactly one']);
  assert.deepEqual(RULE_OPTIONS.map(option => option.value), ['AND', 'OR', 'EXACTLY_ONE']);
  assert.ok(RULE_OPTIONS.every(option => !/both/i.test(option.label)));
  assert.deepEqual((['AND', 'OR', 'EXACTLY_ONE'] as const).map(ruleWord), ['and', 'or', 'exactly one of']);
  assert.deepEqual((['AND', 'OR', 'EXACTLY_ONE'] as const).map(rulePhrase),
    ['Pays when all are correct', 'Pays when at least one is correct', 'Pays when exactly one is correct']);
});

test('the payout sentence names each answer with its question number', () => {
  const two = [{ number: 1, side: 'yes' as const }, { number: 6, side: 'no' as const }];
  const three = [{ number: 1, side: 'yes' as const }, { number: 2, side: 'yes' as const }, { number: 6, side: 'no' as const }];
  assert.equal(payoutSentence('AND', two), 'Pays 1 test AUSD a share if Q1 is Yes and Q6 is No.');
  assert.equal(payoutSentence('AND', three), 'Pays 1 test AUSD a share if Q1 is Yes, Q2 is Yes and Q6 is No.');
  assert.equal(payoutSentence('OR', three), 'Pays 1 test AUSD a share if at least one is right: Q1 Yes, Q2 Yes or Q6 No.');
  assert.equal(payoutSentence('OR', two), 'Pays 1 test AUSD a share if at least one is right: Q1 Yes or Q6 No.');
  assert.equal(payoutSentence('EXACTLY_ONE', three),
    'Pays 1 test AUSD a share if exactly one is right: Q1 Yes, Q2 Yes or Q6 No. Two or more right pays nothing.');
  assert.equal(payoutSentence('AND', [two[0]]), 'Pays 1 test AUSD a share if Q1 is Yes.');
});

test('a held position reads as one line with its rule', () => {
  const legs = (...items: [number, 'yes' | 'no'][]) => items.map(([number, side]) => ({ number, side }));
  assert.equal(positionLine('AND', legs([1, 'yes'])), 'Q1 Yes');
  assert.equal(positionLine('AND', legs([1, 'yes'], [6, 'no'])), 'Q1 Yes and Q6 No, all correct');
  assert.equal(positionLine('OR', legs([1, 'yes'], [6, 'no'])), 'Q1 Yes or Q6 No, at least one correct');
  assert.equal(positionLine('EXACTLY_ONE', legs([1, 'yes'], [2, 'no'], [6, 'no'])), 'Q1 Yes, Q2 No or Q6 No, exactly one correct');
  assert.equal(positionLine('AND', legs([1, 'yes'], [2, 'no'], [6, 'no'])), 'Q1 Yes, Q2 No and Q6 No, all correct');
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

test('the balance line reads, fails and loads in plain words', () => {
  const idle = 'MetaMask signs each trade and bond you review';
  assert.equal(balanceLabel({ owner: null, snapshotLoaded: false, cashAtoms: null, error: false }), idle);
  assert.equal(balanceLabel({ owner: '0xabc', snapshotLoaded: false, cashAtoms: null, error: false }), 'Reading balance...');
  assert.equal(balanceLabel({ owner: '0xabc', snapshotLoaded: false, cashAtoms: null, error: true }), 'Balance unavailable. Refresh.');
  assert.equal(balanceLabel({ owner: '0xabc', snapshotLoaded: true, cashAtoms: '10500000', error: false }), '10.5 test AUSD');
  assert.equal(balanceLabel({ owner: '0xabc', snapshotLoaded: true, cashAtoms: '0', error: true }), '0 test AUSD');
});

test('ticket copy uses no banned words, no dashes and no exclamation marks', () => {
  const banned = /\b(?:bet|bets|betting|odds|parlay|wager|wagers|gambl\w*|jackpot|cash out|win big)\b|\u2014|\u2013|!/i;
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(Object.values(copy).filter(value => typeof value !== 'function'));
  const legs = [{ number: 1, side: 'yes' as const }, { number: 2, side: 'no' as const }, { number: 6, side: 'yes' as const }];
  for (const rule of ['AND', 'OR', 'EXACTLY_ONE'] as const) {
    walk([payoutSentence(rule, legs), payoutSentence(rule, legs.slice(0, 2)), payoutSentence(rule, legs.slice(0, 1)), positionLine(rule, legs),
      rulePhrase(rule), ruleWord(rule)]);
  }
  walk([quoteErrorMessage('unpriceable'), quoteErrorMessage('unavailable'), quoteWaitText(true), quoteWaitText(false), sellBlockedMessage('0'),
    sellBlockedMessage('2500000'), balanceLabel({ owner: null, snapshotLoaded: false, cashAtoms: null, error: false }), TICKET_INTRO]);
  assert.ok(strings.length > 20);
  for (const text of strings) assert.doesNotMatch(text, banned, text);
  assert.equal(TICKET_INTRO, 'Each share pays 1 test AUSD if your prediction is right. Add up to two linked questions to combine them.');
});

test('a completed trade links its transaction only for a full hash', () => {
  assert.equal(monadTxUrl('0x' + 'ab'.repeat(32)), 'https://testnet.monadscan.com/tx/0x' + 'ab'.repeat(32));
  assert.equal(monadTxUrl('0x12'), null);
  assert.equal(monadTxUrl(''), null);
});

test('a slow quote says it is still loading and retries', () => {
  assert.equal(quoteWaitText(false), 'Reading the current pool quote...');
  assert.equal(quoteWaitText(true), 'Still reading the pool quote. Monad may be slow; this retries on its own.');
});
