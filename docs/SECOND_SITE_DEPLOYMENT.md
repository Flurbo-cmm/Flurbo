# Company site deployment

The original hackathon site remains at `https://flurbo.singu.online` in its existing Render account. The company repository targets a second Docker web service at `https://flurbopm.singu.online` in a separate Render account. The root `render.yaml` defines `flurbopm-testnet` using `apps/web/Dockerfile`; the Docker context must be the repository root.

## Before creating the service

1. Confirm the latest company `main` checks pass. Connect the private `Flurbo-cmm/Flurbo` GitHub repository to the new Render account. The contracts repository is checked out by CI, but the web Docker build does not need contract source.
2. Inventory the existing Render service's environment variable **names**, source commit, custom domain, health check and external monitors. Render's dashboard can import a `.env` file, but do not import the original service settings wholesale. Keep any exported values outside Git and out of chat.
3. Decide which data stores the company site will use. A separate Upstash database and separate application database give independent sessions, wallet links, approvals and rate limits. Reusing the old stores would couple both sites. Existing passkeys for `flurbo.singu.online` cannot sign in at the new subdomain; new passkeys produce new Flurbo login accounts. A trading wallet may still hold positions in the same on-chain pool, but it must be linked and approved for the new account before the new site can use it.

## New Render service settings

| Setting | New service value or action |
| --- | --- |
| Repo and branch | `Flurbo-cmm/Flurbo`, `main` |
| Runtime | Docker; `apps/web/Dockerfile`; context `.` |
| Plan | Free for the verification deployment, subject to Render's current usage limits |
| Health check | `/healthz` |
| `FLURBO_ORIGIN` | `https://flurbopm.singu.online` |
| `FLURBO_NETWORK` | `public_testnet` |
| `FLURBO_SETTLEMENT_BOT` | `false`; the app also rejects `true` at this origin |
| Upstash | Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for the chosen separate database |
| RPC | Configure `FLURBO_ALCHEMY_TESTNET_RPC_URL` if the company service uses that provider; check quota with two sites |
| Pool list | Set `FLURBO_COLLECTIONS_SOURCE=registry` only after verifying the committed registry and on-chain pool state |
| Applications and mail | Enable only after deciding whether to create separate Supabase application tables and Resend configuration; otherwise leave `FLURBO_APPLICATIONS_ENABLED` and notifications off |
| Signers and funding | Do not copy `FLURBO_RESOLUTION_PRIVATE_KEY`, `FLURBO_STARTER_PRIVATE_KEY`, settlement signer settings or starter-fund settings from the old service |
| Webhooks and alerts | Do not copy delivery targets or signing keys until each integration is intentionally assigned to the company site |

The full variable-name inventory is in `PROJECT_REFERENCE.md`. `FLURBO_RESOLUTION_EVIDENCE_ORIGIN` should be the company origin only when the company site becomes a resolution publisher. The old site remains the sole settlement worker while it stays active.

## Domain and verification

1. Create the new Render service and deploy the company repository. Add `flurbopm.singu.online` under that service's Custom Domains. Add only the `flurbopm` DNS record requested by Render, then verify its TLS certificate. Leave the old `flurbo` DNS record untouched.
2. Check `/healthz`: it should report `settlement_bot: disabled`. A healthy response is only liveness; it does not prove chain readiness.
3. Create a new passkey on the company hostname. Test account approval, MetaMask linking, market listing, quotes, a small test-asset trade, evidence and portfolio redemption where a settled pool is available. Check server logs and external store usage.
4. Keep the old service's settlement monitor and cron/health checks pointed at the old hostname. Do not add a second settlement scheduler or fund a second signer during this parallel period.

The new service is a parallel company deployment, not a cutover of the existing hackathon website.
