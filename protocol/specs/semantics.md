# Pre-trade outcome compatibility

Development status: this feature is parked for future integration. The specification alone is not proof of production readiness. See [the project reference](../../docs/PROJECT_REFERENCE.md) for the product status.

This is an off-chain guard for purchases through the Flurbo application and the updated TypeScript, Python, Rust and C++ executors. It does not change existing contracts, prices, resolution or redemption. Direct contract callers and old or modified SDKs can bypass it.

## What is proved

The backend enumerates the pool's Boolean outcomes, evaluates operator-reviewed predicates and projects the selected claim mask onto the admissible outcomes. A claim with no admissible winning ordinary outcome returns `SEMANTIC_COLLISION`. This handles AND, OR, exactly one, at least two and arbitrary supported masks without trusting a client-supplied rule label.

The proof is conditional on correct metadata and ordinary Yes/No resolution. The service does not interpret question text or use an LLM to certify exclusivity. Two predicates are comparable only when their observation identifiers refer to precisely the same instrument, source, time or window, sampling method, unit and rounding rule. An intraday maximum and a closing price must have different identifiers.

VOID payouts are calculated separately using the deployed contract's uniform averaging, without filtering out semantic impossibilities. Therefore an impossible ordinary AND claim can still have a fractional VOID payout. The response does not claim an unconditional loss across every settlement result. Existing resolvers can also deliver answers that contradict the metadata; this guard does not change or constrain resolution.

## Server configuration

`FLURBO_SEMANTIC_RULES_JSON` is public configuration, not a signing secret. Its value is JSON with this shape. The addresses and hash below are placeholders, not a deployment recipe:

```json
{
  "schema": "flurbo.semantic-rules.v1",
  "markets": [{
    "pool": "0x1111111111111111111111111111111111111111",
    "rulesHash": "0x2222222222222222222222222222222222222222222222222222222222222222",
    "predicates": [
      {"event": 0, "observation": "eth:official-close:2027-01-01:usd-cents", "operator": "gte", "value": "300000", "sourceRule": "Exact official closing observation at the time specified in event 0, expressed in integer USD cents."},
      {"event": 1, "observation": "eth:official-close:2027-01-01:usd-cents", "operator": "lt", "value": "250000", "sourceRule": "The identical source, closing timestamp, sampling and integer cents conversion specified in event 1."}
    ]
  }]
}
```

Supported predicates are `lt`, `lte`, `gt`, `gte`, `eq` over integer observation atoms. At most one predicate per event, four per pool, fifty pools. An operator must check each predicate against the published Yes/No rules and document that mapping in `sourceRule`. Unsupported natural-language relations remain unknown. Do not fabricate independent observation identifiers to turn unknown relationships into an apparent clearance.

The pool address and existing rules hash bind the mapping to a deployment. A mismatched hash fails closed. The metadata itself is operator-managed, not committed on-chain. Its SHA-256 digest binds a manual acknowledgment to the mapping reviewed. A server compromise or an incorrect mapping remains a trust risk.

### Modes

`FLURBO_SEMANTIC_MODE` selects one of two modes. Any other value stops the server from starting.

| Mode | Setting | Server behavior | Updated clients |
| --- | --- | --- | --- |
| Disabled (default) | unset, empty or `off` | Never reads `FLURBO_SEMANTIC_RULES_JSON`. Answers every valid request with a claim-bound `mode: "disabled"` assessment. | Proceed without semantic assurance and log `SEMANTICS_DISABLED`. The manual review shows no compatibility claim. |
| Enforced | `enforce` | Evaluates the configured rules. | Apply the checks below. |

Only a fresh, claim-bound answer with `mode: "disabled"` means "switched off". A network failure, an error response, a stale or mismatched answer, a missing `mode` or `configRevision`, or any other mode is `SEMANTICS_UNAVAILABLE` and stops a new purchase. Removing the endpoint is therefore not a way to switch checks off: updated clients stop buying.

Switching to `off` restores availability by withdrawing protection. It is an operational rollback, not a fix. Every assessment carries `configRevision`, a SHA-256 digest of the mode and, when enforced, the rules text. The manual flow asks for a new review if the revision changes between review and wallet confirmation.

### Startup validation and diagnostics

In enforced mode the rules are parsed once at startup. Unreadable JSON, a wrong schema, more than fifty markets or an entry without a valid lowercase pool address stops the deploy. An otherwise invalid or duplicated entry, or one whose `rulesHash` does not match the deployment, makes only that pool unavailable: new purchases there stop until it is fixed, and other markets are unaffected. In disabled mode the rules are ignored, so unused configuration cannot disrupt trading.

The server logs the effective mode, the first twelve characters of the revision and each market's status at startup. The testing operator can read the same report at `GET /api/semantic-status` (`flurbo.semantic-status.v1`): per market `disabled`, `mapped`, `partial`, `unmapped` or `misconfigured` with the reason, plus rules configured for unknown pools.

In enforced mode an empty configuration returns unknown. **There is no built-in mapping for existing public pools in this change. In enforced mode, updated agents abstain on combined purchases until their selected events have reviewed metadata.** Do not copy test fixtures into hosting settings. Single-event purchases may proceed with unknown metadata but receive no semantic assurance. A misconfigured pool blocks purchases there, not selling or redemption.

## Endpoints

Manual: `POST /api/{namespace}/validate-trade`, using the approved Mera account's session and same-origin checks.

Agent: `POST /api/agent-runtime/v1/markets/{namespace}/validate-trade`, using protocol version 1 and a scoped agent credential with `markets:read`. The namespace must be enabled for that agent. Browser calls to the runtime endpoint remain forbidden.

Exact request fields:

```json
{"scope":3,"mask":"8","quantityAtoms":"1000000"}
```

The response schema is `flurbo.semantic-assessment.v1`. Every response includes `mode`, `configRevision`, the pool and rules hash, the exact request and checked/expiry times. An enforced response also includes the mapping digest, coverage, status, Boolean payout matrix, ordinary minimum/maximum payout atoms, maximum VOID payout atoms and predicates. Assessments expire after sixty seconds. These are payout bounds, not executable quotes or probability estimates. The actual purchase cost and fees are determined by the separate quote and transaction.

Status is `collision`, `unknown` or `no_declared_collision`. The last means no contradiction was found under the configured predicates, not a guarantee of feasibility, accuracy or profitability.

## Execution behavior

All four supported live executors check before starting a purchase, including before its allowance approval. They check again immediately before signing a buy, covering custom strategies that use `plan` and `sign`. The response must match deployment, claim, quantity, freshness and the mask-derived payouts.

- `SEMANTIC_COLLISION`: no admissible ordinary winning state. Abort and log; no agent override.
- `SEMANTICS_UNKNOWN`: a combination lacks complete reviewed coverage. Abstain.
- `SEMANTICS_UNAVAILABLE`: endpoint missing, inaccessible, stale or malformed. Abort new purchases.

Reference paper runners use the same guard before recording a fill. Existing sell, redemption and already-signed transaction recovery paths do not require this assessment. Recovery can rebroadcast only the transaction bytes already journaled, using the existing recovery checks. An assessment is not a signing authorization and cannot freeze a wallet outside these runtimes.

The manual review shows the ordinary loss and VOID distinction. A human can acknowledge a known collision by typing the exact displayed phrase. Confirmation stays disabled until then. A fresh check runs before the wallet prompt; a different mapping digest invalidates the acknowledgment. The server accepts no client-supplied predicates. The exception is deliberate user-interface friction, not on-chain enforcement or a server-issued permit. The native app uses the same shared submission check with its own market namespace and shows the same warning and typed acknowledgment. Native builds distributed before this change keep their old behavior.

## Boundaries and next work

This evaluates one claim against the current pool's configured observations. It does not merge external positions, prove an entire multi-pool portfolio profitable, or treat holding two exclusive single claims as intrinsically a guaranteed loss. It also does not yet replace the reference runner's separate pair forecasts with one coherent whole-pool forecast. That global-forecast consistency issue remains distinct from this execution guard.

Deploy the backend/frontend first and update all agent runtimes before relying on the guard. Keep live agents paused during rollout, validate reviewed metadata with paper mode, and inspect explicit abstention reasons. No contract redeployment is required. Public wallet signing, new funded trades, commits and deployment are not part of these local tests.

## Local validation

The implementation was checked with shared semantic fixtures in all four SDKs, backend and manual-review regression tests, and custom execution/signing tests that reject collisions before reaching the signer. Fixtures cover exclusive AND claims, possible OR claims, unknown coverage, stale or mismatched responses and malformed payout matrices.

The web build and SDK typechecks passed. Chrome tests passed for desktop and mobile confirmation flows, including the required acknowledgment. Four local Anvil runtime integration tests passed for autonomous trading and attribution, transaction restart recovery, policy/pause/revocation, and paper mode with concurrent reservations. Local synthetic rule mappings in that harness are not public-market configuration.

The full web suite was not certified by this change. A separate wallet-session browser test still expects portfolio copy that is absent from the current page; its failure was not fixed as part of the semantic guard. Hosted configuration and hosted agent execution remain unverified.
