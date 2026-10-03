# Web client and server

The Vite/React client lives in `src`. The Node API, access controls, data stores and settlement bot live in `server`. This package needs sibling `apps/dashboard`, `packages/sdk`, `config`, `crates/flurbo-core` and `scripts` for its current Docker build.

From the repository root, run `npm --prefix apps/web ci`, then `npm --prefix apps/web run dev`. The local site uses `http://localhost:18767`. Typecheck, test and build scripts are in `package.json`.

The production service is built by `apps/web/Dockerfile` from the repository root. Read [the project reference](../../docs/PROJECT_REFERENCE.md) for Render environment names, origin requirements and settlement behavior. Local `.env` files and private keys must stay outside Git.
