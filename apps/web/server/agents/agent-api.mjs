import { randomUUID } from 'node:crypto';
import { pilotCall, COMBINATION_LIMIT_MESSAGE } from '../../shared/pilot.mjs';
import { agentStore, memoryBackend, redisBackend, addPaperFill, addConfirmedPurchase, compactReview, transactionDigest, ownsPurchase, VERIFIED, AGENT_LIMITS } from './agent-store.mjs';
import { quoteClaims, verifyReceipt, readResolution } from './agent-market.mjs';
import { runtimeApi, defaultRuntimePolicy, policyView, connection } from './runtime-api.mjs';
import {agentPortfolio} from './portfolio.mjs';
import { RuntimeError } from './credentials.mjs';
import { memoryWindow } from '../request-limits.mjs';
import { STRATEGY, DEFAULT_CONFIG, SCHEMAS, FlurboError, assertConfig, candidateClaims, decide, claimKey, parseMarket, parseForecast, parseQuoteResult,
  parsePairAnalytics, parseClaimImplied, decisionToJSON, decisionFromJSON, recordPaperFill, paperFillToJSON, paperFillFromJSON, evaluatePaper, forecastToJSON, FILL_MODEL,
  claimFromJSON, isNamespace, parseAtoms } from '../../../../packages/sdk/src/index.ts';

// Agent routes. Called only after the application's session and invite checks, with the verified login.
// Ownership always comes from that login. Agents never sign: proposals return an unsigned review that
// the user confirms in MetaMask through the existing transaction flow.
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const keysExactly = (input, allowed, required = allowed) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) || required.some(k => !(k in input)))
    fail(400, 'Unexpected request fields.');
  return input;
};
const PROPOSAL_TTL_SECONDS = 300;
// A decision is reserved for this long while its transaction is prepared. A server that stops mid-way
// leaves a reservation that lapses instead of blocking the decision forever.
const RESERVATION_SECONDS = 60;
// An unsent review stays recoverable (a hash can still be attached) for a day after its decision lapses.
const RECOVERY_SECONDS = 86_400;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const MODES = ['paper', 'approval'];

function configFromInput(raw, maxTrade) {
  const c = keysExactly(raw, ['quantityAtoms', 'slippageBps', 'minEdgeBps', 'minEdgeAtoms', 'maxCostAtoms', 'minEvidence', 'maxEvidenceAgeDays', 'includeSingles', 'paperBudgetAtoms']);
  let config;
  try {
    config = assertConfig({ quantityAtoms: parseAtoms(c.quantityAtoms), slippageBps: c.slippageBps, minEdgeBps: c.minEdgeBps, minEdgeAtoms: parseAtoms(c.minEdgeAtoms),
      maxCostAtoms: parseAtoms(c.maxCostAtoms), minEvidence: c.minEvidence, maxEvidenceAgeDays: c.maxEvidenceAgeDays, includeSingles: c.includeSingles }, maxTrade);
  } catch (e) { fail(400, e instanceof FlurboError ? e.message : 'Invalid strategy settings.'); }
  const paperBudget = parseAtoms(c.paperBudgetAtoms);
  if (paperBudget <= 0n || paperBudget > 10_000_000_000n) fail(400, 'Paper budget must be between 0 and 10,000 test AUSD.');
  return { ...c, quantityAtoms: config.quantityAtoms.toString(), minEdgeAtoms: config.minEdgeAtoms.toString(), maxCostAtoms: config.maxCostAtoms.toString(), paperBudgetAtoms: paperBudget.toString() };
}
const strategyConfig = c => ({ quantityAtoms: BigInt(c.quantityAtoms), slippageBps: c.slippageBps, minEdgeBps: c.minEdgeBps, minEdgeAtoms: BigInt(c.minEdgeAtoms),
  maxCostAtoms: BigInt(c.maxCostAtoms), minEvidence: c.minEvidence, maxEvidenceAgeDays: c.maxEvidenceAgeDays, includeSingles: c.includeSingles });
export const DEFAULT_PROFILE_CONFIG = Object.freeze({ quantityAtoms: DEFAULT_CONFIG.quantityAtoms.toString(), slippageBps: DEFAULT_CONFIG.slippageBps,
  minEdgeBps: DEFAULT_CONFIG.minEdgeBps, minEdgeAtoms: DEFAULT_CONFIG.minEdgeAtoms.toString(), maxCostAtoms: DEFAULT_CONFIG.maxCostAtoms.toString(),
  minEvidence: DEFAULT_CONFIG.minEvidence, maxEvidenceAgeDays: DEFAULT_CONFIG.maxEvidenceAgeDays, includeSingles: DEFAULT_CONFIG.includeSingles, paperBudgetAtoms: '50000000' });

// Proposal lifecycle:
//   preparing -> awaiting-approval | preparation-failed | preparation-expired
//   awaiting-approval -> submitted | rejected (refresh keeps it awaiting-approval with a new review)
//   submitted -> confirmed | approval-confirmed | failed;  approval-confirmed -> awaiting-approval | rejected
// Every review a proposal issues is kept. Expiry, dismissal or archiving does not prove a review was never
// sent, so a hash for any of them can still be recorded (one tracked transaction at a time) and verified.
// Recording a hash is provisional and exclusive to nobody. Ownership of a transaction (one proposal per
// chain and hash, across agents and accounts) is written only when the receipt check proves the chain
// transaction is that proposal's reviewed transaction, atomically with the purchase it counts.
// Every change bumps `version`. A change computed from an older read is refused, never merged.
const hasSubmitted = p => p.transactions.some(t => t.status === 'submitted');
const reserving = (p, now) => p.status === 'preparing' && now < p.reservedUntil;
// Proposals that block another proposal for the same decision. An expired, unsent review still blocks:
// it may have been sent from MetaMask with tracking lost, so the user refreshes or dismisses it first.
const LIVE = ['awaiting-approval', 'submitted', 'approval-confirmed', 'confirmed'];
const blocksDecision = (p, now) => reserving(p, now) || LIVE.includes(p.status);
const decisionDeadline = p => Math.max(p.decision?.proposal ? p.decision.proposal.quoteExpiresAt + PROPOSAL_TTL_SECONDS : 0, p.review?.expiresAt ?? 0);
// Records that are never trimmed: anything preparing, any transaction not yet resolved, and unsent
// reviews that could still be recovered.
export const unresolvedProposal = (p, now) => reserving(p, now) || hasSubmitted(p)
  || (['awaiting-approval', 'approval-confirmed'].includes(p.status) && now < decisionDeadline(p) + RECOVERY_SECONDS);
const TX_FIELDS = ['from', 'to', 'data', 'chainId', 'value'];
const reviewCount = state => state.proposals.reduce((n, p) => n + (p.reviews?.length ?? 0), 0);
const hasReview = (p, review) => p.reviews.some(v => transactionDigest(v.transaction) === transactionDigest(review.transaction));
const reviewLimit = () => fail(409, `This agent has prepared its limit of ${AGENT_LIMITS.reviewsPerAgent} transaction reviews. Create a new agent to continue.`, 'REVIEW_LIMIT');
const requireActive = profile => { if (profile.status === 'archived') fail(409, 'This agent is archived. Its transactions can still be recorded and checked.', 'ARCHIVED'); };

// Proposal status as the user should read it. An expired review with no transaction is shown as expired.
export function proposalView(record, now = nowSeconds()) {
  // The embedded decision stays server-side; replaced reviews are exposed only as the transactions they carried.
  const { decision, reviews, superseded, reservedUntil, ...rest } = record, view = { ...rest, reviewedTransactions: (reviews ?? []).map(v => v.transaction) };
  if (record.status === 'awaiting-approval' && now >= record.review.expiresAt && !hasSubmitted(record)) return { ...view, status: 'expired' };
  if (record.status === 'preparing' && !reserving(record, now)) return { ...view, status: 'preparation-expired' };
  return view;
}
const recordsView = (state, now) => [...state.proposals.map(p => proposalView(p, now)), ...state.paper.recent, ...state.decisions]
  .sort((a, b) => b.createdAt - a.createdAt);

// `previewAllows(account)` re-checks testnet approval on every headless request; `reservedWallets` are
// operator addresses that can never become agent wallets.
export function agentApi({ command = null, hosted = false, serviceFor, links, rpc, now = nowSeconds, previewAllows = null, reservedWallets = new Set(), localCounters = false }) {
  if (hosted && !command) throw new Error('Durable agent storage is required when hosted');
  const store = agentStore(command ? redisBackend(command) : memoryBackend(), { unresolved: p => unresolvedProposal(p, now()) });
  const runtime = runtimeApi({ store, serviceFor, rpc, now, previewAllows, reservedWallets, links, count: localCounters ? memoryWindow() : null });
  // Autonomous runtime agents and assisted (manual forecast, paper and MetaMask approval) agents.
  const assisted = profile => { if (profile.kind === 'runtime') fail(409, 'This agent runs on your own infrastructure. Use the SDK runtime for research and trading.'); };
  const service = namespace => {
    if (!isNamespace(namespace)) fail(400, 'Choose a supported market.');
    const s = serviceFor(namespace);
    if (!s) fail(404, 'That market is not available.');
    return s;
  };
  const load = async (account, id) => { const found = await store.get(account, id); if (!found) fail(404, 'Agent not found.'); return found; };
  const change = async (account, id, fn) => { const result = await store.mutate(account, id, fn); return result ?? fail(404, 'Agent not found.'); };
  const linkedOwner = async (account, owner, origin) => {
    if (typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) fail(400, 'Choose a linked MetaMask wallet.');
    const { wallets } = await links.list(account, origin);
    if (!wallets.includes(owner.toLowerCase())) fail(403, 'Link this MetaMask wallet to your Flurbo account first.');
    return owner.toLowerCase();
  };

  async function evaluate(account, id, input) {
    keysExactly(input, ['forecast']);
    const { profile } = await load(account, id);
    assisted(profile); requireActive(profile);
    if (profile.status !== 'active') fail(409, 'Resume this agent before evaluating.');
    if (!await store.allowEvaluation(account, now() * 1000)) fail(429, 'Evaluation limit reached for this hour. Try later.', 'RATE_LIMITED');
    const svc = service(profile.market.namespace);
    const market = parseMarket(await svc.markets(), profile.market.namespace);
    if (market.pool !== profile.market.pool) fail(409, 'This market no longer matches the agent. Create a new agent.');
    let forecast;
    // The server cannot verify who produced a submitted forecast, so it is always recorded as the user's.
    try { forecast = parseForecast({ ...input.forecast, source: { kind: 'user', name: 'account' } }, { eventCount: market.events.length, pool: market.pool, now: new Date(now() * 1000) }); }
    catch (e) { fail(400, e instanceof FlurboError ? e.message : 'Invalid forecast.'); }
    const config = strategyConfig(profile.config), quotes = new Map();
    const candidates = market.open ? candidateClaims(market, forecast, config) : [];
    if (candidates.length) {
      const snapshot = { blockNumber: market.snapshot.blockNumber.toString(), blockHash: market.snapshot.blockHash, timestamp: market.snapshot.timestamp };
      const results = await quoteClaims({ service: svc, rpc, claims: candidates, quantityAtoms: config.quantityAtoms, snapshot });
      candidates.forEach((claim, i) => quotes.set(claimKey(claim), parseQuoteResult(results[i], market.events.length)));
    }
    let implied = null;
    if (forecast.joint.events.length === 2 && svc.analytics) {
      try { implied = parsePairAnalytics(await svc.analytics({ a: forecast.joint.events[0], b: forecast.joint.events[1] }), market.pool); } catch { implied = null; }
      if (implied && implied.snapshot.blockHash !== market.snapshot.blockHash) implied = { ...implied, stale: true };
    }
    const decision = decide({ market, forecast, config, now: now(), quotes, implied: implied && !implied.stale ? implied : null });
    // Model-implied probability of the proposed claim from the canonical claim analytics. Context for the
    // person approving; the decision itself rests only on the forecast and executable quotes.
    let proposalImplied = null;
    if (decision.proposal && svc.claimAnalytics) {
      try {
        const c = parseClaimImplied(await svc.claimAnalytics({ scope: decision.proposal.claim.scope, mask: decision.proposal.claim.mask.toString() }), market.pool, market.events.length);
        proposalImplied = { marketTenths: c.market, independentTenths: c.independent, differenceTenths: c.difference, sameSnapshot: c.snapshot.blockHash === market.snapshot.blockHash };
      } catch { proposalImplied = null; }
    }
    const record = { id: randomUUID(), kind: 'decision', createdAt: now(), strategy: STRATEGY, forecast: forecastToJSON(forecast),
      decision: decisionToJSON(decision), impliedStale: !!implied?.stale, proposalImplied };
    return change(account, id, state => { state.decisions.unshift(record); return record; });
  }

  async function paper(account, id, input) {
    keysExactly(input, ['decisionId']);
    const { profile } = await load(account, id), eventCount = await eventCountFor(profile);
    requireActive(profile);
    return change(account, id, async (state, current) => {
      requireActive(current);
      const source = state.decisions.find(r => r.id === input.decisionId);
      if (!source) fail(404, 'Decision not found.');
      if (source.paperFillId) fail(409, 'This decision was already paper traded.');
      const decision = decisionFromJSON(source.decision, eventCount), p = decision.proposal;
      // The budget counts every paper fill ever recorded, not only those still shown in the feed.
      if (p && BigInt(state.paper.costAtoms) + p.quoteAtoms > BigInt(current.config.paperBudgetAtoms)) fail(409, 'This paper trade would exceed the agent\'s paper budget.');
      let fill;
      try { fill = await recordPaperFill({ fills: async () => paperPositions(state.paper, eventCount), add: async () => {} }, decision, { now: now(), id: randomUUID() }); }
      catch (e) { fail(409, e instanceof FlurboError ? e.message : 'Paper trade rejected.'); }
      const record = { id: fill.id, kind: 'paper', createdAt: now(), decisionId: source.id, fill: paperFillToJSON(fill) };
      state.paper.recent.unshift(record); addPaperFill(state.paper, record.fill); source.paperFillId = record.id;
      return record;
    });
  }
  // One position per claim from the running totals: its total quantity and cost and its newest quote
  // block. The fill model's rule (a strictly newer block per claim) applies to these unchanged.
  const paperPositions = (paper, eventCount) => Object.values(paper.claims).map(c => paperFillFromJSON({ schema: SCHEMAS.paperFill, mode: 'paper', id: 'position',
    decisionKey: 'position', claim: c.claim, quantityAtoms: c.quantityAtoms, costAtoms: c.costAtoms, snapshotBlock: c.lastBlock, snapshotTimestamp: 0, filledAt: 0,
    model: FILL_MODEL, assumptions: [] }, eventCount));
  async function eventCountFor(profile) { return service(profile.market.namespace).manifest.publication.draft.events.length; }

  // Prepare the unsigned review through the existing transaction preparation, then prove it still carries
  // the proposed claim, quantity and a limit no worse than the decision allowed.
  async function prepareFor(profile, decision, owner) {
    const svc = service(profile.market.namespace), p = decision.proposal;
    let review;
    try { review = await svc.prepare({ owner, action: 'buy', scope: p.claim.scope, mask: p.claim.mask.toString(), quantity: p.quantityAtoms.toString(), slippageBps: p.slippageBps }); }
    catch (e) {
      if (e?.message === COMBINATION_LIMIT_MESSAGE) fail(409, COMBINATION_LIMIT_MESSAGE, 'COMBINATION_UNAVAILABLE');
      fail(409, /Not enough test AUSD/.test(e?.message) ? 'This wallet does not hold enough test AUSD for this purchase.' : 'The purchase could not be prepared at the current price. Evaluate again.');
    }
    const call = pilotCall({ to: review.transaction.to, data: review.transaction.data, manifest: svc.manifest });
    const limit = BigInt(review.amountAtoms);
    if (!call || review.schema !== 'flurbo.pilot-review.v1' || review.transaction.from.toLowerCase() !== owner) fail(503, 'Unexpected transaction review.');
    if (review.action === 'buy') {
      const [scope, mask, quantity, maxCost] = call.args;
      if (call.name !== 'buy' || scope !== p.claim.scope || mask !== p.claim.mask || quantity !== p.quantityAtoms || maxCost !== limit) fail(503, 'The review does not match the proposed claim.');
    } else if (review.action === 'approve') {
      if (call.name !== 'approve' || String(call.args[0]).toLowerCase() !== svc.manifest.pool || call.args[1] !== limit) fail(503, 'Unexpected approval review.');
    } else fail(503, 'Unexpected transaction review.');
    if (limit > p.worstCostAtoms) fail(409, 'The price moved above what this decision allowed. Evaluate again.', 'PRICE_MOVED');
    if (limit > BigInt(profile.config.maxCostAtoms)) fail(409, 'This purchase exceeds the agent budget.');
    return review;
  }

  // Reserve the decision atomically, prepare outside the lock, then activate only if the reservation is
  // still ours and unexpired. Two servers racing on one decision: exactly one reserves, the other gets
  // PROPOSAL_EXISTS without preparing anything.
  async function propose(account, id, input, origin) {
    keysExactly(input, ['decisionId', 'owner']);
    const { profile } = await load(account, id);
    assisted(profile); requireActive(profile);
    if (profile.status !== 'active') fail(409, 'Resume this agent before proposing a trade.');
    if (profile.mode !== 'approval') fail(409, 'This agent is in paper mode. Switch it to approval mode to prepare real trades.');
    const owner = await linkedOwner(account, input.owner, origin), eventCount = await eventCountFor(profile);
    const reservation = await change(account, id, state => {
      const t = now(), found = state.decisions.find(r => r.id === input.decisionId);
      if (!found) fail(404, 'Decision not found.');
      const decision = decisionFromJSON(found.decision, eventCount);
      if (decision.outcome !== 'propose' || !decision.proposal) fail(409, 'This decision abstained. There is nothing to approve.');
      for (const p of state.proposals) if (p.status === 'preparing' && !reserving(p, t)) { p.status = 'preparation-expired'; p.version++; p.updatedAt = t; delete p.reservedUntil; }
      // One live proposal per decision: a confirmed, in-flight, waiting or preparing proposal blocks another, so a
      // single decision can never turn into a second purchase. Rejected or failed proposals may be retried.
      if (state.proposals.some(p => p.decisionId === found.id && blocksDecision(p, t)))
        fail(409, 'This decision already has a proposal in progress or confirmed. Evaluate again for a new decision.', 'PROPOSAL_EXISTS');
      if (t >= decision.proposal.quoteExpiresAt + PROPOSAL_TTL_SECONDS) fail(409, 'This decision is too old. Evaluate again.');
      if (reviewCount(state) >= AGENT_LIMITS.reviewsPerAgent) reviewLimit();
      const record = { id: randomUUID(), kind: 'proposal', version: 1, createdAt: t, updatedAt: t, decisionId: found.id, decision: found.decision, owner, account: account.toLowerCase(),
        claim: found.decision.proposal.claim, quantityAtoms: found.decision.proposal.quantityAtoms, status: 'preparing', reservedUntil: t + RESERVATION_SECONDS,
        review: null, reviews: [], transactions: [] };
      state.proposals.unshift(record);
      return record;
    });
    let review = null, failure = null;
    try { review = await prepareFor(profile, decisionFromJSON(reservation.decision, eventCount), owner); } catch (e) { failure = e; }
    const outcome = await change(account, id, (state, current) => {
      const t = now(), r = state.proposals.find(p => p.id === reservation.id);
      if (!failure && current.status === 'archived') failure = new HttpError(409, 'This agent was archived while the purchase was being prepared.', 'ARCHIVED');
      if (!failure && reviewCount(state) >= AGENT_LIMITS.reviewsPerAgent) failure = new HttpError(409, 'This agent has reached its limit of transaction reviews.', 'REVIEW_LIMIT');
      if (!r || r.status !== 'preparing' || r.version !== reservation.version)
        return { error: new HttpError(409, 'This proposal changed while it was being prepared. Reload before approving.', 'PROPOSAL_CHANGED') };
      delete r.reservedUntil; r.version++; r.updatedAt = t;
      if (failure) { r.status = 'preparation-failed'; r.failure = failure instanceof HttpError ? failure.message : 'The purchase could not be prepared.'; return { error: failure }; }
      if (t >= reservation.reservedUntil) { r.status = 'preparation-expired'; return { error: new HttpError(409, 'Preparing this purchase took too long. Try again.', 'RESERVATION_EXPIRED') }; }
      r.status = 'awaiting-approval'; r.review = review; r.reviews = [compactReview(review)];
      return { record: proposalView(r, t) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.record;
  }

  // Proposal lifecycle. Only a verified receipt for the reviewed purchase marks it confirmed. Slow work
  // (transaction preparation, receipt reads) happens outside the lock; the write then checks that the
  // proposal did not change meanwhile.
  async function track(account, id, proposalId, input, origin) {
    const allowed = { refresh: ['action'], submitted: ['action', 'hash', 'transaction'], check: ['action'], rejected: ['action'] };
    if (!input || !allowed[input.action]) fail(400, 'Unknown proposal action.');
    keysExactly(input, allowed[input.action]);
    const { profile, state } = await load(account, id), eventCount = await eventCountFor(profile);
    const current = state.proposals.find(r => r.id === proposalId);
    if (!current || current.account !== account.toLowerCase()) fail(404, 'Proposal not found.');
    const update = fn => change(account, id, (next, latest) => {
      const r = next.proposals.find(p => p.id === proposalId);
      if (!r) fail(404, 'Proposal not found.');
      requireActive(latest);
      const t = now(), result = fn(r, next, t);
      r.version++; r.updatedAt = t;
      return result ?? proposalView(r, t);
    });

    if (input.action === 'refresh') {
      requireActive(profile);
      if (hasSubmitted(current)) fail(409, 'A transaction is still being tracked. Check it before preparing another.');
      if (!['awaiting-approval', 'approval-confirmed'].includes(current.status)) fail(409, 'This proposal can no longer be refreshed.');
      await linkedOwner(account, current.owner, origin);
      const source = current.decision ?? state.decisions.find(r => r.id === current.decisionId)?.decision;
      if (!source) fail(409, 'The decision behind this proposal is no longer available. Evaluate again.');
      const decision = decisionFromJSON(source, eventCount);
      if (now() >= decision.proposal.quoteExpiresAt + PROPOSAL_TTL_SECONDS) fail(409, 'This decision is too old. Evaluate again.');
      const review = await prepareFor(profile, decision, current.owner);
      return update((r, next) => {
        if (r.version !== current.version) fail(409, 'This proposal changed while the review was being prepared. Reload before approving.', 'PROPOSAL_CHANGED');
        // Earlier reviews stay attached: any of them may already be open in MetaMask or sent.
        if (!hasReview(r, review)) { if (reviewCount(next) >= AGENT_LIMITS.reviewsPerAgent) reviewLimit(); r.reviews.push(compactReview(review)); }
        r.status = 'awaiting-approval'; r.review = review;
      });
    }
    if (input.action === 'submitted') {
      if (typeof input.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.hash)) fail(400, 'Invalid transaction hash.');
      const sent = input.transaction;
      if (!sent || typeof sent !== 'object' || TX_FIELDS.some(f => typeof sent[f] !== 'string')) fail(400, 'Include the reviewed transaction that was sent.');
      const hash = input.hash.toLowerCase(), digest = transactionDigest(sent);
      return change(account, id, async (next, latest, own) => {
        const r = next.proposals.find(p => p.id === proposalId), t = now();
        if (!r) fail(404, 'Proposal not found.');
        // Only verified ownership is final. A hash another proposal merely recorded does not block this
        // one: the receipt check decides whose reviewed transaction it is.
        const owner = await own.read(hash);
        if (owner && !own.owns(owner, r.id, digest)) fail(409, 'This transaction was verified for another proposal.', 'HASH_CONFLICT');
        const known = r.transactions.find(x => x.hash === hash);
        // Recording the same hash for the same transaction again is a no-op, so a retry is safe.
        if (known) return transactionDigest(known.review.transaction) === digest ? proposalView(r, t)
          : fail(409, 'This hash is already tracked for a different transaction.', 'HASH_CONFLICT');
        if (hasSubmitted(r)) fail(409, 'A different transaction is already being tracked for this proposal. Check it first and do not send again.', 'HASH_CONFLICT');
        const review = r.reviews.find(v => transactionDigest(v.transaction) === digest);
        if (!review) fail(409, 'This transaction is not one prepared for this proposal.', 'REVIEW_MISMATCH');
        r.transactions = [...r.transactions, { hash, action: review.action, status: 'submitted', review, submittedAt: t, statusBefore: r.status }];
        r.status = 'submitted'; r.version++; r.updatedAt = t;
        return proposalView(r, t);
      });
    }
    if (input.action === 'rejected') {
      return update(r => {
        if (hasSubmitted(r) || !['awaiting-approval', 'approval-confirmed'].includes(r.status)) fail(409, 'Only a waiting proposal can be dismissed.');
        r.status = 'rejected';
      });
    }
    const pending = current.transactions.find(t => t.status === 'submitted');
    if (!pending) return proposalView(current, now());
    let result;
    try { result = await verifyReceipt({ rpc, review: pending.review, hash: pending.hash, manifest: service(profile.market.namespace).manifest }); }
    catch { fail(503, 'The transaction could not be checked. Try again shortly.'); }
    if (['unknown', 'pending', 'confirming'].includes(result.status)) return { ...proposalView(current, now()), check: result.status };
    // Re-run from a fresh read if another server verified the same transaction at the same moment.
    return change(account, id, async (next, latest, own) => {
      const r = next.proposals.find(p => p.id === proposalId), t = now();
      if (!r) fail(404, 'Proposal not found.');
      const tx = r.transactions.find(x => x.hash === pending.hash);
      if (!tx || tx.status !== 'submitted') return proposalView(r, t); // already resolved by another request
      let done = { ...tx, status: result.status, blockNumber: result.blockNumber ?? null, paidAtoms: result.paidAtoms ?? null };
      if (VERIFIED.includes(result.status)) {
        // The chain transaction is this proposal's reviewed transaction. Claim it unless another proposal
        // with an identical reviewed transaction was verified first; then it is not counted here.
        const digest = transactionDigest(tx.review.transaction), owner = await own.read(tx.hash);
        if (owner && !own.owns(owner, r.id, digest)) done.attributedElsewhere = true;
        else { own.claim(tx.hash, r.id, digest); if (result.status === 'confirmed' && tx.action === 'buy') done = addConfirmedPurchase(next.live, done); }
      }
      r.transactions = r.transactions.map(x => (x.hash === tx.hash ? done : x));
      // A confirmed purchase this proposal owns stays confirmed whatever later transactions do.
      if (done.attributedElsewhere) {
        r.status = ownsPurchase(r) ? 'confirmed' : tx.statusBefore ?? 'attributed-elsewhere';
        r.failure = 'This transaction was verified for another proposal first, so it is not counted here.';
      } else {
        r.status = ownsPurchase(r) ? 'confirmed' : result.status === 'confirmed' ? 'approval-confirmed' : 'failed';
        if (result.status !== 'confirmed') r.failure = result.status === 'mismatch' ? 'The transaction does not match the reviewed purchase.' : 'The transaction reverted on-chain.';
      }
      r.version++; r.updatedAt = t;
      return proposalView(r, t);
    });
  }

  // Honest accounting. Paper results are simulated; live results cover only confirmed agent-originated
  // purchases, at the cost the receipt shows. Collected payouts belong to the wallet in Portfolio and are
  // not attributed to an agent. Unknown values are null with a reason, never zero.
  async function performance(account, id) {
    const { profile, state } = await load(account, id), svc = service(profile.market.namespace), eventCount = svc.manifest.publication.draft.events.length;
    let resolution = null, resolutionKnown = true;
    try { resolution = await readResolution({ rpc, pool: svc.manifest.pool }); } catch { resolutionKnown = false; }
    // From the running totals, so results stay complete after the activity feed is trimmed. Payouts are
    // computed per claim position, rounding down once per claim.
    const positions = paperPositions(state.paper, eventCount), paper = evaluatePaper(positions, { eventCount, resolution });
    paper.fills = state.paper.fills; paper.costBasisAtoms = BigInt(state.paper.costAtoms);
    if (paper.realized) paper.realized.count = state.paper.fills;
    paper.missing = paper.missing.filter(m => !m.startsWith('No current sell quote'));
    if (!resolution && positions.length) paper.missing.unshift('Paper positions have no current sell quote, so their value is unknown.');
    if (!resolutionKnown) paper.missing.push('The pool resolution could not be read just now.');
    // Totals rebuilt from capped records written before this version cover only what was kept.
    const incomplete = 'Records from before this version were capped, so earlier trades may be missing from these totals.';
    paper.complete = !state.paper.incomplete;
    if (state.paper.incomplete) paper.missing.push(incomplete);
    const l = state.live;
    const live = { mode: 'live', complete: !l.incomplete, confirmedPurchases: l.confirmedPurchases, costBasisAtoms: l.unknownCost ? null : l.costAtoms,
      realizedPnlAtoms: null, collectedPayoutAtoms: null,
      missing: [...(l.unknownCost ? ['Some purchase costs could not be read from their receipts.'] : []), ...(l.incomplete ? [incomplete] : []),
        'Collected payouts and realized results are shown per wallet in Portfolio and are not attributed to this agent.'] };
    const s = v => (v === null || v === undefined ? null : v.toString());
    return { schema: 'flurbo.agent-performance.v1', paper: { ...paper, costBasisAtoms: s(paper.costBasisAtoms),
      realized: paper.realized && { count: paper.realized.count, payoutAtoms: s(paper.realized.payoutAtoms), pnlAtoms: s(paper.realized.pnlAtoms) },
      unrealized: paper.unrealized && { count: paper.unrealized.count, valueAtoms: s(paper.unrealized.valueAtoms), pnlAtoms: s(paper.unrealized.pnlAtoms) } }, live };
  }

  async function quote(input) {
    keysExactly(input, ['namespace', 'scope', 'mask', 'quantityAtoms', 'side']);
    const svc = service(input.namespace), eventCount = svc.manifest.publication.draft.events.length;
    let claim, quantity;
    try { claim = claimFromJSON({ chainId: 10143, pool: svc.manifest.pool, scope: input.scope, mask: input.mask }, eventCount); quantity = parseAtoms(input.quantityAtoms); }
    catch (e) { return { status: 'unavailable', reason: 'unsupported_claim', detail: e instanceof FlurboError ? e.message : 'Unsupported claim.' }; }
    if (quantity === 0n || quantity > 100_000_000n) return { status: 'unavailable', reason: 'quantity_limit', detail: 'Quantity must be between one atom and 100 shares.' };
    if (!['buy', 'sell'].includes(input.side)) fail(400, 'Choose buy or sell.');
    return (await quoteClaims({ service: svc, rpc, claims: [claim], quantityAtoms: quantity, side: input.side }))[0];
  }

  function profileFrom(input, existing = null) {
    const name = input.name ?? existing?.name;
    // Plus, hash and brackets allow names like "C++ agent" or "C# bot (test)".
    if (typeof name !== 'string' || !/^[\p{L}\p{N} ._+#()'-]{3,48}$/u.test(name.trim())) fail(400, "Use a name of 3 to 48 characters: letters, numbers, spaces and . _ - + # ( ) '");
    const mode = input.mode ?? existing?.mode;
    if (!MODES.includes(mode)) fail(400, 'Choose paper or approval mode.');
    const status = input.status ?? existing?.status ?? 'active';
    if (!['active', 'paused'].includes(status)) fail(400, 'Choose active or paused.');
    return { name: name.trim(), mode, status };
  }

  // An autonomous agent runs on the user's own infrastructure. Flurbo stores its profile, policy for the
  // runtime to read, credentials (as digests), the associated wallet and verified activity.
  function runtimeProfile(input) {
    keysExactly(input, ['kind', 'name', 'markets']);
    const { name } = profileFrom({ name: input.name, mode: 'paper' });
    if (!Array.isArray(input.markets) || input.markets.length < 1 || input.markets.length > 20 || new Set(input.markets).size !== input.markets.length) fail(400, 'Choose at least one market.');
    input.markets.forEach(service);
    return { schema: SCHEMAS.profile, kind: 'runtime', name, status: 'active', markets: [...input.markets], runtimePolicy: defaultRuntimePolicy(),
      wallet: null, walletHistory: [], createdAt: now(), updatedAt: now() };
  }
  async function runtimeView(account, profile, state) {
    const t = now(), heartbeats = runtime.heartbeatsFor(account, profile.id, state.runtime.heartbeats), conn = connection(heartbeats, t);
    return { profile, records: [], runtime: { connection: { state: conn.state, ageSeconds: conn.ageSeconds ?? null },
      heartbeats, policy: policyView(profile, t),
      acknowledged: conn.latest ? conn.latest.policy.flurboVersion === profile.runtimePolicy.version : false,
      decisions: state.runtime.decisions, executions: state.runtime.executions, totals: state.runtime.totals,
      credentials: await runtime.session.credentials(account, profile.id), wallet: profile.wallet, walletHistory: profile.walletHistory ?? [] } };
  }

  const routes = async ({ method, path, input, login, origin, sessionDigest = null }) => {
    const account = login.address.toLowerCase(), parts = path.split('/').slice(3); // ['/', 'api', 'agents', ...]
    if (method === 'GET' && parts.length === 0) return { schema: 'flurbo.agents.v1', durable: store.durable, agents: await store.list(account), archived: await store.listArchived(account) };
    if (method === 'POST' && parts.length === 0 && input?.kind === 'runtime') return store.create(account, runtimeProfile(input));
    if (method === 'POST' && parts.length === 0) {
      keysExactly(input, ['name', 'namespace', 'mode', 'config'], ['name', 'namespace', 'mode']);
      const svc = service(input.namespace), base = profileFrom(input);
      const maxTrade = 100_000_000n;
      const profile = { schema: SCHEMAS.profile, ...base, status: 'active', strategy: STRATEGY, market: { namespace: input.namespace, pool: svc.manifest.pool,
        title: String(svc.manifest.publication.draft.title ?? '') }, config: configFromInput(input.config ?? { ...DEFAULT_PROFILE_CONFIG }, maxTrade), createdAt: now(), updatedAt: now() };
      return store.create(account, profile);
    }
    if (method === 'POST' && parts.length === 1 && parts[0] === 'quote') return quote(input);
    const id = parts[0];
    if (method === 'GET' && parts.length === 1) {
      const { profile, state } = await load(account, id);
      return profile.kind === 'runtime' ? runtimeView(account, profile, state) : { profile, records: recordsView(state, now()) };
    }
    if (method !== 'POST') fail(405, 'Method not allowed.');
    if (parts.length === 2 && parts[1] === 'update') {
      const updated = await store.update(account, id, async current => {
        requireActive(current);
        if (current.kind === 'runtime') { keysExactly(input, ['name']); return { ...current, name: profileFrom({ name: input.name, mode: 'paper' }).name, updatedAt: now() }; }
        keysExactly(input, ['name', 'mode', 'status', 'config'], []);
        return { ...current, ...profileFrom(input, current), config: input.config ? configFromInput(input.config, 100_000_000n) : current.config, updatedAt: now() };
      });
      return updated ?? fail(404, 'Agent not found.');
    }
    // Runtime agent administration from the signed-in dashboard.
    if (parts[1] === 'credentials' && parts.length === 2) return runtime.session.issueCredential(account, id, input);
    if (parts[1] === 'credentials' && parts.length === 4 && parts[3] === 'revoke') { keysExactly(input, []); return runtime.session.revokeCredential(account, id, parts[2]); }
    if (parts[1] === 'credentials' && parts.length === 4 && parts[3] === 'rotate') return runtime.session.rotateCredential(account, id, parts[2], input);
    if (parts[1] === 'wallet' && parts.length === 3 && parts[2] === 'challenge') return runtime.session.walletChallenge(account, id, input, origin, sessionDigest);
    if (parts[1] === 'wallet' && parts.length === 3 && parts[2] === 'verify') return runtime.session.walletVerify(account, id, input, origin, sessionDigest);
    if (parts[1] === 'runtime-policy' && parts.length === 2) return runtime.session.setPolicy(account, id, input);
    if (parts[1] === 'executions' && parts.length === 4 && parts[3] === 'check') { keysExactly(input, []); return runtime.session.checkExecution(account, id, String(parts[2]).toLowerCase()); }
    if (parts.length === 2 && parts[1] === 'delete') {
      keysExactly(input, []);
      return (await store.archive(account, id, now())) ? { deleted: true, archived: true } : fail(404, 'Agent not found.');
    }
    if (parts.length === 2 && parts[1] === 'evaluate') return evaluate(account, id, input);
    if (parts.length === 2 && parts[1] === 'performance') { keysExactly(input, []); assisted((await load(account, id)).profile); return performance(account, id); }
    if (parts.length === 2 && parts[1] === 'paper') { assisted((await load(account, id)).profile); return paper(account, id, input); }
    if (parts.length === 2 && parts[1] === 'proposal') return propose(account, id, input, origin);
    if (parts.length === 3 && parts[1] === 'proposals') return track(account, id, parts[2], input, origin);
    fail(404, 'Unknown agent endpoint.');
  };

  return {
    durable: store.durable,
    // Headless runtime API: bearer credentials only (see runtime-api.mjs).
    runtime: runtime.handle,
    isAgentWallet: async wallet => !!(await store.agentWallet(wallet)),
    portfolio: (account,origin)=>agentPortfolio({store,links,account,origin,serviceFor}),
    // Returns {status, body}. Unexpected failures are reported without internal detail.
    async handle(request) {
      try { return { status: 200, body: await routes(request) }; }
      catch (e) {
        if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
        if (e instanceof RuntimeError) return { status: e.status, body: { error: e.message, code: e.code } };
        if (e?.status === 409) return { status: 409, body: { error: e.message, code: e.code ?? 'BUSY' } };
        return { status: 503, body: { error: 'The agent service is temporarily unavailable. Nothing was traded.' } };
      }
    },
  };
}
