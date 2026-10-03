//! Replacing the reference strategy and research without changing the SDK. The runner accepts any type
//! implementing `Strategy` (id, version, decide) or `Forecaster` (kind, name, complete); policy checks,
//! signing, the journal and recovery stay the SDK's.
//!
//! ```text
//! cargo run --example custom_strategy -- flurbo-agent.json [--once]
//! ```
//!
//! This strategy only trades relationships: it ignores single-event claims, requires the forecast to say
//! the two events are related, and buys the combination with the largest edge per unit of worst-case cost.
use std::path::Path;

use flurbo_sdk::amounts::{buy_limit, PPM};
use flurbo_sdk::claims::{claim_key, claim_probability, encode_claim, marginal, Leg};
use flurbo_sdk::research::{prompt_evidence_ids, Prompt, MODEL_SCHEMA};
use flurbo_sdk::runtime::cli::load_config;
use flurbo_sdk::runtime::research::Forecaster;
use flurbo_sdk::runtime::runner::{AgentRunner, RunnerOptions, Strategy, StrategyContext, StrategyDecision, StrategyProposal};
use flurbo_sdk::Result;
use serde_json::json;

struct RelationshipOnly;

impl Strategy for RelationshipOnly {
    fn id(&self) -> String {
        "relationship-only".into()
    }
    fn version(&self) -> String {
        "1.0.0".into()
    }
    fn decide(&self, ctx: &StrategyContext) -> Result<StrategyDecision> {
        let (m, f) = (ctx.market, ctx.forecast);
        let (a, b) = (f.events[0], f.events[1]);
        let (p_a, p_b, p_ab) = (marginal(&f.events, &f.states_ppm, a), marginal(&f.events, &f.states_ppm, b), f.states_ppm[3]);
        if (p_ab - p_a * p_b / PPM).abs() < 50_000 {
            return Ok(StrategyDecision::abstain("no_relationship_edge", "The forecast treats the events as nearly independent."));
        }
        let leg = |e: u32, yes: bool| Leg { event: e as i64, yes };
        let mut claims = Vec::new();
        for ya in [true, false] {
            for yb in [true, false] {
                claims.push(encode_claim(m.event_count as i64, &[leg(a, ya), leg(b, yb)], "AND")?);
            }
        }
        for rule in ["OR", "EXACTLY_ONE"] {
            claims.push(encode_claim(m.event_count as i64, &[leg(a, true), leg(b, true)], rule)?);
        }
        let quantity = 1_000_000;
        let quotes = (ctx.quote)(&claims, quantity);
        let mut best: Option<(u32, u32, i128, i128, i128)> = None;
        for (scope, mask) in claims {
            let Some(q) = quotes.get(&claim_key(10143, &m.pool, scope, mask)) else { continue };
            let worst = buy_limit(q.amount_atoms, 50);
            let edge = quantity * claim_probability(&f.events, &f.states_ppm, scope, mask) / PPM - worst;
            let score = edge * 10_000 / worst;
            if edge > 20_000 && score >= 1_000 && worst <= 1_500_000 && best.is_none_or(|x| score > x.3) {
                best = Some((scope, mask, q.amount_atoms, score, edge));
            }
        }
        let Some((scope, mask, amount, score, edge)) = best else {
            return Ok(StrategyDecision::abstain("edge_below_threshold", "No combination clears 10% edge per unit of worst-case cost."));
        };
        Ok(StrategyDecision {
            outcome: "propose".into(),
            reasons: vec![],
            explanation: format!("Relationship trade: edge {} atoms, {} bps of worst-case cost.", edge, score),
            proposal: Some(StrategyProposal { scope, mask, quantity_atoms: quantity, quote_atoms: amount, slippage_bps: 50, edge_atoms: Some(edge), edge_bps: Some(score) }),
        })
    }
}

/// Custom research (not a language model): keyword rules over the retrieved text. Labelled custom, never AI.
struct KeywordResearch;

impl Forecaster for KeywordResearch {
    fn kind(&self) -> &str {
        "custom"
    }
    fn name(&self) -> String {
        "keyword-rules".into()
    }
    fn complete(&self, prompt: &Prompt) -> Result<String> {
        let text = prompt.user.to_lowercase();
        let ids = prompt_evidence_ids(&prompt.user);
        let tagged = ["tagged", "released", "published"].iter().map(|w| text.matches(w).count() as i64).sum::<i64>();
        let together = ["same day", "together", "shared"].iter().any(|w| text.contains(w));
        let p_both = (300_000 + tagged * 100_000 + if together { 150_000 } else { 0 }).min(800_000);
        let p_one = (1_000_000 - p_both) / 3;
        let reason = if ids.is_empty() { json!("insufficient_evidence") } else { json!(null) };
        let explanation = format!("Rule-based: {} release keywords{}.", tagged, if together { ", shared schedule" } else { "" });
        Ok(json!({"schema": MODEL_SCHEMA, "abstain": ids.is_empty(), "abstainReason": reason, "events": [0, 1],
            "statesPpm": [1_000_000 - p_both - 2 * p_one, p_one, p_one, p_both], "evidenceIds": ids.iter().take(3).collect::<Vec<_>>(),
            "assumptions": ["Keyword counts reflect release progress."], "uncertainty": "Keyword rules ignore context.", "explanation": explanation})
        .to_string())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.iter().find(|a| !a.starts_with("--")).cloned().unwrap_or_else(|| "flurbo-agent.json".into());
    let run = || -> Result<()> {
        let options = RunnerOptions { strategy: Some(Box::new(RelationshipOnly)), forecaster: Some(Box::new(KeywordResearch)), ..Default::default() };
        AgentRunner::new(load_config(Path::new(&path))?, options)?.run(args.iter().any(|a| a == "--once"));
        Ok(())
    };
    if let Err(e) = run() {
        eprintln!("{}: {}", e.code, e.message);
        std::process::exit(1);
    }
}
