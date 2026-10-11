# Synthetic settlement workflow

This package holds one CRE workflow target, `synthetic`, defined in `workflow.yaml` and `project.yaml`. Its HTTP trigger (`src/main.ts`) takes synthetic final observations, checks them against the fixed configuration in `fixtures/config.json` with `prepareSettlement` (`src/settlement.ts`), and returns the terminal state and an unsigned ABI report. It signs nothing, delivers nothing and makes no blockchain calls; the RPC entry in `project.yaml` exists only because the CLI requires one. Every input is marked `synthetic-only`.

From this directory, run `bun install --frozen-lockfile`, `bun run typecheck` and `bun test`. `bun run fixtures` regenerates the Solidity report fixtures from the same function, and `bun run fixtures:check` confirms they are current.

Pools are prepared and registered with the hybrid scripts in `apps/web/scripts`. See [the project reference](../../docs/PROJECT_REFERENCE.md) for the contracts, readers, registries and Render behavior.
