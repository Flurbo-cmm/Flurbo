# flurbo-sdk for C++ (0.2.0-beta.0, private)

Research evidence now uses `flurbo.agent-evidence.v2`, with full-capture provenance, independent publisher/HTTP timestamps and per-event citation coverage. Legacy records must be regenerated. Generic HTTP retrieval cannot establish publisher release time; operators must explicitly select per-event background research where appropriate through `research.evidenceRequirements`. See [the research protocol](../../protocol/specs/research.md). Oversized or incomplete HTTP responses now fail instead of returning a silently shortened body. C++ retrieval requests identity transfer content and rejects unsupported content encodings rather than treating compressed bytes as evidence.

Purchase safety: before approving or signing a new buy, the runtime asks the backend outcome-compatibility endpoint. When the server enforces compatibility rules, known collisions stop the purchase and unknown combinations abstain; if the endpoint cannot be reached, the buy does not proceed. The public testnet currently runs with these rules switched off, so every buy logs `SEMANTICS_DISABLED` and relies on your policy limits alone. Paper fills use the same check. Sell, redemption and already-signed recovery remain available. Review [configuration and rollout requirements](../../protocol/specs/semantics.md) before upgrading a live agent.

Every configuration key, including research providers, `extraSources` and `evidenceRequirements`, is described in the [agent configuration reference](../../docs/AGENT_CONFIG_REFERENCE.md).


C++ SDK and runtime for Flurbo agents on Monad testnet (chain 10143, test assets only), built against the shared protocol in [protocol/](../../protocol) and checked against the same golden fixtures as the TypeScript reference. Not published. Not a mainnet product and not a promise of profit.

## Setup

GNU make, a C++20 compiler with `__int128` (GCC or Clang), and OpenSSL 3.2 or later (for deterministic ECDSA and Keccak-256). Tested with GCC 15.2 and OpenSSL 3.6 on Windows (MSYS2 UCRT64), and with GCC 13.3 on Ubuntu 24.04 against OpenSSL 3.5 built from source. macOS uses the same sources and Makefile but was not run here. MSVC is not supported (no `__int128`).

```bash
cd packages/sdk-cpp
make                                   # Windows (MSYS2): mingw32-make, with C:\msys64\ucrt64\bin on PATH
./build/flurbo-agent-cpp init --config flurbo-agent.json --markets <names from the agent's Setup page>
```

On Windows, keep `C:\msys64\ucrt64\bin` on PATH whenever you run the program too, not only while building. The executable loads the compiler's runtime and OpenSSL libraries from there; without them Windows stops it before it starts, with exit code 127 and no message. In Git Bash: `export PATH="/c/msys64/ucrt64/bin:$PATH"`. In PowerShell: `$env:Path = "C:\msys64\ucrt64\bin;" + $env:Path`.

### Linux with an older system OpenSSL

Ubuntu 24.04 and Debian 12 ship OpenSSL 3.0, which lacks the deterministic ECDSA nonces this SDK signs with; the build then stops with "needs OpenSSL 3.2 or later". Build a newer OpenSSL into your home directory and point the build at it:

```bash
curl -LO https://github.com/openssl/openssl/releases/download/openssl-3.5.4/openssl-3.5.4.tar.gz
tar xzf openssl-3.5.4.tar.gz && cd openssl-3.5.4
./Configure --prefix="$HOME/openssl-3.5" --libdir=lib no-tests no-docs && make -j"$(nproc)" && make install_sw
cd /path/to/Flurbo/packages/sdk-cpp
export CPPFLAGS="-I$HOME/openssl-3.5/include" LDFLAGS="-L$HOME/openssl-3.5/lib -Wl,-rpath,$HOME/openssl-3.5/lib"
make && make test
```

Pass `CPPFLAGS` and `LDFLAGS` through the environment as shown, not as `make` arguments, so the Makefile keeps its own include path. The rpath makes the runner and tests use that OpenSSL at run time without `LD_LIBRARY_PATH`.

Dependencies: OpenSSL (Apache-2.0) for secp256k1 signing with RFC 6979 nonces, Keccak-256, SHA-256 and TLS. HTTPS verifies certificates and host names; on Windows the system root store is loaded. The JSON value type and the HTTP/1.1 client are part of the SDK. The protocol core (`core`, `policy`, `research`) does no I/O.

The configuration file is the same `flurbo.agent-config.v1` format the other runtimes use. Secrets come only from environment variables named in it: `FLURBO_AGENT_TOKEN`, `FLURBO_AGENT_PRIVATE_KEY` for live mode, and your model provider's key variable.

| Command | Effect |
| --- | --- |
| `flurbo-agent-cpp start [--once]` | Run the loop in the foreground |
| `flurbo-agent-cpp stop` | Ask a running agent to stop after its current step |
| `flurbo-agent-cpp status` | Mode, transactions in progress, what the last run recorded |
| `flurbo-agent-cpp recover` | Reconcile and report existing transactions only |
| `flurbo-agent-cpp address` | The agent wallet address |
| `flurbo-agent-cpp sign-message --file F` | Sign a Flurbo wallet association message (refuses anything else) |

Add `--config flurbo-agent.json` to each. Ctrl+C ends the process at once; the journal is crash-safe, so the next start reconciles any transaction that was in flight. Use `stop` to finish the current step first.

## What it implements

- Headless API client (credential only in the Authorization header), chain reads with deployment verification, calldata encoding and validation before signing, and a local key signer behind the `Signer` interface for remote signers.
- Deterministic policy with Flurbo's published policy as a tightening layer. Live permission requires local live mode, live trades allowed on Flurbo, not paused and a fresh policy.
- A journal in the same format and with the same lock file as the other runtimes. Entries are kept as JSON objects, so fields written by another runtime survive. Crash recovery resends only identical signed bytes; replaced and expired transactions are released; receipts are verified one block deep before success is reported; reporting is idempotent.
- Research: allowlisted retrieval, OpenAI-compatible and Anthropic adapters with timeouts, bounded retries and request budgets; validated model output; abstention with reasons; fixtures labelled as fixtures.
- The reference strategy `joint-edge` v1, identical to the other SDKs on `protocol/fixtures/strategy.json`, and any custom `Strategy` or `Forecaster`.

Control, custody and attribution are as described in [packages/sdk/README.md](../sdk/README.md). Credentials only read and report. Keys stay local. Policies are software checks, and pause and revocation are instructions to a compliant runtime, not on-chain freezes.

## Examples

Built by `make` into `build/`:

- `offline_pipeline`: offline pipeline with a fixture forecaster (not AI).
- `ai_agent flurbo-agent.json`: a real model provider from the configuration.
- `custom_strategy flurbo-agent.json`: your own strategy and research plugged into the runner.

## Tests

```bash
make test         # conformance and runtime unit tests
make test-chain   # the local-chain tests
```

`tests/conformance.cpp` runs every shared fixture: claims, calldata, signed transactions and messages byte for byte, amounts, policy, recovery, research and strategy. `tests/runtime_units.cpp` covers retrieval, providers, budgets, the headless client, the journal lock across processes and the command line. `tests/local_chain.cpp` trades on a local anvil chain against the real Flurbo API through `packages/sdk/tools/serve-local-stack.ts`. It needs Node 24, anvil and `forge build`, and it skips with a message when they are missing.
