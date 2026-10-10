# Settlement routing and mechanical reader plan

Status update, 5 October 2026: every new question now commits to Reality.eth v3 on Sepolia with the official Kleros proxy as its arbitrator. A mechanical reader no longer posts to the Flurbo optimistic resolver. It acts as the automatic bonded answerer on Reality.eth, so an unchallenged question settles about one Reality timeout after its observation window. A keeper escalates a contradicting answer to Kleros and drives the court through every permissionless step. Only the juror vote is manual on this testnet. The Sepolia-to-Monad relay stays trusted. `MechanicalKlerosCase` and its worker remain as legacy code for `hybrid-reader-1`. The runbook section "Reality reader pools" in [the hybrid runbook](HYBRID_TESTNET_RUNBOOK.md) has the procedure. New pools arbitrate through a Flurbo copy of the Kleros proxy bound to subcourt 3 so the operator juror is drawn.

Status update, 5 October 2026: the first hybrid mechanical test pool and Sepolia Kleros adapter have been deployed. The broader reader families and authenticated bridge below remain a plan. See [the current handoff](HANDOFF.md) for the actual contracts, worker settings, and open verification. The existing activity and earlier Reality pools retain their contracts and rules.

## Decision

Flurbo keeps its own market, pricing, share, and payout contracts. Every question commits to one resolution route before trading. New questions commit to Reality.eth with Kleros as the Reality arbitrator. Objective questions carry a published rule, and a mechanical reader posts the first bonded answer automatically. Questions that require human interpretation need a human answerer. A challenge goes to Kleros through the proxy, with evidence, appeal funding and ruling delivery on Sepolia. The earlier mechanical route with a Flurbo optimistic resolver and the `MechanicalKlerosCase` adapter is legacy and is used only by `hybrid-reader-1`. A question does not switch routes after trading begins.

“Contested” describes what happens after a proposal is challenged. It is not a source type. A sports score can be contested because the reader selected the wrong match; it remains a mechanical-source question and goes to Kleros with its source evidence. A subjective question needs a named answerer or an open answer incentive on Reality.eth. Reality.eth does not produce an answer automatically.

## Common question contract

Before a pool is funded, commit the exact question, answer mapping, source authority and version, event identity, observation and publication times, chain finality or correction window, extraction rule, evidence format, missing-data and VOID policy, challenge period, bond and arbitration-fee policy, Kleros route, and a maximum report period. These fields must be included in the on-chain rules commitment and exposed in the market UI. Do not publish a question whose source cannot be identified and tested before trading.

The evidence record must bind the pool, event index, rule hash, source identity, request, response or proof hash, observation timestamp, reader version, normalized value, decision, and transaction or content location. Do not publish API keys, cookies, tokens, or private responses. Evidence must be retrievable long enough for challengers and arbitrators to inspect it.

## Settlement state machine

| Route | Normal path | Challenge path | Missing or inconclusive answer |
| --- | --- | --- | --- |
| Mechanical | Reader observes final source, stores evidence, bot posts provisional YES/NO/VOID to the new Monad resolver, challenge timer runs, bot finalizes and delivers | User submits bond, fee, and evidence in Flurbo; resolver freezes the result and opens a Kleros case; final ruling returns through a verified route and the bot delivers | Retry until the committed cutoff, then apply the published VOID or pause rule; never guess |
| Human interpretation | Reality question is created with Kleros arbitrator; an answerer posts a bond; Reality answer becomes final after its timeout; result is delivered to Monad | User challenges in Flurbo; the transaction invokes the Reality/Kleros arbitration route; ruling determines the Reality answer before delivery | No bonded answer by the committed deadline means the published VOID or cancellation rule, subject to the pool contract |

The website should use the existing Markets layout for both routes. Show answer, bond, evidence, and challenge controls only in the relevant phase. Email notices should use the same closing, observation, proposal, challenge, final, and payout events as other markets.

Automatic means source polling, evidence capture, provisional posting, timer checks, Reality question creation, notices, finalization, final-result delivery, and payout activation can run without an operator. A human interpretation answer still needs a bonded answerer, and Kleros disputes need jurors. Keepers must be idempotent and recover after restarts. Missed keeper runs must not change the published outcome rule.

The in-site Challenge action must explicitly request Kleros arbitration and collect the required fee. Reality also permits counteranswers with larger bonds; a counteranswer alone does not guarantee a Kleros case. Challenges are allowed only during the committed challenge window. An active court case needs its own long deadline and appeal policy; it must not be silently converted to VOID by the ordinary short report timer.

## Reader families

The reference for every reader type, its rule settings, the authoring workflow and the rules for changing readers is [SETTLEMENT_READERS.md](SETTLEMENT_READERS.md). This table records which families are implemented.

| Family | First implementation | Required checks |
| --- | --- | --- |
| Official sports | One league-specific official fixture/results feed before expanding sport by sport | Competition, season, fixture ID, final status, score type, postponement, correction policy |
| Elections and statistics | Named election authority or statistical series; extend the existing CSV, SDMX, JSON-stat, and JSON readers | Jurisdiction, election/series ID, certified versus provisional value, release vintage and revisions |
| On-chain quantities | Extend existing EVM RPC reader by chain configuration; add separate Bitcoin and Solana adapters later | Chain ID/genesis, block hash, finality, reorg handling, token address/decimals, exact observation block |
| PDF-only public results | Implemented as `pdf-text.v1`: the raw PDF is kept with its hash, page text is extracted by the pinned `pdfjs-dist@6.3.289` and extracted again from the raw bytes before any evidence is archived. Text layer only, no OCR | Issuer, edition, page range, required anchors, one exact match, amended documents; a scanned document without a text layer is rejected |
| JavaScript-only public pages | Prefer the page's official data request, read with `json-api.v2` (or `proof-http.v1` when it needs a credential); use a browser capture only when necessary | Origin, rendered page identity, network response or DOM snapshot, capture timestamp, stable selector |
| Login or keyed data | Implemented as `proof-http.v1`: a Reclaim HTTPS proof made by an operator-run prover, verified offline against attestor addresses pinned in the rule | Origin/path/record/field, pinned attestors and minimum signatures, committed request, rule-bound proof context, finality check, credential secrecy, evidence that anyone can re-verify without the credential |
| Public JSON with a POST body, derived values or time filters | Implemented as `json-api.v2`: GraphQL or other POST queries, the difference or sum of two selections, counts over time windows, RFC 2822 dates | Query is read-only, exact decimals, window bounds, record identity checks |
| RSS, Atom and XML feeds | Implemented as `xml-feed.v1`: pinned `fast-xml-parser@5.11.1`, then the same selection, filter and count rules as `json-api.v2` | No DOCTYPE or entities, feed identity checks, publication-time filters |

There is no single reliable reader for every sport, chain, PDF, JavaScript site, or private provider. Each family needs source-specific configurations and fixtures. “All known chains” is an expansion target, not a claim supported by one EVM RPC implementation. When a source cannot be verified reproducibly, the market should not be listed as automatic.

Still not implemented: Bitcoin and Solana readers (they need header-chain or slot-finality verification), pages that only render with JavaScript and have no usable data request (no headless browser reader exists), and multi-source medians. Subjective questions stay on the Reality route with a human answer. Each new reader is a new rule shape with its own adapter name, so no deployed rule or contract changed; the eight earlier readers are frozen and a test pins the hashes of every deployed rule. See [PROOF_READER_RUNBOOK.md](PROOF_READER_RUNBOOK.md) for the credentialed path.

## New resolver and Kleros integration

The current `PilotResolver` has an operator reviewer panel. The current `WidePilotResolver` accepts an immediate final report from a trusted relay and has no Monad challenge period. Neither deployed resolver can acquire the new challenge behavior in place. Deploy a new version for new pools, reusing Flurbo's pool and share model. Preserve the existing activity pool and Reality pool until they finish under their published rules.

For mechanical markets, the new resolver must support `Pending -> Proposed -> Finalized` or `Pending -> Proposed -> Disputed -> Finalized`, enforce bonds and challenge deadlines, bind evidence and case IDs, and accept exactly one final Kleros ruling. It must not include the operator 2-of-3 vote. If the selected Kleros arbitrator is not on Monad, a cross-chain route is necessary. A trusted relay is acceptable for a labelled testnet proof of concept; production delivery must authenticate source-chain state and bind case, result, destination, nonce, and expiry. A signer-controlled report alone remains a trusted oracle.

For subjective markets, Reality's arbitrator handles Kleros disputes on the Reality chain. The existing testnet relay reports final answers to Monad, but its key can misreport. Replace it with same-chain verification or authenticated cross-chain delivery before describing settlement as trustless. The Flurbo UI may initiate answer and challenge transactions without sending the user to a separate site; wallets may still need to switch to the arbitration chain and hold its gas and bond token.

## Timing and pool composition

The provisional mechanical answer can appear as soon as the official source is final and available. Claimable payout begins only after the challenge window, source finality, and every question in the shared pool has finalized. A Kleros dispute follows its court and appeal schedule and can be much slower. Reality questions also wait for a bonded answer and the Reality timeout. Group questions with similar expected resolution times so one slow question does not hold every payout in a pool.

## Build order

1. Specify the common question, evidence, and reader result interfaces. Add a new isolated mechanical test pool using the existing EVM reader and a new optimistic resolver with a Kleros dispute route. Leave both deployed pools unchanged.
2. Prove one full challenged and one unchallenged path from the Flurbo UI through Kleros ruling or timer expiry to payout. Verify retries, missed worker cycles, VOID, and evidence integrity.
3. Add one official sports result and one election/statistical release source, then PDF and JavaScript capture. Only enable each source after real-source fixtures, correction handling, and end-to-end tests.
4. Add a genuine keyed API proof and a genuine logged-in proof, each with a pinned provider, nonce, and field. Test an arbitrator-readable evidence policy before listing private-source markets.
5. Expand on-chain support chain by chain. Move trusted cross-chain reports to authenticated delivery and measure gas, proof cost, finality, challenge frequency, and payout latency.

The first milestone is a new objective-source pool with both automatic unchallenged payout and an in-site Kleros challenge. That validates the shared settlement architecture before multiplying reader types.
