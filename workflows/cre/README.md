# Market preparation and settlement workflows

This package validates public event drafts, prepares deterministic settlement rules and batch deployment files, verifies deployed pools, and edits `config/collections.json`. The prepared files are local artifacts under `target/deployments` and are not credentials.

From the repository root, run `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` in `workflows/cre`. For a new pool batch, use `bun workflows/cre/scripts/batch.ts prepare --spec config/markets/<name>.json`, then `check --ids <ids>`. The owner simulates and deploys with Foundry, then runs `verify --ids <ids>` and `register --ids <ids>`. Review the resulting registry before release.

See [the project reference](../../docs/PROJECT_REFERENCE.md) for the current contract, reader, registry and Render behavior. Keep private keys and provider URLs out of batch specifications.
