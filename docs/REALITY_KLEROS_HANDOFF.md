# Reality.eth and Kleros settlement handoff

Written before the pilot pool generation was retired; where it says pilot, read docs/PROJECT_REFERENCE.md.

Written 5 October 2026 for the next maintainer. It covers the work on branch `kleros-reality-eth` that moved hybrid pools to Reality.eth v3 on Sepolia with the official Kleros proxy as arbitrator. Read [HANDOFF.md](HANDOFF.md) first for the overall system, then this file for the change itself. The operating procedure is the "Reality reader pools" section of [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md).

## 1. Status

| Item | State |
| --- | --- |
| Code merged to company `main` | Yes (pull request 17). Contracts test merged to contracts `main`, CI pin updated. The catalog listing commit (`3d28adf`) followed on the same branch |
| Pool `hybrid-reality-1` | Deployed on Monad testnet and listed in `config/hybrid-markets.json`. Delivered unchallenged on 5 October 2026 (Reality best answers Yes and No, no arbitration, resolver `delivered()` true, pool `resolved()` true). It keeps the official Kleros proxy |
| Live end-to-end run (unchallenged question, challenged question with a juror vote, relay, delivery, redemption) | Unchallenged path done on `hybrid-reality-1`. Challenged path pending: it runs on a new pool `hybrid-reality-2` through the proxy copy after the release that adds the subcourt 3 route. Record transaction hashes, the dispute ID and addresses in `secrets/COMPANY_OPERATIONS.md` |
| Web tests | 571 pass, 0 fail, 50 skipped (browser suites and infrastructure-gated tests) |
| Contract tests | 333 pass (`forge test --offline`), including 5 new all-Reality tests |
| Browser tests (`tests/*browser.test.ts`) | Not run in the authoring environment. They need Playwright. Run them once after `npm run build` |
| `hybrid-reader-1` | Unchanged. Already delivered through the unchallenged mechanical path. Its proposer still holds 2 test AUSD of bond credit (`withdrawBond()` from the proposer wallet) |

## 2. Why this changed

The first hybrid pool settled only through the unchallenged mechanical path. Its dispute path used a custom Sepolia adapter (`MechanicalKlerosCase`) with four gaps: no appeal method, no ruling execution, no way to add evidence after the case opened, and no dispute links. The Reality.eth route inside `HybridPilotResolver` had never run end to end. A live bug also shifted every Kleros proxy status by one.

Decisions made by the owner:

1. Every new question settles through Reality.eth v3 on Sepolia with Kleros proxy code as arbitrator. Challenges, evidence, appeals and ruling delivery all use that proxy. `hybrid-reality-1` uses the official proxy. New pools use a Flurbo copy of the same code, deployed through the deterministic factory and bound to subcourt 3 with one juror, because the official proxy sends every dispute to the crowded subcourt 0 where the operator juror is rarely drawn.
2. Flurbo keeps its mechanical readers (`evm-rpc.v1`, `json-api.v1`, `stat-table.v1`, `html-text.v1`). A reader becomes the automatic bonded answerer on Reality.eth, so an unchallenged question settles about one Reality timeout (default 1 hour) after its observation window.
3. Testnet and test assets only. The keeper does everything permissionless on the court. The only manual step is the juror vote, cast by an operator-controlled juror wallet staked with faucet test PNK.
4. No new Solidity. New pools reuse `HybridPilotResolver` and `WidePilotPool` with every route set to Reality. `MechanicalKlerosCase` and `hybrid-arbitration-worker.mjs` remain as legacy code for `hybrid-reader-1`.
5. The Sepolia-to-Monad relay stays trusted.
6. Why not a Gnosis route: Sepolia already has Reality.eth v3, the Kleros v1 proxy and our relay. Kleros cross-chain proxies do not support Monad. Reality.eth exists on Monad mainnet but not on Monad testnet.

## 3. Flow per question

```
trade on Monad -> close -> reader capture window [scheduledAt, publicationCutoff]
-> observationEndsAt (= Reality opening_ts)
-> answerer worker: submitAnswer(question, reader result or VOID, 0) with the minimum bond
-> Reality timeout (3600 s, committed in the question)
   A. nobody contests -> Reality final -> relay reportReality(...) on Monad
   B. a different answer arrives (bond doubles)
        -> keeper: requestArbitration(question, currentBond) if the best answer contradicts the reader
        -> keeper: submitEvidence(question, reader evidence URI)
        -> keeper: executeDelayedSetStakes / passPhase / drawJurors / passPeriod
        -> juror (manual): castVote(disputeId, voteIds, choice, 0)
        -> keeper: passPeriod after the vote, passPeriod after the appeal window
        -> users may fund appeals from the market page
        -> keeper: executeRuling -> proxy status Ruled
        -> keeper: proxy.reportAnswer(...) -> Reality final
        -> keeper: KlerosLiquid.execute(...) for each round, then Reality claimWinnings, then withdraw
        -> relay reportReality on Monad once the question is final at the Sepolia finalized block
-> when every question is final: relay deliver() -> holders redeem on the market page
```

Kleros ruling to Reality answer to Flurbo outcome: ruling 1 gives `0x00..00` (No), ruling 2 gives `0x00..01` (Yes), ruling 0 (refused or tied) gives `0xff..ff` (Void). The relay delivers any final answer other than No or Yes as Void. Proxy status enum: `None=0, Disputed=1, Ruled=2, Reported=3`. A vote period passed with no vote cast ties and produces Void.

## 4. What changed and where

### Server

| File | Change | Key functions |
| --- | --- | --- |
| `apps/web/server/oracle-integration.mjs` | Added the real proxy status enum and extended the court ABI with phase, dispute, vote, `execute`, `courts`, `jurors` and `arbitrationCost`. Holds the supported arbitrators and the pinned proxy code hash | `ARBITRATION_STATUS`, `courtAbi`, `proxyAbi`, `realityAbi`, `HYBRID_ARBITRATORS`, `hybridArbitrator`, `KLEROS_PROXY_CODE_HASH`, `SEPOLIA_KLEROS_LIQUID`, `SEPOLIA_KLEROS_SUBCOURT3` |
| `apps/web/server/hybrid-reality.mjs` | Fixed the status off-by-one. Added court readers and report arguments. Snapshot now returns `court`, `links`, `bestAnswer`. Verifies the proxy code, bindings and seat count. Court snapshot lists rounds, repartitions and the juror's unvoted seats. Claim arguments are shared by the site and the keeper | `hybridRealitySnapshot`, `realityReportArgs`, `realityClaimArgs`, `hybridRealityReportAction`, `klerosCourtSnapshot`, `klerosCourtPhase`, `hybridRealityAppealAction`, `verifyKlerosProxy`, `castVoteCommand`, `REALITY_ANSWERS` |
| `apps/web/server/hybrid-settlement-worker.mjs` | Catalog requires `keeper` and `answerer` for Reality events. Per-event actions. Automatic answerer that also withdraws its Reality credit. Masked errors, isolated per pool and reported as `<id>: <message>`. The relay reads `isFinalized` and the final answer at the Sepolia finalized block. Non-boolean final answers deliver as Void | `hybridSettlementCatalog`, `nextHybridActions`, `planRealityAnswer`, `buildRealityObservation`, `realityAnswerBytes`, `hybridRealityOutcome`, `hybridSettlementWorker` (inner `answer`, `send`, `collect`, `reportReality`, `withdrawRealityCredit`, `tick`) |
| `apps/web/server/hybrid-court-keeper.mjs` (new) | Keeper for arbitration, evidence and court steps. Verifies each proxy once. After finalization it executes every court round, processes Reality bonds once per question and withdraws its own Reality credit. Reports the juror's unvoted seats when `FLURBO_HYBRID_JUROR_ADDRESS` is set | `courtAction`, `hybridCourtKeeper` (inner `afterFinal`, `withdrawCredit`) |
| `apps/web/server/hybrid-market-service.mjs` | Adds `ruleURI` and `automaticAnswer` to snapshots, `command` parameter, `ruleFor` | `hybridMarketService`, `ruleFor` |
| `apps/web/server/local-api.mjs` | Public `GET /api/hybrid/rules/0x<hash>` endpoint. Wider set of validation messages passed to the client | handler near the evidence route, hybrid error regex |
| `apps/web/server/hybrid-notices.mjs` | Reality cases expose `court: { disputeId, status }` | `hybridNoticePools` |
| `apps/web/server/member-notices.mjs` | New `arbitration` and `ruling` notices, mapped to the `challenges` preference | `CONSENT`, `dueStages`, `relevant`, `compose` |
| `apps/web/server/hybrid-operator-alerts.mjs` (new) | Operator emails for hybrid pools: event alerts, worker errors, low balances. Baselines a pool silently on first run. The ACTION vote email carries the juror's ready-to-run `castVote` command | `hybridOperatorAlerts`, `hybridAlertsFor`, `readPoolForAlerts`, `walletBalances` |
| `apps/web/server/production.mjs` | Wires the answerer key, court keeper, operator alerts, the optional `FLURBO_HYBRID_JUROR_ADDRESS`, `/healthz` keys and shutdown | `hybridSettlementWorker(...)`, `hybridCourtKeeper(...)` |

### Scripts

| File | Purpose |
| --- | --- |
| `apps/web/scripts/prepare-hybrid-pilot.mjs` | Reality events accept the official proxy and the subcourt 3 copy as arbitrator. Reality events may carry a `rule`. The rule must match the event, the Reality timeout and the rule URI. The event hash covers rule and source together. Exports `ruleUriPattern`, `realityQuestionText` |
| `apps/web/scripts/create-hybrid-evm-pilot.mjs` | Extracted `evmBlockEvents` so mechanical and Reality templates share rule construction |
| `apps/web/scripts/create-hybrid-reality-pilot.mjs` (new) | Builds the template and the `askQuestionWithMinBond` commands. Optional arbitrator (default the subcourt 3 copy) and title (`createHybridRealityPilot`, `askCommand`) |
| `apps/web/scripts/complete-hybrid-reality-draft.mjs` (new) | Verifies each creation receipt and fills `questionId`, `contentHash`, `questionTxHash` (`completeHybridRealityDraft`) |
| `apps/web/scripts/inspect-reality-question.mjs` | Library function plus the original CLI. Takes the expected arbitrator (`inspectRealityQuestion`) |
| `apps/web/scripts/inspect-kleros-dispute.mjs` (new) | Read-only. Follows the question's own arbitrator, lists the juror's vote IDs and prints the `castVote` command (`klerosDisputeReport`) |
| `apps/web/scripts/inspect-kleros-court.mjs` (new) | Read-only. Checks the proxy code and bindings, then whether the juror is the sole staker of the proxy's subcourt at or above the minimum stake. Exit code 0 when ready (`klerosJurorReadiness`, `sortitionRootSlot`) |
| `apps/web/scripts/register-hybrid-pool.mjs` | Role checks first, then per-question receipt verification, then verification of each Reality arbitrator proxy, then the catalog record with `keeper` and `answerer` (`verifyHybridDeployment`) |

### Frontend

`apps/web/src/pages/HybridMarket.tsx`: Reality timeline (Trading, Source observed, Answer posted, Challenge window, Kleros review, Final on Reality.eth, Reported to Monad, Payouts), Kleros case line with the juror wait notice, Reality and Etherscan links, published rule and reader answer, appeal funding amounts. The "Reality.eth answer bonds" panel hides once the answer history is processed. `OracleMarkets.tsx` and `HybridMarket.tsx` use the corrected status constants. The `court.kleros.io/cases/<id>` link was removed because it opens mainnet cases, not Sepolia.

### Contracts repo (`C:\Users\anany\Flurbo-contracts`)

No source change. `test/HybridPilotLifecycle.t.sol` gained `realityPair()` and five tests: `testAllRealityPoolReportsAndDelivers`, `testRealityReportOutsideWindowRejected`, `testRealityMissingReportBecomesVoid`, `testRealityReportedOnce`, `testRealityReportOnlyByRelay`.

### Catalog and CI

`config/hybrid-markets.json` lists `hybrid-reader-1` (mechanical) and `hybrid-reality-1` (Reality). It is written only by `register-hybrid-pool.mjs`. `.github/workflows/checks.yml` pins the contracts checkout to the merge commit that contains `HybridPilotResolver`.

## 5. Formats and state

Catalog record fields (written by the registration script): `keeper` (required when any event has `route: "reality"`), `answerer` (required when any Reality event has a `rule`), `adapter` and `manager` (only for mechanical events).

Reality event with a rule: `route: "reality"`, `rule` (same shape as mechanical rules, `timing.challengePeriod` equal to the Reality `minTimeout`), and `source` with `kind: "reality-sepolia"`, `reality`, `arbitrator`, `questionId`, `contentHash`, `questionTxHash`, `questionText`, `ruleURI`, `minTimeout`, `minBond`, `openingAt`. `questionText` must equal `realityQuestionText(question, ruleURI)` (separator U+241F). `ruleURI` ends with the rule hash. Event hash for a rule-backed Reality event is `keccak256(canonical({ source, rule }))`. Events without a rule keep the old hash.

Redis keys:

| Key | Content |
| --- | --- |
| `flurbo:hybrid-answer:v1:{questionId}:observation` | Frozen reader result `{ schema, questionId, outcome, answer, evidenceHash, evidenceURI, observedAt }`, written with `SET NX`, never expires |
| `flurbo:hybrid-answer:v1:{questionId}:transaction` | `preparing`, then `{ hash, sentAt }`. A leftover `preparing` means manual review |
| `flurbo:hybrid-court:v1:{questionId}:{disputeId or none}:{action}` | Keeper journal, `preparing` (30 minutes) then the transaction hash (24 hours) |
| `flurbo:hybrid-court:v1:court:passPhase:{lastPhaseChange}` | Global journal for the court phase |
| `flurbo:hybrid-court:v1:{questionId}:{disputeId}:execute-{round}` | Keeper journal for `KlerosLiquid.execute` of one round |
| `flurbo:hybrid-court:v1:{questionId}:claim` | Keeper journal for `Reality.claimWinnings` |
| `flurbo:hybrid-court:v1:withdraw:{keeper}:{balanceWei}` | Keeper journal for `Reality.withdraw` |
| `flurbo:hybrid-answer:v1:withdraw:{answerer}:{balanceWei}` | Settlement worker journal for the answerer's `Reality.withdraw` |

## 6. Configuration

Render variables (names only):

| Variable | Role |
| --- | --- |
| `FLURBO_HYBRID_ANSWER_PRIVATE_KEY` | New Sepolia-only key that posts the first answer. Required once a rule-backed Reality pool is listed. Without it the service fails startup ("Hosting startup failed") |
| `FLURBO_HYBRID_ALERTS_ENABLED` | `true` turns on operator emails for hybrid pools. Uses `FLURBO_MONITOR_EMAIL_TO`, `FLURBO_MONITOR_EMAIL_FROM`, `FLURBO_MONITOR_RESEND_KEY` |
| `FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI` | Optional cap on the arbitration fee the keeper will pay. Default `20000000000000000` |
| `FLURBO_HYBRID_JUROR_ADDRESS` | Optional public juror address. Adds the juror's unvoted seats to `/healthz` and the exact `castVote` command to the ACTION email |
| `FLURBO_HYBRID_SETTLEMENT_ENABLED`, `FLURBO_HYBRID_ARBITRATION_ENABLED` | Must be `true`. The second now also starts the court keeper |
| `FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY` | Also the court keeper key. Its address must equal each Reality pool's `keeper` |
| `FLURBO_HYBRID_PROPOSER_PRIVATE_KEY`, `FLURBO_HYBRID_RELAY_PRIVATE_KEY` | Unchanged. Still required by the resolver configuration |
| `FLURBO_SEPOLIA_RPC_URL` | Private Sepolia HTTPS RPC |

Addresses (Sepolia unless stated): Reality.eth v3 `0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA`, official Kleros proxy `0x05b942faecfb3924970e3a28e0f230910cedff45`, Flurbo copy of the proxy on subcourt 3 `0x9E05da51D17bCd4B796E4505FCEED9135bd99964`, KlerosLiquid court `0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879`, test PNK `0xA1eE4D32bdBcA69cdb445D66fAA3804aFFa24bFE`, PNK faucet `0x776e5853e3d61B2dFB22Bcf872a43bF9A1231e52`, keeper (case manager) `0x771fE7003FA20737C933c39B89386d78cbc36370`, test AUSD on Monad `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`, deployer on both chains `0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391`. Court subcourt 0 and subcourt 3 both use 1 juror, voting period 600 s, evidence 30 s, appeal 600 s, execution after appeal. Subcourt 3 settings: open votes, minimum stake 7,400 PNK, dispute fee 0.02 ETH per juror. The proxy copy's runtime code hash equals the official proxy's (`0x41e678fa0e8ad73d464dbaa431d4b61a3f275f5079d75ed8e24b12ac53e4e5ad`); its `arbitratorExtraData` is `(3, 1)`.

`/healthz` additions: `hybrid_court` (enabled, routes, keeper, `juror`, `cases` with `proxyStatus`, `disputeId`, `period`, `waiting`, `jurorVoteIds`), `hybrid_settlement.answerer`, `hybrid_settlement.answers`.

## 7. Behavior to know before changing it

- Wallet roles: the answerer must differ from creator, proposer and relay. The keeper must differ from the relay. Registration and worker startup both enforce this.
- `nextHybridActions` returns finalize actions first, then propose or reality actions. An event already past its deadline is not also proposed.
- `buildRealityObservation` evaluates at `min(now, observationEndsAt + assertionPeriod - 1)` so a late answerer still reads captures. It only freezes a Void result once the observation window has ended and the publication cutoff has passed.
- The keeper requests arbitration only when a reader observation exists, a bond is posted, no arbitration is pending, Sepolia time is before `finalizesAt - 60`, the best answer differs from the reader answer, the fee is within the cap, and the keeper balance exceeds the fee. It uses Sepolia block time, never the local clock.
- `courtAction` holds the court-step order. In the vote period it waits until the vote is cast or `voteWaitSeconds` (default 24 hours) has passed. Passing without a vote ends in Void.
- Errors are masked. Only messages in each module's `publicErrors` set reach `/healthz`. Add new thrown messages to that set if operators need to see them.
- A Kleros case that outlasts the 90-day report period becomes Void in the resolver.
- A stake placed outside the court's staking phase is queued. Anyone can run `executeDelayedSetStakes` once the phase is 0. The keeper does that only when a dispute exists, so stake the juror before the first challenge.
- The relay reports only when the question is final at the Sepolia `finalized` block (about 13 minutes behind the head), because Reality reverts final-answer reads before that. Any final answer other than No or Yes is delivered as Void.
- The settlement worker and the keeper isolate errors per pool or route and report `<id>: <message>` joined by `; `. One failing pool no longer skips the rest.
- After a ruling the keeper executes each court round (`KlerosLiquid.execute`), which unlocks the juror's PNK and pays the juror fee. It then processes the Reality answer history once per finalized question and withdraws its own Reality credit. The answerer withdraws from the settlement worker. Minimum withdrawal 0.0001 ETH.
- Every proxy is verified once per process against the pinned runtime code hash, the Sepolia Reality address, the KlerosLiquid address and a 64-byte `(subcourt, 1)` extra data.
- The browser tests and `hybrid-reader-1` remain independent of the new route.

## 8. Tests

| File | Covers |
| --- | --- |
| `apps/web/tests/oracle-integration.test.ts`, `hybrid-reality.test.ts` | Status constants, supported arbitrators, Reported refusal, appeal gating, court snapshot and links, proxy verification, juror seats, `castVote` command, claim arguments |
| `apps/web/tests/prepare-hybrid-pilot.test.ts` | Rule-backed Reality events, URI and text checks, committed catalog re-prepares |
| `apps/web/tests/create-hybrid-reality-pilot.test.ts`, `register-hybrid-pool.test.ts`, `hybrid-reality-fixture.ts` | Template, arbitrator and title options, ask commands, receipt verification, registration roles, proxy code and seat verification |
| `apps/web/tests/hybrid-settlement-worker.test.ts`, `hybrid-catalog-fixture.ts` | Catalog rules, per-event actions, answer plan, Void observation, once-only submission across restarts, error masking, Void mapping, finalized-block relay, per-pool isolation, answerer withdrawal |
| `apps/web/tests/hybrid-court-keeper.test.ts`, `inspect-kleros-dispute.test.ts`, `inspect-kleros-court.test.ts` | `courtAction` decisions, arbitration request, evidence once, report, journal duplicates, masked errors, proxy code refusal, round execution, bond claims, withdrawals, juror seats, vote ID listing, juror readiness |
| `apps/web/tests/hybrid-operator-alerts.test.ts`, `member-notices.test.ts` | Alert baseline, once-only sends, ACTION vote alert with the juror command, retries, errors and balances. Member notice recheck and diagnostics |
| `apps/web/tests/hybrid-rule-endpoint.test.ts`, `hybrid-api-errors.test.ts`, `hybrid-market-service.test.ts`, `member-notices.test.ts` | Public rule endpoint, error pass-through, automatic answer in snapshots, notices |
| `apps/web/tests/hybrid-trade-browser.test.ts` | Reality market page, claim hint after a purchase (Playwright, requires `FLURBO_TEST_PLAYWRIGHT` and `FLURBO_TEST_BROWSER`) |
| `apps/web/tests/hybrid-portfolio.test.ts`, `hybrid-portfolio-api.test.ts`, `portfolio-groups.test.ts`, `portfolio-loader-hybrid.test.ts`, `portfolio-history-cache.test.ts`, `hybrid-portfolio-browser.test.ts` | Pool portfolio routes and reads, shared history and payout indexes, portfolio groups and claim links, loader requests, saved activity cache, Portfolio page (Playwright) |
| `test/HybridPilotLifecycle.t.sol` (contracts repo) | All-Reality pool lifecycle |

Commands, from `apps/web`: `npm run typecheck`, `npm test`, `npm run build`. Single file: `node --experimental-strip-types --test tests/<file>.test.ts`. Contracts, with `HOME=$USERPROFILE` and `~/.foundry/bin` on `PATH`: `forge test --offline`.

## 9. Known limits and follow-ups

1. The Sepolia-to-Monad relay is trusted. Authenticated delivery is required before real money.
2. The juror vote is manual on this testnet. Production would rely on the real Kleros juror pool on a chain it supports.
3. The unified Portfolio loads hybrid holdings, history and collected payouts through `/api/hybrid/pool/<pool>/...` (`apps/web/server/hybrid-portfolio.mjs`). Payouts are collected on the hybrid market page. Past activity and collected payouts are also saved in the browser (`portfolio-history-cache.ts`) so the Activity and Collected tabs fill before the verified history reloads.
4. A resolver revision could pause the 90-day deadline while arbitration is pending.
5. Remove `MechanicalKlerosCase` and `hybrid-arbitration-worker.mjs` once nothing needs `hybrid-reader-1`.
6. The Reality.eth question link was checked against a Sepolia question and works. `court.kleros.io` does not show Sepolia cases, so use the Etherscan court events and the case number on the market page.
7. Liquidity items from the owner's reference note are still open: leftover funding return, fees, LS-LMSR, LP vaults.
8. Sole-juror assumption: the proxy copy on subcourt 3 works only while the operator juror is the only staker there. Run `inspect-kleros-court.mjs` before each challenge test.
9. The PNK faucet grants 10,000 PNK once per address. A second juror wallet is needed if the first one cannot be restaked.
10. An absent juror is penalized and unstaked when the round is executed, so its PNK may drop below the 7,400 minimum. Restake or use a new juror wallet before the next test.

## 10. References

Repository documents: [HANDOFF.md](HANDOFF.md), [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md), [SETTLEMENT_ROUTING_V4.md](SETTLEMENT_ROUTING_V4.md), [ORACLE_POC_RUNBOOK.md](ORACLE_POC_RUNBOOK.md), [ORACLE_AUTO_ANSWER.md](ORACLE_AUTO_ANSWER.md), [ORACLE_ROUTING_AND_PRIVATE_SOURCES.md](ORACLE_ROUTING_AND_PRIVATE_SOURCES.md), [PROJECT_REFERENCE.md](PROJECT_REFERENCE.md), [SECOND_SITE_DEPLOYMENT.md](SECOND_SITE_DEPLOYMENT.md).

Contracts repo: `src/HybridPilotResolver.sol`, `src/MechanicalKlerosCase.sol`, `test/HybridPilotLifecycle.t.sol`, `script/DeployHybridPilot.s.sol`.

External: Kleros Reality integration (https://docs.kleros.io/developers/products/reality/integration.md), Kleros v1 arbitrable apps (https://docs.kleros.io/developers/arbitrable-apps/v1-arbitrable-apps.md), KlerosLiquid source (https://raw.githubusercontent.com/kleros/kleros/master/contracts/kleros/KlerosLiquid.sol), Reality.eth monorepo deployments (https://github.com/RealityETH/reality-eth-monorepo/tree/main/packages/contracts/chains/deployments), Kleros deployment addresses (https://docs.kleros.io/reference/contracts/deployment-addresses-v1.md). Verified contract sources for the proxy, court and Reality v3 are on Sourcify for chain 11155111 at the addresses in section 6.
