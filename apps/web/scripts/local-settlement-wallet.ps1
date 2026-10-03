param(
  [ValidateSet('initialize','run')][string]$Mode = 'initialize',
  [string]$ConfigPath,
  [string]$StateDirectory = 'target/local-settlement-rehearsal/live-source-test'
)
$ErrorActionPreference = 'Stop'
$rehearsalRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$rehearsalBase = [IO.Path]::GetFullPath((Join-Path $rehearsalRoot 'target/local-settlement-rehearsal'))
$rehearsalDirectory = [IO.Path]::GetFullPath((Join-Path $rehearsalRoot $StateDirectory))
if (!$rehearsalDirectory.StartsWith($rehearsalBase + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'An isolated rehearsal directory is required.' }
[IO.Directory]::CreateDirectory($rehearsalDirectory) | Out-Null
if ((Get-Item -LiteralPath $rehearsalDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed.' }
$rehearsalWalletPath = Join-Path $rehearsalDirectory 'signer.dpapi.json'
$rehearsalNode = (Get-Command node -ErrorAction Stop).Source

if ($Mode -eq 'initialize') {
  if (!(Test-Path -LiteralPath $rehearsalWalletPath)) {
    Push-Location (Join-Path $rehearsalRoot 'apps/web')
    try {
      # Captured directly in this process. Never echo raw material or pass it as a CLI argument.
      $rehearsalMaterial = & $rehearsalNode --input-type=module -e "import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';const key=generatePrivateKey();process.stdout.write(JSON.stringify({key,address:privateKeyToAccount(key).address.toLowerCase()}));" | ConvertFrom-Json
      if ($LASTEXITCODE -ne 0 -or $rehearsalMaterial.key -notmatch '^0x[0-9a-f]{64}$') { throw 'Wallet generation failed.' }
      $rehearsalProtected = ConvertFrom-SecureString (ConvertTo-SecureString $rehearsalMaterial.key -AsPlainText -Force)
      $rehearsalRecord = @{schema='flurbo.local-rehearsal-signer.v1';address=$rehearsalMaterial.address;protectedKey=$rehearsalProtected} | ConvertTo-Json
      $rehearsalFile = [IO.File]::Open($rehearsalWalletPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $rehearsalBytes=[Text.Encoding]::UTF8.GetBytes($rehearsalRecord);$rehearsalFile.Write($rehearsalBytes,0,$rehearsalBytes.Length);$rehearsalFile.Flush($true) } finally { $rehearsalFile.Dispose() }
    } finally { $rehearsalMaterial=$null;$rehearsalRecord=$null;$rehearsalProtected=$null;Pop-Location }
  }
  $rehearsalWallet = Get-Content -LiteralPath $rehearsalWalletPath -Raw | ConvertFrom-Json
  if ($rehearsalWallet.schema -ne 'flurbo.local-rehearsal-signer.v1' -or $rehearsalWallet.address -notmatch '^0x[0-9a-f]{40}$') { throw 'Invalid signer record.' }
  @{address=$rehearsalWallet.address;network='Monad testnet only';protection='Windows DPAPI current user';notice='Dedicated settlement bot. Do not trade from this address. Needs test MON gas and two test AUSD bonds.'} | ConvertTo-Json
  exit
}

if (!$ConfigPath) { throw 'A reviewed rehearsal config is required.' }
$rehearsalConfigFile = [IO.Path]::GetFullPath((Join-Path $rehearsalRoot $ConfigPath))
$rehearsalConfig = Get-Content -LiteralPath $rehearsalConfigFile -Raw | ConvertFrom-Json
$rehearsalWallet = Get-Content -LiteralPath $rehearsalWalletPath -Raw | ConvertFrom-Json
if ($rehearsalWallet.schema -ne 'flurbo.local-rehearsal-signer.v1' -or $rehearsalConfig.signerAddress -cne $rehearsalWallet.address -or [IO.Path]::GetFullPath((Join-Path $rehearsalRoot $rehearsalConfig.stateDirectory)) -ne $rehearsalDirectory) { throw 'Signer or state directory does not match the rehearsal.' }
$rehearsalSecret = ConvertTo-SecureString $rehearsalWallet.protectedKey
$rehearsalPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($rehearsalSecret)
$rehearsalPriorKey = $env:FLURBO_REHEARSAL_PRIVATE_KEY
try {
  $env:FLURBO_REHEARSAL_PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($rehearsalPointer)
  & $rehearsalNode (Join-Path $PSScriptRoot 'run-local-settlement-rehearsal.mjs') $rehearsalConfigFile --execute
  if ($LASTEXITCODE -ne 0) { throw 'Rehearsal worker stopped. Inspect its sanitized report.' }
} finally {
  $env:FLURBO_REHEARSAL_PRIVATE_KEY=$rehearsalPriorKey
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($rehearsalPointer)
  $rehearsalSecret.Dispose()
}
