import { STRATEGY, type Decision } from './strategy.ts';
import { claimFromJSON, claimToJSON } from './claims.ts';
import { parseAtoms, parseSignedAtoms } from './amounts.ts';
import { FlurboError } from './errors.ts';
import { SCHEMAS } from './version.ts';
import { FILL_MODEL, type PaperFill } from './paper.ts';

// JSON boundary for decisions: bigints become decimal strings, nothing else changes.
export function decisionToJSON(d: Decision) {
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    schema: d.schema, strategy: d.strategy, pool: d.pool, decidedAt: d.decidedAt,
    snapshot: { blockNumber: d.snapshot.blockNumber.toString(), blockHash: d.snapshot.blockHash, timestamp: d.snapshot.timestamp },
    outcome: d.outcome, reasons: d.reasons, assumptions: d.assumptions, explanation: d.explanation,
    proposal: d.proposal && { claim: claimToJSON(d.proposal.claim), quantityAtoms: s(d.proposal.quantityAtoms), quoteAtoms: s(d.proposal.quoteAtoms),
      worstCostAtoms: s(d.proposal.worstCostAtoms), slippageBps: d.proposal.slippageBps, quoteExpiresAt: d.proposal.quoteExpiresAt,
      forecastPpm: s(d.proposal.forecastPpm), averagePricePpm: s(d.proposal.averagePricePpm), expectedPayoutAtoms: s(d.proposal.expectedPayoutAtoms),
      edgeAtoms: s(d.proposal.edgeAtoms), edgeBps: d.proposal.edgeBps, winning: d.proposal.winning },
    evaluations: d.evaluations.map(e => ({ claim: claimToJSON(e.claim), shape: e.shape, status: e.status, forecastPpm: s(e.forecastPpm), quoteAtoms: s(e.quoteAtoms),
      worstCostAtoms: s(e.worstCostAtoms), averagePricePpm: s(e.averagePricePpm), expectedPayoutAtoms: s(e.expectedPayoutAtoms), edgeAtoms: s(e.edgeAtoms), edgeBps: e.edgeBps })),
    relationship: d.relationship && { a: d.relationship.a, b: d.relationship.b, forecastBothPpm: s(d.relationship.forecastBothPpm),
      forecastIndependentPpm: s(d.relationship.forecastIndependentPpm), impliedAvailable: d.relationship.impliedAvailable, impliedBothTenths: d.relationship.impliedBothTenths, impliedIndependentTenths: d.relationship.impliedIndependentTenths },
  };
}
export type DecisionJSON = ReturnType<typeof decisionToJSON>;

// Inverse of decisionToJSON, validated. Used where stored decisions must be enforced exactly (paper
// fills, proposal limits); display code can keep the JSON form.

export function decisionFromJSON(v: DecisionJSON, eventCount: number): Decision {
  if (!v || v.schema !== SCHEMAS.decision || v.strategy?.id !== STRATEGY.id || !['propose', 'abstain'].includes(v.outcome))
    throw new FlurboError('invalid_response', 'Unrecognised decision record.');
  const snapshot = { chainId: 10143, pool: v.pool, blockNumber: BigInt(v.snapshot.blockNumber), blockHash: v.snapshot.blockHash, timestamp: v.snapshot.timestamp };
  const p = v.proposal;
  return {
    schema: SCHEMAS.decision, strategy: STRATEGY, pool: v.pool, decidedAt: v.decidedAt, snapshot, outcome: v.outcome, reasons: v.reasons as Decision['reasons'],
    assumptions: v.assumptions, explanation: v.explanation, evaluations: [], relationship: null,
    proposal: p && { claim: claimFromJSON(p.claim, eventCount), quantityAtoms: parseAtoms(p.quantityAtoms), quoteAtoms: parseAtoms(p.quoteAtoms), worstCostAtoms: parseAtoms(p.worstCostAtoms),
      slippageBps: p.slippageBps, quoteExpiresAt: p.quoteExpiresAt, forecastPpm: parseAtoms(p.forecastPpm), averagePricePpm: parseAtoms(p.averagePricePpm),
      expectedPayoutAtoms: parseAtoms(p.expectedPayoutAtoms), edgeAtoms: parseSignedAtoms(p.edgeAtoms), edgeBps: p.edgeBps, winning: p.winning },
  };
}

export function paperFillFromJSON(v: ReturnType<typeof import('./paper.ts').paperFillToJSON>, eventCount: number): PaperFill {
  if (!v || v.schema !== SCHEMAS.paperFill || v.mode !== 'paper' || v.model !== FILL_MODEL) throw new FlurboError('invalid_response', 'Unrecognised paper fill.');
  return { ...v, claim: claimFromJSON(v.claim, eventCount), quantityAtoms: parseAtoms(v.quantityAtoms), costAtoms: parseAtoms(v.costAtoms), snapshotBlock: BigInt(v.snapshotBlock) } as PaperFill;
}
