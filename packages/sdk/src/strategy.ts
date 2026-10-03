import { FlurboError } from './errors.ts';
import { PPM, ceilDiv, formatAtoms, formatPpm } from './amounts.ts';
import { SCHEMAS } from './version.ts';
import { type Answer, type Claim, allOf, anyOf, exactlyOne, assertClaim, claimKey, claimShape, winningCombinations } from './claims.ts';
import { claimProbability, covers, both, marginal } from './distribution.ts';
import { type Forecast, evidenceSummary } from './forecast.ts';
import type { Market, PairImplied, QuoteResult } from './market.ts';

// Reference strategy "joint-edge": compare a structured joint forecast with the pool's executable
// finite-size quotes for claims the forecast covers, and propose at most one purchase whose expected
// value, after the worst-case cost allowed by slippage, clears the configured thresholds. Otherwise abstain.
//
// Expected value uses the forecast probability p that the claim pays and assumes no VOID outcome:
//   expectedPayout = floor(quantity * p / 10^6),  worstCost = ceil(quote * (10000 + slippage) / 10000),
//   edge = expectedPayout - worstCost.
// A VOID event pays fractional amounts (never zero by default), so this is an explicit assumption,
// listed in every decision. Edge is a model estimate, not a promised profit.
export const STRATEGY = { id: 'joint-edge', version: '1.0.0' } as const;

export type StrategyConfig = {
  quantityAtoms: bigint;       // Shares to buy, in atoms (10^6 = one share).
  slippageBps: 10 | 50 | 100;  // Same choices the transaction review supports.
  minEdgeBps: number;          // Minimum edge relative to worst-case cost.
  minEdgeAtoms: bigint;        // Minimum absolute edge.
  maxCostAtoms: bigint;        // Risk budget for one proposal (worst-case cost).
  minEvidence: number;         // Minimum fresh evidence items.
  maxEvidenceAgeDays: number;
  includeSingles: boolean;     // Also consider one-event claims, not only combinations.
};
export const DEFAULT_CONFIG: StrategyConfig = { quantityAtoms: 1_000_000n, slippageBps: 50, minEdgeBps: 500, minEdgeAtoms: 10_000n,
  maxCostAtoms: 5_000_000n, minEvidence: 1, maxEvidenceAgeDays: 14, includeSingles: true };

export function assertConfig(c: StrategyConfig, maxTradeQuantityAtoms: bigint | null = null): StrategyConfig {
  if (typeof c.quantityAtoms !== 'bigint' || c.quantityAtoms < 10_000n || c.quantityAtoms > 100_000_000n) throw new FlurboError('invalid_input', 'Quantity must be between 0.01 and 100 shares.');
  if (maxTradeQuantityAtoms !== null && c.quantityAtoms > maxTradeQuantityAtoms) throw new FlurboError('invalid_input', 'Quantity exceeds this pool\'s per-trade limit.');
  if (![10, 50, 100].includes(c.slippageBps)) throw new FlurboError('invalid_input', 'Slippage must be 0.1%, 0.5% or 1%.');
  if (!Number.isInteger(c.minEdgeBps) || c.minEdgeBps < 0 || c.minEdgeBps > 10_000) throw new FlurboError('invalid_input', 'Minimum edge must be between 0% and 100%.');
  if (typeof c.minEdgeAtoms !== 'bigint' || c.minEdgeAtoms < 0n) throw new FlurboError('invalid_input', 'Minimum edge must not be negative.');
  if (typeof c.maxCostAtoms !== 'bigint' || c.maxCostAtoms <= 0n || c.maxCostAtoms > 1_000_000_000n) throw new FlurboError('invalid_input', 'Budget must be between 0 and 1000 test AUSD.');
  if (!Number.isInteger(c.minEvidence) || c.minEvidence < 0 || c.minEvidence > 12) throw new FlurboError('invalid_input', 'Minimum evidence must be 0 to 12 items.');
  if (!Number.isInteger(c.maxEvidenceAgeDays) || c.maxEvidenceAgeDays < 1 || c.maxEvidenceAgeDays > 365) throw new FlurboError('invalid_input', 'Evidence age must be 1 to 365 days.');
  if (typeof c.includeSingles !== 'boolean') throw new FlurboError('invalid_input', 'Invalid singles setting.');
  return c;
}

export type AbstainReason = 'market_closed' | 'insufficient_evidence' | 'no_supported_claim' | 'quote_unavailable' | 'quote_expired'
  | 'budget_exceeded' | 'edge_below_threshold' | 'cross_pool';
export type Evaluation = {
  claim: Claim; shape: string; forecastPpm: bigint;
  status: 'eligible' | 'quote_unavailable' | 'quote_expired' | 'budget_exceeded' | 'edge_below_threshold';
  quoteAtoms: bigint | null; worstCostAtoms: bigint | null; averagePricePpm: bigint | null;
  expectedPayoutAtoms: bigint | null; edgeAtoms: bigint | null; edgeBps: number | null;
};
export type Decision = {
  schema: typeof SCHEMAS.decision; strategy: typeof STRATEGY; pool: string; decidedAt: number;
  snapshot: Market['snapshot']; outcome: 'propose' | 'abstain'; reasons: AbstainReason[];
  proposal: null | { claim: Claim; quantityAtoms: bigint; quoteAtoms: bigint; worstCostAtoms: bigint; slippageBps: number; quoteExpiresAt: number;
    forecastPpm: bigint; averagePricePpm: bigint; expectedPayoutAtoms: bigint; edgeAtoms: bigint; edgeBps: number; winning: Answer[][] };
  evaluations: Evaluation[]; relationship: null | Relationship; assumptions: string[]; explanation: string;
};
// impliedAvailable distinguishes "no pool analytics were supplied" from "supplied but not certified" (null values).
export type Relationship = { a: number; b: number; forecastBothPpm: bigint; forecastIndependentPpm: bigint; impliedAvailable: boolean; impliedBothTenths: number | null; impliedIndependentTenths: number | null };

// Candidate claims covered by the forecast, built with the canonical encoder: every "all of these answers"
// combination of each pair, "at least one" and "exactly one" of each pair's Yes answers, and optionally
// single answers. Capped for bounded quoting.
export function candidateClaims(market: Market, forecast: Forecast, config: StrategyConfig): Claim[] {
  const events = forecast.joint.events, n = market.events.length, out = new Map<string, Claim>();
  const add = (c: Claim) => out.set(claimKey(c), c);
  if (config.includeSingles) for (const e of events) for (const yes of [true, false]) add(allOf(market.pool, n, [{ event: e, yes }]));
  const pairs: number[][] = [];
  for (let i = 0; i < events.length; i++) for (let j = i + 1; j < events.length; j++) pairs.push([events[i], events[j]]);
  for (const [a, b] of pairs) {
    for (const ya of [true, false]) for (const yb of [true, false]) add(allOf(market.pool, n, [{ event: a, yes: ya }, { event: b, yes: yb }]));
    add(anyOf(market.pool, n, [{ event: a, yes: true }, { event: b, yes: true }]));
    add(exactlyOne(market.pool, n, [{ event: a, yes: true }, { event: b, yes: true }]));
  }
  return [...out.values()].slice(0, 24);
}

export type DecideInput = {
  market: Market; forecast: Forecast; config: StrategyConfig; now: number;
  quotes: Map<string, QuoteResult>; implied?: PairImplied | null;
};

export function decide(input: DecideInput): Decision {
  const { market, forecast, config, now, quotes } = input;
  assertConfig(config);
  const base = { schema: SCHEMAS.decision, strategy: STRATEGY, pool: market.pool, decidedAt: now, snapshot: market.snapshot };
  const assumptions = [
    'The forecast is an estimate supplied to the agent, not a market price or a verified fact.',
    'Expected value assumes no event resolves VOID. A VOID event pays a fractional amount under the published rules.',
    'Costs use the pool quote for this exact quantity at the snapshot block, plus the full slippage allowance.',
    'Gas fees are not included in edge.',
  ];
  const abstain = (reasons: AbstainReason[], evaluations: Evaluation[], explanation: string, relationship: Relationship | null = null): Decision =>
    ({ ...base, outcome: 'abstain', reasons, proposal: null, evaluations, relationship, assumptions, explanation });
  if (forecast.pool !== market.pool) return abstain(['cross_pool'], [], 'The forecast belongs to a different pool.');
  const relationship = pairRelationship(forecast, input.implied ?? null);
  if (!market.open || market.resolved || now >= market.closesAt) return abstain(['market_closed'], [], 'Trading is closed for this pool, so no purchase is proposed.', relationship);
  const evidence = evidenceSummary(forecast, new Date(now * 1000), config.maxEvidenceAgeDays);
  if (evidence.fresh < config.minEvidence) return abstain(['insufficient_evidence'], [], `The forecast has ${evidence.fresh} evidence item(s) observed within ${config.maxEvidenceAgeDays} days; ${config.minEvidence} required.`, relationship);
  const candidates = candidateClaims(market, forecast, config).filter(c => covers(forecast.joint, c));
  if (!candidates.length) return abstain(['no_supported_claim'], [], 'No supported claim is covered by this forecast.', relationship);
  const evaluations = candidates.map((claim): Evaluation => {
    assertClaim(claim, market.events.length);
    const forecastPpm = claimProbability(forecast.joint, claim), shape = claimShape(claim, market.events.length);
    const empty = { claim, shape, forecastPpm, quoteAtoms: null, worstCostAtoms: null, averagePricePpm: null, expectedPayoutAtoms: null, edgeAtoms: null, edgeBps: null };
    const result = quotes.get(claimKey(claim));
    if (!result || result.status !== 'ok') return { ...empty, status: 'quote_unavailable' };
    const q = result.quote;
    if (q.side !== 'buy' || q.quantityAtoms !== config.quantityAtoms || claimKey(q.claim) !== claimKey(claim) || q.snapshot.blockHash !== market.snapshot.blockHash)
      return { ...empty, status: 'quote_unavailable' };
    if (now >= q.expiresAt) return { ...empty, status: 'quote_expired' };
    const worstCostAtoms = ceilDiv(q.amountAtoms * BigInt(10_000 + config.slippageBps), 10_000n);
    const expectedPayoutAtoms = config.quantityAtoms * forecastPpm / PPM;
    const edgeAtoms = expectedPayoutAtoms - worstCostAtoms;
    const edgeBps = Number(edgeAtoms * 10_000n / worstCostAtoms);
    const averagePricePpm = q.amountAtoms * PPM / config.quantityAtoms;
    const evaluated = { claim, shape, forecastPpm, quoteAtoms: q.amountAtoms, worstCostAtoms, averagePricePpm, expectedPayoutAtoms, edgeAtoms, edgeBps };
    if (worstCostAtoms > config.maxCostAtoms) return { ...evaluated, status: 'budget_exceeded' };
    if (edgeBps < config.minEdgeBps || edgeAtoms < config.minEdgeAtoms) return { ...evaluated, status: 'edge_below_threshold' };
    return { ...evaluated, status: 'eligible' };
  });
  const eligible = evaluations.filter(e => e.status === 'eligible')
    .sort((x, y) => (y.edgeAtoms! > x.edgeAtoms! ? 1 : y.edgeAtoms! < x.edgeAtoms! ? -1 : claimKey(x.claim) < claimKey(y.claim) ? -1 : 1));
  if (!eligible.length) {
    const seen = new Set(evaluations.map(e => e.status));
    const reasons = (['quote_expired', 'quote_unavailable', 'budget_exceeded', 'edge_below_threshold'] as const).filter(r => seen.has(r));
    return abstain(reasons, evaluations, 'No covered claim clears the edge threshold after the quoted cost and slippage allowance.', relationship);
  }
  const best = eligible[0], quote = quotes.get(claimKey(best.claim));
  const quoteExpiresAt = quote && quote.status === 'ok' ? quote.quote.expiresAt : now;
  const proposal = { claim: best.claim, quantityAtoms: config.quantityAtoms, quoteAtoms: best.quoteAtoms!, worstCostAtoms: best.worstCostAtoms!, slippageBps: config.slippageBps,
    quoteExpiresAt, forecastPpm: best.forecastPpm, averagePricePpm: best.averagePricePpm!, expectedPayoutAtoms: best.expectedPayoutAtoms!, edgeAtoms: best.edgeAtoms!, edgeBps: best.edgeBps!,
    winning: winningCombinations(best.claim, market.events.length) };
  const explanation = `The forecast gives this claim ${formatPpm(best.forecastPpm)} to pay. Buying ${formatAtoms(config.quantityAtoms)} share(s) costs ${formatAtoms(best.quoteAtoms!)} test AUSD at the snapshot, an average of ${formatPpm(best.averagePricePpm!)} per share at this size, and at most ${formatAtoms(best.worstCostAtoms!)} with slippage. Estimated edge under the forecast: ${formatAtoms(best.edgeAtoms!)} test AUSD before gas.`;
  return { ...base, outcome: 'propose', reasons: [], proposal, evaluations, relationship, assumptions, explanation };
}

// For a two-event forecast: the forecast's joint versus an independence baseline, and the pool's
// model-implied joint when the caller supplied certified pair analytics from the same pool.
function pairRelationship(forecast: Forecast, implied: PairImplied | null): Relationship | null {
  if (forecast.joint.events.length !== 2) return null;
  const [a, b] = forecast.joint.events;
  const pa = marginal(forecast.joint, a), pb = marginal(forecast.joint, b);
  const usable = implied && implied.pool === forecast.pool && ((implied.a === a && implied.b === b) || (implied.a === b && implied.b === a));
  return { a, b, forecastBothPpm: both(forecast.joint, a, b), forecastIndependentPpm: pa * pb / PPM, impliedAvailable: !!usable,
    impliedBothTenths: usable ? implied!.both : null, impliedIndependentTenths: usable ? implied!.independent : null };
}
