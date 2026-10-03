import { FlurboError } from './errors.ts';
import { CHAIN_ID, SCHEMAS } from './version.ts';
import { parseAtoms } from './amounts.ts';
import { type Claim, assertClaim, claimFromJSON } from './claims.ts';

// Runtime validation for the Flurbo app APIs the SDK reads. External data is untrusted: an unexpected
// shape raises invalid_response rather than being guessed at.
const bad = (what: string): never => { throw new FlurboError('invalid_response', `Unexpected ${what} from the server.`); };
const obj = (v: unknown, what: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(what));
const addr = (v: unknown, what: string): string => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : bad(what));
const int = (v: unknown, what: string): number => (Number.isSafeInteger(v) ? v as number : bad(what));

export type Namespace = 'pilot' | `practice-${string}`;
export const isNamespace = (v: unknown): v is Namespace => v === 'pilot' || (typeof v === 'string' && /^practice-[0-9a-f]{40}$/.test(v));

export type Snapshot = { chainId: number; pool: string; blockNumber: bigint; blockHash: string; timestamp: number };
export type DirectoryEntry = { namespace: Namespace; label: string; pool: string; closesAt: number };
// source: the record settlement reads, when the server lists it. Runtimes cite it as evidence when its host is allowed.
export type MarketEvent = { index: number; id: string; question: string; yesRule: string; noRule: string; observationEndsAt: number; source?: { publisher: string | null; referenceUrl: string | null } };
export type Market = {
  namespace: Namespace; pool: string; rulesHash: string; title: string; closesAt: number; open: boolean; resolved: boolean;
  events: MarketEvent[]; snapshot: Snapshot;
  // One-share buy costs at the snapshot. A finite purchase cost, not a probability. Null when closed.
  oneShareBuyAtoms: { yes: bigint | null; no: bigint | null }[];
};
// Model-implied pair values from the pool state, in tenths of a percentage point. Null means the
// server could not certify the rounding; it is never shown as zero.
export type PairImplied = {
  pool: string; a: number; b: number; snapshot: Snapshot; expiresAt: number;
  a_yes: number | null; b_yes: number | null; both: number | null; independent: number | null; difference: number | null;
};
export type Quote = {
  schema: typeof SCHEMAS.quote; claim: Claim; side: 'buy' | 'sell'; quantityAtoms: bigint;
  // Buy: the pool's quoteBuy cost. Sell: quoteSell proceeds. Read from the contract at the snapshot block.
  amountAtoms: bigint; snapshot: Snapshot; expiresAt: number; source: 'pool.quoteBuy' | 'pool.quoteSell' | 'fixture';
};
// Model-implied probability that a claim pays, from the canonical claim analytics (tenths of a percentage
// point), with the independence baseline of its selected events. A model value, not an executable price.
export type ClaimImplied = { pool: string; claim: Claim; snapshot: Snapshot; expiresAt: number; market: number | null; independent: number | null; difference: number | null };
export function parseClaimImplied(v: unknown, pool: string, eventCount: number): ClaimImplied {
  const r = obj(v, 'claim analytics'), values = obj(r.values, 'claim analytics values');
  if (r.schema !== SCHEMAS.claimImplied || r.chainId !== CHAIN_ID || addr(r.pool, 'pool') !== pool || r.unit !== 'tenths_of_percentage_point') bad('claim analytics');
  const val = (x: unknown) => (x === null ? null : Number.isSafeInteger(x) ? x as number : bad('claim analytics value'));
  const claim = assertClaim({ chainId: CHAIN_ID, pool, scope: int(r.scope, 'scope'), mask: typeof r.mask === 'string' ? parseAtoms(r.mask, 'mask') : bad('mask') }, eventCount);
  return { pool, claim, snapshot: parseSnapshot(r.snapshot, pool), expiresAt: int(r.expiresAt, 'expiry'), market: val(values.market), independent: val(values.independent), difference: val(values.difference) };
}
export type QuoteResult = { status: 'ok'; quote: Quote } | { status: 'unavailable'; reason: 'market_closed' | 'unsupported_claim' | 'quantity_limit' | 'quote_unavailable'; detail: string };

export function parseSnapshot(v: unknown, pool: string): Snapshot {
  const s = obj(v, 'snapshot');
  if (typeof s.blockNumber !== 'string' || !/^[0-9]{1,20}$/.test(s.blockNumber) || typeof s.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(s.blockHash)) bad('snapshot');
  return { chainId: CHAIN_ID, pool, blockNumber: BigInt(s.blockNumber as string), blockHash: (s.blockHash as string).toLowerCase(), timestamp: int(s.timestamp, 'snapshot time') };
}

export function parseDirectory(v: unknown): DirectoryEntry[] {
  const d = obj(v, 'market directory');
  if (d.schema !== 'flurbo.market-directory.v1' || !Array.isArray(d.markets)) bad('market directory');
  return (d.markets as unknown[]).map(raw => {
    const m = obj(raw, 'market entry');
    if (!isNamespace(m.namespace) || typeof m.label !== 'string') bad('market entry');
    return { namespace: m.namespace as Namespace, label: m.label as string, pool: addr(m.pool, 'pool'), closesAt: int(m.closesAt, 'close time') };
  });
}

export function parseMarket(v: unknown, namespace: Namespace): Market {
  const m = obj(v, 'market'), manifest = obj(m.manifest, 'manifest'), publication = obj(manifest.publication, 'publication'), draft = obj(publication.draft, 'draft');
  if (manifest.chainId !== CHAIN_ID || !Array.isArray(draft.events) || typeof m.open !== 'boolean' || typeof m.resolved !== 'boolean' || !Array.isArray(m.prices)) bad('market');
  const pool = addr(manifest.pool, 'pool');
  if (namespace.startsWith('practice-') && pool !== '0x' + namespace.slice(9)) throw new FlurboError('cross_pool', 'The server returned a different pool than requested.');
  const events = (draft.events as unknown[]).map((raw, index) => {
    const e = obj(raw, 'event');
    if (typeof e.id !== 'string' || typeof e.question !== 'string') bad('event');
    const src = e.source && typeof e.source === 'object' ? e.source as Record<string, unknown> : null;
    const source = src && typeof src.referenceUrl === 'string' && /^https:\/\//.test(src.referenceUrl) ? { source: { publisher: typeof src.publisher === 'string' ? src.publisher : null, referenceUrl: src.referenceUrl } } : {};
    return { index, id: e.id as string, question: e.question as string, yesRule: String(e.yesRule ?? ''), noRule: String(e.noRule ?? ''), observationEndsAt: int(e.observationEndsAt, 'observation time'), ...source };
  });
  const prices = (m.prices as unknown[]).map(raw => {
    const p = obj(raw, 'price');
    const read = (x: unknown) => (x === null ? null : parseAtoms(x, 'price'));
    return { yes: read(p.yes), no: read(p.no) };
  });
  if (prices.length !== events.length) bad('prices');
  return { namespace, pool, rulesHash: String(manifest.rulesHash), title: String(draft.title ?? ''), closesAt: int(draft.closesAt, 'close time'),
    open: m.open as boolean, resolved: m.resolved as boolean, events, snapshot: parseSnapshot(m.snapshot, pool), oneShareBuyAtoms: prices };
}

export function parsePairAnalytics(v: unknown, pool: string): PairImplied {
  const r = obj(v, 'analytics'), values = obj(r.values, 'analytics values');
  if (r.schema !== 'flurbo.pair-analytics.v1' || r.chainId !== CHAIN_ID || addr(r.pool, 'pool') !== pool || r.unit !== 'tenths_of_percentage_point') bad('analytics');
  const val = (x: unknown) => (x === null ? null : Number.isSafeInteger(x) ? x as number : bad('analytics value'));
  return { pool, a: int(r.a, 'event'), b: int(r.b, 'event'), snapshot: parseSnapshot(r.snapshot, pool), expiresAt: int(r.expiresAt, 'expiry'),
    a_yes: val(values.a), b_yes: val(values.b), both: val(values.joint), independent: val(values.independent), difference: val(values.difference) };
}

export function parseQuoteResult(v: unknown, eventCount: number): QuoteResult {
  const r = obj(v, 'quote');
  if (r.status === 'unavailable') {
    if (!['market_closed', 'unsupported_claim', 'quantity_limit', 'quote_unavailable'].includes(r.reason as string)) bad('quote');
    return { status: 'unavailable', reason: r.reason as 'market_closed', detail: String(r.detail ?? '') };
  }
  if (r.status !== 'ok') bad('quote');
  const q = obj(r.quote, 'quote');
  if (q.schema !== SCHEMAS.quote || !['buy', 'sell'].includes(q.side as string)) bad('quote');
  // The label is preserved, never inferred: a fixture quote stays marked as a fixture.
  const source = q.source === 'fixture' ? 'fixture' : q.source === (q.side === 'buy' ? 'pool.quoteBuy' : 'pool.quoteSell') ? q.source as Quote['source'] : bad('quote source');
  const claim = claimFromJSON(q.claim, eventCount), snapshot = parseSnapshot(q.snapshot, claim.pool);
  const quantity = parseAtoms(q.quantityAtoms, 'quantity'), amount = parseAtoms(q.amountAtoms, 'quote');
  if (quantity === 0n || (q.side === 'buy' && (amount === 0n || amount > quantity))) bad('quote amount');
  return { status: 'ok', quote: { schema: SCHEMAS.quote, claim, side: q.side as 'buy', quantityAtoms: quantity, amountAtoms: amount, snapshot,
    expiresAt: int(q.expiresAt, 'expiry'), source } };
}

export const quoteToJSON = (q: Quote) => ({ schema: q.schema, claim: { chainId: q.claim.chainId, pool: q.claim.pool, scope: q.claim.scope, mask: q.claim.mask.toString() },
  side: q.side, quantityAtoms: q.quantityAtoms.toString(), amountAtoms: q.amountAtoms.toString(),
  snapshot: { blockNumber: q.snapshot.blockNumber.toString(), blockHash: q.snapshot.blockHash, timestamp: q.snapshot.timestamp }, expiresAt: q.expiresAt, source: q.source });

// The existing unsigned transaction review (flurbo.pilot-review.v1). The SDK checks that the review still
// carries the exact claim and quantity the agent proposed; the web client's validator re-checks calldata.
export type ReviewSummary = { action: string; owner: string; claim: Claim | null; quantityAtoms: bigint | null; amountAtoms: bigint; expiresAt: number; snapshot: Snapshot; approvalFirst: boolean };
export function parseReview(v: unknown, eventCount: number): ReviewSummary {
  const r = obj(v, 'review'), requested = obj(r.requested, 'review request'), manifest = obj(r.manifest, 'review manifest'), tx = obj(r.transaction, 'transaction');
  if (r.schema !== 'flurbo.pilot-review.v1' || tx.chainId !== '0x279f' || tx.value !== '0x0') bad('review');
  const pool = addr(manifest.pool, 'pool'), owner = addr(requested.owner, 'owner');
  if (addr(tx.from, 'sender') !== owner) bad('review sender');
  const trade = ['buy', 'sell'].includes(requested.action as string);
  const claim = trade ? assertClaim({ chainId: CHAIN_ID, pool, scope: int(requested.scope, 'scope'), mask: parseAtoms(requested.mask, 'mask') }, eventCount) : null;
  return { action: String(r.action), owner, claim, quantityAtoms: trade ? parseAtoms(requested.quantity, 'quantity') : null, amountAtoms: parseAtoms(r.amountAtoms, 'amount'),
    expiresAt: int(r.expiresAt, 'expiry'), snapshot: parseSnapshot(r.snapshot, pool), approvalFirst: r.action === 'approve' };
}
