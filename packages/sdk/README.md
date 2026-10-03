# @flurbo/sdk (0.2.0-beta, private)

Research evidence now uses `flurbo.agent-evidence.v2`: full-capture provenance, separate publication/transport timestamps, and cited evidence coverage for each event. Legacy captures must be regenerated. Generic HTTP capture has no verified publication time and defaults to abstention for release freshness; background research requires explicit per-event `research.evidenceRequirements` configuration. See [the research protocol and migration policy](../../protocol/specs/research.md). This does not change market settlement or transaction permissions.

Purchase safety: before approving or signing a new buy, the runtime asks the backend outcome-compatibility endpoint. When the server enforces compatibility rules, known collisions stop the purchase and unknown combinations abstain; if the endpoint cannot be reached, the buy does not proceed. The public testnet currently runs with these rules switched off, so every buy logs `SEMANTICS_DISABLED` and relies on your policy limits alone. Paper fills use the same check. Sell, redemption and already-signed recovery remain available. Review [configuration and rollout requirements](../../protocol/specs/semantics.md) before upgrading a live agent.

Every configuration key, including research providers, `extraSources` and `evidenceRequirements`, is described in the [agent configuration reference](../../docs/AGENT_CONFIG_REFERENCE.md).


TypeScript SDK and reference runtime for Flurbo agents on Monad testnet (chain 10143, test assets only). It is the reference implementation of the shared protocol in [protocol/](../../protocol). Not published to npm. Not a mainnet product and not a promise of profit.

## What you can build

An agent that runs on your own computer or server, researches Flurbo markets, forecasts how their events relate, compares that with the pool's executable prices and trades from its own dedicated wallet, without a browser or a MetaMask confirmation per trade. Flurbo shows its status, decisions and verified trades on the agent page.

```
research (retrieval + your model or code) -> validated joint forecast -> strategy -> deterministic policy
  -> quote and simulation on your RPC -> journal -> sign (your key) -> broadcast -> receipt -> verify -> report
```

The model never builds transactions and has no tools. It returns a structured forecast, validated before use; everything after that is deterministic code.

## Setup

Node 24 or later. From a checkout of the repository:

```bash
cd packages/sdk && npm ci
node bin/flurbo-agent.ts init --config flurbo-agent.json --markets <names from the agent's Setup page>   # paper mode, no secrets
```

On the agent page (flurbo.singu.online/agents): register the agent, link its dedicated wallet (`flurbo-agent sign-message --file message.txt` signs the ownership message with the agent key), issue a credential, and later allow live trades. Then set secrets in the environment, never in files:

```bash
export FLURBO_AGENT_TOKEN=fla1_...            # the credential, shown once on the agent page
export FLURBO_AGENT_PRIVATE_KEY=0x...         # the dedicated agent wallet key, live mode only
export OPENAI_API_KEY=...                     # or whichever variable your provider uses
```

| Command | Effect |
| --- | --- |
| `flurbo-agent start [--once]` | Run the loop in the foreground (`--once`: one cycle) |
| `flurbo-agent stop` | Ask a running agent to stop after its current step |
| `flurbo-agent status` | Mode, transactions in progress and what the last run recorded |
| `flurbo-agent recover` | Reconcile and report existing transactions only; starts nothing new |
| `flurbo-agent address` | The agent wallet address |
| `flurbo-agent sign-message --file F` | Sign a Flurbo wallet association message (refuses anything else) |

Run them as `node bin/flurbo-agent.ts <command> --config flurbo-agent.json`.

## Configuration (`flurbo.agent-config.v1`)

- `mode`: `paper` (default) never constructs a signer. `live` needs this setting **and** live trades allowed on the agent page.
- `markets`, `policy.markets`: namespaces the agent may trade.
- `research.provider`: `openai-compatible` (hosted providers or a local model server), `anthropic`, `fixture` (a fixed reply file, always labelled as a fixture, never AI) or `none`. Timeouts, bounded retries and `perCycle` / `perHour` request budgets apply. Check your provider's current terms and prices.
- `research.retriever`: allowlisted HTTPS hosts. Each market publishes a source per event; `extraSources` adds more.
- `strategy`: the reference `joint-edge` settings.
- `policy`: exact limits (per-trade cost and quantity, lifetime and time-window spending, per-claim position, worst-case loss across overlapping claims, slippage, gas fee and reserve, quote age, time before close, pending transactions, sell and redeem switches). Definitions: [protocol/specs/transactions.md](../../protocol/specs/transactions.md).

## Control, stated precisely

- The API credential reads and reports. It cannot sign or move funds, and it never reaches settlement, assertion, challenge or reviewer actions.
- The wallet key never leaves your machine. Flurbo never asks for it or a seed phrase. Keep secrets out of files, logs, URLs and prompts; the SDK never logs them.
- Policies are software checks in this runtime. The funded wallet bounds what is at risk; a raw key can bypass any SDK policy.
- A dashboard pause is an instruction the runtime reads before each new action. Revoking the credential stops a compliant runtime from starting actions. Neither is an on-chain freeze: a transaction already sent can still confirm. None of this is cryptographically enforced delegation.

## Recovery

The runtime journals every intent before signing, records the signed bytes before broadcasting, and after a crash resends only those identical bytes (same hash), never a new transaction. Replaced and expired transactions are released; nothing is retried with wider slippage or more spending. One state directory per agent wallet; several processes may share it (a lock file serialises them and spending reservations). Details: [protocol/specs/transactions.md](../../protocol/specs/transactions.md).

## Examples

| File | Shows |
| --- | --- |
| `examples/offline-autonomous-pipeline.ts` | The whole pipeline offline with a fixture forecaster; prints the transaction it would sign |
| `examples/ai-agent.ts` | A real model provider, retrieval, strategy, policy and live execution from a config file |
| `examples/custom-strategy.ts` | Your own strategy and research plugged into the runner without changing the SDK |
| `examples/offline-research.ts` | The earlier assisted flow: forecast, decision and paper trade |

## Local chain and acceptance demonstration

`tools/local-stack.ts` starts an anvil chain with chain id 10143, local test AUSD at the canonical address, a funded pilot pool and the real Flurbo API. `node tools/acceptance-demo.ts` runs an agent outside the browser through every acceptance step. Needs anvil and a `forge build` in the repository root.

## Tests and typechecks

```bash
node --test test/*.test.ts                                    # protocol fixtures, units, local-chain end to end
node ../../apps/web/node_modules/typescript/bin/tsc -p tsconfig.json        # core (ES2022, no Node or DOM)
node ../../apps/web/node_modules/typescript/bin/tsc -p tsconfig.node.json   # runtime, CLI, examples
```

`test/runtime-local.test.ts` and `test/dashboard-browser.test.ts` need anvil and the forge build; the dashboard test also needs `FLURBO_TEST_PLAYWRIGHT` and `FLURBO_TEST_BROWSER`.

## Other languages

The Python ([packages/sdk-python](../sdk-python/README.md)), Rust ([packages/sdk-rust](../sdk-rust/README.md)) and C++ ([packages/sdk-cpp](../sdk-cpp/README.md)) SDKs implement the same protocol, reproduce the same fixtures, read the same configuration file and keep the same journal format and lock. `node protocol/tools/conformance.mjs` from the repository root checks all four.
