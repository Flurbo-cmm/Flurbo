# Numbers

## Units

| Quantity | Unit | Scale |
| --- | --- | --- |
| Collateral (test AUSD) | atom | 1 test AUSD = 1,000,000 atoms (the token has 6 decimals, checked on-chain) |
| Shares of a claim | atom | 1 share = 1,000,000 atoms; a winning share pays 1 test AUSD |
| Probability, forecast | parts per million (ppm) | integer 0 to 1,000,000 inclusive |
| Model-implied probability (analytics) | tenths of a percentage point | integer 0 to 1,000 inclusive |
| Slippage, edge thresholds | basis points (bps) | integer; 10,000 bps = 100 percent |
| Gas and fees | wei | integer |
| Time | Unix seconds | integer |

## JSON representation

- Token amounts, share quantities, limits, budgets, fees and block numbers are decimal integer strings matching `^(0|[1-9][0-9]{0,77})$`. Leading zeros, signs, exponents and fractions are rejected.
- Scopes, bps, ppm and tenths are JSON integers within their stated ranges.
- A mask is a decimal integer string (see claims.md).
- Floating point is never used for money, quantities, allowances, budgets, slippage or probabilities. Implementations use big integers for amounts.

## Probabilities

- A joint distribution over the selected events lists one ppm value per local state and sums to exactly 1,000,000.
- A pair forecast `(P(A), P(B), P(A and B))` must satisfy `max(0, P(A) + P(B) - 1,000,000) <= P(A and B) <= min(P(A), P(B))`. Contradictory input is rejected, never repaired.
- Converting decimal percentage text to ppm accepts at most four decimal places (`62.5` becomes `625000`). More precision is rejected.
- When only marginals are known, no joint distribution is assumed. Independence is never implied by missing data.

## Rounding

| Computation | Rule |
| --- | --- |
| Buy limit from quote and slippage | `ceil(quote * (10000 + bps) / 10000)` |
| Sell minimum from quote and slippage | `floor(quote * (10000 - bps) / 10000)` |
| Probability that a claim pays | `p` = sum of the forecast ppm over the claim's winning states (exact) |
| Expected payout under a forecast | `floor(quantity * p / 1,000,000)` |
| Edge | `expectedPayout - worstCost`, exact integer |
| Relative edge in bps | `trunc(edge * 10000 / worstCost)` (toward zero) when `worstCost > 0` |
| Redemption payout | `floor(quantity * numerator / denominator)`, as the contract computes |
| Gas reservation | `gasLimit * maxFeePerGas`, exact |

Rounding always favours the conservative side for the agent: limits round against the agent, estimated payouts round down.
