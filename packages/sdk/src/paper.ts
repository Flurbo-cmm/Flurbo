import { FlurboError } from './errors.ts';
import { SCHEMAS } from './version.ts';
import { type Claim, claimKey, payoutFraction } from './claims.ts';
import type { Decision } from './strategy.ts';

// PAPER TRADING. Nothing here is on-chain. Every record carries mode "paper".
// Fill model "quote-at-snapshot-no-impact-v1":
//   * A paper fill is priced at the pool's quote for that exact quantity and snapshot block (the quoted
//     cost, not the slippage limit).
//   * Hypothetical positions do not move the live pool. The simulation therefore understates the cost
//     of repeated or large trades, and says so.
//   * To stop an unchanged quote being "filled" repeatedly, a second fill of the same claim requires a
//     quote from a strictly newer block than every earlier fill of that claim, and each decision fills once.
export const FILL_MODEL = 'quote-at-snapshot-no-impact-v1';
export type PaperFill = {
  schema: typeof SCHEMAS.paperFill; mode: 'paper'; id: string; decisionKey: string; claim: Claim; quantityAtoms: bigint;
  costAtoms: bigint; snapshotBlock: bigint; snapshotTimestamp: number; filledAt: number; model: typeof FILL_MODEL; assumptions: string[];
};
export type PaperStore = { fills(): Promise<PaperFill[]>; add(fill: PaperFill): Promise<void> };

export function memoryPaperStore(initial: PaperFill[] = []): PaperStore {
  const fills = [...initial];
  return { fills: async () => [...fills], add: async fill => { fills.push(fill); } };
}

export const decisionKey = (d: Decision): string => `${d.pool}:${d.snapshot.blockHash}:${d.decidedAt}:${d.proposal ? claimKey(d.proposal.claim) : 'abstain'}`;

export async function recordPaperFill(store: PaperStore, decision: Decision, options: { now: number; id: string; budgetAtoms?: bigint }): Promise<PaperFill> {
  const p = decision.proposal;
  if (decision.outcome !== 'propose' || !p) throw new FlurboError('conflict', 'Only a proposal can be paper traded.');
  if (options.now >= p.quoteExpiresAt) throw new FlurboError('stale_quote', 'The quote behind this decision has expired. Evaluate again.');
  const existing = await store.fills(), key = decisionKey(decision);
  if (existing.some(f => f.decisionKey === key)) throw new FlurboError('conflict', 'This decision was already paper traded.');
  const sameClaim = existing.filter(f => claimKey(f.claim) === claimKey(p.claim));
  if (sameClaim.some(f => f.snapshotBlock >= decision.snapshot.blockNumber))
    throw new FlurboError('conflict', 'A paper fill for this claim already used this or a newer quote. Wait for a newer block and evaluate again.');
  if (options.budgetAtoms !== undefined) {
    const spent = existing.reduce((sum, f) => sum + f.costAtoms, 0n);
    if (spent + p.quoteAtoms > options.budgetAtoms) throw new FlurboError('conflict', 'This paper trade would exceed the agent\'s paper budget.');
  }
  const fill: PaperFill = { schema: SCHEMAS.paperFill, mode: 'paper', id: options.id, decisionKey: key, claim: p.claim, quantityAtoms: p.quantityAtoms,
    costAtoms: p.quoteAtoms, snapshotBlock: decision.snapshot.blockNumber, snapshotTimestamp: decision.snapshot.timestamp, filledAt: options.now, model: FILL_MODEL,
    assumptions: ['Priced at the pool quote for this quantity at the snapshot block.', 'The hypothetical position does not change live pool prices.', 'Gas is not simulated.'] };
  await store.add(fill);
  return fill;
}

// Performance, kept honest:
//   realized:   resolved claims only, payout under the published VOID rules minus cost.
//   unrealized: open claims only when a current executable sell quote was supplied; otherwise unknown.
//   unknown values are null and listed in `missing`, never reported as zero.
export type Resolution = { yesMask: number; voidMask: number };
export type Mark = { claimKey: string; proceedsAtoms: bigint; quantityAtoms: bigint; snapshotBlock: bigint };
export type Performance = {
  mode: 'paper' | 'live'; fills: number; costBasisAtoms: bigint;
  realized: { count: number; payoutAtoms: bigint; pnlAtoms: bigint } | null;
  unrealized: { count: number; valueAtoms: bigint; pnlAtoms: bigint } | null;
  open: number; missing: string[];
};

export function evaluatePaper(fills: PaperFill[], context: { eventCount: number; resolution: Resolution | null; marks?: Mark[] }): Performance {
  const missing: string[] = [];
  let realizedCount = 0, payout = 0n, realizedCost = 0n, unrealizedCount = 0, value = 0n, unrealizedCost = 0n, open = 0;
  for (const fill of fills) {
    if (fill.mode !== 'paper') throw new FlurboError('invalid_input', 'Only paper fills can be evaluated here.');
    if (context.resolution) {
      const { numerator, denominator } = payoutFraction(fill.claim, context.eventCount, context.resolution);
      payout += fill.quantityAtoms * numerator / denominator; realizedCost += fill.costAtoms; realizedCount++;
      continue;
    }
    open++;
    const mark = context.marks?.find(m => m.claimKey === claimKey(fill.claim) && m.quantityAtoms === fill.quantityAtoms);
    if (mark) { value += mark.proceedsAtoms; unrealizedCost += fill.costAtoms; unrealizedCount++; }
    else missing.push(`No current sell quote for paper fill ${fill.id}; its value is unknown.`);
  }
  if (!context.resolution && fills.length) missing.push('The pool has not resolved, so no paper result is realized yet.');
  return { mode: 'paper', fills: fills.length, costBasisAtoms: fills.reduce((s, f) => s + f.costAtoms, 0n),
    realized: realizedCount ? { count: realizedCount, payoutAtoms: payout, pnlAtoms: payout - realizedCost } : null,
    unrealized: unrealizedCount ? { count: unrealizedCount, valueAtoms: value, pnlAtoms: value - unrealizedCost } : null,
    open, missing };
}

export const paperFillToJSON = (f: PaperFill) => ({ ...f, claim: { ...f.claim, mask: f.claim.mask.toString() }, quantityAtoms: f.quantityAtoms.toString(),
  costAtoms: f.costAtoms.toString(), snapshotBlock: f.snapshotBlock.toString() });
