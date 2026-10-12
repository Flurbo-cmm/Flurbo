import { validatePairSnapshot } from './pair-math.mjs';
import { depthWad } from '../shared/ls-lmsr.mjs';

// Read-only reflection of FactoredQuote.updatedFactors, never execution authority.
// Each scenario starts from the original snapshot, not the preceding scenario.
// With ls = { initialDepthWad, rateWad } the state is in WAD units and the depth is recomputed after the share.
export function simulatePairPurchase(state, answer, ls = null) {
  validatePairSnapshot(state);
  if (!['yes', 'no'].includes(answer)) throw new Error('Invalid simulated answer');
  const quantity = ls ? 10n ** 18n : 1_000_000n;
  if (quantity > BigInt(state.liquidity)) throw new Error('One share exceeds the pool quantity limit');
  const scope = (1 << state.a) | (1 << state.b);
  const bBit = state.b < state.a ? 0 : 1;
  const winningState = answer === 'yes' ? 3 : 1 << bBit;
  const mask = 1 << winningState;
  const values = [0n, 0n, 0n, 0n];
  const factors = [];
  for (const factor of state.factors) {
    if (factor.scope === scope) factor.values.forEach((value, i) => { values[i] += BigInt(value); });
    else factors.push({ scope: factor.scope, values: [...factor.values] });
  }
  values[winningState] += quantity;
  factors.push({ scope, values: values.map(String) });
  const liquidity = ls ? depthWad(ls.initialDepthWad, ls.rateWad, factors).toString() : state.liquidity;
  const after = validatePairSnapshot({ ...state, factors, liquidity });
  return { scope, mask, quantity: '1000000', after };
}
