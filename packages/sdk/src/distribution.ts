import { FlurboError } from './errors.ts';
import { PPM } from './amounts.ts';
import { type Claim, scopeEvents } from './claims.ts';

// A joint forecast is a normalized distribution over every Yes/No combination of the forecast events.
// Probabilities are integer parts per million that sum to exactly 1,000,000, so every derived number
// (marginals, joints, claim probabilities) is exact and reproducible. These are model estimates,
// never market prices.
//   states[s]: probability of local state s, where local bit j is the answer of events[j] (ascending).
export type Joint = { events: number[]; states: bigint[] };

export function assertJoint(joint: Joint, eventCount?: number): Joint {
  const { events, states } = joint;
  if (!Array.isArray(events) || events.length < 1 || events.length > 4) throw new FlurboError('invalid_forecast', 'A forecast covers one to four events.');
  if (events.some((e, i) => !Number.isInteger(e) || e < 0 || (eventCount !== undefined && e >= eventCount) || (i > 0 && events[i - 1] >= e)))
    throw new FlurboError('invalid_forecast', 'Forecast events must be distinct pool events in ascending order.');
  if (!Array.isArray(states) || states.length !== 2 ** events.length || states.some(p => typeof p !== 'bigint' || p < 0n))
    throw new FlurboError('invalid_forecast', 'Every outcome combination needs a non-negative probability.');
  if (states.reduce((a, b) => a + b, 0n) !== PPM) throw new FlurboError('invalid_forecast', 'Outcome probabilities must sum to exactly 100%.');
  return joint;
}

const index = (joint: Joint, event: number): number => {
  const i = joint.events.indexOf(event);
  if (i < 0) throw new FlurboError('invalid_forecast', `Event ${event} is not part of this forecast.`);
  return i;
};

export function marginal(joint: Joint, event: number): bigint {
  const bit = 1 << index(joint, event);
  return joint.states.reduce((sum, p, s) => (s & bit ? sum + p : sum), 0n);
}

export function both(joint: Joint, a: number, b: number): bigint {
  const bits = (1 << index(joint, a)) | (1 << index(joint, b));
  return joint.states.reduce((sum, p, s) => ((s & bits) === bits ? sum + p : sum), 0n);
}

// Probability that a claim pays, under this forecast. The claim's events must all be forecast.
export function claimProbability(joint: Joint, claim: Claim): bigint {
  const claimEvents = scopeEvents(claim.scope), positions = claimEvents.map(e => index(joint, e));
  let total = 0n;
  joint.states.forEach((p, s) => {
    let local = 0;
    positions.forEach((pos, j) => { if (s & (1 << pos)) local |= 1 << j; });
    if (claim.mask & (1n << BigInt(local))) total += p;
  });
  return total;
}

export const covers = (joint: Joint, claim: Claim): boolean => scopeEvents(claim.scope).every(e => joint.events.includes(e));

// Fréchet bounds for two events: max(0, P(A)+P(B)-1) <= P(A and B) <= min(P(A), P(B)).
export function frechetBounds(pA: bigint, pB: bigint): { low: bigint; high: bigint } {
  for (const p of [pA, pB]) if (p < 0n || p > PPM) throw new FlurboError('invalid_forecast', 'Probabilities must be between 0% and 100%.');
  const low = pA + pB - PPM;
  return { low: low > 0n ? low : 0n, high: pA < pB ? pA : pB };
}

// Two events from marginals and a joint. Contradictory input is rejected, never displayed as coherent.
export function jointFromPair(input: { a: number; b: number; pA: bigint; pB: bigint; pBoth: bigint }): Joint {
  const { a, b, pA, pB, pBoth } = input;
  if (a === b) throw new FlurboError('invalid_forecast', 'Choose two different events.');
  const { low, high } = frechetBounds(pA, pB);
  if (pBoth < low || pBoth > high) throw new FlurboError('invalid_forecast', 'The chance of both happening must be at least P(A)+P(B)-100% and at most the smaller of P(A) and P(B).');
  const [first, second, pFirst, pSecond] = a < b ? [a, b, pA, pB] : [b, a, pB, pA];
  // Local bit 0 is the lower event index, bit 1 the higher.
  const states = [PPM - pFirst - pSecond + pBoth, pFirst - pBoth, pSecond - pBoth, pBoth];
  return assertJoint({ events: [first, second], states });
}

// Independent marginals as a baseline, rounded to exact ppm with the largest-remainder method.
export function independentJoint(events: number[], marginals: bigint[]): Joint {
  if (events.length !== marginals.length) throw new FlurboError('invalid_forecast', 'One probability per event is required.');
  const order = events.map((e, i) => ({ e, p: marginals[i] })).sort((x, y) => x.e - y.e);
  order.forEach(({ p }) => { if (p < 0n || p > PPM) throw new FlurboError('invalid_forecast', 'Probabilities must be between 0% and 100%.'); });
  const n = order.length, scale = PPM ** BigInt(n - 1), raw: { s: number; whole: bigint; rest: bigint }[] = [];
  for (let s = 0; s < 2 ** n; s++) {
    let product = 1n;
    order.forEach(({ p }, j) => { product *= s & (1 << j) ? p : PPM - p; });
    raw.push({ s, whole: product / scale, rest: product % scale });
  }
  let missing = PPM - raw.reduce((a, r) => a + r.whole, 0n);
  const states = raw.map(r => r.whole);
  for (const r of [...raw].sort((x, y) => (y.rest > x.rest ? 1 : y.rest < x.rest ? -1 : x.s - y.s))) { if (missing <= 0n) break; states[r.s]++; missing--; }
  return assertJoint({ events: order.map(o => o.e), states });
}

export const jointToJSON = (joint: Joint) => ({ events: joint.events, statesPpm: joint.states.map(String) });
export function jointFromJSON(value: unknown, eventCount?: number): Joint {
  const v = value as { events?: unknown; statesPpm?: unknown } | null;
  if (!v || !Array.isArray(v.events) || !Array.isArray(v.statesPpm) || v.statesPpm.some(p => typeof p !== 'string' || !/^(0|[1-9][0-9]{0,6})$/.test(p)))
    throw new FlurboError('invalid_forecast', 'Malformed forecast distribution.');
  return assertJoint({ events: v.events as number[], states: (v.statesPpm as string[]).map(p => BigInt(p)) }, eventCount);
}
