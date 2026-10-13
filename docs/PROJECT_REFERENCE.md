# Flurbo project reference

This is the 3 October 2026 migration snapshot. For the newer Reality.eth and hybrid testnet deployments, current repository layout, Render variable inventory, and pending work, read [the current handoff](HANDOFF.md).

Snapshot: 3 October 2026. The company site is reported deployed at `flurbopm.singu.online`; this checkout has not independently queried its Render environment. The one-pool isolation changes in this working tree require an operator commit, merge and redeploy before they are live. The company repository starts from personal-repository `main` commit `8443469`; its first company commit is `6d144cc`. The company remote is `Flurbo-cmm/Flurbo`. Treat values described as "reported" as handoff records and verify them in the service dashboards.

The pilot pool generation (`PilotPool` + `PilotResolver`) has since been retired from this repository; the sections below describe the hybrid and oracle pools that replace it.

## Product and boundaries

Flurbo is an invite-only prediction market on Monad testnet (chain 10143) using test AUSD. A hybrid pool has 2 to 32 related binary questions and one trading close; agents trade pools of 2 to 4 questions. Members buy or sell single answers and Boolean combinations in the same funded pool. Mera passkeys provide the Flurbo login. A linked MetaMask wallet signs trades. Member-run agents use their own wallets and agent tokens. The server does not sign agent trades.

The startup product consists of the web client and API, Solidity pools and resolver, market preparation workflow, shared protocol fixtures, the agent SDKs currently coupled to web code, and the Rust pricing reference. The mobile client and privacy lab are parked in the personal hackathon repository. Reality.eth on Sepolia and the Kleros proxy settle hybrid and oracle pools (see Pool types). The MetaMask Agent Wallet plugin is outside this repository. Kuru order-book screens, endpoints, fork tests, and deployment experiments are excluded. The older synthetic-pool dashboard reader still consumes Kuru contract fields from its deployed manifest, so its internal compatibility code remains until that legacy pool is retired or extracted. This does not affect the newer real-event pools.

Do not use real money or describe the trusted Sepolia-to-Monad relay as trustless. All live assets described here are test assets.

## Repository map

| Path | Role |
| --- | --- |
| `apps/web/src` | React and Vite site, passkey login, market and wallet views |
| `apps/web/server` | Node API, access, evidence, hybrid settlement and oracle workers, scheduler, Redis and Supabase routing |
| `config/mobile-passkeys.json` | Public Android association data retained for already installed preview builds; no mobile app is developed here |
| `apps/dashboard` and `scripts` | Legacy synthetic-pool reader and wallet trading compatibility used by the running server |
| `contracts/` (separate pinned checkout) | Factored pools, hybrid and oracle resolvers, test asset and deployment scripts from `Flurbo-cmm/Flurbo-contracts` |
| `config/hybrid-markets.json`, `config/oracle-markets.json` | Registries of hybrid and oracle pools, written by the register scripts after on-chain verification |
| `apps/web/scripts` | Hybrid pool preparation, registration and settlement inspection scripts |
| `workflows/cre` | Synthetic CRE settlement workflow only |
| `apps/web/server/settlement-*.mjs` | Settlement rules and the twelve reader types. Start at [SETTLEMENT_READERS.md](SETTLEMENT_READERS.md) before changing or adding a reader |
| `integrations/source-proofs` | Operator-run prover for credentialed sources (`proof-http.v1`); runs on the operator's machine, never on Render. See [PROOF_READER_RUNBOOK.md](PROOF_READER_RUNBOOK.md) |
| `packages/sdk*` | TypeScript, Python, Rust and C++ member agents |
| `protocol`, `crates/flurbo-core` | Interchange fixtures and Rust reference calculations |
| `.github/workflows/checks.yml` | Code checks; scheduled settlement workflows are excluded |

The web Dockerfile builds from the repository root. It copies the Rust crate, web app, TypeScript SDK, legacy dashboard, Python scripts and config. Keep these inputs together until their runtime imports are replaced. The contracts source is a separate private repository pinned to commit `9f2510eebbfe34f06809e3db5ed9d9010a018eae` for Foundry, settlement preparation and local-chain tests. CI checks it out with the read-only `FLURBO_CONTRACTS_READ_TOKEN` secret; Render's web image does not need it. This is the first two-repository split, with web and settlement tooling still coupled in `Flurbo`.

## Trading and settlement mechanics

Each pool has one cost function over the joint answer space. Let `L(x)` be the pool's liability in answer state `x` and `n` the number of questions. Pools deployed from October 2026 (pool `protocolVersion` 5, `LsPilotPool`) use the liquidity-sensitive LMSR of Othman, Pennock, Reeves and Sandholm: depth is `d(L) = b0 + k * mean_x L(x)` with `k = v / (n ln 2)` for commission `v`, and the cost is `d ln(sum_x exp(L(x)/d))`. This is the paper's `b(q) = alpha sum q` with a uniform seed of `b0 / k` shares per state that nobody owns, so the seed cancels from every quote. The deployer funds `b0 * n * ln(2)` test AUSD, the same as a fixed-depth pool with `b = b0`, and that is the worst-case loss. A protocol 5 pool records the account that deployed it as `sponsor()`. Once trading closes, `withdrawSurplus()` sends the sponsor everything above what the pool still owes: the worst-case liability until settlement, then the unredeemed winning payouts. Anyone may call it and only the sponsor is paid. The hybrid settlement worker calls it from the relay wallet at close and again after settlement. Winning claims never expire. Protocol 3 and older pools have no such function, so whatever they hold beyond payouts stays in them. Prices of any complete set of claims sum to at most `1 + v` before impact. Earlier pools (`protocolVersion` 3, `WidePilotPool`) use a fixed depth: `b ln(sum_x exp(L(x)/b))`. Both evaluate costs without enumerating states: claim tables cover up to 3 questions, variable elimination has induced width at most 2, and every trade checks collateral coverage. A claim spans at most 3 questions, so a wide pool can hold up to 32 questions without enumerating every answer state. Agent pools stay at 2 to 4 questions because protocol v1 claim math is capped there.

A claim is a scope bitmap plus a truth-table mask. It can express YES, NO, AND, OR and other supported Boolean claims. A VOID question gives equal weight to YES and NO in payouts; it is not a refund. A pool pays only after all its questions are final. This makes long-running question clusters slower to pay than short ones. Early redemption requires new contracts.

`HybridPilotResolver` commits each question to one route before trading. There is no operator reviewer panel:

1. The hybrid settlement worker captures a question's committed source inside the rule's observation window. The first complete valid capture is retained, and missing data is never interpreted as No.
2. Reality route (every new pool): the question is asked on Reality.eth on Sepolia with the Kleros proxy as arbitrator. After the window the worker's answerer wallet posts the first bonded answer with public evidence; a contradicting answer is escalated to Kleros by the court keeper. The final answer is reported to Monad by the relay.
3. Mechanical route (the first hybrid test pool): the worker posts a bonded proposal on the Monad resolver. An unchallenged proposal finalizes after its challenge window; a challenge opens a Kleros case on Sepolia and the reported ruling decides the question.
4. Missing or inconclusive data follows the rule's committed VOID policy.
5. Once all questions are final, the result is delivered to the pool and holders may redeem. Bonds are credited for later `withdrawBond()` calls. For a protocol 5 pool the worker then returns the rest of the pool's test AUSD to the deployer.

The reader types are listed in [SETTLEMENT_READERS.md](SETTLEMENT_READERS.md). Rules commit URLs, reader settings, timing and decision thresholds on-chain through a rules hash. The current policy uses official first-line public sources; subjective outcomes take the Reality route. Sports and entertainment were excluded by the old market policy; opening those categories is future product work, not an existing capability.

## Pool types

- Hybrid (served): `WidePilotPool` + `HybridPilotResolver`. Every hybrid pool is listed in the market directory. Pools of 2 to 4 questions are also served to agents and the SDKs as the agent pool `practice-<pool address without 0x>` (protocol v1); a pool whose deployment anchor cannot be read yet stays pending and is retried by the scheduler.
- Oracle (served): `WidePilotPool` + `WidePilotResolver`, answered on Reality.eth and reported to Monad by the trusted relay.
- Legacy pilot pools (`PilotPool` + `PilotResolver`): deployed on chain, not served. Their evidence (`/api/pilot/evidence/<hash>`) and indexes stay in Redis under the `flurbo:pilot:*` keys, which must not be renamed.

## Pool registries and listing

Hybrid pools are listed from `config/hybrid-markets.json` and oracle pools from `config/oracle-markets.json`. The registries hold public manifests only, and the server checks each pool's code, resolver binding and rules hash on chain before serving it. A hybrid pool is drafted with the `create-hybrid-*` scripts, prepared with `apps/web/scripts/prepare-hybrid-pilot.mjs`, deployed by the owner with Foundry, then verified and recorded with `register-hybrid-pool.mjs`; oracle pools use `register-oracle-pool.mjs`. See [the hybrid testnet runbook](HYBRID_TESTNET_RUNBOOK.md). The registry change is reviewed in Git and deployed with the site. Never hand-edit a registry or rerun a broadcast for a pool id that is already registered. The hackathon registry and its Render service are unaffected.

## Runtime, hosting and data

The hackathon site at `https://flurbo.singu.online` is frozen and separate. The company `render.yaml` defines the `flurbopm-testnet` service at `https://flurbopm.singu.online`. The hybrid settlement, arbitration, court and alert workers and the oracle relay and answerer run in-process on their own timers when configured. With `FLURBO_SCHEDULER=true` (legacy alias `FLURBO_SETTLEMENT_BOT=true`, which logs a warning), the scheduler also runs every 2 minutes: it retries agent pools whose deployment anchor could not be read, advances the operator metrics scan, checks funding balances and sends member notices.

`/healthz` reports `scheduler` (repeated under the legacy key `settlement_bot`), `agent_pools`, `hybrid_settlement`, `hybrid_arbitration`, `hybrid_court`, `hybrid_alerts`, `oracle_relay`, `oracle_answerer`, `proof_captures` and the learning pool keys. The handoff reports cron-job.org sending `/healthz` every 10 minutes to keep the free Render service awake; verify that schedule before moving deployments. The old GitHub Actions monitor, worker and Cloudflare alarm are excluded from this company copy.

Upstash Redis holds sessions, agent state, wallet links, settlement journals, evidence, alerts and starter-fund records. Supabase holds access applications and, when `FLURBO_SUPABASE_KV=true`, rebuildable price history, indexes and metrics. The same Supabase project and service key are used for the KV route; migration `004_kv_store.sql` establishes that table. The handoff reports both services on free plans. Render free hours, Upstash commands, Supabase storage, QuickNode credits and Resend email limits need dashboard checks before scaling. The code currently has one-instance in-memory request limits unless `FLURBO_SHARED_LIMITS=true`.

The source on local `main` also contains an Alchemy signed activity webhook and Envio cash-movement proxy. `FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY` authenticates webhook deliveries; `FLURBO_ENVIO_GRAPHQL_URL` points the proxy at its indexer. They were added after the 1 October handbook and are included in this baseline. Whether their corresponding live services are configured needs a dashboard check.

## Research carried forward, with status

The original combinatorial market maker brief supplies the product reason: related questions should share one funded probability model so traders can express knowledge about how events move together. Its proposed 10-question, fully enumerated pool and performance claims are not the deployed implementation. The current code uses bounded-width factored pricing, claims over at most 3 questions and pools of up to 32. Full enumeration and transient-storage gas savings from that brief are research proposals. Depth that grows with volume shipped as the liquidity-sensitive LMSR for protocol 5 pools.

The dispute integration note proposes keeping Flurbo's Monad market contracts and using Reality.eth for questions that need a human answer, with Kleros as an appeal path. That is a useful target for broader market types. Its proposed Gnosis-to-Monad bot relay alone would still require trusting the bot's report on Monad. A production design must specify how the final oracle answer is authenticated on Monad, how mismatched question wording and VOID map to Flurbo outcomes, and who pays cross-chain gas, bonds and appeals. Seer contracts are optional. Existing mechanical readers should remain the fast path for objective, public facts. Hybrid pools now implement this route with a trusted Sepolia-to-Monad relay; authenticated delivery is still open.

The Substreams note proposes a Rust event indexer into Postgres for price charts and portfolio views. Indexing can improve those views, but it cannot create an on-chain trader registry or compute a live executable exit quote by itself. The local `main` already contains an Envio indexer and proxy, so any Substreams work should first compare actual lag, cost and data completeness against that path. The note's claims about exclusive Monad support and necessary scale are unverified here.

The market landscape research favors short objective markets, reviewed reader templates, proof-backed access to sources behind logins, and later liquidity options such as fees or vaults. These are product proposals. The present production baseline remains invite-only, uses official public mechanical sources, and has creator-funded depth, which grows with outstanding shares in protocol 5 pools. Research HTML and personal notes stay outside the company repository; this section records the decisions needed to interpret them.

## Environment inventory

Keep actual secret values in Render or another secret manager, never in Git. The following is an inventory of names from the code and handoff, not a copy of the current Render dashboard. `render.yaml` declares the company origin, network, `FLURBO_SCHEDULER=false` (the dashboard value wins, and a Blueprint sync can overwrite dashboard values) and Upstash placeholders. Before activation, compare this list with Render's current environment and record any missing names securely.

| Group | Names and known non-secret values |
| --- | --- |
| Core | `FLURBO_NETWORK=public_testnet`, `FLURBO_ORIGIN=https://flurbopm.singu.online` for the company service (`https://flurbo.singu.online` on the hackathon service), `PORT` set by Render, `RENDER_GIT_COMMIT`, `FLURBO_ALCHEMY_TESTNET_RPC_URL` secret RPC URL, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Database | `FLURBO_SUPABASE_KV=true` reported, `FLURBO_APPLICATIONS_SUPABASE_URL`, `FLURBO_APPLICATIONS_SUPABASE_SECRET`, `FLURBO_SHARED_LIMITS` unset for one instance |
| Access and mail | `FLURBO_APPLICATIONS_ENABLED`, `FLURBO_APPLICATIONS_CODE_SECRET`, `FLURBO_APPLICATIONS_RESEND_KEY`, `FLURBO_APPLICATIONS_EMAIL_FROM`, `FLURBO_APPLICATIONS_EMAIL_DAILY_LIMIT`, `FLURBO_TESTNET_APPROVED_ACCOUNTS`, `FLURBO_TESTING_OPERATOR_ACCOUNT`, `FLURBO_NOTIFY_ENABLED`, `FLURBO_NOTIFY_DAILY_LIMIT` |
| Wallet funding | `FLURBO_STARTER_PRIVATE_KEY` (new wallet or unset on company site), `FLURBO_COMPANY_STARTER_ADDRESS` (required if the company starter key is set), `FLURBO_STARTER_MON`, `FLURBO_STARTER_DAILY_LIMIT`, `FLURBO_TEST_AUSD_FAUCET`, `FLURBO_ALERT_STARTER_MON`, `FLURBO_ALERT_DISPENSER_AUSD`, `FLURBO_ALERT_EMAIL` |
| Scheduler and settlement | `FLURBO_SCHEDULER` (`true` enables the scheduler; `FLURBO_SETTLEMENT_BOT` is accepted as a legacy alias for one release), every `FLURBO_HYBRID_*` and `FLURBO_ORACLE_*` variable (see [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md) and [ORACLE_POC_RUNBOOK.md](ORACLE_POC_RUNBOOK.md)), `FLURBO_SEPOLIA_RPC_URL`, `FLURBO_SEPOLIA_BEACON_URL` |
| Proof sources | `FLURBO_PROOF_SUBMIT_TOKEN` (Render and the prover machine), `FLURBO_RECLAIM_APP_ID`, `FLURBO_RECLAIM_APP_SECRET` and `FLURBO_PROOF_CREDENTIAL_<LABEL>` (prover machine only, never Render) |
| Monitoring | `FLURBO_MONITOR_RESEND_KEY`, `FLURBO_MONITOR_EMAIL_FROM`, `FLURBO_MONITOR_EMAIL_TO` (hybrid operator alerts), `FLURBO_METRICS_DIGEST`, `FLURBO_METRICS_DIGEST_UTC`, `FLURBO_METRICS_SCAN_STEPS`, `FLURBO_METRICS_EXCLUDE` |
| Optional and integrations | `FLURBO_ENVIO_GRAPHQL_URL`, `FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY`, `FLURBO_SEMANTIC_MODE` (off), `FLURBO_SEMANTIC_RULES_JSON`, `FLURBO_AGENT_RESERVED_WALLETS`, `FLURBO_ANDROID_CERT_SHA256` |

**Removed variables.** No code reads these retired pilot variables any more; remove them from the company Render service once the hybrid-only build is live, and leave the hackathon service alone: `FLURBO_COLLECTIONS_SOURCE`, `FLURBO_PILOT_DISABLED`, `FLURBO_PILOT_MANIFEST_JSON`, `FLURBO_PRACTICE_COLLECTIONS_JSON`, `FLURBO_PRACTICE_ACTIVE_POOL`, `FLURBO_REHEARSAL_MANIFEST_JSON`, `FLURBO_REHEARSAL_PRIVATE_KEY`, `FLURBO_MONITOR_ENABLED`, `FLURBO_MONITOR_HEALTHCHECK_URL`, `FLURBO_READINESS_GAS_BUDGET_WEI`, every `FLURBO_RESOLUTION_*` variable, `FLURBO_DEPLOYER` and the evidence assistant's `FLURBO_EVIDENCE_OPERATOR`, `FLURBO_EVIDENCE_MODEL`, `FLURBO_EVIDENCE_GEMINI_KEY` and `FLURBO_EVIDENCE_FREE_TIER_CONFIRMED`. Delete the pilot settlement signer's private key from the dashboard without copying its value.

## Wallet and origin continuity

Mera is the account login, MetaMask is the member's trading wallet. The site checks that a trading wallet is linked to the account; the contracts themselves remain permissionless. The hybrid settlement, relay and answer wallets are separate and must never trade. The old lost-key signer must never be funded. Member agent private keys stay on members' machines. A test AUSD dispenser and starter MON wallet fund invited members, with daily limits and alerts.

The original hackathon site stays at `flurbo.singu.online`. The company service targets `flurbopm.singu.online` in a separate Render account. Each hostname is its own passkey relying party; existing passkeys do not transfer to the new hostname. The hackathon site's bot and this site's workers stay independent because their registries, signers and Redis state are separate. The company site reuses the testnet deployer and test AUSD token, so their balances and nonce remain shared. See [company testnet runbook](SECOND_SITE_DEPLOYMENT.md).

## Checks and cutover

Run web typecheck, server tests and build; `bun` workflow checks; Foundry tests against the pinned contracts checkout; and the browser suite in the pinned Playwright Docker image. CI in `.github/workflows/checks.yml` records the exact commands and uses Node 24. The mobile job is retired from this company repository. Build the Docker image from the root because the web Dockerfile copies sibling packages.

The personal hackathon repository remains unchanged. This company repository has no Git history from it; that avoids publishing old research, local files or historical secrets. Before a live cutover, review the complete file list and run secret scanning. After the new repo passes checks, deploy the company service separately at `flurbopm.singu.online` and compare account login, wallet linking, market directory, quotes, buy/sell, evidence and redemption. Keep the original Render service and domain online. Verify environment names and values directly in Render using hidden inputs for secrets; the company service starts with settlement automation off.

## Known gaps at this snapshot

- The Sepolia-to-Monad relay is trusted; its key could misreport. Authenticated cross-chain delivery is still open.
- An official source behind a login or an unreadable page needs a new public-verification mechanism or manual assertion. No sports reader exists.
- Long pools pay after their last question. Early redemption needs contract changes.
- Rate limits and free-tier usage were reported in handoff notes, not measured during this migration.
- The legacy synthetic reader still has Kuru-specific compatibility fields. Extract or retire it in a separate change once the real-event path is verified.
- The Android asset-links endpoint remains for already installed mobile previews. The startup web release does not develop or ship the mobile client.
