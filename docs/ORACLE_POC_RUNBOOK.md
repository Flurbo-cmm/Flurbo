# Reality.eth and Kleros testnet pool runbook

Status: the two-question pool and relay are deployed on the company testnet site. The unified Markets view and member notice changes in this branch still need the user's commit, merge, and Render deployment. This is a testnet proof of concept with a trusted Sepolia-to-Monad relay.

## What ships

- The existing company pool and its settlement bot remain in place. New questions use a separate `WidePilotPool` and `WidePilotResolver` at protocol version 3. The new resolver has no Flurbo reviewer panel. The dedicated relay is its only privileged reporter.
- The two new questions appear beside the existing pool on `/markets`, with the same question cards, status filters, and one-share Yes and No quotes. Each opens at `/markets/oracle/<id>`. Existing `/oracle` links redirect to Markets. After Flurbo sign-in, MetaMask can submit Reality YES, NO, or VOID answers and ETH bonds, challenge an answer through Kleros, publish evidence, contribute to an appeal, report a completed Kleros ruling to Reality when needed, process winning answer bonds, claim available appeal rewards, and withdraw credited Reality ETH without leaving Flurbo. Resolution controls appear only in their relevant stage. The same market page can approve test AUSD, buy, sell, and redeem claims containing one to three YES or NO outcomes from the new pool.
- Connecting MetaMask links the wallet to the signed-in Flurbo account through the existing wallet signature flow. Member email preferences and unsubscribe links also cover this pool. The notice worker indexes its on-chain trades, confirms current holdings, and sends the existing closing, proposed-answer, and payout notices. Its initial index catch-up may take several settlement-bot cycles. The payout email links to a question in the member's winning claim, where those shares can be redeemed.
- The relay worker reads the final Reality answer at a finalized Sepolia block, verifies the committed question and new pool, writes immutable public evidence to the company Redis store, and reports the outcome on Monad. It voids an event after its report deadline if no final answer was reported. Once all events are final or void, it calls `deliver`.
- The Monad resolver authenticates the relay address and checks its report window. It cannot prove Sepolia state. A compromised relay can misreport a result. Do not represent this proof of concept as trustless or real-money ready.

The pinned Sepolia Kleros proxy is `0x05b942faecfb3924970e3a28e0f230910cedff45`. Its on-chain `realitio()` points to `0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA`. The Monad test AUSD is `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`. The deployment verifier rejects a substituted contract, question receipt, question text, content hash, arbitrator, source settings, pool, resolver, relay, rules hash, collateral, or event hash.

## Costs and timing

Sepolia ETH pays question gas, answer bonds, Kleros dispute fees, and any appeal contribution. Monad testnet MON pays new pool deployment and relay reports. Test AUSD supplies the new pool and purchases. Public RPC and existing Redis may suffice for a small proof of concept, but reliable Sepolia RPC and Render uptime matter for an unattended relay. No real-money funds are involved. The dispute fee is read live because it can change.

An unchallenged answer becomes final after the question timeout. An arbitration can take much longer. `reportPeriod` must cover the timeout, Kleros case and appeals, source finality, and outages. The pool can deliver only when all its questions are final or void. Use a small two-question pool first. Although the contracts support up to 32 base questions, each claim references at most three and no full 2^32 state space is enumerated.

## Operator sequence

These commands are for PowerShell 7. Run them yourself. Keep passwords and private keys out of JSON, Git, screenshots, and chat. Do not reuse the old pool's resolution private key for the new relay.

### 1. Prepare wallets and RPCs

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
$company = 'C:\Users\anany\Flurbo-company'
$contracts = 'C:\Users\anany\Flurbo-contracts'
$monadRpc = 'https://testnet-rpc.monad.xyz'
$sepoliaRpc = 'https://ethereum-sepolia-rpc.publicnode.com'
$deployerAccount = 'flurbo-testnet'
$deployer = cast wallet address --account $deployerAccount
$reality = '0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA'
$kleros = '0x05b942faecfb3924970e3a28e0f230910cedff45'
$env:FLURBO_SEPOLIA_RPC_URL = $sepoliaRpc
$env:FLURBO_TESTNET_RPC_URL = $monadRpc
$env:FLURBO_ORIGIN = 'https://flurbopm.singu.online'

cast wallet new "$env:USERPROFILE\.foundry\keystores" flurbo-oracle-relay
$relay = cast wallet address --account flurbo-oracle-relay
cast send $relay --value 2ether --rpc-url $monadRpc --account $deployerAccount
cast balance $relay --rpc-url $monadRpc
cast balance $deployer --rpc-url $sepoliaRpc
cast call 0xa9012a055bd4e0edff8ce09f960291c09d5322dc 'balanceOf(address)(uint256)' $deployer --rpc-url $monadRpc
```

The Sepolia balance must cover two question transactions. The final `cast call` prints the deployer's test AUSD balance in six-decimal atoms; the deployment script checks that it covers the pool's required funding. For a larger pool, estimate report and delivery gas and top up the relay again. To test a dispute from a user wallet, that wallet also needs enough Sepolia ETH for the live Kleros fee. Use a private RPC if the public endpoint rate limits the relay.

### 2. Ask exactly two Boolean questions on Sepolia

The two sample questions below resolve from one future, finalized Sepolia block. The canonical finalized block is the correction policy, and unavailable finalized data at the opening time means VOID. Review the exact titles before asking, and keep them unchanged in the publication. The Reality template delimiter is `␟` (U+241F).

```powershell
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$close = $now + 21600
$opening = $close + 3600
$timeout = 3600
$minBond = '100000000000000'
$closeIso = [DateTimeOffset]::FromUnixTimeSeconds($close).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
$openingIso = 
[DateTimeOffset]::FromUnixTimeSeconds($opening).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
$title1 = "Will the first canonical finalized Sepolia block with timestamp at or after $closeIso have an even block number? Read Sepolia eth_getBlockByNumber. VOID if no such finalized block is available by $openingIso."
$title2 = "Will the first canonical finalized Sepolia block with timestamp at or after $closeIso contain at least one transaction? Read Sepolia eth_getBlockByNumber. VOID if no such finalized block is available by $openingIso."
$separator = [char]0x241F
$text1 = "$title1$separator" + "flurbo-poc$separator" + 'en'
$text2 = "$title2$separator" + "flurbo-poc$separator" + 'en'

cast send $reality 'askQuestionWithMinBond(uint256,string,address,uint32,uint32,uint256,uint256)' 0 $text1 $kleros $timeout $opening 101 $minBond --value 0 --rpc-url $sepoliaRpc --account $deployerAccount
cast send $reality 'askQuestionWithMinBond(uint256,string,address,uint32,uint32,uint256,uint256)' 0 $text2 $kleros $timeout $opening 102 $minBond --value 0 --rpc-url $sepoliaRpc --account $deployerAccount
```

Copy the two transaction hashes from the output. If the proxy's per-question fee is nonzero, a `--value 0` call will revert; query the live fee and rerun with the required Sepolia ETH. Do not reuse the same nonce and text after a successful ask.

```powershell
$questionTx1 = '<first Sepolia transaction hash>'
$questionTx2 = '<second Sepolia transaction hash>'
New-Item -ItemType Directory -Force "$contracts\target\deployments" | Out-Null
Set-Location $company
node apps/web/scripts/inspect-reality-question.mjs $questionTx1 $deployer $title1 $opening | Set-Content -Encoding utf8 "$contracts\target\deployments\source-1.json"
node apps/web/scripts/inspect-reality-question.mjs $questionTx2 $deployer $title2 $opening | Set-Content -Encoding utf8 "$contracts\target\deployments\source-2.json"
$source1 = Get-Content "$contracts\target\deployments\source-1.json" -Raw | ConvertFrom-Json
$source2 = Get-Content "$contracts\target\deployments\source-2.json" -Raw | ConvertFrom-Json
```

The inspector checks the successful Reality receipt, exact title, creator, Kleros proxy, opening time, timeout, and minimum bond. Review the returned question IDs and content hashes. The `target/deployments` files are local artifacts and are not committed.

### 3. Prepare and deploy the separate Monad pool

```powershell
$publication = @{
  schema = 'flurbo.wide-publication.v3'; chainId = 10143
  trustModel = 'trusted-source-relay'; rulesReviewed = $true
  creator = $deployer; relay = $relay; title = 'Flurbo oracle test pool'
  closesAt = $close; reportPeriod = 7776000; liquidityAtoms = '10000000'
  events = @(
    @{ id = 'source-question-1'; question = $title1; observationEndsAt = $opening; source = $source1 },
    @{ id = 'source-question-2'; question = $title2; observationEndsAt = $opening; source = $source2 }
  )
}
$draft = "$contracts\target\deployments\wide-pilot-input.json"
$prepared = "$contracts\target\deployments\wide-pilot-prepared.json"
$unverified = "$contracts\target\deployments\wide-pilot-unverified.json"
$candidate = "$contracts\target\deployments\oracle-catalog-candidate.json"
$publication | ConvertTo-Json -Depth 25 | Set-Content -Encoding utf8 $draft
Set-Location $company
node apps/web/scripts/prepare-wide-pilot.mjs $draft $prepared

Set-Location $contracts
$env:FOUNDRY_PROFILE = 'demo'
$env:FLURBO_DEPLOYER = $deployer
forge build --offline
forge test --offline --match-contract WidePilotLifecycleTest
forge script script/DeployWidePilot.s.sol:DeployWidePilot --rpc-url $monadRpc --account $deployerAccount --sender $deployer --broadcast --slow
```

If a prior attempt succeeded on chain but timed out locally, inspect the Foundry broadcast JSON before retrying. The deployment script refuses to overwrite an existing unverified manifest. A fresh pool needs fresh question IDs and a new publication.

### 4. Verify and register

```powershell
Set-Location $company
node apps/web/scripts/register-oracle-pool.mjs $prepared $unverified $candidate
Get-Content $candidate
Copy-Item -LiteralPath $candidate -Destination 'config\oracle-markets.json'
```

Registration records the pool's deployment block for the member notice trade index and verifies contract code at that block and its predecessor. If the RPC cannot search historical code, set `FLURBO_ORACLE_DEPLOYMENT_BLOCK` locally to the exact pool creation block from the Foundry receipt, then rerun registration. This value is public chain metadata, not a Render secret. The current two-question pool was deployed at Monad testnet block `67970042`.

Registration checks the Reality question creation receipts, exact text and opening times, and live Sepolia and Monad contract getters. It writes a candidate. Review it before copying it to the tracked catalog. The old `config/collections.json` entry stays unchanged. No new pool is served until the catalog is deployed.

### 5. Deploy the web branch and relay

On the **company** Render service, retain the existing origin, Monad RPC, Redis, application, faucet, and old settlement settings. Add:

| Variable | Value |
| --- | --- |
| `FLURBO_SEPOLIA_RPC_URL` | Reliable Sepolia HTTPS RPC, no URL with an embedded secret in Git |
| `FLURBO_ORACLE_RELAY_ENABLED` | `true` after the catalog and relay key are ready |
| `FLURBO_ORACLE_RELAY_PRIVATE_KEY` | Raw private key for the **new** `flurbo-oracle-relay` keystore, entered only in Render's secret field |

Member notices for both pools use the existing `FLURBO_SETTLEMENT_BOT=true`, `FLURBO_NOTIFY_ENABLED=true`, `FLURBO_APPLICATIONS_RESEND_KEY`, and `FLURBO_APPLICATIONS_EMAIL_FROM` settings. No second email key or sender is needed for the new pool. The Monad relay does not post the first Reality.eth answer. See [ORACLE_AUTO_ANSWER.md](ORACLE_AUTO_ANSWER.md) for the separate source reader and Sepolia answer signer.

To retrieve the key for Render, run `cast wallet decrypt-keystore flurbo-oracle-relay` locally and enter its hidden password. Do not paste the output into chat, a file, or a Git command. Record the encrypted keystore and its password in your own secure backup. Fund the relay's public address with Monad testnet MON. The service refuses to start the relay if the private key does not match every registered route.

After the user merges the branch and Render deploys, open `/healthz` and check `oracle_relay.enabled`, `oracle_relay.signer`, and route count. Sign in on `/markets` and confirm the old pool plus both new questions appear together. Open one of the new questions, connect MetaMask, and test an answer bond on Sepolia after its opening time. Once an answer exists, **Challenge this answer** prepares a Kleros arbitration request before finalization; the displayed fee is read from the pinned proxy. The optional counteranswer uses a larger Reality bond and does not start Kleros. Public evidence is submitted from the same market page. Appeal funding is simulated against the proxy before signing. If the Kleros request shows **Ruled** but Reality still shows arbitration pending, use **Complete Kleros ruling** on Flurbo. Flurbo checks the Reality answer history and simulates the proxy call before MetaMask signs. After Reality is final, use **Claim answer bonds** if this wallet posted an answer, then withdraw credited Reality ETH from the wallet panel. The relay reports the final answer to Monad and delivers the pool when every question is ready. It does not force a result while Kleros is active. Test a single-outcome purchase, a two-outcome purchase, redemption after delivery, and member notices to a verified holder email with its normal preferences and unsubscribe link.

The Kleros proxy and Reality contracts remain external services. Flurbo users remain in Flurbo for bonds, arbitration requests, evidence, appeals, ruling reports, and claims, but MetaMask prompts are still required. Kleros jurors vote in Kleros Court; juror participation is outside this user workflow. Public evidence is content addressed in the company Redis store; keep that store available throughout disputes and appeals. For production, publish durable evidence to IPFS or equivalent storage. The company site's trusted relay is the PoC boundary. A production design should use a compatible same-chain Reality and Kleros deployment, or an authenticated cross-chain proof receiver before removing this trust.

