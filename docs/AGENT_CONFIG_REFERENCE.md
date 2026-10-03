# Agent configuration reference

All four runtimes (TypeScript, Python, Rust, C++) read the same `flurbo.agent-config.v1` JSON file. `init` writes a paper-mode file with safe defaults; `init --markets A,B` also writes the agent's markets (the agent's Setup page on Flurbo shows that exact line). This page describes every key. Key names are camelCase in every language. Secrets never go in this file: it names environment variables instead, and the runtimes refuse a file with a `privateKey` or `secret` field holding a key.

## Top level

| Key | Default | Meaning |
|---|---|---|
| `schema` | `flurbo.agent-config.v1` | Required, exact. |
| `mode` | `paper` | `paper` simulates fills; `live` signs and sends. Live trading also needs "Allow live testnet trades" on the agent's Flurbo page. |
| `markets` | `["pilot"]`, or the list given to `init --markets` | Market namespaces the agent may read: `pilot` or `practice-<pool address without 0x>`. |
| `stateDir` | `.flurbo-agent` | Journal, paper book and runtime status. Keep it private; never delete the journal of a live agent. |
| `api.baseUrl` | `https://flurbo.singu.online` | Flurbo API. |
| `api.credentialEnv` | `FLURBO_AGENT_TOKEN` | Environment variable holding the agent credential issued on the Agents page. |
| `chain.rpcUrl` | `https://testnet-rpc.monad.xyz` | Monad testnet RPC. |
| `signer.keyEnv` | `FLURBO_AGENT_PRIVATE_KEY` | Environment variable holding the agent wallet key (live mode only). |
| `schedule` | 300 s cycle, 30 s heartbeat, 90 s receipt wait | Minimum cycle 10 s, heartbeat 5 s. |
| `paperBudgetAtoms` | `50000000` (50 test AUSD) | Paper-mode bankroll. |
| `policyMaxAgeSeconds` | `120` | How old the limits read from Flurbo may be before live trading pauses. |

Amounts are strings of atoms: 1 test AUSD is `1000000`.

## Research

A decision needs a forecast, and a forecast must cite retrieved evidence.

| Key | Default | Meaning |
|---|---|---|
| `research.provider` | `{"kind": "none"}` | Where forecasts come from; see below. With `none`, every cycle abstains with `provider_not_configured`. |
| `research.retriever.allowHosts` | `["github.com"]` | HTTPS hosts evidence may be fetched from. Each cycle the runtime fetches the record settlement reads for each question (the market's `source.referenceUrl`) plus `extraSources`; a market's own source hosts must be listed here. Responses over 2 MB are skipped. |
| `research.retriever.allowLocalHttp` | `false` | Allows `http://127.0.0.1` sources for local testing only. |
| `research.retriever.extraSources` | none | Additional evidence pages, **keyed by market namespace**, see below. |
| `research.perCycle`, `research.perHour` | `2`, `20` | Provider request budgets. |
| `research.maxEvidenceAgeDays` | `14` | Maximum evidence age; how age is measured depends on `evidenceRequirements`. |
| `research.evidenceRequirements` | none (every event `release`) | Per-market freshness rules, see below. |

### Providers

```json
{ "kind": "openai-compatible", "baseUrl": "https://api.example.com/v1", "model": "model-name", "apiKeyEnv": "OPENAI_API_KEY" }
{ "kind": "anthropic", "model": "model-name", "apiKeyEnv": "ANTHROPIC_API_KEY" }
{ "kind": "fixture", "replyFile": "forecast.json" }
{ "kind": "none" }
```

`timeoutMs` and `maxRetries` are optional on the model providers. `apiKeyEnv` may be `null` for an OpenAI-compatible server that needs no key.

`fixture` reads a fixed reply from `replyFile`, resolved relative to the directory that contains `stateDir`. Use it for offline runs and demonstrations; its forecasts are always labelled "fixture (not AI)" in Flurbo. The file must contain exactly what a model would return:

```json
{
  "schema": "flurbo.agent-model-forecast.v1",
  "abstain": false,
  "abstainReason": null,
  "events": [0, 1],
  "statesPpm": [100000, 200000, 200000, 500000],
  "evidenceIds": ["<id of a record the retriever returned this cycle>"],
  "assumptions": ["..."],
  "uncertainty": "...",
  "explanation": "..."
}
```

`statesPpm` lists the joint states of the listed events in parts per million and must sum to 1,000,000. State index bit *j* is 1 when the *j*-th listed event resolves Yes, so for two events the order is (No, No), (Yes, No), (No, Yes), (Yes, Yes). `evidenceIds` must cite records retrieved in the same cycle, so a fixture still needs working sources.

### `extraSources`

A map from market namespace to a list of `{event, url}`. It is **not** a plain list; a list does not work (the Python runtime stops with an error).

```json
"extraSources": {
  "pilot": [
    { "event": 0, "url": "https://github.com/ethereum/go-ethereum/releases" },
    { "event": 1, "url": "https://github.com/paradigmxyz/reth/releases" }
  ]
}
```

`event` is the question index within that market (0 for the first question). Every URL's host must also be in `allowHosts`.

Every question in a decision needs at least one readable page that cycle, or the runtime abstains: `no_sources` when nothing could be read, `missing_event_evidence` when one question has nothing. The record settlement reads often cannot serve: it may not exist until the result is published (a dated statistics release, for example), and chain endpoints answer JSON-RPC rather than page requests. Add a page for each such question here. The agent's Setup page on Flurbo shows a research section already filled in for its markets.

### `evidenceRequirements`

A map from market namespace to per-event freshness rules. Each namespace must also appear in `markets`, and each event may appear once.

```json
"evidenceRequirements": {
  "pilot": [
    { "event": 0, "freshness": "background" },
    { "event": 1, "freshness": "background" }
  ]
}
```

- `release` (the default for any event not listed): the page must show when the publisher released it, and that release must be within `maxEvidenceAgeDays`. An undated page never qualifies.
- `background`: freshness is measured from when the page was retrieved. Use it for pages without a publication date, such as a GitHub releases list. It does not mean the result has been observed.

If every run abstains with `stale_evidence` on undated pages, set `background` for those events. The full rules are in [protocol/specs/research.md](../protocol/specs/research.md).

## Strategy

| Key | Default | Meaning |
|---|---|---|
| `strategy.id` | `joint-edge` | Built-in strategy; custom strategies plug in through each SDK's API. |
| `strategy.quantityAtoms` | `1000000` | Shares per proposal (1 share). |
| `strategy.slippageBps` | `50` | 10, 50 or 100, and no more than `policy.maxSlippageBps`. |
| `strategy.minEdgeBps`, `strategy.minEdgeAtoms` | `500`, `10000` | Minimum expected edge, relative and absolute, before proposing. |
| `strategy.maxCostAtoms` | `2000000` | Largest cost per proposal. |
| `strategy.includeSingles` | `true` | Also consider single-answer claims, not only combinations. |
| `strategy.minEvidence` | `1` | Minimum cited records per forecast. |

## Policy

The runtime enforces these before anything is signed, and tightens them with any limits set on the agent's Flurbo page.

| Key | Default | Meaning |
|---|---|---|
| `policy.markets` | Same as `markets` | Must be a subset of `markets`. |
| `policy.maxQuantityAtoms` | `2000000` | Shares per trade. |
| `policy.maxTradeCostAtoms` | `2000000` | Cost per trade. |
| `policy.maxSlippageBps` | `50` | 10, 50 or 100. |
| `policy.spend.totalAtoms` | `20000000` | Lifetime spend. |
| `policy.spend.windows` | 10 test AUSD per 24 hours | Rolling spend windows, `[{"seconds": 86400, "atoms": "10000000"}]`. |
| `policy.maxPositionAtoms` | `5000000` | Largest holding per claim. |
| `policy.maxWorstCaseLossAtoms` | `10000000` | Worst-case loss across overlapping claims. |
| `policy.gas.maxFeeWei`, `policy.gas.reserveWei` | 0.1 MON, 0.2 MON | Largest fee per transaction; MON always kept back. |
| `policy.quoteMaxAgeSeconds` | `30` | Quotes older than this are refreshed, never used. |
| `policy.minSecondsBeforeClose` | `120` | Stop trading this long before a market closes. The runtime logs `too_close_to_close` and skips the market. The site's own trading stays open until the close. |
| `policy.maxPending` | `2` | Unconfirmed transactions allowed at once. |
| `policy.allowSell`, `policy.allowRedeem` | `false`, `false` | Permit sells and redemptions. |

## Outcome-compatibility checks

Before a new buy the runtime also asks Flurbo's outcome-compatibility endpoint. The public testnet currently runs with these rules switched off, so every buy logs `SEMANTICS_DISABLED` and relies on the policy above. If the endpoint cannot be reached, the buy does not proceed (`SEMANTICS_UNAVAILABLE`). See [protocol/specs/semantics.md](../protocol/specs/semantics.md).
