// Opt-in in-process scheduler for hosts without a reliable free cron, enabled with
// FLURBO_SETTLEMENT_BOT=true. Each cycle runs one monitor pass, then the resolution worker with the
// same bounded drain as `run-resolution.mjs --drain`. Cycles never overlap. Durable state, leases and
// signer journals stay in Redis, so a restart only skips a cycle and a second runner cannot double-act.
const ACTIVE = ['submitted', 'resubmitted', 'confirmed'];
// Near anything due (an observation window ending, an open assertion window, a challenge or vote deadline,
// delivery) the bot runs every intervalMs. When every pool's next due time is further away than FAST_LEAD, it
// runs every idleIntervalMs instead, waking FAST_LEAD before the next due time. Unknown state is treated as due.
const FAST_LEAD_SECONDS = 15 * 60;
export function nextPeriod({ intervalMs, idleIntervalMs, nextDue, monitor, worker, nowSeconds }) {
  const workerIdle = !ACTIVE.includes(worker) && worker !== 'drain_limit';
  if (nextDue === null || !workerIdle || monitor !== 'ok') return intervalMs;
  if (nextDue === 'none') return idleIntervalMs;
  return Math.max(intervalMs, Math.min(idleIntervalMs, (nextDue - FAST_LEAD_SECONDS - nowSeconds) * 1000));
}

export function settlementBot({ env = process.env, intervalMs = 120_000, idleIntervalMs = 600_000, firstDelayMs = 30_000, log = console.log,
  monitor = null,
  // One schedule (pool -> last monitor read and next due time) and one retained-capture cache for the life of the
  // process: the monitor re-reads pools far from their next action less often, and the worker skips their chain reads.
  poolSchedule = new Map(), retainedCaptures = new Set(),
  resolve = async () => (await import('../scripts/run-resolution.mjs')).runResolution(env, { schedule: poolSchedule, retainedCaptures }),
  failure = async error => (await import('../scripts/run-resolution.mjs')).resolutionFailure(error),
  metrics = null, funds = null, notices = null, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw Error('Settlement cycles must be at least one minute apart');
  if (!Number.isSafeInteger(idleIntervalMs) || idleIntervalMs < intervalMs || idleIntervalMs > 600_000) throw Error('Idle cycles must be between the normal interval and ten minutes');
  let timer = null, stopped = true, running = false, nextDue = null;
  // The default monitor reads each pool's next due time from its report line; an injected monitor leaves it
  // unknown, which keeps the normal interval.
  monitor ??= async () => {
    let due = 'none';
    const code = await (await import('../scripts/notify-settlement.mjs')).runNotifications({ env, args: [], schedule: poolSchedule, output: line => {
      log('[settlement-monitor] ' + line);
      let value; try { value = JSON.parse(line).nextDueAt; } catch { value = null; }
      if (due === null || value === 'none') return;
      due = Number.isSafeInteger(value) ? (due === 'none' ? value : Math.min(due, value)) : null;
    } });
    nextDue = code === 0 ? due : null;
    return code;
  };
  const status = { enabled: true, intervalSeconds: intervalMs / 1000, idleIntervalSeconds: idleIntervalMs / 1000, cadence: 'normal', nextDueAt: null, cycles: 0, lastStartedAt: null, lastFinishedAt: null, monitor: 'not_run', worker: 'not_run', metrics: metrics ? 'not_run' : 'disabled', funds: funds ? 'not_run' : 'disabled', notices: notices ? 'not_run' : 'disabled' };

  async function work() {
    const deadline = now() + 150_000;
    for (let pass = 0; pass < 12; pass++) {
      let result;
      try { result = await resolve(); } catch (error) { const report = await failure(error); log('[settlement-worker] ' + JSON.stringify(report)); return report.code || 'resolution_stopped'; }
      log('[settlement-worker] ' + JSON.stringify(result));
      if (!ACTIVE.includes(result?.status) || now() > deadline) return String(result?.status || 'unknown');
      await sleep(4_000);
    }
    return 'drain_limit';
  }

  async function cycle() {
    if (running || stopped) return;
    running = true; status.cycles++; status.lastStartedAt = new Date(now()).toISOString(); nextDue = null;
    try {
      if (env.FLURBO_MONITOR_ENABLED === 'true') {
        try { status.monitor = (await monitor()) === 0 ? 'ok' : 'attention'; } catch { status.monitor = 'failed'; log('[settlement-monitor] {"status":"notification_failed"}'); }
      } else status.monitor = 'disabled';
      // Like the scheduled Actions worker, this runs even after a failed monitor pass. The worker
      // itself refuses pools whose monitoring is stale and can still finish healthy ones.
      try { status.worker = env.FLURBO_RESOLUTION_ENABLED === 'true' ? await work() : 'disabled'; } catch { status.worker = 'failed'; }
      // Operator metrics run last, so settlement never waits on them, and a metrics failure never stops settlement.
      if (metrics && !stopped) {
        try { status.metrics = String(await metrics()); } catch { status.metrics = 'failed'; log('[metrics] {"status":"failed"}'); }
      }
      if (funds && !stopped) {
        try { status.funds = String(await funds()); } catch { status.funds = 'failed'; log('[funds] {"status":"failed"}'); }
      }
      if (notices && !stopped) {
        try { status.notices = String(await notices()); } catch { status.notices = 'failed'; log('[notices] {"status":"failed"}'); }
      }
    } finally {
      running = false; status.lastFinishedAt = new Date(now()).toISOString();
      // Idle only when the monitor ran cleanly and nothing is due soon; an active worker keeps the normal interval.
      const period = nextPeriod({ intervalMs, idleIntervalMs, nextDue, monitor: status.monitor, worker: status.worker, nowSeconds: now() / 1000 });
      status.cadence = period > intervalMs ? 'idle' : 'normal';
      status.nextDueAt = typeof nextDue === 'number' ? new Date(nextDue * 1000).toISOString() : nextDue;
      if (!stopped) timer = schedule(cycle, Math.max(1_000, period - (Date.parse(status.lastFinishedAt) - Date.parse(status.lastStartedAt))));
    }
  }

  return {
    start() { if (!stopped) return; stopped = false; timer = schedule(cycle, firstDelayMs); },
    stop() { stopped = true; if (timer) cancel(timer); timer = null; },
    status: () => ({ ...status, running }),
  };
}
