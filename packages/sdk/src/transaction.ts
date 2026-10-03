import { FlurboError } from './errors.ts';
import { decodeCall, encodeCall } from './abi.ts';
import { assertClaim } from './claims.ts';
import { COLLATERAL, SERVICE_LIMITS, type Deployment } from './protocol.ts';

// Builds and validates the only transactions an agent runtime may sign (protocol/specs/contracts.md).
// Validation runs on the final bytes immediately before signing, independently of how they were built:
// chain, contract, token, method, amounts and beneficiary. The pool credits msg.sender, so the
// beneficiary is always the signing wallet, which must be the agent wallet.
export type Intent =
  | { action: 'buy' | 'sell'; claim: { scope: number; mask: bigint }; quantityAtoms: bigint; limitAtoms: bigint; deadline: number }
  | { action: 'redeem'; claim: { scope: number; mask: bigint }; quantityAtoms: bigint }
  | { action: 'approve'; amountAtoms: bigint };
export type TransactionRequest = { chainId: number; from: string; to: string; data: string; value: bigint };

const bad = (message: string): never => { throw new FlurboError('invalid_input', `Refusing to sign: ${message}.`); };

export function buildTransaction(intent: Intent, deployment: Deployment, wallet: string): TransactionRequest {
  const from = wallet.toLowerCase();
  const tx = intent.action === 'approve'
    ? { to: COLLATERAL, data: encodeCall('approve', [deployment.pool, intent.amountAtoms]) }
    : intent.action === 'redeem'
      ? { to: deployment.pool, data: encodeCall('redeem', [intent.claim.scope, intent.claim.mask, intent.quantityAtoms]) }
      : { to: deployment.pool, data: encodeCall(intent.action, [intent.claim.scope, intent.claim.mask, intent.quantityAtoms, intent.limitAtoms, BigInt(intent.deadline)]) };
  const request = { chainId: 10143, from, ...tx, value: 0n };
  validateTransaction(request, intent, deployment, wallet);
  return request;
}

export function validateTransaction(tx: TransactionRequest, intent: Intent, deployment: Deployment, wallet: string): void {
  if (tx.chainId !== 10143 || deployment.chainId !== 10143) bad('not Monad testnet');
  if (tx.value !== 0n) bad('value must be zero');
  if (tx.from.toLowerCase() !== wallet.toLowerCase()) bad('the signer is not the agent wallet');
  const call = decodeCall(tx.data);
  if (call.name !== intent.action) bad('the method differs from the intent');
  const max = SERVICE_LIMITS.maxQuantityAtoms, maxLimit = SERVICE_LIMITS.maxLimitAtoms;
  if (intent.action === 'approve') {
    if (tx.to.toLowerCase() !== COLLATERAL) bad('approvals are only for test AUSD');
    const [spender, amount] = call.args;
    if ('0x' + spender.toString(16).padStart(40, '0') !== deployment.pool) bad('the spender is not the pool');
    if (amount !== intent.amountAtoms || amount === 0n || amount > maxLimit) bad('the approval amount is outside the service limit');
    return;
  }
  if (tx.to.toLowerCase() !== deployment.pool) bad('the contract is not the published pool');
  const [scope, mask, quantity, limit, deadline] = call.args;
  if (Number(scope) !== intent.claim.scope || mask !== intent.claim.mask || quantity !== intent.quantityAtoms) bad('the claim or quantity differs from the intent');
  assertClaim({ chainId: 10143, pool: deployment.pool, scope: Number(scope), mask }, deployment.eventCount);
  if (quantity < 1n || quantity > max) bad('the quantity is outside the service limit');
  if (intent.action === 'buy' || intent.action === 'sell') {
    if (limit !== intent.limitAtoms || limit > maxLimit || (intent.action === 'buy' && limit === 0n)) bad('the limit differs from the intent or the service limit');
    if (deadline !== BigInt(intent.deadline) || intent.deadline >= deployment.closesAt) bad('the deadline differs from the intent or is after the close');
  }
}
