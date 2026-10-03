# Research and model output

The research layer turns market questions into a validated forecast. It never builds, signs or sends transactions, and its output cannot change wallets, contracts, recipients, amounts, budgets or policies.

## Retrieval

A retriever returns `flurbo.agent-evidence.v2` records. Retrieved text is untrusted data. It is passed to a model only inside clearly delimited, escaped data blocks. Evidence ids and event associations come from retrieval configuration or a reviewed source adapter, never from model output.

| Field | Meaning |
| --- | --- |
| `schema` | `flurbo.agent-evidence.v2` |
| `id`, `title`, `publisher` | Retriever-assigned reference and source labels |
| `requestedUrl`, `finalUrl`, `url` | Requested reference, final allowlisted URL after redirects, and compatibility alias equal to `finalUrl` |
| `retrievedAt` | Capture time, integer Unix seconds |
| `publisherReleasedAt` | Publisher release time extracted by a source-specific adapter, or `null` |
| `httpLastModified` | HTTP transport metadata, integer Unix seconds or `null`; never a substitute for publication time |
| `contentSha256`, `capturedBytes` | SHA-256 of the entire captured response body and its byte count, before text extraction |
| `completeDocument` | True only after the full bounded response has been read successfully |
| `excerpt` | Nonempty extracted text, optionally shortened for model input; shortening this display text does not mean the HTTP capture was partial |
| `eventIds` | Distinct in-range event indices explicitly associated with this document |

Generic HTTP retrieval cannot establish a publisher release time, so it emits `publisherReleasedAt: null`. It does not infer publication from retrieval, HTTP Last-Modified, a model answer, or an operator-supplied date. A release adapter must extract the documented field from the captured publisher record. The envelope establishes provenance, not source truth or factual relevance.

Empty, oversized, truncated and failed responses produce no citable evidence. HTTP partial responses (206 or Content-Range) are rejected. Redirects are allowlist-checked before following each hop. The hash covers the full uncompressed response body exposed by the transport; it is not a claim to archive response headers or original wire encoding. A complete body can still contain incomplete information, which remains an extraction or interpretation concern.

## Freshness and event coverage

The caller supplies `evidenceRequirements: [{event, freshness}]`. `freshness` is either `release` or `background`; omitted events default to `release`. Each requested event must have at least one cited, qualifying associated record.

- `release`: `publisherReleasedAt` must be known and no older than `maxEvidenceAgeSeconds`. An undated page retrieved now cannot qualify.
- `background`: the operator explicitly permits background research and freshness uses `retrievedAt`. This does not represent recent publication or an observation of the event result.

All cited records must have valid v2 provenance, positive captured bytes, nonempty text and a nonempty-body SHA-256. Retrieval and release times must be nonnegative integer seconds with `publisherReleasedAt <= retrievedAt <= now`. Last-Modified is separately recorded transport metadata, including a possible future server date, and never participates in freshness. Policies cannot be selected or weakened by evidence text or model output.

The runtime config may set `research.evidenceRequirements` to a map of market namespace to requirement lists. Generic HTTP users wanting background research must opt in explicitly, for example `{"pilot":[{"event":0,"freshness":"background"},{"event":1,"freshness":"background"}]}`. The default fails closed for unknown publisher times. Source `{event, url}` produces an association with that event only. A source-specific adapter may associate one document with several events when those associations are explicit.

Legacy unversioned records do not qualify. Do not migrate their `publishedAt` to `publisherReleasedAt` blindly: it may have represented an HTTP header. Refetch with a v2 retriever or regenerate controlled fixture records with explicit provenance. Protocol clients and adapters should upgrade together. Model output and final forecast schemas remain v1. Their flat `observedAt` preserves the citation's policy freshness: if it supports any requested release event, use publisher release time; only associations entirely with explicit background events use retrieval time. Citations with unknown required publication time or no association to a requested event remain in the raw research evidence and model citation IDs but are omitted from the flat forecast evidence list, so even a very large age window cannot count them as fresh. This conservative projection prevents stale supporting citations from inflating the strategy's minimum fresh-evidence count. Its note separates the selected basis, actual capture time, publisher release time, transport time and full capture hash. The complete v2 envelope remains available in the research result.

## Model output (`flurbo.agent-model-forecast.v1`)

The model returns one JSON object, either as the whole reply or as the whole reply inside one fenced block (```` ```json ```` or ```` ``` ````). Anything else is malformed.

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | `flurbo.agent-model-forecast.v1` |
| `abstain` | boolean | `true` ends validation with `model_abstained` |
| `abstainReason` | string or null | When abstaining: `insufficient_evidence`, `contradictory_evidence`, `stale_evidence`, `ambiguous_rules` or `other` |
| `events` | integers | The requested event indices, ascending |
| `statesPpm` | integers | One per local state (`2^events`), each 0 to 1,000,000, summing to 1,000,000 |
| `evidenceIds` | strings | Distinct ids of retrieved evidence |
| `assumptions` | strings | At most 8, each 3 to 300 characters |
| `uncertainty` | string | 3 to 600 characters |
| `explanation` | string | 10 to 1,200 characters |

No other fields are allowed. When `abstain` is true, only `schema`, `abstain`, `abstainReason` and optionally `explanation` are read.

## Validation order and outcomes

1. Not a single JSON object as above, unknown or missing fields, wrong types or lengths: `malformed_output`.
2. `abstain` is true: `model_abstained` (with the model's reason).
3. `events` differ from the requested events: `events_out_of_scope`.
4. Wrong number of states, a value out of range, or a sum other than 1,000,000: `invalid_distribution`.
5. No cited evidence: `no_evidence`. Any retriever id that is not a nonblank string of at most 64 UTF-16 code units: `invalid_evidence`. A cited id not retrieved: `unknown_evidence`.
6. Duplicate retriever ids, any cited invalid/legacy/incomplete/empty envelope, or malformed/duplicate caller requirements: `invalid_evidence`.
7. Any requested event has no associated cited record: `missing_event_evidence`.
8. Any requested event has no associated citation satisfying its own freshness requirement: `stale_evidence`.

The runtime also checks usable evidence coverage before spending a model call. Invalid captures are never offered as model citations. An empty retrieval batch is `no_sources`; an existing batch with no valid envelopes is `invalid_evidence`. Transport failure, overflow and empty extraction all yield no usable source in the current array-based retriever API, rather than fabricated evidence. Detailed per-source transport diagnostics are not part of this envelope.

Otherwise the output becomes a `flurbo.agent-forecast.v1` forecast with source `{kind: "provider", name: "{provider}/{model}"}` and evidence taken from the retrieval records, not from the model. Every failure is an abstention; the runtime never repairs model output.

Provider calls use a timeout, a bounded number of retries for transport errors only, and per-cycle and per-hour request budgets. A missing provider configuration is reported as `provider_not_configured`, never replaced by a fixed forecast. A fixture forecaster is always labelled as a fixture, never as AI.

Fixtures: `fixtures/research.json`. A case may provide `context` as a shallow override of the top-level context. These fixtures exercise validation; runtime tests must additionally exercise actual body reading, redirects and stream failures.
