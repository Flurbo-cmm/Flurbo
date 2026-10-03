# flurbo-sdk for Rust (0.2.0-beta.0, private)

Purchase safety: before approving or signing a new buy, the runtime asks the backend outcome-compatibility endpoint. When the server enforces compatibility rules, known collisions stop the purchase and unknown combinations abstain; if the endpoint cannot be reached, the buy does not proceed. The public testnet currently runs with these rules switched off, so every buy logs `SEMANTICS_DISABLED` and relies on your policy limits alone. Paper fills use the same check. Sell, redemption and already-signed recovery remain available. Review [configuration and rollout requirements](../../protocol/specs/semantics.md) before upgrading a live agent.

Every configuration key, including research providers, `extraSources` and `evidenceRequirements`, is described in the [agent configuration reference](../../docs/AGENT_CONFIG_REFERENCE.md).


Rust SDK and runtime for Flurbo agents on Monad testnet (chain 10143, test assets only), built against the shared protocol in [protocol/](../../protocol) and checked against the same golden fixtures as the TypeScript reference. Not published to crates.io. Not a mainnet product and not a promise of profit.

## Setup

A Rust toolchain (tested with 1.97.1). From a checkout of the repository:

```bash
cd packages/sdk-rust
cargo build --release
./target/release/flurbo-agent-rs init --config flurbo-agent.json --markets <names from the agent's Setup page>
```

Dependencies: `k256` (secp256k1 with RFC 6979 signing), `sha3` (keccak), `serde` and `serde_json`, `getrandom`, and `ureq` with rustls for HTTP. All are MIT or Apache-2.0, except rustls's own dependencies (ISC, BSD-3-Clause) and the bundled web root certificates (CDLA-Permissive-2.0). The protocol core (`claims`, `abi`, `amounts`, `policy`, `recovery`, `effects`, `research`, `strategy`, `transaction`, `protocol`) does no I/O.

The configuration file is the same `flurbo.agent-config.v1` format the TypeScript and Python runtimes use. Secrets come only from environment variables named in it: `FLURBO_AGENT_TOKEN`, `FLURBO_AGENT_PRIVATE_KEY` for live mode, and your model provider's key variable.

| Command | Effect |
| --- | --- |
| `flurbo-agent-rs start [--once]` | Run the loop in the foreground |
| `flurbo-agent-rs stop` | Ask a running agent to stop after its current step |
| `flurbo-agent-rs status` | Mode, transactions in progress, what the last run recorded |
| `flurbo-agent-rs recover` | Reconcile and report existing transactions only |
| `flurbo-agent-rs address` | The agent wallet address |
| `flurbo-agent-rs sign-message --file F` | Sign a Flurbo wallet association message (refuses anything else) |

Add `--config flurbo-agent.json` to each. Ctrl+C ends the process at once; the journal is crash-safe, so the next start reconciles any transaction that was in flight. Use `stop` to finish the current step first.

## What it implements

- Headless API client (credential only in the Authorization header), chain reads with deployment verification, calldata encoding and validation before signing, and a local key signer behind the `Signer` trait for remote signers.
- Deterministic policy with Flurbo's published policy as a tightening layer. Live permission requires local live mode, live trades allowed on Flurbo, not paused and a fresh policy.
- A journal in the same format and with the same lock file as the other runtimes, keeping fields it does not know. Crash recovery resends only identical signed bytes; replaced and expired transactions are released; receipts are verified one block deep before success is reported; reporting is idempotent.
- Research: allowlisted retrieval, OpenAI-compatible and Anthropic adapters with timeouts, bounded retries and request budgets; validated model output; abstention with reasons; fixtures labelled as fixtures.
- The reference strategy `joint-edge` v1, identical to the other SDKs on `protocol/fixtures/strategy.json`, and any custom `Strategy` or `Forecaster` implementation.

Control, custody and attribution are as described in [packages/sdk/README.md](../sdk/README.md). Credentials only read and report. Keys stay local. Policies are software checks, and pause and revocation are instructions to a compliant runtime, not on-chain freezes.

## Evidence v2 and freshness

The research runtime now requires `flurbo.agent-evidence.v2`. Custom retrievers must supply the full envelope in [the research protocol](../../protocol/specs/research.md): complete body capture, byte count and SHA-256, requested and final URLs, associated event indices, retrieval time, a separately established publisher release time (or explicit null), and HTTP Last-Modified (or explicit null). Legacy `publishedAt` records are not upgraded because their provenance and completeness cannot be recovered.

The HTTP retriever rejects empty, interrupted, partial and oversized bodies. It hashes the entire completed response even when the displayed excerpt is shorter. It records Last-Modified only as HTTP metadata; generic retrieval cannot establish a release date. Missing publication evidence therefore makes release-sensitive research abstain before calling a model.

Every requested event needs at least one cited, valid and fresh associated record. The default freshness basis is the publisher release time. For a source that is deliberately being used as background material, the operator may explicitly choose retrieval freshness for that event:

```json
{
  "research": {
    "evidenceRequirements": {
      "pilot": [
        { "event": 0, "freshness": "background" },
        { "event": 1, "freshness": "background" }
      ]
    }
  }
}
```

Merge this fragment into the existing configuration. Unlisted events retain `release` freshness. Background retrieval does not prove a newly published result or authorize settlement. The lower-level `Researcher::research_with_requirements` accepts the same explicit policy; `research` keeps the release-sensitive default. Unusable sources remain abstentions rather than forecasts repaired by the SDK.

The forecast v1 `observedAt` projection and the strategy's fresh-evidence count preserve this policy. A record associated with any requested release-sensitive event uses publication freshness, even if it also supplies background evidence. Only records whose associated requested events all explicitly select background use retrieval time. Unknown required release dates and unrelated citations are omitted from the v1 projection and cannot inflate its fresh-evidence count. Their original records and model citation IDs remain in the research result.

## Examples

- `cargo run --example offline_pipeline`: offline pipeline with a fixture forecaster (not AI).
- `cargo run --example ai_agent -- flurbo-agent.json`: a real model provider from the configuration.
- `cargo run --example custom_strategy -- flurbo-agent.json`: your own strategy and research plugged into the runner.

## Tests

```bash
cargo test
```

`tests/conformance.rs` runs every shared fixture: claims, calldata, signed transactions and messages byte for byte, amounts, policy, recovery, research and strategy. `tests/runtime_units.rs` covers retrieval, providers, budgets, the headless client, the journal lock across processes and the command line. `tests/local_chain.rs` trades on a local anvil chain against the real Flurbo API through `packages/sdk/tools/serve-local-stack.ts`. It needs Node 24, anvil and `forge build`, and it skips with a message when they are missing.
