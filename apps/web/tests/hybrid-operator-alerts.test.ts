import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanQuestionsWaiting, hybridAlertsFor, hybridOperatorAlerts } from '../server/hybrid-operator-alerts.mjs';
import { account, at, catalog } from './hybrid-catalog-fixture.ts';

const origin = 'https://flurbopm.singu.online';
const zero = `0x${'0'.repeat(64)}`;
const record = catalog(['reality', 'reality']).pools[0];
const mech = catalog(['mechanical', 'mechanical']).pools[0];

const reality = (over: Record<string, unknown> = {}) => ({ bondWei: '0', answerLabel: null, finalized: false,
  finalizesAt: at + 7200, disputeStatus: 0, disputeId: '0', court: null, ...over });
const pool = (events: any[], over: Record<string, unknown> = {}) => ({ delivered: false, resolved: false, events, ...over });
const open = () => ({ phase: 0, result: 0, reality: reality() });

function memory() {
  const values = new Map<string, string>();
  return { values, command: async (op: string, name: string, value?: string, ...options: string[]) => {
    if (op === 'GET') return values.get(name) ?? null;
    if (op === 'SET') {
      if (options.includes('NX') && values.has(name)) return null;
      values.set(name, value || ''); return 'OK';
    }
    throw Error(`Unexpected ${op}`);
  } };
}

function fixture(initial: any, extra: Record<string, unknown> = {}) {
  const redis = memory(), sent: any[] = [];
  let state = initial, failures = 0, workers: any = {}, balances: any = {};
  const alerts = hybridOperatorAlerts({ pools: [record], readPool: async () => state, command: redis.command,
    deliver: async (pending: any) => { if (failures > 0) { failures--; throw Error('down'); } sent.push(pending); return 'id'; },
    from: 'ops@example.com', to: ['owner@example.com'], origin, now: () => at + 3700,
    workers: () => workers, balances: async () => balances, ...extra });
  return { alerts, sent, set: (next: any) => { state = next; }, fail: (n: number) => { failures = n; },
    setWorkers: (next: any) => { workers = next; }, setBalances: (next: any) => { balances = next; } };
}

test('the first run records the current state without sending anything', async () => {
  const h = fixture(pool([{ phase: 3, result: 2, reality: reality({ bondWei: '1', answerLabel: 'Yes', finalized: true }) }, open()], { delivered: true }));
  assert.equal(await h.alerts.tick(), 'baseline 1 pool');
  assert.equal(await h.alerts.tick(), 'idle');
  assert.deepEqual(h.sent, []);
});

test('a posted answer sends one email and is not repeated', async () => {
  const h = fixture(pool([open(), open()]));
  await h.alerts.tick();
  h.set(pool([{ phase: 0, result: 0, reality: reality({ bondWei: '100000000000000', answerLabel: 'Yes' }) }, open()]));
  assert.equal(await h.alerts.tick(), 'sent 1');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].body.subject, /answer posted/i);
  assert.match(h.sent[0].body.text, /Yes/);
  assert.match(h.sent[0].body.text, /\/markets\/hybrid\//);
  assert.deepEqual(h.sent[0].body.to, ['owner@example.com']);
  assert.equal(await h.alerts.tick(), 'idle');
  assert.equal(h.sent.length, 1);
});

test('the vote period asks the operator to act, once per round', async () => {
  const h = fixture(pool([open(), open()]));
  await h.alerts.tick();
  const court = { period: 2, periodLabel: 'Vote', ruled: false, rounds: 1, votesCast: 0, votesNeeded: 1 };
  h.set(pool([{ phase: 0, result: 0, reality: reality({ bondWei: '2', answerLabel: 'No', disputeStatus: 1, disputeId: '7', court,
    questionId: '0xabc' }) }, open()]));
  await h.alerts.tick();
  const text = h.sent.map(m => m.body.text).join('\n');
  assert.ok(h.sent.some(m => /^ACTION/.test(m.body.subject)));
  assert.match(text, /juror vote/i);
  assert.match(text, /inspect-kleros-dispute\.mjs/);
  assert.match(text, /#7/);
  const before = h.sent.length;
  await h.alerts.tick();
  assert.equal(h.sent.length, before);
});

const voting = (jurorPendingVoteIds: number[]) => pool([{ phase: 0, result: 0, reality: reality({ bondWei: '200000000000000',
  answerLabel: 'No', disputeStatus: 1, disputeId: '7', questionId: `0x${'a'.repeat(64)}`,
  court: { court: '0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879', period: 2, ruled: false, rounds: 1, votesCast: 0,
    votesNeeded: 1, jurorPendingVoteIds } }) }, open()]);

test("the vote alert carries the juror's command", () => {
  const alert = hybridAlertsFor(record, voting([0]), origin).find(item => item.id.startsWith('vote:'))!;
  assert.equal(alert.action, true);
  assert.ok(alert.text.includes("'castVote(uint256,uint256[],uint256,uint256)' 7 '[0]'"));
});

test('the vote alert reports a configured juror without a seat', () => {
  const alert = hybridAlertsFor(record, voting([]), origin).find(item => item.id.startsWith('vote:'))!;
  assert.ok(alert.text.includes('The configured juror holds no unvoted seat'));
});

test('several new alerts go out in one email', async () => {
  const h = fixture(pool([open(), open()]));
  await h.alerts.tick();
  h.set(pool([{ phase: 3, result: 2, reality: reality({ bondWei: '1', answerLabel: 'Yes', finalized: true }) },
    { phase: 3, result: 1, reality: reality({ bondWei: '1', answerLabel: 'No', finalized: true }) }], { delivered: true, resolved: true }));
  assert.equal(await h.alerts.tick(), 'sent 1');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].body.subject, /updates/);
  assert.match(h.sent[0].body.text, /delivered/i);
});

test('a failed send is retried and never duplicated', async () => {
  const h = fixture(pool([open(), open()]));
  await h.alerts.tick();
  h.set(pool([{ phase: 0, result: 0, reality: reality({ bondWei: '1', answerLabel: 'Yes' }) }, open()]));
  h.fail(1);
  assert.equal(await h.alerts.tick(), 'send failed; retained');
  assert.equal(h.sent.length, 0);
  assert.equal(await h.alerts.tick(), 'sent 1');
  assert.equal(await h.alerts.tick(), 'idle');
  assert.equal(h.sent.length, 1);
});

test('worker errors and low balances alert once per window', async () => {
  const h = fixture(pool([open(), open()]));
  await h.alerts.tick();
  h.setWorkers({ hybrid_court: { lastError: 'Sepolia keeper needs the arbitration fee and gas' } });
  h.setBalances({ keeper: { address: account('8'), wei: 10n ** 16n }, answerer: { address: account('9'), wei: 10n ** 18n },
    relay: null, proposer: null });
  assert.equal(await h.alerts.tick(), 'sent 1');
  assert.match(h.sent[0].body.text, /arbitration fee and gas/);
  assert.match(h.sent[0].body.text, /keeper/i);
  assert.ok(h.sent[0].body.text.includes(account('8')));
  assert.equal(await h.alerts.tick(), 'idle');
});

test('a low Monad relay balance names the wallet and the delivery count', async () => {
  const h = fixture(pool([open(), open()]));
  await h.alerts.tick();
  h.setBalances({ keeper: null, answerer: null, proposer: null,
    relay: { address: '0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1', wei: 100_000_000_000_000_000n } });
  assert.equal(await h.alerts.tick(), 'sent 1');
  assert.equal(h.sent[0].body.subject, 'ACTION: Flurbo hybrid: Low Monad balance: relay');
  for (const part of ['0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1', '0.1000 MON', 'below 0.3000', 'about 7 deliveries'])
    assert.ok(h.sent[0].body.text.includes(part), part);
  assert.equal(await h.alerts.tick(), 'idle');
  assert.equal(h.sent.length, 1);
});

const human = structuredClone(record);
delete (human.prepared.draft.events[1] as any).rule;
const opensAt = at + 3600;
const unanswered = (sourceNow: number, bondWei = '0') => pool([open(), { phase: 0, result: 0,
  reality: reality({ bondWei, finalized: false, pendingArbitration: false, sourceNow, opensAt }) }]);

test('a human question asks for an answer once when its window opens', async () => {
  const h = fixture(unanswered(opensAt - 60), { pools: [human] });
  await h.alerts.tick();
  assert.deepEqual(h.alerts.status().waitingForHumanAnswer, {});
  h.set(unanswered(opensAt + 60));
  assert.equal(await h.alerts.tick(), 'sent 1');
  assert.equal(h.sent.length, 1);
  const { subject, text } = h.sent[0].body;
  assert.match(subject, /^ACTION: Flurbo hybrid:/);
  assert.ok(subject.includes('Answer needed: question 2 of'));
  assert.ok(text.includes('no automatic reader'));
  assert.ok(text.includes('0.0001 Sepolia ETH'));
  const draft = human.prepared.draft;
  const deadline = new Date((draft.events[1].observationEndsAt + draft.reportPeriod) * 1000).toISOString()
    .replace('T', ' ').slice(0, 16) + ' UTC';
  assert.ok(text.includes(deadline), deadline);
  assert.equal(await h.alerts.tick(), 'idle');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.alerts.status().waitingForHumanAnswer, { [human.id]: [1] });
  h.set(unanswered(opensAt + 120, '100000000000000'));
  await h.alerts.tick();
  assert.deepEqual(h.alerts.status().waitingForHumanAnswer, {});
});

test('rule-backed questions never ask for a human answer', () => {
  const state = pool([{ phase: 0, result: 0, reality: reality({ bondWei: '0', finalized: false, pendingArbitration: false,
    sourceNow: opensAt + 60, opensAt }) }, open()]);
  assert.equal(hybridAlertsFor(record, state, origin).some(alert => alert.id.startsWith('human:')), false);
  assert.deepEqual(humanQuestionsWaiting(record, state), []);
});

test('mechanical questions report proposal, challenge and result', () => {
  const states = [{ phase: 1, result: 0, reality: null }, { phase: 2, result: 0, reality: null }];
  const ids = hybridAlertsFor(mech, pool(states), origin).map((a: any) => a.id);
  assert.ok(ids.some((id: string) => id.startsWith('proposed:')));
  assert.ok(ids.some((id: string) => id.startsWith('challenged:')));
  const done = hybridAlertsFor(mech, pool([{ phase: 3, result: 2, reality: null }, { phase: 3, result: 1, reality: null }], { delivered: true }), origin);
  assert.ok(done.some((a: any) => a.id.startsWith('finalized:')));
  assert.ok(done.some((a: any) => a.id.startsWith('delivered:')));
});
