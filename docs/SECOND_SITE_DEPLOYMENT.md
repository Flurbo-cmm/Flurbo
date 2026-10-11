# Company testnet site

This runbook is for `Flurbo-cmm/Flurbo` at `https://flurbopm.singu.online`. The hackathon site at `https://flurbo.singu.online` stays live and separate. Use PowerShell for every command below; Git Bash needs `/c/Users/anany/...` paths instead of Windows backslashes. The operator, not the repository automation, commits, pushes, merges and signs transactions.

The company site reuses the existing Monad testnet deployer and test AUSD token, with its own Render service, pool registries and hosted state. Reusing the deployer shares its AUSD balance and transaction nonce, so do not run deployments from that wallet concurrently. Markets are hybrid pools (`config/hybrid-markets.json`) and oracle pools (`config/oracle-markets.json`). The earlier company pilot pool stays on chain but is no longer served, because the pilot pool generation is retired. Everything here uses test assets only.

## 1. Ship the code

From the **company checkout**:

```powershell
Set-Location C:\Users\anany\Flurbo-company
git status --short --branch
npm --prefix apps/web ci
Push-Location workflows/cre
bun install --frozen-lockfile
bun test
bun run typecheck
Pop-Location
npm --prefix apps/web run typecheck
npm --prefix apps/web test
```

Review the diff and create a new branch. Stage files explicitly; the unrelated untracked `apps/mobile/` directory must stay untracked. Commit and push yourself, open a PR, wait for its checks, and merge it yourself. Pull the resulting `main` before preparing a market.

In the **company Render service**, set these nonsecret values and redeploy after the merge:

```text
FLURBO_ORIGIN=https://flurbopm.singu.online
FLURBO_NETWORK=public_testnet
FLURBO_SCHEDULER=false
```

`/healthz` must show `scheduler: disabled` until you enable it in step 4. Remove the variables the code no longer reads; the list is in [the project reference](PROJECT_REFERENCE.md#environment-inventory). Do not delete values on the hackathon Render service.

Keep the **company** Upstash database. If `FLURBO_APPLICATIONS_ENABLED=true` or `FLURBO_SUPABASE_KV=true`, use a separate company Supabase project and its own URL/service key; run the repository SQL migrations there before switching. A shared Supabase project would mix application and KV state. Resend may use the existing verified sending domain, but use a new API key if you want independent usage and revocation.

If a copied `FLURBO_STARTER_PRIVATE_KEY` is present, remove it now. The company server accepts a starter wallet only when `FLURBO_COMPANY_STARTER_ADDRESS` matches the key. A new starter wallet is optional; members can use the official Monad testnet MON faucet.

## 2. Keep keys private

The existing deployer public address is `0xf1fea08ebba92ed342acc5639db312c3694bc391`. Confirm that your existing Foundry keystore signs for it. On this machine Foundry is under `%USERPROFILE%\.foundry\bin`:

```powershell
Set-Location C:\Users\anany\Flurbo-company
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
forge --version
cast --version
$deployerAccount = 'flurbo-testnet'  # replace only if your existing keystore has a different name
$deployer = '0xf1fea08ebba92ed342acc5639db312c3694bc391'
cast wallet address --account $deployerAccount
```

The hybrid and oracle runbooks name the extra wallets each pool needs (settlement, relay, answer and keeper wallets). Create each one with `cast wallet new` and save its private key in a password manager or offline encrypted backup immediately, with its public address and purpose. Never put keys or passwords in a command argument, repository, `.env` committed to Git, chat, screenshot or shell transcript.

## 3. Markets

Prepare, deploy and register hybrid pools with [the hybrid testnet runbook](HYBRID_TESTNET_RUNBOOK.md) and oracle pools with [the oracle runbook](ORACLE_POC_RUNBOOK.md). Registration writes the registry entry from on-chain checks; review the diff, commit it yourself, merge and redeploy the company Render service. Keep the prepared and unverified deployment files as private operational records, and never rerun a broadcast for a registered pool id. Hybrid pools with 2 to 4 questions also appear to agents as `practice-<pool address without 0x>`.

### Optional: separate company test AUSD faucet

The test AUSD **token** remains the shared Monad testnet token. Until `FLURBO_TEST_AUSD_FAUCET` points at a new company faucet, `/fund` uses the existing public faucet and its per-wallet cooldown is shared with the hackathon site. To isolate distribution, deploy a fresh dispenser. This creates no market pool. It needs at least 50 test AUSD for one claim; top it up as needed. Build the ignored `contracts/` checkout at the commit pinned in `.github/workflows/checks.yml` first, then review the output and copy the new faucet address manually:

```powershell
if (-not (Test-Path contracts/.git)) { git clone https://github.com/Flurbo-cmm/Flurbo-contracts.git contracts }
git -C contracts fetch origin
git -C contracts switch --detach <commit pinned in .github/workflows/checks.yml>
npm --prefix contracts ci
$env:FOUNDRY_PROFILE = 'demo'
forge build
$ausd = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc'
forge create contracts/src/TestAusdFaucet.sol:TestAusdFaucet --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount --broadcast --constructor-args $deployer
$companyFaucet = Read-Host 'New company faucet contract address from the deployment receipt'
cast call $companyFaucet 'owner()(address)' --rpc-url https://testnet-rpc.monad.xyz
cast send $ausd 'transfer(address,uint256)' $companyFaucet 50000000 --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount
cast call $ausd 'balanceOf(address)(uint256)' $companyFaucet --rpc-url https://testnet-rpc.monad.xyz
```

In Render set `FLURBO_TEST_AUSD_FAUCET` to that new address and redeploy. The deployer and token remain shared by explicit choice; the pools and faucet contract state are separate.

## 4. Scheduler, workers and notices

The hybrid settlement, arbitration, court and alert workers and the oracle relay and answerer start when their variables are set (see the runbooks). Set `FLURBO_SCHEDULER=true` to run the scheduler every 2 minutes: it retries agent pools whose deployment anchor could not be read yet, advances the operator metrics scan, checks funding balances and, with `FLURBO_NOTIFY_ENABLED=true`, sends member notices. `FLURBO_SETTLEMENT_BOT=true` is still accepted as a legacy alias and logs a warning. Hybrid operator alerts use `FLURBO_MONITOR_RESEND_KEY` (hidden Render secret), `FLURBO_MONITOR_EMAIL_FROM` and `FLURBO_MONITOR_EMAIL_TO`; the sender must be verified for the API key.

If you choose to enable the optional company starter grant, use a new wallet, fund it with test MON, and set **both** `FLURBO_STARTER_PRIVATE_KEY` (hidden secret) and matching public `FLURBO_COMPANY_STARTER_ADDRESS` in the company Render service. Set a small `FLURBO_STARTER_DAILY_LIMIT` during testing. Do not reuse the hackathon starter key.

Keep the Upstash REST URL/token, Supabase service key, Resend keys, account invite-code secret, worker wallet keys, any starter key, deployer keystore and all keystore passwords in your secret inventory. The RPC URL may contain a provider token and should be treated as a secret. Save Render environment exports outside Git. Public addresses, pool and resolver addresses, hashes and receipts are safe to record.

The in-process workers and scheduler run only while the Render web instance is awake. Give the company site its own reliable periodic `/healthz` wakeup or use an always-on instance. Do not point the hackathon site's wakeup or watchdog at the company hostname.

Check `https://flurbopm.singu.online/healthz` after each redeploy: `scheduler`, `agent_pools`, `hybrid_settlement`, `hybrid_arbitration`, `hybrid_court`, `oracle_relay` and `oracle_answerer` should report no errors. A successful `/healthz` is liveness, not proof of a completed settlement. Trade a small amount using a separate MetaMask trading wallet and confirm the pool appears only on the company site.
