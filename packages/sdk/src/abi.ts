import { FlurboError } from './errors.ts';

// ABI encoding for the calls the protocol uses (protocol/specs/contracts.md). Every argument is a static
// type, so calldata is the 4-byte selector followed by one 32-byte word per argument. Selectors and event
// topics are fixed by the protocol and checked against protocol/fixtures/calldata.json.
export const SELECTORS = Object.freeze({
  buy: '0x3e6b6cde', sell: '0xc39849c5', redeem: '0xdf992423', quoteBuy: '0xa6a83dde', quoteSell: '0xf29d0ba9',
  holdings: '0x90fc2c7b', payoutFraction: '0xf0f54950', closesAt: '0x39a3a99a', eventCount: '0x71be2e4a', collateral: '0xd8dfeb45',
  collateralDecimals: '0xec9c6c30', settlementRulesHash: '0x03a79426', resolved: '0x3f6fa655', resolvedState: '0x1bb51c6a',
  voidMask: '0x91187684', funded: '0xf3a504f2', approve: '0x095ea7b3', allowance: '0xdd62ed3e', balanceOf: '0x70a08231', decimals: '0x313ce567',
} as const);
export type FunctionName = keyof typeof SELECTORS;
export const TOPICS = Object.freeze({
  Traded: '0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5',
  Redeemed: '0x3e24bbc5ae535f3f571a815b8ba9fc70c94ad494d812f0210c3da99fad2173ae',
} as const);

type Kind = 'uint32' | 'uint128' | 'uint256' | 'address' | 'bool' | 'uint8';
const SIGNATURES: Record<FunctionName, Kind[]> = {
  buy: ['uint32', 'uint256', 'uint128', 'uint128', 'uint256'], sell: ['uint32', 'uint256', 'uint128', 'uint128', 'uint256'],
  redeem: ['uint32', 'uint256', 'uint128'], quoteBuy: ['uint32', 'uint256', 'uint128'], quoteSell: ['uint32', 'uint256', 'uint128'],
  holdings: ['address', 'uint32', 'uint256'], payoutFraction: ['uint32', 'uint256'], approve: ['address', 'uint256'],
  allowance: ['address', 'address'], balanceOf: ['address'], closesAt: [], eventCount: [], collateral: [], collateralDecimals: [],
  settlementRulesHash: [], resolved: [], resolvedState: [], voidMask: [], funded: [], decimals: [],
};
const BITS: Record<Kind, number> = { uint8: 8, uint32: 32, uint128: 128, uint256: 256, address: 160, bool: 1 };
const HEX = /^0x[0-9a-f]*$/;
const bad = (message: string): never => { throw new FlurboError('invalid_input', message); };

export type Word = bigint | string | boolean | number;
function word(kind: Kind, value: Word): string {
  let n: bigint;
  if (kind === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) bad('Invalid address.');
    n = BigInt(value as string);
  } else if (kind === 'bool') {
    if (typeof value !== 'boolean') bad('Invalid boolean.');
    n = value ? 1n : 0n;
  } else {
    if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
    else if (typeof value === 'bigint') n = value;
    else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) n = BigInt(value);
    else return bad(`Invalid ${kind}.`);
  }
  if (n < 0n || n >= 1n << BigInt(BITS[kind])) bad(`Value out of range for ${kind}.`);
  return n.toString(16).padStart(64, '0');
}

export function encodeCall(name: FunctionName, args: Word[]): string {
  const kinds = SIGNATURES[name];
  if (!kinds) return bad('Unsupported function.');
  if (args.length !== kinds.length) bad(`${name} takes ${kinds.length} arguments.`);
  return SELECTORS[name] + kinds.map((kind, i) => word(kind, args[i])).join('');
}

// Decodes calldata for a supported function. Rejects unknown selectors, wrong lengths and non-canonical
// words (dirty high bits), mirroring the web app's re-encoding check.
export function decodeCall(data: string): { name: FunctionName; args: bigint[] } {
  const hex = data.toLowerCase();
  if (!HEX.test(hex) || hex.length < 10) bad('Invalid calldata.');
  const name = (Object.keys(SELECTORS) as FunctionName[]).find(n => SELECTORS[n] === hex.slice(0, 10));
  if (!name) return bad('Unsupported function.');
  const kinds = SIGNATURES[name], body = hex.slice(10);
  if (body.length !== kinds.length * 64) bad('Invalid calldata length.');
  const args = kinds.map((_, i) => BigInt('0x' + (body.slice(i * 64, i * 64 + 64) || '0')));
  args.forEach((v, i) => { if (v >= 1n << BigInt(BITS[kinds[i]])) bad('Non-canonical calldata.'); });
  return { name, args };
}

export const addressFromWord = (value: bigint): string => '0x' + value.toString(16).padStart(40, '0');

// Return data: one or more 32-byte words.
export function decodeWords(data: string, count: number): bigint[] {
  const hex = data.toLowerCase();
  if (!HEX.test(hex) || hex.length !== 2 + count * 64) throw new FlurboError('invalid_response', 'Unexpected contract return data.');
  return Array.from({ length: count }, (_, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + i * 64 + 64)));
}

export type Log = { address: string; topics: string[]; data: string };
export type TradedEvent = { event: 'Traded'; address: string; trader: string; scope: number; mask: bigint; isBuy: boolean; quantity: bigint; collateralAmount: bigint };
export type RedeemedEvent = { event: 'Redeemed'; address: string; owner: string; scope: number; mask: bigint; quantity: bigint; collateralAmount: bigint };

// Decodes a pool event, or returns null for any other log. Malformed pool-shaped logs are treated as
// other logs, never guessed at.
export function decodePoolLog(log: Log): TradedEvent | RedeemedEvent | null {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 4 || typeof log.data !== 'string') return null;
  const [t0, t1, t2, t3] = log.topics.map(t => String(t).toLowerCase());
  if (![t0, t1, t2, t3].every(t => /^0x[0-9a-f]{64}$/.test(t))) return null;
  const topic = (t: string) => BigInt(t);
  const address = String(log.address).toLowerCase(), who = topic(t1), scope = topic(t2), mask = topic(t3);
  if (who >= 1n << 160n || scope >= 1n << 32n) return null;
  try {
    if (t0 === TOPICS.Traded) {
      const [isBuy, quantity, amount] = decodeWords(log.data, 3);
      if (isBuy > 1n || quantity >= 1n << 128n || amount >= 1n << 128n) return null;
      return { event: 'Traded', address, trader: addressFromWord(who), scope: Number(scope), mask, isBuy: isBuy === 1n, quantity, collateralAmount: amount };
    }
    if (t0 === TOPICS.Redeemed) {
      const [quantity, amount] = decodeWords(log.data, 2);
      if (quantity >= 1n << 128n || amount >= 1n << 128n) return null;
      return { event: 'Redeemed', address, owner: addressFromWord(who), scope: Number(scope), mask, quantity, collateralAmount: amount };
    }
  } catch { return null; }
  return null;
}
