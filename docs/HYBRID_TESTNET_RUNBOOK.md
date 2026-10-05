# Hybrid settlement testnet runbook

Status update, 5 October 2026: the hybrid pool and mechanical Kleros adapter are deployed, and `config/hybrid-markets.json` lists one pool with two mechanical questions. The deployment sequence below is historical and must not be broadcast again for the same manifest. See [the current handoff](HANDOFF.md) for addresses, Render variables, architecture, and remaining verification. The existing activity and earlier Reality pools retain their contracts and workers.

## What this version does

New pools use `HybridPilotResolver` and the existing `WidePilotPool`. A pool can hold 2 to 32 base questions. A purchase selects one to three outcomes, so the pool does not enumerate `2^32` states. A Foundry test deployed and settled a 32-question fixture; it used about 14.2 million gas across the test, including contract creation, funding, 32 reports, and delivery. This is a local test, not a Monad deployment estimate.

Each question commits to one route before trading:

- Mechanical: the existing source capture and reader pipeline records evidence, a dedicated proposer posts a bonded provisional result on Monad, and a one-hour challenge window opens. Without a challenge, the worker finalizes and delivers automatically. A challenge locks another test AUSD bond, freezes the short timer, and requests a Kleros case on Sepolia through `MechanicalKlerosCase`. A case manager wallet pays the Sepolia arbitration fee. A dedicated relay reports the resulting ruling to Monad. A linked case waits for its Kleros ruling even after the 90-day fallback deadline. A challenge without a linked source case becomes Void at that deadline. The contract does not use the old 2-of-3 operator review.
- Reality.eth: an answerer posts a Sepolia ETH bond from the Flurbo market page. Another answer or a Kleros arbitration request is available during the Reality timeout. The final answer is read at a finalized Sepolia block and relayed to Monad. The same page supports evidence, appeal contributions, ruling completion, bond processing, and withdrawals.

Both routes appear on `/markets` and use the same question cards, price history, trade ticket, combined claims, settlement timeline, account link, and member notice worker. Resolution controls appear only in their relevant phase. The new market page reads single-question holdings and lets a holder select the exact questions and answers of a combined claim to collect its payout. The unified Portfolio dashboard still indexes the original pool types, so use the new market page for hybrid holdings and payouts until the Portfolio loader is extended.

The Sepolia-to-Monad relay is trusted in this testnet version. A compromised relay can report the wrong Kleros ruling or Reality answer. The on-chain contracts bind who may report, but they do not verify Sepolia state. Keep this limit visible when testing; authenticated cross-chain delivery is still required before a real-money deployment.

A linked Kleros case can hold up every payout in its shared pool if the court never issues a final ruling. Monitor linked cases and their appeals. The 90-day fallback applies only when a case cannot be linked.

## Source coverage

The mechanical route currently uses the existing verified adapters: public JSON API, CSV/SDMX/JSON-stat tables, anchored HTML text, and EVM RPC. A publisher-specific rule must name the event, record, finality or revision policy, and exact extraction field before listing a market. The first sample below uses two quantities from the same Monad testnet block.

Official sports feeds can be configured through public JSON only after a league-specific fixture ID, final status, score type, postponement rule, and correction policy are tested. Election and statistics feeds can use the existing table readers where a certified release and revision vintage are explicit. Other chain families, PDF-only documents, browser-rendered public pages, and login/key-gated zkTLS proofs are not implemented by this version. Do not advertise those categories as automatic or publish questions using them yet. The build order and rejection criteria are in [SETTLEMENT_ROUTING_V4.md](SETTLEMENT_ROUTING_V4.md).

## Wallets, funds, and hosting

Keep the existing deployer keystore. Create separate encrypted keystores for the Monad proposer, Monad relay, and Sepolia case manager. Their private keys are Render secrets, never Git content. The deployer needs Monad testnet MON and test AUSD to create and fund a pool. The proposer needs MON for gas and test AUSD for each mechanical bond. The relay needs MON. The case manager needs Sepolia ETH above the live Kleros arbitration fee plus gas. Traders need test AUSD and MON; a Reality answerer or challenger needs Sepolia ETH. The existing faucet can remain shared.

The existing Render Redis, Resend, and settlement bot settings remain in use. For a nonempty hybrid catalog, add these company service variables:

| Variable | Purpose |
| --- | --- |
| `FLURBO_HYBRID_SETTLEMENT_ENABLED=true` | Poll sources, post, finalize, and deliver |
| `FLURBO_HYBRID_PROPOSER_PRIVATE_KEY` | New Monad proposer key |
| `FLURBO_HYBRID_RELAY_PRIVATE_KEY` | New Monad relay key |
| `FLURBO_HYBRID_ARBITRATION_ENABLED=true` | Open and report mechanical Kleros cases |
| `FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY` | New Sepolia case manager key |
| `FLURBO_SEPOLIA_RPC_URL` | Reliable Sepolia HTTPS RPC |
| `FLURBO_HYBRID_ANSWER_PRIVATE_KEY` | Sepolia-only answerer key for Reality reader pools |
| `FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI` | Optional cap on the Kleros arbitration fee the keeper pays, default `20000000000000000` |
| `FLURBO_HYBRID_ALERTS_ENABLED=true` | Operator emails for hybrid pools (see "Operator emails" below). Needs `FLURBO_MONITOR_EMAIL_TO`, `FLURBO_MONITOR_EMAIL_FROM` and `FLURBO_MONITOR_RESEND_KEY` |

`FLURBO_SETTLEMENT_BOT=true` and `FLURBO_NOTIFY_ENABLED=true` continue to drive closing, observation, proposal, and payout emails. Sender addresses and Resend keys stay as configured for the company site. Check `/healthz` for `hybrid_settlement` and `hybrid_arbitration` errors after enabling the catalog. A free Render instance can sleep; a ten-minute ping is helpful but cannot guarantee capturing a short source window. The source rule specifies the cutoff and VOID behavior, so widen the capture window for a real trial.

Run one company web instance for this testnet trial. The two hybrid workers serialize transactions from their shared Monad relay wallet inside that process. Multiple service instances using the same relay key need a distributed nonce coordinator or a single elected worker before they are enabled.

## Reality reader pools

New pools reuse `HybridPilotResolver` and `WidePilotPool` with every route set to Reality. Each question carries its published rule. After the observation window, the hybrid settlement worker reads the committed source, freezes the result in Redis, and its answerer wallet posts the first bonded answer on Reality.eth. Reality finalizes after its timeout (default one hour). The relay then reports the answer to Monad. If someone posts a different answer, the court keeper requests Kleros arbitration through the official proxy when the new best answer contradicts the reader result, files the reader evidence, and moves the court through each permissionless step: delayed stakes, phase changes, juror draw, period changes, ruling execution and the report back to Reality. Appeal funding stays open to users on the market page.

The only manual step is the juror vote. An operator-controlled juror wallet staked with faucet test PNK casts it. The keeper passes the vote period once the vote is cast, or after `voteWaitSeconds` (default 24 hours) with no vote. Passing without a vote ends in a tie, which Kleros reports as ruling 0 and Flurbo treats as Void. The relay from Sepolia to Monad is trusted in this testnet version. Authenticated delivery is required before any real-money use. A Kleros case that outlasts the 90-day report period becomes Void.

### Operator emails and member notice diagnostics

The original operator monitor (`FLURBO_MONITOR_*`) only watches the activity pool. Hybrid pools have their own operator email, `hybrid-operator-alerts.mjs`, enabled with `FLURBO_HYBRID_ALERTS_ENABLED=true` and sent through the same Resend settings and recipient. It emails once per event: answer posted, Kleros arbitration requested, vote period reached (subject starts with `ACTION`, this is your cue to cast the juror vote), ruling, Reality final, reported to Monad, and pool delivered. It also emails worker errors (once per 6 hours per message) and low Sepolia balances for the answerer (below 0.002 ETH) and the keeper (below 0.03 ETH), once per day. The first run for a pool records the current state without sending, so history is never emailed. Check `/healthz` `hybrid_alerts`.

Member notices (traders) are separate. A stage that nobody could receive, because no wallet was linked or no verified email existed, is now checked again after one hour instead of being closed for good. When stages were due but nobody was emailed, the `settlement_bot.notices` text in `/healthz` adds the counts, for example `sent 0 (stages 1, wallets 1, unlinked 1, no verified email 0)`. `unlinked` means a trading wallet is not linked to a Flurbo account. `no verified email` means the account has no verified email in the company applications data.

### Wallets and funding

| Wallet | Chain | Role | Funding |
| --- | --- | --- | --- |
| Answerer (new keystore `flurbo-hybrid-answer`) | Sepolia | Posts the first bonded answer | At least 0.01 Sepolia ETH |
| Juror (new keystore `flurbo-kleros-juror`) | Sepolia | Stakes test PNK and casts the vote | At least 0.01 Sepolia ETH and faucet PNK |
| Keeper (existing case manager `0x771fE7003FA20737C933c39B89386d78cbc36370`) | Sepolia | Requests arbitration, files evidence, drives the court | At least 0.05 Sepolia ETH |

The proposer, relay and deployer keep their existing roles. The answerer must differ from the creator, proposer and relay. The keeper must differ from the relay.

### Environment variables

`FLURBO_HYBRID_ANSWER_PRIVATE_KEY` is new and is pasted only into Render. A key set ahead of a catalog entry with rule-backed Reality events is ignored. `FLURBO_HYBRID_SETTLEMENT_ENABLED=true` and `FLURBO_HYBRID_ARBITRATION_ENABLED=true` start the answerer and the court keeper. The keeper reuses `FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY`. `FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI` is optional. `/healthz` gains `hybrid_court` and `hybrid_settlement.answerer`, plus per-question `hybrid_settlement.answers`.

### Owner procedure (Git Bash, the owner signs everything)

Set up the environment:

```bash
export PATH="$USERPROFILE/.foundry/bin:$PATH"; export HOME="$USERPROFILE"
export FLURBO_SEPOLIA_RPC_URL='<private Sepolia HTTPS RPC>'; export FLURBO_TESTNET_RPC_URL='<private Monad HTTPS RPC>'
cd /c/Users/anany/Flurbo-company/apps/web
```

1. Create the two keystores and note the addresses. Back up each password privately.

```bash
cast wallet new "$USERPROFILE/.foundry/keystores" flurbo-hybrid-answer
```

```bash
cast wallet new "$USERPROFILE/.foundry/keystores" flurbo-kleros-juror
```

```bash
ANSWERER=$(cast wallet address --account flurbo-hybrid-answer); JUROR=$(cast wallet address --account flurbo-kleros-juror); KEEPER=0x771fE7003FA20737C933c39B89386d78cbc36370
```

```bash
cast balance $KEEPER --rpc-url "$FLURBO_SEPOLIA_RPC_URL"
```

2. Stake the juror. Request test PNK from the faucet, read the balance, then stake all of it in subcourt 0. Outside the staking phase the stake is queued and the keeper executes it later.

```bash
cast send 0x776e5853e3d61B2dFB22Bcf872a43bF9A1231e52 'request()' --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror
```

```bash
cast call 0xA1eE4D32bdBcA69cdb445D66fAA3804aFFa24bFE 'balanceOf(address)(uint256)' $JUROR --rpc-url "$FLURBO_SEPOLIA_RPC_URL"
```

```bash
cast send 0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879 'setStake(uint96,uint128)' 0 <PNK_BALANCE> --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror
```

```bash
cast call 0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879 'stakeOf(address,uint96)(uint256)' $JUROR 0 --rpc-url "$FLURBO_SEPOLIA_RPC_URL"
```

If the last call prints `0` because the stake was queued, check it again after the keeper runs.

3. Ship the code with no new catalog entry. Commit and merge the contracts test, set the CI pin in `.github/workflows/checks.yml` to that merge commit, then commit and merge the company changes. Set `FLURBO_HYBRID_ANSWER_PRIVATE_KEY` (from `cast wallet decrypt-keystore flurbo-hybrid-answer`), `FLURBO_HYBRID_SETTLEMENT_ENABLED=true` and `FLURBO_HYBRID_ARBITRATION_ENABLED=true` in Render. `/healthz` shows `hybrid_court` as `disabled` until a Reality pool is listed.

4. Move the files of any earlier hybrid pool out of `Flurbo-contracts/target/deployments/` into private records (`hybrid-pilot-input.json`, `hybrid-pilot-prepared.json`, `hybrid-pilot-unverified.json`, `hybrid-catalog-candidate.json`). Every script below writes with `wx` and refuses to overwrite. Then generate the template and ask both questions. `CLOSE` must be at least 2 hours away.

```bash
CLOSE=$(( $(date +%s) + 3*3600 )); DEPLOYER=0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391
```

```bash
node scripts/create-hybrid-reality-pilot.mjs $DEPLOYER 0xa45c95f673580132F2E6f75372808162Ea069d49 0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1 $CLOSE https://flurbopm.singu.online ../../../Flurbo-contracts/target/deployments/hybrid-reality-template.json
```

Run the two printed `cast send` lines and copy both transaction hashes.

5. Complete the draft, prepare, deploy and register.

```bash
node scripts/complete-hybrid-reality-draft.mjs ../../../Flurbo-contracts/target/deployments/hybrid-reality-template.json <TX0> <TX1> ../../../Flurbo-contracts/target/deployments/hybrid-pilot-input.json
```

```bash
node scripts/prepare-hybrid-pilot.mjs ../../../Flurbo-contracts/target/deployments/hybrid-pilot-input.json ../../../Flurbo-contracts/target/deployments/hybrid-pilot-prepared.json
```

```bash
cd /c/Users/anany/Flurbo-contracts && FOUNDRY_PROFILE=demo FLURBO_DEPLOYER=$DEPLOYER forge script script/DeployHybridPilot.s.sol:DeployHybridPilot --rpc-url "$FLURBO_TESTNET_RPC_URL" --account flurbo-testnet --sender $DEPLOYER --broadcast --slow
```

```bash
cd /c/Users/anany/Flurbo-company && node apps/web/scripts/register-hybrid-pool.mjs hybrid-reality-1 ../Flurbo-contracts/target/deployments/hybrid-pilot-prepared.json ../Flurbo-contracts/target/deployments/hybrid-pilot-unverified.json ../Flurbo-contracts/target/deployments/hybrid-catalog-candidate.json --keeper $KEEPER --answerer $ANSWERER
```

Review the candidate, then copy it to `config/hybrid-markets.json`, commit, merge and deploy. Check `/healthz`: `hybrid_court.routes` is 2, `hybrid_settlement.answerer` equals `$ANSWERER`, and no `lastError` appears.

```bash
cp ../Flurbo-contracts/target/deployments/hybrid-catalog-candidate.json config/hybrid-markets.json
```

6. Question 1 (no challenge). Buy one share on each question from the market page. After `observationEndsAt`, `hybrid_settlement.answers` reaches `submitted`, then `already_answered`. About one hour later Reality finalizes and the relay reports.

7. Question 2 (challenge). Inside its Reality timeout, a separate test wallet posts the opposite answer from the market page at double the bond. Within one keeper cycle `hybrid_court.cases[<id>].proxyStatus` becomes 1. Note the dispute ID and the `requestArbitration` transaction. Inspect the case:

```bash
node apps/web/scripts/inspect-kleros-dispute.mjs <Q2_ID> $JUROR
```

Once the period is `Vote`, run the printed `castVoteCommand` with the right choice: 2 for Yes, 1 for No, 0 for Void. The keeper passes the vote and appeal periods, executes the ruling and reports it. Reality finalizes, the relay reports to Monad, and the relay delivers when both questions are final.

8. Redeem from the market page. Claim Reality bonds and withdraw on Sepolia for the answerer and the challenger. Check the Resend logs for the closing, observation, challenge, arbitration, ruling and payout notices. Store the transaction hashes, the dispute ID and the addresses in `secrets/COMPANY_OPERATIONS.md`.

### Staging for the owner

```bash
cd /c/Users/anany/Flurbo-company && git add -- apps/web/server/oracle-integration.mjs apps/web/server/hybrid-reality.mjs apps/web/server/hybrid-settlement-worker.mjs apps/web/server/hybrid-court-keeper.mjs apps/web/server/hybrid-market-service.mjs apps/web/server/hybrid-notices.mjs apps/web/server/member-notices.mjs apps/web/server/local-api.mjs apps/web/server/production.mjs apps/web/scripts/prepare-hybrid-pilot.mjs apps/web/scripts/create-hybrid-evm-pilot.mjs apps/web/scripts/create-hybrid-reality-pilot.mjs apps/web/scripts/complete-hybrid-reality-draft.mjs apps/web/scripts/inspect-reality-question.mjs apps/web/scripts/inspect-kleros-dispute.mjs apps/web/scripts/register-hybrid-pool.mjs apps/web/src/pages/HybridMarket.tsx apps/web/src/pages/OracleMarkets.tsx apps/web/tests/oracle-integration.test.ts apps/web/tests/hybrid-reality.test.ts apps/web/tests/hybrid-settlement-worker.test.ts apps/web/tests/hybrid-catalog-fixture.ts apps/web/tests/hybrid-reality-fixture.ts apps/web/tests/hybrid-market-service.test.ts apps/web/tests/hybrid-trade-browser.test.ts apps/web/tests/member-notices.test.ts apps/web/tests/prepare-hybrid-pilot.test.ts apps/web/tests/create-hybrid-reality-pilot.test.ts apps/web/tests/register-hybrid-pool.test.ts apps/web/tests/hybrid-rule-endpoint.test.ts apps/web/tests/hybrid-court-keeper.test.ts apps/web/tests/inspect-kleros-dispute.test.ts apps/web/tests/hybrid-api-errors.test.ts docs/SETTLEMENT_ROUTING_V4.md docs/HYBRID_TESTNET_RUNBOOK.md docs/HANDOFF.md && git diff --cached --check && git diff --cached --stat
```

The CI pin edit to `.github/workflows/checks.yml` is a separate commit made after the contracts pull request merges. The contracts side stages only `test/HybridPilotLifecycle.t.sol`.

## Manual deployment sequence (historical, mechanical pool)

Run PowerShell 7. First merge and deploy the code with the empty `config/hybrid-markets.json`. Confirm `https://flurbopm.singu.online/hybrid-meta-evidence.json` serves the MetaEvidence JSON. It follows [ERC-1497](https://docs.kleros.io/developer/arbitration-development/erc-1497-evidence-standard). For a durable deployment, pin the exact JSON on IPFS and use its immutable HTTPS gateway URL when deploying the adapter.

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
$company = 'C:\Users\anany\Flurbo-company'
$contracts = 'C:\Users\anany\Flurbo-contracts'
$monadRpc = 'https://testnet-rpc.monad.xyz'
$sepoliaRpc = '<your Sepolia HTTPS RPC>'
$deployerAccount = 'flurbo-testnet'
$deployer = cast wallet address --account $deployerAccount
$proxy = '0x05b942faecfb3924970e3a28e0f230910cedff45'
$env:FLURBO_TESTNET_RPC_URL = $monadRpc
$env:FLURBO_SEPOLIA_RPC_URL = $sepoliaRpc

cast wallet new "$env:USERPROFILE\.foundry\keystores" flurbo-hybrid-proposer
cast wallet new "$env:USERPROFILE\.foundry\keystores" flurbo-hybrid-relay
cast wallet new "$env:USERPROFILE\.foundry\keystores" flurbo-hybrid-case-manager
$proposer = cast wallet address --account flurbo-hybrid-proposer
$relay = cast wallet address --account flurbo-hybrid-relay
$manager = cast wallet address --account flurbo-hybrid-case-manager
```

Back up each encrypted keystore and its password separately. Never send the private keys in chat or save them in the publication JSON. Fund all three wallets after checking the live balances and arbitration cost.

Confirm that the Sepolia endpoint is on chain `11155111` before using it. The existing deployer needs Sepolia ETH for the adapter deployment, and the new case manager needs Sepolia ETH for the arbitration fee and gas. Monad MON in either wallet cannot pay those Sepolia costs.

```powershell
cast chain-id --rpc-url $sepoliaRpc
$court = cast call $proxy 'arbitrator()(address)' --rpc-url $sepoliaRpc
$extraData = cast call $proxy 'arbitratorExtraData()(bytes)' --rpc-url $sepoliaRpc
$fee = cast call $court 'arbitrationCost(bytes)(uint256)' $extraData --rpc-url $sepoliaRpc
"Court: $court | Extra data: $extraData | Fee in wei: $fee"
cast balance $deployer --rpc-url $monadRpc
cast balance $deployer --rpc-url $sepoliaRpc
cast balance $manager --rpc-url $sepoliaRpc
cast call 0xa9012a055bd4e0edff8ce09f960291c09d5322dc 'balanceOf(address)(uint256)' $deployer --rpc-url $monadRpc
```

The Monad transfers below are examples. Adjust them to the live balances. Obtain Sepolia test ETH for both the deployer and the case manager before deploying the adapter. If the deployer already has Sepolia ETH and you choose to transfer some to the case manager, check the live arbitration fee and leave the deployer enough for its adapter deployment gas. The previous fixed `0.1ether` transfer example is intentionally omitted because it can exceed the sender's Sepolia balance.

```powershell
cast send $proposer --value 0.2ether --rpc-url $monadRpc --account $deployerAccount
cast send $relay --value 0.2ether --rpc-url $monadRpc --account $deployerAccount
```

Deploy the Sepolia adapter. Read the contract address from the successful Foundry output and record its deployment transaction and block.

```powershell
Set-Location $contracts
$env:FLURBO_DEPLOYER = $deployer
$env:FLURBO_KLEROS_ARBITRATOR = $court
$env:FLURBO_KLEROS_EXTRA_DATA = $extraData
$env:FLURBO_CASE_MANAGER = $manager
$env:FLURBO_CASE_META_EVIDENCE_URI = 'https://flurbopm.singu.online/hybrid-meta-evidence.json'
forge script script/DeployMechanicalKlerosCase.s.sol:DeployMechanicalKlerosCase --rpc-url $sepoliaRpc --account $deployerAccount --sender $deployer --broadcast --slow
$adapter = '<successful Sepolia adapter address>'
```

Create a fresh two-question mechanical sample. The generator commits to the first Monad testnet block at or after a future timestamp, records finality, and uses a public RPC without a credential. Review the full generated JSON before preparing or deploying.

```powershell
$close = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 10800
New-Item -ItemType Directory -Force "$contracts\target\deployments" | Out-Null
$draft = "$contracts\target\deployments\hybrid-pilot-input.json"
$prepared = "$contracts\target\deployments\hybrid-pilot-prepared.json"
$unverified = "$contracts\target\deployments\hybrid-pilot-unverified.json"
$candidate = "$contracts\target\deployments\hybrid-catalog-candidate.json"
Set-Location $company
node apps/web/scripts/create-hybrid-evm-pilot.mjs $deployer $proposer $relay $close $draft
Get-Content $draft
node apps/web/scripts/prepare-hybrid-pilot.mjs $draft $prepared
```

Deploy a new Monad pool. The script refuses to overwrite an existing unverified manifest. If a broadcast times out, inspect Foundry's transaction receipts before retrying to avoid duplicate pools.

```powershell
Set-Location $contracts
$env:FOUNDRY_PROFILE = 'demo'
forge build --offline
forge test --offline --match-contract HybridPilotLifecycleTest
forge test --offline --match-contract MechanicalKlerosCaseTest
forge script script/DeployHybridPilot.s.sol:DeployHybridPilot --rpc-url $monadRpc --account $deployerAccount --sender $deployer --broadcast --slow
```

Verify on-chain bindings, create the catalog candidate, review it, then copy only the candidate into the company catalog. Register before allowing trades so the email trade index starts before the first trade.

```powershell
Set-Location $company
node apps/web/scripts/register-hybrid-pool.mjs hybrid-reader-1 $prepared $unverified $adapter $manager $candidate
Get-Content $candidate
Copy-Item -LiteralPath $candidate -Destination 'config\hybrid-markets.json'
```

After the catalog change is committed, pushed, merged, and deployed by you, set the Render variables above. Confirm `/healthz` reports both hybrid workers enabled with no error and that two new questions appear on `/markets`. Trade one share, then observe both automatic no-challenge settlement and a separate challenged question. A challenge needs a user with test AUSD, MON, and public evidence. The case manager needs Sepolia ETH above the fee. Check the Kleros case and Relay progress, then redeem from the market page after every question in the pool is final. Check a verified holder's email preferences and Resend logs for closing, observation, challenge, and payout notices.

Keep the pool, resolver, adapter, court, manager, proposer, relay, rule hash, draft hash, catalog ID, creation transactions, chain IDs, and JSON manifests in your private deployment records. The private keys and keystore passwords belong only in your secret manager and Render. Do not reuse the old activity pool's resolution key or the old Reality pool's relay key for these new roles.

No command here commits, pushes, merges, or deploys on your behalf.

## Git commands for the first hybrid release (historical)

After reviewing both checkouts and running the tests, stage only the listed settlement files. Unrelated untracked files are intentionally excluded.

```powershell
Set-Location $contracts
git status --short
git add -- script/DeployHybridPilot.s.sol script/DeployMechanicalKlerosCase.s.sol src/HybridPilotResolver.sol src/MechanicalKlerosCase.sol test/HybridPilotLifecycle.t.sol test/MechanicalKlerosCase.t.sol
git diff --cached --stat
git commit -m "Add hybrid settlement contracts and Kleros case adapter"
git push -u origin kleros-reality-eth

Set-Location $company
git status --short
git add -- apps/web/server/local-api.mjs apps/web/server/member-notices.mjs apps/web/server/oracle-integration.mjs apps/web/server/production.mjs apps/web/server/hybrid-arbitration-worker.mjs apps/web/server/hybrid-market-service.mjs apps/web/server/hybrid-notices.mjs apps/web/server/hybrid-reality.mjs apps/web/server/hybrid-settlement-worker.mjs apps/web/server/oracle-answer-worker.mjs apps/web/scripts/create-hybrid-evm-pilot.mjs apps/web/scripts/prepare-hybrid-pilot.mjs apps/web/scripts/register-hybrid-pool.mjs apps/web/public/hybrid-meta-evidence.json apps/web/src/App.tsx apps/web/src/market-directory.ts apps/web/src/pages/HybridMarket.tsx apps/web/src/pages/Markets.tsx apps/web/src/pages/OracleMarkets.tsx apps/web/src/pages/PriceHistory.tsx apps/web/tests/hybrid-arbitration-worker.test.ts apps/web/tests/hybrid-market-service.test.ts apps/web/tests/hybrid-reality.test.ts apps/web/tests/hybrid-settlement-worker.test.ts apps/web/tests/oracle-answer-worker.test.ts apps/web/tests/prepare-hybrid-pilot.test.ts config/hybrid-markets.json docs/HYBRID_TESTNET_RUNBOOK.md docs/ORACLE_AUTO_ANSWER.md docs/ORACLE_POC_RUNBOOK.md docs/SETTLEMENT_ROUTING_V4.md
git diff --cached --stat
git commit -m "Integrate hybrid settlement into company markets"
git push -u origin kleros-reality-eth
```

Merge the contracts branch before the company branch, then follow the manual deployment sequence above. These commands are for you to run; they have not been executed here.
