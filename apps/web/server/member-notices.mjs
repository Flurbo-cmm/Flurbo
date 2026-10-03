import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { LINKS } from './user-metrics.mjs';

// Email notices to members about their own positions:
//   payout     results are final and the member has test AUSD to collect (reminder 3 days later if still uncollected)
//   challenge  an answer was proposed for a question they hold, with the challenge deadline
//   closing    trading closes in about 2 hours for a market they hold (opt-in)
// Holders come from the market's trade index, confirmed by current on-chain balances. Each email goes to
// exactly one member, with only that member's address in To and no CC or BCC, and combines everything due
// for that member at once. Sent items are recorded, so a notice is never sent twice.
const PREFIX = 'flurbo:notify:v1:';
export const PREFS = PREFIX + 'prefs';
export const DEFAULT_PREFS = Object.freeze({ payouts: true, challenges: true, closing: false });
const CONSENT = { payout: 'payouts', reminder: 'payouts', challenge: 'challenges', closing: 'closing' };
const HOUR = 3600, SENT_TTL = 90 * 86_400, REMINDER_AFTER = 72 * HOUR, CLOSING_BEFORE = 2 * HOUR;
const OUTCOME = ['Unset', 'No', 'Yes', 'VOID'];
const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v);
const json = raw => { try { return JSON.parse(raw); } catch { return null; } };
const utc = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const ausd = atoms => (Number(atoms) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });

// One-click unsubscribe links: the account plus an HMAC, so no login is needed and nothing else is exposed.
const mac = (secret, account) => createHmac('sha256', secret).update('flurbo-notice-unsubscribe:v1:' + account).digest('hex');
export const unsubscribeToken = (secret, account) => `${account.toLowerCase()}.${mac(secret, account.toLowerCase())}`;
export function verifyUnsubscribeToken(secret, token) {
  const m = /^(0x[0-9a-f]{40})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m || !secret) return null;
  const expected = Buffer.from(mac(secret, m[1]), 'hex'), given = Buffer.from(m[2], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1] : null;
}

export function memberNotices({ command, pools, applications = null, links = null, origin, env = process.env, send = null,
  now = () => Math.floor(Date.now() / 1000) }) {
  if (!command) return null;
  const secret = applications?.noticeSecret || null;
  const dailyLimit = Math.min(500, Math.max(1, Number(env.FLURBO_NOTIFY_DAILY_LIMIT) || 40));

  async function preferences(account) {
    const saved = json(await command('HGET', PREFS, account.toLowerCase()));
    return { ...DEFAULT_PREFS, ...(saved && typeof saved === 'object' ? Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in DEFAULT_PREFS && typeof v === 'boolean')) : {}) };
  }
  async function setPreferences(account, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in DEFAULT_PREFS) || typeof input[k] !== 'boolean'))
      throw Object.assign(Error('Choose on or off for each notice.'), { status: 400 });
    const next = { ...await preferences(account), ...input };
    await command('HSET', PREFS, account.toLowerCase(), JSON.stringify(next));
    return next;
  }
  async function unsubscribe(token) {
    const account = verifyUnsubscribeToken(secret, token);
    if (!account) return null;
    await command('HSET', PREFS, account, JSON.stringify({ payouts: false, challenges: false, closing: false }));
    return account;
  }

  // Wallet -> Flurbo account, from recorded links and the wallet-link store.
  async function ownerOf(wallet) {
    const recorded = json(await command('HGET', LINKS, wallet));
    if (address(recorded?.account)) return recorded.account;
    const linked = links ? await links.ownerOf(wallet, origin).catch(() => null) : null;
    return address(linked) ? linked : null;
  }

  // Current holdings per account in one market: candidates from the trade index, balances from the chain.
  async function holdings(service) {
    const index = json(await command('GET', `flurbo:pilot:index:v1:${service.manifest.pool}`));
    if (!index || !(index.through >= index.target)) return null; // wait until the index has caught up
    const candidates = new Map();
    for (const log of index.logs || []) {
      if (log.name !== 'Traded' || !log.args?.isBuy) continue;
      const wallet = String(log.args.trader).toLowerCase();
      if (!candidates.has(wallet)) candidates.set(wallet, new Map());
      candidates.get(wallet).set(`${log.args.scope}:${log.args.mask}`, { scope: Number(log.args.scope), mask: String(log.args.mask) });
    }
    const byAccount = new Map();
    for (const [wallet, claims] of candidates) {
      const account = await ownerOf(wallet);
      if (!account) continue;
      const list = [...claims.values()], rows = [];
      for (let i = 0; i < list.length; i += 60) rows.push(...(await service.positions(wallet, list.slice(i, i + 60))).rows);
      const held = rows.filter(r => BigInt(r.quantity) > 0n);
      if (!held.length) continue;
      if (!byAccount.has(account)) byAccount.set(account, []);
      byAccount.get(account).push(...held);
    }
    return byAccount;
  }

  // Notices due now for one market, as stages; each stage lists the accounts it concerns.
  async function dueStages({ namespace, label, service }, t) {
    const status = await service.status(), m = service.manifest, closesAt = m.publication.draft.closesAt, stages = [];
    const events = m.publication.draft.events;
    if (!status.resolved && t >= closesAt - CLOSING_BEFORE && t < closesAt - 300)
      stages.push({ kind: 'closing', id: `closing:${m.pool}`, market: label, namespace, closesAt });
    status.cases.forEach((c, event) => {
      if (Number(c.phase) === 1 && Number(c.challengeUntil) > t + 600)
        stages.push({ kind: 'challenge', id: `challenge:${m.pool}:${event}:${c.challengeUntil}`, market: label, namespace, event,
          question: events[event].question, proposal: OUTCOME[Number(c.proposal)] || 'an answer', until: Number(c.challengeUntil) });
    });
    if (status.delivered && status.resolved) {
      stages.push({ kind: 'payout', id: `payout:${m.pool}`, market: label, namespace });
      const first = Number(await command('GET', PREFIX + 'done:payout:' + m.pool) || 0);
      if (first && t - first >= REMINDER_AFTER) stages.push({ kind: 'reminder', id: `reminder:${m.pool}`, market: label, namespace });
    }
    const open = [];
    for (const stage of stages) if (await command('GET', PREFIX + 'done:' + stage.id) === null) open.push(stage);
    return open;
  }

  function relevant(stage, rows) {
    if (stage.kind === 'payout' || stage.kind === 'reminder') {
      const total = rows.reduce((sum, r) => sum + BigInt(r.payoutAtoms || 0), 0n);
      return total > 0n ? { payoutAtoms: String(total) } : null;
    }
    if (stage.kind === 'challenge') return rows.some(r => Number(r.scope) & (1 << stage.event)) ? {} : null;
    return rows.length ? {} : null;
  }

  function compose(account, items, email) {
    const url = origin.replace(/\/$/, '');
    const unsubscribeUrl = `${url}/api/notifications/unsubscribe/${unsubscribeToken(secret, account)}`;
    const parts = items.map(({ stage, detail }) => {
      if (stage.kind === 'payout' || stage.kind === 'reminder') return `${stage.kind === 'reminder' ? 'Reminder: ' : ''}results are final for ${stage.market}. You have about ${ausd(detail.payoutAtoms)} test AUSD to collect. Payouts are not sent automatically: open Portfolio and collect with the MetaMask wallet that holds the shares.\n${url}/portfolio`;
      if (stage.kind === 'challenge') return `An answer was proposed for a question you hold in ${stage.market}:\n"${stage.question}"\nProposed answer: ${stage.proposal}. It can be challenged until ${utc(stage.until)}. If it is right, you do not need to do anything. If it is wrong, review the evidence and challenge it from the market page before the deadline.\n${url}/markets/${stage.namespace}/${stage.event}`;
      return `Trading in ${stage.market} closes at ${utc(stage.closesAt)}, in about 2 hours. After that you can no longer buy or sell there.\n${url}/markets`;
    });
    const kinds = new Set(items.map(i => i.stage.kind === 'reminder' ? 'payout' : i.stage.kind));
    const subject = kinds.size > 1 ? 'Updates on your Flurbo predictions'
      : kinds.has('payout') ? 'You have test AUSD to collect on Flurbo'
      : kinds.has('challenge') ? 'An answer was proposed for a question you hold'
      : `Trading closes in about 2 hours: ${items[0].stage.market}`;
    const text = [...parts,
      'Flurbo runs on Monad testnet. Test assets only; nothing here has monetary value.',
      `You get these emails because you hold shares on Flurbo. Choose which notices you get on Your account: ${url}/access\nStop all Flurbo notices: ${unsubscribeUrl}`].join('\n\n');
    return { to: [email], subject, text, unsubscribeUrl };
  }

  // Runs every settlement-bot cycle. Returns a short status for /healthz.
  async function tick() {
    if (env.FLURBO_NOTIFY_ENABLED !== 'true') return 'disabled';
    if (!applications?.contacts || !secret || !send) return 'not_configured';
    const t = now(), pending = new Map(), stageAccounts = new Map();
    for (const pool of pools()) {
      let stages, held;
      try { stages = await dueStages(pool, t); if (!stages.length) continue; held = await holdings(pool.service); }
      catch { continue; }
      if (!held) continue;
      for (const stage of stages) {
        const accounts = [];
        for (const [account, rows] of held) {
          const detail = relevant(stage, rows);
          if (!detail) continue;
          accounts.push(account);
          if (!pending.has(account)) pending.set(account, []);
          pending.get(account).push({ stage, detail, key: `${PREFIX}sent:${stage.id}:${account}` });
        }
        stageAccounts.set(stage.id, accounts);
      }
    }
    if (!stageAccounts.size) return 'idle';
    const contacts = pending.size ? await applications.contacts([...pending.keys()]) : {};
    const handled = new Set();
    let sent = 0, capped = false;
    for (const [account, all] of pending) {
      const prefs = await preferences(account), items = [];
      for (const item of all) {
        if (!prefs[CONSENT[item.stage.kind]] || await command('EXISTS', item.key) === 1) { handled.add(item.key); continue; }
        items.push(item);
      }
      if (!items.length) continue;
      if (!contacts[account]) { items.forEach(i => handled.add(i.key)); continue; }
      const day = PREFIX + 'day:' + new Date(t * 1000).toISOString().slice(0, 10);
      const count = Number(await command('INCR', day)); await command('EXPIRE', day, 172_800);
      if (count > dailyLimit) { capped = true; break; }
      const message = compose(account, items, contacts[account]);
      const idempotency = 'flurbo-notice-' + createHash('sha256').update(items.map(i => i.key).sort().join('|')).digest('hex').slice(0, 40);
      try { await send({ ...message, key: idempotency }); }
      catch { continue; }
      for (const item of items) { await command('SET', item.key, String(t), 'EX', SENT_TTL); handled.add(item.key); }
      sent++;
    }
    // A stage is finished once every account it concerns was emailed, opted out or has no verified email.
    for (const [id, accounts] of stageAccounts)
      if (accounts.every(a => handled.has(`${PREFIX}sent:${id}:${a}`))) await command('SET', PREFIX + 'done:' + id, String(t), 'NX', 'EX', SENT_TTL);
    return capped ? `sent ${sent}; daily limit reached` : `sent ${sent}`;
  }

  return { preferences, setPreferences, unsubscribe, tick };
}

// Resend delivery for notices: always one recipient, never CC or BCC, with one-click unsubscribe headers.
export function noticeDelivery({ key, from }, request = fetch) {
  return async ({ to, subject, text, unsubscribeUrl, key: idempotency }) => {
    if (!Array.isArray(to) || to.length !== 1) throw Error('A notice goes to exactly one member');
    const response = await request('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotency },
      body: JSON.stringify({ from, to, subject, text, headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
    });
    if (!response.ok) throw Error('Notice not accepted');
  };
}
