import { FlurboError } from './errors.ts';
import { CHAIN_ID, SCHEMAS } from './version.ts';
import { type Answer, type Claim, allOf, anyOf, exactlyOne, claimKey, claimFromJSON } from './claims.ts';
import type { Transport } from './client.ts';

// OFFLINE FIXTURE DATA. Not live, not a real pool, not a real quote. Every label says so, and the fixture
// transport reports kind "fixture" so a client in fixture mode can never be mistaken for live data.
// The quote table is a fixed set of hand-written numbers for deterministic research and tests. It is not
// produced by a pricing model and must never be used to price a real trade.
export const FIXTURE_POOL = '0x00000000000000000000000000000000f1c7a0e0';
export const FIXTURE_NAMESPACE = `practice-${FIXTURE_POOL.slice(2)}` as const;
export const FIXTURE_SNAPSHOT = { blockNumber: '65000000', blockHash: '0x' + 'f1'.repeat(32), timestamp: 1_790_500_000 };
export const FIXTURE_NOW = FIXTURE_SNAPSHOT.timestamp + 10;
const QUOTE_TTL = 60;

export const FIXTURE_MARKET = {
  manifest: { chainId: CHAIN_ID, pool: FIXTURE_POOL, rulesHash: '0x' + 'ab'.repeat(32),
    publication: { mode: 'rehearsal', draft: { title: 'Offline fixture: Ethereum block activity (not live)', closesAt: FIXTURE_SNAPSHOT.timestamp + 86_400, events: [
      { id: 'fixture-fullness', question: 'Fixture: Will the selected Ethereum block be at least 75% full?', yesRule: 'Fixture rule, not live.', noRule: 'Fixture rule, not live.', observationEndsAt: FIXTURE_SNAPSHOT.timestamp + 90_000 },
      { id: 'fixture-transactions', question: 'Fixture: Will the selected Ethereum block contain at least 150 transactions?', yesRule: 'Fixture rule, not live.', noRule: 'Fixture rule, not live.', observationEndsAt: FIXTURE_SNAPSHOT.timestamp + 90_000 },
      { id: 'fixture-blobs', question: 'Fixture: Will the selected Ethereum block include at least 3 data blobs?', yesRule: 'Fixture rule, not live.', noRule: 'Fixture rule, not live.', observationEndsAt: FIXTURE_SNAPSHOT.timestamp + 90_000 },
    ] } } },
  snapshot: FIXTURE_SNAPSHOT, open: true, resolved: false,
  prices: [{ yes: '604000', no: '404000' }, { yes: '554000', no: '454000' }, { yes: '401000', no: '607000' }],
};

// Hand-set one-share (10^6 atom) buy costs for events 0 and 1, fixed for the offline snapshot.
const n = 3, a = (event: number, yes: boolean): Answer => ({ event, yes });
const FIXED: [Claim, string][] = [
  [allOf(FIXTURE_POOL, n, [a(0, true)]), '604000'], [allOf(FIXTURE_POOL, n, [a(0, false)]), '404000'],
  [allOf(FIXTURE_POOL, n, [a(1, true)]), '554000'], [allOf(FIXTURE_POOL, n, [a(1, false)]), '454000'],
  [allOf(FIXTURE_POOL, n, [a(0, true), a(1, true)]), '334000'], [allOf(FIXTURE_POOL, n, [a(0, true), a(1, false)]), '274000'],
  [allOf(FIXTURE_POOL, n, [a(0, false), a(1, true)]), '224000'], [allOf(FIXTURE_POOL, n, [a(0, false), a(1, false)]), '184000'],
  [anyOf(FIXTURE_POOL, n, [a(0, true), a(1, true)]), '822000'], [exactlyOne(FIXTURE_POOL, n, [a(0, true), a(1, true)]), '494000'],
];
export const FIXTURE_QUOTES = new Map(FIXED.map(([c, cost]) => [claimKey(c), cost]));

export const FIXTURE_ANALYTICS = { schema: 'flurbo.pair-analytics.v1', model: 'fixture', chainId: CHAIN_ID, pool: FIXTURE_POOL, snapshot: FIXTURE_SNAPSHOT,
  expiresAt: FIXTURE_SNAPSHOT.timestamp + 60, a: 0, b: 1, unit: 'tenths_of_percentage_point',
  values: { a: 600, b: 550, joint: 330, givenYes: 600, givenNo: 600, independent: 330, difference: 0 }, reasons: {} };

// A fixture forecast: the forecaster thinks the two events move together more than the pool implies.
export const FIXTURE_FORECAST = {
  schema: SCHEMAS.forecast, pool: FIXTURE_POOL,
  joint: { events: [0, 1], statesPpm: ['260000', '170000', '120000', '450000'] },
  evidence: [{ id: 'fixture-evidence-1', title: 'Fixture note: recent blocks near the gas target', source: 'Offline fixture', url: null,
    observedAt: new Date((FIXTURE_SNAPSHOT.timestamp - 3600) * 1000).toISOString(), note: 'Illustrative fixture evidence. Not a real observation.' }],
  assumptions: ['Busy blocks tend to be both full and transaction-heavy.'],
  uncertainty: 'Illustrative only. The joint estimate could reasonably be anywhere from 38% to 50%.',
  explanation: 'Full blocks and high transaction counts usually come from the same demand, so they should happen together more often than independence suggests.',
  selfReportedConfidence: 'medium', source: { kind: 'fixture', name: 'offline-fixture' }, createdAt: new Date((FIXTURE_SNAPSHOT.timestamp - 60) * 1000).toISOString(),
};

// Offline transport. Serves only the fixture pool. Quotes outside the fixed table are unavailable.
export function fixtureTransport(): Transport {
  const ok = (body: unknown) => ({ status: 200, body: structuredClone(body), retryAfter: null });
  return {
    kind: 'fixture',
    async send({ method, path, body, signal }) {
      if (signal.aborted) throw new FlurboError('aborted', 'The request was cancelled.');
      if (method === 'GET' && path === '/api/market-directory')
        return ok({ schema: 'flurbo.market-directory.v1', markets: [{ namespace: FIXTURE_NAMESPACE, label: 'Offline fixture pool (not live)', pool: FIXTURE_POOL, closesAt: FIXTURE_MARKET.manifest.publication.draft.closesAt }] });
      if (method === 'GET' && path === `/api/${FIXTURE_NAMESPACE}/markets`) return ok(FIXTURE_MARKET);
      if (method === 'POST' && path === `/api/${FIXTURE_NAMESPACE}/analytics`) {
        const b = body as { a?: number; b?: number };
        if (!((b.a === 0 && b.b === 1) || (b.a === 1 && b.b === 0))) return { status: 503, body: { error: 'Fixture analytics exist only for events 0 and 1.' }, retryAfter: null };
        return ok({ ...FIXTURE_ANALYTICS, a: b.a, b: b.b });
      }
      if (method === 'POST' && path === '/api/agents/quote') {
        const q = body as { namespace: string; scope: number; mask: string; quantityAtoms: string; side: string };
        if (q.namespace !== FIXTURE_NAMESPACE) return { status: 404, body: { error: 'Unknown fixture pool.' }, retryAfter: null };
        const claim = claimFromJSON({ chainId: CHAIN_ID, pool: FIXTURE_POOL, scope: q.scope, mask: q.mask }, n), cost = FIXTURE_QUOTES.get(claimKey(claim));
        if (q.side !== 'buy' || q.quantityAtoms !== '1000000' || !cost) return ok({ status: 'unavailable', reason: 'quote_unavailable', detail: 'The offline fixture only quotes one-share buys of its fixed claims.' });
        return ok({ status: 'ok', quote: { schema: SCHEMAS.quote, claim: { chainId: CHAIN_ID, pool: FIXTURE_POOL, scope: claim.scope, mask: claim.mask.toString() },
          side: 'buy', quantityAtoms: q.quantityAtoms, amountAtoms: cost, snapshot: FIXTURE_SNAPSHOT, expiresAt: FIXTURE_SNAPSHOT.timestamp + QUOTE_TTL, source: 'fixture' } });
      }
      return { status: 404, body: { error: 'Not available in offline fixture mode.' }, retryAfter: null };
    },
  };
}
