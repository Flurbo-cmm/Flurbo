# Transactions, policies and recovery

## Pipeline

```
research -> forecast (validated) -> strategy -> policy checks -> quote and simulation
  -> plan (journal, reserve) -> sign -> record signed -> broadcast -> receipt -> verify -> report
```

The model or research code never builds transactions. It returns a structured forecast; everything after that is deterministic code with fixed inputs.

## Modes

- `paper` (default): no signer is constructed or called. Fills are simulated at the quoted cost (`quote-at-snapshot-no-impact-v1`).
- `live`: real test-asset transactions. Requires `mode: "live"` in the operator's local configuration and live execution enabled for the agent on Flurbo. A paused agent, a missing or stale policy, or a credential problem blocks new live actions.

## Policies

All amounts are atoms, all times Unix seconds, all comparisons exact integers. The effective limit is the smaller of the local configuration and the agent policy published by Flurbo.

| Policy | Definition |
| --- | --- |
| `markets` | Namespaces the runtime may trade. Others are skipped. |
| `maxQuantityAtoms` | Quantity of one trade. At most 100,000,000. |
| `maxTradeCostAtoms` | Buy limit (`maxCost`) of one trade. |
| `maxSlippageBps` | One of 10, 50, 100. The runtime uses exactly its configured slippage and never widens it to force a fill. |
| `spend.totalAtoms` | Lifetime spend of the journal: confirmed buy cost plus the limit of every buy not yet final. |
| `spend.windows` | List of `{seconds, atoms}`: for each, the same sum restricted to buys with `plannedAt >= now - seconds`. Local and Flurbo windows all apply. |
| `maxPositionAtoms` | Per claim: shares held (read on-chain) plus quantities of unfinished buys. |
| `maxWorstCaseLossAtoms` | Per pool: agent cost basis (confirmed buy cost plus unfinished buy limits) minus the lowest total payout over every Yes/No outcome of the pool's events for all agent claims. VOID payouts lie between outcome payouts, so the bound holds under VOID. |
| `gas.maxFeeWei` | `gasLimit * maxFeePerGas` of one transaction. |
| `gas.reserveWei` | Native balance that must remain after the maximum fee. |
| `quoteMaxAgeSeconds` | `now - quote block timestamp`. |
| `minSecondsBeforeClose` | `closesAt - now` at planning time. |
| `maxPending` | Journal entries not final. |
| `allowSell`, `allowRedeem` | Off unless the operator enables them. |
| `research.maxRequestsPerCycle`, `research.maxRequestsPerHour` | Model and retrieval request budgets. |

In the spend sums, a confirmed buy counts its actual cost, an unfinished buy (`planned`, `signed`, `broadcast`) counts its limit, a `mismatch` counts its limit (its effect is unknown), and other final states count zero. The candidate counts its limit.

Violation codes, reported in this order, each at most once:

| Code | Applies to |
| --- | --- |
| `SERVICE_LIMIT` (quantity 1 to 100,000,000; limit at most 100,000,000; slippage 10, 50 or 100) | buy, sell (slippage and limit), redeem (quantity) |
| `MARKET_NOT_ALLOWED` | all |
| `MARKET_CLOSED` (not open, or `now >= closesAt`) | buy, sell |
| `MARKET_NOT_RESOLVED` | redeem |
| `TOO_CLOSE_TO_CLOSE` (only when not closed) | buy, sell |
| `ACTION_DISABLED` | sell, redeem |
| `HOLDINGS_INSUFFICIENT` (wallet holdings of the claim below the quantity) | sell, redeem |
| `QUANTITY_LIMIT` | all |
| `TRADE_COST_LIMIT` | buy |
| `SLIPPAGE_LIMIT` | buy, sell |
| `QUOTE_STALE` | buy, sell |
| `TOTAL_SPEND_LIMIT`, `WINDOW_SPEND_LIMIT` | buy |
| `POSITION_LIMIT`, `WORST_CASE_LOSS_LIMIT` | buy |
| `GAS_FEE_LIMIT`, `GAS_RESERVE` | all |
| `PENDING_LIMIT` (non-final entries already at `maxPending`) | all |

Positions for `WORST_CASE_LOSS_LIMIT` come from the journal (confirmed buys minus confirmed sells and redemptions, plus unfinished buys and the candidate), so activity the agent did not perform never lowers the measured risk. `POSITION_LIMIT` uses the on-chain holdings of the wallet, which can only raise it.

**Live permission** is separate from the limits: live actions are allowed only when the local mode is `live`, Flurbo reports live execution enabled, the agent is not paused, and the Flurbo policy was read within `policyMaxAgeSeconds` (default 120). Otherwise the reason is `local_paper_mode`, `live_disabled`, `paused` or `policy_stale`, checked in that order.

Policy checks and the spend reservation happen in one step under the journal lock at planning time. Two processes sharing a state directory therefore cannot both pass a limit that only one fits. A violation is recorded with its code and the runtime moves on; it never adjusts the trade to squeeze under a limit.

Fixtures: `fixtures/policy.json`.

## Journal (`flurbo.agent-journal.v1`)

One journal per agent wallet, in the runtime's state directory, written atomically (write a temporary file, flush, rename). A lock file serialises every planning, signing, broadcasting and reconciliation step across processes. A lock older than 30 seconds whose owner process is gone is stale and may be taken over.

Entry states:

| State | Meaning | Final |
| --- | --- | --- |
| `planned` | Intent recorded and spend reserved. Nothing signed. | no |
| `signed` | Signed bytes, hash and nonce recorded. May or may not have reached the network. | no |
| `broadcast` | The RPC accepted it or the chain knows the hash. | no |
| `confirmed` | Receipt status 1 and the expected event verified. | yes |
| `reverted` | Receipt status 0. | yes |
| `mismatch` | Mined, but the receipt does not show the expected effect. | yes |
| `replaced` | Its nonce was used by a different transaction; this hash can no longer be mined. | yes |
| `expired` | Never seen on-chain, its deadline passed, and it will not be sent again. | yes |
| `abandoned` | Planned but never signed, or rejected before signing (simulation, policy, pause). | yes |

Reporting to Flurbo is tracked separately per entry (`pending`, `accepted`, `rejected`) and retried idempotently.

## Nonces

Under the lock: `nonce = max(eth_getTransactionCount(wallet, "pending"), highest nonce among non-final journal entries + 1)`. One state directory per wallet. Two state directories sharing one wallet are not supported.

## Crash and failure recovery

| Crash or failure point | Recovery |
| --- | --- |
| Before signing (`planned`) | Nothing was signed, so mark `abandoned` and release the reservation. A new cycle decides afresh. |
| After signing, before recording | The signature was never recorded, so it was never broadcast. Same as `planned`. |
| After recording `signed`, broadcast unknown (crash or network timeout) | Look up the hash. Found: `broadcast`. Not found and the nonce is used by another transaction: `replaced`. Not found, nonce free, deadline not passed: send the same signed bytes again (same hash, so it cannot duplicate). Not found, deadline passed: `expired`; the next transaction reuses the nonce, which invalidates the old bytes. |
| After broadcast, before the receipt is recorded | Poll the receipt. Missing and the nonce used by another transaction: `replaced`. |
| After the receipt, before reporting | Report again; Flurbo treats a repeated report of the same hash as the same execution. |

Never sign a new transaction for an intent while an earlier transaction for it can still be mined. Never retry with a new transaction after a timeout. Never increase slippage, quantity or spending to force a fill.

A `confirmed` buy or sell requires a `Traded` event from the pool with `trader` equal to the wallet and the expected scope, mask, direction and quantity, and an amount within the limit. A redemption requires `Redeemed`. An approval requires the allowance read back at the receipt block. Otherwise the entry is `mismatch`.

Fixtures: `fixtures/recovery.json`.

## Attribution by Flurbo

The runtime reports each broadcast transaction with its intent. Recording is provisional and claims nothing. A transaction becomes a **verified agent execution** when Flurbo, using its own RPC:

1. finds the transaction and a receipt on chain 10143 with value 0;
2. finds that `from` is the wallet associated with the agent at the transaction's block time;
3. decodes the call against the deployment (pool `buy`, `sell`, `redeem`, or collateral `approve` to the pool) within the service limits, matching the reported intent exactly;
4. finds the expected `Traded` or `Redeemed` event for that wallet; and
5. claims ownership of `(chain, hash)` atomically with the accounting update. The ownership namespace is shared with browser proposals, so a transaction counts once across agents, accounts and flows.

Accounting per agent, from verified executions only: buys (count, cost), sells (count, proceeds), redemptions (count, payout), approvals (count), failed or reverted (count). Gas is reported by the runtime and labelled as reported. Wallet holdings read on-chain are shown as wallet holdings, not as agent performance, because the wallet may have other activity. Forecasts, evidence and abstentions are self-reported and labelled that way.
