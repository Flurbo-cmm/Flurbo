import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pilotRpc, pilotService } from '../server/pilot.mjs';
import { checkSettlement, monitorIdentity, validateMonitorCheckpoint } from '../server/settlement-monitor.mjs';
import { redisCommand } from '../server/redis-session.mjs';
import { settlementLease } from '../server/settlement-store.mjs';
import { emailConfig, resendDelivery, validateEmailState, queueReport, drainEmails, queueReadFailures, READ_FAILURE_IDENTITY } from '../server/settlement-email.mjs';
import {validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {DETERMINISTIC_MODE} from '../server/settlement-publication.mjs';
import {loadRegistry, monitoredCollections, registryEnabled} from '../server/collection-registry.mjs';

export function watchdog(env, request = fetch) {
  const url = env.FLURBO_MONITOR_HEALTHCHECK_URL || '';
  if (!/^https:\/\/hc-ping\.com\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url)) throw new Error('Configure independent watchdog');
  return async failed => {
    const response = await request(url + (failed ? '/fail' : ''), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('Watchdog unavailable');
  };
}

// A pool counts as failing only after this many checks in a row could not read the chain, each after retries.
export const READ_FAILURE_THRESHOLD = 2;
const READ_ATTEMPTS = 3;
const pause = ms => new Promise(done => setTimeout(done, ms));
// A verified observation is written at least this often even when nothing changed, well inside the worker's
// 15-minute freshness requirement and the hosted gap alarm.
export const CHECKPOINT_REFRESH_SECONDS = 300;

// When the settlement bot next needs to act on this pool, in UTC seconds: now when an assertion window is open
// or every answer is final but not delivered, otherwise the next observation end, challenge or vote deadline.
// 'none' when the pool is delivered. The bot runs every 2 minutes near these times and every 10 otherwise.
export function nextDueAt(report) {
  if (report.lifecycle === 'settled') return 'none';
  const chainTime = report.snapshot.timestamp, open = report.events.filter(e => e.phase !== 'Finalized');
  if (!open.length) return chainTime;
  return Math.min(...open.map(e => e.phase === 'Pending'
    ? Math.max(chainTime, Number(report.timing.observationEnds[e.event])) : Math.max(chainTime, Number(e.deadline))));
}

export async function notifyPool({ manifest, command, rpc, config, send,
  now = () => Math.floor(Date.now() / 1000), test = false, inspect = checkSettlement, wait = pause }) {
  // Validate static bindings before accepting persisted state or creating an email.
  pilotService({ manifest, rpc, now });
  const identity = monitorIdentity(manifest), lease = await settlementLease(command, identity);
  try {
    let state = await lease.load() ?? { schema: 'flurbo.settlement-mail.v1', identity,
      checkpoint: null, report: null, signature: null, lastQueuedAt: 0, queue: [] };
    validateEmailState(state, identity); validateMonitorCheckpoint(state.checkpoint, manifest);
    const loaded = state;
    if (state.queue.some(item => item.body.from !== config.from || JSON.stringify(item.body.to) !== JSON.stringify(config.to))) {
      throw new Error('Reconcile pending mail before changing recipient or sender');
    }
    let result = null;
    for (let attempt = 1; attempt <= READ_ATTEMPTS && !result; attempt++) {
      try { result = await inspect({ manifest, rpc, now, previous: state.checkpoint }); }
      catch { if (attempt < READ_ATTEMPTS) await wait(2_000 * attempt); }
    }
    if (!result) {
      // The checkpoint and the last report stay as they were. Failures are reported once for every pool, by
      // runNotifications, after READ_FAILURE_THRESHOLD checks in a row, so a single RPC hiccup sends nothing.
      state.readFailures = (state.readFailures ?? 0) + 1;
      await lease.save(state);
      const delivered = await drainEmails(state, { save: lease.save, renew: lease.renew, send, now });
      return { status: 'check_failed', pool: manifest.pool, readFailures: state.readFailures,
        acceptedEmails: delivered.accepted, pendingEmails: delivered.state.queue.length };
    }
    state.readFailures = 0;
    // Five-minute jobs have scheduling jitter. Use a 15-minute hosted gap alarm;
    // the independent watchdog covers a job that never returns at all.
    result.report.alerts = result.report.alerts.filter(a => a.code !== 'CHECK_GAP');
    // A delivered pool has nothing left to miss, so a long gap since its last read (a restart, or a pool the bot
    // no longer re-reads) is not an alarm.
    const settled = loaded.report?.lifecycle === 'settled' && result.report.lifecycle === 'settled';
    if (state.checkpoint && !settled && now() - state.checkpoint.checkedAt > 900) result.report.alerts.push({
      code: 'HOSTED_CHECK_GAP', severity: 'critical', message: 'Over 15 minutes since the last verified read. Intermediate assertions may have been missed; review chain history manually.',
    });
    if (result.report.status !== 'check_failed') result.report.status = result.report.alerts.some(a => a.severity !== 'info') ? 'attention_required' : 'observed';
    result.report.notice = 'Read-only observation; no transaction submitted. Email delivery state is tracked separately. Neither email acceptance nor this snapshot certifies truth or continuous coverage.';
    state = queueReport(state, result.report, config, now(), { test });
    state.report = result.report; state.checkpoint = result.checkpoint;
    // Observation and pending email are saved atomically before any external send. A repeat of the saved
    // observation (same status, alerts and cases, no new email) is not rewritten until the saved checkpoint is
    // CHECKPOINT_REFRESH_SECONDS old, which saves one Redis write per pool on most two-minute cycles.
    const repeat = loaded.checkpoint && (loaded.readFailures ?? 0) === 0 && state.signature === loaded.signature
      && state.queue.length === loaded.queue.length && loaded.report?.status === state.report.status
      && now() - loaded.checkpoint.checkedAt < CHECKPOINT_REFRESH_SECONDS;
    if (!repeat) await lease.save(state);
    const delivered = await drainEmails(state, { save: lease.save, renew: lease.renew, send, now });
    return { status: result.report.status, pool: manifest.pool, acceptedEmails: delivered.accepted,
      pendingEmails: delivered.state.queue.length, nextDueAt: (() => { try { return nextDueAt(result.report); } catch { return null; } })() };
  } finally { await lease.release(); }
}

// This process remembers when the shared read-failure outbox is known to be clear (no failure reported, nothing
// pending), so healthy cycles skip its lease: three Redis commands per cycle. A restart checks it once again.
let readFailuresClear = false;
export async function notifyReadFailures({ command, config, send, now, failing }) {
  if (!failing.length && readFailuresClear) return { acceptedEmails: 0, pendingEmails: 0 };
  const lease = await settlementLease(command, READ_FAILURE_IDENTITY);
  try {
    let state = await lease.load() ?? { schema: 'flurbo.settlement-mail.v1', identity: READ_FAILURE_IDENTITY,
      checkpoint: null, report: null, signature: null, lastQueuedAt: 0, queue: [] };
    validateEmailState(state, READ_FAILURE_IDENTITY);
    const next = queueReadFailures(state, failing, config, now());
    if (JSON.stringify(next) !== JSON.stringify(state)) await lease.save(next);
    const delivered = await drainEmails(next, { save: lease.save, renew: lease.renew, send, now });
    readFailuresClear = next.signature === null && delivered.state.queue.length === 0;
    return { acceptedEmails: delivered.accepted, pendingEmails: delivered.state.queue.length };
  } finally { await lease.release(); }
}

// The settlement bot keeps one schedule for the life of the process: pool -> { checkedAt, nextDueAt }. A pool far
// from its next action is re-read at most every POOL_RECHECK_SECONDS, well inside the 15-minute gap alarm and the
// worker's 900-second freshness rule, so a 2-minute cadence for one pool does not re-read every other pool. A
// delivered pool ('none') is read once and then left alone until the process restarts. Without a schedule (the
// GitHub job, the CLI) every pool is read on every run, as before.
export const MAX_MONITORED_POOLS = 32;
export const POOL_RECHECK_SECONDS = 480;
const DUE_SOON_SECONDS = 900;
export function skipCheck(seen, nowSeconds) {
  if (seen.nextDueAt === 'none') return true;
  return Number.isSafeInteger(seen.nextDueAt) && seen.nextDueAt - nowSeconds > DUE_SOON_SECONDS
    && nowSeconds - seen.checkedAt < POOL_RECHECK_SECONDS && nowSeconds >= seen.checkedAt;
}

export async function runNotifications({ env = process.env, args = process.argv.slice(2), request = fetch,
  output = console.log, now = () => Math.floor(Date.now() / 1000), inspect = checkSettlement, wait = pause, schedule = null, readRegistry = null } = {}) {
  let ping;
  try {
    ping = watchdog(env, request);
    if (args.length > 1 || args.length === 1 && args[0] !== '--test-email') throw new Error('Invalid arguments');
    const config = emailConfig(env), command = redisCommand(env, request), send = resendDelivery(config, request);
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const manifests = [JSON.parse(env.FLURBO_PILOT_MANIFEST_JSON ?? await readFile(resolve(root, 'config/pilot-testnet.json'), 'utf8'))];
    if (['rehearsal','ethereum-activity',DETERMINISTIC_MODE].includes(manifests[0].publication?.mode)) throw new Error('Configure the release pilot pool');
    // With the registry, every pool the bot may act on is watched, plus every listed pool.
    const extras=registryEnabled(env)?monitoredCollections(await loadRegistry(readRegistry?{read:readRegistry}:{})).map(({label,manifest})=>({label,manifest}))
      :env.FLURBO_PRACTICE_COLLECTIONS_JSON?JSON.parse(env.FLURBO_PRACTICE_COLLECTIONS_JSON):[];
    if(!Array.isArray(extras)||extras.length>MAX_MONITORED_POOLS)throw Error('Invalid practice collections');
    for(const row of extras){
      if(!row?.manifest||!['rehearsal','ethereum-activity',DETERMINISTIC_MODE].includes(row.manifest.publication?.mode)
        ||manifests.some(manifest=>manifest.pool===row.manifest.pool||manifest.resolver===row.manifest.resolver))throw Error('Duplicate or invalid practice collection');
      // Validate every additional manifest before delivering any observations.
      pilotService({manifest:row.manifest,rpc:async()=>{throw Error('No read during configuration');},now});
      if(row.manifest.publication.mode==='ethereum-activity')validateActivityDraft(row.manifest.publication.draft);
      manifests.push(row.manifest);
    }
    let failed = false;
    const failing = [];
    for (const manifest of manifests) {
      const seen = schedule?.get(manifest.pool);
      if (seen && skipCheck(seen, now())) {
        output(JSON.stringify({ status: 'skipped', pool: manifest.pool, nextDueAt: seen.nextDueAt }));
        continue;
      }
      try {
        const deadline = AbortSignal.timeout(45_000);
        const rpc = pilotRpc(env.FLURBO_ALCHEMY_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz', (url, options) =>
          request(url, { ...options, signal: AbortSignal.any([deadline, options.signal]) }));
        const result = await notifyPool({ manifest, command, rpc, config, send, now, inspect, wait, test: args[0] === '--test-email' });
        output(JSON.stringify(result));
        if (schedule) {
          if (result.status === 'check_failed' || result.pendingEmails > 0) schedule.delete(manifest.pool);
          else schedule.set(manifest.pool, { checkedAt: now(), nextDueAt: result.nextDueAt ?? null });
        }
        if (result.pendingEmails > 0) failed = true;
        if (result.status === 'check_failed') {
          if (result.readFailures >= READ_FAILURE_THRESHOLD) failing.push({ pool: manifest.pool, readFailures: result.readFailures });
        }
      } catch {
        schedule?.delete(manifest.pool);
        failed = true; output(JSON.stringify({ status: 'notification_failed', message: 'Inspect RPC, mail, durable state and lease configuration. No transaction submitted; upstream details withheld.' }));
      }
    }
    // One email for every pool whose reads keep failing, and one when they recover.
    try {
      const mail = await notifyReadFailures({ command, config, send, now, failing });
      if (mail.pendingEmails > 0) failed = true;
    } catch {
      failed = true; output(JSON.stringify({ status: 'notification_failed', message: 'Read failure notice could not be stored or sent; details withheld.' }));
    }
    if (failing.length) failed = true;
    // Warning/critical resolver alerts are successful monitoring when delivered. Reads failing on consecutive
    // checks, unsent notifications or storage errors must not refresh a healthy heartbeat; a single failed
    // check (after retries) is retried next cycle without paging anyone.
    await ping(failed);
    return failed ? 2 : 0;
  } catch {
    if (ping) await ping(true).catch(() => {});
    output(JSON.stringify({ status: 'notification_failed', message: 'Monitor configuration or watchdog failed. Check hosting secrets and service dashboards; sensitive details withheld.' }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runNotifications();
