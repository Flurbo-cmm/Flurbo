import { decodePoolLog, type Log } from './abi.ts';

// Whether a mined receipt shows exactly the reported intent (protocol/specs/transactions.md). Used by the
// runtime before it reports success and by Flurbo before it attributes an execution.
export type ExecutionAction = 'buy' | 'sell' | 'redeem' | 'approve';
export type ExecutionIntent = {
  action: ExecutionAction; wallet: string; pool: string;
  claim: { scope: number; mask: string } | null;
  // Buy: maxCost. Sell: minProceeds. Approve: allowance amount. Redeem: unused ("0").
  quantityAtoms: string; limitAtoms: string;
};
export type EffectResult = { status: 'confirmed'; collateralAtoms: string | null } | { status: 'mismatch' };

export function verifyEffect(intent: ExecutionIntent, receipt: { status: number; logs: Log[] }, allowanceAfterAtoms: string | null): EffectResult {
  if (receipt.status !== 1) return { status: 'mismatch' };
  const wallet = intent.wallet.toLowerCase(), pool = intent.pool.toLowerCase(), limit = BigInt(intent.limitAtoms);
  if (intent.action === 'approve') {
    return allowanceAfterAtoms !== null && /^(0|[1-9][0-9]*)$/.test(allowanceAfterAtoms) && BigInt(allowanceAfterAtoms) >= limit
      ? { status: 'confirmed', collateralAtoms: null } : { status: 'mismatch' };
  }
  if (!intent.claim) return { status: 'mismatch' };
  const scope = intent.claim.scope, mask = BigInt(intent.claim.mask), quantity = BigInt(intent.quantityAtoms);
  for (const log of receipt.logs ?? []) {
    if (String(log?.address).toLowerCase() !== pool) continue;
    const e = decodePoolLog(log);
    if (!e || e.scope !== scope || e.mask !== mask || e.quantity !== quantity) continue;
    if (e.event === 'Traded' && e.trader === wallet) {
      if (intent.action === 'buy' && e.isBuy && e.collateralAmount <= limit) return { status: 'confirmed', collateralAtoms: e.collateralAmount.toString() };
      if (intent.action === 'sell' && !e.isBuy && e.collateralAmount >= limit) return { status: 'confirmed', collateralAtoms: e.collateralAmount.toString() };
    }
    if (e.event === 'Redeemed' && intent.action === 'redeem' && e.owner === wallet) return { status: 'confirmed', collateralAtoms: e.collateralAmount.toString() };
  }
  return { status: 'mismatch' };
}
