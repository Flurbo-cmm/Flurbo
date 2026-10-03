import { FlurboError } from './errors.ts';
import { paysIn } from './claims.ts';

// Deterministic execution policy (protocol/specs/transactions.md). Software checks in a compliant runtime:
// they bound what this runtime does, not what the wallet key can do.
export type SpendWindow = { seconds: number; atoms: string };
export type PolicyConfig = {
  markets: string[]; maxQuantityAtoms: string; maxTradeCostAtoms: string; maxSlippageBps: number;
  spend: { totalAtoms: string; windows: SpendWindow[] };
  maxPositionAtoms: string; maxWorstCaseLossAtoms: string;
  gas: { maxFeeWei: string; reserveWei: string };
  quoteMaxAgeSeconds: number; minSecondsBeforeClose: number; maxPending: number; allowSell: boolean; allowRedeem: boolean;
};
export type JournalStatus = 'planned' | 'signed' | 'broadcast' | 'confirmed' | 'reverted' | 'mismatch' | 'replaced' | 'expired' | 'abandoned';
export const UNFINISHED: readonly JournalStatus[] = ['planned', 'signed', 'broadcast'];
export type PolicyAction = 'buy' | 'sell' | 'redeem';
// A journal entry as policy sees it. `costAtoms`: actual collateral of a confirmed entry (cost, proceeds or payout).
export type PolicyEntry = { id: string; action: PolicyAction | 'approve'; namespace: string; claim: { scope: number; mask: string } | null;
  quantityAtoms: string; limitAtoms: string; costAtoms: string | null; status: JournalStatus; plannedAt: number };
export type PolicyInput = {
  policy: PolicyConfig; now: number;
  market: { namespace: string; pool: string; eventCount: number; closesAt: number; open: boolean; resolved: boolean };
  wallet: { nativeBalanceWei: string; holdings: { scope: number; mask: string; quantityAtoms: string }[] };
  journal: PolicyEntry[];
  candidate: { action: PolicyAction; namespace: string; claim: { scope: number; mask: string }; quantityAtoms: string; limitAtoms: string;
    slippageBps: number; quoteBlockTimestamp: number; gasLimit: string; maxFeePerGas: string };
};
export const VIOLATIONS = ['SERVICE_LIMIT', 'MARKET_NOT_ALLOWED', 'MARKET_CLOSED', 'MARKET_NOT_RESOLVED', 'TOO_CLOSE_TO_CLOSE', 'ACTION_DISABLED',
  'HOLDINGS_INSUFFICIENT', 'QUANTITY_LIMIT', 'TRADE_COST_LIMIT', 'SLIPPAGE_LIMIT', 'QUOTE_STALE', 'TOTAL_SPEND_LIMIT', 'WINDOW_SPEND_LIMIT',
  'POSITION_LIMIT', 'WORST_CASE_LOSS_LIMIT', 'GAS_FEE_LIMIT', 'GAS_RESERVE', 'PENDING_LIMIT'] as const;
export type Violation = typeof VIOLATIONS[number];
export const SERVICE_MAX_ATOMS = 100_000_000n;
export const SERVICE_SLIPPAGE_BPS: readonly number[] = [10, 50, 100];

const n = (v: string): bigint => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) throw new FlurboError('invalid_input', 'Invalid policy amount.'); return BigInt(v); };
const same = (a: { scope: number; mask: string } | null, b: { scope: number; mask: string }) => !!a && a.scope === b.scope && a.mask === b.mask;

// What a buy counts toward spending: confirmed cost, the limit while unfinished or unknown, else zero.
export function spendOf(e: PolicyEntry): bigint {
  if (e.action !== 'buy') return 0n;
  if (e.status === 'confirmed') return n(e.costAtoms ?? '0');
  if (UNFINISHED.includes(e.status) || e.status === 'mismatch') return n(e.limitAtoms);
  return 0n;
}

export function evaluatePolicy(input: PolicyInput): { ok: boolean; violations: Violation[] } {
  const { policy: p, now, market, wallet, journal, candidate: c } = input, found = new Set<Violation>();
  const action = c.action, quantity = n(c.quantityAtoms), limit = n(c.limitAtoms);
  const buy = action === 'buy', trade = buy || action === 'sell';
  if (quantity < 1n || quantity > SERVICE_MAX_ATOMS || limit > SERVICE_MAX_ATOMS || (trade && !SERVICE_SLIPPAGE_BPS.includes(c.slippageBps))) found.add('SERVICE_LIMIT');
  if (!p.markets.includes(c.namespace) || c.namespace !== market.namespace) found.add('MARKET_NOT_ALLOWED');
  const closed = !market.open || now >= market.closesAt;
  if (trade && closed) found.add('MARKET_CLOSED');
  if (action === 'redeem' && !market.resolved) found.add('MARKET_NOT_RESOLVED');
  if (trade && !closed && market.closesAt - now < p.minSecondsBeforeClose) found.add('TOO_CLOSE_TO_CLOSE');
  if ((action === 'sell' && !p.allowSell) || (action === 'redeem' && !p.allowRedeem)) found.add('ACTION_DISABLED');
  const held = wallet.holdings.filter(h => same(h, c.claim)).reduce((s, h) => s + n(h.quantityAtoms), 0n);
  if (!buy && held < quantity) found.add('HOLDINGS_INSUFFICIENT');
  if (quantity > n(p.maxQuantityAtoms)) found.add('QUANTITY_LIMIT');
  if (buy && limit > n(p.maxTradeCostAtoms)) found.add('TRADE_COST_LIMIT');
  if (trade && c.slippageBps > p.maxSlippageBps) found.add('SLIPPAGE_LIMIT');
  if (trade && now - c.quoteBlockTimestamp > p.quoteMaxAgeSeconds) found.add('QUOTE_STALE');
  if (buy) {
    const total = journal.reduce((s, e) => s + spendOf(e), 0n) + limit;
    if (total > n(p.spend.totalAtoms)) found.add('TOTAL_SPEND_LIMIT');
    for (const w of p.spend.windows) {
      const sum = journal.filter(e => e.plannedAt >= now - w.seconds).reduce((s, e) => s + spendOf(e), 0n) + limit;
      if (sum > n(w.atoms)) found.add('WINDOW_SPEND_LIMIT');
    }
    const pendingSame = journal.filter(e => e.action === 'buy' && UNFINISHED.includes(e.status) && e.namespace === c.namespace && same(e.claim, c.claim))
      .reduce((s, e) => s + n(e.quantityAtoms), 0n);
    if (held + pendingSame + quantity > n(p.maxPositionAtoms)) found.add('POSITION_LIMIT');
    if (worstCaseLoss(input) > n(p.maxWorstCaseLossAtoms)) found.add('WORST_CASE_LOSS_LIMIT');
  }
  const fee = n(c.gasLimit) * n(c.maxFeePerGas);
  if (fee > n(p.gas.maxFeeWei)) found.add('GAS_FEE_LIMIT');
  if (n(wallet.nativeBalanceWei) - fee < n(p.gas.reserveWei)) found.add('GAS_RESERVE');
  if (journal.filter(e => UNFINISHED.includes(e.status)).length >= p.maxPending) found.add('PENDING_LIMIT');
  const violations = VIOLATIONS.filter(v => found.has(v));
  return { ok: violations.length === 0, violations };
}

// Agent cost basis in this pool minus the lowest total payout over every Yes/No outcome of its events,
// counting only positions the journal shows the agent took (plus the candidate).
export function worstCaseLoss(input: PolicyInput): bigint {
  const { market, journal, candidate: c } = input;
  const positions = new Map<string, { scope: number; mask: bigint; quantity: bigint }>();
  const add = (claim: { scope: number; mask: string }, q: bigint) => {
    const key = `${claim.scope}:${claim.mask}`, cur = positions.get(key) ?? { scope: claim.scope, mask: BigInt(claim.mask), quantity: 0n };
    cur.quantity += q; positions.set(key, cur);
  };
  let cost = 0n;
  for (const e of journal) {
    if (e.namespace !== market.namespace || !e.claim) continue;
    if (e.action === 'buy' && e.status === 'confirmed') { add(e.claim, n(e.quantityAtoms)); cost += n(e.costAtoms ?? '0'); }
    else if (e.action === 'buy' && UNFINISHED.includes(e.status)) { add(e.claim, n(e.quantityAtoms)); cost += n(e.limitAtoms); }
    else if ((e.action === 'sell' || e.action === 'redeem') && e.status === 'confirmed') add(e.claim, -n(e.quantityAtoms));
  }
  add(c.claim, n(c.quantityAtoms)); cost += n(c.limitAtoms);
  let floor: bigint | null = null;
  for (let state = 0; state < 2 ** market.eventCount; state++) {
    let payout = 0n;
    for (const pos of positions.values()) if (pos.quantity > 0n && paysIn({ chainId: 10143, pool: market.pool, scope: pos.scope, mask: pos.mask }, state)) payout += pos.quantity;
    if (floor === null || payout < floor) floor = payout;
  }
  return cost - (floor ?? 0n);
}

// Flurbo's published policy tightens the local configuration; it never loosens it.
export type FlurboPolicy = { version: number; paused: boolean; liveEnabled: boolean; limits: { maxTradeCostAtoms: string | null; windows: SpendWindow[] } };
export type LiveBlock = 'local_paper_mode' | 'live_disabled' | 'paused' | 'policy_stale';
export function effectivePolicy(local: { mode: 'paper' | 'live'; maxTradeCostAtoms: string; spend: { totalAtoms: string; windows: SpendWindow[] } },
  flurbo: FlurboPolicy | null, readAt: number | null, now: number, policyMaxAgeSeconds: number) {
  const serverMax = flurbo?.limits.maxTradeCostAtoms ?? null;
  const maxTradeCostAtoms = serverMax !== null && n(serverMax) < n(local.maxTradeCostAtoms) ? serverMax : local.maxTradeCostAtoms;
  const windows = [...local.spend.windows, ...(flurbo?.limits.windows ?? [])];
  const stale = readAt === null || now - readAt > policyMaxAgeSeconds;
  const reason: LiveBlock | null = local.mode !== 'live' ? 'local_paper_mode' : flurbo === null ? 'policy_stale'
    : !flurbo.liveEnabled ? 'live_disabled' : flurbo.paused ? 'paused' : stale ? 'policy_stale' : null;
  return { maxTradeCostAtoms, windows, liveAllowed: reason === null, reason };
}
