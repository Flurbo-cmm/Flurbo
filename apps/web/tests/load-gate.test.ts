import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdFor, initialLoaderState, reduceLoader, resolveDuration, TIMING, type LoaderEvent, type LoaderState } from '../src/loading/load-gate.ts';

const run = (events: LoaderEvent[], start: LoaderState = initialLoaderState) => events.reduce(reduceLoader, start);
const open: LoaderEvent = { type: 'open', label: 'Loading markets', stage: 0, stages: 2 };

test('ready content is revealed within a 750ms animation budget, including the readiness debounce', () => {
  for (const reduced of [false, true]) for (const readyAt of [1, 100, 1000]) {
    const state = run([open, {type:'show', now:0}, {type:'ready', now:readyAt}]);
    const resolve = resolveDuration(state, reduced);
    const delay = 60 + resolve + holdFor(state, readyAt + resolve, reduced) + (reduced ? TIMING.reducedFadeOut : TIMING.exit);
    assert.ok(delay <= 750, `post-readiness animation takes ${delay}ms`);
  }
});

test('a load that is ready before the show delay never displays the loader', () => {
  const state = run([open, { type: 'ready', now: 150 }]);
  assert.equal(state.phase, 'idle');
});

test('a shown loader moves through entering, waiting, resolving, complete and exiting in order', () => {
  let state = run([open, { type: 'show', now: 200 }]);
  assert.equal(state.phase, 'entering');
  state = run([{ type: 'entered' }], state);
  assert.equal(state.phase, 'waiting');
  // Out-of-order events do not skip phases.
  assert.equal(run([{ type: 'held' }], state).phase, 'waiting');
  state = run([{ type: 'ready', now: 2000 }], state);
  assert.equal(state.phase, 'resolving');
  assert.equal(state.fast, false);
  state = run([{ type: 'resolved' }, { type: 'held' }], state);
  assert.equal(state.phase, 'exiting');
  assert.equal(run([{ type: 'exited' }], state).phase, 'idle');
});

test('readiness soon after showing uses the short resolve and still honours the minimum visible time', () => {
  const state = run([open, { type: 'show', now: 200 }, { type: 'ready', now: 300 }]);
  assert.equal(state.fast, true);
  assert.equal(resolveDuration(state, false), TIMING.resolveFast);
  const completeAt = 300 + TIMING.resolveFast;
  const hold = holdFor(state, completeAt, false);
  assert.ok(completeAt + hold - 200 >= TIMING.minVisible);
  assert.ok(hold >= TIMING.dot + TIMING.settle);
});

test('reduced motion skips the resolve animation and keeps a shorter minimum', () => {
  const state = run([open, { type: 'show', now: 0 }, { type: 'ready', now: 100 }]);
  assert.equal(resolveDuration(state, true), 0);
  assert.equal(holdFor(state, 100, true), TIMING.reducedMinVisible - 100);
});

test('failures surface with their message and a retry returns to waiting', () => {
  let state = run([open, { type: 'show', now: 200 }, { type: 'entered' }, { type: 'fail', error: 'Markets could not be loaded. Please retry.', now: 900 }]);
  assert.equal(state.phase, 'failed');
  assert.equal(state.error, 'Markets could not be loaded. Please retry.');
  state = run([{ type: 'retry' }], state);
  assert.equal(state.phase, 'waiting');
  assert.equal(state.error, null);
  assert.equal(run([{ type: 'ready', now: 1500 }], state).phase, 'resolving');
});

test('a failure before the loader shows is still displayed, never swallowed', () => {
  const state = run([open, { type: 'fail', error: 'Access check failed', now: 50 }]);
  assert.equal(state.phase, 'failed');
  assert.equal(state.shownAt, 50);
});

test('leaving the page releases the loader and a reset always returns to idle', () => {
  assert.equal(run([open, { type: 'abandon' }]).phase, 'idle');
  const shown = run([open, { type: 'show', now: 200 }]);
  assert.equal(run([{ type: 'abandon' }], shown).phase, 'exiting');
  assert.equal(run([{ type: 'reset' }], shown).phase, 'idle');
});

test('the slow notice applies only while waiting and progress updates keep identity when unchanged', () => {
  const waiting = run([open, { type: 'show', now: 0 }, { type: 'entered' }, { type: 'slow' }]);
  assert.equal(waiting.slow, true);
  const same = reduceLoader(waiting, { type: 'progress', label: waiting.label, stage: waiting.stage, stages: waiting.stages });
  assert.equal(same, waiting);
  assert.equal(run([{ type: 'slow' }], initialLoaderState).slow, false);
});
