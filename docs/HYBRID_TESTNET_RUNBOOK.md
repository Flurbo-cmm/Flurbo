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

`FLURBO_SETTLEMENT_BOT=true` and `FLURBO_NOTIFY_ENABLED=true` continue to drive closing, observation, proposal, and payout emails. Sender addresses and Resend keys stay as configured for the company site. Check `/healthz` for `hybrid_settlement` and `hybrid_arbitration` errors after enabling the catalog. A free Render instance can sleep; a ten-minute ping is helpful but cannot guarantee capturing a short source window. The source rule specifies the cutoff and VOID behavior, so widen the capture window for a real trial.

Run one company web instance for this testnet trial. The two hybrid workers serialize transactions from their shared Monad relay wallet inside that process. Multiple service instances using the same relay key need a distributed nonce coordinator or a single elected worker before they are enabled.

## Manual deployment sequence

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

## Git commands for you to run

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
