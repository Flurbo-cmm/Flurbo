# Flurbo

Flurbo is a testnet prediction market for related yes or no questions. Members trade single answers and combinations from one funded on-chain pool. The site uses Mera passkeys for account access and linked MetaMask wallets for trades.

The current product runs on Monad testnet with test AUSD only. The original company activity pool uses an operator-controlled reviewer panel. New hybrid pools use committed mechanical or Reality.eth routes, with Kleros for challenged answers. The Sepolia-to-Monad delivery is a trusted testnet relay.

Start with [the current handoff](docs/HANDOFF.md) for deployed addresses, architecture, workflow, Render variable names, current gaps and the latest branch work. [The project reference](docs/PROJECT_REFERENCE.md) and [second-site deployment](docs/SECOND_SITE_DEPLOYMENT.md) describe the earlier company migration.

## Local checks

Use Node 24, Bun, Rust, Python and Foundry as needed by the component. From the repository root:

```sh
npm --prefix apps/web ci
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build
```

The full CI workflow is in `.github/workflows/checks.yml`. The Render Dockerfile builds from the repository root and the deployed service uses `render.yaml`.

## Contracts checkout

Contract source lives in the private `Flurbo-cmm/Flurbo-contracts` repository. Local Foundry, settlement preparation and SDK local-chain checks expect a second checkout at `contracts/`. Use the exact commit pinned in `.github/workflows/checks.yml`, currently `a3c696f49daad145a40c7ca050db56a34d5b32b9`:

```sh
git clone https://github.com/Flurbo-cmm/Flurbo-contracts.git contracts
git -C contracts checkout a3c696f49daad145a40c7ca050db56a34d5b32b9
npm --prefix contracts ci
forge test --offline
```

The CI `sdks` job checks out that exact commit using a read-only fine-grained token stored as `FLURBO_CONTRACTS_READ_TOKEN`. The token needs Contents: read access to `Flurbo-contracts`. The web Docker build does not fetch or package contract source.

## Repository status

This company repository started from the personal repository's local `main` commit `8443469` and was initialized at company commit `6d144cc`. The personal repository remains the hackathon submission. Mobile and the privacy lab remain there and are outside the startup web release. The Android asset-links configuration stays here only for compatibility with previously installed preview builds.
