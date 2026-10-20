# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working rules (from the owner)

- Never commit, push, merge or open PRs. Prepare changes and give the owner the git commands, always give commands in git bash format.
- Work on branch `kleros-reality-eth` for the oracle work.
- Never mention Codex, ChatGPT or Claude in any tracked file, branch name or commit. Avoid em dashes and unnecessary comments in code.
- Do not stage `apps/mobile/` (untracked, out of scope). Stage files explicitly, never `git add .` or `-A`.
- Never place private keys, API tokens or RPC URLs with tokens in the repo or chat. `/secrets/` is gitignored and holds the private ops inventory (`secrets/COMPANY_OPERATIONS.md`).
- The deployed Monad activity pool (`0x8c93...`, in `config/collections.json`) and its settlement bot must not be changed. The hackathon repo and `flurbo.singu.online` are frozen and separate.
- before implementing a feature,always write tests first (not tests for each line but every important feature planned)
- 

## Repository layout (polyrepo)

- This repo (`Flurbo-cmm/Flurbo`): web app + API server + settlement/oracle workers, SDKs, Envio indexer config, registries, docs. Deployed to Render as `flurbopm-testnet` (`render.yaml`, `apps/web/Dockerfile`, build context = repo root).
- `Flurbo-contracts` (separate repo, `C:\Users\anany\Flurbo-contracts`): all Solidity, Foundry tests, deploy scripts. Here `contracts/` is an **ignored local checkout** of it. CI pins a commit in `.github/workflows/checks.yml` (`ref:`) and reads it with the secret `FLURBO_CONTRACTS_READ_TOKEN`. After merging contract changes, update that pin. README still lists an older pin.
- Root `foundry.toml` points `src`/`test` at `contracts/` and writes to `target/`. Run `forge` from this repo root so scripts can read `config/` and write `target/deployments`. Use `FOUNDRY_PROFILE=demo` for deploy scripts.
- Web and SDK are not split: web imports `packages/sdk` by relative path, SDK tests use the web server and shared fixtures.

## Commands

Web (Node 24), run in `apps/web`:
```sh
npm ci
npm run typecheck
npm run build                # typecheck + vite build
npm run dev                  # vite on 127.0.0.1:18767
npm test                     # node --experimental-strip-types --test tests/*.test.ts
node --experimental-strip-types --test tests/oracle-integration.test.ts   # single file
node --experimental-strip-types --test --test-name-pattern 'name' tests/x.test.ts
```
Browser tests (`tests/*browser.test.ts`) need Playwright: set `FLURBO_TEST_PLAYWRIGHT` (path to `playwright-core/index.mjs`) and `FLURBO_TEST_BROWSER` (chromium executable), run with `--test-concurrency=1`. Without them they skip. Run `vite build` first. If tests fail on a Windows temp lock, set `TEMP`/`TMP` to a writable dir.

Other components:
- Settlement preparation: `cd workflows/cre && bun install --frozen-lockfile && bun run typecheck && bun test`
- TS SDK: `cd packages/sdk && npm run typecheck && npm test` (local-chain tests need `anvil`/`forge` on PATH and a built `contracts/` checkout)
- Python SDK `packages/sdk-python`, Rust SDK `packages/sdk-rust`, C++ `packages/sdk-cpp`; shared fixtures in `protocol/fixtures`
- Offline settlement replay: `node apps/web/scripts/replay-settlement-chain.mjs`
- Rule check against the live source: `node apps/web/scripts/check-settlement-rule.mjs <rules.json> [--closes-at N] [--proof capture.json]`
- Evidence replay (no credentials): `node apps/web/scripts/verify-settlement-evidence.mjs <url-or-file> --rule-hash <64 hex>`
- Prover for credentialed sources: `cd integrations/source-proofs && npm ci && npm test`; running it is in `docs/PROOF_READER_RUNBOOK.md`. It imports `apps/web/server` by relative path, so `apps/web` must be installed first
- Contracts (in the contracts checkout/repo): `forge build --offline`, `forge test --offline --match-contract WidePilotLifecycleTest`. Set `HOME=$USERPROFILE` and put `~/.foundry/bin` on PATH on Windows.
- Full CI definition: `.github/workflows/checks.yml`

## Architecture

**Server**: `apps/web/server/production.mjs` boots the hosted server (config validated in `network.mjs`; startup errors are intentionally generic, e.g. "Hosting startup failed", so check env). `local-api.mjs` holds the HTTP API. State lives in Upstash Redis (sessions, settlement journal, grants) and Supabase (applications, optional KV). The settlement bot and oracle workers run **in-process** in the web service on timers, so the free Render instance must be kept awake by an external ping to `/healthz`, which also reports `settlement_bot`, `oracle_relay`, `oracle_answerer`.

**Pools and registries**: markets are discovered from `config/collections.json` (`FLURBO_COLLECTIONS_SOURCE=registry`, legacy pilot disabled via `FLURBO_PILOT_DISABLED=true`) and, for oracle pools, `config/oracle-markets.json`. Registries are written by scripts (`workflows/cre/scripts/batch.ts prepare|check|verify|register`, `apps/web/scripts/register-oracle-pool.mjs`) after on-chain verification. Never hand-edit manifests or rerun a broadcast for the same pool id.

**Two pool generations** (resolver is immutable per pool, so new behavior means a new pool):
1. `PilotPool` + `PilotResolver`: 2 to 4 questions, deterministic mechanical readers (`settlement-readers.mjs`: json-api, stat-table, html-text, evm-rpc; `settlement-rules.mjs`, `settlement-evidence.mjs`, `resolution-worker.mjs`), bonded proposal, 1h challenge, operator 2-of-3 reviewer panel.
2. `WidePilotPool` + `WidePilotResolver`: up to 32 questions (claims still span at most 3 events; SDK v1 claim math is capped, wide math is exposed separately in v2 functions). Reality.eth on Sepolia holds answers, Kleros proxy arbitrates, and a **trusted relay** (`oracle-relay-worker.mjs`, `reality-relay.mjs`) reports final answers to Monad. `oracle-integration.mjs` prepares all in-site wallet transactions (answer, bond, arbitration request, evidence, appeal, report ruling, claim). `oracle-answer-worker.mjs` auto-posts the first bonded answer for the two allowlisted Sepolia block questions.
3. In progress: `HybridPilotResolver` (contracts repo, untracked draft) per `docs/SETTLEMENT_ROUTING_V4.md`: per-event route Mechanical or Reality, phases Pending, Proposed, Disputed, Finalized, challenge goes to Kleros, no operator panel.

**Settlement readers** (full reference: `docs/SETTLEMENT_READERS.md`, read it before touching `settlement-rules.mjs`, `settlement-readers.mjs`, `settlement-evidence.mjs`, `settlement-pdf.mjs` or `source-proof.mjs`): twelve adapters. The first eight (`json-api.v1`, `stat-table.v1`, `html-text.v1`, `evm-rpc.v1` and four older single-source ones) are frozen; `tests/settlement-compat.test.ts` pins the hashes of every deployed rule. New behavior is a new adapter name appended to `GENERAL_ADAPTERS`: `json-api.v2` (POST, derived values, time filters), `proof-http.v1` (credentialed sources via a Reclaim TLS proof), `pdf-text.v1`, `xml-feed.v1`. Rules that must hold: a read step is synchronous, offline and deterministic (async work happens at capture time and is re-checked before evidence is archived); `pdfjs-dist` and `fast-xml-parser` are exact pinned versions that a rule commits to, never upgrade them while a rule using them is live; the readers may import only `settlement-rules.mjs` and `source-proof.mjs` because CRE bundles them (run `bun test` in `workflows/cre` after touching imports); source credentials and Reclaim secrets live only on the prover machine, never in the repo or on Render (the only proof variable on Render is `FLURBO_PROOF_SUBMIT_TOKEN`). The worker never fetches a `proof-http.v1` source; the operator-run prover (`integrations/source-proofs/prove.mjs`) uploads proofs to `/api/settlement/proof-captures`. A reader for a new source class needs tests first and a name in `apps/web/src/reader-names.ts`.

**Frontend**: `apps/web/src/pages/Markets.tsx` is the single market directory; oracle markets appear there via `market-directory.ts` and `OracleMarkets.tsx` using the same layout as normal markets (price history, ticket, timeline). Do not build a separate oracle page. Reality/Kleros controls show inside the settlement timeline only when relevant. Member emails use the existing notice engine (`member-notices.mjs`).

**Wallet/accounts**: Mera passkey account (origin-bound to `flurbopm.singu.online`; the primary host is `flurbo.tech`, which reuses those passkeys via WebAuthn related origins, see `docs/DOMAIN_MOVE_FLURBO_TECH.md`), approval is by Mera address, MetaMask trading wallets are linked per account. The company host rejects starter keys without matching `FLURBO_COMPANY_STARTER_ADDRESS` and requires evidence origin to equal `FLURBO_ORIGIN` when the bot is on.

**Settlement design**: objective sources use mechanical readers and an optimistic resolver; only subjective questions use Reality.eth; any challenge goes to Kleros. A shared pool pays only when every question is final. Private-source zkTLS (`integrations/source-proofs`) is mock-tested only and does not settle markets.


Pricing: new hybrid pools are LsPilotPool (pool protocolVersion 5): the liquidity-sensitive LMSR, depth b0 + k * mean liability, k = commission / (n ln 2), commission 100 to 2000 bps (500 by default). LsQuote.sol reuses the frozen factored math unchanged; only b becomes the current depth. Funding and worst-case loss stay b0 * n * ln 2. HybridPilotResolver binds only protocol 5 pools. Protocol 3 pools (WidePilotPool) keep fixed depth and stay readable. Off-chain, apps/web/shared/ls-lmsr.mjs mirrors the depth formula and analytics express LS state in WAD units so pair-math.mjs and the Rust pair binary stay unchanged. Fixtures: py scripts/ls_lmsr_fixtures.py ../Flurbo-contracts. Plan and proof: docs/LS_LMSR_PLAN.md.
Protocol 5 pools return their surplus: `sponsor()` is the deploying account; after close `withdrawSurplus()` (anyone may call, only the sponsor is paid) releases everything above the worst-case liability, and after settlement everything above unredeemed winnings; claims never expire. The hybrid settlement worker sends it from the relay wallet when at least 1 test AUSD is free (`hybrid_settlement.sweeps`). Deployed protocol 3 and pilot pools cannot return funds. Plan: docs/SPONSOR_SURPLUS_PLAN.md.

## Environment notes

- Company and hackathon sites share the deployer wallet, test AUSD token, faucet and starter wallet, but have separate pools, Upstash, Supabase, Resend, Healthchecks, settlement signer and oracle relay/answer wallets. Env var inventory (names only) is in `docs/PROJECT_REFERENCE.md` and `docs/ORACLE_POC_RUNBOOK.md`.
- `render.yaml` sets `FLURBO_SETTLEMENT_BOT=false`; a Blueprint sync can overwrite dashboard values.
- Foundry deploy output is UTF-16 when redirected with `>` in PowerShell; write JSON via `[IO.File]::WriteAllText` with UTF-8 no BOM. The Reality question text uses the U+241F separator.
- Public Monad RPC is limited to 15 req/s; use `FLURBO_TESTNET_RPC_URL` with a private endpoint for registration scripts.
