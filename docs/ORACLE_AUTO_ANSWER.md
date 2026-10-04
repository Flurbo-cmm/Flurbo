# Automatic Reality.eth answers for the Sepolia block PoC

The company site can run a separate answer worker for the two published Sepolia block questions. It does not handle the existing Monad activity pool, and it does not submit answers for arbitrary question text. New question types require a reviewed source reader and tests before they are added to the allowlist.

## Flow

1. During each question's published source window, the worker reads Sepolia's `finalized` execution head. It finds the first finalized block whose timestamp meets the question's threshold, computes the published Yes or No predicate, and freezes the block hash and answer in company Redis. The two current predicates are even block number and at least one transaction.
2. If the service starts after the source cutoff, it asks a Sepolia Beacon API for the historical finality checkpoint immediately before that cutoff. It cross-checks that checkpoint's execution block hash against the Sepolia RPC, then finds the first qualifying block in the finalized prefix. If none exists, it checks a checkpoint just after the cutoff before considering Void. A finality change between those checkpoints is ambiguous and requires human review. If historical finality is unavailable, the worker does not guess or sign.
3. Once Reality.eth opens the question, the worker verifies the frozen block hash and live question content hash, bond, and opening time. A dedicated Sepolia signer submits `submitAnswer(questionId, answer, 0)` with the question's minimum ETH bond. Redis records the transaction so a restart does not submit it twice. An uncertain submission requires operator review before another attempt.
4. A user may still counteranswer or request Kleros arbitration on the Flurbo market page. The answer worker never overrides an existing bonded answer. The separate Monad relay reports a final Reality.eth result and delivers the pool after both questions resolve.

The answer signer is a trusted PoC participant. Reality.eth's open answer and Kleros dispute process still allow its result to be challenged. The cross-chain relay remains a separate trust boundary.

## Company Render variables

| Variable | Value |
| --- | --- |
| `FLURBO_ORACLE_ANSWER_ENABLED` | `true` to start the worker; omit or `false` to keep manual answers only |
| `FLURBO_ORACLE_ANSWER_PRIVATE_KEY` | Private key of a **new Sepolia-only answer wallet**, entered as a Render secret |
| `FLURBO_SEPOLIA_RPC_URL` | Existing reliable Sepolia execution HTTPS RPC, also used by the market and relay |
| `FLURBO_SEPOLIA_BEACON_URL` | Sepolia Beacon API base URL, without a trailing slash; needed to recover a question whose source cutoff passed before the worker began observing |

Do not reuse the Monad relay, settlement, starter, faucet, or deployer key. Fund the new answer wallet with Sepolia ETH for two `0.0001 ETH` bonds plus transaction gas. Keep the encrypted keystore and its password in your secure backup. Never put the private key in Git, a command argument, a screenshot, or chat.

Create the wallet locally with Foundry:

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
cast wallet new "$env:USERPROFILE\.foundry\keystores" flurbo-oracle-answer
cast wallet address --account flurbo-oracle-answer
```

Use `cast wallet decrypt-keystore flurbo-oracle-answer` locally when entering the key in Render. Its output is sensitive. Paste it only into Render's secret field, then clear the terminal and retain the encrypted keystore backup.

The currently deployed questions' source cutoff was **2026-10-04 06:59:47 UTC**. The worker was not running during that window. To answer them automatically, the configured Beacon endpoint must serve the historical finality checkpoint for Sepolia slot `11280297` and the associated beacon block. A provider returning 404 or 500 for that historical state is insufficient. Check the endpoint before enabling the worker:

```powershell
$beaconSecret = Read-Host 'Sepolia Beacon API base URL' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($beaconSecret)
try { $beacon = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$checkpoint = Invoke-RestMethod "$beacon/eth/v1/beacon/states/11280297/finality_checkpoints"
if ($checkpoint.execution_optimistic -ne $false) { throw 'Checkpoint is optimistic' }
$root = $checkpoint.data.finalized.root
$block = Invoke-RestMethod "$beacon/eth/v2/beacon/blocks/$root"
if ($block.execution_optimistic -ne $false) { throw 'Beacon block is optimistic' }
$block.data.message.body.execution_payload.block_number
Remove-Variable beacon,beaconSecret,pointer,checkpoint,root,block -ErrorAction SilentlyContinue
```

Use a provider URL that points to Sepolia's **consensus** API. The existing `FLURBO_SEPOLIA_RPC_URL` is an execution JSON-RPC URL; it may or may not also serve Beacon paths. If the historical checkpoint cannot be retrieved, these two already-open questions need a manually reviewed bonded answer. Future questions can be answered automatically from live finalized observations even if historical retrieval is unavailable.

The historical read uses the [Beacon API finality checkpoint endpoint](https://github.com/ethereum/beacon-APIs/blob/master/beacon-node-oapi.yaml). [QuickNode documents that endpoint](https://www.quicknode.com/docs/ethereum/eth-v1-beacon-states-state_id-finality_checkpoints), but check that your Sepolia plan serves the particular historical slot before enabling the worker.

After deployment, check `https://flurbopm.singu.online/healthz`: `oracle_answerer.enabled` must be `true`, `signer` must match the new wallet, `routes` must be `2`, and each result should progress from `waiting_source` or `waiting_open` to `submitted`, `confirming`, or `already_answered`. `submission_uncertain` and a transaction still missing after 30 minutes require inspection of the signer before anyone clears its Redis lock. If `lastError` mentions historical finality, RPC, a changed block, or low balance, do not infer that an answer was posted. Read the Reality.eth question on Flurbo or Sepolia before taking further action. Once the bonded answer appears, its challenge window starts; the existing `oracle_relay` then waits for finality.
