import { FlurboError } from './errors.ts';
import { CHAIN_ID } from './version.ts';
import { encodeClaim, decodeClaim, validateClaim, claimScenarios, CLAIM_SCHEMA, CLAIM_RULES, type ClaimRule, type ClaimLeg } from '../../../apps/web/shared/claims.mjs';

// Claims use the canonical Flurbo combination model (flurbo.claim.v1, apps/web/shared/claims.mjs), owned by
// the market interface. This module never encodes on its own: it wraps canonical {scope, mask} with the
// chain and pool the claim belongs to, and uses a bigint mask so amounts and masks never touch floats.
//   scope: bit i set means pool event i is part of the claim (one to three events).
//   mask:  bit s set means the claim pays in local state s; local bit j is the answer of the j-th scoped
//          event in ascending order, exactly as PilotPool.project and FactoredPositions.key define it.
export type Answer = ClaimLeg;
export type Rule = ClaimRule;
export type Claim = { chainId: number; pool: string; scope: number; mask: bigint };
export type ClaimShape = Rule | 'SINGLE' | 'OTHER';
export type ClaimJSON = { chainId: number; pool: string; scope: number; mask: string };
export const CLAIM_ADAPTER = CLAIM_SCHEMA;
export const RULES = CLAIM_RULES;

const POOL = /^0x[0-9a-f]{40}$/;
export const bitCount = (value: number): number => { let n = 0; for (let v = value; v; v &= v - 1) n++; return n; };
export const scopeEvents = (scope: number): number[] => { const out: number[] = []; for (let i = 0; i < 31; i++) if (scope & (1 << i)) out.push(i); return out; };

const canonical = <T>(fn: () => T, message: string): T => { try { return fn(); } catch { throw new FlurboError('unsupported_claim', message); } };

export function assertClaim(claim: Claim, eventCount: number): Claim {
  if (claim.chainId !== CHAIN_ID) throw new FlurboError('unsupported_claim', 'Only Monad testnet (chain 10143) is supported.');
  if (!POOL.test(claim.pool)) throw new FlurboError('unsupported_claim', 'Invalid pool address.');
  if (typeof claim.mask !== 'bigint' || claim.mask <= 0n) throw new FlurboError('unsupported_claim', 'A claim must win in some outcomes and lose in others.');
  canonical(() => validateClaim(claim.scope, claim.mask.toString(), eventCount), 'This claim is not supported in this pool.');
  return claim;
}

// One pricing pool per claim. Claims from different pools never combine, even if the UI lists them together.
export function assertSamePool(claims: Claim[]): string {
  const pools = new Set(claims.map(c => c.pool));
  if (pools.size !== 1) throw new FlurboError('cross_pool', 'These events belong to different pools and cannot be combined in one claim.');
  return [...pools][0];
}

// Build a claim from answers and a payout rule through the canonical encoder.
export function encode(pool: string, eventCount: number, answers: Answer[], rule: Rule): Claim {
  const encoded = canonical(() => encodeClaim({ events: eventCount, legs: answers, rule }), 'This combination is not supported in this pool.');
  return assertClaim({ chainId: CHAIN_ID, pool, scope: encoded.scope, mask: BigInt(encoded.mask) }, eventCount);
}
export const allOf = (pool: string, eventCount: number, answers: Answer[]): Claim => encode(pool, eventCount, answers, 'AND');
export const anyOf = (pool: string, eventCount: number, answers: Answer[]): Claim => {
  if (answers.length < 2) throw new FlurboError('unsupported_claim', 'Use a single answer instead of "at least one" of one answer.');
  return encode(pool, eventCount, answers, 'OR');
};
export const exactlyOne = (pool: string, eventCount: number, answers: Answer[]): Claim => encode(pool, eventCount, answers, 'EXACTLY_ONE');
export const atLeastTwo = (pool: string, eventCount: number, answers: Answer[]): Claim => encode(pool, eventCount, answers, 'AT_LEAST_TWO');
export const single = (pool: string, eventCount: number, answer: Answer): Claim => encode(pool, eventCount, [answer], 'AND');

// The canonical named reading of a claim, when one exists. Masks are never rewritten to fit a name.
export function describe(claim: Claim, eventCount: number): { rule: Rule; legs: Answer[] } | null {
  return canonical(() => decodeClaim(claim.scope, claim.mask.toString(), eventCount), 'This claim is not supported in this pool.');
}
export function claimShape(claim: Claim, eventCount: number): ClaimShape {
  if (bitCount(claim.scope) === 1) return 'SINGLE';
  return describe(claim, eventCount)?.rule ?? 'OTHER';
}

// The exact winning condition, as every answer combination that pays.
export function winningCombinations(claim: Claim, eventCount: number): Answer[][] {
  return canonical(() => claimScenarios(claim.scope, claim.mask.toString(), eventCount), 'This claim is not supported in this pool.')
    .filter(s => s.wins).map(s => s.answers);
}

// Does the claim pay in the given full-pool assignment (bit i = event i is Yes)? Evaluation only.
export function paysIn(claim: Claim, state: number): boolean {
  let local = 0, index = 0;
  for (const event of scopeEvents(claim.scope)) { if (state & (1 << event)) local |= 1 << index; index++; }
  return (claim.mask & (1n << BigInt(local))) !== 0n;
}

export const claimKey = (claim: Claim): string => `${claim.chainId}:${claim.pool}:${claim.scope}:${claim.mask.toString()}`;
export const claimToJSON = (claim: Claim): ClaimJSON => ({ chainId: claim.chainId, pool: claim.pool, scope: claim.scope, mask: claim.mask.toString() });

export function claimFromJSON(value: unknown, eventCount: number): Claim {
  const v = value as Partial<ClaimJSON> | null;
  if (!v || typeof v !== 'object' || typeof v.pool !== 'string' || typeof v.mask !== 'string' || !/^[1-9][0-9]{0,2}$/.test(v.mask) || typeof v.scope !== 'number')
    throw new FlurboError('unsupported_claim', 'Malformed claim.');
  return assertClaim({ chainId: Number(v.chainId), pool: v.pool.toLowerCase(), scope: v.scope, mask: BigInt(v.mask) }, eventCount);
}

// Payout fraction after resolution, mirroring PilotPool.payoutFraction: VOID events are averaged
// uniformly over both answers; known answers are fixed. VOID is not No.
export function payoutFraction(claim: Claim, eventCount: number, resolution: { yesMask: number; voidMask: number }): { numerator: bigint; denominator: bigint } {
  assertClaim(claim, eventCount);
  const all = 2 ** eventCount - 1, known = all ^ resolution.voidMask;
  if ((resolution.yesMask & resolution.voidMask) !== 0 || resolution.yesMask > all || resolution.voidMask > all) throw new FlurboError('invalid_input', 'Invalid resolution.');
  let numerator = 0n, denominator = 0n;
  for (let state = 0; state <= all; state++) {
    if ((state & known) !== resolution.yesMask) continue;
    denominator++;
    if (paysIn(claim, state)) numerator++;
  }
  return { numerator, denominator };
}
