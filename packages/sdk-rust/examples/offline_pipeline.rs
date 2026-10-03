//! The autonomous pipeline, offline and deterministic: research -> validated forecast -> strategy ->
//! deterministic policy -> the transaction that would be signed. No network, no keys, no signer. The
//! forecaster is a FIXTURE (a fixed reply), not AI; ai_agent.rs uses a real model provider.
//!
//! ```text
//! cargo run --example offline_pipeline
//! ```
use std::collections::HashMap;

use flurbo_sdk::amounts::buy_limit;
use flurbo_sdk::claims::{claim_key, ClaimRef};
use flurbo_sdk::policy::{evaluate_policy, Candidate, PolicyInput, PolicyMarket, PolicyWallet};
use flurbo_sdk::protocol::{CodeHashes, Deployment};
use flurbo_sdk::research::{Evidence, PromptEvent, MODEL_SCHEMA};
use flurbo_sdk::runtime::config::{default_config, parse_config};
use flurbo_sdk::runtime::research::{FixtureForecaster, FixtureRetriever, Research, Researcher};
use flurbo_sdk::runtime::runner::{JointEdgeStrategy, Strategy, StrategyContext};
use flurbo_sdk::strategy::{JointForecast, Quote, StrategyMarket};
use flurbo_sdk::transaction::{build_transaction, Claim, Intent};
use serde_json::json;

const NOW: i64 = 1_790_500_010;
const POOL: &str = "0x00000000000000000000000000000000f1c7a0e0";

fn main() -> flurbo_sdk::Result<()> {
    let events: Vec<PromptEvent> = ["Will project A ship 1.0? (fixture)", "Will project B ship 2.0? (fixture)"]
        .iter()
        .enumerate()
        .map(|(i, q)| PromptEvent { index: i as u32, question: q.to_string(), yes_rule: "YES if released.".into(), no_rule: "NO otherwise.".into(), observation_ends_at: 1_791_000_000 })
        .collect();
    let retriever = FixtureRetriever {
        records: vec![Evidence {
            schema: flurbo_sdk::research::EVIDENCE_SCHEMA.into(),
            id: "src-1".into(),
            url: "https://example.org/fixture-release-notes".into(),
            requested_url: "https://example.org/fixture-release-notes".into(),
            final_url: "https://example.org/fixture-release-notes".into(),
            title: Some("Fixture release notes".into()),
            publisher: Some("example.org".into()),
            retrieved_at: 0,
            publisher_released_at: Some(NOW - 3600),
            http_last_modified: None,
            content_sha256: "0".repeat(64),
            excerpt: "Both release branches were tagged on the same day (fixture text).".into(),
            complete_document: true,
            captured_bytes: 63,
            event_ids: vec![0, 1],
        }],
    };
    let reply = json!({"schema": MODEL_SCHEMA, "abstain": false, "abstainReason": null, "events": [0, 1], "statesPpm": [250_000, 100_000, 100_000, 550_000],
        "evidenceIds": ["src-1"], "assumptions": ["The two releases share a dependency."], "uncertainty": "A late fix could split them.",
        "explanation": "Fixture reasoning: both branches were tagged together, so both releases are likely and linked."});
    let forecaster = FixtureForecaster::fixed(&reply.to_string(), "offline-fixture (not AI)");
    let researcher = Researcher::new(Box::new(retriever), Ok(Box::new(forecaster)), 14 * 86_400, 2, 10);
    let (output, fresh, provenance) = match researcher.research(POOL, "Fixture market", &events, &[], NOW) {
        Research::Ok { output, fresh_evidence, provenance, .. } => (output, fresh_evidence, provenance),
        Research::Abstain { reason, .. } => {
            println!("Abstained: {}", reason);
            return Ok(());
        }
    };
    println!("Forecast source: {} {}; joint ppm {:?}", provenance.kind, provenance.name, output.states_ppm);

    // Fixture quotes stand in for pool.quoteBuy: an independent 50/50 market price plus a small spread.
    let quote = |claims: &[(u32, u32)], quantity: i128| -> HashMap<String, Quote> {
        claims
            .iter()
            .map(|(scope, mask)| {
                let amount = quantity * mask.count_ones() as i128 / (1i128 << scope.count_ones()) + 20_000;
                (claim_key(10143, POOL, *scope, *mask), Quote { amount_atoms: amount, expires_at: NOW + 50, block_hash: format!("0x{}", "f1".repeat(32)) })
            })
            .collect()
    };
    let config = parse_config(&default_config())?;
    let market = StrategyMarket { pool: POOL.into(), event_count: 2, open: true, resolved: false, closes_at: 1_790_900_000, snapshot_block_hash: format!("0x{}", "f1".repeat(32)) };
    let forecast = JointForecast { events: output.events.clone(), states_ppm: output.states_ppm.clone(), fresh_evidence: fresh };
    let decision = JointEdgeStrategy::from_config(&config).decide(&StrategyContext { market: &market, forecast: &forecast, now: NOW, quote: &quote })?;
    println!("Decision: {}. {}", decision.outcome, decision.explanation);
    let Some(p) = decision.proposal else { return Ok(()) };
    let limit = buy_limit(p.quote_atoms, p.slippage_bps);
    let namespace = format!("practice-{}", &POOL[2..]);
    let mut policy = config.policy.clone();
    policy.markets = vec![namespace.clone()];
    let verdict = evaluate_policy(&PolicyInput {
        policy,
        now: NOW,
        market: PolicyMarket { namespace: namespace.clone(), pool: POOL.into(), event_count: 2, closes_at: 1_790_900_000, open: true, resolved: false },
        wallet: PolicyWallet { native_balance_wei: 10i128.pow(18), holdings: vec![] },
        journal: vec![],
        candidate: Candidate {
            action: "buy".into(),
            namespace: namespace.clone(),
            claim: ClaimRef::new(p.scope, p.mask),
            quantity_atoms: p.quantity_atoms,
            limit_atoms: limit,
            slippage_bps: p.slippage_bps as i64,
            quote_block_timestamp: NOW - 5,
            gas_limit: 250_000,
            max_fee_per_gas: 100_000_000_000,
        },
    });
    println!("Policy: {}", if verdict.ok { "passes".to_string() } else { format!("rejected ({})", verdict.violations.join(", ")) });
    let deployment = Deployment {
        namespace,
        chain_id: 10143,
        pool: POOL.into(),
        resolver: POOL.into(),
        code_hashes: CodeHashes { pool: String::new(), resolver: String::new() },
        rules_hash: String::new(),
        closes_at: 1_790_900_000,
        event_count: 2,
    };
    let intent = Intent::Buy { claim: Claim { scope: p.scope, mask: p.mask }, quantity_atoms: p.quantity_atoms, limit_atoms: limit, deadline: (NOW + 300) as u64 };
    let tx = build_transaction(&intent, &deployment, &format!("0x{}", "11".repeat(20)))?;
    println!("Would sign: buy {} atoms of claim {}/{}, paying at most {} atoms, calldata {}... (offline: nothing signed)", p.quantity_atoms, p.scope, p.mask, limit, &tx.data[..18]);
    Ok(())
}
