import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awaitingAnswer } from '../src/settlement-copy.ts';

const format = (s: number) => new Date(s * 1000).toISOString();
const at = (automatic: boolean, now: number) => awaitingAnswer({ automatic, opensAt: 100, now, reportDeadline: 700, format });

test('a question with a reader says when Flurbo answers', () => {
  assert.equal(at(true, 50).meta, "Flurbo's reader answers after 1970-01-01T00:01:40.000Z");
  assert.equal(at(true, 150).meta, "Flurbo's reader is posting the first answer");
});

test('a question without a reader says anyone can answer', () => {
  assert.equal(at(false, 50).meta, 'Anyone can answer after 1970-01-01T00:01:40.000Z');
  assert.equal(at(false, 150).meta, 'No automatic reader: anyone can post the first answer with a Sepolia ETH bond');
});

test('every waiting question states its Void deadline', () => {
  for (const [automatic, now] of [[true, 50], [true, 150], [false, 50], [false, 150]] as const)
    assert.equal(at(automatic, now).caption, 'If nobody answers by 1970-01-01T00:11:40.000Z, this question settles Void.');
});
