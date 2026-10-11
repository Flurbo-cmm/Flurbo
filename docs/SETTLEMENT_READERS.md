# Settlement readers: types, workflow and rules

Snapshot: 10 October 2026. This is the reference for how a market question is read from its source: which reader types exist, what a rule for each may contain, the workflow from draft rule to settled question, and the rules that must not be broken when changing any of it. The code is the authority: `apps/web/server/settlement-rules.mjs`, `settlement-readers.mjs`, `settlement-evidence.mjs`, `settlement-pdf.mjs` and `source-proof.mjs`.

Related: [SETTLEMENT_ROUTING_V4.md](SETTLEMENT_ROUTING_V4.md) (routes, Kleros, what is not built), [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md) (listing a pool), [PROOF_READER_RUNBOOK.md](PROOF_READER_RUNBOOK.md) (credentialed sources).

## 1. How a reader fits in

A **rule** (`flurbo.settlement-rule.v1`) says which source to read, how to turn the response into one value, and how that value decides YES or NO. Its hash, `sha256(canonical(rule))`, is bound into the question's event hash, and the event hash is stored by the resolver contract. So the reader settings in a rule are committed on-chain before trading and cannot change afterwards. The contracts never parse rules, which is why a new reader never needs a contract change.

Every reader plugs into the same pipeline:

1. `retrieveSettlementCapture` fetches the source: bounded GET (or POST for `json-api.v2`), no redirects, at most 2,000,000 bytes, UTF-8 only. `evm-rpc.v1` and `pdf-text.v1` have their own retrievers. `proof-http.v1` is never fetched (see section 4.3).
2. `parseSettlementCapture` checks size and hash, then the reader turns the capture into a record with a value.
3. The capture store keeps it, content addressed, with its first and last fetch time (at most 50 distinct bodies per rule).
4. `evaluateSettlement` decides. For `first-observed-snapshot` the earliest capture inside `[scheduledAt, publicationCutoff]` wins; two different values at the same second conflict (`INITIAL_SOURCE_CONFLICT`).
5. `archiveSettlementProposal` re-verifies the packet and writes public evidence. Readers that derive data from the capture (PDF text) are re-checked asynchronously here first.
6. The hybrid worker proposes or answers with that evidence. No valid capture by `publicationCutoff` freezes VOID.

**The invariant that shapes everything:** a reader's read step is synchronous, offline and deterministic. `evaluateSettlement` and `verifySettlementPacket` are synchronous and anyone must be able to replay a packet later with no network and no secret. Any async work (network, PDF parsing, proving) happens at capture time, and anything derived is re-checked by an async verifier before evidence is archived.

## 2. Reader types

Twelve adapter names exist. The first eight are **frozen**: their validation, reading and request headers must never change, because deployed pools commit to them.

| Adapter | Use for | Status |
| --- | --- | --- |
| `json-api.v1` | A value, or a count, sum, max, min or single match over a filtered list, from a public JSON API | frozen |
| `stat-table.v1` | Official statistics: CSV rows, SDMX-JSON series, JSON-stat datasets | frozen |
| `html-text.v1` | Official web page: required anchors plus one pattern that matches exactly once | frozen |
| `evm-rpc.v1` | Any EVM chain: contract call, balance, nonce, block field at a time, or transaction and log counts between two times | frozen |
| `json-record.v1`, `bls-employment-html.v1`, `fomc-statement-html.v1`, `usgs-earthquake-count.v1` | Older single-source readers used by the first pools. Do not author new rules with them | frozen |
| `json-api.v2` | Everything `json-api.v1` does, plus POST bodies (GraphQL), derived values, time filters, `contains`, RFC 2822 dates | current |
| `proof-http.v1` | A source that needs an API key or a login, read through a Reclaim TLS proof made by an operator-run prover | current |
| `pdf-text.v1` | An official PDF-only document with a text layer | current |
| `xml-feed.v1` | RSS, Atom and XML feeds | current |

### Which reader for which question

| Question | Reader |
| --- | --- |
| A public value at a time, such as an FX rate or index level | `json-api.v1` or `json-api.v2` |
| An official statistic with a release vintage | `stat-table.v1` |
| An official announcement on a web page | `html-text.v1` |
| EVM chain state or activity | `evm-rpc.v1` |
| How many events happened in a window | `json-api.v2` count with time filters, or `xml-feed.v1` count |
| The margin or total of two values in one record | `json-api.v2` `derive`, or `proof-http.v1` `sum` or `difference` |
| A GraphQL or POST-only public API | `json-api.v2` with `request` |
| An RSS, Atom or XML feed | `xml-feed.v1` |
| An official PDF-only document | `pdf-text.v1` |
| An API that needs a key, or a page behind a login | `proof-http.v1` |
| A page that only renders with JavaScript | Use the page's own JSON request with `json-api.v2` (or `proof-http.v1` if it needs a credential). There is no headless browser reader |
| Anything subjective or interpretive | No reader. Reality.eth with a human answer |
| Bitcoin, Solana, medians across sources | Not implemented |

## 3. Anatomy of a rule

```json
{
  "schema": "flurbo.settlement-rule.v1",
  "eventId": "short-lowercase-id",
  "question": "The exact YES or NO question.",
  "source": { "id": "...", "publisher": "...", "urls": ["https://..."], "adapter": "json-api.v2", "reader": { } },
  "observation": { "series": "...", "period": "...", "unit": "..." },
  "decision": { "type": "number", "operator": "gte", "value": "4" },
  "timing": { "scheduledAt": 0, "publicationCutoff": 0, "correctionCutoff": 0, "observationEndsAt": 0,
              "assertionPeriod": 3600, "challengePeriod": 3600, "votingPeriod": 3600 },
  "vintage": "first-observed-snapshot",
  "missingPolicy": "resolver-timeout-void"
}
```

- **URLs** are exact `https` URLs with no credentials or fragment. General readers allow up to 32; `proof-http.v1` exactly one.
- **Decision** is `number` (`gt gte lt lte eq`, exact decimal text), `category` (`eq` on text), or `timestamp` (integer UTC seconds). Numbers are never floats: JSON numbers keep their exact text and arithmetic uses exact decimals.
- **Vintage** for general readers is `first-observed-snapshot` (the earliest capture inside the window decides) or `initial` (needs `publishedAt` from the source; a value published before `scheduledAt` never settles). `proof-http.v1` and `evm-rpc.v1` allow only `first-observed-snapshot`.
- **Timing:** `correctionCutoff` equals `publicationCutoff` for general readers, and `observationEndsAt` equals `correctionCutoff`. `assertionPeriod` is 1 hour to 30 days; `challengePeriod` and `votingPeriod` are 1 hour to 7 days. In a Reality-routed event, `challengePeriod` must equal the Reality `minTimeout`, `assertionPeriod` must equal the pool's, and `publicationCutoff` may not pass `observationEndsAt`.
- **Options several readers share:** `scale` (number decisions only, shifts the decimal point), `valueFormat` (required exactly when the decision is `timestamp`), `publishedAt` (a publication time read from the source, needed by the `initial` vintage), and `checks` (identity checks that must hold before a value counts; JSON, XML and proof readers).
- **Authoring policy** (`settlementRuleAuthoringIssues`, applied when preparing a market and by the rule check, never when an existing pool settles): a snapshot of an interval (period `start/end`) must open at least 3 hours after the interval ends, except `evm-rpc.v1`; a `proof-http.v1` window must be at least 6 hours.

## 4. The current readers in detail

### 4.1 `json-api.v2`

Reader keys (any subset; `select` and `aggregate` required): `request, select, aggregate, field, filter, checks, publishedAt, derive, scale, valueFormat`.

- `select` and `field` are JSON pointers. `aggregate` is `value`, `only`, `count`, `sum`, `max` or `min`. `only`, `sum`, `max`, `min` need `field`; `count`, `sum`, `max`, `min` need a number decision; `value` takes no filter.
- `filter`: 1 to 8 items `{ path, op, value, format? }`. `op` is `eq ne gt gte lt lte contains`. With `format` (`unix-seconds`, `unix-millis`, `iso-datetime`, `date`, `rfc-2822`) the field is parsed as a time and `value` is integer seconds. Without it, ordered ops compare exact decimals and `contains` is a plain substring test. An item missing the field does not match; a field that is present but not a valid time is `TIME_INVALID`.
- `request`: absent means GET. Present means exactly `{ "method": "POST", "body": "<json object text>" }`, at most 4,000 characters, and a GraphQL `query` may not start with `mutation`. The body is sent as `application/json`.
- `derive`: `{ op: "difference" | "sum", select, aggregate, field?, filter? }`, number decisions only. The two selections are combined exactly, then `scale` applies.
- `rfc-2822` parsing is strict (`Date.UTC`, never `Date.parse`) and an impossible calendar date is `TIME_INVALID`.

### 4.2 `xml-feed.v1`

Reader keys (`parser, select, aggregate` required): `parser, arrays, select, aggregate, field, filter, checks, publishedAt, scale, valueFormat`. Selection, filter, check and time rules are exactly those of `json-api.v2`, with no `request` and no `derive`.

- `parser` must be the exact string `fast-xml-parser@5.11.1`.
- `arrays` lists up to 8 dotted paths (for example `rss.channel.item`) that are always arrays, so a feed with one item reads the same as a feed with three.
- Attributes are read with an `@` prefix (`/feed/entry/0/link/@href`), element text next to attributes as `#text`. All values are strings; nothing is type guessed.
- Any `<!DOCTYPE` or `<!ENTITY` is refused (`XML_DOCTYPE_REFUSED`). Malformed XML is `EXTRACTION_INVALID_XML`. The content type must be an XML type.

### 4.3 `proof-http.v1`

Reader keys (all but `scale` and `valueFormat` required): `proof` (`reclaim-http.v1`), `attestors` (1 to 4 lowercase addresses), `minSignatures`, `credential` (`{ kind: "header", name, label }` or `{ kind: "cookie", label }`), `request` (`{ method, headers?, body? }` with no secret header), `responseRedactions` (1 to 8 `{ jsonPath }` or `{ regex }`), `responseMatches` (1 to 8 `{ type: "regex", value }` with named groups, no lookaround or backreferences), `checks` (1 to 8 `{ param, equals }` on named groups), `value` (`{ param }`, or `{ sum: [a, b] }` or `{ difference: [a, b] }` for number decisions).

How it works:

1. The rule commits the exact request, which fields are revealed, the attestors it trusts, and the checks that must hold (identity, and a terminal state such as `status == FINISHED`).
2. An operator-run **prover** (`integrations/source-proofs/prove.mjs`) holds the Reclaim credentials and the source credential on the owner's machine. It makes the proof inside the capture window, checks it locally with the server's own reader, and uploads it to `POST /api/settlement/proof-captures` with a bearer token.
3. The server verifies again, offline: it recomputes the claim identifier, recovers the signers synchronously, requires at least `minSignatures` of the pinned attestors, requires the proven request to equal the committed request, requires the signed context to name this rule's hash, and reads values only from the signed extracted parameters. The unsigned `extractedParameterValues` is never trusted or stored.
4. The settlement worker **never fetches** a credentialed source. While no proof is stored it records `PROOF_CAPTURE_PENDING`. No valid proof inside the window means VOID under the published rule.
5. Anyone can re-verify the evidence with `verify-settlement-evidence.mjs`, with no credential.

Trust model, to use verbatim in docs and the UI: a TLS proof shows that a named HTTPS server returned the revealed fields to the prover at the signed time, as attested by the pinned Reclaim attestors. It relies on those attestors being honest and not colluding with the prover. It does not prove the source's data is correct, and it does not let anyone else fetch the source. Only the revealed fields are public.

State: implemented and tested with signed synthetic proofs and a conformance test against the Reclaim SDK. A genuine proof from a live attestor has not been recorded, so the live claim layout is unconfirmed. Do not list a proof pool before the discovery and fixture steps in the runbook.

### 4.4 `pdf-text.v1`

Reader keys (`parser, pages, anchors, pattern` required): `parser, pages, anchors, pattern, grouping, publishedAt, scale, valueFormat`.

- `parser` must be the exact string `pdfjs-dist@6.3.289`. `pages` is `{ first, last }` with `1 <= first <= last <= first + 49`.
- `anchors`, `pattern`, `grouping` and `publishedAt` follow `html-text.v1`: every anchor must appear in the page text, and the pattern (one capture group) must match exactly once.
- The capture is JSON holding the raw PDF (base64, at most 1,400,000 bytes), its SHA-256, and the extracted text of each page. The synchronous read checks the hash and searches the text as given. Before evidence is archived, `settlement-pdf.mjs` extracts the text again from the raw bytes with the pinned parser and requires it to be identical (`PDF_TEXT_MISMATCH` otherwise). The replay tool does the same.
- Text layer only. There is no OCR, so a scanned document has no text and fails the anchor check (`OBSERVATION_IDENTITY_MISMATCH`).

## 5. Workflow

1. **Write tests first** for a new rule shape or reader (see section 7).
2. **Author the rule.** For football-data.org matches use `apps/web/scripts/create-football-proof-rules.mjs`. Never hand-edit `config/hybrid-markets.json` or `config/oracle-markets.json`; only the registration scripts write them.
3. **Check it against the live source** before preparing a market:

   ```bash
   node apps/web/scripts/check-settlement-rule.mjs <rule-or-rules.json> --closes-at <unix seconds>
   ```

   It reports validity, the rule hash, what each source returns now, and whether the market would still be a prediction (`ok`, `already-public`, `source-error`). A credentialed rule reports `proof-required`, or pass sample proofs with `--proof <capture.json>`.
4. **Build the pool.** Reality-routed pools can carry custom rules: `create-hybrid-reality-pilot.mjs` takes a rules file as its ninth argument, then `complete-hybrid-reality-draft.mjs`, `prepare-hybrid-pilot.mjs`, deploy and register as in the hybrid runbook. A deployed pool cannot be changed.
5. **Capture.** The hybrid worker checks every two minutes. Inside `[scheduledAt, publicationCutoff]` it fetches each public source once per cycle; a snapshot rule stops after the first valid capture is retained. For `proof-http.v1` the prover uploads instead.
6. **Settle.** After `observationEndsAt` the worker evaluates the retained captures, archives public evidence, and posts the bonded answer. Challenges go to Kleros as for any Reality-routed answer.
7. **Verify.** `node apps/web/scripts/verify-settlement-evidence.mjs <evidence URL or file> --rule-hash <hash>` replays the evaluation from the retained captures. Any packet change fails with `PACKET_BINDING_FAILED` or `PACKET_REPLAY_FAILED`.

## 6. Rules that must not be broken

1. **Frozen readers.** The eight earlier adapters keep their validation, reading and `Accept` headers forever. New behavior is a new adapter name appended to `GENERAL_ADAPTERS`; order never changes. `apps/web/tests/settlement-compat.test.ts` pins the hashes of every deployed rule and the adapter order. If it fails, you changed a frozen reader: revert.
2. **Synchronous, offline reads.** No network, clock or randomness in a read step. Derived data needs an async verifier that runs before evidence is archived.
3. **Pinned parsers.** `pdfjs-dist` and `fast-xml-parser` are exact versions in `package.json`, and the rule commits the version string. The reader refuses if the installed version differs. Never upgrade either while a rule using it is live; a new version means a new parser string and new rules.
4. **CRE safety.** The CRE workflow imports `settlement-rules.mjs` and so `settlement-readers.mjs`. The readers may import only `settlement-rules.mjs` and `source-proof.mjs` (which uses `viem` and `@noble/curves`, pure JavaScript). No Node-only static imports there: the XML parser is loaded lazily through `process.getBuiltinModule`, and `pdfjs-dist` is imported only from `settlement-pdf.mjs`, which only `settlement-evidence.mjs` imports. After touching imports run `bun test` and `bun run typecheck` in `workflows/cre` (64 tests pass as of this snapshot).
5. **Credentials stay off the server.** Source credentials, Reclaim application secrets, cookies and tokens never go in the repo, a rule, a fixture, a log line, the web image or Render. A rule holds only a credential label. The only proof-related Render variable is `FLURBO_PROOF_SUBMIT_TOKEN`.
6. **Exact values.** Decimals are exact text. Duplicate JSON keys are refused. Content types are checked. Responses are capped (2,000,000 bytes per capture, 1,400,000 per PDF, 300,000 per proof upload).
7. **Proof rules** use `first-observed-snapshot`, exactly one URL, at least one terminal-state check, and a window of at least six hours. The proof's signed time must equal the capture time and fall inside the window.
8. **Nothing guesses.** A value that is not there yet is an issue, so the capture is not retained and the bot keeps checking until the cutoff. Missing at the cutoff is VOID, as the rule says.
9. **Tests first.** Write the tests for each planned feature before implementing it.
10. **Never change a deployed pool, rule or catalog entry.** Resolvers are immutable. If a rule is wrong, list a new pool.

## 7. Adding a new reader

1. Tests first: rule validation (good and bad settings), reading, retrieval request shape, replay, and that the frozen readers still pass `settlement-compat.test.ts`.
2. Append the adapter name to `GENERAL_ADAPTERS` in `settlement-rules.mjs`.
3. In `settlement-readers.mjs`: a `checkX(rule)` called from `validateReaderConfig`, the read function, a branch in `readGeneralRecord`, and `readerAccept` if it needs its own `Accept` header. Add a branch in `retrieveSettlementCapture` only if it needs its own transport (as `evm-rpc.v1` and `pdf-text.v1` do), and an async verifier called from `verifyDerivedCaptures` if it derives data.
4. Add its member-facing name to `apps/web/src/reader-names.ts` (`reader-names.test.ts` fails if any adapter lacks one).
5. Update this file, the reader table in [SETTLEMENT_ROUTING_V4.md](SETTLEMENT_ROUTING_V4.md) and the source coverage paragraph in [HYBRID_TESTNET_RUNBOOK.md](HYBRID_TESTNET_RUNBOOK.md).
6. Run the checks below.

## 8. Issue codes

Readers fail with `Object.assign(Error(reason), { reason })`; the code must match `/^[A-Z0-9_]{1,96}$/` because the capture store records it.

| Group | Codes |
| --- | --- |
| Keep trying (the value is not there yet) | `VALUE_MISSING`, `EXTRACTION_MISSING_FIELD`, `EVM_BLOCK_NOT_YET_AVAILABLE`, `EVM_NOT_FINAL` |
| Transport | `SOURCE_FETCH_FAILED`, `SOURCE_PARTIAL_RESPONSE`, `SOURCE_TOO_LARGE`, `SOURCE_EMPTY`, `SOURCE_LENGTH_INVALID`, `SOURCE_LENGTH_MISMATCH`, `SOURCE_ENCODING_INVALID`, `SOURCE_URL_MISMATCH`, `CONTENT_TYPE_MISMATCH` |
| Extraction | `EXTRACTION_INVALID_JSON`, `EXTRACTION_DUPLICATE_FIELD`, `EXTRACTION_NOT_A_LIST`, `EXTRACTION_NOT_A_VALUE`, `EXTRACTION_AMBIGUOUS_OR_MISSING`, `OBSERVATION_IDENTITY_MISMATCH`, `VALUE_INVALID`, `TIME_INVALID` |
| XML | `EXTRACTION_INVALID_XML`, `XML_DOCTYPE_REFUSED`, `XML_PARSER_VERSION_MISMATCH` |
| PDF | `PDF_INVALID`, `PDF_PAGE_MISSING`, `PDF_CAPTURE_INVALID`, `PDF_TEXT_MISMATCH`, `PDF_PARSER_VERSION_MISMATCH` |
| Proof | `PROOF_CAPTURE_REQUIRED`, `PROOF_CAPTURE_PENDING`, `PROOF_CAPTURE_INVALID`, `PROOF_CLAIM_INVALID`, `PROOF_IDENTIFIER_MISMATCH`, `PROOF_SIGNATURE_INVALID`, `PROOF_CONTEXT_INVALID`, `PROOF_CONTEXT_MISMATCH`, `PROOF_REQUEST_MISMATCH`, `PROOF_PARAMETER_INVALID`, `PROOF_TIME_MISMATCH`, `PROOF_OUTSIDE_WINDOW` |
| Evaluation and replay | `CAPTURE_TIME_INVALID`, `CAPTURE_INTEGRITY_FAILED`, `INITIAL_SOURCE_CONFLICT`, `SNAPSHOT_NOT_RETAINED_IN_WINDOW`, `RELEASED_BEFORE_OBSERVATION_WINDOW`, `PACKET_BINDING_FAILED`, `PACKET_REPLAY_FAILED` |

## 9. Where things live

| Path | Role |
| --- | --- |
| `apps/web/server/settlement-rules.mjs` | Rule validation, rule hash, adapter list, authoring policy |
| `apps/web/server/settlement-readers.mjs` | Every general reader: validation, reading, `proofHttp`, `inspectProofCapture` |
| `apps/web/server/settlement-evidence.mjs` | Retrieval, capture parsing, evaluation, packet verification, archiving |
| `apps/web/server/settlement-pdf.mjs` | PDF retrieval, text extraction, async verification |
| `apps/web/server/source-proof.mjs` | Offline Reclaim claim verifier |
| `apps/web/server/proof-captures.mjs` | Authenticated proof upload service, mounted at `/api/settlement/proof-captures` |
| `apps/web/server/hybrid-settlement-worker.mjs` | Capture loop (`hybridCaptureStep`), answers, proposals |
| `apps/web/scripts/check-settlement-rule.mjs` | Rule check against the live source |
| `apps/web/scripts/verify-settlement-evidence.mjs` | Replay tool for challengers and jurors |
| `apps/web/scripts/create-football-proof-rules.mjs` | football-data.org rule writer |
| `integrations/source-proofs` | Prover and its tests (`prove.mjs`, `capture.mjs`) |
| `apps/web/src/reader-names.ts` | Member-facing reader names |
| `apps/web/tests/settlement-compat.test.ts` | Frozen-reader guard |

## 10. Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `FLURBO_PROOF_SUBMIT_TOKEN` | Render and the prover machine | Bearer token for the upload endpoint. The endpoint is off without it, or when no listed rule uses `proof-http.v1`. `/healthz` shows `proof_captures` |
| `FLURBO_RECLAIM_APP_ID`, `FLURBO_RECLAIM_APP_SECRET` | prover machine only | Reclaim application credentials |
| `FLURBO_PROOF_CREDENTIAL_<LABEL>` | prover machine only | The source credential for the rule whose credential label is `<label>` |

## 11. Checks to run after any reader change

```bash
cd apps/web && npm run typecheck && npm test
```

```bash
cd apps/web && npm run build
```

```bash
cd integrations/source-proofs && npm test
```

```bash
cd workflows/cre && bun test && bun run typecheck
```

As of this snapshot: web 729 tests (667 pass, 62 skipped, 0 fail), source-proofs 16 pass, CRE 64 pass. The skipped web tests need Playwright or `dist`, and the genuine Reclaim proof test needs its fixture.

## 12. Not implemented

Bitcoin and Solana readers (they need header-chain or slot-finality verification), a reader for pages that only render with JavaScript and have no data request, multi-source medians, OCR for scanned PDFs, and private-source proofs that settle without an operator-run prover. Subjective questions use Reality.eth with a human answer.
