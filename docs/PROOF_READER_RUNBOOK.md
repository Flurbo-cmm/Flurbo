# Proof reader runbook: credentialed sources by TLS proof

Status, 10 October 2026: the `proof-http.v1` reader, the prover, the upload endpoint and the replay tool are implemented and tested with signed synthetic proofs. No genuine proof from a live provider has been recorded yet, and no listed pool uses a proof rule. Steps 3 to 5 below produce the first genuine proof and record it as a test fixture; do them before listing any pool.

Reader families: [SETTLEMENT_ROUTING_V4.md](SETTLEMENT_ROUTING_V4.md). Pool procedure this builds on: [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md).

## What it is

A source that needs an API key or a login cannot be fetched by the web service, which would have to hold the credential. Instead:

1. The rule names the exact request and the fields to reveal, and pins the Reclaim attestor addresses it trusts.
2. An operator-run prover on the owner's machine holds the credential, makes a Reclaim proof of the response inside the rule's capture window, checks it locally with the server's own reader, and uploads it.
3. The web service verifies the proof again, offline, and stores it as the capture. The settlement worker never fetches a credentialed source; it only records that it is still waiting for a proof.
4. The first valid proof inside the window decides the question, exactly as for any first-observed-snapshot rule.

## Trust model

A TLS proof shows that a named HTTPS server returned the revealed fields to the prover at the signed time, as attested by the pinned Reclaim attestors. It relies on those attestors being honest and not colluding with the prover. It does not prove the source's data is correct, and it does not let anyone else fetch the source. Anyone can re-check the signatures, the committed request and the revealed values from the public evidence without any credential. Only the revealed fields are public; the credential and the rest of the response are never disclosed. If no valid proof is retained inside the capture window, the question resolves VOID under the published rule. Proofs are produced by an operator-run prover on this testnet, so automatic settlement depends on that prover running inside the window.

## 1. Prerequisites

- A Reclaim application from the Reclaim developer portal (application ID and secret).
- An account with the source. The first source is football-data.org (free plan, an API key sent as `X-Auth-Token`). The free plan delays scores, so choose a match that finished some hours ago and open the capture window three hours after kickoff.
- Node 24, with `npm ci` run in `apps/web` and in `integrations/source-proofs`.

## 2. Environment (names only)

| Name | Where | Purpose |
| --- | --- | --- |
| `FLURBO_RECLAIM_APP_ID`, `FLURBO_RECLAIM_APP_SECRET` | prover machine only | Reclaim application credentials |
| `FLURBO_PROOF_CREDENTIAL_<LABEL>` | prover machine only | the source credential for the rule whose credential label is `<label>`; `football-data` becomes `FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA` |
| `FLURBO_PROOF_SUBMIT_TOKEN` | Render and the prover machine | bearer token, 32 to 128 URL-safe characters |

None of these goes into Git, a rule, a fixture, a log line or chat. Never set the first three on Render. Enter them in the Git Bash session used for proving without echoing:

```bash
read -rs FLURBO_RECLAIM_APP_ID; export FLURBO_RECLAIM_APP_ID
```

```bash
read -rs FLURBO_RECLAIM_APP_SECRET; export FLURBO_RECLAIM_APP_SECRET
```

```bash
read -rs FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA; export FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA
```

## 3. Download the circuits once

```bash
cd /c/Users/anany/Flurbo-company/integrations/source-proofs && npm ci && npm run circuits
```

The default mode (`--mode zk`) runs in plain JavaScript and needs them. `--mode tee` does not, but loads a native library.

## 4. Discover and pin the attestor

Pick a finished match. The first line of output is the match ID, kickoff, teams and winner:

```bash
curl -s -H "X-Auth-Token: $FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA" "https://api.football-data.org/v4/competitions/PL/matches?status=FINISHED" | node.exe -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).matches.at(-1);console.log(m.id,m.utcDate,m.homeTeam.shortName,m.awayTeam.shortName,m.score.winner)})"
```

Write rules with a placeholder attestor, and prove once without the pin:

```bash
cd /c/Users/anany/Flurbo-company/apps/web && node scripts/create-football-proof-rules.mjs <ID> $(date -d <UTCDATE> +%s) <HOME> <AWAY> 0x0000000000000000000000000000000000000001 ../../secrets/proof-discovery-rules.json
```

```bash
cd ../../integrations/source-proofs && node prove.mjs --rule ../../secrets/proof-discovery-rules.json --index 0 --discover --out ../../secrets/proof-discovery.json
```

The result is `{"status":"discovered","signers":["0x..."]}`. Confirm each signer is a listed Reclaim attestor before pinning it:

```bash
curl -s https://api.reclaimprotocol.org/api/attestors | node.exe -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.map(a=>a.address.toLowerCase()).join('\n')))"
```

Stop if the signer is not in that list. If `--mode zk` fails on Windows, retry with `--mode tee` and note which mode worked.

Then open `secrets/proof-discovery.json` and compare the signed claim with what the reader accepts: `claimData.parameters` may only hold the keys `url, method, body, headers, responseMatches, responseRedactions, geoLocation, paramValues`, with `geoLocation` empty and `paramValues` empty or absent, and the signed context may only hold `contextAddress, contextMessage, extractedParameters, providerHash`. A key outside that list with an empty value is a small allowed-list change in `settlement-readers.mjs` (`PROOF_PARAM_KEYS`); record it and rerun the tests. A non-empty unexpected value, or a context without `extractedParameters`, means the reader design needs revisiting: stop and report.

## 5. Record the genuine proof as a test fixture

Do this once, with the real attestor address from step 4. It makes the offline test of a genuine proof run instead of being skipped.

```bash
cd /c/Users/anany/Flurbo-company/apps/web && node scripts/create-football-proof-rules.mjs <ID> <KICKOFF_UNIX> <HOME> <AWAY> <ATTESTOR> ../../secrets/proof-fixture-rules.json
```

```bash
cd ../../integrations/source-proofs && node prove.mjs --rule ../../secrets/proof-fixture-rules.json --index 0 --out ../../secrets/proof-fixture-capture.json
```

```bash
cd ../../apps/web && node.exe -p "JSON.stringify(require('../../secrets/proof-fixture-rules.json')[0])" > ../../secrets/proof-fixture-rule0.json
```

```bash
node scripts/check-settlement-rule.mjs ../../secrets/proof-fixture-rule0.json --proof ../../secrets/proof-fixture-capture.json
```

Expected: `"result": "proof-valid"` with the real winner. Then write the fixture and confirm it holds no credential; both greps must print `0`:

```bash
node.exe -e "const fs=require('fs'); fs.writeFileSync('tests/fixtures/settlement/proof-football-data.json', JSON.stringify({rule:require('../../secrets/proof-fixture-rules.json')[0],capture:require('../../secrets/proof-fixture-capture.json')},null,2)+'
',{flag:'wx'})"
```

```bash
grep -c "$FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA" tests/fixtures/settlement/proof-football-data.json
```

```bash
grep -c "$FLURBO_RECLAIM_APP_SECRET" tests/fixtures/settlement/proof-football-data.json
```

Add a short paragraph to `apps/web/tests/fixtures/settlement/README.md` saying what the file is (a genuine Reclaim proof of one football-data.org match), the date, the match ID, and that it contains no credential. Then run `node --experimental-strip-types --test tests/proof-reader.test.ts`: the test `a genuine Reclaim proof verifies offline` should now run and pass. Update the status paragraph in [ORACLE_ROUTING_AND_PRIVATE_SOURCES.md](ORACLE_ROUTING_AND_PRIVATE_SOURCES.md) with the date, match and attestor address.

## 6. Author the rules

```bash
cd /c/Users/anany/Flurbo-company/apps/web && node scripts/create-football-proof-rules.mjs <ID> <KICKOFF_UNIX> <HOME> <AWAY> <ATTESTOR> <OUTPUT.json>
```

This writes two rules for one match: the home win (`fd-<id>-home-win`) and at least three goals (`fd-<id>-goals`). The capture window opens three hours after kickoff and closes 30 hours after it. Every proof rule must include a terminal-state check (`status` equals `FINISHED`), so that a proof made after the final whistle shows the same result; the earliest valid proof inside the window decides. A proof rule needs a window of at least six hours, one URL and `first-observed-snapshot`.

Check them. Without a proof the report says `proof-required`; with a sample proof it reads it offline:

```bash
node scripts/check-settlement-rule.mjs <OUTPUT.json> --closes-at <CLOSE_UNIX>
```

```bash
node scripts/check-settlement-rule.mjs <single-rule.json> --proof <capture.json>
```

Expected: `status: ok`, and `result: proof-valid` with the real value when a proof is passed.

## 7. List a pool

Follow the owner procedure in [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md), steps 4 to 8, with these differences. Use a match 4 hours to 13 days away (`status=SCHEDULED`), `KICKOFF` as its Unix start and `CLOSE=$((KICKOFF - 600))`.

Generate a submit token and set it in Render as `FLURBO_PROOF_SUBMIT_TOKEN`; export it in the proving shell with `read -rs`:

```bash
node.exe -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Build the Reality template with the rules as the ninth argument (use `""` to skip the arbitrator and title arguments you do not need), then ask the questions and complete the draft exactly as in step 5 of that runbook, with pool ID `hybrid-proof-1`:

```bash
node scripts/create-hybrid-reality-pilot.mjs $DEPLOYER <PROPOSER> <RELAY> $CLOSE https://flurbopm.singu.online ../../../Flurbo-contracts/target/deployments/hybrid-reality-template.json <ARBITRATOR> "Monad testnet credentialed source pool" ../../../Flurbo-contracts/target/deployments/proof-rules.json
```

Registering the pool (the `config/hybrid-markets.json` change) is its own commit after deployment. Deploying cannot be undone: a pool's resolver is immutable, so if proofs cannot be produced in the window the questions resolve VOID. Never edit the catalog afterwards.

## 8. Prove inside the window

After kickoff plus three hours, on the prover machine:

```bash
cd /c/Users/anany/Flurbo-company/integrations/source-proofs && node prove.mjs --catalog ../../config/hybrid-markets.json --pool hybrid-proof-1 --event 0 --submit https://flurbopm.singu.online --watch
```

```bash
node prove.mjs --catalog ../../config/hybrid-markets.json --pool hybrid-proof-1 --event 1 --submit https://flurbopm.singu.online --watch
```

`--watch` tries every ten minutes until the upload returns `stored` or the window closes. Each result is one JSON line. While the match is unfinished the proof fails the finality check (`OBSERVATION_IDENTITY_MISMATCH`) or the source has no winner yet (proof generation fails), and the prover simply tries again. Exit codes: 0 done, 1 usage or invalid rule, 3 proof generation failed, 4 outside the capture window, 5 local verification failed (the line carries the reason code), 6 upload rejected.

Keep the prover running through the window; if the machine sleeps or loses power for the whole window, the questions resolve VOID.

## 9. Health

`/healthz` reports `proof_captures`: `enabled (N rules)` when the token is set and the catalog has proof rules, otherwise `disabled`. After the window closes, `hybrid_settlement.answers` for each event goes to `submitted` and then `already_answered`, as in step 6 of the hybrid runbook. Until a proof is stored, the worker records `PROOF_CAPTURE_PENDING` for the rule on each cycle; that attempt is included in the VOID evidence if no proof ever arrives.

## 10. Verify as an outsider

Anyone can check the published evidence without a credential, using the evidence URL shown on the market page and the rule hash from the rule URI:

```bash
cd /c/Users/anany/Flurbo-company && node apps/web/scripts/verify-settlement-evidence.mjs <EVIDENCE_URL> --rule-hash <RULE_HASH>
```

Expected: `{"status":"verified",...,"adapter":"proof-http.v1","signers":["<ATTESTOR>"]}`. The tool replays the evaluation from the retained captures and checks the signatures against the attestors in the rule. A changed packet fails with `PACKET_BINDING_FAILED` or `PACKET_REPLAY_FAILED`.

## 11. When no proof is retained

If no valid proof is stored between the rule's `scheduledAt` and `publicationCutoff`, the hybrid worker freezes VOID for that question, as the published rule says (`resolver-timeout-void`). Flurbo VOID uses the committed uniform averaging rule; it is not a refund. A challenge still goes to Kleros as for any Reality-routed answer.

## 12. Rotating credentials

- Source credential: change the environment variable on the prover machine. The rule holds only the credential label, so no rule changes.
- Reclaim application secret: rotate in the portal and update the prover machine.
- Upload token: set a new value in Render and on the prover machine, then redeploy.
- Attestor set: attestors are part of the rule hash, so a different set means new rules and a new pool.

## Limits to keep visible

The prover is one operator machine. The pinned attestors are trusted to sign only what the source returned. A source that edits its data after the capture cannot be detected. The proof reveals only the fields in the rule, but the rule and the revealed values are public.
