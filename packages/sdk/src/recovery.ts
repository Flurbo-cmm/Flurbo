import type { JournalStatus } from './policy.ts';

// One recovery step for a journal entry (protocol/specs/transactions.md). Pure: the caller supplies what
// the chain shows. `nonceLatest` is eth_getTransactionCount(wallet, "latest"): the nonce is used once
// `nonceLatest > nonce`. The contract rejects a trade only when `block.timestamp > deadline`.
export type RecoveryAction = 'none' | 'release' | 'verify' | 'poll' | 'rebroadcast';
export type ChainView = { txFound: boolean; receiptStatus: 0 | 1 | null; nonceLatest: number };
export type RecoveryEntry = { status: JournalStatus; action: string; nonce: number | null; deadline: number | null };
export const FINAL: readonly JournalStatus[] = ['confirmed', 'reverted', 'mismatch', 'replaced', 'expired', 'abandoned'];

export function recoveryStep(entry: RecoveryEntry, chain: ChainView, now: number): { status: JournalStatus; action: RecoveryAction } {
  if (FINAL.includes(entry.status)) return { status: entry.status, action: 'none' };
  // Nothing was signed, so nothing can reach the chain.
  if (entry.status === 'planned') return { status: 'abandoned', action: 'release' };
  if (chain.receiptStatus === 1) return { status: 'broadcast', action: 'verify' };
  if (chain.receiptStatus === 0) return { status: 'reverted', action: 'release' };
  if (chain.txFound) return { status: 'broadcast', action: 'poll' };
  if (entry.nonce !== null && chain.nonceLatest > entry.nonce) return { status: 'replaced', action: 'release' };
  if (entry.deadline !== null && now > entry.deadline) return { status: 'expired', action: 'release' };
  // Same signed bytes, same hash: sending again cannot create a second transaction.
  return { status: entry.status, action: 'rebroadcast' };
}
