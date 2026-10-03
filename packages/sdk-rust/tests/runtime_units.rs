//! Runtime pieces that need no chain: retrieval allowlist, model providers, request budgets, the headless
//! client, the journal lock across separate processes, the signer and the command line.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flurbo_sdk::research::{Evidence, EvidenceRequirement, Prompt, PromptEvent, EVIDENCE_SCHEMA, MODEL_SCHEMA};
use flurbo_sdk::runtime::cli::main_with;
use flurbo_sdk::runtime::config::{default_config, parse_config};
use flurbo_sdk::runtime::headless::{is_stop, RuntimeClient};
use flurbo_sdk::runtime::journal::{owner, FileJournal, JournalEntry, ReportState};
use flurbo_sdk::runtime::research::{extract_text, AnthropicMessages, FixtureForecaster, FixtureRetriever, Forecaster, HttpRetriever, OpenAiCompatible, Research, Researcher, Retriever, Source};
use flurbo_sdk::signer::{LocalKeySigner, Signer};
use serde_json::{json, Value};

const TOKEN: &str = "fla1_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[derive(Debug, Clone)]
struct Call {
    path: String,
    headers: HashMap<String, String>,
}

type Respond = dyn Fn(&str, usize) -> (u16, Vec<(String, String)>, String) + Send + Sync;

/// A local HTTP/1.1 server whose handler is a function (path, call number) -> (status, headers, body).
struct Server {
    url: String,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl Server {
    fn start(respond: Box<Respond>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let respond: Arc<Respond> = Arc::from(respond);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let mut headers = HashMap::new();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.trim().split_once(':') {
                        headers.insert(k.trim().to_lowercase(), v.trim().to_string());
                    }
                }
                let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let n = {
                    let mut c = seen.lock().unwrap();
                    c.push(Call { path: path.clone(), headers });
                    c.len()
                };
                let (status, extra, payload) = respond(&path, n);
                let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", status, payload.len());
                for (k, v) in extra {
                    out.push_str(&format!("{}: {}\r\n", k, v));
                }
                out.push_str("\r\n");
                out.push_str(&payload);
                let _ = stream.write_all(out.as_bytes());
            }
        });
        Server { url, calls }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn prompt() -> Prompt {
    Prompt { system: "s".into(), user: "u".into() }
}

#[test]
fn retrieval_allowlist_redirects_and_text() {
    let server = Server::start(Box::new(|path, _| {
        if path == "/redirect" {
            return (302, h(&[("Location", "https://evil.example/page")]), String::new());
        }
        (
            200,
            h(&[("Content-Type", "text/html"), ("Last-Modified", "Sat, 26 Sep 2026 10:00:00 GMT")]),
            "<html><title>Release 1.0</title><script>steal()</script><p>Tagged &amp; released</p></html>".into(),
        )
    }));
    let local = HttpRetriever::new(&[], true);
    let got = local.retrieve(&[Source { event: 0, url: format!("{}/a", server.url) }, Source { event: 0, url: format!("{}/redirect", server.url) }], 1_790_000_000);
    assert_eq!(got.len(), 1, "a redirect to another host is never followed");
    assert_eq!((got[0].id.as_str(), got[0].title.as_deref(), got[0].excerpt.as_str()), ("src-1", Some("Release 1.0"), "Release 1.0 Tagged & released"));
    assert_eq!(got[0].publisher_released_at, None, "HTTP modification metadata is not a publication date");
    assert_eq!(got[0].http_last_modified, Some(1_790_416_800));
    assert_eq!(got[0].event_ids, vec![0]);
    assert!(got[0].complete_document && got[0].captured_bytes > 0);
    assert!(HttpRetriever::new(&[], false).retrieve(&[Source { event: 0, url: format!("{}/a", server.url) }], 0).is_empty(), "plain HTTP only when allowed");
    assert!(HttpRetriever::new(&["allowed.example".into()], false).retrieve(&[Source { event: 0, url: "https://other.example/x".into() }], 0).is_empty());
    assert!(!server.calls().iter().any(|c| c.path.contains("evil")));
    assert_eq!(extract_text("<style>x{}</style><b>a</b>  b", "text/html"), "a b");
    assert_eq!(extract_text("İ <SCRIPT>ignore</SCRIPT><b>official value</b>", "text/html"), "İ official value");
}

#[test]
fn retrieval_requires_complete_nonempty_body_and_preserves_provenance() {
    let body = "Official value: 4.2. ".repeat(300);
    let expected_body = body.clone();
    let server = Server::start(Box::new(move |path, _| match path {
        "/redirect" => (302, h(&[("Location", "/full")]), String::new()),
        "/empty" => (200, h(&[("Content-Type", "text/plain")]), String::new()),
        "/blank" => (200, h(&[("Content-Type", "text/html")]), "<script>no evidence</script>".into()),
        "/partial" => (206, h(&[("Content-Type", "text/plain")]), "partial source".into()),
        "/range" => (200, h(&[("Content-Type", "text/plain"), ("Content-Range", "bytes 0-13/100")]), "partial source".into()),
        _ => (200, h(&[("Content-Type", "text/plain"), ("Last-Modified", "Sat, 26 Sep 2026 10:00:00 GMT")]), body.clone()),
    }));
    let source = |path: &str| Source { event: 1, url: format!("{}{}", server.url, path) };
    let retriever = HttpRetriever::new(&[], true);
    for path in ["/empty", "/blank", "/partial", "/range"] {
        assert!(retriever.retrieve(&[source(path)], 1_790_500_000).is_empty(), "{path}");
    }
    assert!(HttpRetriever::new(&[], true).with_max_bytes(64).retrieve(&[source("/full")], 1_790_500_000).is_empty(), "oversized first response chunk cannot produce a fresh empty or truncated record");
    let got = HttpRetriever::new(&[], true).with_max_bytes(expected_body.len()).retrieve(&[source("/redirect")], 1_790_500_000);
    assert_eq!(got.len(), 1, "a complete body exactly at the limit is accepted");
    let record = &got[0];
    assert_eq!(record.schema, EVIDENCE_SCHEMA);
    assert_eq!(record.requested_url, source("/redirect").url);
    assert_eq!(record.final_url, source("/full").url);
    assert_eq!(record.url, record.final_url);
    assert_eq!(record.publisher_released_at, None);
    assert_eq!(record.event_ids, vec![1]);
    assert_eq!(record.captured_bytes, expected_body.len() as u64);
    assert_eq!(record.excerpt.len(), 4000);
    use sha3::Digest;
    let full_hash: String = k256::sha2::Sha256::digest(expected_body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(record.content_sha256, full_hash, "hash binds the full source, not the display excerpt");
}

#[test]
fn retrieval_rejects_interrupted_and_late_overflow_streams() {
    fn retrieve_raw(chunks: Vec<Vec<u8>>, max_bytes: usize) -> Vec<Evidence> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/source", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            for chunk in chunks {
                if stream.write_all(&chunk).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let got = HttpRetriever::new(&[], true).with_max_bytes(max_bytes).retrieve(&[Source { event: 0, url }], 1_790_500_000);
        handle.join().unwrap();
        got
    }
    let broken = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial".to_vec();
    assert!(retrieve_raw(vec![broken], 200).is_empty(), "EOF before declared body length is a source failure");
    let header = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
    assert!(retrieve_raw(vec![header.clone(), b"4\r\ntext\r\n".to_vec()], 200).is_empty(), "missing chunk terminator is a source failure");
    assert!(retrieve_raw(vec![header, b"4\r\ntext\r\n".to_vec(), b"4\r\nmore\r\n0\r\n\r\n".to_vec()], 6).is_empty(), "overflow in later chunks also fails closed");
}

#[test]
fn providers_configuration_retries_limits_and_wire_formats() {
    assert_eq!(OpenAiCompatible::new("https://api.example/v1", "m", None, Duration::from_secs(5), 2).unwrap_err().code, "provider_not_configured");
    assert_eq!(AnthropicMessages::new("m", None, Duration::from_secs(5), 2).unwrap_err().code, "provider_not_configured");
    assert!(OpenAiCompatible::new("http://api.example/v1", "m", Some("k".into()), Duration::from_secs(5), 2).is_err());

    let server = Server::start(Box::new(|_, n| {
        if n < 3 {
            (503, h(&[("Retry-After", "0")]), "{}".into())
        } else {
            (200, h(&[("Content-Type", "application/json")]), json!({"choices": [{"message": {"content": "{\"x\":1}"}}]}).to_string())
        }
    }));
    let p = OpenAiCompatible::new(&format!("{}/v1", server.url), "m", Some("sk-secret".into()), Duration::from_secs(5), 2).unwrap();
    assert_eq!(p.complete(&prompt()).unwrap(), "{\"x\":1}");
    let calls = server.calls();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|c| !c.path.contains("sk-secret") && c.headers.get("authorization").map(String::as_str) == Some("Bearer sk-secret")));
    assert!(calls.iter().all(|c| c.path == "/v1/chat/completions"));
    assert!(!format!("{:?}", p).contains("sk-secret"));

    let limited = Server::start(Box::new(|_, _| (429, h(&[("Retry-After", "0")]), json!({"error": {"message": "key sk-secret over quota"}}).to_string())));
    let e = OpenAiCompatible::new(&format!("{}/v1", limited.url), "m", Some("sk-secret".into()), Duration::from_secs(5), 1).unwrap().complete(&prompt()).unwrap_err();
    assert_eq!(e.code, "rate_limited");
    assert!(!e.message.contains("sk-secret"));
    assert_eq!(limited.calls().len(), 2);

    let anthropic = Server::start(Box::new(|_, _| (200, h(&[("Content-Type", "application/json")]), json!({"content": [{"type": "text", "text": "hello"}]}).to_string())));
    let a = AnthropicMessages::new("m", Some("k2".into()), Duration::from_secs(5), 2).unwrap().with_base_url(&anthropic.url);
    assert_eq!(a.complete(&prompt()).unwrap(), "hello");
    let c = &anthropic.calls()[0];
    assert_eq!((c.path.as_str(), c.headers.get("x-api-key").map(String::as_str)), ("/v1/messages", Some("k2")));
}

fn evidence() -> Vec<Evidence> {
    vec![Evidence {
        schema: EVIDENCE_SCHEMA.into(),
        id: "src-1".into(),
        url: "https://example.org/x".into(),
        requested_url: "https://example.org/x".into(),
        final_url: "https://example.org/x".into(),
        title: Some("x source".into()),
        publisher: Some("example.org".into()),
        retrieved_at: 0,
        publisher_released_at: Some(1_790_000_000),
        http_last_modified: None,
        content_sha256: "0".repeat(64),
        excerpt: "t".into(),
        complete_document: true,
        captured_bytes: 1,
        event_ids: vec![0, 1],
    }]
}

#[test]
fn research_budgets() {
    let good = json!({"schema": MODEL_SCHEMA, "abstain": false, "abstainReason": null, "events": [0, 1], "statesPpm": [250000, 250000, 250000, 250000], "evidenceIds": ["src-1"],
        "assumptions": [], "uncertainty": "Unknown.", "explanation": "Evenly uncertain about both."})
    .to_string();
    let calls = Arc::new(Mutex::new(0));
    let counter = calls.clone();
    let forecaster = FixtureForecaster {
        name: "fixture".into(),
        reply: Box::new(move |_| {
            *counter.lock().unwrap() += 1;
            Ok(good.clone())
        }),
    };
    let r = Researcher::new(Box::new(FixtureRetriever { records: evidence() }), Ok(Box::new(forecaster)), 86_400, 1, 2);
    let events: Vec<PromptEvent> = (0..2).map(|i| PromptEvent { index: i, question: "q".into(), yes_rule: "y".into(), no_rule: "n".into(), observation_ends_at: 1_800_000_000 }).collect();
    let run = || r.research(&format!("0x{}", "11".repeat(20)), "t", &events, &[], 1_790_000_000);
    let reason = |x: Research| match x {
        Research::Abstain { reason, .. } => reason,
        Research::Ok { .. } => "ok".into(),
    };
    match run() {
        Research::Ok { forecast, provenance, .. } => {
            assert_eq!(forecast["source"], json!({"kind": "fixture", "name": "fixture"}));
            assert_eq!(provenance.kind, "fixture", "a fixture is never labelled as a model");
        }
        other => panic!("{:?}", other),
    }
    assert_eq!((reason(run()), *calls.lock().unwrap()), ("request_budget_exhausted".to_string(), 1));
    r.reset_cycle();
    run();
    r.reset_cycle();
    assert_eq!((reason(run()), *calls.lock().unwrap()), ("request_budget_exhausted".to_string(), 2), "the hourly budget holds across cycles");
    let none = Researcher::new(Box::new(FixtureRetriever { records: vec![] }), Err(flurbo_sdk::FlurboError::new("provider_not_configured", "No provider.")), 1, 1, 1);
    assert_eq!(reason(none.research("0x", "t", &events, &[], 0)), "provider_not_configured");
}

#[test]
fn research_preflight_requires_each_event_and_explicit_background_policy() {
    let calls = Arc::new(Mutex::new(0));
    let counter = calls.clone();
    let forecaster = FixtureForecaster {
        name: "fixture".into(),
        reply: Box::new(move |p| {
            *counter.lock().unwrap() += 1;
            assert!(p.user.contains("evidence requirement: background"));
            Ok(json!({"schema": MODEL_SCHEMA, "abstain": false, "abstainReason": null, "events": [0, 1], "statesPpm": [250000, 250000, 250000, 250000], "evidenceIds": ["src-1"],
            "assumptions": [], "uncertainty": "Unknown.", "explanation": "Evenly uncertain about both."})
            .to_string())
        }),
    };
    let mut records = evidence();
    records[0].publisher_released_at = None;
    records[0].http_last_modified = Some(1_790_000_000);
    let events: Vec<PromptEvent> = (0..2).map(|index| PromptEvent { index, question: "q".into(), yes_rule: "y".into(), no_rule: "n".into(), observation_ends_at: 1_800_000_000 }).collect();
    let r = Researcher::new(Box::new(FixtureRetriever { records }), Ok(Box::new(forecaster)), 86_400, 1, 1);
    let reason = |x: Research| match x {
        Research::Abstain { reason, .. } => reason,
        Research::Ok { .. } => "ok".into(),
    };
    assert_eq!(reason(r.research("0x", "t", &events, &[], 1_790_000_000)), "stale_evidence", "fresh retrieval and Last-Modified cannot substitute for a release date");
    let one = [EvidenceRequirement { event: 0, freshness: "background".into() }];
    assert_eq!(reason(r.research_with_requirements("0x", "t", &events, &[], 1_790_000_000, 2, &one)), "stale_evidence", "event 1 still defaults to release freshness");
    assert_eq!(*calls.lock().unwrap(), 0, "unusable sources never reach a model or consume its budget");
    let both: Vec<EvidenceRequirement> = (0..2).map(|event| EvidenceRequirement { event, freshness: "background".into() }).collect();
    assert_eq!(reason(r.research_with_requirements("0x", "t", &events, &[], 1_790_000_000, 2, &both)), "ok");
    assert_eq!(*calls.lock().unwrap(), 1);
    let mut config = default_config();
    config["research"]["evidenceRequirements"] = json!({"pilot": both});
    assert_eq!(parse_config(&config).unwrap().research.evidence_requirements["pilot"].len(), 2);
    for invalid in [
        json!({"pilot": [{"event": 0, "freshness": "lastModified"}]}),
        json!({"other": [{"event": 0, "freshness": "background"}]}),
        json!({"pilot": [{"event": 0, "freshness": "background"}, {"event": 0, "freshness": "release"}]}),
    ] {
        config["research"]["evidenceRequirements"] = invalid;
        assert!(parse_config(&config).is_err());
    }
}

#[test]
fn forecast_projection_and_strategy_count_never_refresh_old_or_unrelated_citations() {
    use flurbo_sdk::research::{forecast_from_model_with_requirements, ModelOutput, Provenance};
    let now = 1_790_000_000;
    let mut records = evidence();
    records[0].retrieved_at = now;
    records[0].publisher_released_at = Some(now - 100_000);
    let mut fresh = records[0].clone();
    fresh.id = "fresh".into();
    fresh.publisher_released_at = Some(now - 100);
    records.push(fresh);
    let mut unrelated = records[1].clone();
    unrelated.id = "unrelated".into();
    unrelated.event_ids = vec![2];
    records.push(unrelated);
    let output = ModelOutput {
        events: vec![0, 1],
        states_ppm: vec![250_000; 4],
        evidence_ids: vec!["src-1".into(), "fresh".into(), "unrelated".into()],
        assumptions: vec![],
        uncertainty: "Unknown.".into(),
        explanation: "Evenly uncertain about both.".into(),
    };
    let provider = Provenance { kind: "fixture".into(), name: "fixture".into() };
    let default = forecast_from_model_with_requirements(&output, "0x", &records, &provider, now, &[]);
    assert_eq!(default["evidence"][0]["observedAt"], flurbo_sdk::time::iso(now - 100_000));
    assert_eq!(default["evidence"].as_array().unwrap().len(), 2, "an unrelated citation is omitted from the v1 projection");
    let both: Vec<EvidenceRequirement> = (0..2).map(|event| EvidenceRequirement { event, freshness: "background".into() }).collect();
    let background = forecast_from_model_with_requirements(&output, "0x", &records, &provider, now, &both);
    assert_eq!(background["evidence"][0]["observedAt"], flurbo_sdk::time::iso(now));
    let mixed = forecast_from_model_with_requirements(&output, "0x", &records, &provider, now, &both[..1]);
    assert_eq!(mixed["evidence"][0]["observedAt"], flurbo_sdk::time::iso(now - 100_000));
    records[0].publisher_released_at = None;
    let missing = forecast_from_model_with_requirements(&output, "0x", &records, &provider, now, &both[..1]);
    assert_eq!(missing["evidence"].as_array().unwrap().len(), 1, "missing publication and unrelated records are omitted, never mapped to an invented timestamp");
    assert_eq!(missing["evidence"][0]["id"], "fresh");
    let reply = json!({"schema": MODEL_SCHEMA, "abstain": false, "abstainReason": null, "events": [0, 1], "statesPpm": [250000, 250000, 250000, 250000], "evidenceIds": output.evidence_ids,
        "assumptions": [], "uncertainty": "Unknown.", "explanation": "Evenly uncertain about both."})
    .to_string();
    let r = Researcher::new(Box::new(FixtureRetriever { records }), Ok(Box::new(FixtureForecaster::fixed(&reply, "fixture"))), 86_400, 5, 5);
    let events: Vec<PromptEvent> = (0..2).map(|index| PromptEvent { index, question: "q".into(), yes_rule: "y".into(), no_rule: "n".into(), observation_ends_at: 1_800_000_000 }).collect();
    match r.research_with_requirements("0x", "t", &events, &[], now, 3, &both[..1]) {
        Research::Ok { fresh_evidence, .. } => assert_eq!(fresh_evidence, 1, "one fresh relevant release; the mixed undated and unrelated records cannot inflate minEvidence"),
        other => panic!("{:?}", other),
    }
}

#[test]
fn headless_credential_only_in_header() {
    assert!(RuntimeClient::new("https://x.example", "not-a-token").is_err());
    assert!(RuntimeClient::new("http://x.example", TOKEN).is_err());
    let server = Server::start(Box::new(|_, n| {
        if n == 1 {
            (200, h(&[("Content-Type", "application/json")]), json!({"version": 1}).to_string())
        } else {
            (401, h(&[("Content-Type", "application/json")]), json!({"code": "CREDENTIAL_REVOKED", "error": "This agent credential was revoked.", "retryable": false}).to_string())
        }
    }));
    let client = RuntimeClient::new(&server.url, TOKEN).unwrap();
    client.policy().unwrap();
    let e = client.session().unwrap_err();
    assert!(is_stop(&e) && e.api_code.as_deref() == Some("CREDENTIAL_REVOKED") && !e.message.contains(TOKEN));
    for c in server.calls() {
        assert!(!c.path.contains(TOKEN));
        assert!(c.path.starts_with("/api/agent-runtime/v1/"));
        assert_eq!((c.headers.get("authorization").cloned(), c.headers.get("flurbo-agent-protocol").cloned()), (Some(format!("Bearer {}", TOKEN)), Some("1".into())));
        assert!(!c.headers.contains_key("sec-fetch-site"));
    }
    assert!(!format!("{:?}", client).contains(TOKEN));
    let offline = RuntimeClient::new("http://127.0.0.1:9", TOKEN).unwrap();
    assert_eq!(offline.session().unwrap_err().api_code.as_deref(), Some("NETWORK"));
}

fn entry(id: String, seq: usize) -> JournalEntry {
    let mut extra = serde_json::Map::new();
    extra.insert("seq".into(), json!(seq));
    JournalEntry {
        id,
        action: "approve".into(),
        namespace: "pilot".into(),
        pool: format!("0x{}", "11".repeat(20)),
        claim: None,
        quantity_atoms: "0".into(),
        limit_atoms: "1".into(),
        deadline: None,
        status: "abandoned".into(),
        planned_at: 0,
        decision_id: None,
        to: String::new(),
        data: "0x".into(),
        gas: None,
        max_fee_per_gas: None,
        max_priority_fee_per_gas: None,
        nonce: None,
        raw_transaction: None,
        hash: None,
        signed_at: None,
        broadcast_at: None,
        final_at: None,
        cost_atoms: None,
        receipt: None,
        note: None,
        owner: owner(),
        report: ReportState { status: "none".into(), attempts: 0, flurbo_status: None },
        extra,
    }
}

const WALLET: &str = "0x2222222222222222222222222222222222222222";

#[test]
fn semantic_collision_blocks_custom_execute_and_sign() {
    use flurbo_sdk::claims::ClaimRef;
    use flurbo_sdk::runtime::chain::{Block, ChainReader};
    use flurbo_sdk::runtime::executor::{ExecutionRequest, Executor, FixedControls};
    use flurbo_sdk::runtime::rpc::JsonRpc;
    use flurbo_sdk::transaction::Claim;
    let f: Value = serde_json::from_str(include_str!("../../../protocol/fixtures/semantics.json")).unwrap();
    let d = serde_json::from_value::<flurbo_sdk::protocol::Deployment>(f["deployment"].clone()).unwrap();
    let mut result = f["cases"][0]["result"].clone();
    let now = flurbo_sdk::time::now_seconds();
    result["checkedAt"] = json!(now);
    result["expiresAt"] = json!(now + 60);
    let server = Server::start(Box::new(move |_, _| (200, h(&[("Content-Type", "application/json")]), result.to_string())));
    let signer = Arc::new(LocalKeySigner::new(&format!("0x{}", "01".repeat(32))).unwrap());
    let dir = std::env::temp_dir().join(format!("flurbo-semantic-sign-{}", std::process::id()));
    let journal = Arc::new(FileJournal::new(&dir, &signer.address()).unwrap());
    let mut e = entry("collision".into(), 0);
    e.action = "buy".into();
    e.status = "planned".into();
    e.claim = Some(ClaimRef { scope: 3, mask: "8".into() });
    e.quantity_atoms = "1000000".into();
    journal
        .locked(|j| {
            j.entries = vec![e.clone()];
            Ok(())
        })
        .unwrap();
    let ex = Executor::new(
        Arc::new(ChainReader::new(Box::new(JsonRpc::new("http://127.0.0.1:9", Duration::from_secs(1)).unwrap()))),
        signer,
        journal.clone(),
        Some(Arc::new(RuntimeClient::new(&server.url, TOKEN).unwrap())),
        Arc::new(FixedControls { policy: parse_config(&default_config()).unwrap().policy, allowed: true }),
        Duration::ZERO,
    );
    assert!(ex.sign("collision", &d).unwrap().is_none());
    assert_eq!(journal.read().unwrap().entries[0].note.as_deref(), Some("SEMANTIC_COLLISION"));
    let c = ExecutionRequest {
        decision_id: "test".into(),
        deployment: d,
        action: "buy".into(),
        claim: Claim { scope: 3, mask: 8 },
        quantity_atoms: 1000000,
        slippage_bps: 50,
        quote_atoms: 500000,
        quote_block: Block { number: 1, hash: "0x".into(), timestamp: now },
    };
    assert_eq!(ex.execute(&c).unwrap().reason.as_deref(), Some("SEMANTIC_COLLISION"));
    assert!(journal.read().unwrap().entries[0].raw_transaction.is_none());
    std::fs::remove_file(dir.join("journal.json")).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

/// Runs only as a child process of `journal_lock_serialises_separate_processes`.
#[test]
fn journal_child_writer() {
    let Ok(dir) = std::env::var("FLURBO_JOURNAL_CHILD_DIR") else { return };
    let j = FileJournal::new(Path::new(&dir), WALLET).unwrap();
    for i in 0..40 {
        j.locked(|f| {
            let seq = f.entries.len();
            f.entries.push(entry(format!("{}-{}", std::process::id(), i), seq));
            Ok(())
        })
        .unwrap();
    }
}

#[test]
fn journal_lock_serialises_separate_processes() {
    let dir = std::env::temp_dir().join(format!("flurbo-rs-journal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let exe = std::env::current_exe().unwrap();
    let children: Vec<_> = (0..3).map(|_| Command::new(&exe).args(["--exact", "journal_child_writer", "--test-threads", "1"]).env("FLURBO_JOURNAL_CHILD_DIR", &dir).spawn().unwrap()).collect();
    for mut c in children {
        assert!(c.wait().unwrap().success());
    }
    let j = FileJournal::new(&dir, WALLET).unwrap();
    let entries = j.read().unwrap().entries;
    assert_eq!(entries.len(), 120, "no lost updates");
    assert_eq!(entries.iter().map(|e| e.extra["seq"].as_u64().unwrap() as usize).collect::<Vec<_>>(), (0..120).collect::<Vec<_>>());
    assert!(!dir.join("journal.lock").exists(), "the lock is released");
    let other = FileJournal::new(&dir, "0x3333333333333333333333333333333333333333").unwrap();
    assert!(other.read().unwrap_err().message.contains("one state directory per agent wallet"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_reads_every_runtime_format_and_keeps_unknown_fields() {
    // An entry exactly as the TypeScript and Python runtimes write it, plus a field from a newer runtime.
    let dir = std::env::temp_dir().join(format!("flurbo-rs-format-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let written = json!({"schema": "flurbo.agent-journal.v1", "wallet": WALLET, "chainId": 10143, "entries": [{
        "id": "e1", "action": "buy", "namespace": "pilot", "pool": "0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02", "claim": {"scope": 3, "mask": "8"},
        "quantityAtoms": "1000000", "limitAtoms": "510000", "deadline": 1790000300, "status": "signed", "plannedAt": 1790000000, "decisionId": "d-1",
        "to": "0x28d5ee02b1eda6959ac3ee5a4f834237c84dee02", "data": "0x", "gas": "250000", "maxFeePerGas": "1", "maxPriorityFeePerGas": "1", "nonce": 4,
        "rawTransaction": "0x02", "hash": "0xab", "signedAt": 1790000001, "broadcastAt": null, "finalAt": null, "costAtoms": null, "receipt": null, "note": null,
        "owner": {"pid": 1, "host": "h"}, "report": {"status": "none", "attempts": 0, "flurboStatus": null}, "futureField": {"kept": true}}]});
    std::fs::write(dir.join("journal.json"), written.to_string()).unwrap();
    let j = FileJournal::new(&dir, WALLET).unwrap();
    j.locked(|f| {
        f.entries[0].note = Some("touched".into());
        Ok(())
    })
    .unwrap();
    let back: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("journal.json")).unwrap()).unwrap();
    let mut expected = written["entries"][0].clone();
    expected["note"] = json!("touched");
    assert_eq!(back["entries"][0], expected);
    let _ = std::fs::remove_dir_all(&dir);
}

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("flurbo-rs-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn signer_cli_and_configuration() {
    assert!(LocalKeySigner::new("0x1234").is_err());
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).unwrap();
    let key = format!("0x{}", raw.iter().map(|b| format!("{:02x}", b)).collect::<String>());
    let signer = LocalKeySigner::new(&key).unwrap();
    assert!(!format!("{:?}", signer).contains(&key[2..]));
    let err_missing = LocalKeySigner::from_env("FLURBO_TEST_MISSING_KEY").unwrap_err();
    assert!(err_missing.message.contains("Set FLURBO_TEST_MISSING_KEY"));

    let d = temp("cli");
    let config = d.join("flurbo-agent.json").to_string_lossy().to_string();
    let (mut out, mut err) = (Vec::<String>::new(), Vec::<String>::new());
    let run = |args: &[&str], out: &mut Vec<String>, err: &mut Vec<String>| {
        let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        main_with(&argv, &mut |s| out.push(s.into()), &mut |s| err.push(s.into()))
    };
    assert_eq!(run(&["init", "--config", &config], &mut out, &mut err), 0);
    parse_config(&serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap()).unwrap();
    assert_eq!(run(&["init", "--config", &config], &mut out, &mut err), 1);
    let message = |w: &str| {
        format!("Flurbo agent wallet association\nOrigin: http://localhost\nMera account: 0x{}\nAgent: a\nAgent wallet: {}\nChain: Monad testnet (10143)\nNonce: n\nIssued: x\nExpires: y\nThis proves control of this wallet.", "44".repeat(20), w)
    };
    std::fs::write(d.join("m.txt"), message(&signer.address())).unwrap();
    std::fs::write(d.join("other.txt"), message(&format!("0x{}", "55".repeat(20)))).unwrap();
    std::fs::write(d.join("tx.txt"), "Transfer all funds").unwrap();
    // The only test that sets this variable; the CLI reads the key from the environment by design.
    std::env::set_var("FLURBO_AGENT_PRIVATE_KEY", &key);
    let file = |n: &str| d.join(n).to_string_lossy().to_string();
    out.clear();
    assert_eq!(run(&["sign-message", "--file", &file("m.txt"), "--config", &config], &mut out, &mut err), 0);
    assert_eq!(out[0], signer.sign_message(&message(&signer.address())).unwrap());
    assert_eq!(run(&["sign-message", "--file", &file("other.txt"), "--config", &config], &mut out, &mut err), 1);
    assert_eq!(run(&["sign-message", "--file", &file("tx.txt"), "--config", &config], &mut out, &mut err), 1);
    out.clear();
    assert_eq!(run(&["address", "--config", &config], &mut out, &mut err), 0);
    assert_eq!(out[0], signer.address());
    std::env::remove_var("FLURBO_AGENT_PRIVATE_KEY");
    assert!(err.iter().all(|e| !e.contains(&key[2..])));
    // Paper-mode status and stop need no key and no credential.
    out.clear();
    assert_eq!(run(&["status", "--config", &config], &mut out, &mut err), 0, "{:?}", err);
    assert_eq!(serde_json::from_str::<Value>(&out[0]).unwrap()["mode"], "paper");
    assert_eq!(run(&["stop", "--config", &config], &mut out, &mut err), 0);
    assert!(d.join(".flurbo-agent").join("stop.request").exists());

    let mut bad = default_config();
    bad["mode"] = json!("autonomous");
    assert!(parse_config(&bad).unwrap_err().message.contains("mode"));
    let mut secret = default_config();
    secret["research"]["provider"] = json!({"kind": "anthropic", "model": "m", "apiKeyEnv": "K", "privateKey": key});
    assert!(parse_config(&secret).unwrap_err().message.contains("secrets"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn semantic_disabled_passes_guard_but_failures_never_do() {
    use flurbo_sdk::claims::ClaimRef;
    use flurbo_sdk::runtime::chain::ChainReader;
    use flurbo_sdk::runtime::executor::{Executor, FixedControls};
    use flurbo_sdk::runtime::rpc::JsonRpc;
    let f: Value = serde_json::from_str(include_str!("../../../protocol/fixtures/semantics.json")).unwrap();
    let d = serde_json::from_value::<flurbo_sdk::protocol::Deployment>(f["deployment"].clone()).unwrap();
    let mut disabled = f["cases"].as_array().unwrap().iter().find(|c| c["name"] == "disabled proceeds without semantic assurance").unwrap()["result"].clone();
    let now = flurbo_sdk::time::now_seconds();
    disabled["checkedAt"] = json!(now);
    disabled["expiresAt"] = json!(now + 60);
    for (status, body, blocked) in
        [(200, disabled.to_string(), false), (503, json!({"code":"SEMANTICS_UNAVAILABLE"}).to_string(), true), (200, json!({"code":"SEMANTICS_UNAVAILABLE"}).to_string(), true)]
    {
        let server = Server::start(Box::new(move |_, _| (status, h(&[("Content-Type", "application/json")]), body.clone())));
        let signer = Arc::new(LocalKeySigner::new(&format!("0x{}", "01".repeat(32))).unwrap());
        let dir = std::env::temp_dir().join(format!("flurbo-semantic-disabled-{}-{}-{}", std::process::id(), status, blocked));
        let journal = Arc::new(FileJournal::new(&dir, &signer.address()).unwrap());
        let mut e = entry("disabled".into(), 0);
        e.action = "buy".into();
        e.status = "planned".into();
        e.claim = Some(ClaimRef { scope: 3, mask: "8".into() });
        e.quantity_atoms = "1000000".into();
        journal
            .locked(|j| {
                j.entries = vec![e.clone()];
                Ok(())
            })
            .unwrap();
        let ex = Executor::new(
            Arc::new(ChainReader::new(Box::new(JsonRpc::new("http://127.0.0.1:9", Duration::from_secs(1)).unwrap()))),
            signer,
            journal.clone(),
            Some(Arc::new(RuntimeClient::new(&server.url, TOKEN).unwrap())),
            Arc::new(FixedControls { policy: parse_config(&default_config()).unwrap().policy, allowed: true }),
            Duration::ZERO,
        );
        let _ = ex.sign("disabled", &d);
        let note = journal.read().unwrap().entries[0].note.clone();
        assert_eq!(note.as_deref() == Some("SEMANTICS_UNAVAILABLE"), blocked, "{status} {note:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
