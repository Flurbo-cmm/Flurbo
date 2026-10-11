import assert from 'node:assert/strict';
import { test } from 'node:test';
import { periodicTasks } from '../server/scheduler.mjs';

// A manual clock and timer queue: each scheduled callback runs only when the test fires it.
function harness() {
  let clock = 1_800_000_000_000;
  const timers: { fn: () => unknown; ms: number; id: number }[] = [], cancelled: number[] = [], logs: string[] = [];
  let next = 0;
  return {
    timers, cancelled, logs,
    now: () => clock, advance: (ms: number) => { clock += ms; },
    schedule: (fn: () => unknown, ms: number) => { const id = ++next; timers.push({ fn, ms, id }); return id; },
    cancel: (id: number) => { cancelled.push(id); },
    log: (line: string) => { logs.push(line); },
    async fire() { const timer = timers.shift(); assert.ok(timer, 'a cycle is scheduled'); await timer.fn(); return timer; },
  };
}

test('cycles must be at least one minute apart', () => {
  assert.throws(() => periodicTasks({ intervalMs: 59_999 }), /one minute/);
  assert.throws(() => periodicTasks({ intervalMs: 90_000.5 }), /one minute/);
  assert.doesNotThrow(() => periodicTasks({ intervalMs: 60_000 }));
});

test('tasks run in order, absent tasks are disabled, and a failure is logged without its text', async () => {
  const h = harness(), order: string[] = [];
  const scheduler = periodicTasks({ log: h.log, now: h.now, schedule: h.schedule, cancel: h.cancel, tasks: {
    agentPools: async () => { order.push('agentPools'); return 'idle'; },
    metrics: async () => { order.push('metrics'); throw Error('upstream said secret-token-123'); },
    notices: async () => { order.push('notices'); return 'sent 2'; } } });
  const before = scheduler.status();
  assert.deepEqual(Object.keys(before).sort(), ['agentPools', 'cycles', 'enabled', 'funds', 'intervalSeconds', 'lastFinishedAt', 'lastStartedAt', 'metrics', 'notices', 'running'].sort());
  assert.deepEqual(before, { enabled: true, intervalSeconds: 120, cycles: 0, lastStartedAt: null, lastFinishedAt: null, running: false,
    agentPools: 'not_run', metrics: 'not_run', funds: 'disabled', notices: 'not_run' });
  scheduler.start();
  assert.equal(h.timers[0].ms, 30_000);
  await h.fire();
  assert.deepEqual(order, ['agentPools', 'metrics', 'notices']);
  const after = scheduler.status();
  assert.equal(after.agentPools, 'idle'); assert.equal(after.metrics, 'failed'); assert.equal(after.funds, 'disabled'); assert.equal(after.notices, 'sent 2');
  assert.equal(after.cycles, 1); assert.equal(after.running, false);
  assert.equal(after.lastStartedAt, new Date(1_800_000_000_000).toISOString()); assert.equal(after.lastFinishedAt, new Date(1_800_000_000_000).toISOString());
  assert.deepEqual(h.logs, ['[metrics] {"status":"failed"}']);
  assert.ok(!h.logs.join('').includes('secret'));
});

test('the next cycle waits the interval minus the time the cycle took, at least one second', async () => {
  const h = harness();
  let took = 5_000;
  const scheduler = periodicTasks({ intervalMs: 60_000, firstDelayMs: 10, now: h.now, schedule: h.schedule, cancel: h.cancel, log: h.log,
    tasks: { metrics: async () => { h.advance(took); return 'ok'; } } });
  scheduler.start();
  assert.equal(h.timers[0].ms, 10);
  await h.fire();
  assert.equal(h.timers[0].ms, 55_000);
  took = 70_000; await h.fire();
  assert.equal(h.timers[0].ms, 1_000);
  assert.equal(scheduler.status().cycles, 2);
});

test('cycles never overlap, a second start is ignored, and stop cancels the timer', async () => {
  const h = harness();
  let release: () => void = () => {}, runs = 0;
  const scheduler = periodicTasks({ now: h.now, schedule: h.schedule, cancel: h.cancel, log: h.log,
    tasks: { funds: () => { runs++; return new Promise<string>(done => { release = () => done('ok'); }); } } });
  scheduler.start(); scheduler.start();
  assert.equal(h.timers.length, 1);
  const first = h.timers.shift()!;
  const running = first.fn();
  assert.equal(scheduler.status().running, true);
  await first.fn();
  assert.equal(runs, 1, 'a cycle does not start while another runs');
  release(); await running;
  assert.equal(scheduler.status().running, false); assert.equal(scheduler.status().funds, 'ok');
  assert.equal(h.timers.length, 1);
  const pending = h.timers[0];
  scheduler.stop();
  assert.deepEqual(h.cancelled, [pending.id]);
  await pending.fn();
  assert.equal(runs, 1, 'no task runs after stop');
  assert.equal(scheduler.status().cycles, 1);
});

test('stop during a cycle skips the remaining tasks and schedules nothing', async () => {
  const h = harness(), order: string[] = [];
  let scheduler: ReturnType<typeof periodicTasks>;
  scheduler = periodicTasks({ now: h.now, schedule: h.schedule, cancel: h.cancel, log: h.log, tasks: {
    agentPools: async () => { order.push('agentPools'); scheduler.stop(); return 'added 1, pending 0'; },
    notices: async () => { order.push('notices'); return 'sent 0'; } } });
  scheduler.start();
  await h.fire();
  assert.deepEqual(order, ['agentPools']);
  assert.equal(h.timers.length, 0);
  assert.equal(scheduler.status().agentPools, 'added 1, pending 0'); assert.equal(scheduler.status().notices, 'not_run');
});
