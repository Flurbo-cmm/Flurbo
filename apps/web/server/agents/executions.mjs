import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { pilotCall, pilotCash, pilotCashAbi } from '../../shared/pilot.mjs';
import { verifyEffect } from '../../../../packages/sdk/src/effects.ts';
import { transactionDigest } from './agent-store.mjs';

// Verification of transactions an agent runtime signed and broadcast itself (protocol/specs/transactions.md,
// "Attribution by Flurbo"). Everything is read from Flurbo's own RPC; the report only says what to check.
export const EXECUTION_ACTIONS = ['buy', 'sell', 'redeem', 'approve'];
const HASH = /^0x[0-9a-f]{64}$/, DIGITS = /^(0|[1-9][0-9]{0,77})$/;

// Validates a reported intent. Returns a canonical copy or null.
export function parseIntent(v, eventCount) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'action,claim,deadline,limitAtoms,quantityAtoms') return null;
  if (!EXECUTION_ACTIONS.includes(v.action) || !DIGITS.test(v.quantityAtoms) || !DIGITS.test(v.limitAtoms)) return null;
  if (v.action === 'approve') {
    if (v.claim !== null || v.deadline !== null || v.quantityAtoms !== '0') return null;
  } else {
    const c = v.claim;
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join(',') !== 'mask,scope' || !Number.isInteger(c.scope) || c.scope < 1 || c.scope >= 2 ** eventCount || !/^[1-9][0-9]{0,2}$/.test(c.mask)) return null;
    if (v.action === 'redeem' ? v.deadline !== null || v.limitAtoms !== '0' : !Number.isSafeInteger(v.deadline) || v.deadline <= 0) return null;
  }
  return { action: v.action, claim: v.claim ? { scope: v.claim.scope, mask: v.claim.mask } : null, quantityAtoms: v.quantityAtoms, limitAtoms: v.limitAtoms, deadline: v.deadline };
}

const walletAt = (history, address, timestamp) => (history ?? []).some(w => w.address === address && w.from <= timestamp && (w.until === null || timestamp < w.until));

// Returns { status, reason?, ... }. Status: unknown (not on chain yet), pending, confirming, confirmed,
// reverted or mismatch. Only confirmed and reverted executions carry `digest` for ownership.
export async function verifyExecution({ rpc, manifest, walletHistory, hash, intent }) {
  if (!HASH.test(hash)) return { status: 'mismatch', reason: 'invalid_hash' };
  const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
  if (!tx) return { status: 'unknown' };
  if (!receipt) return { status: 'pending' };
  const from = String(tx.from).toLowerCase(), to = String(tx.to ?? '').toLowerCase(), data = String(tx.input ?? '').toLowerCase();
  if (String(tx.hash).toLowerCase() !== hash || String(receipt.transactionHash).toLowerCase() !== hash || BigInt(tx.chainId ?? '0x0') !== 10143n
    || BigInt(tx.value ?? '0x1') !== 0n || String(receipt.blockHash).toLowerCase() !== String(tx.blockHash).toLowerCase()) return { status: 'mismatch', reason: 'not_this_chain_or_value' };
  const [block, head] = await Promise.all([rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', ['latest', false])]);
  if (String(block?.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase() || !head || BigInt(head.number) < BigInt(receipt.blockNumber) + 1n) return { status: 'confirming' };
  const blockTimestamp = Number(BigInt(block.timestamp));
  const facts = { blockNumber: BigInt(receipt.blockNumber).toString(), blockTimestamp, from, gasUsed: BigInt(receipt.gasUsed ?? '0x0').toString(),
    effectiveGasPrice: receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice).toString() : null,
    digest: transactionDigest({ from, to, data, chainId: '0x279f', value: '0x0' }) };
  if (!walletAt(walletHistory, from, blockTimestamp)) return { status: 'mismatch', reason: 'wallet_not_associated', ...facts };
  const call = pilotCall({ to, data, manifest });
  if (!call || call.name !== intent.action) return { status: 'mismatch', reason: 'unsupported_call', ...facts };
  const [a0, a1, a2, a3, a4] = call.args;
  const matches = intent.action === 'approve'
    ? to === pilotCash && String(a0).toLowerCase() === manifest.pool && a1 === BigInt(intent.limitAtoms)
    : to === manifest.pool && a0 === intent.claim.scope && a1 === BigInt(intent.claim.mask) && a2 === BigInt(intent.quantityAtoms)
      && (intent.action === 'redeem' || (a3 === BigInt(intent.limitAtoms) && a4 === BigInt(intent.deadline)));
  if (!matches) return { status: 'mismatch', reason: 'intent_mismatch', ...facts };
  if (BigInt(receipt.status) !== 1n) return { status: 'reverted', ...facts };
  let allowance = null;
  if (intent.action === 'approve') {
    const raw = await rpc('eth_call', [{ to: pilotCash, data: encodeFunctionData({ abi: pilotCashAbi, functionName: 'allowance', args: [from, manifest.pool] }) }, receipt.blockNumber]);
    allowance = decodeFunctionResult({ abi: pilotCashAbi, functionName: 'allowance', data: raw }).toString();
  }
  const effect = verifyEffect({ action: intent.action, wallet: from, pool: manifest.pool, claim: intent.claim, quantityAtoms: intent.quantityAtoms, limitAtoms: intent.limitAtoms },
    { status: 1, logs: receipt.logs ?? [] }, allowance);
  return effect.status === 'confirmed' ? { status: 'confirmed', collateralAtoms: effect.collateralAtoms, ...facts } : { status: 'mismatch', reason: 'effect_missing', ...facts };
}
