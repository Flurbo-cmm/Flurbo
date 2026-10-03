import { pilotRpc } from './pilot.mjs';
import { agentWalletKey, accountDigest } from './agents/agent-store.mjs';
import { emailConfig, resendDelivery } from './settlement-email.mjs';
import { CLAIM_RULES, ruleMatches } from '../shared/claims.mjs';

// Operator-only growth metrics: who signed in, requested and received access, linked a wallet, got starter
// MON and placed bets. Sign-ins and links are recorded from the moment this ships; applications come from
// Supabase (migration 002, no email addresses); bets come from each listed pool's on-chain Traded events,
// scanned by the existing pilot index. Nothing here is shown to members.
const PREFIX = 'flurbo:metrics:v1:';
export const SIGNINS = PREFIX + 'signins', LAST_SIGNINS = PREFIX + 'last-signins', LINKS = PREFIX + 'links', BLOCK_TIMES = PREFIX + 'block-times', SYNC = PREFIX + 'sync';
const STARTER_MATCH = 'flurbo:starter:v2:account:*';
const DAY = 86_400_000;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
const addressList = value => (value || '').split(',').map(x => x.trim().toLowerCase()).filter(address);
const pairs = raw => Array.isArray(raw) ? Array.from({ length: raw.length / 2 }, (_, i) => [raw[2 * i], raw[2 * i + 1]]) : Object.entries(raw || {});
const json = raw => { try { return JSON.parse(raw); } catch { return null; } };
const time = value => { const ms = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const earliest = (a, b) => a === null ? b : b === null ? a : Math.min(a, b);
const latest = (a, b) => a === null ? b : b === null ? a : Math.max(a, b);

// What kind of prediction a claim is: one answer, or a combination with its payout rule.
export function describeClaim(scope, mask) {
  scope = Number(scope);
  const legs = [0, 1, 2, 3].filter(i => scope & (1 << i)).length;
  if (legs === 1) return { legs, kind: 'single', rule: null, answer: String(mask) === '2' ? 'YES' : String(mask) === '1' ? 'NO' : null };
  for (const rule of CLAIM_RULES) {
    if (rule === 'AT_LEAST_TWO' && legs < 3) continue;
    for (let answers = 0; answers < 2 ** legs; answers++) {
      let value = 0n;
      for (let state = 0; state < 2 ** legs; state++) {
        const matches = Array.from({ length: legs }, (_, i) => Boolean(state & (1 << i)) === Boolean(answers & (1 << i)));
        if (ruleMatches(rule, matches)) value |= 1n << BigInt(state);
      }
      if (String(value) === String(mask)) return { legs, kind: 'combined', rule, answer: null };
    }
  }
  return { legs, kind: 'combined', rule: 'OTHER', answer: null };
}

const emptyTrades = () => ({ buys: 0, singles: 0, combined: 0, sells: 0, redeems: 0, spentAtoms: 0n, receivedAtoms: 0n,
  markets: new Set(), byRule: {}, byLegs: {}, firstBuyAt: null, lastBuyAt: null });
function addTrade(bucket, trade) {
  if (trade.kind === 'buy') {
    bucket.buys++; bucket[trade.claim.kind === 'single' ? 'singles' : 'combined']++;
    bucket.spentAtoms += trade.amount; bucket.markets.add(trade.namespace);
    const rule = trade.claim.rule || 'SINGLE';
    bucket.byRule[rule] = (bucket.byRule[rule] || 0) + 1;
    bucket.byLegs[trade.claim.legs] = (bucket.byLegs[trade.claim.legs] || 0) + 1;
    bucket.firstBuyAt = earliest(bucket.firstBuyAt, trade.at); bucket.lastBuyAt = latest(bucket.lastBuyAt, trade.at);
  } else { bucket[trade.kind === 'sell' ? 'sells' : 'redeems']++; bucket.receivedAtoms += trade.amount; }
}
const publicTrades = t => ({ buys: t.buys, singles: t.singles, combined: t.combined, sells: t.sells, redeems: t.redeems,
  spentAtoms: String(t.spentAtoms), receivedAtoms: String(t.receivedAtoms), markets: t.markets.size, byRule: t.byRule, byLegs: t.byLegs,
  firstBuyAt: t.firstBuyAt, lastBuyAt: t.lastBuyAt });

export function userMetrics({ command, origin, pools, links = null, applications = null, funding = null, operatorAccount = null, openAccess = false,
  reservedWallets = new Set(), rpcUrl = null, env = process.env, now = Date.now, rpc = null, deliver = null }) {
  if (!command) return null;
  // Block times come from the public testnet RPC; a local fork simply leaves bet times unrecorded.
  if (!rpc && rpcUrl) { try { rpc = pilotRpc(rpcUrl); } catch { rpc = null; } }
  const team = new Set([...addressList(env.FLURBO_METRICS_EXCLUDE), ...(operatorAccount ? [operatorAccount.toLowerCase()] : [])]);
  const teamWallets = new Set([...team, ...[...reservedWallets].map(w => w.toLowerCase())]);
  const legacy = new Set(addressList(env.FLURBO_TESTNET_APPROVED_ACCOUNTS));

  async function recordSignIn(account) {
    account = String(account).toLowerCase();
    if (!address(account)) return;
    await command('HSETNX', SIGNINS, account, String(now()));
    await command('HSET', LAST_SIGNINS, account, String(now()));
  }
  async function recordLink(account, wallet) {
    account = String(account).toLowerCase(); wallet = String(wallet).toLowerCase();
    if (!address(account) || !address(wallet)) return;
    await command('HSETNX', LINKS, wallet, JSON.stringify({ account, at: now() }));
    seen.add(wallet);
  }
  // Links made before metrics shipped have no recorded date. They are picked up when the member next loads
  // their wallets; each wallet is written at most once per server process, and never overwrites a dated link.
  const seen = new Set();
  async function recordExistingLinks(account, wallets) {
    account = String(account).toLowerCase();
    if (!address(account)) return;
    for (const raw of wallets) {
      const wallet = String(raw).toLowerCase();
      if (!address(wallet) || seen.has(wallet)) continue;
      if (seen.size >= 50_000) seen.clear();
      await command('HSETNX', LINKS, wallet, JSON.stringify({ account, at: null }));
      seen.add(wallet);
    }
  }

  const readIndex = async pool => json(await command('GET', `flurbo:pilot:index:v1:${pool}`));
  const tradeBlocks = index => [...new Set((index?.logs || []).filter(l => l.name === 'Traded' || l.name === 'Redeemed').map(l => l.block))];

  // Advances every pool's trade index (at most 1,000 blocks per step), round robin within the budget,
  // then records the time of any block that holds a bet. A step costs about 115 units of the web process's
  // 1,200-per-minute RPC budget, so the steps per run are capped to leave room for members' requests.
  const scanSteps = Math.min(20, Math.max(1, Number(env.FLURBO_METRICS_SCAN_STEPS) || 3));
  async function sync({ budgetMs = 60_000, maxSteps = scanSteps } = {}) {
    const started = now(), state = {}, done = new Set(), list = pools();
    let moving = true, steps = 0;
    while (moving && now() - started < budgetMs && steps < maxSteps) {
      moving = false;
      for (const { namespace, service } of list) {
        if (done.has(namespace) || now() - started >= budgetMs || steps >= maxSteps) continue;
        try {
          steps++;
          const result = await service.index.refresh();
          state[namespace] = { through: result.through, target: result.target ?? result.through, complete: !!result.complete };
          if (result.complete) done.add(namespace); else moving = true;
        } catch { state[namespace] = { ...(state[namespace] || {}), error: true }; done.add(namespace); }
      }
    }
    let timed = 0;
    if (rpc) {
      const blocks = [];
      for (const { service } of list) blocks.push(...tradeBlocks(await readIndex(service.manifest.pool)));
      const unique = [...new Set(blocks)];
      const known = unique.length ? await command('HMGET', BLOCK_TIMES, ...unique.map(String)) : [];
      // One request per block, capped per run like the scan.
      const missing = unique.filter((_, i) => !known[i]).slice(0, 40);
      const values = [];
      for (const block of missing) {
        if (now() - started >= budgetMs + 20_000) break;
        try { const b = await rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false]); values.push(String(block), String(Number(BigInt(b.timestamp)) * 1000)); }
        catch { break; }
      }
      if (values.length) { await command('HSET', BLOCK_TIMES, ...values); timed = values.length / 2; }
    }
    const complete = list.every(({ namespace }) => state[namespace]?.complete);
    await command('SET', SYNC, JSON.stringify({ at: now(), complete, pools: state }));
    return { complete, pools: state, timedBlocks: timed, steps };
  }

  async function starterRecords() {
    const keys = [];
    let cursor = '0';
    for (let i = 0; i < 100; i++) {
      const [next, batch] = await command('SCAN', cursor, 'MATCH', STARTER_MATCH, 'COUNT', 1000);
      keys.push(...batch); cursor = String(next);
      if (cursor === '0') break;
    }
    const records = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100), values = await command('MGET', ...chunk);
      chunk.forEach((key, j) => {
        const account = key.slice(STARTER_MATCH.length - 1), raw = values[j];
        if (!address(account) || raw === null) return;
        const record = json(raw);
        records.push(record && typeof record === 'object' ? { account, wallet: record.wallet ?? null, sent: !!record.hash, at: record.at ?? null } : { account, wallet: address(raw) ? raw : null, sent: false, at: null });
      });
    }
    return records;
  }

  async function report() {
    const t = now();
    const [signins, lastSignins, linkRows, blockRows, syncRaw] = await Promise.all([
      command('HGETALL', SIGNINS), command('HGETALL', LAST_SIGNINS), command('HGETALL', LINKS), command('HGETALL', BLOCK_TIMES), command('GET', SYNC)]);
    let apps = null, applicationsStatus = applications?.stats ? 'ok' : 'not_configured';
    if (applications?.stats) { try { apps = await applications.stats(); } catch { applicationsStatus = 'unavailable'; } }
    const starters = await starterRecords();
    const blockTimes = new Map(pairs(blockRows).map(([b, ms]) => [Number(b), Number(ms)]));

    const users = new Map();
    const user = account => {
      if (!users.has(account)) users.set(account, { account, team: team.has(account), firstSignIn: null, lastSignIn: null, application: null,
        legacy: legacy.has(account), wallets: new Set(), linkedAt: null, starter: null, trades: emptyTrades() });
      return users.get(account);
    };
    for (const [account, ms] of pairs(signins)) if (address(account)) user(account).firstSignIn = Number(ms);
    for (const [account, ms] of pairs(lastSignins)) if (address(account)) user(account).lastSignIn = Number(ms);
    for (const row of apps?.rows || []) if (address(row.account)) user(row.account).application = {
      state: row.state, decision: row.decision ?? null, createdAt: time(row.createdAt), verifiedAt: time(row.verifiedAt), approvedAt: time(row.approvedAt) };
    for (const account of legacy) user(account);
    const owners = new Map();
    for (const [wallet, raw] of pairs(linkRows)) {
      const record = json(raw);
      if (!address(wallet) || !address(record?.account)) continue;
      owners.set(wallet, { kind: 'account', account: record.account });
      const u = user(record.account); u.wallets.add(wallet); u.linkedAt = earliest(u.linkedAt, record.at ?? null);
    }
    for (const record of starters) {
      const u = user(record.account);
      u.starter = { sent: record.sent, at: record.at };
      if (address(record.wallet)) { u.wallets.add(record.wallet); if (!owners.has(record.wallet)) owners.set(record.wallet, { kind: 'account', account: record.account }); }
    }

    // Bets from every listed pool.
    const markets = [], trades = [];
    const listed = pools();
    let syncComplete = true;
    for (const { namespace, label, service } of listed) {
      const manifest = service.manifest, index = await readIndex(manifest.pool), start = Number(manifest.verifiedBlock) || 0;
      const through = index?.through ?? start, target = Math.max(index?.target ?? through, through);
      const complete = !!index && through >= target;
      syncComplete &&= complete;
      const market = { namespace, label, pool: manifest.pool, closesAt: manifest.publication?.draft?.closesAt ?? null, scanned: { through, target, start,
        percent: target > start ? Math.min(100, Math.floor((through - start) * 100 / (target - start))) : index ? 100 : 0, complete } };
      markets.push(market);
      for (const log of index?.logs || []) {
        const traded = log.name === 'Traded', redeemed = log.name === 'Redeemed';
        if (!traded && !redeemed) continue;
        const wallet = String(traded ? log.args.trader : log.args.owner).toLowerCase();
        trades.push({ namespace, wallet, block: log.block, hash: log.hash, at: blockTimes.get(log.block) ?? null,
          kind: redeemed ? 'redeem' : log.args.isBuy ? 'buy' : 'sell', amount: BigInt(log.args.collateralAmount ?? 0),
          claim: describeClaim(log.args.scope, log.args.mask) });
      }
    }
    // Who owns each wallet that traded: a linked account, an agent, the team, or nobody.
    const digests = new Map([...users.keys()].map(a => [accountDigest(a), a]));
    for (const wallet of new Set(trades.map(x => x.wallet))) {
      if (owners.has(wallet)) continue;
      if (teamWallets.has(wallet)) { owners.set(wallet, { kind: 'team' }); continue; }
      const linked = links ? await links.ownerOf(wallet, origin).catch(() => null) : null;
      if (address(linked)) {
        owners.set(wallet, { kind: 'account', account: linked });
        const u = user(linked); u.wallets.add(wallet);
        await command('HSETNX', LINKS, wallet, JSON.stringify({ account: linked, at: null }));
        continue;
      }
      const agent = json(await command('GET', agentWalletKey(wallet)));
      if (agent?.owner) { owners.set(wallet, { kind: 'agent', ownerDigest: agent.owner, agentId: agent.agentId ?? null }); continue; }
      owners.set(wallet, { kind: 'unlinked' });
    }

    const unlinked = new Map(), agents = new Map(), totals = emptyTrades(), perMarket = new Map(markets.map(m => [m.namespace, { ...emptyTrades(), traders: new Set() }]));
    for (const trade of trades) {
      const owner = owners.get(trade.wallet);
      if (owner.kind === 'team' || owner.kind === 'account' && team.has(owner.account)) continue;
      if (owner.kind === 'account') addTrade(user(owner.account).trades, trade);
      else if (owner.kind === 'agent') {
        const id = owner.ownerDigest + ':' + owner.agentId;
        if (!agents.has(id)) agents.set(id, { agentId: owner.agentId, account: digests.get(owner.ownerDigest) ?? null, wallet: trade.wallet, trades: emptyTrades() });
        addTrade(agents.get(id).trades, trade);
      } else {
        if (!unlinked.has(trade.wallet)) unlinked.set(trade.wallet, { wallet: trade.wallet, trades: emptyTrades() });
        addTrade(unlinked.get(trade.wallet).trades, trade);
      }
      addTrade(totals, trade);
      const m = perMarket.get(trade.namespace); addTrade(m, trade); if (trade.kind === 'buy') m.traders.add(trade.wallet);
    }

    const approved = u => u.team || openAccess || (u.application?.decision ? u.application.decision === 'approved' : u.legacy);
    const members = [...users.values()].filter(u => !u.team);
    const recent = ms => ms !== null && ms > t - DAY;
    const funnel = [
      { key: 'signedIn', label: 'Signed in', count: members.length },
      { key: 'requested', label: 'Access requested', count: members.filter(u => u.application && u.application.state !== 'withdrawn').length,
        detail: { emailVerified: members.filter(u => u.application?.verifiedAt || ['pending', 'approved', 'declined', 'revoked'].includes(u.application?.state)).length,
          withdrawn: members.filter(u => u.application?.state === 'withdrawn').length } },
      { key: 'granted', label: 'Access granted', count: members.filter(approved).length },
      { key: 'linked', label: 'Wallet linked', count: members.filter(u => u.wallets.size > 0).length },
      { key: 'funded', label: 'Got starter MON', count: members.filter(u => u.starter?.sent).length },
      { key: 'traded', label: 'Made at least one bet', count: members.filter(u => u.trades.buys > 0).length },
      { key: 'active7d', label: 'Bet in the last 7 days', count: members.filter(u => u.trades.lastBuyAt !== null && u.trades.lastBuyAt > t - 7 * DAY).length },
    ];

    const days = Array.from({ length: 14 }, (_, i) => dayOf(t - (13 - i) * DAY));
    const daily = new Map(days.map(day => [day, { day, signIns: 0, requests: 0, verified: 0, approvals: 0, firstBets: 0, bets: 0, singles: 0, combined: 0 }]));
    const bump = (ms, field) => { if (ms !== null && daily.has(dayOf(ms))) daily.get(dayOf(ms))[field]++; };
    for (const u of members) {
      bump(u.firstSignIn, 'signIns'); bump(u.application?.createdAt ?? null, 'requests'); bump(u.application?.verifiedAt ?? null, 'verified');
      bump(u.application?.approvedAt ?? null, 'approvals'); bump(u.trades.firstBuyAt, 'firstBets');
    }
    for (const trade of trades) {
      const owner = owners.get(trade.wallet);
      if (trade.kind !== 'buy' || owner.kind !== 'account' || team.has(owner.account)) continue;
      bump(trade.at, 'bets'); bump(trade.at, trade.claim.kind === 'single' ? 'singles' : 'combined');
    }
    const memberBuys = trades.filter(x => x.kind === 'buy' && owners.get(x.wallet).kind === 'account' && !team.has(owners.get(x.wallet).account));
    const syncState = json(syncRaw);

    return {
      schema: 'flurbo.user-metrics.v1', generatedAt: t,
      funds: funding ? (funding.latest() ?? await funding.check().catch(() => null)) : null,
      notes: { signInsTrackedSince: Math.min(...members.map(u => u.firstSignIn).filter(x => x !== null), t), applications: applicationsStatus,
        excludedAccounts: team.size, inviteOnly: !openAccess },
      funnel,
      last24h: { signIns: members.filter(u => recent(u.firstSignIn)).length, requests: members.filter(u => recent(u.application?.createdAt ?? null)).length,
        approvals: members.filter(u => recent(u.application?.approvedAt ?? null)).length, firstBets: members.filter(u => recent(u.trades.firstBuyAt)).length,
        bets: memberBuys.filter(x => recent(x.at)).length, singles: memberBuys.filter(x => recent(x.at) && x.claim.kind === 'single').length,
        combined: memberBuys.filter(x => recent(x.at) && x.claim.kind === 'combined').length },
      daily: [...daily.values()],
      totals: publicTrades(totals),
      markets: markets.map(m => { const x = perMarket.get(m.namespace); return { ...m, ...publicTrades(x), traders: x.traders.size }; }),
      sync: { complete: syncComplete, lastRunAt: syncState?.at ?? null },
      users: [...users.values()].map(u => ({ account: u.account, team: u.team, firstSignIn: u.firstSignIn, lastSignIn: u.lastSignIn,
        application: u.application, approved: approved(u), wallets: u.wallets.size, linkedAt: u.linkedAt, starter: u.starter?.sent ?? false,
        trades: publicTrades(u.trades) }))
        .sort((a, b) => (b.trades.lastBuyAt ?? 0) - (a.trades.lastBuyAt ?? 0) || (b.firstSignIn ?? 0) - (a.firstSignIn ?? 0)),
      agents: [...agents.values()].map(a => ({ agentId: a.agentId, account: a.account, wallet: a.wallet, trades: publicTrades(a.trades) })),
      unlinked: [...unlinked.values()].map(u => ({ wallet: u.wallet, trades: publicTrades(u.trades) })),
    };
  }

  function digestText(r, day) {
    const f = Object.fromEntries(r.funnel.map(s => [s.key, s]));
    const pending = r.markets.filter(m => !m.scanned.complete).map(m => `${m.label} ${m.scanned.percent}%`);
    return [
      `Flurbo daily metrics, ${day} (UTC). Team accounts are excluded.`,
      [`Signed in: ${f.signedIn.count} (+${r.last24h.signIns} in the last 24 hours)`,
        `Access requested: ${f.requested.count} (+${r.last24h.requests}), email verified ${f.requested.detail.emailVerified}`,
        `Access granted: ${f.granted.count} (+${r.last24h.approvals})`,
        `Wallet linked: ${f.linked.count}`, `Got starter MON: ${f.funded.count}`,
        `Made at least one bet: ${f.traded.count} (+${r.last24h.firstBets} new)`, `Bet in the last 7 days: ${f.active7d.count}`].join('\n'),
      `Bets in the last 24 hours: ${r.last24h.bets} (${r.last24h.singles} single, ${r.last24h.combined} combined)`,
      `All bets so far: ${r.totals.buys} (${r.totals.singles} single, ${r.totals.combined} combined)`,
      `Wallets that traded without a linked Flurbo account: ${r.unlinked.length}${r.unlinked.length ? '. Someone may be calling the contracts directly.' : ''}`,
      r.notes.applications === 'ok' ? null : 'Application numbers are unavailable. Run migration 002 in Supabase.',
      pending.length ? `Trade data still scanning: ${pending.join(', ')}` : 'Trade data is up to date.',
      ...[['AUSD dispenser', r.funds?.dispenser], ['Starter MON wallet', r.funds?.starter]].filter(([, w]) => w)
        .map(([name, w]) => `${name}: ${w.balance} ${w.unit}, about ${w.left} ${w.leftLabel} left${w.low ? '. LOW, top it up.' : '.'}`),
      'Details: https://flurbo.singu.online/metrics',
    ].filter(Boolean).join('\n\n');
  }

  // One summary email per UTC day, after FLURBO_METRICS_DIGEST_UTC (default 03:30, 9:00 in India).
  async function digest() {
    if (env.FLURBO_METRICS_DIGEST !== 'true') return 'disabled';
    const [hh, mm] = (env.FLURBO_METRICS_DIGEST_UTC || '03:30').split(':').map(Number);
    if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) throw Error('Invalid FLURBO_METRICS_DIGEST_UTC');
    const t = now(), day = dayOf(t), due = Date.parse(`${day}T00:00:00Z`) + (hh * 60 + mm) * 60_000;
    if (t < due) return 'not_due';
    const key = PREFIX + 'digest:' + day;
    if (await command('SET', key, String(t), 'NX', 'EX', 259_200) !== 'OK') return 'sent';
    try {
      const config = emailConfig(env), send = deliver || resendDelivery(config);
      await send({ key: `flurbo-metrics-${day}`, body: { from: config.from, to: config.to, subject: `Flurbo daily metrics, ${day}`, text: digestText(await report(), day) } });
      return 'sent_now';
    } catch (error) { await command('DEL', key); throw error; }
  }

  return { recordSignIn, recordLink, recordExistingLinks, sync, report, digest, digestText,
    async tick() { const s = await sync(); const d = await digest().catch(() => 'digest_failed'); return `${s.complete ? 'synced' : 'scanning'}; digest ${d}`; } };
}
