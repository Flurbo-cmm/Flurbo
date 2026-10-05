import { createHash } from 'node:crypto';
import { castVoteCommand, hybridRealitySnapshot } from './hybrid-reality.mjs';
import { readHybridSnapshot } from './hybrid-settlement-worker.mjs';

const PREFIX = 'flurbo:hybrid-alert:v1:';
const TTL = 90 * 86_400, ERROR_WINDOW = 6 * 3600, DAY = 86_400;
const LOW = { answerer: 2n * 10n ** 15n, keeper: 3n * 10n ** 16n };
const label = ['Waiting', 'No', 'Yes', 'Void'];
const utc = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const eth = wei => (Number(wei) / 1e18).toFixed(4);

export async function readPoolForAlerts(record, market, source, juror = null) {
  const snapshot = await readHybridSnapshot(record, market);
  const events = await Promise.all(record.prepared.draft.events.map(async (item, index) => ({
    phase: Number(snapshot.states[index].phase), result: Number(snapshot.states[index].result),
    reality: item.route === 'reality' ? await hybridRealitySnapshot(source, item, null, { juror }) : null })));
  return { delivered: snapshot.delivered, resolved: snapshot.resolved, events };
}

function voteInstruction(r) {
  const seats = r.court.jurorPendingVoteIds;
  if (Array.isArray(seats) && seats.length)
    return `Cast it now with choice 2 (Yes), 1 (No) or 0 (Void):\n${castVoteCommand(r.court.court, r.disputeId, seats)}`;
  if (Array.isArray(seats))
    return `The configured juror holds no unvoted seat in this round. Check the draw with node apps/web/scripts/inspect-kleros-dispute.mjs ${r.questionId} <juror address> before the keeper passes the vote period.`;
  return `Find your vote IDs: node apps/web/scripts/inspect-kleros-dispute.mjs ${r.questionId} <juror address>\nThen run the printed castVoteCommand with choice 2 (Yes), 1 (No) or 0 (Void).`;
}

export function hybridAlertsFor(record, state, origin) {
  const pool = record.pool.toLowerCase(), draft = record.prepared.draft, alerts = [];
  const add = (id, subject, text, action = false) => alerts.push({ id, subject, text, action });
  state.events.forEach((event, index) => {
    const item = draft.events[index], url = `${origin}/markets/hybrid/${record.pool}/${index}`;
    const head = `Question ${index + 1} of ${draft.title}:\n"${item.question}"\n`;
    const r = event.reality;
    if (r) {
      if (BigInt(r.bondWei || 0) > 0n)
        add(`answered:${pool}:${index}`, `Reality answer posted: ${r.answerLabel || 'unknown'}`,
          `${head}Answer posted on Reality.eth: ${r.answerLabel || 'unknown'}. It can be challenged until ${utc(r.finalizesAt)}.\n${url}`);
      if (r.disputeStatus >= 1)
        add(`arbitration:${pool}:${index}:${r.disputeId}`, `Kleros arbitration requested (case #${r.disputeId})`,
          `${head}Kleros arbitration was requested. Case #${r.disputeId}.\n${url}`);
      if (r.court && r.court.period === 2 && !r.court.ruled)
        add(`vote:${pool}:${index}:${r.disputeId}:${r.court.rounds}`, `Cast the juror vote for case #${r.disputeId}`,
          `${head}The Kleros case #${r.disputeId} is in the vote period (${r.court.votesCast} of ${r.court.votesNeeded} votes cast). The juror vote is the one manual step.\n${voteInstruction(r)}\n${url}`, true);
      if (r.disputeStatus >= 2)
        add(`ruled:${pool}:${index}:${r.disputeId}`, `Kleros ruled on case #${r.disputeId}`,
          `${head}The court has ruled. The keeper reports it to Reality.eth next.\n${url}`);
      if (r.finalized)
        add(`realityFinal:${pool}:${index}`, `Reality finalized: ${r.answerLabel || 'unknown'}`,
          `${head}Reality.eth finalized the answer: ${r.answerLabel || 'unknown'}. The relay reports it to Monad next.\n${url}`);
      if (event.phase === 3)
        add(`reported:${pool}:${index}`, `Reported to Monad: ${label[event.result] || 'unknown'}`,
          `${head}The result was reported to the Monad resolver: ${label[event.result] || 'unknown'}.\n${url}`);
    } else {
      if (event.phase >= 1)
        add(`proposed:${pool}:${index}`, 'Answer proposed', `${head}A bonded answer was proposed.\n${url}`);
      if (event.phase === 2)
        add(`challenged:${pool}:${index}`, 'Answer challenged', `${head}The proposed answer was challenged and a Kleros case was requested.\n${url}`);
      if (event.phase === 3)
        add(`finalized:${pool}:${index}`, `Result final: ${label[event.result] || 'unknown'}`,
          `${head}The result is final: ${label[event.result] || 'unknown'}.\n${url}`);
    }
  });
  if (state.delivered)
    add(`delivered:${pool}`, 'Pool delivered', `${draft.title} was delivered to the pool. Holders can redeem on the market page.\n${origin}/markets/hybrid/${record.pool}/0`);
  return alerts;
}

export async function walletBalances(source, pools) {
  const record = pools.find(pool => pool.keeper || pool.answerer) || {};
  const read = async address => address ? BigInt(await source.getBalance({ address })) : null;
  return { keeper: await read(record.keeper), answerer: await read(record.answerer) };
}

export function hybridOperatorAlerts({ pools, readPool, command, deliver, from, to, origin, workers = () => ({}),
  balances = async () => ({}), now = () => Math.floor(Date.now() / 1000), intervalMs = 300_000 }) {
  if (!Array.isArray(pools) || !pools.length || typeof readPool !== 'function' || typeof command !== 'function'
    || typeof deliver !== 'function' || !Array.isArray(to) || !to.length || !from || !origin?.startsWith('https://'))
    throw Error('Hybrid alert configuration incomplete');
  let timer = null, running = false, cycles = 0, lastResult = null, lastError = null, lastFinishedAt = null, sentTotal = 0;
  const sentKey = id => `${PREFIX}sent:${id}`;

  async function operational(t) {
    const alerts = [];
    for (const [name, status] of Object.entries(workers() || {})) {
      const message = status && typeof status === 'object' ? status.lastError : null;
      if (typeof message !== 'string' || !message) continue;
      const digest = createHash('sha256').update(message).digest('hex').slice(0, 10);
      alerts.push({ id: `error:${name}:${digest}:${Math.floor(t / ERROR_WINDOW)}`, subject: `Worker error: ${name}`,
        text: `${name} reported an error:\n${message}\nCheck ${origin}/healthz.`, action: true });
    }
    const wallets = await balances();
    for (const [name, wei] of Object.entries(wallets || {})) {
      if (typeof wei !== 'bigint' || !LOW[name] || wei >= LOW[name]) continue;
      alerts.push({ id: `lowbalance:${name}:${Math.floor(t / DAY)}`, subject: `Low Sepolia balance: ${name}`,
        text: `The ${name} wallet holds ${eth(wei)} Sepolia ETH, below ${eth(LOW[name])}. Fund it so answers and court steps keep running.`, action: true });
    }
    return alerts;
  }

  async function tick() {
    if (running) return 'running';
    running = true; cycles++;
    try {
      const t = now(), fresh = [];
      let baselined = 0;
      for (const record of pools) {
        const alerts = hybridAlertsFor(record, await readPool(record), origin);
        const baseline = `${PREFIX}baseline:${record.pool.toLowerCase()}`;
        if (await command('GET', baseline) === null) {
          for (const alert of alerts) await command('SET', sentKey(alert.id), String(t), 'NX', 'EX', TTL);
          await command('SET', baseline, String(t), 'NX');
          baselined++;
          continue;
        }
        fresh.push(...alerts);
      }
      fresh.push(...await operational(t));
      const unsent = [];
      for (const alert of fresh) if (await command('GET', sentKey(alert.id)) === null) unsent.push(alert);
      if (!unsent.length) {
        lastError = null;
        return lastResult = baselined ? `baseline ${baselined} pool${baselined === 1 ? '' : 's'}` : 'idle';
      }
      const action = unsent.some(alert => alert.action);
      const subject = `${action ? 'ACTION: ' : ''}Flurbo hybrid: ${unsent.length === 1 ? unsent[0].subject : `${unsent.length} updates`}`;
      const text = [...unsent.map(alert => alert.text), `Health: ${origin}/healthz`].join('\n\n');
      const key = 'flurbo-hybrid-alert-' + createHash('sha256').update(unsent.map(a => a.id).sort().join('|')).digest('hex').slice(0, 40);
      try { await deliver({ key, body: { from, to, subject, text } }); }
      catch { lastError = 'Hybrid alert email not acknowledged; retained'; return lastResult = 'send failed; retained'; }
      for (const alert of unsent) await command('SET', sentKey(alert.id), String(t), 'NX', 'EX', TTL);
      sentTotal++; lastError = null;
      return lastResult = 'sent 1';
    } catch {
      lastError = 'Hybrid alert read failed';
      return lastResult = 'failed';
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }

  return { tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, pools: pools.length, emails: sentTotal,
      lastResult, lastError, lastFinishedAt }; },
  };
}
