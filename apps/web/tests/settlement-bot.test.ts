import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementBot } from '../server/settlement-bot.mjs';

function harness(env: Record<string, string>, results: any[] = [{ status: 'wait' }]) {
  const calls: string[] = [], timers: { fn: () => Promise<void>; ms: number }[] = [], logs: string[] = [];
  let clock = 1_800_000_000_000;
  const bot = settlementBot({
    env, log: line => logs.push(line), now: () => clock,
    monitor: async () => { calls.push('monitor'); clock += 5_000; return 0; },
    resolve: async () => { calls.push('worker'); const next = results.shift(); if (next instanceof Error) throw next; return next ?? { status: 'wait' }; },
    failure: async () => ({ status: 'resolution_stopped', code: 'WORKER_CHECK_FAILED' }),
    sleep: async ms => { calls.push('sleep:' + ms); clock += ms; },
    schedule: ((fn: () => Promise<void>, ms: number) => { timers.push({ fn, ms }); return timers.length; }) as any,
    cancel: (() => { timers.length = 0; }) as any,
  });
  return { bot, calls, timers, logs, run: async () => { const next = timers.shift()!; await next.fn(); return next.ms; } };
}
const both = { FLURBO_MONITOR_ENABLED: 'true', FLURBO_RESOLUTION_ENABLED: 'true' };

test('each cycle monitors first, then drains the worker while transactions progress, and never overlaps', async () => {
  const h = harness(both, [{ status: 'submitted' }, { status: 'confirmed' }, { status: 'wait' }]);
  h.bot.start();
  assert.equal(await h.run(), 30_000);
  assert.deepEqual(h.calls, ['monitor', 'worker', 'sleep:4000', 'worker', 'sleep:4000', 'worker']);
  const status = h.bot.status();
  assert.equal(status.monitor, 'ok'); assert.equal(status.worker, 'wait'); assert.equal(status.cycles, 1); assert.equal(status.running, false);
  // The next cycle starts one interval after the previous one began, not after it finished.
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 120_000 - 13_000);
  assert.ok(h.logs.every(line => line.startsWith('[settlement-')));
  h.bot.stop(); assert.equal(h.timers.length, 0);
});

test('switches mirror the Actions variables, and a failed monitor or worker never stops the schedule', async () => {
  const off = harness({ FLURBO_MONITOR_ENABLED: 'false', FLURBO_RESOLUTION_ENABLED: 'true' });
  off.bot.start(); await off.run();
  assert.deepEqual(off.calls, ['worker']); assert.equal(off.bot.status().monitor, 'disabled');

  const quiet = harness({ FLURBO_MONITOR_ENABLED: 'true' });
  quiet.bot.start(); await quiet.run();
  assert.deepEqual(quiet.calls, ['monitor']); assert.equal(quiet.bot.status().worker, 'disabled');

  const failing = harness(both, [new Error('private detail')]);
  failing.bot.start(); await failing.run();
  assert.equal(failing.bot.status().worker, 'WORKER_CHECK_FAILED');
  assert.ok(!failing.logs.join('').includes('private detail'));
  assert.equal(failing.timers.length, 1, 'the next cycle is still scheduled');

  const queued: (() => Promise<void>)[] = [];
  const broken = settlementBot({ env: both, log: () => {}, monitor: async () => { throw Error('down'); }, resolve: async () => ({ status: 'wait' }),
    schedule: ((fn: () => Promise<void>) => { queued.push(fn); return 1; }) as any, cancel: (() => {}) as any });
  broken.start(); await queued.shift()!();
  assert.equal(broken.status().monitor, 'failed'); assert.equal(broken.status().worker, 'wait'); assert.equal(queued.length, 1);
});

test('cycles cannot run more often than once a minute', () => {
  assert.throws(() => settlementBot({ env: both, intervalMs: 30_000 }), /one minute/);
});

test('the real monitor and worker load and fail closed, offline, when hosting settings are missing', async () => {
  const logs: string[] = [], queued: (() => Promise<void>)[] = [];
  const bot = settlementBot({ env: both, log: line => logs.push(line), schedule: ((fn: () => Promise<void>) => { queued.push(fn); return 1; }) as any, cancel: (() => {}) as any });
  bot.start(); await queued.shift()!();
  assert.equal(bot.status().monitor, 'attention');
  assert.equal(bot.status().worker, 'CONFIGURATION_INVALID');
  assert.ok(logs.some(line => line.includes('notification_failed')) && logs.some(line => line.includes('resolution_stopped')));
  bot.stop();
});

test('a single local check forces execution off and reports the cycle', async () => {
  const { runSettlementBotOnce } = await import('../scripts/run-settlement-bot-once.mjs');
  let seen: any = null;
  const factory = (options: any) => { seen = options.env; return settlementBot({ ...options, monitor: async () => 0, resolve: async () => ({ status: 'wait' }) }); };
  const status = await runSettlementBotOnce({ env: { ...both, FLURBO_RESOLUTION_EXECUTE: 'true' }, log: () => {}, factory });
  assert.equal(seen.FLURBO_RESOLUTION_EXECUTE, 'false');
  assert.equal(status.cycles, 1); assert.equal(status.monitor, 'ok'); assert.equal(status.worker, 'wait');
});

test('operator metrics run after the worker each cycle, and a metrics failure never touches settlement', async () => {
  const calls: string[] = [], timers: { fn: () => Promise<void> }[] = [];
  let fail = false;
  const bot = settlementBot({ env: both, log: () => {}, monitor: async () => { calls.push('monitor'); return 0; },
    resolve: async () => { calls.push('worker'); return { status: 'wait' }; }, failure: async () => ({}),
    metrics: async () => { calls.push('metrics'); if (fail) throw Error('redis down'); return 'synced; digest not_due'; },
    schedule: ((fn: () => Promise<void>) => { timers.push({ fn }); return 1; }) as any, cancel: (() => {}) as any });
  assert.equal(bot.status().metrics, 'not_run');
  bot.start(); await timers.shift()!.fn();
  assert.deepEqual(calls, ['monitor', 'worker', 'metrics']);
  assert.equal(bot.status().metrics, 'synced; digest not_due');
  fail = true; await timers.shift()!.fn();
  assert.equal(bot.status().metrics, 'failed'); assert.equal(bot.status().worker, 'wait'); assert.equal(timers.length, 1);
  bot.stop();
  assert.equal(settlementBot({ env: both }).status().metrics, 'disabled');
  assert.equal(settlementBot({ env: both }).status().notices, 'disabled');
  assert.equal(settlementBot({ env: both, notices: async () => 'idle' }).status().notices, 'not_run');
});

test('the bot runs every 2 minutes near anything due and every 10 minutes otherwise', async () => {
  const { nextPeriod } = await import('../server/settlement-bot.mjs');
  const base = { intervalMs: 120_000, idleIntervalMs: 600_000, monitor: 'ok', worker: 'wait', nowSeconds: 1_000_000 };
  assert.equal(nextPeriod({ ...base, nextDue: 'none' }), 600_000, 'every pool delivered');
  assert.equal(nextPeriod({ ...base, nextDue: 1_000_000 + 86_400 }), 600_000, 'next deadline a day away');
  assert.equal(nextPeriod({ ...base, nextDue: 1_000_000 + 15 * 60 + 300 }), 300_000, 'wakes 15 minutes before it is due');
  assert.equal(nextPeriod({ ...base, nextDue: 1_000_000 + 600 }), 120_000, 'due within 15 minutes');
  assert.equal(nextPeriod({ ...base, nextDue: 1_000_000 }), 120_000, 'window open now');
  assert.equal(nextPeriod({ ...base, nextDue: null }), 120_000, 'unknown state');
  assert.equal(nextPeriod({ ...base, nextDue: 'none', monitor: 'attention' }), 120_000, 'monitor not clean');
  assert.equal(nextPeriod({ ...base, nextDue: 'none', worker: 'submitted' }), 120_000, 'transaction in flight');
  assert.equal(nextPeriod({ ...base, nextDue: 'none', worker: 'drain_limit' }), 120_000);
});
