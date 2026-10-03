import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailConfig, resendDelivery, queueReport, drainEmails, queueReadFailures } from '../server/settlement-email.mjs';
import { settlementLease } from '../server/settlement-store.mjs';
import { notifyPool, runNotifications, watchdog } from '../scripts/notify-settlement.mjs';
import { monitorIdentity } from '../server/settlement-monitor.mjs';
import { pilotFixture, hash } from './pilot-fixture.ts';
import { deterministicManifest } from './deterministic-fixture.ts';

const config = { from: 'alerts@example.com', to: ['operator@example.com'], key: 're_test-secret' };
const identity = 'test-pool';
const empty = () => ({ schema: 'flurbo.settlement-mail.v1', identity, signature: null, lastQueuedAt: 0, queue: [] });
const report = (checkedAt = 1000, active = true): any => ({ checkedAt, pool: 'pool', resolver: 'resolver',
  snapshot: { blockNumber: String(checkedAt) }, lifecycle: 'trading_closed', status: active ? 'attention_required' : 'observed',
  alerts: active ? [{ code: 'ASSERTION_REVIEW_REQUIRED', severity: 'critical', event: 0, deadline: 5000, message: 'Review evidence.' }] : [],
  events: [{ event: 0, question: 'Fixture?', phase: 'Asserted', proposal: 'YES', counter: 'Unset', result: 'Unset', votes: [0, 0, 0],
    deadline: 5000, evidenceHash: hash, counterEvidenceHash: hash, remainingSeconds: 5000 - checkedAt, action: 'Review assertion.' }],
});

// Models the atomic Redis lease operations, including expiration and fenced writes.
function redis() {
  const data = new Map<string, string>(), expires = new Map<string, number>();
  const clock = { ms: 0 }, fail = { save: false };
  const command = async (...args: any[]): Promise<any> => {
    for (const [k, at] of expires) if (at <= clock.ms) { data.delete(k); expires.delete(k); }
    if (args[0] === 'GET') return data.get(args[1]) ?? null;
    if (args[0] === 'SET') {
      if (data.has(args[1])) return null;
      data.set(args[1], args[2]); expires.set(args[1], clock.ms + 300000); return 'OK';
    }
    assert.equal(args[0], 'EVAL');
    const [, , , lock, key, token, operation, value] = args;
    if (data.get(lock) !== token) return 0;
    if (operation === 'release') { data.delete(lock); expires.delete(lock); return 1; }
    expires.set(lock, clock.ms + 300000);
    if (operation === 'save') { if (fail.save) throw new Error('storage failure'); data.set(key, value); }
    return 1;
  };
  return { command, data, clock, fail };
}

test('stable observations do not spam; deadline escalation, evidence, recovery and hourly reminders notify', () => {
  let state = queueReport(empty(), report(), config, 1000);
  assert.equal(state.queue.length, 1);
  state = queueReport(state, report(1300), config, 1300);
  assert.equal(state.queue.length, 1); // Block and countdown changes are irrelevant.
  state = queueReport(state, report(4600), config, 4600);
  assert.equal(state.queue.length, 2);
  const changed = report(4700); changed.events[0].evidenceHash = 'new evidence';
  assert.equal(queueReport(state, changed, config, 4700).queue.length, 3);
  const urgent = report(4800); urgent.alerts.push({ code: 'DEADLINE_WITHIN_10_MINUTES', severity: 'critical', event: 0, deadline: 5000, message: 'Act now.' });
  assert.equal(queueReport(state, urgent, config, 4800).queue.length, 3);
  assert.equal(queueReport(state, report(4800, false), config, 4800).queue.length, 3);
  assert.equal(queueReport(empty(), report(1000, false), config, 1000).queue.length, 0);
  assert.equal(queueReport(empty(), report(1000, false), config, 1000, { test: true }).queue.length, 1);
  const settled = report(1000, false);
  settled.alerts = [{ code: 'SETTLEMENT_DELIVERED', severity: 'info', message: 'Delivered.' }];
  assert.equal(queueReport(empty(), settled, config, 1000).queue.length, 1);
});

test('a timed out accepted email retries the identical body and idempotency key', async () => {
  let state = queueReport(empty(), report(), config, 1000), calls: any[] = [];
  const send = resendDelivery(config, async (url: any, options: any) => {
    assert.equal(url, 'https://api.resend.com/emails'); calls.push(options);
    if (calls.length === 1) throw new Error('Provider accepted but response lost re_test-secret');
    return Response.json({ id: 'provider-message-id' });
  });
  const save = async (next: any) => { state = structuredClone(next); };
  await assert.rejects(drainEmails(state, { send, save, renew: async () => {}, now: () => 1100 }), /pending delivery retained/);
  assert.equal(state.queue.length, 1);
  const result = await drainEmails(state, { send, save, renew: async () => {}, now: () => 1200 });
  assert.equal(result.state.queue.length, 0);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});

test('failed acknowledgement persistence reuses the pending item; expired or lost leases prevent sends', async () => {
  const state = queueReport(empty(), report(), config, 1000);
  let sends = 0;
  const send = async () => { sends++; return 'accepted-id'; };
  await assert.rejects(drainEmails(state, { send, save: async () => { throw new Error('disk'); }, renew: async () => {}, now: () => 1100 }));
  assert.equal(state.queue.length, 1);
  await assert.rejects(drainEmails(state, { send, save: async () => {}, renew: async () => {}, now: () => 1000 + 23 * 3600 }), /manual reconciliation/);
  await assert.rejects(drainEmails(state, { send, save: async () => {}, renew: async () => { throw new Error('lease lost'); }, now: () => 1100 }));
  assert.equal(sends, 1);
});

test('Redis lease excludes concurrent workers and fences a paused worker after expiration', async () => {
  const r = redis(), first = await settlementLease(r.command, identity);
  await assert.rejects(settlementLease(r.command, identity), /already running/);
  await first.save({ good: true });
  r.clock.ms = 300001;
  const second = await settlementLease(r.command, identity);
  await assert.rejects(first.save({ bad: true }), /lease lost/);
  await assert.rejects(first.release(), /lease lost/);
  assert.deepEqual(await second.load(), { good: true });
  await second.release();
});

function observed(manifest: any, now: number, active = true) {
  return { report: { ...report(now, active), pool: manifest.pool, resolver: manifest.resolver },
    checkpoint: { schema: 'flurbo.settlement-checkpoint.v1', identity: monitorIdentity(manifest), checkedAt: now,
      snapshot: { blockNumber: '100', blockHash: hash, timestamp: now }, delivered: false,
      cases: Array.from({ length: manifest.publication.draft.events.length }, () => ({ phase: 0, result: 0, votes: [0, 0, 0] })) } };
}

test('hosted job persists before sending, retries reads, and keeps the checkpoint and inbox quiet on a failed check', async () => {
  const f = pilotFixture(), r = redis(); let time = 1000, sends = 0;
  const waits: number[] = [], wait = async (ms: number) => { waits.push(ms); };
  const options = { manifest: f.manifest, rpc: f.rpc, command: r.command, config, now: () => time, wait,
    send: async () => { sends++; return 'accepted-id'; }, inspect: async () => observed(f.manifest, time) };
  r.fail.save = true;
  await assert.rejects(notifyPool(options)); assert.equal(sends, 0);
  r.fail.save = false;
  assert.equal((await notifyPool(options)).acceptedEmails, 1);
  const stateKey = [...r.data.keys()].find(k => k.endsWith(':state'))!;
  const checkpoint = JSON.parse(r.data.get(stateKey)!).checkpoint;
  time = 1300;
  let calls = 0;
  const failed = await notifyPool({ ...options, inspect: async () => { calls++; throw new Error('secret RPC'); } });
  assert.equal(failed.status, 'check_failed'); assert.equal(failed.readFailures, 1); assert.equal(failed.acceptedEmails, 0);
  assert.equal(calls, 3, 'each check retries its read'); assert.deepEqual(waits, [2000, 4000]);
  assert.deepEqual(JSON.parse(r.data.get(stateKey)!).checkpoint, checkpoint);
  assert.equal((await notifyPool({ ...options, inspect: async () => { calls++; throw new Error('secret RPC'); } })).readFailures, 2);
  // A read that fails once and then succeeds is a normal check.
  time = 1600; let flaky = 0;
  const recovered = await notifyPool({ ...options, inspect: async () => { if (flaky++ === 0) throw new Error('blip'); return observed(f.manifest, time); } });
  assert.equal(recovered.status, 'attention_required'); assert.equal(JSON.parse(r.data.get(stateKey)!).readFailures, 0);
  assert.equal(recovered.acceptedEmails, 0, 'nothing changed on chain, so nothing new to send');
  assert.equal(sends, 1);
});

test('read failures across pools send one email after two failed checks in a row, and one on recovery', () => {
  let state: any = { schema: 'flurbo.settlement-mail.v1', identity: 'x', checkpoint: null, report: null, signature: null, lastQueuedAt: 0, queue: [] };
  state = queueReadFailures(state, [], config, 1000); assert.equal(state.queue.length, 0);
  const two = [{ pool: '0x' + 'aa'.repeat(20), readFailures: 2 }, { pool: '0x' + 'bb'.repeat(20), readFailures: 3 }];
  state = queueReadFailures(state, two, config, 1000);
  assert.equal(state.queue.length, 1); assert.equal(state.queue[0].body.subject, 'Flurbo settlement monitor: chain reads failing');
  assert.match(state.queue[0].body.text, /for 2 pools on at least two checks in a row/); assert.match(state.queue[0].body.text, /UTC \(05:46 IST\)/);
  state = queueReadFailures(state, [...two].reverse(), config, 1600); assert.equal(state.queue.length, 1, 'same pools, no repeat within the hour');
  state = queueReadFailures(state, two, config, 4600); assert.equal(state.queue.length, 2, 'hourly reminder while failing');
  state = queueReadFailures(state, [], config, 4700);
  assert.equal(state.queue.length, 3); assert.equal(state.queue[2].body.subject, 'Flurbo settlement monitor: chain reads recovered');
  state = queueReadFailures(state, [], config, 4800); assert.equal(state.queue.length, 3);
});

test('queue capacity, recipient changes and corrupt state fail closed', async () => {
  let state: any = empty();
  for (let i = 0; i < 20; i++) state = queueReport(state, report(1000 + i), config, 1000 + i, { test: true });
  assert.throws(() => queueReport(state, report(), config, 1100, { test: true }), /queue full/);
  const f = pilotFixture(), r = redis();
  const options = { manifest: f.manifest, rpc: f.rpc, command: r.command, config, now: () => 1000,
    send: async () => { throw new Error('offline'); }, inspect: async () => observed(f.manifest, 1000) };
  await assert.rejects(notifyPool(options));
  await assert.rejects(notifyPool({ ...options, config: { ...config, to: ['changed@example.com'] } }), /Reconcile/);
  const key = [...r.data.keys()].find(k => k.endsWith(':state'))!;
  r.data.set(key, '{broken');
  await assert.rejects(notifyPool(options));
  assert.equal(r.data.get(key), '{broken');
});

test('email and watchdog transports reject redirects/errors and do not expose credentials', async () => {
  assert.throws(() => emailConfig({ FLURBO_MONITOR_EMAIL_TO: 'victim@example.com\nbcc:other@example.com' }));
  const item = queueReport(empty(), report(), config, 1000).queue[0];
  const send = resendDelivery(config, async () => new Response('re_test-secret', { status: 429 }));
  await assert.rejects(send(item), error => !String(error).includes('re_test-secret'));
  assert.throws(() => watchdog({ FLURBO_MONITOR_HEALTHCHECK_URL: 'http://localhost/internal' }));
  const urls: string[] = [];
  const ping = watchdog({ FLURBO_MONITOR_HEALTHCHECK_URL: 'https://hc-ping.com/00000000-0000-0000-0000-000000000000' },
    async (url: string, init: any) => { urls.push(url); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined); return new Response('OK'); });
  await ping(false); await ping(true);
  assert.ok(!urls[0].endsWith('/fail')); assert.ok(urls[1].endsWith('/fail'));
});

test('runner handles the pilot and practice pools, signals failed reads to watchdog, and redacts configuration errors', async () => {
  const r = redis(), pilot = pilotFixture().manifest, rehearsal = structuredClone(pilot);
  rehearsal.publication.mode = 'rehearsal'; rehearsal.rulesHash = '0x' + 'ab'.repeat(32);
  const env = { FLURBO_PILOT_MANIFEST_JSON: JSON.stringify(pilot),
    UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'storage-secret',
    FLURBO_MONITOR_EMAIL_FROM: config.from, FLURBO_MONITOR_EMAIL_TO: config.to[0], FLURBO_MONITOR_RESEND_KEY: config.key,
    FLURBO_MONITOR_HEALTHCHECK_URL: 'https://hc-ping.com/00000000-0000-0000-0000-000000000000' };
  const pings: string[] = [], output: string[] = [], subjects: string[] = [];
  const request = async (url: string, init: any) => {
    if (url.includes('upstash.io')) return Response.json({ result: await r.command(...JSON.parse(init.body)) });
    if (url === 'https://api.resend.com/emails') { subjects.push(JSON.parse(init.body).subject); return Response.json({ id: 'accepted-id' }); }
    pings.push(url); return new Response('OK');
  };
  const options = { env, args: [], request, now: () => 1000, output: (s: string) => output.push(s), wait: async () => {},
    inspect: async ({ manifest }: any) => observed(manifest, 1000) };
  assert.equal(await runNotifications(options), 0);
  assert.equal(output.length, 1);
  const extra=structuredClone(rehearsal);extra.pool='0x'+'aa'.repeat(20);extra.resolver='0x'+'bb'.repeat(20);
  extra.codeHashes[extra.pool]=rehearsal.codeHashes[rehearsal.pool];extra.codeHashes[extra.resolver]=rehearsal.codeHashes[rehearsal.resolver];
  const extraEnv={...env,FLURBO_PRACTICE_COLLECTIONS_JSON:JSON.stringify([{label:'October practice',manifest:extra}])};
  const before=output.length;assert.equal(await runNotifications({...options,env:extraEnv}),0);
  assert.equal(output.length-before,2);assert.ok(output.some(line=>JSON.parse(line).pool===extra.pool));
  const general=deterministicManifest();general.pool='0x'+'ac'.repeat(20);general.codeHashes[general.pool]=pilot.codeHashes[pilot.pool];
  // The resolver address remains committed; this extra does not share either configured pool or resolver.
  const {settlementBindings,pilotRulesHash}=await import('../server/settlement-publication.mjs');
  general.resolver='0x'+'ad'.repeat(20);general.codeHashes[general.resolver]=pilot.codeHashes[pilot.resolver];
  general.rulesHash=pilotRulesHash(settlementBindings(general.publication).config,general.resolver,general.publication.creator);
  const generalEnv={...env,FLURBO_PRACTICE_COLLECTIONS_JSON:JSON.stringify([{label:'Source test',manifest:general}])};
  const generalBefore=output.length;assert.equal(await runNotifications({...options,env:generalEnv}),0);assert.equal(output.length-generalBefore,2);
  general.publication.settlementRules[0].decision.value='4.3';
  assert.equal(await runNotifications({...options,env:{...generalEnv,FLURBO_PRACTICE_COLLECTIONS_JSON:JSON.stringify([{label:'Source test',manifest:general}])}}),2);
  assert.equal(await runNotifications({...options,env:generalEnv}),0);
  assert.ok(!pings.at(-1)!.endsWith('/fail'));
  assert.equal(await runNotifications({...options,env:{...env,FLURBO_PRACTICE_COLLECTIONS_JSON:JSON.stringify([{label:'Duplicate pool',manifest:rehearsal}])}}),2);
  // One failed check (after retries) pages nobody; the second in a row sends one email and fails the watchdog.
  const failingRead = { ...options, inspect: async () => { throw new Error('storage-secret'); } };
  const mailBefore = subjects.length;
  assert.equal(await runNotifications(failingRead), 0);
  assert.ok(!pings.at(-1)!.endsWith('/fail')); assert.equal(subjects.length, mailBefore);
  assert.equal(await runNotifications(failingRead), 2);
  assert.ok(pings.at(-1)!.endsWith('/fail'));
  assert.deepEqual(subjects.slice(mailBefore), ['Flurbo settlement monitor: chain reads failing']);
  assert.equal(await runNotifications(options), 0);
  assert.deepEqual(subjects.slice(mailBefore), ['Flurbo settlement monitor: chain reads failing', 'Flurbo settlement monitor: chain reads recovered']);
  assert.ok(!output.join('').includes('storage-secret'));
  assert.equal(await runNotifications({ ...options, env: { ...env, FLURBO_MONITOR_RESEND_KEY: '' } }), 2);
});

test('bot schedule: a pool far from due is re-read only every few minutes, a settled one once; registry pools are watched', async () => {
  const r = redis(), pilot = pilotFixture().manifest, general = deterministicManifest();
  general.pool = '0x' + 'ac'.repeat(20); general.resolver = '0x' + 'ad'.repeat(20);
  general.codeHashes = { [general.pool]: pilot.codeHashes[pilot.pool], [general.resolver]: pilot.codeHashes[pilot.resolver] };
  const { settlementBindings, pilotRulesHash } = await import('../server/settlement-publication.mjs');
  general.rulesHash = pilotRulesHash(settlementBindings(general.publication).config, general.resolver, general.publication.creator);
  const registry = { schema: 'flurbo.collections.v1', featured: general.pool, pilotSettlement: 'finish-only',
    collections: [{ label: 'Source test', settlement: 'auto', status: 'active', manifest: general }] };
  const env = { FLURBO_PILOT_MANIFEST_JSON: JSON.stringify(pilot), FLURBO_COLLECTIONS_SOURCE: 'registry',
    UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'storage-secret',
    FLURBO_MONITOR_EMAIL_FROM: config.from, FLURBO_MONITOR_EMAIL_TO: config.to[0], FLURBO_MONITOR_RESEND_KEY: config.key,
    FLURBO_MONITOR_HEALTHCHECK_URL: 'https://hc-ping.com/00000000-0000-0000-0000-000000000000' };
  const request = async (url: string, init: any) => url.includes('upstash.io') ? Response.json({ result: await r.command(...JSON.parse(init.body)) })
    : url === 'https://api.resend.com/emails' ? Response.json({ id: 'accepted-id' }) : new Response('OK');
  let time = 10_000, settled = false;
  const reads: string[] = [], output: string[] = [], schedule = new Map();
  // The pilot is quiet for two hours; the registry pool is quiet until it settles.
  const inspect = async ({ manifest }: any) => {
    reads.push(manifest.pool);
    const o: any = observed(manifest, time, false);
    o.report.snapshot.timestamp = time; o.report.events = [{ ...o.report.events[0], phase: 'Pending' }];
    o.report.timing = { observationEnds: [time + 7200] };
    if (settled && manifest.pool === general.pool) { o.report.lifecycle = 'settled'; o.checkpoint.delivered = true; }
    return o;
  };
  const options = { env, args: [], request, now: () => time, output: (s: string) => output.push(s), wait: async () => {}, inspect, schedule,
    readRegistry: async () => JSON.stringify(registry) };
  assert.equal(await runNotifications(options), 0);
  assert.deepEqual(reads, [pilot.pool, general.pool], 'the registry pool is watched beside the pilot');
  time += 120; assert.equal(await runNotifications(options), 0);
  assert.equal(reads.length, 2, 'two minutes later nothing is due soon, so nothing is re-read');
  const skipped = output.slice(-2).map(line => JSON.parse(line));
  assert.deepEqual(skipped.map(s => [s.status, s.nextDueAt]), [['skipped', 10_000 + 7200], ['skipped', 10_000 + 7200]]);
  time += 480; settled = true; assert.equal(await runNotifications(options), 0);
  assert.equal(reads.length, 4, 'after the recheck interval both are read again');
  time += 3600; assert.equal(await runNotifications(options), 0);
  assert.deepEqual(reads.slice(4), [pilot.pool], 'a settled pool is not read again');
  // Without the bot's schedule (GitHub job, CLI) every pool is read on every run.
  const before = reads.length; assert.equal(await runNotifications({ ...options, schedule: null }), 0);
  assert.equal(reads.length - before, 2);
});

test('next due time follows observation ends, deadlines and delivery; repeated observations skip rewriting state', async () => {
  const { nextDueAt, CHECKPOINT_REFRESH_SECONDS } = await import('../scripts/notify-settlement.mjs');
  const report = (events: any[], lifecycle = 'trading_closed') => ({ lifecycle, snapshot: { timestamp: 1000 }, timing: { observationEnds: [5000, 9000] }, events });
  assert.equal(nextDueAt(report([{ event: 0, phase: 'Pending', deadline: 5000 }, { event: 1, phase: 'Pending', deadline: 9000 }])), 5000);
  assert.equal(nextDueAt(report([{ event: 0, phase: 'Asserted', deadline: 4600 }, { event: 1, phase: 'Pending', deadline: 9000 }])), 4600);
  assert.equal(nextDueAt({ ...report([{ event: 0, phase: 'Pending', deadline: 8600 }]), timing: { observationEnds: [500] } }), 1000, 'assertion window open: due now');
  assert.equal(nextDueAt(report([{ event: 0, phase: 'Finalized', deadline: null }])), 1000, 'all final, delivery due now');
  assert.equal(nextDueAt(report([], 'settled')), 'none');
  // Saves: the first observation is written; an identical one within the refresh window is not; later it is again.
  const f = pilotFixture(), r = redis(); let time = 1000, saves = 0;
  const command = async (...c: any[]) => { if (c[0] === 'EVAL' && c.includes('save')) saves++; return r.command(...c); };
  const options = { manifest: f.manifest, rpc: f.rpc, command, config, now: () => time, wait: async () => {},
    send: async () => 'accepted-id', inspect: async () => observed(f.manifest, time) };
  await notifyPool(options); const first = saves;
  time += 120; await notifyPool(options); assert.equal(saves, first, 'unchanged observation not rewritten');
  time += CHECKPOINT_REFRESH_SECONDS; await notifyPool(options); assert.equal(saves, first + 1, 'refreshed before the freshness limit');
});
