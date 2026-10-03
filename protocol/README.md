# Flurbo agent protocol, version 1

One specification shared by the TypeScript, Python, Rust and C++ SDKs. An SDK conforms when it reproduces every golden fixture exactly and follows the lifecycle and recovery rules below.

| Document | Contents |
| --- | --- |
| [specs/numbers.md](specs/numbers.md) | Units, precision, rounding, probability representation |
| [specs/claims.md](specs/claims.md) | Canonical claims (`flurbo.claim.v1`) |
| [specs/contracts.md](specs/contracts.md) | Contract ABI subset, deployment compatibility, service limits |
| [specs/auth.md](specs/auth.md) | Agent credentials and agent wallet association |
| [specs/transactions.md](specs/transactions.md) | Transaction lifecycle, journal, policies and recovery |
| [specs/semantics.md](specs/semantics.md) | Pre-trade outcome compatibility, operator metadata, manual exceptions and agent abstention |
| [specs/research.md](specs/research.md) | Retrieval, model output and its validation |
| [openapi/agent-runtime.v1.yaml](openapi/agent-runtime.v1.yaml) | Hosted headless API |
| [schemas/](schemas) | JSON Schemas for payloads, errors and the journal |
| [abi/](abi) | ABI fragments the SDKs encode and decode |
| [fixtures/](fixtures) | Golden fixtures every SDK must reproduce |

## Versions

- Protocol version: `1`. Clients send `Flurbo-Agent-Protocol: 1` on every request. The server rejects any other value with `UNSUPPORTED_PROTOCOL`.
- API base path: `/api/agent-runtime/v1`. A breaking change gets a new path.
- Every payload names its schema (for example `flurbo.agent-deployment.v1`). A consumer rejects a schema it does not recognise instead of guessing.
- Deployment interface: `flurbo.pilot-pool.v1` on chain `10143` (Monad testnet). An SDK refuses any other chain or interface.

## Compatibility rules

- Additive fields may appear in any version-1 response. Clients ignore fields they do not know, except inside objects that the schema marks closed.
- Enumerations may gain values. A client that meets an unknown status treats it as "unknown, do not act".
- Removing or retyping a field, or changing rounding, requires a new protocol version.
- Fixtures are versioned with the protocol. A fixture change in version 1 is only allowed to fix an error, and every SDK is updated in the same change.

## Conformance

`node protocol/tools/conformance.mjs` checks that the schemas and fixtures regenerate identically from the TypeScript reference, then runs the fixtures in the TypeScript, Python, Rust and C++ SDKs. With `--full` it also runs every unit and local-chain suite (anvil and `forge build` required). A missing toolchain fails the run. Signatures in `fixtures/calldata.json` are also checked against Foundry with `protocol/tools/check-with-cast.mjs`.

## What the protocol does not grant

API credentials read data and report runtime activity. They never sign, never move funds and never grant assertion, challenge, reviewer or settlement authority. Signing happens only in the operator's runtime with a key the operator controls.
