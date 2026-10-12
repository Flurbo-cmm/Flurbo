// Mirrors LsQuote.sol: depth = initial depth + rate * mean joint liability, rate = commission / (events ln 2).
// Exact integer arithmetic with the contract's rounding, so analytics can compare against the on-chain depth.
export const WAD = 10n ** 18n;
export const LN2_WAD = 693147180559945309n;
export const ATOM_TO_WAD = 10n ** 12n;
export const MIN_COMMISSION_BPS = 100, MAX_COMMISSION_BPS = 2000;

export function depthRateWad(events, commissionBps) {
  if (!Number.isInteger(events) || events < 1 || events > 32) throw new Error('Invalid event count');
  if (!Number.isInteger(commissionBps) || commissionBps < MIN_COMMISSION_BPS || commissionBps > MAX_COMMISSION_BPS)
    throw new Error('Invalid commission');
  return BigInt(commissionBps) * 10n ** 14n * WAD / (BigInt(events) * LN2_WAD);
}

export function depthWad(initialDepthWad, rateWad, factors) {
  let scaled = 0n;
  for (const factor of factors) {
    if (!Number.isInteger(factor?.scope) || factor.scope < 0) throw new Error('Invalid scope');
    const size = factor.scope.toString(2).replaceAll('0', '').length;
    if (size > 3) throw new Error('Invalid scope');
    if (!Array.isArray(factor.values) || factor.values.length !== 2 ** size) throw new Error('Invalid values');
    scaled += factor.values.reduce((sum, value) => sum + BigInt(value), 0n) * BigInt(8 >> size);
  }
  return BigInt(initialDepthWad) + BigInt(rateWad) * scaled / (8n * WAD);
}

// The fixed-depth analytics state at the current depth, in WAD units. Probabilities depend only on L / depth.
export function lsAnalyticsState({ events, a, b, initialDepthAtoms, commissionBps, order, factors }) {
  const rateWad = depthRateWad(events, commissionBps);
  const wadFactors = factors.map(f => ({ scope: f.scope, values: f.values.map(v => (BigInt(v) * ATOM_TO_WAD).toString()) }));
  const depth = depthWad(BigInt(initialDepthAtoms) * ATOM_TO_WAD, rateWad, wadFactors);
  return { state: { events, a, b, liquidity: depth.toString(), order, factors: wadFactors }, depthWad: depth, rateWad };
}

// Null unless the pool's initial depth, commission and current depth agree with the committed pricing and the formula.
export function verifiedLsState(committed, { events, a, b, order, factors, liquidity, commissionBps, depth }) {
  const built = lsAnalyticsState({ events, a, b, order, factors,
    initialDepthAtoms: committed.initialDepthAtoms, commissionBps: committed.commissionBps });
  if (BigInt(liquidity) !== BigInt(committed.initialDepthAtoms) || Number(commissionBps) !== committed.commissionBps
    || BigInt(depth) !== built.depthWad || (committed.depthRateWad !== undefined && BigInt(committed.depthRateWad) !== built.rateWad))
    return null;
  return { state: built.state, ls: { initialDepthWad: BigInt(committed.initialDepthAtoms) * ATOM_TO_WAD, rateWad: built.rateWad } };
}
