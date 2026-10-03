# Company testnet: one pool, two markets

This runbook is for `Flurbo-cmm/Flurbo` at `https://flurbopm.singu.online`. The hackathon site at `https://flurbo.singu.online` stays live. Use PowerShell for every command below; Git Bash needs `/c/Users/anany/...` paths instead of Windows backslashes. The operator, not the repository automation, commits, pushes, merges and signs transactions.

The company test reuses the existing Monad testnet deployer and test AUSD token. It creates a separate `PilotPool` and `PilotResolver`, three new reviewer wallets, a new settlement signer, a new pool registry, and separate hosted state. Reusing the deployer shares its AUSD balance and transaction nonce, so do not run deployments from that wallet concurrently. The two markets settle from a future Monad mainnet block's transaction count and gas used. Both use the existing `evm-rpc.v1` mechanical reader. This is a testnet exercise with a trusted single-operator reviewer panel, not an independent oracle.

## 1. Ship the company-only code with settlement off

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

Review the diff. The current `staging-domain` branch was already merged into `main`; create a new branch. `git add -u` stages only tracked changes, then add the two new generator files explicitly. The unrelated untracked `apps/mobile/` directory must stay untracked. Commit and push yourself, open a PR, wait for its checks, and merge it yourself. Pull the resulting `main` before preparing a market. Keep `FLURBO_SETTLEMENT_BOT=false` during this step.

```powershell
git switch -c company-one-pool
git add -u
git add workflows/cre/src/company-smoke.ts workflows/cre/scripts/create-company-smoke.ts
git diff --cached --check
git diff --cached --stat
git commit -m "Isolate company one-pool testnet"
git push -u origin company-one-pool
# After merging the PR on GitHub:
git switch main
git fetch origin
git merge --ff-only origin/main
```

In the **new Render service**, set these nonsecret values and redeploy after the merge:

```text
FLURBO_ORIGIN=https://flurbopm.singu.online
FLURBO_NETWORK=public_testnet
FLURBO_COLLECTIONS_SOURCE=registry
FLURBO_PILOT_DISABLED=true
FLURBO_SETTLEMENT_BOT=false
```

The initial `config/collections.json` is intentionally empty. `/healthz` must show `pilot_pool: disabled`, `learning_pool: unavailable`, `settlement_bot: disabled`, and no active practice collection. The company startup refuses the old pilot, and its monitor and worker can use only the company registry. Remove the copied `FLURBO_MANIFEST_JSON`, `FLURBO_PILOT_MANIFEST_JSON`, `FLURBO_PRACTICE_COLLECTIONS_JSON`, `FLURBO_PRACTICE_ACTIVE_POOL`, `FLURBO_RESOLUTION_MANIFEST_JSON`, `FLURBO_RESOLUTION_POOL`, `FLURBO_RESOLUTION_RULES_HASH`, `FLURBO_RESOLUTION_COLLECTIONS_JSON` and `FLURBO_RESOLUTION_FINISH_ALLOWLIST` variables from this Render service. Registry mode ignores most of them, but deleting them makes a later rollback less confusing. Do not delete values on the hackathon Render service.

Keep the **new** Upstash database. If `FLURBO_APPLICATIONS_ENABLED=true` or `FLURBO_SUPABASE_KV=true`, use a separate company Supabase project and its own URL/service key; run the repository SQL migrations there before switching. A shared Supabase project would mix application and KV state. Resend may use the existing verified sending domain, but use a new API key if you want independent usage and revocation. Create a separate Healthchecks.io check for the company bot.

If a copied `FLURBO_STARTER_PRIVATE_KEY` is present, remove it now. The company server accepts a starter wallet only when `FLURBO_COMPANY_STARTER_ADDRESS` matches the key. A new starter wallet is optional for the first pool test; members can use the official Monad testnet MON faucet.

## 2. Keep keys private and prepare public wallet selection

The existing deployer public address is `0xf1fea08ebba92ed342acc5639db312c3694bc391`. Confirm that your existing Foundry keystore signs for it. On this machine Foundry is under `%USERPROFILE%\.foundry\bin`:

```powershell
Set-Location C:\Users\anany\Flurbo-company
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
forge --version
cast --version
$deployerAccount = 'flurbo-testnet'  # replace only if your existing keystore has a different name
$env:FLURBO_DEPLOYER = '0xf1fea08ebba92ed342acc5639db312c3694bc391'
cast wallet address --account $deployerAccount
```

Create **one new settlement signer and three new reviewer wallets**. Run `cast wallet new` four times. Each call prints a private key: save it in a password manager or offline encrypted backup immediately, with its public address and purpose. Never put keys or passwords in a command argument, repository, `.env` committed to Git, chat, screenshot or shell transcript. If you want a separate starter wallet, run a fifth time. The reviewer addresses are public; their keys are needed only to cast votes if there is a dispute. These reviewers remain under one operator's control and must be disclosed as such.

```powershell
cast wallet new
cast wallet new
cast wallet new
cast wallet new
```

Enter only the three **new public reviewer addresses** into the selection file. The creator stays the old deployer. The file has no secrets and can be committed with the final market manifest.

```powershell
$reviewer1 = Read-Host 'New reviewer 1 public address'
$reviewer2 = Read-Host 'New reviewer 2 public address'
$reviewer3 = Read-Host 'New reviewer 3 public address'
@{ creator = $env:FLURBO_DEPLOYER; reviewers = @(
  @{ name = 'Company test reviewer 1'; address = $reviewer1 },
  @{ name = 'Company test reviewer 2'; address = $reviewer2 },
  @{ name = 'Company test reviewer 3'; address = $reviewer3 }
) } | ConvertTo-Json -Depth 5 | Set-Content config/company-testnet-selection.json
```

## 3. Generate and check exactly one future pool

Do this when ready to deploy within the next day. The generator refuses to overwrite an existing spec. It takes the current Monad mainnet block's transaction count and gas used as thresholds; the two answers come from the first finalized block at or after the future observation time. Trading closes at the next UTC hour at least 24 hours after generation. The source capture window starts six minutes after that close and lasts one hour. Review the generated questions and thresholds before signing. If the current block is unusually quiet, stop and choose a more representative observation period before committing. Do not regenerate a spec after deploying it.

```powershell
Set-Location C:\Users\anany\Flurbo-company
bun workflows/cre/scripts/create-company-smoke.ts
Get-Content config/markets/company-smoke-1.json
bun workflows/cre/scripts/batch.ts prepare --spec config/markets/company-smoke-1.json --selection config/company-testnet-selection.json
bun workflows/cre/scripts/batch.ts check --ids company-smoke-1
```

The `check` output must say `ready`, show one pool with `questions: 2`, and show at least **27.725888 test AUSD** plus **3 MON** in the deployer. The check script calculates the exact funding needed from the generated spec. Test AUSD and MON are test assets. If balances are low, use the existing testnet funding route or transfer test AUSD from a wallet you control to the deployer, then rerun `check`. Preserve `target/deployments/company-smoke-1-prepared.json` outside Git; it is ignored and binds the deployment to the reviewed rules.

## 4. Deploy the one contract pair

Verify the ignored `contracts/` checkout points to the pinned company contracts commit, and install its dependencies if needed. On a fresh checkout, clone the private `Flurbo-contracts` repo into `contracts/` first. The contracts folder is ignored in the web repository.

```powershell
if (-not (Test-Path contracts/.git)) { git clone https://github.com/Flurbo-cmm/Flurbo-contracts.git contracts }
git -C contracts fetch origin
git -C contracts switch --detach 9f2510eebbfe34f06809e3db5ed9d9010a018eae
git -C contracts rev-parse HEAD
npm --prefix contracts ci
$env:FOUNDRY_PROFILE = 'demo'
forge build
$env:FLURBO_DEPLOY_IDS = 'company-smoke-1'
forge script contracts/script/DeployPilotBatch.s.sol:DeployPilotBatch --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount --sender $env:FLURBO_DEPLOYER --broadcast --slow
bun workflows/cre/scripts/batch.ts verify --ids company-smoke-1
bun workflows/cre/scripts/batch.ts register --ids company-smoke-1 --settlement auto --feature company-smoke-1
```

`verify` checks the on-chain pool, resolver, funding, bytecode and rules. Do not register if it fails. The verified public manifest is copied into `config/collections.json` by `register`. Review that the registry has **one entry and two events**; commit and push the generated spec, public selection and registry yourself, wait for checks, merge and redeploy the company Render service:

```powershell
git switch -c company-smoke-listing
git add config/markets/company-smoke-1.json config/company-testnet-selection.json config/collections.json
git diff --cached --check
git diff --cached --stat
git commit -m "List verified company test pool"
git push -u origin company-smoke-listing
# After merging the PR on GitHub:
git switch main
git fetch origin
git merge --ff-only origin/main
```

Keep both `target/deployments/*-prepared.json` and `*-unverified.json` as private operational records. They contain public configuration and deployed addresses, but are needed to reproduce verification after a local reset. Never rerun the broadcast for the same ID.

### Optional: separate company test AUSD faucet

The test AUSD **token** remains the shared Monad testnet token. Until `FLURBO_TEST_AUSD_FAUCET` points at a new company faucet, `/fund` uses the existing public faucet and its per-wallet cooldown is shared with the hackathon site. To isolate distribution, deploy a fresh dispenser after the pool is funded. This creates no additional market pool. It needs at least 50 test AUSD for one claim; top it up as needed. Review the output and copy the new faucet address manually:

```powershell
$ausd = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc'
forge create contracts/src/TestAusdFaucet.sol:TestAusdFaucet --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount --broadcast --constructor-args $env:FLURBO_DEPLOYER
$companyFaucet = Read-Host 'New company faucet contract address from the deployment receipt'
cast call $companyFaucet 'owner()(address)' --rpc-url https://testnet-rpc.monad.xyz
cast send $ausd 'transfer(address,uint256)' $companyFaucet 50000000 --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount
cast call $ausd 'balanceOf(address)(uint256)' $companyFaucet --rpc-url https://testnet-rpc.monad.xyz
```

In Render set `FLURBO_TEST_AUSD_FAUCET` to that new address and redeploy. The deployer and token remain shared by explicit choice; the pool, resolver and faucet contract state are separate.

## 5. Enable a separate company monitor, then settlement

Fund the **new** settlement signer with test MON and at least **2 test AUSD** for two one-AUSD assertion bonds; keep a margin (for example 10 AUSD and several MON) for retries and gas. It must have no positions in this pool. If transferring from the old deployer, use its keystore and the public signer address. This moves only test assets; it does not touch an old pool:

```powershell
$signerAddress = Read-Host 'New settlement signer public address'
$ausd = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc'
cast send $ausd 'transfer(address,uint256)' $signerAddress 10000000 --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount
cast send $signerAddress --value 3ether --rpc-url https://testnet-rpc.monad.xyz --account $deployerAccount
cast call $ausd 'balanceOf(address)(uint256)' $signerAddress --rpc-url https://testnet-rpc.monad.xyz
cast balance $signerAddress --rpc-url https://testnet-rpc.monad.xyz
```

If a dispute must be tested, fund each reviewer with test MON from the official faucet or from the deployer and import that reviewer's key into a wallet you control. Keep those reviewer keys separate from the settlement signer and trading wallet.

If you choose to enable the optional company starter grant, use the fifth new wallet mentioned above, fund it with test MON, and set **both** `FLURBO_STARTER_PRIVATE_KEY` (hidden secret) and matching public `FLURBO_COMPANY_STARTER_ADDRESS` in the company Render service. Set a small `FLURBO_STARTER_DAILY_LIMIT` during testing. Do not reuse the hackathon starter key.

Configure the **company Render service only** with these values. Enter the signer key as a hidden Render secret, not in a shell command or file in Git. Use a separate company Healthchecks.io UUID. The monitor's Resend sender must be verified for the API key. Keep `FLURBO_RESOLUTION_EXECUTE=false` at first; observe a healthy monitor and worker dry run in `/healthz` and logs. Then set `FLURBO_RESOLUTION_EXECUTE=true` before the observation window. The bot is always limited by the one-pool registry; the hackathon bot can keep running on its own pools and signer.

```text
FLURBO_SETTLEMENT_BOT=true
FLURBO_MONITOR_ENABLED=true
FLURBO_RESOLUTION_ENABLED=true
FLURBO_RESOLUTION_PROPOSALS=true
FLURBO_RESOLUTION_EXECUTE=false   # change to true only after the dry run
FLURBO_RESOLUTION_SIGNER_ADDRESS=<new public signer address>
FLURBO_RESOLUTION_PRIVATE_KEY=<new signer private key; hidden Render secret>
FLURBO_RESOLUTION_EVIDENCE_ORIGIN=https://flurbopm.singu.online
FLURBO_MONITOR_RESEND_KEY=<Resend API key; hidden Render secret>
FLURBO_MONITOR_EMAIL_FROM=<verified sender>
FLURBO_MONITOR_EMAIL_TO=<operator inbox>
FLURBO_MONITOR_HEALTHCHECK_URL=<new company hc-ping.com UUID URL>
```

Keep the new Upstash REST URL/token, Supabase service key, Resend keys, account invite-code secret, signer key, reviewer keys, any starter key, deployer keystore and all keystore passwords in your secret inventory. The RPC URL may contain a provider token and should be treated as a secret. Save Render environment exports outside Git. Public addresses, pool/resolver addresses, hashes and receipts are safe to record. Never use the old settlement key on this service.

The in-process bot runs only while the Render web instance is awake. Give the company site its own reliable periodic `/healthz` wakeup or use an always-on instance, and let the new Healthchecks.io check alert if bot pings stop. Do not point the hackathon site's wakeup or watchdog at the company hostname.

Check `https://flurbopm.singu.online/healthz` after each redeploy. It should show one configured practice collection, the new pool address, and a running bot after activation. Trade a small amount using a separate MetaMask trading wallet, then compare balances and positions on the hackathon site: the new pool must appear only on the company site. Settlement takes at least the observation window plus the one-hour challenge period and chain transactions; disputes or missing evidence take longer or can VOID. A successful `/healthz` is liveness, not proof of a completed settlement. Keep the bot and new signer funded until both markets are final and payouts delivered.
