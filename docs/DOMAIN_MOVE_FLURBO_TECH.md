# Domain move: flurbo.tech is the primary company origin

`https://flurbo.tech` is the primary origin of the company site (Render service `flurbopm-testnet`). `https://flurbopm.singu.online` still resolves to the same service and redirects (HTTP 308, path and query kept) to `flurbo.tech`.

## What the old host still answers directly

A redirect would break these, so `flurbopm.singu.online` serves them itself:

- `/healthz` (external keep-awake ping and Healthchecks keep working unchanged)
- `/.well-known/webauthn` (related origins file, see passkeys)
- `/api/pilot/evidence/*`, `/api/oracle/evidence/*`, `/api/settlement/packets/*`, `/api/hybrid/rules/*`, `/hybrid-meta-evidence.json` (content addressed URIs already recorded on chain and in question text)
- `/api/agent-runtime/*` and `/api/settlement/proof-captures` (bearer credential clients and the prover that cannot follow a cross-origin redirect)

Everything else on the old host redirects.

## Passkeys keep the old relying party

A Mera account is derived from a passkey that is scoped to the host it was created on. To keep every existing address, `flurbo.tech` still asks for the relying party `flurbopm.singu.online` and the browser permits that because the old host lists `flurbo.tech` in `/.well-known/webauthn`. Consequences:

- `flurbopm.singu.online` must stay in DNS and pointed at this service for as long as passkeys are in use. If it is dropped, no one can sign in.
- Supported browsers: Chrome and Edge 128+, Safari 18+. Firefox does not support related origins yet, so sign-in on flurbo.tech fails there.
- Browser sessions and the remembered-passkey hint are per host, so members sign in once on flurbo.tech.

## Evidence origin

`FLURBO_EVIDENCE_ORIGIN` is the host used to mint and verify evidence, packet and rule URIs. It stays `https://flurbopm.singu.online` because pools and archived evidence already point there. Do not change it while any pool created before the move is unsettled. Moving it later needs the settlement worker to accept both hosts for stored URIs.

## Render steps

1. Render dashboard, service `flurbopm-testnet`, Settings, Custom Domains: add `flurbo.tech` (and `www.flurbo.tech`, which Render redirects). Keep `flurbopm.singu.online` listed.
2. At the registrar for flurbo.tech add the records Render shows (apex `A`/`ALIAS`, `www` `CNAME`). Wait for the certificate to show Verified.
3. Environment, set:
   - `FLURBO_ORIGIN` = `https://flurbo.tech`
   - `FLURBO_EVIDENCE_ORIGIN` = `https://flurbopm.singu.online`
   - leave `FLURBO_COMPANY_STARTER_ADDRESS` and every other variable as is.
4. Deploy. The Blueprint (`render.yaml`) now carries both values, so a Blueprint sync will not revert them.
5. Check: `curl -sI https://flurbopm.singu.online/markets` returns `308` with `location: https://flurbo.tech/markets`; `curl -s https://flurbopm.singu.online/.well-known/webauthn` returns `{"origins":["https://flurbo.tech"]}`; `curl -s https://flurbo.tech/healthz` reports the workers.
6. Sign in with an existing passkey on flurbo.tech and confirm the same Mera address.

## Other places that mention the host

- Resend sender and the other email variables are not tied to the web host; member notice links now use flurbo.tech.
- Update any external health ping to `https://flurbo.tech/healthz` at leisure (the old URL keeps working).
- Agent and prover clients can keep using the old URL; new SDK defaults use flurbo.tech.
- The hackathon site (`flurbo.singu.online`) is unchanged.
