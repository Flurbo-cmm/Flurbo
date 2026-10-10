import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footballProofRules } from '../scripts/create-football-proof-rules.mjs';
import { createHybridRealityPilot } from '../scripts/create-hybrid-reality-pilot.mjs';
import { completeHybridRealityDraft } from '../scripts/complete-hybrid-reality-draft.mjs';
import { prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { settlementRuleAuthoringIssues, settlementRuleHash, validateSettlementRule } from '../server/settlement-rules.mjs';
import { parseSettlementCapture } from '../server/settlement-evidence.mjs';
import { creator, fakeSepolia, origin, proposer, relay, txHashes } from './hybrid-reality-fixture.ts';
import { ATTESTOR, proofCapture } from './proof-fixture.ts';

const kickoffAt = () => Math.floor(Date.now() / 1000) + 4 * 3600;
const rulesFor = (kickoff: number) => footballProofRules({ matchId: '537785', kickoff, home: 'Arsenal', away: 'Chelsea', attestors: [ATTESTOR] });

test('football proof rules validate and hash', () => {
  const kickoff = 1_792_332_000, rules = rulesFor(kickoff);
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    assert.doesNotThrow(() => validateSettlementRule(rule));
    assert.deepEqual(settlementRuleAuthoringIssues(rule), []);
    assert.equal(rule.source.adapter, 'proof-http.v1');
    assert.deepEqual(rule.source.urls, ['https://api.football-data.org/v4/matches/537785']);
    assert.deepEqual(rule.timing, { scheduledAt: kickoff + 3 * 3600, publicationCutoff: kickoff + 30 * 3600, correctionCutoff: kickoff + 30 * 3600,
      observationEndsAt: kickoff + 30 * 3600, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 });
  }
  assert.notEqual(settlementRuleHash(rules[0]), settlementRuleHash(rules[1]));
  assert.equal(rules[0].eventId, 'fd-537785-home-win');
  assert.equal(rules[0].question, 'Will Arsenal beat Chelsea in football-data.org match 537785 (kickoff 2026-10-18T14:00:00Z)?');
  assert.deepEqual(rules[0].decision, { type: 'category', operator: 'eq', value: 'HOME_TEAM' });
  assert.equal(rules[1].eventId, 'fd-537785-goals');
  assert.equal(rules[1].question, 'Will football-data.org match 537785 (Arsenal v Chelsea, kickoff 2026-10-18T14:00:00Z) end with at least 3 goals in total?');
  assert.deepEqual(rules[1].decision, { type: 'number', operator: 'gte', value: '3' });
  assert.deepEqual(rules[1].source.reader.value, { sum: ['homeGoals', 'awayGoals'] });
  assert.deepEqual(rules[1].source.reader.responseRedactions.map((item: any) => item.jsonPath), ['$.id', '$.status', '$.score.fullTime.home', '$.score.fullTime.away']);
  assert.deepEqual(rules[0].source.reader.checks, [{ param: 'matchId', equals: '537785' }, { param: 'status', equals: 'FINISHED' }]);
  assert.equal(footballProofRules({ matchId: '537785', kickoff, home: 'Arsenal', away: 'Chelsea', attestors: [ATTESTOR], timeout: 7200 })[0].timing.challengePeriod, 7200);
});

test('football rule inputs are checked', () => {
  const base = { matchId: '537785', kickoff: 1_792_332_000, home: 'Arsenal', away: 'Chelsea', attestors: [ATTESTOR] };
  for (const change of [{ matchId: '12ab' }, { matchId: '' }, { kickoff: 1.5 }, { home: '' }, { away: ' Chelsea' }, { home: 'x'.repeat(41) }, { home: 'A\nB' },
    { attestors: [] }, { attestors: ['0xABCDEF'] }, { timeout: 10 }])
    assert.throws(() => footballProofRules({ ...base, ...change }), undefined, JSON.stringify(change));
});

test('a football proof settles the winner and the goals from one signed response', async () => {
  const [winner, goals] = rulesFor(1_792_332_000), at = winner.timing.scheduledAt + 600;
  const identity = { matchId: '537785', status: 'FINISHED' };
  assert.equal(parseSettlementCapture(winner, await proofCapture(winner, { timestampS: at, extracted: { ...identity, winner: 'HOME_TEAM' } }), at + 5).value, 'HOME_TEAM');
  assert.equal(parseSettlementCapture(goals, await proofCapture(goals, { timestampS: at, extracted: { ...identity, homeGoals: '2', awayGoals: '2' } }), at + 5).value, '4');
});

test('a Reality reader pool can carry proof rules', async () => {
  const kickoff = kickoffAt(), rules = rulesFor(kickoff);
  const create = (extra: object) => createHybridRealityPilot({ creator, proposer, relay, closesAt: kickoff - 600, origin, ...extra });
  const template = create({ rules });
  assert.throws(() => prepareHybridPilot(template.draft), /Invalid Reality source/, 'question IDs only exist after the questions are asked');
  const draft = await completeHybridRealityDraft(template, txHashes, fakeSepolia(template));
  const prepared = prepareHybridPilot({ ...draft, rulesReviewed: true });
  assert.equal(prepared.draft.events.length, 2);
  template.draft.events.forEach((event: any, index: number) => {
    assert.equal(event.rule, rules[index]);
    assert.ok(event.source.ruleURI.endsWith(`/0x${settlementRuleHash(rules[index])}`));
    assert.ok(event.source.questionText.includes(event.source.ruleURI));
    assert.equal(event.observationEndsAt, rules[index].timing.observationEndsAt);
    assert.equal(template.questions[index].opening, event.observationEndsAt);
    assert.equal(prepared.draft.events[index].rule.source.adapter, 'proof-http.v1');
  });
  assert.throws(() => create({ rules: [rules[0]] }), /2 to 32 rules/);
  assert.throws(() => create({ rules: [rules[0], rules[0]] }), /distinct/);
  assert.throws(() => create({ rules, timeout: 7200 }), /challenge period/);
  const shortWindow = structuredClone(rules[0]); shortWindow.timing.publicationCutoff = shortWindow.timing.scheduledAt + 3600;
  shortWindow.timing.correctionCutoff = shortWindow.timing.observationEndsAt = shortWindow.timing.publicationCutoff;
  assert.throws(() => create({ rules: [shortWindow, rules[1]] }), /at least 6 hours/);
  assert.equal(create({}).draft.events[0].rule.source.adapter, 'evm-rpc.v1');
});
