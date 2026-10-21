// Conditional claims "if condition, then target" on CondPilotPool (conditionalVersion 1). Mirrors ConditionalShape.sol:
// pays shares where both hold, nothing where only the condition holds, and refunds the price where it fails.
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { claimEvents, encodeClaim } from './claims.mjs';
import { pilotCash, pilotCashAbi } from './pilot.mjs';

export const CONDITIONAL_VERSION = 1, PRICER_VERSION = 1, MAX_SHAPES = 256;
export const MAX_CONDITIONAL_SHARES = 20_000_000n;
// keccak256 of LsPricer's runtime code without the compiler metadata trailer, which encodes source paths only.
export const LS_PRICER_CODE_HASH = '0x9d94c381bfcef323ed0b6e0a40fb02b2bbe695a05b25a5b9080bc147dff61ee4';

const shape = '(uint32 conditionScope,uint256 conditionMask,uint32 targetScope,uint256 targetMask)';
export const condPoolAbi = parseAbi([
  'function conditionalVersion() view returns (uint8)', 'function pricer() view returns (address)',
  'function protocolVersion() view returns (uint8)', 'function shapeCount() view returns (uint256)',
  `function shapeAt(uint256 index) view returns (bytes32 key,${shape} shape)`,
  'function conditionalHolding(address owner,bytes32 key) view returns (uint128 shares,uint128 refund)',
  `function quoteConditionalBuy(${shape} shape,uint128 shares,uint128 price) view returns (uint128)`,
  `function quoteConditionalSell(${shape} shape,address owner,uint128 shares) view returns (uint128 proceeds,uint128 refundRemoved)`,
  `function conditionalPayout(${shape} shape,address owner) view returns (uint128)`,
  `function buyConditional(${shape} shape,uint128 shares,uint128 price,uint256 deadline) returns (bytes32)`,
  `function sellConditional(${shape} shape,uint128 shares,uint128 minProceeds,uint256 deadline) returns (uint128)`,
  `function redeemConditional(${shape} shape) returns (uint128)`,
  'function liquidity() view returns (uint128)', 'function depth() view returns (uint256)',
  'function commissionBps() view returns (uint16)', 'function eliminationOrder() view returns (uint8[])',
  'function factors() view returns ((uint32 scope,uint128[] values)[])',
  'function resolved() view returns (bool)', 'function resolvedState() view returns (uint32)',
  'function voidMask() view returns (uint32)',
  'event ConditionalTraded(address indexed trader,bytes32 indexed key,bool isBuy,uint128 shares,uint128 refund,uint128 collateralAmount)',
  'event ConditionalRedeemed(address indexed owner,bytes32 indexed key,uint128 shares,uint128 refund,uint128 collateralAmount)',
]);

const invalid = () => new Error('Invalid conditional');
const size = scope => claimEvents(scope).length;
const integer = value => typeof value === 'bigint' ? value
  : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
  : typeof value === 'string' && /^(0|[1-9][0-9]{0,76})$/.test(value) ? BigInt(value) : null;

export function validateShape(value, events) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).filter(key => key !== 'scope') : [];
  if (keys.sort().join() !== 'conditionMask,conditionScope,targetMask,targetScope') throw invalid();
  const { conditionScope, targetScope } = value, conditionMask = integer(value.conditionMask), targetMask = integer(value.targetMask);
  if (!Number.isInteger(events) || events < 2 || events > 32 || conditionMask === null || targetMask === null) throw invalid();
  for (const scope of [conditionScope, targetScope]) if (!Number.isInteger(scope) || scope <= 0 || scope >= 2 ** events) throw invalid();
  const c = size(conditionScope), t = size(targetScope);
  const overlap = claimEvents(conditionScope).some(event => Math.floor(targetScope / 2 ** event) % 2 === 1);
  const fits = (mask, k) => mask > 0n && mask < (1n << BigInt(2 ** k)) - 1n;
  if (c > 2 || t > 2 || c + t > 3 || overlap || !fits(conditionMask, c) || !fits(targetMask, t)
    || value.scope !== undefined && value.scope !== conditionScope + targetScope) throw invalid();
  return { conditionScope, conditionMask, targetScope, targetMask, scope: conditionScope + targetScope };
}

// The condition is all of its answers; the target combines its answers with `rule`.
export function shapeFromAnswers({ events, condition, target, rule = 'AND' }) {
  try {
    if (!Array.isArray(condition) || !Array.isArray(target) || condition.length < 1 || condition.length > 2
      || target.length < 1 || target.length > 2) throw invalid();
    const c = encodeClaim({ events, legs: condition, rule: 'AND' }), t = encodeClaim({ events, legs: target, rule });
    const s = validateShape({ conditionScope: c.scope, conditionMask: c.mask, targetScope: t.scope, targetMask: t.mask }, events);
    return { conditionScope: s.conditionScope, conditionMask: s.conditionMask, targetScope: s.targetScope, targetMask: s.targetMask };
  } catch { throw invalid(); }
}

export function shapeKey(value) {
  const s = validateShape(value, 32);
  return keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint256' }],
    [s.conditionScope, s.conditionMask, s.targetScope, s.targetMask]));
}

function project(from, to, state) {
  let local = 0;
  claimEvents(to).forEach((event, i) => { if (state >> claimEvents(from).indexOf(event) & 1) local |= 1 << i; });
  return local;
}

function valueAt(s, scope, state, shares, refund) {
  if (!(s.conditionMask >> BigInt(project(scope, s.conditionScope, state)) & 1n)) return refund;
  return s.targetMask >> BigInt(project(scope, s.targetScope, state)) & 1n ? shares : 0n;
}

export function shapeVector(value, shares, refund) {
  const s = validateShape(value, 32), q = BigInt(shares), r = BigInt(refund);
  if (q < 0n || r < 0n || q === 0n && r === 0n) throw invalid();
  return { scope: s.scope, values: Array.from({ length: 2 ** size(s.scope) }, (_, state) => valueAt(s, s.scope, state, q, r)) };
}

// Void questions count both answers equally; rounds down like the pool.
export function shapePayout(value, shares, refund, yesMask, voidMask) {
  const s = validateShape(value, 32), members = claimEvents(s.scope);
  const local = mask => members.reduce((at, event, i) => at | (Math.floor(mask / 2 ** event) % 2 ? 1 << i : 0), 0);
  const known = (2 ** members.length - 1) ^ local(voidMask), yes = local(yesMask);
  let total = 0n, count = 0n;
  for (let state = 0; state < 2 ** members.length; state++) {
    if ((state & known) !== (yes & known)) continue;
    total += valueAt(s, s.scope, state, BigInt(shares), BigInt(refund));
    count++;
  }
  return total / count;
}

const tolerance = price => { const t = (price + 9_999n) / 10_000n; return t > 2n ? t : 2n; };
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

// Smallest price the pool accepts (cost <= price), from at most five quoteConditionalBuy reads. Each step aims at the
// middle of the acceptance window along the secant; the first slope is the chance that the condition fails.
export async function solveConditionalPrice({ shares, fair, conditionChance, quote }) {
  const q = BigInt(shares);
  if (q <= 0n) throw invalid();
  let price = BigInt(Math.ceil(Number(q) * (typeof fair === 'number' && Number.isFinite(fair) ? clamp(fair, 0, 1) : 0.5)));
  if (price < 1n) price = 1n;
  let slope = clamp(1 - (typeof conditionChance === 'number' && Number.isFinite(conditionChance) ? conditionChance : 0.5), 0, 0.99);
  let previous = null;
  for (let reads = 1; reads <= 5; reads++) {
    const cost = BigInt(await quote(price));
    if (cost <= price && price - cost <= tolerance(price)) return { price, cost, reads };
    if (cost > price && price === q) throw new Error('This conditional is too certain to buy');
    if (previous && previous.price !== price) slope = clamp(Number(cost - previous.cost) / Number(price - previous.price), 0, 0.999);
    previous = { price, cost };
    const target = Number(cost - price) + Number(tolerance(price)) / 2;
    let next = price + BigInt(Math.ceil(target / (1 - slope)));
    if (next === price) next += cost > price ? 1n : -1n;
    if (next < 1n) next = 1n;
    price = next > q ? q : next;
  }
  throw new Error('Conditional price unavailable. Refresh and retry.');
}

// keccak256 of runtime code without the trailing CBOR metadata whose length is in the last two bytes.
export function runtimeCodeHash(code) {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return null;
  const length = parseInt(code.slice(-4), 16), bytes = (code.length - 2) / 2;
  return keccak256(length + 2 < bytes ? `0x${code.slice(2, code.length - (length + 2) * 2)}` : code);
}

// The same decoder guards browser review and server preparation. Re-encoding rejects extra or noncanonical bytes.
export function conditionalCall({ to, data, pool, events }) {
  try {
    const target = to.toLowerCase(), self = pool.toLowerCase();
    const abi = target === self ? condPoolAbi : target === pilotCash ? pilotCashAbi : null;
    if (!abi) return null;
    const decoded = decodeFunctionData({ abi, data });
    if (encodeFunctionData({ abi, ...decoded }).toLowerCase() !== data.toLowerCase()) return null;
    const { functionName: name, args = [] } = decoded;
    if (abi === pilotCashAbi) {
      if (name !== 'approve' || args[0].toLowerCase() !== self || args[1] > 100_000_000n) return null;
    } else if (['buyConditional', 'sellConditional', 'redeemConditional'].includes(name)) {
      validateShape({ ...args[0] }, events);
      if (name !== 'redeemConditional' && (args[1] <= 0n || args[1] > MAX_CONDITIONAL_SHARES || args[2] > args[1])) return null;
      if (name === 'buyConditional' && args[2] <= 0n) return null;
    } else return null;
    return { abi, name, args };
  } catch { return null; }
}
