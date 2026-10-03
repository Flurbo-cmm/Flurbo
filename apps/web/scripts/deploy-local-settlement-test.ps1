param([string]$Account='flurbo-testnet')
$ErrorActionPreference='Stop'
$rehearsalRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$rehearsalDirectory=Join-Path $rehearsalRoot 'target/local-settlement-rehearsal/live-source-test'
$rehearsalRpc='https://testnet-rpc.monad.xyz'
$rehearsalCash='0xa9012a055bd4e0edff8ce09f960291c09d5322dc'
$rehearsalCast=Join-Path $env:USERPROFILE '.foundry/bin/cast.exe'
$rehearsalForge=Join-Path $env:USERPROFILE '.foundry/bin/forge.exe'
$rehearsalBun=Join-Path $env:USERPROFILE '.bun/bin/bun.exe'
$rehearsalCompiler=Join-Path $rehearsalRoot 'target/tools/solc-0.8.28.exe'
if ($Account -notmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'Use a named local Foundry keystore.' }
foreach($rehearsalTool in @($rehearsalCast,$rehearsalForge,$rehearsalBun,$rehearsalCompiler)) { if (!(Test-Path -LiteralPath $rehearsalTool)) { throw 'A required local deployment tool is missing.' } }
$rehearsalSelection=Get-Content -LiteralPath (Join-Path $rehearsalRoot 'config/pilot-alpha-selection.json') -Raw | ConvertFrom-Json
$rehearsalWallet=Get-Content -LiteralPath (Join-Path $rehearsalDirectory 'signer.dpapi.json') -Raw | ConvertFrom-Json
$rehearsalBootstrap=Get-Content -LiteralPath (Join-Path $rehearsalDirectory 'bootstrap.json') -Raw | ConvertFrom-Json
if ($rehearsalBootstrap.schema -ne 'flurbo.rehearsal-bootstrap.v1' -or $rehearsalBootstrap.signerAddress -cne $rehearsalWallet.address) { throw 'The public rehearsal bootstrap does not match the dedicated signer.' }
$rehearsalEvidenceUri=[Uri]$rehearsalBootstrap.evidenceOrigin
if ($rehearsalEvidenceUri.Scheme -ne 'https' -or $rehearsalEvidenceUri.UserInfo -or $rehearsalEvidenceUri.AbsolutePath -ne '/' -or $rehearsalEvidenceUri.Query -or $rehearsalEvidenceUri.Fragment) { throw 'Public HTTPS evidence origin required.' }
$rehearsalHealth=Invoke-RestMethod -Uri ($rehearsalBootstrap.evidenceOrigin+'/healthz') -TimeoutSec 20 -MaximumRedirection 0
if ($rehearsalHealth.service -ne 'flurbo-rehearsal-public-evidence' -or $rehearsalHealth.readOnly -ne $true) { throw 'The public readonly evidence gateway must be reachable before deployment.' }
if ($rehearsalWallet.schema -ne 'flurbo.local-rehearsal-signer.v1' -or $rehearsalWallet.address -notmatch '^0x[0-9a-f]{40}$') { throw 'Initialize the dedicated rehearsal bot first.' }
if ($rehearsalWallet.address -eq $rehearsalSelection.creator -or $rehearsalWallet.address -in $rehearsalSelection.reviewers.address) { throw 'The bot must be separate from creator and reviewers.' }
if (Test-Path -LiteralPath (Join-Path $rehearsalRoot 'target/deployments/deterministic-test-unverified.json')) { throw 'A deployment already exists. Inspect and verify it; do not redeploy.' }

Push-Location $rehearsalRoot
$rehearsalPriorDeployer=$env:FLURBO_DEPLOYER
$rehearsalPriorRpc=$env:FLURBO_ALCHEMY_TESTNET_RPC_URL
$rehearsalPriorProfile=$env:FOUNDRY_PROFILE
try {
  $env:FOUNDRY_PROFILE='demo'
  # The password is entered into Foundry's terminal prompt, never into chat or a file.
  $rehearsalAddress=(& $rehearsalCast wallet address --account $Account).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $rehearsalAddress -cne $rehearsalSelection.creator) { throw 'This keystore does not match the reviewed test deployer.' }
  $rehearsalChain=& $rehearsalCast chain-id --rpc-url $rehearsalRpc
  if ($LASTEXITCODE -ne 0 -or "$rehearsalChain".Trim() -ne '10143') { throw 'Public Monad testnet required.' }
  Write-Host 'This deploys a NEW official-source Test collection on Monad testnet. Existing pools and production settings are unchanged.'
  Write-Host ('Dedicated bot: '+$rehearsalWallet.address)
  $rehearsalGas=& $rehearsalCast balance $rehearsalWallet.address --rpc-url $rehearsalRpc
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read bot gas.' }
  # Eight bounded approval/assert/finalize/deliver actions can each reserve up
  # to 0.1 test MON. Fund the complete lifecycle, not only its first call.
  $rehearsalGasReserve=[Numerics.BigInteger]::Parse('1000000000000000000')
  $rehearsalGasAvailable=[Numerics.BigInteger]::Parse("$rehearsalGas".Trim())
  if ($rehearsalGasAvailable -lt $rehearsalGasReserve) {
    $rehearsalGasTopUp=($rehearsalGasReserve-$rehearsalGasAvailable).ToString()
    & $rehearsalCast send $rehearsalWallet.address --value $rehearsalGasTopUp --account $Account --rpc-url $rehearsalRpc --confirmations 2
    if ($LASTEXITCODE -ne 0) { throw 'Bot test MON funding failed.' }
  }
  $rehearsalCashBalance=& $rehearsalCast call $rehearsalCash 'balanceOf(address)(uint256)' $rehearsalWallet.address --rpc-url $rehearsalRpc
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read bot collateral.' }
  if ([Numerics.BigInteger]::Parse(("$rehearsalCashBalance".Trim() -split '\s+')[0]) -lt 2000000) {
    & $rehearsalCast send $rehearsalCash 'transfer(address,uint256)(bool)' $rehearsalWallet.address 2000000 --account $Account --rpc-url $rehearsalRpc --confirmations 2
    if ($LASTEXITCODE -ne 0) { throw 'Bot test AUSD funding failed.' }
  }
  # Compile before preparation so compiler latency cannot consume the deployment margin.
  & $rehearsalForge build --use $rehearsalCompiler
  if ($LASTEXITCODE -ne 0) { throw 'Deployment compilation failed.' }
  & $rehearsalBun workflows/cre/scripts/prepare-deterministic-test.ts --prepare
  if ($LASTEXITCODE -ne 0) { throw 'Preparation failed. Preserve artifacts and inspect the immutable deadlines.' }
  $env:FLURBO_DEPLOYER=$rehearsalSelection.creator
  $env:FLURBO_ALCHEMY_TESTNET_RPC_URL=$rehearsalRpc
  & $rehearsalForge script contracts/script/DeployDeterministicTest.s.sol:DeployDeterministicTest --use $rehearsalCompiler --rpc-url $rehearsalRpc --account $Account --sender $env:FLURBO_DEPLOYER --broadcast --slow
  if ($LASTEXITCODE -ne 0) { throw 'Deployment did not complete. Preserve broadcast files and inspect receipts before retrying.' }
  & $rehearsalBun workflows/cre/scripts/verify-pilot.ts --deterministic-test
  if ($LASTEXITCODE -ne 0) { throw 'Deployment verification failed. Do not trade or start the worker.' }
  Write-Host 'Fresh deployment verified. Return to Codex to connect the local website, evidence gateway and worker, then place a test trade.'
} finally {
  $env:FLURBO_DEPLOYER=$rehearsalPriorDeployer
  $env:FLURBO_ALCHEMY_TESTNET_RPC_URL=$rehearsalPriorRpc
  $env:FOUNDRY_PROFILE=$rehearsalPriorProfile
  Pop-Location
}
