// Local Boolean claims. Bit order is ascending event index, matching PilotPool.
// This module encodes intent only; the pool remains authoritative for quotes.
export const CLAIM_SCHEMA = 'flurbo.claim.v1';
export const CLAIM_RULES = Object.freeze(['AND', 'OR', 'EXACTLY_ONE', 'AT_LEAST_TWO']);
export function ruleMatches(rule, matches) {
  if (!CLAIM_RULES.includes(rule) || !matches.length) throw Error('Unsupported payout rule');
  const count = matches.filter(Boolean).length;
  return rule === 'AND' ? count === matches.length : rule === 'OR' ? count > 0
    : rule === 'EXACTLY_ONE' ? count === 1 : count >= 2;
}
export function claimEvents(scope) {
  if (!Number.isInteger(scope) || scope <= 0 || scope >= 2 ** 4) throw Error('Invalid claim scope');
  return [0, 1, 2, 3].filter(i => scope & (1 << i));
}
export function validateClaim(scope, mask, events) {
  if (![2, 3, 4].includes(events) || typeof mask !== 'string' || !/^[1-9][0-9]{0,2}$/.test(mask)) throw Error('Invalid claim');
  const legs = claimEvents(scope);
  if (scope >= 2 ** events || legs.length > 3 || BigInt(mask) >= (1n << BigInt(2 ** legs.length)) - 1n) throw Error('Unsupported claim');
  return legs;
}
export function encodeClaim({events, legs, rule}) {
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 3 || !CLAIM_RULES.includes(rule)) throw Error('Choose one to three answers');
  const sorted = [...legs].sort((a, b) => a.event - b.event);
  if (new Set(sorted.map(l => l.event)).size !== sorted.length || sorted.some(l => !Number.isInteger(l.event) || l.event < 0 || l.event >= events || typeof l.yes !== 'boolean')) throw Error('Invalid claim answers');
  if (rule === 'AT_LEAST_TWO' && legs.length < 2) throw Error('Choose at least two answers');
  const scope = sorted.reduce((s, l) => s | (1 << l.event), 0);
  let mask = 0n;
  for (let state = 0; state < 2 ** sorted.length; state++) {
    if (ruleMatches(rule, sorted.map((l, i) => Boolean(state & (1 << i)) === l.yes))) mask |= 1n << BigInt(state);
  }
  validateClaim(scope, String(mask), events);
  return {schema: CLAIM_SCHEMA, scope, mask: String(mask)};
}
export function claimScenarios(scope, mask, events) {
  const selected = validateClaim(scope, mask, events);
  return Array.from({length: 2 ** selected.length}, (_, state) => ({
    state, answers: selected.map((event, i) => ({event, yes: Boolean(state & (1 << i))})),
    wins: Boolean(BigInt(mask) & (1n << BigInt(state))),
  }));
}
// Decode only when an exact named representation exists. Never change a mask.
export function decodeClaim(scope, mask, events = 4) {
  const selected = validateClaim(scope, String(mask), events);
  for (const rule of CLAIM_RULES) for (let state = 2 ** selected.length - 1; state >= 0; state--) {
    if (rule === 'AT_LEAST_TWO' && selected.length < 2) continue;
    const legs = selected.map((event, i) => ({event, yes: Boolean(state & (1 << i))}));
    if (encodeClaim({events, legs, rule}).mask === String(mask)) return {rule, legs};
  }
  return null;
}
