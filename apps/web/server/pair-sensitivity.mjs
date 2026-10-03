import { validatePairSnapshot } from './pair-math.mjs';

// Read-only reflection of FactoredQuote.updatedFactors, never execution authority.
// Each scenario starts from the original snapshot, not the preceding scenario.
export function simulatePairPurchase(state, answer) {
  validatePairSnapshot(state);
  if (!['yes', 'no'].includes(answer)) throw new Error('Invalid simulated answer');
  const quantity = 1_000_000n;
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
  const after = validatePairSnapshot({ ...state, factors });
  return { scope, mask, quantity: quantity.toString(), after };
}
