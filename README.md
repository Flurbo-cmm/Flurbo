# Flurbo

Flurbo is a testnet prediction market for related yes or no questions. Members trade single answers and combinations from one funded on-chain pool. The site uses Mera passkeys for account access and linked MetaMask wallets for trades.

The current product runs on Monad testnet with test AUSD only. Settlement uses public evidence, a bonded proposal, a challenge window and an operator-controlled reviewer panel. It is not a real-money service or an independent arbitration system.

Read [the project reference](docs/PROJECT_REFERENCE.md) for architecture, contracts, settlement, hosting, environment names, operations and migration status.

## Local checks

Use Node 24, Bun, Rust, Python and Foundry as needed by the component. From the repository root:

```sh
npm --prefix apps/web ci
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix apps/mobile ci
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile test
```

The full CI workflow is in `.github/workflows/checks.yml`. The Render Dockerfile builds from the repository root and the deployed service uses `render.yaml`.

## Repository status

This company copy was prepared from the personal repository's local `main` commit `8443469`. The personal repository remains the hackathon submission. The new company repository starts with a clean history after its file list, checks and secret scan are reviewed.
