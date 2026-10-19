# Hybrid settlement testnet runbook

Status update, 5 October 2026: the hybrid pool and mechanical Kleros adapter are deployed, and `config/hybrid-markets.json` lists one pool with two mechanical questions. The deployment sequence below is historical and must not be broadcast again for the same manifest. See [the current handoff](HANDOFF.md) for addresses, Render variables, architecture, and remaining verification. The existing activity and earlier Reality pools retain their contracts and workers.

## What this version does

New pools use `HybridPilotResolver` with `LsPilotPool`; the pools deployed before October 2026 use `WidePilotPool`. A pool can hold 2 to 32 base questions. A purchase selects one to three outcomes, so the pool does not enumerate `2^32` states. A Foundry test deployed and settled a 32-question fixture; it used about 14.2 million gas across the test, including contract creation, funding, 32 reports, and delivery. This is a local test, not a Monad deployment estimate.

Each question commits to one route before trading:

- Mechanical: the existing source capture and reader pipeline records evidence, a dedicated proposer posts a bonded provisional result on Monad, and a one-hour challenge window opens. Without a challenge, the worker finalizes and delivers automatically. A challenge locks another test AUSD bond, freezes the short timer, and requests a Kleros case on Sepolia through `MechanicalKlerosCase`. A case manager wallet pays the Sepolia arbitration fee. A dedicated relay reports the resulting ruling to Monad. A linked case waits for its Kleros ruling even after the 90-day fallback deadline. A challenge without a linked source case becomes Void at that deadline. The contract does not use the old 2-of-3 operator review.
- Reality.eth: an answerer posts a Sepolia ETH bond from the Flurbo market page. Another answer or a Kleros arbitration request is available during the Reality timeout. The final answer is read at a finalized Sepolia block and relayed to Monad. The same page supports evidence, appeal contributions, ruling completion, bond processing, and withdrawals.

Both routes appear on `/markets` and use the same question cards, price history, trade ticket, combined claims, settlement timeline, account link, and member notice worker. Resolution controls appear only in their relevant phase. The new market page reads single-question holdings and lets a holder select the exact questions and answers of a combined claim to collect its payout. The unified Portfolio dashboard still indexes the original pool types, so use the new market page for hybrid holdings and payouts until the Portfolio loader is extended.

The Sepolia-to-Monad relay is trusted in this testnet version. A compromised relay can report the wrong Kleros ruling or Reality answer. The on-chain contracts bind who may report, but they do not verify Sepolia state. Keep this limit visible when testing; authenticated cross-chain delivery is still required before a real-money deployment.

A linked Kleros case can hold up every payout in its shared pool if the court never issues a final ruling. Monitor linked cases and their appeals. The 90-day fallback applies only when a case cannot be linked.

### Pricing of new pools

Drafts use schema `flurbo.hybrid-publication.v5` with `liquidityAtoms` (the initial depth) and `commissionBps` (100 to 2000; the creation scripts use 500). `DeployHybridPilot` deploys `LsPilotPool` (protocol 5), which `HybridPilotResolver` requires. Funding is `liquidityAtoms * n * ln 2`, the same as before. After deployment check `protocolVersion()` is 5, `commissionBps()` matches the draft, `depth()` equals `liquidityAtoms * 1e12`, and `requiredFunding()` matches a two-question pool's 13862944 atoms for `liquidityAtoms` 10000000. Registration and the catalog check the same values. Also check that `sponsor()` returns the deployer; the deployment script and registration refuse any other value. `surplus()` is 0 while trading is open. The three earlier pools are protocol 3 and keep their fixed depth.

### Returning the pool surplus

After trading closes, the settlement worker sends `withdrawSurplus()` from the relay wallet whenever `surplus()` is at least 1 test AUSD: once at close (everything above the worst-case liability) and once after settlement (everything above the unredeemed winnings). The test AUSD goes to the deployer, never to the caller. `/healthz` shows `hybrid_settlement.sweeps.<pool id>` as `submitted` or `pending` while a return is in flight and `idle` when nothing is left. Winning claims stay redeemable without a deadline. If the worker is off, run `cast call $POOL "surplus()(uint128)"` and then `cast send $POOL "withdrawSurplus()" --account flurbo-testnet` with your RPC. Protocol 3 pools and older have no such function; their leftover funding stays in the pool.

## Source coverage

Reader types, their rule settings and the rules for changing them are in [SETTLEMENT_READERS.md](SETTLEMENT_READERS.md).

The mechanical route uses these verified adapters: public JSON API (`json-api.v1`, and `json-api.v2` for POST queries, derived values and time filters), CSV/SDMX/JSON-stat tables, anchored HTML text, EVM RPC, RSS/Atom/XML feeds (`xml-feed.v1`), official PDF text (`pdf-text.v1`), and credentialed sources through a TLS proof (`proof-http.v1`). A publisher-specific rule must name the event, record, finality or revision policy, and exact extraction field before listing a market. The first sample below uses two quantities from the same Monad testnet block.

Official sports feeds can be configured through public JSON only after a league-specific fixture ID, final status, score type, postponement rule, and correction policy are tested. Election and statistics feeds can use the existing table readers where a certified release and revision vintage are explicit. A feed that needs an API key or a login uses `proof-http.v1`: the source credential never reaches Render, an operator-run prover uploads a Reclaim proof inside the capture window, and the rule must give a window of at least six hours. Follow [PROOF_READER_RUNBOOK.md](PROOF_READER_RUNBOOK.md). The proof reader has not yet settled a listed pool end to end, so treat the first proof pool as a trial.

`pdf-text.v1` and `xml-feed.v1` commit the exact parser version in the rule and refuse to read if the installed version differs. Never upgrade `pdfjs-dist` or `fast-xml-parser` while a rule using it is live; a new parser version means new rules. Bitcoin and Solana readers, pages that only render with JavaScript, and multi-source medians are not implemented. Do not advertise those categories as automatic or publish questions using them. The build order and rejection criteria are in [SETTLEMENT_ROUTING_V4.md](SETTLEMENT_ROUTING_V4.md).

## Wallets, funds, and hosting

Keep the existing deployer keystore. Create separate encrypted keystores for the Monad proposer, Monad relay, and Sepolia case manager. Their private keys are Render secrets, never Git content. The deployer needs Monad testnet MON and test AUSD to create and fund a pool. The proposer needs MON for gas and test AUSD for each mechanical bond. The relay needs MON. The case manager needs Sepolia ETH above the live Kleros arbitration fee plus gas. Traders need test AUSD and MON; a Reality answerer or challenger needs Sepolia ETH. The existing faucet can remain shared.

The existing Render Redis, Resend and scheduler settings remain in use. For a nonempty hybrid catalog, add these company service variables:

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
| `FLURBO_HYBRID_JUROR_ADDRESS` | Optional public address of the operator juror. `/healthz` and the ACTION email then show the juror's unvoted seats and the exact `castVote` command |
| `FLURBO_HYBRID_ALERTS_ENABLED=true` | Operator emails for hybrid pools (see "Operator emails" below). Needs `FLURBO_MONITOR_EMAIL_TO`, `FLURBO_MONITOR_EMAIL_FROM` and `FLURBO_MONITOR_RESEND_KEY` |
| `FLURBO_PROOF_SUBMIT_TOKEN` | Bearer token (32 to 128 URL-safe characters) for the proof upload endpoint. Needed only when a listed pool uses `proof-http.v1`; without it the endpoint stays off and `/healthz` shows `proof_captures: disabled` |

`FLURBO_SCHEDULER=true` (legacy alias `FLURBO_SETTLEMENT_BOT=true`) and `FLURBO_NOTIFY_ENABLED=true` drive closing, observation, proposal, and payout emails. Sender addresses and Resend keys stay as configured for the company site. Check `/healthz` for `hybrid_settlement` and `hybrid_arbitration` errors after enabling the catalog. A free Render instance can sleep; a ten-minute ping is helpful but cannot guarantee capturing a short source window. The source rule specifies the cutoff and VOID behavior, so widen the capture window for a real trial.

Run one company web instance for this testnet trial. The two hybrid workers serialize transactions from their shared Monad relay wallet inside that process. Multiple service instances using the same relay key need a distributed nonce coordinator or a single elected worker before they are enabled.

## Reality reader pools

New pools reuse `HybridPilotResolver` and `LsPilotPool` with every route set to Reality. Each question carries its published rule. After the observation window, the hybrid settlement worker reads the committed source, freezes the result in Redis, and its answerer wallet posts the first bonded answer on Reality.eth. Reality finalizes after its timeout (default one hour). The relay then reports the answer to Monad. If someone posts a different answer, the court keeper requests Kleros arbitration through the question's arbitrator proxy when the new best answer contradicts the reader result, files the reader evidence, and moves the court through each permissionless step: delayed stakes, phase changes, juror draw, period changes, ruling execution and the report back to Reality. After the ruling it also executes each court round (so the juror's locked PNK is released and the juror fee is paid), processes the Reality answer history with `claimWinnings` once per finalized question, and withdraws its own Reality credit. The settlement worker's answerer withdraws its own credit the same way. Both withdrawals need at least 0.0001 ETH of credit. Appeal funding stays open to users on the market page.

New pools use the Flurbo copy of the Kleros proxy at `0x9E05da51D17bCd4B796E4505FCEED9135bd99964` (subcourt 3, one juror seat, 0.02 Sepolia ETH dispute fee). `hybrid-reality-1` keeps the official proxy. The reason: the official proxy sends every dispute to subcourt 0, which held about 122,000 test PNK on 5 October 2026, while a faucet address can hold only 10,000. The operator juror would be drawn about 8% of the time, and otherwise an absent stranger holds the seat and the question ends Void. Subcourt 3 had no stake, open votes and the same 30/600/600/600 second periods, so a juror staked there alone is always drawn. The juror stakes only in subcourt 3. A missed vote gets the juror penalized and unstaked when the court round is executed, so the juror then needs new PNK before the next test.

The only manual step is the juror vote. An operator-controlled juror wallet staked with faucet test PNK casts it. The keeper passes the vote period once the vote is cast, or after `voteWaitSeconds` (default 24 hours) with no vote. Passing without a vote ends in a tie, which Kleros reports as ruling 0 and Flurbo treats as Void. Before every challenge test, confirm the juror is still the only staker in subcourt 3 (step 7 below). A final Reality answer that is neither Yes nor No is delivered to Monad as Void. The relay from Sepolia to Monad is trusted in this testnet version. Authenticated delivery is required before any real-money use. A Kleros case that outlasts the pool's report period becomes Void (7 days by default for pools created with the current script, 90 days for flb-1 and earlier pools).

### Operator emails and member notice diagnostics

The original operator monitor (`FLURBO_MONITOR_*`) only watches the activity pool. Hybrid pools have their own operator email, `hybrid-operator-alerts.mjs`, enabled with `FLURBO_HYBRID_ALERTS_ENABLED=true` and sent through the same Resend settings and recipient. It emails once per event: answer posted, Kleros arbitration requested, vote period reached (subject starts with `ACTION`, this is your cue to cast the juror vote), ruling, Reality final, reported to Monad, and pool delivered. It also emails worker errors (once per 6 hours per message) and low balances once per day: the Sepolia answerer (below 0.002 ETH) and keeper (below 0.03 ETH), the Monad relay (below 0.3 MON) and the Monad proposer (below 0.1 MON). When a question without a reader opens for answers it sends an `ACTION` email with the minimum bond and the Void deadline; `/healthz` `hybrid_alerts.waitingForHumanAnswer` lists those questions until someone answers. `/healthz` `hybrid_settlement.events` lists every failing question with its stage, a stable code and the time it started failing. The first run for a pool records the current state without sending, so history is never emailed. Check `/healthz` `hybrid_alerts`.

Member notices (traders) are separate. A stage that nobody could receive, because no wallet was linked or no verified email existed, is now checked again after one hour instead of being closed for good. When stages were due but nobody was emailed, the `scheduler.notices` text in `/healthz` (repeated under the legacy `settlement_bot` key) adds the counts, for example `sent 0 (stages 1, wallets 1, unlinked 1, no verified email 0)`. `unlinked` means a trading wallet is not linked to a Flurbo account. `no verified email` means the account has no verified email in the company applications data.

### Wallets and funding

| Wallet | Chain | Role | Funding |
| --- | --- | --- | --- |
| Answerer (new keystore `flurbo-hybrid-answer`) | Sepolia | Posts the first bonded answer | At least 0.01 Sepolia ETH |
| Juror (new keystore `flurbo-kleros-juror`) | Sepolia | Casts the vote | At least 7,400 test PNK staked in subcourt 3 only, 0.01 Sepolia ETH |
| Keeper (existing case manager `0x771fE7003FA20737C933c39B89386d78cbc36370`) | Sepolia | Requests arbitration, files evidence, drives the court | At least 0.05 Sepolia ETH |

The proposer, relay and deployer keep their existing roles. The answerer must differ from the creator, proposer and relay. The keeper must differ from the relay.

### Relay gas

Monad charges the full gas limit, so one `reportReality` costs about 0.013 MON at 102 gwei. Fund the relay with at least `0.013 MON x questions + 0.05 MON` per pool (the delivery and two surplus sweeps), for example 0.26 MON for a 16-question pool, and keep 0.3 MON spare. The settlement worker checks the balance against the estimated gas before each Monad transaction.

### Environment variables

`FLURBO_HYBRID_ANSWER_PRIVATE_KEY` is new and is pasted only into Render. A key set ahead of a catalog entry with rule-backed Reality events is ignored. `FLURBO_HYBRID_SETTLEMENT_ENABLED=true` and `FLURBO_HYBRID_ARBITRATION_ENABLED=true` start the answerer and the court keeper. The keeper reuses `FLURBO_HYBRID_CASE_MANAGER_PRIVATE_KEY`. `FLURBO_HYBRID_MAX_DISPUTE_FEE_WEI` is optional. `FLURBO_HYBRID_JUROR_ADDRESS` is optional and public. `/healthz` gains `hybrid_court` (with `juror` and each case's `jurorVoteIds`) and `hybrid_settlement.answerer`, plus per-question `hybrid_settlement.answers`. Errors are reported per question as `<pool id> event <index> <stage> <CODE>: <message>` (pool-level failures omit the event) joined by `; `. Each question's steps run on their own, so one failing question or pool no longer stops the others; a wallet without gas is reported as `RELAY_GAS_LOW` or `PROPOSER_GAS_LOW` before any transaction is locked.

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

2. Deploy the Flurbo copy of the Kleros proxy and stake the juror in subcourt 3 (details in "Kleros proxy copy" below). `MSYS_NO_PATHCONV=1` stops Git Bash from rewriting the `/ipfs/...` argument into a Windows path.

```bash
export MSYS_NO_PATHCONV=1; DEPLOYER=0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391; COURT=0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879; PROXY3=0x9E05da51D17bCd4B796E4505FCEED9135bd99964; FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C; PNK=0xA1eE4D32bdBcA69cdb445D66fAA3804aFFa24bFE; SALT=0x0000000000000000000000000000000000000000000000000000000000000000
```

If `cast code $PROXY3 --rpc-url "$FLURBO_SEPOLIA_RPC_URL"` already prints more than `0x`, skip to the verification. Otherwise rebuild the init code from the official deployment and compare each hash with the value in "Kleros proxy copy". Stop on any difference.

```bash
CREATION=$(cast tx 0x45c4df7712dd6a09e8845646821e454779c390c8afa7bcf2dfbbe29a3ba65ac9 input --rpc-url "$FLURBO_SEPOLIA_RPC_URL" | cut -c1-22186); cast keccak "$CREATION"
```

```bash
META='{"tos":"ipfs://QmaUr6hnSVxYD899xdcn2GUVtXVjXoSXKZbce3zFtGWw4H/Question_Resolution_Policy.pdf"}'; EVIDENCE='/ipfs/QmPrLN3L6z3MrTKnyuiLdF4miS9LSSLfVB62kpkxn1hbr8/metaEvidence.json'
```

```bash
ARGS=$(cast abi-encode 'constructor(address,string,address,bytes,string)' 0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA "$META" $COURT $(cast abi-encode 'f(uint256,uint256)' 3 1) "$EVIDENCE"); cast keccak "$ARGS"
```

```bash
INIT="${CREATION}${ARGS#0x}"; cast keccak "$INIT"
```

```bash
cast call $FACTORY "${SALT}${INIT#0x}" --from $DEPLOYER --rpc-url "$FLURBO_SEPOLIA_RPC_URL"
```

The simulated address must be `0x9e05da51d17bcd4b796e4505fceed9135bd99964`. Then deploy it and verify the copy:

```bash
cast send $FACTORY "${SALT}${INIT#0x}" --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-testnet
```

```bash
cast keccak "$(cast code $PROXY3 --rpc-url "$FLURBO_SEPOLIA_RPC_URL")"; cast call $PROXY3 'arbitratorExtraData()(bytes)' --rpc-url "$FLURBO_SEPOLIA_RPC_URL"; cast call $PROXY3 'getDisputeFee(bytes32)(uint256)' $SALT --rpc-url "$FLURBO_SEPOLIA_RPC_URL"
```

```bash
unset MSYS_NO_PATHCONV
```

Stake the juror. Read the PNK balance first. It must be at least 7,400 PNK (`7400000000000000000000`). The faucet gives 10,000 PNK once per address, so if the juror already used it, create `flurbo-kleros-juror-2` with `cast wallet new`, fund it with 0.02 Sepolia ETH, request from it and use that keystore name below. The locked tokens from `jurors(address)` must be 0.

```bash
cast send 0x776e5853e3d61B2dFB22Bcf872a43bF9A1231e52 'request()' --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror
```

```bash
BAL=$(cast call $PNK 'balanceOf(address)(uint256)' $JUROR --rpc-url "$FLURBO_SEPOLIA_RPC_URL" | awk '{print $1}'); echo $BAL; cast call $COURT 'jurors(address)(uint256,uint256)' $JUROR --rpc-url "$FLURBO_SEPOLIA_RPC_URL"
```

Move the whole stake to subcourt 3 (unstake subcourt 0 first if it holds any):

```bash
cast send $COURT 'setStake(uint96,uint128)' 0 0 --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror
```

```bash
cast send $COURT 'setStake(uint96,uint128)' 3 $BAL --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror
```

Outside the court's staking phase the stake is queued. Wait for phase 0 (send `passPhase()` once if phase 2 lasts more than ten minutes), then run the queue:

```bash
until [ "$(cast call $COURT 'phase()(uint8)' --rpc-url "$FLURBO_SEPOLIA_RPC_URL")" = "0" ]; do date; sleep 30; done
```

```bash
cast send $COURT 'executeDelayedSetStakes(uint256)' 20 --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror
```

Check readiness. It must print `"ready": true` and `"sharePercent": "100.00"`:

```bash
node scripts/inspect-kleros-court.mjs $PROXY3 $JUROR
```

Keep the juror address for `FLURBO_HYBRID_JUROR_ADDRESS`.

3. Ship the code with no new catalog entry. Commit and merge the contracts test, set the CI pin in `.github/workflows/checks.yml` to that merge commit, then commit and merge the company changes. Set `FLURBO_HYBRID_ANSWER_PRIVATE_KEY` (from `cast wallet decrypt-keystore flurbo-hybrid-answer`), `FLURBO_HYBRID_SETTLEMENT_ENABLED=true` and `FLURBO_HYBRID_ARBITRATION_ENABLED=true` in Render. `/healthz` shows `hybrid_court` as `disabled` until a Reality pool is listed.

4. Move the files of any earlier hybrid pool out of `Flurbo-contracts/target/deployments/` into private records (`hybrid-pilot-input.json`, `hybrid-pilot-prepared.json`, `hybrid-pilot-unverified.json`, `hybrid-catalog-candidate.json`). Every script below writes with `wx` and refuses to overwrite. Then generate the template and ask both questions. `CLOSE` must be at least 2 hours away. Without the last two arguments the template uses the subcourt 3 proxy copy and the title `Monad testnet Reality reader pool`. The optional arguments pin the arbitrator (`0x9E05da51D17bCd4B796E4505FCEED9135bd99964` or the official proxy) and the title.

```bash
CLOSE=$(( $(date +%s) + 3*3600 )); DEPLOYER=0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391
```

```bash
node scripts/create-hybrid-reality-pilot.mjs $DEPLOYER 0xa45c95f673580132F2E6f75372808162Ea069d49 0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1 $CLOSE https://flurbopm.singu.online ../../../Flurbo-contracts/target/deployments/hybrid-reality-template.json 0x9E05da51D17bCd4B796E4505FCEED9135bd99964 "Monad testnet Kleros challenge pool"
```

Check that both printed `cast send` lines contain the proxy copy address, run them and copy both transaction hashes.

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

The registration output lists `arbitrators`. Registration refuses a proxy whose runtime code, Reality and court bindings or juror seat count differ from the verified Kleros proxy. Review the candidate, then copy it to `config/hybrid-markets.json`, commit, merge and deploy. Check `/healthz`: `hybrid_court.routes` is 2, `hybrid_settlement.answerer` equals `$ANSWERER`, and no `lastError` appears.

```bash
cp ../Flurbo-contracts/target/deployments/hybrid-catalog-candidate.json config/hybrid-markets.json
```

6. Question 1 (no challenge). Buy one share on each question from the market page. After `observationEndsAt`, `hybrid_settlement.answers` reaches `submitted`, then `already_answered`. About one hour later Reality finalizes and the relay reports.

7. Question 2 (challenge). About 15 minutes before the question's `observationEndsAt`, check that the juror is ready and that the keeper, answerer, juror and challenger wallets are funded. Stop if `ready` is false.

```bash
node scripts/inspect-kleros-court.mjs $PROXY3 $JUROR
```

Inside its Reality timeout, a separate test wallet posts the opposite answer from the market page at double the bond. Within one keeper cycle `hybrid_court.cases[<id>].proxyStatus` becomes 1. Note the dispute ID and the `requestArbitration` transaction. Inspect the case:

```bash
node apps/web/scripts/inspect-kleros-dispute.mjs <Q2_ID> $JUROR
```

Once the period is `Vote`, `/healthz` shows `jurorVoteIds` for the case and the `ACTION` email carries the ready-to-run `castVote` command (set `FLURBO_HYBRID_JUROR_ADDRESS` first). If `jurorVoteIds` is empty, the juror was not drawn: do not vote, and repeat on a new pool after re-checking readiness. Otherwise run the command with the right choice: 2 for Yes, 1 for No, 0 for Void. The keeper passes the vote and appeal periods, executes the ruling and reports it, then executes the court round and processes the Reality bonds. Reality finalizes, the relay reports to Monad, and the relay delivers when both questions are final.

8. Redeem from the market page. The keeper and the answerer process bonds and withdraw their credit automatically. The challenger claims on the market page under "Reality.eth answer bonds" if its wallet posted a winning answer. Check the Resend logs for the closing, observation, challenge, arbitration, ruling and payout notices. Store the transaction hashes, the dispute ID and the addresses in `secrets/COMPANY_OPERATIONS.md`. For a protocol 5 pool, `hybrid_settlement.sweeps` for the pool returns to `idle` once the worker has returned the surplus to the deployer.

### Kleros proxy copy

The copy is byte-identical to the official Kleros `Realitio_v2_1_ArbitratorWithAppeals` deployment (Sourcify exact match) except for the constructor argument `arbitratorExtraData`, which is subcourt 3 with 1 juror. It has no owner. It is deployed through the deterministic deployment factory, so anyone who sends the same init code gets the same address.

| Item | Value |
| --- | --- |
| Official proxy | `0x05b942faecfb3924970e3a28e0f230910cedff45` (deployment transaction `0x45c4df7712dd6a09e8845646821e454779c390c8afa7bcf2dfbbe29a3ba65ac9`) |
| Creation code keccak (first 11092 bytes of the deployment input) | `0x23b20a66834e0b462b0ec8db4d38d8617374e4982cb984daa93fef48ece4a6b5` |
| Constructor arguments keccak | `0xf2772a7e82b34c914cb3a41a847ffe5e692be2bc97bd010999758b1c1d028229` |
| Init code keccak | `0x7184b2cb6ccd385eacbe8b2e941d89c4337c575480898bc6cbc0449196d307fe` |
| Factory and salt | `0x4e59b44847b379578588920cA78FbF26c0B4956C`, salt 0 |
| Copy address | `0x9E05da51D17bCd4B796E4505FCEED9135bd99964` |
| Runtime code keccak (official and copy) | `0x41e678fa0e8ad73d464dbaa431d4b61a3f275f5079d75ed8e24b12ac53e4e5ad` |
| `arbitratorExtraData` | 64 bytes, `3` then `1` |
| `getDisputeFee` | `20000000000000000` (0.02 ETH) |

The code pins the same runtime hash. The keeper, registration and `inspect-kleros-court.mjs` all refuse a proxy whose code, Reality binding, court binding or seat count differs.

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
