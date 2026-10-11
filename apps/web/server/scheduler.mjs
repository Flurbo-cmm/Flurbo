// Opt-in in-process scheduler for hosts without a reliable free cron, enabled with FLURBO_SCHEDULER=true.
// Each cycle refreshes agent pools that are still pending, then advances operator metrics, funding alerts and
// member notices. Cycles never overlap, and one task failing never stops the others.
const TASKS = ['agentPools', 'metrics', 'funds', 'notices'];

export function periodicTasks({ intervalMs = 120_000, firstDelayMs = 30_000, log = console.log,
  tasks = {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw Error('Cycles must be at least one minute apart');
  let timer = null, stopped = true, running = false;
  const status = { enabled: true, intervalSeconds: intervalMs / 1000, cycles: 0, lastStartedAt: null, lastFinishedAt: null,
    ...Object.fromEntries(TASKS.map(name => [name, tasks[name] ? 'not_run' : 'disabled'])) };

  async function cycle() {
    if (running || stopped) return;
    running = true; status.cycles++; status.lastStartedAt = new Date(now()).toISOString();
    try {
      for (const name of TASKS) {
        if (!tasks[name] || stopped) continue;
        try { status[name] = String(await tasks[name]()); } catch { status[name] = 'failed'; log(`[${name}] {"status":"failed"}`); }
      }
    } finally {
      running = false; status.lastFinishedAt = new Date(now()).toISOString();
      if (!stopped) timer = schedule(cycle, Math.max(1_000, intervalMs - (Date.parse(status.lastFinishedAt) - Date.parse(status.lastStartedAt))));
    }
  }

  return {
    start() { if (!stopped) return; stopped = false; timer = schedule(cycle, firstDelayMs); },
    stop() { stopped = true; if (timer) cancel(timer); timer = null; },
    status: () => ({ ...status, running }),
  };
}
