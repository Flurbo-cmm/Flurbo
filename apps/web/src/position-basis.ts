import { positionKey, realizedPerformance, type TradeActivity } from './portfolio-performance.ts';

export { positionKey };

// What a sale would earn or lose against what was paid, from the wallet's recorded trades. Null whenever the record
// cannot account for the shares: fewer shares than are sold, or a different count from what the wallet holds now.
export function sellOutcome(trades: TradeActivity[], key: string, quantity: bigint, proceeds: bigint, held?: bigint) {
  const basis = realizedPerformance(trades).inventory.get(key);
  if (!basis || quantity <= 0n || basis.quantity < quantity || (held !== undefined && basis.quantity !== held)) return null;
  const paid = quantity === basis.quantity ? basis.cost : basis.cost * quantity / basis.quantity;
  return { paid, proceeds, difference: proceeds - paid };
}
