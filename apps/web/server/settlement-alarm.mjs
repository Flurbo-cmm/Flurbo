// Settlement alarm: wakes the existing GitHub monitor (which then triggers the worker) when an automatic
// resolver action is due, or when monitoring has gone stale while any market is in an unresolved phase.
// It holds no signing key, no RPC secret and no Redis credential. It reads public chain state and GitHub
// run history; its writes are a workflow dispatch and an optional Healthchecks ping.
// Runtime-neutral: no Node built-ins, so the same code can be bundled for a scheduled edge function.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { resolverAbi } from '../shared/pilot.mjs';
import { settlementCalendar, dueEntries, nextWake } from '../shared/settlement-calendar.mjs';
import { proposerHoldings, proposerStatus } from './proposer-guard.mjs';

export const ALARM_DEFAULTS = Object.freeze({
  minRedispatchSeconds: 600,   // Retry cadence while the same work stays unresolved.
  recoverySeconds: 1800,       // Wake the worker anyway when the calendar is unavailable and nothing ran recently.
  maxSkewSeconds: 300,         // A chain snapshot further than this from the alarm clock is stale.
  stuckRunSeconds: 1800,       // An active run older than this is reported as stuck, not duplicated.
  monitorIntervalSeconds: 600, // Refresh monitoring this often while any market is in an unresolved phase.
  monitorAlertSeconds: 1800,   // Monitoring older than this during an unresolved phase is a health failure.
  preflightIntervalSeconds: 600, // Proposer holdings preflight cadence while a proposal is still ahead.
});
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const address = value => /^0x[0-9a-f]{40}$/.test(value);
// Canonical Multicall3 (listed by viem for Monad testnet). The public RPC rate-limits each batched
// call separately, so every read goes through one aggregate3 call at a pinned block.
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const multicallAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

// Public subset of verified manifests. Nothing here is secret.
export function alarmConfig(input) {
  const c = { ...ALARM_DEFAULTS, ...input };
  if (!/^[\w.-]+\/[\w.-]+$/.test(c.repository || '') || c.repository.includes('..') || !/^[\w.-]+\.ya?ml$/.test(c.monitorWorkflow || '')
    || !/^[\w.-]+\.ya?ml$/.test(c.workerWorkflow || '') || !address(String(c.signer).toLowerCase())
    || !Array.isArray(c.pools) || !c.pools.length) throw new Error('Invalid alarm configuration');
  for (const k of Object.keys(ALARM_DEFAULTS)) if (!Number.isSafeInteger(c[k]) || c[k] <= 0) throw new Error('Invalid alarm configuration');
  const pools = c.pools.map(p => {
    if (!address(p.pool) || !address(p.resolver) || !['rehearsal', 'ethereum-activity', 'deterministic-source-v1', 'release'].includes(p.mode)
      || typeof p.evidence !== 'boolean' || !Array.isArray(p.observationEnds) || !p.observationEnds.length
      || p.observationEnds.some(t => !Number.isSafeInteger(t))) throw new Error('Invalid alarm pool');
    return { ...p };
  });
  if (new Set(pools.map(p => p.pool)).size !== pools.length || pools.filter(p => p.evidence).length > 1) throw new Error('Invalid alarm pools');
  return { ...c, signer: c.signer.toLowerCase(), pools };
}

export function alarmPoolsFromManifests(manifests, evidencePool = null) {
  return manifests.map(m => ({
    pool: m.pool.toLowerCase(), resolver: m.resolver.toLowerCase(),
    mode: ['rehearsal', 'ethereum-activity', 'deterministic-source-v1'].includes(m.publication.mode) ? m.publication.mode : 'release',
    evidence: !!evidencePool && m.pool.toLowerCase() === evidencePool.toLowerCase(),
    observationEnds: m.publication.draft.events.map(e => e.observationEndsAt),
  }));
}

// Two requests per tick: the latest block, then one Multicall3 read of every pool at that block.
export function jsonRpc(endpoint, fetcher = fetch) {
  return async (method, params) => {
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!response.ok) throw new Error('RPC unavailable');
    const body = await response.json();
    if (body?.error || body?.result === undefined) throw new Error('RPC call failed');
    return body.result;
  };
}

const safe = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid resolver value'); return n; };

// Each pool is read and validated independently. One reverting, misconfigured or malformed resolver is
// reported in `failed` and never removes the calendars of healthy pools.
export async function readCalendars(config, rpc) {
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block?.number || !block?.timestamp || !block?.hash) throw new Error('Invalid block');
  const calls = [], groups = [];
  const call = (target, functionName, args = []) => calls.push({ target, functionName, callData: encodeFunctionData({ abi: resolverAbi, functionName, args }) });
  for (const p of config.pools) {
    const start = calls.length;
    call(p.resolver, 'delivered');
    p.observationEnds.forEach((_, i) => { call(p.resolver, 'caseState', [i]); call(p.resolver, 'assertionDeadline', [i]); });
    groups.push([start, calls.length]);
  }
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3',
    args: [calls.map(c => ({ target: c.target, allowFailure: true, callData: c.callData }))] });
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3',
    data: await rpc('eth_call', [{ to: MULTICALL3, data }, block.number]) });
  if (!Array.isArray(results) || results.length !== calls.length) throw new Error('Invalid multicall result');
  const snapshot = { blockNumber: String(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)) };
  const calendars = [], failed = [];
  config.pools.forEach((p, index) => {
    try {
      const [start, end] = groups[index];
      const decode = i => {
        if (!results[i].success) throw new Error('Resolver call failed');
        return decodeFunctionResult({ abi: resolverAbi, functionName: calls[i].functionName, data: results[i].returnData });
      };
      let i = start;
      const delivered = decode(i++);
      if (typeof delivered !== 'boolean') throw new Error('Invalid delivery flag');
      const cases = p.observationEnds.map(observationEnd => {
        const c = decode(i++), assertionDeadline = safe(decode(i++));
        const phase = Number(c.phase);
        if (!(phase >= 0 && phase <= 3) || assertionDeadline < observationEnd) throw new Error('Invalid resolver case');
        return { phase, proposal: Number(c.proposal), asserter: c.asserter, evidenceHash: c.evidenceHash,
          challengeUntil: String(safe(c.challengeUntil)), voteUntil: String(safe(c.voteUntil)), assertionDeadline: String(assertionDeadline) };
      });
      if (i !== end) throw new Error('Read misaligned');
      const state = { manifest: { pool: p.pool, publication: { mode: p.mode, draft: { events: p.observationEnds.map(t => ({ observationEndsAt: t })) } } },
        snapshot, delivered, cases };
      calendars.push(settlementCalendar(state, { owner: config.signer, owned: null, evidence: p.evidence }));
    } catch { failed.push({ pool: p.pool, reason: 'resolver-read-failed' }); }
  });
  return { snapshot, calendars, failed };
}

const seconds = iso => Math.floor(Date.parse(iso) / 1000);

// Pure decision. GitHub concurrency groups remain the hard guarantee against parallel runs;
// this only avoids pointless or repeated dispatches.
export function alarmDecision({ now, calendars = null, failed = [], calendarError = null, runs = null, runsError = null, config }) {
  // Without run history the alarm can neither deduplicate nor judge freshness; fail closed.
  if (runsError || !Array.isArray(runs)) return { action: 'skip', reason: 'run-history-unavailable' };
  // Freshness = completion time of the last monitor run that concluded success. That conclusion certifies
  // every pool was read and every alert delivered (notify-settlement exits non-zero otherwise).
  // Start times are used only to rate-limit dispatches, never as evidence of monitoring.
  const completions = runs.filter(r => r.workflow === config.monitorWorkflow && r.conclusion === 'success').map(r => seconds(r.updated_at)).filter(Number.isFinite);
  const lastMonitorSuccess = completions.length ? Math.max(...completions) : null;
  const monitorAgeSeconds = lastMonitorSuccess === null ? null : now - lastMonitorSuccess;
  // Every alarm timer runs on MONITOR runs only: the alarm dispatches the monitor, and the worker follows it.
  // Scheduled or chained worker runs must never postpone a monitor refresh, retry or recovery. A worker run
  // that is stuck is reported (degraded health) but does not block dispatching the monitor.
  const monitorRuns = runs.filter(r => r.workflow === config.monitorWorkflow);
  const workerStuck = runs.some(r => r.workflow === config.workerWorkflow && ACTIVE.has(r.status) && now - seconds(r.created_at) > config.stuckRunSeconds);
  const context = { lastMonitorSuccess, monitorAgeSeconds, failedPools: failed.map(f => f.pool), ...(workerStuck ? { workerStuck } : {}) };
  const active = monitorRuns.filter(r => ACTIVE.has(r.status));
  if (active.length) {
    const oldest = Math.min(...active.map(r => seconds(r.created_at)));
    return { action: 'skip', reason: now - oldest > config.stuckRunSeconds ? 'stuck-run' : 'in-flight', ...context };
  }
  const starts = monitorRuns.map(r => seconds(r.created_at)).filter(Number.isFinite);
  const lastRun = starts.length ? Math.max(...starts) : null;
  const sinceLastRun = lastRun === null ? Infinity : now - lastRun;
  const stale = !calendarError && Array.isArray(calendars) && calendars.some(c => Math.abs(now - c.snapshot.timestamp) > config.maxSkewSeconds);
  if (calendarError || !Array.isArray(calendars) || stale) {
    // Recovery: the alarm cannot see what is due, so it wakes the monitor and worker at a slow, bounded cadence.
    if (sinceLastRun >= config.recoverySeconds) return { action: 'dispatch', reason: 'recovery', detail: stale ? 'stale-calendar' : 'calendar-unavailable', ...context };
    return { action: 'skip', reason: stale ? 'stale-calendar' : 'calendar-unavailable', ...context };
  }
  // Pools needing observation: any unresolved phase, plus pools whose read failed (state unknown).
  const watching = [...calendars.filter(c => c.watch?.length).map(c => c.pool), ...context.failedPools];
  const monitorStale = watching.length > 0 && (monitorAgeSeconds === null || monitorAgeSeconds >= config.monitorIntervalSeconds);
  const monitorOverdue = watching.length > 0 && (monitorAgeSeconds === null || monitorAgeSeconds >= config.monitorAlertSeconds);
  const due = calendars.flatMap(c => dueEntries(c, now).map(e => ({ ...e, pool: c.pool })));
  const wake = nextWake(calendars, now);
  const common = { ...context, watching, monitorOverdue, nextWake: wake };
  if (due.length) {
    const newest = Math.max(...due.map(e => e.readyAt));
    // If several runs already saw this due set and it persists, the worker is blocked (monitoring,
    // allowlist, funds, proposer guard). Back off to the recovery cadence.
    const attempts = starts.filter(t => t >= newest).length;
    const interval = attempts >= 3 ? config.recoverySeconds : config.minRedispatchSeconds;
    if (!(lastRun !== null && newest <= lastRun && sinceLastRun < interval)) return { action: 'dispatch', reason: 'due', due, ...common };
    // Deduplicated bot work must not suppress a monitoring refresh that is itself due.
    if (monitorStale && sinceLastRun >= config.minRedispatchSeconds) return { action: 'dispatch', reason: 'monitor-refresh', due, attempts, ...common };
    return { action: 'skip', reason: attempts >= 3 ? 'backing-off' : 'recently-dispatched', due, attempts, ...common };
  }
  if (monitorStale) {
    // A failed monitor run starts a retry clock; it is not treated as fresh monitoring.
    if (sinceLastRun >= config.minRedispatchSeconds) return { action: 'dispatch', reason: 'monitor-refresh', ...common };
    return { action: 'skip', reason: 'monitor-retry-wait', ...common };
  }
  return { action: 'skip', reason: 'idle', ...common };
}

// ok: success ping. degraded: no success ping (Healthchecks alerts after its grace period) plus a log entry.
// fail: immediate failure signal, for conditions that will not heal without a person.
export function alarmHealth(summary, { dispatchEnabled = false } = {}) {
  if (summary.action === 'alarm-failed') return 'fail';
  if (summary.action === 'dispatch-failed') return summary.retryable ? 'degraded' : 'fail';
  if (['run-history-unavailable', 'calendar-unavailable', 'stale-calendar', 'recovery', 'stuck-run', 'backing-off'].includes(summary.reason)) return 'degraded';
  // A proposer position needs a person, ideally before trading closes, when it can still be sold.
  if (summary.proposerPreflight?.status === 'holds-position') return 'fail';
  if (summary.proposerPreflight && summary.proposerPreflight.status !== 'clear') return 'degraded';
  if (summary.failedPools?.length || summary.workerStuck) return 'degraded';
  // The alarm owns freshness only once it is allowed to dispatch; during observation this is reported, not alerted.
  if (dispatchEnabled && summary.monitorOverdue) return 'degraded';
  return 'ok';
}

export async function healthPing({ url, health, summary, fetcher = fetch }) {
  if (!url) return 'not-configured';
  try {
    const base = new URL(url);
    if (base.protocol !== 'https:' || base.username || base.password) return 'invalid-url';
    const target = health === 'ok' ? base.href : `${base.href.replace(/\/$/, '')}/${health === 'fail' ? 'fail' : 'log'}`;
    // Only codes and counts; never URLs, tokens or upstream error text.
    const body = JSON.stringify({ health, action: summary.action, reason: summary.reason ?? null, status: summary.status ?? null,
      failedPools: summary.failedPools?.length ?? 0, monitorAgeSeconds: summary.monitorAgeSeconds ?? null, proposer: summary.proposerPreflight?.status ?? null });
    const response = await fetcher(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return response.ok ? 'sent' : 'rejected';
  } catch { return 'failed'; }
}

export class GitHubError extends Error { constructor(status) { super('GitHub request failed'); this.status = status; } }

// Least privilege available is repository-wide Actions permission: read to list runs, write to dispatch.
// GitHub cannot scope a token to one workflow. The token never appears in results or errors.
export function githubActions({ repository, token, monitorWorkflow, workerWorkflow, ref = 'main', fetcher = fetch }) {
  const base = `https://api.github.com/repos/${repository}/actions/workflows/`;
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'flurbo-settlement-alarm',
    ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const get = async file => {
    const response = await fetcher(`${base}${file}/runs?per_page=10&branch=${ref}`, { headers });
    if (!response.ok) throw new GitHubError(response.status);
    const body = await response.json();
    if (!Array.isArray(body?.workflow_runs)) throw new GitHubError(502);
    return body.workflow_runs.map(r => ({ workflow: file, status: r.status, conclusion: r.conclusion ?? null, event: r.event,
      created_at: r.created_at, updated_at: r.updated_at }));
  };
  return {
    async listRuns() { return [...await get(monitorWorkflow), ...await get(workerWorkflow)]; },
    async dispatch() {
      if (!token) throw new GitHubError(401);
      const response = await fetcher(`${base}${monitorWorkflow}/dispatches`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ref }) });
      if (response.status !== 204) throw new GitHubError(response.status);
    },
  };
}

export async function alarmTick({ config, rpc, github, now = () => Math.floor(Date.now() / 1000), dispatch = false, healthUrl = null, fetcher = fetch, holdings = null }) {
  let read = null, calendarError = null, runs = null, runsError = null;
  try { read = await readCalendars(config, rpc); } catch { calendarError = 'chain-read-failed'; }
  try { runs = await github.listRuns(); } catch (error) { runsError = error instanceof GitHubError ? `github-${error.status}` : 'github-unavailable'; }
  const decision = alarmDecision({ now: now(), calendars: read?.calendars ?? null, failed: read?.failed ?? [], calendarError, runs, runsError, config });
  let summary = { ...decision, checkedAt: now(), ...(calendarError ? { calendarError } : {}), ...(runsError ? { runsError } : {}) };
  if (decision.action === 'dispatch') {
    if (!dispatch) summary = { ...summary, action: 'would-dispatch' };
    else {
      try { await github.dispatch(); summary = { ...summary, dispatched: true }; }
      catch (error) {
        const status = error instanceof GitHubError ? error.status : 0;
        // Auth or configuration failures need a person; rate limits and outages retry on the next tick.
        summary = { ...summary, action: 'dispatch-failed', status, retryable: ![401, 403, 404, 422].includes(status) };
      }
    }
  }
  // Explicit proposer preflight: while any proposal is still ahead for the proposing pool, check the
  // proposer holds nothing there, sampled every preflightIntervalSeconds. This runs before observation
  // ends, so a position is reported while trading is open and it can still be removed.
  const proposing = config.pools.find(p => p.evidence), at = now();
  const calendar = proposing && read?.calendars.find(c => c.pool === proposing.pool);
  const ahead = calendar?.entries.filter(e => e.action === 'evidence' && at < e.deadline) ?? [];
  const period = Math.max(1, Math.round(config.preflightIntervalSeconds / 60));
  if (ahead.length && Math.floor(at / 60) % period === 0) {
    const check = holdings || (() => proposerHoldings({ manifest: { pool: proposing.pool, publication: { draft: { events: proposing.observationEnds.map(() => ({})) } } }, rpc, owner: config.signer }));
    summary = { ...summary, proposerPreflight: { pool: proposing.pool, window: ahead.some(e => e.readyAt <= at) ? 'assertion-window' : 'before-observation', ...await proposerStatus(check) } };
  }
  const health = alarmHealth(summary, { dispatchEnabled: dispatch });
  return { ...summary, health, healthPing: await healthPing({ url: healthUrl, health, summary, fetcher }) };
}
