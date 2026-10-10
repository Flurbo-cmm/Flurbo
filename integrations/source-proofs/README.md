# Source proofs

Proof captures for `proof-http.v1` settlement rules: sources that need an API key or a logged-in session. The prover runs on the operator's machine, holds every credential, and uploads only a finished Reclaim TLS proof. The web service verifies the proof again, offline, before it stores it.

## Setup

```bash
cd integrations/source-proofs && npm ci
npm run circuits
```

`apps/web` must be installed too (`cd apps/web && npm ci`), because the prover imports the settlement reader by relative path. `npm run circuits` downloads the zero-knowledge circuits once. The default mode needs them; `--mode tee` does not.

## Environment

Values are read from the environment and never printed or written to a file.

| Name | Used for |
| --- | --- |
| `FLURBO_RECLAIM_APP_ID` | Reclaim application ID |
| `FLURBO_RECLAIM_APP_SECRET` | Reclaim application secret |
| `FLURBO_PROOF_CREDENTIAL_<LABEL>` | the source credential for the rule whose credential label is `<label>` (upper case, `-` becomes `_`) |
| `FLURBO_PROOF_SUBMIT_TOKEN` | bearer token for the upload endpoint, needed with `--submit` |

Set them in the shell without echoing, for example `read -rs FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA; export FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA`.

## Commands

Prove a listed pool event inside its capture window, verify it locally, and upload it:

```bash
node prove.mjs --catalog ../../config/hybrid-markets.json --pool <pool id> --event <index> --submit https://flurbopm.singu.online --watch
```

`--watch` tries again every 600 seconds until the upload returns `stored` or the window closes. Without `--submit` the proof is only made and checked.

Prove one rule from a file, outside any window (authoring and fixtures). This never uploads:

```bash
node prove.mjs --rule <rules.json> [--index N] [--out FILE]
```

Add `--discover` to print the attestor addresses that signed, without checking the pin in the rule, so the owner can pin them. `--out` writes the capture with exclusive create, so it never overwrites a file.

Each result is one JSON line. Exit codes: 0 done, 1 usage or invalid rule, 3 proof generation failed, 4 outside the capture window, 5 local verification failed (the line carries the reason code), 6 upload rejected.

## Trust model

A TLS proof shows that a named HTTPS server returned the revealed fields to the prover at the signed time, as attested by the pinned Reclaim attestors. It relies on those attestors being honest and not colluding with the prover. It does not prove the source's data is correct, and it does not let anyone else fetch the source. Anyone can re-check the signatures, the committed request and the revealed values from the public evidence without any credential. Only the revealed fields are public; the credential and the rest of the response are never disclosed. If no valid proof is retained inside the capture window, the question resolves VOID under the published rule. Proofs are produced by an operator-run prover on this testnet, so automatic settlement depends on that prover running inside the window.

## Earlier experiments

`browser.mjs`, `keyed.mjs` and `decision.mjs` are earlier mock-tested experiments. They need the Reclaim application secret to verify and are not used for settlement.
