// Proposer holdings guard: an automated proposer must hold no position in the pool it proposes for.
// Exhaustive by construction. Every buy appends its scope to factors() (FactoredTrading.applyQuote), and
// internal positions move only through buy, sell, redeem, wrapBase and unwrapBase. So a position of this
// address can exist only on (factor scope, non-constant mask) or as a wrapped base-token balance.
// Limits: this covers the signing address only, not other wallets of the same person. Anyone can send
// wrapped base tokens to the address, which blocks proposals (fail closed) until a person reviews it.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { pilotPoolAbi } from '../shared/pilot.mjs';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const multicallAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ZERO = '0x0000000000000000000000000000000000000000';
const CHUNK = 250;

export function claimMasks(scope) {
  let size = 0;
  for (let s = scope; s; s &= s - 1) size++;
  if (size < 1 || size > 3) throw new Error('Unsupported factor scope');
  const limit = 2 ** (2 ** size) - 1;
  return Array.from({ length: limit - 1 }, (_, i) => i + 1); // 1 .. 2^(2^k)-2, as FactoredPositions.key requires
}

export async function proposerHoldings({ manifest, rpc, owner }) {
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new Error('Invalid proposer');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block?.number || !block?.hash) throw new Error('Invalid block');
  const tag = block.number;
  const aggregate = async calls => {
    const out = [];
    for (let i = 0; i < calls.length; i += CHUNK) {
      const part = calls.slice(i, i + CHUNK);
      const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [part.map(c => ({ target: c.target, allowFailure: false, callData: c.data }))] });
      const rows = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: await rpc('eth_call', [{ to: MULTICALL3, data }, tag]) });
      if (rows.length !== part.length || rows.some(r => !r.success)) throw new Error('Holdings read failed');
      rows.forEach((r, j) => out.push(decodeFunctionResult({ abi: part[j].abi, functionName: part[j].fn, data: r.returnData })));
    }
    return out;
  };
  const call = (target, abi, fn, args = []) => ({ target, abi, fn, data: encodeFunctionData({ abi, functionName: fn, args }) });
  const events = manifest.publication.draft.events.length;
  const [factors] = await aggregate([call(manifest.pool, pilotPoolAbi, 'factors')]);
  const scopes = [...new Set(factors.map(f => Number(f.scope)))];
  const claims = scopes.flatMap(scope => claimMasks(scope).map(mask => ({ scope, mask })));
  const bases = Array.from({ length: events }, (_, i) => [[i, 2], [i, 1]]).flat();
  const tokens = await aggregate(bases.map(([i, mask]) => call(manifest.pool, pilotPoolAbi, 'baseTokens', [1 << i, mask])));
  const held = await aggregate(claims.map(c => call(manifest.pool, pilotPoolAbi, 'holdings', [owner, c.scope, BigInt(c.mask)])));
  const wrappedTokens = bases.map(([event, mask], i) => ({ event, outcome: mask === 2 ? 'YES' : 'NO', token: String(tokens[i]).toLowerCase() })).filter(t => t.token !== ZERO);
  const balances = await aggregate(wrappedTokens.map(t => call(t.token, erc20Abi, 'balanceOf', [owner])));
  const positions = claims.map((c, i) => ({ ...c, quantity: String(held[i]) })).filter(p => p.quantity !== '0');
  const wrapped = wrappedTokens.map((t, i) => ({ ...t, balance: String(balances[i]) })).filter(t => t.balance !== '0');
  return { clear: !positions.length && !wrapped.length, blockNumber: String(BigInt(block.number)), checkedClaims: claims.length,
    checkedTokens: wrappedTokens.length, positions, wrapped };
}

// Fails closed: a missing or failing guard blocks proposals, never finishing actions.
export async function proposerStatus(proposerHoldings) {
  if (typeof proposerHoldings !== 'function') return { status: 'guard-missing' };
  let held;
  try { held = await proposerHoldings(); } catch { return { status: 'guard-unavailable' }; }
  if (held?.clear === true && Array.isArray(held.positions) && !held.positions.length && Array.isArray(held.wrapped) && !held.wrapped.length)
    return { status: 'clear', blockNumber: held.blockNumber, checkedClaims: held.checkedClaims };
  return { status: 'holds-position', blockNumber: held?.blockNumber, positions: held?.positions?.length ?? null, wrapped: held?.wrapped?.length ?? null };
}
