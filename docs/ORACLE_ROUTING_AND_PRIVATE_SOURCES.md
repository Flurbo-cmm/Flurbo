# Oracle routing and private-source proof plan

Status: isolated Monad testnet proof of concept, 4 October 2026. The two-question pool, Reality questions, and trusted relay are deployed on the company site. The unified Markets and member notice changes in the current branch are awaiting the user's commit and deployment. No private proof provider or authenticated bridge has been deployed.

## Decision and trust boundary

Keep Flurbo's factored pool and claim contracts. For the new testnet pool, remove the operator-owned reviewer panel entirely. A Reality.eth question uses the Kleros Reality proxy as its arbitrator. The resolver on Monad accepts one final report from a dedicated relay address. There is no second Flurbo vote, challenge period, or assertion bond. Reality's answer is optimistic unless challenged on its own chain; Kleros decides a dispute only when its arbitration path is invoked.

The current relay is **trusted**. It reads Reality on Sepolia and submits a Monad transaction after publishing exact evidence, but the Monad contract cannot verify Sepolia state. The relay key could submit a false YES, NO, or VOID with arbitrary evidence bytes. A finalized Reality answer can settle the new pool through the configured relay worker, subject to its report window and hosting availability. This testnet PoC must never be described as trustless Kleros settlement. Keeping the relay separate from the deployer reduces key reuse but does not remove this authority.

For the optimal integration, give the verified Reality answer final authority on Monad. Prefer a verified, compatible Reality contract and Kleros arbitrator on Monad if available. Otherwise deliver the finalized source-chain result through an authenticated bridge whose Monad receiver checks the source chain, source contract, question ID, content hash, arbitrator, answer, destination pool, event index, nonce, and expiry. A relay signature alone is insufficient. Keep the resolution route fixed when each question is published. Seer's pool contracts are not required.

## Existing pool and capacity

The company pool `0x8c931a6f799d69185ee2f2f47e46667fd0da545b` and resolver `0x349a0d009f163c4c83c5c507b38fe617e726408f` retain their deployed bytecode and current collection entry. This branch does not migrate or upgrade them, change their bot, or change Render configuration. The new `WidePilotPool` and `WidePilotResolver` use `protocolVersion() == 3` and the distinct `flurbo.pilot.trusted-relay.v3` rules domain. The new relay rejects old pools and resolvers. Both pools' questions now appear in the same Markets directory, while each keeps its own settlement route.

The existing public pilot handles two to four base questions. The new factored pool is tested with **32 base questions** and supports bit 31 in its unsigned scope. Each traded claim still references at most three questions. The pricing graph must have induced width at most two and there are at most 64 distinct traded scopes. The joint space of 32 questions has `2^32` assignments, but the pool never enumerates those assignments. Local payout work is bounded by at most eight states per claim. Dense combinations are rejected.

Thirty-two is a tested representation and contract ceiling, not a launch recommendation. Measure worst-case trading gas, funding, settlement gas, and oracle timing before choosing an operating limit; ten may be more practical. Delivery waits for **every** question in a pool, so group questions with similar deadlines. The shared claim encoder and SDK handle 32-bit scopes. V3 questions share the normal Markets list and use their own market detail controls. The existing pool's manifest verification, operator bot, semantic checks, and agent deployment path still accept at most four questions. The new catalog is independent of the old collections registry.

## Reality.eth and Kleros workflow

1. Write a precise Boolean rule. Commit the source, observation time, correction policy, VOID meaning, Reality question ID, content hash, arbitrator, minimum timeout, minimum answer bond, before trading. Choose a public evidence URI before reporting. Verify Reality and Kleros proxy addresses against official deployments before asking the question.
2. Ask the question on Reality with the Kleros proxy selected as arbitrator. After the observable event, an answerer posts an answer and bond. An unchallenged answer becomes final after Reality's timeout. A disputed answer follows the Kleros court and appeal schedule.
3. The relay worker calls `getFinalAnswerIfMatches` at a **finalized Sepolia block**. It accepts only 0 as NO, 1 as YES, and all `ff` as VOID. An unanswered or disputed question, or a mismatch in content, arbitrator, timeout, or bond, cannot be relayed by this tool.
4. The deployment verifier checks the original Reality creation receipt and the live pool. The relay recomputes the event commitment and checks the new Monad pool and resolver versions, rules hash, event hash, relay address, event index, observation time, funded state, pending phase, and report window. It persists the exact evidence bytes at a public URI, then sends `reportFinal` from the dedicated relay wallet. The contract itself checks the relay address and timing, **not** the evidence or Sepolia answer.
5. The relay can report each event once. If no report arrives by `observationEnds + reportPeriod`, the worker or anyone else can call `finalizeMissing` and the event becomes VOID. Once every event is final, the worker or anyone else can call `deliver`; holders redeem on the market page. There is no local panel appeal or replacement report.

Choose `reportPeriod` long enough for Reality's timeout, possible Kleros appeals, source-chain finality, and relay operation. The supported range is one hour to 90 days. A fixed deadline that expires during a court case yields VOID, so do not advertise a deadline shorter than the route can satisfy. Flurbo VOID uses the committed uniform averaging rule; it is neither NO nor a refund of a trade's purchase price.

## Private sources and proof policy

The first keyed API test candidate is [football-data.org](https://docs.football-data.org/general/v4/match.html): `GET /v4/matches/{id}` with `X-Auth-Token`, checking the response ID, `status == FINISHED`, and `score.fullTime.home` or `score.fullTime.away`. Its [free plan](https://www.football-data.org/pricing) delays scores, so this tests correctness rather than fast sports settlement. The first logged-in candidate is a Google Forms creator response view with a fixed form ID and cutoff. The [Forms API](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list) is OAuth gated and paginated; a partial page cannot establish a final count. A browser proof must bind form identity and count together, or we must choose another source.

The isolated `integrations/source-proofs` package has a browser proof request and a zkFetch keyed-API path. Both require a pinned provider and version, cryptographic and TEE attestation checks, exact request and field binding, a fresh session nonce, a proof-time window, and an atomic one-use session store supplied by the caller. The keyed API path keeps its token in private headers. Current tests use mock proofs. No genuine provider has been selected or proven end to end, and no private proof currently settles a pool.

Never put API keys, cookies, OAuth tokens, private responses, or proof-service secrets in a market draft, route JSON, evidence URI, logs, Git, or browser bundle. A TLS proof can show that a named source returned particular bytes under the provider's verification model. It cannot prove that the source data is correct or never edited. Before a private-source market is listed, pin the origin, path, record ID, field, provider and version; validate a real proof; persist sessions and evidence; define correction and exception windows; and connect the accepted proof to a verifiable resolver route. If source content cannot be disclosed to an arbitrator, define a clear VOID policy.

## Rollout and settlement speed

| Stage | Required result | Market effect |
| --- | --- | --- |
| 1. Wide math | 32-event tests and worst-case gas measurement | Separate local or testnet pool |
| 2. Oracle PoC | Verified Reality question and Kleros proxy on Sepolia, final answer, published evidence, trusted relay into a new pool | Label relay authority clearly |
| 3. Website v3 | Shared Markets directory, v3 trading and settlement controls, holder notice index, portfolio and browser regressions | New pool appears with the current pool; unified portfolio remains a follow-up |
| 4. Private proof | Genuine keyed and logged-in provider proofs, durable one-use sessions, privacy review | Private-source questions can be tested |
| 5. Verified delivery | Same-chain answer verification or authenticated source-chain bridge, audits | Removes the trusted relay |

Deterministic public sources can keep direct readers and the existing fast path. Reality adds its answer timeout to ordinary cases; Kleros adds court and appeal time when disputed. Private sources add proof-generation time and availability risk. Flurbo can claim fast settlement for timely deterministic markets, not every question. A wide pool with one slow question delivers only after that question is final or VOID.

## Cost boundary

The relay worker and mock proof tests can run locally without production hosting. Deploying a new Monad pool and reporting consume testnet gas. Asking or answering a Reality question consumes source-chain gas and may require answer bonds or test tokens. A Kleros dispute or appeal can require additional fees. A genuine Reclaim proof may depend on provider availability and quota; a live end-to-end proof cannot be promised free until its current terms are checked. The PoC relay can run locally.

Production costs include source-chain transactions and bonds, Kleros disputes, verified delivery if source and market chains differ, RPC and indexer capacity, proof service usage, evidence storage, and monitoring. None of this requires replacing Flurbo's own market contracts with Seer contracts.

## Deployment and test instructions

See [Reality.eth and Kleros testnet pool runbook](ORACLE_POC_RUNBOOK.md) for the exact operator sequence, question creation, verification, Render variables, and in-site test flow.

## Sources

- [Reality.eth contract integration](https://reality.eth.limo/app/docs/html/contracts.html)
- [Reality.eth deployment files](https://github.com/RealityETH/reality-eth-monorepo/tree/main/packages/contracts/chains/deployments)
- [Kleros Reality integration](https://docs.kleros.io/products/oracle)
- [Reclaim proof request and verification](https://docs.reclaimprotocol.org/manual/js-sdk/usage)
- [Reclaim zkFetch private headers](https://docs.reclaimprotocol.org/zkfetch/usage)
