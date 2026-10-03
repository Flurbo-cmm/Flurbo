import {rpcFetch} from '../rpc-capacity.mjs';
import { testnetRpcHost } from '../network.mjs';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { pilotPoolAbi, pilotCall } from '../../shared/pilot.mjs';

// Read-only chain access for agents. No pricing is computed here: every quote is the pool contract's own
// quoteBuy/quoteSell for an exact claim and quantity, read at one pinned snapshot block.
const READ_METHODS = ['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBalance', 'eth_getTransactionCount'];
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const multicallAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
export const QUOTE_TTL_SECONDS = 60;
const MAX_QUOTES = 24;

export function agentRpc(endpoint, { hosted = true, request = fetch } = {}) {
  const url = new URL(endpoint);
  const allowed = hosted
    ? url.protocol === 'https:' && testnetRpcHost(url.hostname)
    : ['127.0.0.1', 'localhost'].includes(url.hostname) || (url.protocol === 'https:' && testnetRpcHost(url.hostname));
  if (!allowed || url.username || url.password) throw new Error('Unsupported RPC endpoint for agents');
  let id = 0;
  return async (method, params = []) => {
    if (!READ_METHODS.includes(method)) throw new Error('Agent RPC is read-only');
    const callId = ++id;
    const response = await rpcFetch(request,endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json();
    // Provider error text can contain endpoint details; it is never surfaced.
    if (!response.ok || body?.id !== callId || body.error || !Object.hasOwn(body, 'result')) throw new Error('Chain read failed');
    return body.result;
  };
}

const hex = n => '0x' + BigInt(n).toString(16);

// Quotes for several claims at the service's verified snapshot block, in one multicall. A reverting
// quote (unsupported claim or size) is reported per claim, not as a whole failure.
export async function quoteClaims({ service, rpc, claims, quantityAtoms, side = 'buy', snapshot = null }) {
  if (!Array.isArray(claims) || claims.length < 1 || claims.length > MAX_QUOTES) throw new Error('Quote between one and twenty-four claims');
  if (!['buy', 'sell'].includes(side)) throw new Error('Unsupported side');
  const s = snapshot ?? await service.snapshot(), tag = hex(s.blockNumber), manifest = service.manifest;
  if (s.timestamp >= manifest.publication.draft.closesAt) return claims.map(() => ({ status: 'unavailable', reason: 'market_closed', detail: 'Trading has closed for this pool.' }));
  const fn = side === 'buy' ? 'quoteBuy' : 'quoteSell';
  const calls = [{ target: manifest.pool, allowFailure: false, callData: encodeFunctionData({ abi: pilotPoolAbi, functionName: 'resolved' }) },
    ...claims.map(c => ({ target: manifest.pool, allowFailure: true, callData: encodeFunctionData({ abi: pilotPoolAbi, functionName: fn, args: [c.scope, c.mask, quantityAtoms] }) }))];
  const rows = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3',
    data: await rpc('eth_call', [{ to: MULTICALL3, data: encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls] }) }, tag]) });
  if (rows.length !== calls.length || !rows[0].success) throw new Error('Quote read failed');
  // The snapshot must still be canonical after the read.
  if ((await rpc('eth_getBlockByNumber', [tag, false]))?.hash?.toLowerCase() !== s.blockHash) throw new Error('Snapshot changed');
  if (decodeFunctionResult({ abi: pilotPoolAbi, functionName: 'resolved', data: rows[0].returnData }))
    return claims.map(() => ({ status: 'unavailable', reason: 'market_closed', detail: 'This pool has resolved.' }));
  return claims.map((claim, i) => {
    const row = rows[i + 1];
    if (!row.success) return { status: 'unavailable', reason: 'quote_unavailable', detail: 'The pool does not quote this claim at this size.' };
    const amount = decodeFunctionResult({ abi: pilotPoolAbi, functionName: fn, data: row.returnData });
    if (typeof amount !== 'bigint' || (side === 'buy' && (amount <= 0n || amount > quantityAtoms)))
      return { status: 'unavailable', reason: 'quote_unavailable', detail: 'The pool returned an unusable quote.' };
    return { status: 'ok', quote: { schema: 'flurbo.agent-quote.v1', claim: { chainId: 10143, pool: manifest.pool, scope: claim.scope, mask: claim.mask.toString() },
      side, quantityAtoms: quantityAtoms.toString(), amountAtoms: amount.toString(),
      snapshot: { blockNumber: String(s.blockNumber), blockHash: s.blockHash, timestamp: s.timestamp },
      expiresAt: s.timestamp + QUOTE_TTL_SECONDS, source: side === 'buy' ? 'pool.quoteBuy' : 'pool.quoteSell' } };
  });
}

// Server-side confirmation of an agent-proposed transaction. A hash alone is not execution: only a
// successful receipt for exactly the reviewed call, from the reviewed wallet, on chain 10143 counts.
export async function verifyReceipt({ rpc, review, hash, manifest }) {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid transaction hash');
  const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
  if (!tx) return { status: 'unknown' };
  const wanted = review.transaction;
  if (tx.hash?.toLowerCase() !== hash || BigInt(tx.chainId ?? '0x279f') !== 10143n || tx.from?.toLowerCase() !== wanted.from.toLowerCase()
    || tx.to?.toLowerCase() !== wanted.to.toLowerCase() || tx.input?.toLowerCase() !== wanted.data.toLowerCase() || BigInt(tx.value) !== 0n)
    return { status: 'mismatch' };
  if (!pilotCall({ to: wanted.to, data: wanted.data, manifest })) return { status: 'mismatch' };
  if (!receipt) return { status: 'pending' };
  if (receipt.transactionHash?.toLowerCase() !== hash || receipt.blockHash?.toLowerCase() !== tx.blockHash?.toLowerCase()) return { status: 'mismatch' };
  const [block, head] = await Promise.all([rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', ['latest', false])]);
  if (block?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || !head || BigInt(head.number) < BigInt(receipt.blockNumber) + 1n) return { status: 'confirming' };
  const success = BigInt(receipt.status) === 1n;
  // The amount actually paid, from the pool's own Traded event for this wallet and claim.
  let paidAtoms = null;
  if (success) for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== manifest.pool) continue;
    try {
      const e = decodeEventLog({ abi: pilotPoolAbi, data: log.data, topics: log.topics });
      if (e.eventName === 'Traded' && e.args.trader.toLowerCase() === wanted.from.toLowerCase() && e.args.isBuy) paidAtoms = e.args.collateralAmount.toString();
    } catch { /* Other events are ignored. */ }
  }
  return { status: success ? 'confirmed' : 'reverted', blockNumber: BigInt(receipt.blockNumber).toString(), paidAtoms };
}

// Pool resolution for scoring paper fills: null while unresolved.
export async function readResolution({ rpc, pool }) {
  const read = async fn => decodeFunctionResult({ abi: pilotPoolAbi, functionName: fn, data: await rpc('eth_call', [{ to: pool, data: encodeFunctionData({ abi: pilotPoolAbi, functionName: fn }) }, 'latest']) });
  if (!await read('resolved')) return null;
  return { yesMask: Number(await read('resolvedState')), voidMask: Number(await read('voidMask')) };
}
