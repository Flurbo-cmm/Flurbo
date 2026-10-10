# Flurbo project reference

This is the 3 October 2026 migration snapshot. For the newer Reality.eth and hybrid testnet deployments, current repository layout, Render variable inventory, and pending work, read [the current handoff](HANDOFF.md).

Snapshot: 3 October 2026. The company site is reported deployed at `flurbopm.singu.online`; this checkout has not independently queried its Render environment. The one-pool isolation changes in this working tree require an operator commit, merge and redeploy before they are live. The company repository starts from personal-repository `main` commit `8443469`; its first company commit is `6d144cc`. The company remote is `Flurbo-cmm/Flurbo`. Treat values described as "reported" as handoff records and verify them in the service dashboards.

Public `/healthz` reads on 3 October showed the company site still exposing the old pilot plus six copied pools with its bot disabled; the hackathon site exposed the same pool set and reported its own monitor healthy with its bot enabled. These are liveness snapshots, not on-chain settlement verification. The company-only code below has not been deployed yet.

## Product and boundaries

Flurbo is an invite-only prediction market on Monad testnet (chain 10143) using test AUSD. A market pool has 2 to 4 related binary questions and one trading close. Members buy or sell single answers and Boolean combinations in the same funded pool. Mera passkeys provide the Flurbo login. A linked MetaMask wallet signs trades. Member-run agents use their own wallets and agent tokens. The server does not sign agent trades.

The startup product consists of the web client and API, Solidity pools and resolver, market preparation workflow, shared protocol fixtures, the agent SDKs currently coupled to web code, and the Rust pricing reference. The mobile client and privacy lab are parked in the personal hackathon repository. Reality.eth and Kleros are future settlement integrations; neither is part of this baseline. The MetaMask Agent Wallet plugin is outside this repository. Kuru order-book screens, endpoints, fork tests, and deployment experiments are excluded. The older synthetic-pool dashboard reader still consumes Kuru contract fields from its deployed manifest, so its internal compatibility code remains until that legacy pool is retired or extracted. This does not affect the newer real-event pools.

Do not use real money or represent the current reviewer panel as independent arbitration. All live assets described here are test assets.

## Repository map

| Path | Role |
| --- | --- |
| `apps/web/src` | React and Vite site, passkey login, market and wallet views |
| `apps/web/server` | Node API, access, evidence, monitor, settlement worker, Redis and Supabase routing |
| `config/mobile-passkeys.json` | Public Android association data retained for already installed preview builds; no mobile app is developed here |
| `apps/dashboard` and `scripts` | Legacy synthetic-pool reader and wallet trading compatibility used by the running server |
| `contracts/` (separate pinned checkout) | Factored pool, optimistic resolver, test asset and deployment scripts from `Flurbo-cmm/Flurbo-contracts` |
| `config/collections.json` | Committed list of pools and their settlement modes |
| `config/markets` | Batch market specifications |
| `workflows/cre` | Rule preparation, checks, deployment verification, registry edits |
| `integrations/source-proofs` | Operator-run prover for credentialed sources (`proof-http.v1`); runs on the operator's machine, never on Render. See [PROOF_READER_RUNBOOK.md](PROOF_READER_RUNBOOK.md) |
| `packages/sdk*` | TypeScript, Python, Rust and C++ member agents |
| `protocol`, `crates/flurbo-core` | Interchange fixtures and Rust reference calculations |
| `.github/workflows/checks.yml` | Code checks; scheduled settlement workflows are excluded |

The web Dockerfile builds from the repository root. It copies the Rust crate, web app, TypeScript SDK, legacy dashboard, Python scripts and config. Keep these inputs together until their runtime imports are replaced. The contracts source is a separate private repository pinned to commit `9f2510eebbfe34f06809e3db5ed9d9010a018eae` for Foundry, settlement preparation and local-chain tests. CI checks it out with the read-only `FLURBO_CONTRACTS_READ_TOKEN` secret; Render's web image does not need it. This is the first two-repository split, with web and settlement tooling still coupled in `Flurbo`.

## Trading and settlement mechanics

Each pool has one LMSR cost function over the joint answer space. If `q_x` is liability in answer state `x` and `b` is depth, `C(q) = b ln(sum_x exp(q_x/b))`. The deployer funds at least `b * n * ln(2)` test AUSD for `n` questions. That is the upper bound on the maker's starting subsidy. The on-chain factored engine avoids full enumeration when quoting: claim tables cover up to 3 questions, variable elimination has induced width at most 2, and every trade checks collateral coverage. The pilot settlement and VOID payout code still enumerates all `2^n` answer states, which is why deployed pools are limited to 4 questions.

A claim is a scope bitmap plus a truth-table mask. It can express YES, NO, AND, OR and other supported Boolean claims. A VOID question gives equal weight to YES and NO in payouts; it is not a refund. A pool pays only after all its questions are final. This makes long-running question clusters slower to pay than short ones. Early redemption and more questions per pool require new contracts.

The current `PilotResolver` is optimistic and operator governed:

1. A source reading is captured inside its rule's observation window. The first complete valid capture is retained. Missing data is never interpreted as No.
2. Once the window closes, an asserter posts an answer, public evidence and a 1 test AUSD bond.
3. A different eligible wallet can dispute during the challenge period with the same bond and its evidence.
4. If disputed, three operator-controlled reviewers vote; two matching votes decide. Without quorum, the question becomes VOID.
5. An unchallenged assertion finalizes after its challenge period. If there is no assertion by the deadline, the question becomes VOID.
6. Once all questions are final, the results are delivered to the pool and holders may redeem. Bonds are credited for later `withdrawBond()` calls.

Four general readers exist: `json-api.v1`, `stat-table.v1`, `html-text.v1`, and `evm-rpc.v1`. Rules commit URLs, reader settings, timing and decision thresholds on-chain through a rules hash. The current policy uses official first-line public sources. Login-gated data, PDFs, images, JavaScript-only pages and subjective outcomes have no automatic reader in this baseline. Sports and entertainment were excluded by the old market policy; opening those categories is future product work, not an existing capability.

## Pool registry and listing workflow

`config/collections.json` is the site, monitor and worker's pool list when `FLURBO_COLLECTIONS_SOURCE=registry`. An entry can be `auto`, `finish-only`, or `off`; its `status` controls whether it is listed. The registry stores public manifests only. It rechecks each pool's code, resolver binding and rules hash on chain before use. Automatic pools with bonds above 10 test AUSD are rejected.

The operator writes a batch file in `config/markets`, runs `bun workflows/cre/scripts/batch.ts prepare --spec <file> --selection <public-wallet-file>`, then `check --ids <ids>`. The check validates rule readiness, deadlines, funding and duplicate deployments. The operator deploys with the encrypted Foundry keystore, then runs `verify --ids <ids>` and `register --ids <ids>`. The registry change is reviewed in Git and deployed with the site. Listing a pool does not require a Render variable edit in registry mode. The company smoke release is fixed to one pool and two markets; see [company testnet runbook](SECOND_SITE_DEPLOYMENT.md).

The pre-isolation company registry copied the hackathon pools, including historical Jobs Friday, Crypto weekend and Brazil election markets. This working tree replaces it with an empty company registry and `pilotSettlement: "off"`; no company pool is listed until its new deployment is verified and registered. The hackathon registry and its Render service are unaffected.

## Runtime, hosting and data

The reported hackathon origin is `https://flurbo.singu.online` on one free Render Docker web service. With `FLURBO_SETTLEMENT_BOT=true`, that original service runs the monitor and worker alongside the site and API. The company `render.yaml` defines a separate `flurbopm-testnet` service at `https://flurbopm.singu.online`; its bot starts disabled and can later settle only its one registered pool with a new signer. The monitor and worker normally run every 10 minutes, then every 2 minutes near deadlines. Each signer has one pending transaction at a time; signed bytes are journaled in its separate Redis database before broadcast. The worker handles up to 12 transactions per cycle.

The handoff reports cron-job.org sending `/healthz` every 10 minutes to keep the free Render service awake, and Healthchecks.io watching the bot. Verify those accounts and schedules before moving deployments. The old GitHub Actions monitor, worker and Cloudflare alarm are excluded from this company copy. Render is the sole scheduler in this baseline.

Upstash Redis holds sessions, agent state, wallet links, settlement journals, evidence, alerts and starter-fund records. Supabase holds access applications and, when `FLURBO_SUPABASE_KV=true`, rebuildable price history, indexes and metrics. The same Supabase project and service key are used for the KV route; migration `004_kv_store.sql` establishes that table. The handoff reports both services on free plans. Render free hours, Upstash commands, Supabase storage, QuickNode credits and Resend email limits need dashboard checks before scaling. The code currently has one-instance in-memory request limits unless `FLURBO_SHARED_LIMITS=true`.

The source on local `main` also contains an Alchemy signed activity webhook and Envio cash-movement proxy. `FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY` authenticates webhook deliveries; `FLURBO_ENVIO_GRAPHQL_URL` points the proxy at its indexer. They were added after the 1 October handbook and are included in this baseline. Whether their corresponding live services are configured needs a dashboard check.

## Research carried forward, with status

The original combinatorial market maker brief supplies the product reason: related questions should share one funded probability model so traders can express knowledge about how events move together. Its proposed 10-question, fully enumerated pool and performance claims are not the deployed implementation. The current code uses bounded-width factored pricing and a 4-question pilot cap. Full enumeration, transient-storage gas savings, and automatic depth scaling from that brief should be treated as research proposals, not shipped features.

The dispute integration note proposes keeping Flurbo's Monad market contracts and using Reality.eth for questions that need a human answer, with Kleros as an appeal path. That is a useful target for broader market types. Its proposed Gnosis-to-Monad bot relay alone would still require trusting the bot's report on Monad. A production design must specify how the final oracle answer is authenticated on Monad, how mismatched question wording and VOID map to Flurbo outcomes, and who pays cross-chain gas, bonds and appeals. Seer contracts are optional. Existing mechanical readers should remain the fast path for objective, public facts. This design is not implemented in the baseline.

The Substreams note proposes a Rust event indexer into Postgres for price charts and portfolio views. Indexing can improve those views, but it cannot create an on-chain trader registry or compute a live executable exit quote by itself. The local `main` already contains an Envio indexer and proxy, so any Substreams work should first compare actual lag, cost and data completeness against that path. The note's claims about exclusive Monad support and necessary scale are unverified here.

The market landscape research favors short objective markets, reviewed reader templates, proof-backed access to sources behind logins, and later liquidity options such as fees or vaults. These are product proposals. The present production baseline remains invite-only, uses official public mechanical sources, and has fixed creator-funded depth. Research HTML and personal notes stay outside the company repository; this section records the decisions needed to interpret them.

## Environment inventory

Keep actual secret values in Render or another secret manager, never in Git. The following is an inventory of names from the code and handoff, not a copy of the current Render dashboard. `render.yaml` declares the company origin, network, registry mode, disabled legacy pilot, disabled bot and Upstash placeholders. Before activation, compare this list with Render's current environment and record any missing names securely.

| Group | Names and known non-secret values |
| --- | --- |
| Core | `FLURBO_NETWORK=public_testnet`, `FLURBO_ORIGIN=https://flurbopm.singu.online` for the company service (`https://flurbo.singu.online` on the hackathon service), `PORT` set by Render, `RENDER_GIT_COMMIT`, `FLURBO_ALCHEMY_TESTNET_RPC_URL` secret RPC URL, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Database | `FLURBO_SUPABASE_KV=true` reported, `FLURBO_APPLICATIONS_SUPABASE_URL`, `FLURBO_APPLICATIONS_SUPABASE_SECRET`, `FLURBO_SHARED_LIMITS` unset for one instance |
| Access and mail | `FLURBO_APPLICATIONS_ENABLED`, `FLURBO_APPLICATIONS_CODE_SECRET`, `FLURBO_APPLICATIONS_RESEND_KEY`, `FLURBO_APPLICATIONS_EMAIL_FROM`, `FLURBO_APPLICATIONS_EMAIL_DAILY_LIMIT`, `FLURBO_TESTNET_APPROVED_ACCOUNTS`, `FLURBO_TESTING_OPERATOR_ACCOUNT`, `FLURBO_NOTIFY_ENABLED`, `FLURBO_NOTIFY_DAILY_LIMIT` |
| Wallet funding | `FLURBO_STARTER_PRIVATE_KEY` (new wallet or unset on company site), `FLURBO_COMPANY_STARTER_ADDRESS` (required if the company starter key is set), `FLURBO_STARTER_MON`, `FLURBO_STARTER_DAILY_LIMIT`, `FLURBO_TEST_AUSD_FAUCET`, `FLURBO_ALERT_STARTER_MON`, `FLURBO_ALERT_DISPENSER_AUSD`, `FLURBO_ALERT_EMAIL` |
| Settlement | `FLURBO_SETTLEMENT_BOT=false` until the one company pool is live, `FLURBO_COLLECTIONS_SOURCE=registry`, `FLURBO_PILOT_DISABLED=true`, then `FLURBO_MONITOR_ENABLED=true`, `FLURBO_RESOLUTION_ENABLED=true`, `FLURBO_RESOLUTION_PROPOSALS=true`, `FLURBO_RESOLUTION_EXECUTE=true` after observation-only dry run, new `FLURBO_RESOLUTION_SIGNER_ADDRESS`, new `FLURBO_RESOLUTION_PRIVATE_KEY`, `FLURBO_RESOLUTION_EVIDENCE_ORIGIN=https://flurbopm.singu.online`, `FLURBO_RESOLUTION_HOLD` optional |
| Proof sources | `FLURBO_PROOF_SUBMIT_TOKEN` (Render and the prover machine), `FLURBO_RECLAIM_APP_ID`, `FLURBO_RECLAIM_APP_SECRET` and `FLURBO_PROOF_CREDENTIAL_<LABEL>` (prover machine only, never Render) |
| Monitoring | `FLURBO_MONITOR_RESEND_KEY`, `FLURBO_MONITOR_EMAIL_FROM`, `FLURBO_MONITOR_EMAIL_TO`, `FLURBO_MONITOR_HEALTHCHECK_URL`, `FLURBO_METRICS_DIGEST`, `FLURBO_METRICS_DIGEST_UTC`, `FLURBO_METRICS_SCAN_STEPS`, `FLURBO_METRICS_EXCLUDE` |
| Optional and integrations | `FLURBO_ENVIO_GRAPHQL_URL`, `FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY`, `FLURBO_EVIDENCE_GEMINI_KEY`, `FLURBO_EVIDENCE_MODEL`, `FLURBO_EVIDENCE_FREE_TIER_CONFIRMED`, `FLURBO_EVIDENCE_OPERATOR`, `FLURBO_SEMANTIC_MODE` (off), `FLURBO_SEMANTIC_RULES_JSON`, `FLURBO_AGENT_RESERVED_WALLETS`, `FLURBO_ANDROID_CERT_SHA256` |

The old registry-bundle variables `FLURBO_PRACTICE_COLLECTIONS_JSON`, `FLURBO_PRACTICE_ACTIVE_POOL`, `FLURBO_RESOLUTION_POOL`, `FLURBO_RESOLUTION_RULES_HASH`, `FLURBO_RESOLUTION_MANIFEST_JSON`, `FLURBO_RESOLUTION_FINISH_ALLOWLIST`, `FLURBO_RESOLUTION_COLLECTIONS_JSON` and `FLURBO_RESOLUTION_SOURCE_MODE` are not used by the company registry path. Remove copied values from the company Render service; leave the hackathon service alone.

## Wallet and origin continuity

Mera is the account login, MetaMask is the member's trading wallet. The site checks that a trading wallet is linked to the account; the contracts themselves remain permissionless. The settlement signer is a separate wallet and must never trade. The old lost-key signer must never be funded. Member agent private keys stay on members' machines. A test AUSD dispenser and starter MON wallet fund invited members, with daily limits and alerts.

The original hackathon site stays at `flurbo.singu.online`. The company service targets `flurbopm.singu.online` in a separate Render account. Each hostname is its own passkey relying party; existing passkeys do not transfer to the new hostname. Both settlement bots can run when their pool registries, signers, Redis state and watchdogs are separate. The company site reuses the testnet deployer and test AUSD token, so their balances and nonce remain shared. See [company testnet runbook](SECOND_SITE_DEPLOYMENT.md).

## Checks and cutover

Run web typecheck, server tests and build; `bun` workflow checks; Foundry tests against the pinned contracts checkout; and the browser suite in the pinned Playwright Docker image. CI in `.github/workflows/checks.yml` records the exact commands and uses Node 24. The mobile job is retired from this company repository. Build the Docker image from the root because the web Dockerfile copies sibling packages.

The personal hackathon repository remains unchanged. This company repository has no Git history from it; that avoids publishing old research, local files or historical secrets. Before a live cutover, review the complete file list and run secret scanning. After the new repo passes checks, deploy the company service separately at `flurbopm.singu.online` and compare account login, wallet linking, market directory, quotes, buy/sell, evidence and redemption. Keep the original Render service and domain online. Verify environment names and values directly in Render using hidden inputs for secrets; the company service starts with settlement automation off.

## Known gaps at this snapshot

- The current dispute panel is operator controlled, with a 1 test AUSD bond. Economic independence needs Reality.eth and/or Kleros integration and new contract wiring.
- The bot does not finalize assertions posted by other wallets and does not withdraw its own bond credits.
- An official source behind a login or an unreadable page needs a new public-verification mechanism or manual assertion. No sports reader exists.
- Long pools pay after their last question. Early redemption and more than 4 questions per pool need contract changes.
- Rate limits and free-tier usage were reported in handoff notes, not measured during this migration.
- The legacy synthetic reader still has Kuru-specific compatibility fields. Extract or retire it in a separate change once the real-event path is verified.
- The Android asset-links endpoint remains for already installed mobile previews. The startup web release does not develop or ship the mobile client.
