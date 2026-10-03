# Canonical claims (`flurbo.claim.v1`)

A claim is a Boolean payout condition over one to three events of one pool. It is identified by `(chainId, pool, scope, mask)`. The pool contract is authoritative for prices; this document only fixes how intent is encoded.

## Pool and events

- A pool has 2 to 4 events, indexed from 0 in the order the deployment lists them.
- Claims from different pools never combine. A request that mixes pools is rejected (`cross_pool`).

## Scope

- `scope` is an integer bitset over the pool's events: bit `i` set means event `i` is part of the claim.
- Valid scopes select 1 to 3 events and satisfy `0 < scope < 2^eventCount`.

## Mask

- The selected events are numbered locally in ascending event index: local bit `j` is the answer of the `j`-th selected event (1 = Yes, 0 = No). A local state is the integer formed by those bits.
- `mask` is a bitset over local states: bit `s` set means the claim pays in local state `s`. It is a decimal integer string.
- Valid masks satisfy `1 <= mask < 2^(2^k) - 1` where `k` is the number of selected events. A mask that pays in every state is invalid; a mask that never pays is invalid.
- This matches `PilotPool.project` and `FactoredPositions.key`.

## Named rules

Given answers `(event_i, yes_i)` sorted by event index, a local state wins when the count `c` of legs whose answer matches satisfies:

| Rule | Condition | Legs |
| --- | --- | --- |
| `AND` | `c == legs` | 1 to 3 |
| `OR` | `c >= 1` | 1 to 3 |
| `EXACTLY_ONE` | `c == 1` | 1 to 3 |
| `AT_LEAST_TWO` | `c >= 2` | 2 to 3 |

A single answer is `AND` over one leg. Duplicate events, events outside the pool and more than three legs are rejected.

Decoding a claim returns a named rule only when one encodes to exactly the same mask, searching rules in the order `AND`, `OR`, `EXACTLY_ONE`, `AT_LEAST_TWO` and states from highest to lowest. Masks are never rewritten to fit a name; a valid mask with no name is reported as `OTHER`.

## Stable identity

`claimKey = "{chainId}:{pool lowercase}:{scope}:{mask}"`, for example `10143:0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02:3:8`.

## Payout after resolution

With `yesMask` (events resolved Yes) and `voidMask` (events resolved VOID), the contract enumerates every full state consistent with the known answers, with VOID events free. The payout fraction is `numerator / denominator` where `denominator` is the number of consistent states and `numerator` the number of those in which the claim pays. VOID is not No. Redemption pays `floor(quantity * numerator / denominator)`.

Fixtures: `fixtures/claims.json`.
