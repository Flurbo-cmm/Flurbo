import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAbortHelpers } from './abort-helpers.ts';
test('native cancellation and deadlines work without browser static helpers', async () => {
  class EmptySignal {}
  const Signal = EmptySignal as unknown as typeof AbortSignal;
  installAbortHelpers(Signal, AbortController);
  const a = new AbortController(), b = new AbortController();
  const combined = Signal.any([a.signal, b.signal]);
  b.abort(); assert.equal(combined.aborted, true);
  assert.equal(Signal.any([b.signal]).aborted, true);
  const timeout = Signal.timeout(5);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(timeout.aborted, true);
  assert.throws(() => Signal.timeout(-1));
});
