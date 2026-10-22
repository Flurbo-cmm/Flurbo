import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settlementView, type TimelineSnapshot } from '../src/settlement-timeline.ts';

const format = (seconds: number) => `t${seconds}`;
const closesAt = 1000, observationEndsAt = 2000;
const reality = (over: Partial<NonNullable<TimelineSnapshot['reality']>> = {}) => ({ sourceNow: 2500, opensAt: 2000, finalizesAt: 0,
  bondWei: '0', finalized: false, pendingArbitration: false, disputeStatus: 0, court: null, ...over });
const snap = (over: Partial<TimelineSnapshot> = {}): TimelineSnapshot => ({ closesAt, observationEndsAt, marketNow: 2500, resolved: false,
  phase: 0, reportDeadline: 2000 + 604800, ruleAdapter: null, automaticAnswer: null, reality: reality(), ...over });
const view = (snapshot: TimelineSnapshot | null, now = 2500) => settlementView({ snapshot, closesAt, observationEndsAt, now, format });
const current = (v: ReturnType<typeof view>) => v.steps.find(step => step.state === 'current')?.key;

test('before close the timeline is open on trading', () => {
  const v = view(snap({ marketNow: 500, reality: reality({ sourceNow: 500 }) }));
  assert.equal(v.status, 'open');
  assert.equal(v.statusText, 'Open for predictions');
  assert.equal(current(v), 'trading');
  assert.deepEqual(v.steps.map(step => step.key), ['trading', 'source', 'proposal', 'challenge', 'final', 'relay', 'payout']);
  assert.equal(v.steps[0].meta, 'Closes t1000');
});

test('a human question after its window opens waits for anyone to answer, with its Void deadline', () => {
  const v = view(snap());
  assert.equal(v.canAnswer, true);
  assert.equal(v.canArbitrate, false);
  assert.equal(v.statusText, 'Awaiting bonded answer');
  assert.equal(current(v), 'proposal');
  assert.match(String(v.steps[2].meta), /anyone can post the first answer/);
  assert.equal(v.waiting?.caption, 'If nobody answers by t606800, this question settles Void.');
});

test('a closed question before its window waits on the source', () => {
  const v = view(snap({ marketNow: 1500, reality: reality({ sourceNow: 1500 }) }));
  assert.equal(v.status, 'closed');
  assert.equal(v.statusText, 'Trading closed');
  assert.equal(v.canAnswer, false);
  assert.equal(current(v), 'source');
});

test('a posted answer opens the challenge window until it finalizes', () => {
  const v = view(snap({ reality: reality({ bondWei: '100000000000000', finalizesAt: 6100 }) }));
  assert.equal(v.hasRealityAnswer, true);
  assert.equal(v.canArbitrate, true);
  assert.equal(v.status, 'challenge');
  assert.equal(v.statusText, 'Answer open for challenge');
  assert.equal(current(v), 'challenge');
  assert.equal(v.steps[3].meta, 'Until t6100');
});

test('a Kleros case adds the court step', () => {
  const court = { disputeId: '7', periodLabel: 'Vote' };
  const v = view(snap({ reality: reality({ bondWei: '1', finalizesAt: 6100, pendingArbitration: true, disputeStatus: 1, court }) }));
  assert.equal(v.status, 'disputed');
  assert.equal(v.statusText, 'Kleros review');
  assert.deepEqual(v.steps.map(step => step.key), ['trading', 'source', 'proposal', 'challenge', 'court', 'final', 'relay', 'payout']);
  assert.equal(current(v), 'court');
  assert.equal(v.steps[4].meta, 'Case #7: Vote');
});

test('a final Reality answer waits for the relay, then the pool pays', () => {
  const relayed = view(snap({ reality: reality({ bondWei: '1', finalizesAt: 2400, finalized: true }) }));
  assert.equal(relayed.statusText, 'Final answer, awaiting relay');
  assert.equal(current(relayed), 'relay');
  const paid = view(snap({ resolved: true, phase: 3, reality: reality({ bondWei: '1', finalizesAt: 2400, finalized: true }) }));
  assert.equal(paid.status, 'collect');
  assert.equal(paid.statusText, 'Collect');
  assert.equal(current(paid), 'payout');
});

test('a rule-backed question names the reader answer', () => {
  const v = view(snap({ ruleAdapter: 'json-api.v1', automaticAnswer: { outcome: 2 }, reality: reality({ bondWei: '1', finalizesAt: 6100 }) }));
  assert.equal(v.steps[2].meta, 'Flurbo reader answered Yes');
});

test('mechanical questions keep their own steps', () => {
  const proposed = view(snap({ reality: null, phase: 1 }));
  assert.deepEqual(proposed.steps.map(step => step.key), ['trading', 'source', 'proposal', 'challenge', 'final', 'payout']);
  assert.equal(proposed.statusText, 'Answer open for challenge');
  assert.equal(current(proposed), 'challenge');
  const disputed = view(snap({ reality: null, phase: 2 }));
  assert.ok(disputed.steps.some(step => step.key === 'court'));
  assert.equal(disputed.status, 'disputed');
  assert.equal(view(snap({ reality: null, phase: 3 })).statusText, 'Result final, awaiting pool');
});

test('without a snapshot the timeline follows the clock', () => {
  assert.equal(view(null, 500).status, 'open');
  assert.equal(view(null, 1500).status, 'closed');
  assert.equal(current(view(null, 500)), 'trading');
});
