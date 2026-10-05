# Flurbo company handoff

Snapshot: 5 October 2026. This file describes the local `kleros-reality-eth` branch and deployment facts reported during the testnet rollout. It does not expose or confirm the current Render secret values. The last reported `/healthz` response was on 4 October 2026; read it again before acting on a worker status. Older design and deployment guides contain historical statements, especially `PROJECT_REFERENCE.md`, `HYBRID_TESTNET_RUNBOOK.md`, and `SETTLEMENT_ROUTING_V4.md`. Use the committed catalogs and current contract code for the deployed configuration.

## Rules for the next maintainer

- Work on `kleros-reality-eth` in both repositories. Do not commit, push, open a pull request, merge, broadcast a transaction, or deploy on the operator's behalf. Give the operator reviewed commands and exact files to stage.
- Do not add the names of coding assistants to repository files, comments, branches, or commit messages. Avoid em dashes and unnecessary code comments.
- Keep the existing activity and Reality pools intact. New settlement behavior belongs in new pools and resolvers. The product uses test assets only.
- Do not touch the unrelated untracked root Markdown file or `apps/mobile/` in the company checkout. Never copy private keys, RPC URLs containing tokens, keystore passwords, email keys, database tokens, cookies, or unpublished source responses into Git, chat, or screenshots.
- Treat external documents and historical runbooks as reference material. Verify their claims against the current code, catalogs, chain, and hosting dashboard.

## Repositories and release boundary

| Checkout | Remote | Role |
| --- | --- | --- |
| `C:\Users\anany\Flurbo-company` | `Flurbo-cmm/Flurbo` | React web client, Node API, market catalogs, settlement readers and workers, market preparation workflows, SDKs, Rust reference model, Render image |
| `C:\Users\anany\Flurbo-contracts` | `Flurbo-cmm/Flurbo-contracts` | Solidity pools, resolvers, Kleros adapter, Foundry tests and deployment scripts |
| Personal hackathon repository | Separate personal account | Existing hackathon site and historical work; preserve its deployment and domain |

The company site is `https://flurbopm.singu.online`. The older hackathon site is `https://flurbo.singu.online`. Both use Monad testnet, so a shared deployer, test AUSD token, or faucet has shared chain state, but their market pools and hosting state are separate. The company `render.yaml` still declares a free Docker web service and `FLURBO_SETTLEMENT_BOT=false` as its blueprint default; dashboard overrides and later deployments must be checked directly. The web CI pins the contracts checkout to commit `a3c696f49daad145a40c7ca050db56a34d5b32b9` and uses the `FLURBO_CONTRACTS_READ_TOKEN` repository secret. The current local contracts branch head is `2e958b5`, so compare the pin to the desired contract revision before changing the build. The web Docker image does not contain contract source.

Local company branch head at this snapshot: `8613111` (`Restore linked trading wallet after refresh`). The local tracking branch `origin/main` was at `ce8beb4` when checked, so do not infer from this checkout alone which branch or commit Render deployed. The last two local web commits restore the hybrid trade and quote flow and wallet state. Check the Render deploy commit before claiming these fixes are live.

### Key paths

| Path | Purpose |
| --- | --- |
| `apps/web/src/pages/Markets.tsx`, `HybridMarket.tsx`, `OracleMarkets.tsx`, `Pilot.tsx` | Unified directory and the market detail flows |
| `apps/web/src/auth/trading-session.ts`, `wallet-links.ts` | Restore the selected browser wallet and verify its account link after refresh |
| `apps/web/server/production.mjs`, `local-api.mjs` | Start the hosted API, market services, health endpoint and workers |
| `apps/web/server/hybrid-market-service.mjs` | Hybrid quote, trade, holdings, challenge and redemption API |
| `apps/web/server/hybrid-settlement-worker.mjs`, `hybrid-arbitration-worker.mjs` | Mechanical source capture, proposals, finalization, Reality delivery and Kleros case relay |
| `apps/web/server/oracle-answer-worker.mjs`, `oracle-relay-worker.mjs` | Earlier Reality pool answer and final result workers |
| `apps/web/server/member-notices.mjs`, `hybrid-notices.mjs` | Position index and member email lifecycle |
| `apps/web/server/settlement-readers.mjs`, `settlement-rules.mjs` | Committed mechanical source rules and four general reader families |
| `config/collections.json` | Existing company activity pool and its legacy settlement mode |
| `config/oracle-markets.json` | Earlier Reality pool routes |
| `config/hybrid-markets.json` | New hybrid pool, published question rules and verified bindings |
| `workflows/cre` | Prepare, check, verify and register older pilot batches |
| `docs/HYBRID_TESTNET_RUNBOOK.md`, `docs/ORACLE_POC_RUNBOOK.md` | Deployment commands and fuller contract setup, with dated status text |

### Change history since the company settlement branch began

| Local commits | Change and current consequence |
| --- | --- |
| `5b32f6c`, `5aab77a`, `a53b236`, `7e6be27`, `cce8fda` | Added the separate Reality pool and relay, then moved its questions into the ordinary Markets flow and extended member notices. Browser and index catch-up regressions were addressed. |
| `2538799`, `b3f5dbb`, `2e52518` | Added hybrid settlement and Kleros case workers, fixed public wallet address handling, and registered the two-question hybrid mechanical pool. |
| `d57bd10`, `39d0fa7`, `8613111` | Restored hybrid share-sensitive quotes and analysis, the approve/buy/sell/redeem review flow, pending transaction recovery, and linked wallet restoration after refresh. |
| Contracts `811026f`, `2e958b5` | Added the earlier isolated Reality pool and resolver, then the hybrid resolver and Sepolia mechanical Kleros case adapter. |

The local commit history is an implementation record. For every change above, still check the deployed commit and an actual browser or on-chain result before calling it live or complete.

## Public deployment inventory

All addresses below are public identifiers. Keep the original receipts, prepared manifests and encrypted keystores in the operator's private deployment records.

| Role | Chain | Address or identifier | Source |
| --- | --- | --- | --- |
| Company activity pool, two questions | Monad testnet `10143` | `0x8c931a6f799d69185ee2f2f47e46667fd0da545b` | `config/collections.json` |
| Activity resolver | Monad testnet | `0x349a0d009f163c4c83c5c507b38fe617e726408f` | `config/collections.json` |
| Activity rules hash | Monad testnet | `0x889189c889a2d56685bb589dba16c451332ade6d204b651df63cf9705cc3f364` | `config/collections.json` |
| Earlier Reality pool, two questions | Monad testnet | `0x8301d8dE76528cD2E0965B21B7e0d926C30c5932` | `config/oracle-markets.json` |
| Earlier Reality resolver | Monad testnet | `0xeC1F04d0448126a86CE69103b7d8961b47d3Ce54` | `config/oracle-markets.json` |
| Earlier Reality relay | Monad testnet | `0x8838BBaC039F319074b9b6C692C9C02fFc82de98` | `config/oracle-markets.json` |
| Hybrid pool, `hybrid-reader-1`, two mechanical questions | Monad testnet | `0xB5CE32DE7A8631960dd26ab46bB20524d1fF9a44` | `config/hybrid-markets.json` |
| Hybrid resolver | Monad testnet | `0xD76F8c1b9356D5d0bdb84447355f41E3366e5ca8` | `config/hybrid-markets.json` |
| Hybrid rules hash | Monad testnet | `0x211f75a4980135521ac574a15c4b485fb1d9ef49addda9d1b9de7cbee6ba034c` | `config/hybrid-markets.json` |
| Hybrid proposer | Monad testnet | `0xa45c95f673580132F2E6f75372808162Ea069d49` | `config/hybrid-markets.json` |
| Hybrid relay | Monad testnet | `0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1` | `config/hybrid-markets.json` |
| Mechanical Kleros case adapter | Sepolia `11155111` | `0x62089ee5ba0E7E9109121be76eDC628B15FADad6` | `config/hybrid-markets.json` |
| Hybrid case manager | Sepolia | `0x771fE7003FA20737C933c39B89386d78cbc36370` | `config/hybrid-markets.json` |
| Reality.eth oracle | Sepolia | `0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA` | `config/oracle-markets.json` |
| Reality Kleros arbitrator proxy | Sepolia | `0x05b942faecfb3924970e3a28e0f230910cedff45` | `config/oracle-markets.json` |
| Shared test AUSD | Monad testnet | `0xa9012a055bd4e0edff8ce09f960291c09d5322dc` | `apps/web/server/network.mjs` |
| Existing deployer | Monad testnet and Sepolia | `0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391` | deployment manifests |

The hybrid adapter deployment transaction was `0x9eee29d1c0382eabcf83c1ab46a11f0dab00cf1b4c5473a41e4c0783f354f9bb` on Sepolia. The hybrid resolver and pool deployment transactions were `0x9e835be3d70b7ebb4efce0c7b188319d50ab15fa323b515d666e982413e742d7` and `0x0a5f9e4b203de34f949a60ddeb9afa6605e6de4ada7c582211d4bf81b9b7f3cd` on Monad testnet. The catalog records hybrid deployment block `68181601` for indexing and verification. The source pools' live outcome state has not been independently checked for this document.

## Architecture and user workflow

```text
Mera login and linked MetaMask wallet
        |
        v
/markets -> one market detail layout -> fresh quote -> AUSD approval -> buy or sell
        |                              |                             |
        |                              +-> combined claims, up to 3 outcomes
        |                                                            |
        +-> price history, thesis, positions, notices, evidence      v
                                                  Flurbo pool on Monad testnet
                                                            |
              committed route for each question -------------------+
                       |                                     |
             mechanical source reader                 Reality.eth on Sepolia
                       |                                     |
             bonded proposal on Monad                 bonded human answer
                       |                                     |
              no challenge: finalize                 timeout or Kleros dispute
                       |                                     |
              challenge: Kleros case on Sepolia              |
                       +---------------+---------------------+
                                       |
                             dedicated trusted relay
                                       |
                             resolver delivers results
                                       |
                         pool payout when all questions final
```

Users sign in with a Mera account, link their MetaMask trading wallet by signature, obtain test AUSD and MON, choose Yes or No and a share amount, optionally add two other questions, review a fresh buy or sell quote, approve AUSD when buying, then sign each transaction. The hybrid ticket now refreshes its quote when selection or share count changes, shows the actual spend or proceeds and payout information, tracks a pending transaction through reload, and restores a linked wallet after page refresh when the browser wallet exposes an authorized account. Wallet permission is still subject to the wallet's own behavior. The older activity and Reality markets also remain in `/markets`; no separate oracle directory is intended as the primary market path.

The hybrid pool uses `WidePilotPool` with `HybridPilotResolver`. It supports 2 to 32 base binary questions, but a trade selects at most three outcomes. The limit does not mean enumerating all `2^32` states. The current listed hybrid pool has only two mechanical questions: transaction count and gas used for a specified Monad testnet block. Pool liquidity and payouts are shared; payout starts after every question is final. A slow or disputed question can delay all holders in that pool. The original activity pool still uses its operator-controlled 2-of-3 reviewer resolver. The earlier Reality pool still uses `WidePilotResolver` and its separate relay. Neither was upgraded in place.

### Mechanical route

1. A published rule fixes the source URL, record selection, observation window, decision, evidence policy and VOID behavior before trading. Four general adapters exist: `json-api.v1`, `stat-table.v1` for CSV/SDMX/JSON-stat, `html-text.v1`, and `evm-rpc.v1` for EVM quantities.
2. The hybrid worker polls within the source window and stores captures and attempts. It validates public evidence, then its dedicated proposer signs a test AUSD bonded Yes, No, or Void proposal on Monad.
3. The one-hour challenge window starts. Without a challenge, the worker finalizes. With a challenge, a member submits an alternative answer, bond and public evidence in Flurbo. The case manager opens a Kleros case on Sepolia, and the Monad relay links and later reports the ruling.
4. The worker delivers all final answers to the pool. If no valid proposal is made by the committed deadline, the contract's timeout path determines Void. A linked Kleros case waits for a ruling; an unlinked challenge has the published 90-day fallback. Do not treat a linked court delay as an ordinary missed proposal.

### Reality route

New hybrid pools may commit a Reality.eth route per question before trading. A person or an enabled answer worker posts a Sepolia ETH bonded answer after the question opens. During Reality's timeout, others may counteranswer with a larger bond or request Kleros arbitration from the Flurbo market page. The page exposes evidence, appeal contributions, ruling completion, bond credits and withdrawals only in relevant phases. Once Reality has finalized, a dedicated worker reads a finalized Sepolia block and relays the result to the Monad resolver. A human interpretation question still requires a bonded human answer unless a specific, reviewed automatic answerer exists. The two earlier Sepolia block questions have a specialized answer worker, but it was last reported disabled. Its historical-finality recovery needs `FLURBO_SEPOLIA_BEACON_URL` and a provider that serves the required old Beacon checkpoint.

The Sepolia-to-Monad relay is trusted in this testnet implementation. Contracts restrict who reports, but Monad does not verify Sepolia state. Authenticated cross-chain delivery and measured court liveness are required before any real-money claim. Kleros requires Sepolia ETH for arbitration and gas. A trader using the Reality route needs Sepolia ETH for a bond or fee, even though the market shares and test AUSD are on Monad.

### Email and data services

The existing member notice cycle indexes linked-wallet positions and covers closing, observation, proposed-answer challenge window and payout transitions for hybrid and earlier Reality pools. Notices require the global settlement bot, `FLURBO_NOTIFY_ENABLED`, a valid company Resend sender domain and a successful position scan. A green worker health state alone does not prove an email was delivered. Use Resend POST logs and the member's preferences to check delivery. Daily metrics are scoped to each site and use the company email configuration. Redis stores sessions, wallet links, evidence and worker journals. Supabase can hold applications and rebuildable KV state. Envio provides indexed cash movement and charts; indexing can lag or omit a newly deployed pool until its indexer configuration includes it. The on-chain holding is the source of truth for a trade and redemption.

## Render variable inventory

These are names and roles, not values read from Render. Retain existing secret values only in Render or the operator's secret manager. Confirm each dashboard setting and deployed commit. `render.yaml` has only the minimal Blueprint defaults and does not list the full live configuration.

| Area | Variable names | Expected purpose or setting |
| --- | --- | --- |
| Site identity | `FLURBO_ORIGIN`, `FLURBO_NETWORK`, `FLURBO_COLLECTIONS_SOURCE`, `FLURBO_PILOT_DISABLED` | Company origin, `public_testnet`, `registry`, `true` |
| RPC and state | `FLURBO_ALCHEMY_TESTNET_RPC_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `FLURBO_SUPABASE_KV`, `FLURBO_APPLICATIONS_SUPABASE_URL`, `FLURBO_APPLICATIONS_SUPABASE_SECRET` | Monad RPC, company Redis, optional company Supabase KV and applications. RPC token-bearing URL and credentials are secrets |
| Existing activity settlement | `FLURBO_SETTLEMENT_BOT`, `FLURBO_MONITOR_ENABLED`, `FLURBO_RESOLUTION_ENABLED`, `FLURBO_RESOLUTION_PROPOSALS`, `FLURBO_RESOLUTION_EXECUTE`, `FLURBO_RESOLUTION_SIGNER_ADDRESS`, `FLURBO_RESOLUTION_PRIVATE_KEY`, `FLURBO_RESOLUTION_EVIDENCE_ORIGIN`, `FLURBO_RESOLUTION_HOLD` | Keep the activity pool's dedicated signer and registry behavior. Company startup requires monitor, worker, proposal flag and matching evidence origin when the bot is on |
| Hybrid settlement, new | `FLURBO_HYBRID_SETTLEMENT_ENABLED`, `FLURBO_HYBRID_PROPOSER_PRIVATE_KEY`, `FLURBO_HYBRID_RELAY_PRIVATE_KEY` | `true` starts capture, propose, finalize and delivery for the hybrid catalog. Keys must match the catalog's public proposer and relay |
| Hybrid Kleros, new | `FLURBO_HYBRID_ARBITRATION_ENABLED`, `FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY`, `FLURBO_SEPOLIA_RPC_URL`, `FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI` | `true` starts opening, linking and relaying mechanical Kleros cases and the Reality court keeper. Case manager and keeper need Sepolia ETH |
| Hybrid Reality answerer, new | `FLURBO_HYBRID_ANSWER_PRIVATE_KEY` | Sepolia key that posts the first bonded answer for rule-backed Reality questions |
| Earlier Reality pool | `FLURBO_ORACLE_RELAY_ENABLED`, `FLURBO_ORACLE_RELAY_PRIVATE_KEY`, `FLURBO_ORACLE_ANSWER_ENABLED`, `FLURBO_ORACLE_ANSWER_PRIVATE_KEY`, `FLURBO_SEPOLIA_BEACON_URL` | Keep its relay separate from the hybrid relay. The answer worker was last reported disabled; only enable with the intended Sepolia answer wallet and finality source |
| Access and mail | `FLURBO_APPLICATIONS_ENABLED`, `FLURBO_APPLICATIONS_CODE_SECRET`, `FLURBO_APPLICATIONS_RESEND_KEY`, `FLURBO_APPLICATIONS_EMAIL_FROM`, `FLURBO_APPLICATIONS_EMAIL_DAILY_LIMIT`, `FLURBO_NOTIFY_ENABLED`, `FLURBO_NOTIFY_DAILY_LIMIT` | Invite workflow and member notices. Sender addresses must belong to a domain verified in the company's Resend account |
| Monitoring and metrics | `FLURBO_MONITOR_RESEND_KEY`, `FLURBO_MONITOR_EMAIL_FROM`, `FLURBO_MONITOR_EMAIL_TO`, `FLURBO_MONITOR_HEALTHCHECK_URL`, `FLURBO_METRICS_DIGEST`, `FLURBO_METRICS_DIGEST_UTC`, `FLURBO_METRICS_SCAN_STEPS`, `FLURBO_METRICS_EXCLUDE` | Operator alerts, heartbeat and site-scoped daily summary |
| Test funding | `FLURBO_STARTER_PRIVATE_KEY`, `FLURBO_COMPANY_STARTER_ADDRESS`, `FLURBO_STARTER_MON`, `FLURBO_STARTER_DAILY_LIMIT`, `FLURBO_TEST_AUSD_FAUCET`, `FLURBO_ALERT_STARTER_MON`, `FLURBO_ALERT_DISPENSER_AUSD`, `FLURBO_ALERT_EMAIL` | Shared or company starter and faucet choices. A company starter key requires its matching public address |
| Other live integrations | `FLURBO_ALCHEMY_WEBHOOK_SIGNING_KEY`, `FLURBO_ENVIO_GRAPHQL_URL`, `FLURBO_AGENT_RESERVED_WALLETS`, `FLURBO_TESTING_OPERATOR_ACCOUNT`, `FLURBO_TESTNET_APPROVED_ACCOUNTS`, `FLURBO_LEARNING_OPERATOR_ACCOUNT`, `FLURBO_SHARED_LIMITS`, `FLURBO_SEMANTIC_MODE` | Signed webhook, Envio proxy, account roles, distributed limits, optional semantic checks |

The earlier copied manifest bundle variables are superseded by `FLURBO_COLLECTIONS_SOURCE=registry` for the company activity pool. Do not copy the hackathon pool manifest or signer into this service. `FLURBO_TESTNET_RPC_URL` is used by local verification scripts; the hosted service uses `FLURBO_ALCHEMY_TESTNET_RPC_URL`. `FLURBO_ORACLE_DEPLOYMENT_BLOCK` is a local registration override, not a hosted secret. GitHub's `FLURBO_CONTRACTS_READ_TOKEN` is a CI repository secret, not a Render variable. The frontend build and Render runtime must be checked for any separate public build-time variables before changing them.

The last user-reported `/healthz` snapshot showed `settlement_bot.enabled=true`, `oracle_answerer=disabled`, `oracle_relay.enabled=true` with two routes, `hybrid_settlement.enabled=true` with one pool, and `hybrid_arbitration.enabled=true` with two routes. Both hybrid workers reported no `lastError` after two cycles. This proves startup and polling at that time, not final answers, email delivery, a Kleros ruling, or payout. The company activity pool was still listed. Recheck current health and chain state.

## Kleros challenge observation, 5 October 2026

The operator reported that the current hybrid market settled while they were away, without a challenge test. Treat this as a report of the ordinary settlement path, not as evidence that Kleros arbitration worked. No Flurbo Kleros dispute ID or case link was observed in the provided records. A finalized answer cannot be challenged afterward; use a new future market for a live arbitration test.

For a mechanical question, a user challenges a bonded Monad proposal during its one-hour window by supplying a different answer, a test AUSD bond and public evidence in Flurbo. The hybrid arbitration worker then uses the funded Sepolia case manager to call `MechanicalKlerosCase.openCase`. That deployed adapter calls the real Sepolia KlerosLiquid `createDispute` with three choices and emits `CaseOpened(requestId, disputeId, questionHash, sourceCaseId)`. The court dispute ID is available from that Sepolia event or `caseState(requestId)`, but the current mechanical market UI does not display a direct Kleros case link. Sepolia adapter: `0x62089ee5ba0E7E9109121be76eDC628B15FADad6`. Sepolia KlerosLiquid: `0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879`. Inspect the adapter on `https://sepolia.etherscan.io/address/0x62089ee5ba0E7E9109121be76eDC628B15FADad6#events` and the court at `https://court.kleros.io/`; a specific court case needs its numeric dispute ID. The case manager pays Sepolia ETH for the arbitration fee and gas. The user pays the Monad bond and transaction gas.

The court's executed ruling calls the adapter's `rule`, which maps No, Yes and Void and stores the result. The worker reads that state and its authorized relay links the source case and reports the outcome to the Monad resolver. The resolver finalizes the answer and test AUSD bond credits, then the pool can pay out once every question is final. The current hybrid catalog has two mechanical questions; neither uses the separate Reality.eth question route.

This is a real deployed arbitrable adapter, but the full live challenge-to-payout path has not been demonstrated. The adapter has no `appeal` method; KlerosLiquid requires an appeal to come from the arbitrable contract, so a mechanical-case appeal is currently unavailable. The Flurbo worker also does not call KlerosLiquid `executeRuling`; an external actor must execute the court ruling before the adapter records it, so automatic completion is not guaranteed. The adapter permits later `submitEvidence`, but the mechanical market page does not expose it after case creation. The Monad resolver trusts the authorized relay's reported Sepolia ruling rather than verifying court state on-chain. Healthy worker polling or a normally settled market does not close any of these gaps.

Before claiming this route works end to end, add ruling execution, an appeal path, post-creation evidence submission and visible dispute links. Then create a new future test market, submit a real challenge, verify `CaseOpened` and `DisputeCreation` on Sepolia, follow juror voting and ruling execution, confirm the Monad relay result, bond withdrawals and final pool payout. Preserve the exact transaction hashes and dispute ID in the private operational record.

## Reality reader route, 5 October 2026

New pools settle every question through Reality.eth v3 on Sepolia with the official Kleros proxy as arbitrator. The four adapter gaps in the previous section (no appeal method, no ruling execution, no later evidence, no dispute links) are superseded for these pools. The proxy supplies appeal funding, evidence and ruling delivery, the court keeper executes the permissionless court steps, and the market page shows the case number, period and Sepolia links. `MechanicalKlerosCase` and `hybrid-arbitration-worker.mjs` stay as legacy code for `hybrid-reader-1`, which is already delivered. The procedure and wallet list are in the "Reality reader pools" section of [the hybrid runbook](HYBRID_TESTNET_RUNBOOK.md).

- Off-by-one fix: the proxy enum is `None=0, Disputed=1, Ruled=2, Reported=3`. The earlier code gated appeal funding on 2 and ruling completion on 3. Both now use `ARBITRATION_STATUS`, and the fixtures use the real values.
- The contracts commit `2e958b5` (`HybridPilotResolver`, `MechanicalKlerosCase`) exists only on the contracts `kleros-reality-eth` branch and has not been through CI. The new all-Reality lifecycle tests in `test/HybridPilotLifecycle.t.sol` need a contracts pull request and a CI pin update in `.github/workflows/checks.yml`.
- New `/healthz` keys: `hybrid_court` (routes, keeper address, per-question `proxyStatus`, `disputeId`, `period`, `waiting`) and `hybrid_settlement.answerer` with `hybrid_settlement.answers`.
- New Render variables: `FLURBO_HYBRID_ANSWER_PRIVATE_KEY` and optional `FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI`.
- The `hybrid-reader-1` proposer holds 2 test AUSD of uncollected bond credit. Collect it with `withdrawBond()` on that resolver from the proposer wallet.
- The Reality.eth question link was opened for an existing Sepolia question and resolves. `court.kleros.io/cases/<id>` opens mainnet cases only, so the market page links the Sepolia court contract events on Etherscan instead and shows the case number and period as text.
- The juror vote is manual. An operator juror wallet staked with faucet test PNK casts it. The relay stays trusted.

## Verification and unfinished work

1. In both checkouts, inspect `git status --short --branch` and the contract pin. Do not stage unrelated untracked files. Review the Render deployed commit, its environment variable names, and the current `/healthz` worker statuses.
2. Verify the three catalog pools and their resolver bindings on chain. Check the hybrid questions' current `caseState`, bonds, source captures, court case and payout state. The current catalog contains two mechanical EVM questions; no hybrid Reality question or live challenged path has been demonstrated in the provided records.
3. Exercise a complete market trade from the company site: Mera login, linked MetaMask restoration after refresh, change shares and combined selection, observe updated quote, approve test AUSD, buy, check the receipt and holding, sell, then redeem after both questions finalize. Browser wallet prompts still require a human signature. Check both normal and challenged settlement paths separately.
4. Check member email preferences, the indexed wallet position, Resend delivery logs and the daily metrics digest. Confirm the sender domain matches the company Resend account. A successful API call or `/healthz` cycle is not enough to establish delivery.
5. Done: the unified Portfolio loads hybrid holdings, combined claims, history and collected payouts through `apps/web/server/hybrid-portfolio.mjs` and the four `/api/hybrid/pool/<pool>/{account,positions,history,collected-payouts}` routes. Payouts are still collected on the hybrid market page.
6. Add reader coverage one source at a time. Public official sports feeds need fixture, status, score, postponement and correction rules. Elections and statistics need certified release and vintage checks. Non-EVM chains, PDF-only results, JavaScript-only public pages and zkTLS for login or keyed data remain unimplemented. No generic reader can safely cover every source. Publish only a question with a tested, committed source route.
7. Replace the trusted Sepolia-to-Monad relay with authenticated delivery before any real-money deployment. Review court fees, appeal timing, settlement latency, source availability and the shared-pool payout delay. If more than one Render instance runs a hybrid relay key, add a distributed nonce coordinator or elect one worker.

For code changes, use the relevant focused tests, then `npm --prefix apps/web run typecheck`, `npm --prefix apps/web test`, the web build, `bun test` in `workflows/cre` when its code changes, and `forge test --summary` in the contracts checkout when contracts change. CI in `.github/workflows/checks.yml` is the release gate. A documentation-only change needs a link and content review plus `git diff --check`; it does not need a new chain transaction. The operator performs all staging, commits, pushes, merges and deployments.
