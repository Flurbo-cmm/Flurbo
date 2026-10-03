//! The reference strategy joint-edge v1, checked against protocol/fixtures/strategy.json. Expected value
//! assumes no VOID outcome and excludes gas; edge is a model estimate, not a promised profit.
use std::collections::HashMap;

use crate::amounts::{ceil_div, trunc_div, PPM};
use crate::claims::{claim_key, claim_probability, covers, encode_claim, Leg};

pub const STRATEGY_ID: &str = "joint-edge";
pub const STRATEGY_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrategyMarket {
    pub pool: String,
    pub event_count: u32,
    pub open: bool,
    pub resolved: bool,
    pub closes_at: i64,
    pub snapshot_block_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JointForecast {
    pub events: Vec<u32>,
    pub states_ppm: Vec<i128>,
    pub fresh_evidence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrategyConfig {
    pub quantity_atoms: i128,
    pub slippage_bps: i128,
    pub min_edge_bps: i128,
    pub min_edge_atoms: i128,
    pub max_cost_atoms: i128,
    pub min_evidence: u32,
    pub include_singles: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub amount_atoms: i128,
    pub expires_at: i64,
    pub block_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub scope: u32,
    pub mask: u32,
    pub forecast_ppm: i128,
    pub status: &'static str,
    pub quote_atoms: Option<i128>,
    pub worst_cost_atoms: Option<i128>,
    pub expected_payout_atoms: Option<i128>,
    pub edge_atoms: Option<i128>,
    pub edge_bps: Option<i128>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub scope: u32,
    pub mask: u32,
    pub quantity_atoms: i128,
    pub quote_atoms: i128,
    pub worst_cost_atoms: i128,
    pub expected_payout_atoms: i128,
    pub edge_atoms: i128,
    pub edge_bps: i128,
    pub slippage_bps: i128,
    pub forecast_ppm: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub outcome: &'static str,
    pub reasons: Vec<&'static str>,
    pub proposal: Option<Proposal>,
    pub evaluations: Vec<Evaluation>,
}

/// Single answers (optional), every "all of these" pair combination, "at least one" and "exactly one" of
/// each pair's Yes answers. Insertion order, duplicates dropped, at most 24.
pub fn candidate_claims(pool: &str, event_count: u32, joint_events: &[u32], include_singles: bool) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |legs: &[Leg], rule: &str| {
        if let Ok((scope, mask)) = encode_claim(event_count as i64, legs, rule) {
            if seen.insert(claim_key(10143, pool, scope, mask)) {
                out.push((scope, mask));
            }
        }
    };
    let leg = |e: u32, yes: bool| Leg { event: e as i64, yes };
    if include_singles {
        for e in joint_events {
            for yes in [true, false] {
                add(&[leg(*e, yes)], "AND");
            }
        }
    }
    for i in 0..joint_events.len() {
        for j in i + 1..joint_events.len() {
            let (a, b) = (joint_events[i], joint_events[j]);
            for ya in [true, false] {
                for yb in [true, false] {
                    add(&[leg(a, ya), leg(b, yb)], "AND");
                }
            }
            add(&[leg(a, true), leg(b, true)], "OR");
            add(&[leg(a, true), leg(b, true)], "EXACTLY_ONE");
        }
    }
    out.truncate(24);
    out
}

fn abstain(reasons: Vec<&'static str>, evaluations: Vec<Evaluation>) -> Decision {
    Decision { outcome: "abstain", reasons, proposal: None, evaluations }
}

/// quotes: claim_key to quote, for the claims the pool quoted at this size.
pub fn decide(market: &StrategyMarket, forecast: &JointForecast, config: &StrategyConfig, now: i64, quotes: &HashMap<String, Quote>) -> Decision {
    let (pool, events, states) = (&market.pool, &forecast.events, &forecast.states_ppm);
    if !market.open || market.resolved || now >= market.closes_at {
        return abstain(vec!["market_closed"], vec![]);
    }
    if forecast.fresh_evidence < config.min_evidence {
        return abstain(vec!["insufficient_evidence"], vec![]);
    }
    let claims: Vec<(u32, u32)> = candidate_claims(pool, market.event_count, events, config.include_singles).into_iter().filter(|c| covers(events, c.0)).collect();
    if claims.is_empty() {
        return abstain(vec!["no_supported_claim"], vec![]);
    }
    let quantity = config.quantity_atoms;
    let mut evaluations = Vec::new();
    for (scope, mask) in claims {
        let p = claim_probability(events, states, scope, mask);
        let base = Evaluation { scope, mask, forecast_ppm: p, status: "", quote_atoms: None, worst_cost_atoms: None, expected_payout_atoms: None, edge_atoms: None, edge_bps: None };
        let q = quotes.get(&claim_key(10143, pool, scope, mask));
        let Some(q) = q.filter(|q| q.block_hash == market.snapshot_block_hash) else {
            evaluations.push(Evaluation { status: "quote_unavailable", ..base });
            continue;
        };
        if now >= q.expires_at {
            evaluations.push(Evaluation { status: "quote_expired", ..base });
            continue;
        }
        let worst = ceil_div(q.amount_atoms * (10_000 + config.slippage_bps), 10_000).unwrap_or(i128::MAX);
        let expected = quantity * p / PPM;
        let edge = expected - worst;
        let edge_bps = trunc_div(edge * 10_000, worst);
        let status = if worst > config.max_cost_atoms {
            "budget_exceeded"
        } else if edge_bps < config.min_edge_bps || edge < config.min_edge_atoms {
            "edge_below_threshold"
        } else {
            "eligible"
        };
        evaluations.push(Evaluation {
            status,
            quote_atoms: Some(q.amount_atoms),
            worst_cost_atoms: Some(worst),
            expected_payout_atoms: Some(expected),
            edge_atoms: Some(edge),
            edge_bps: Some(edge_bps),
            ..base
        });
    }
    // Largest edge; ties broken by the claim key as a string, ascending.
    let best = evaluations
        .iter()
        .filter(|e| e.status == "eligible")
        .min_by(|a, b| b.edge_atoms.cmp(&a.edge_atoms).then_with(|| claim_key(10143, pool, a.scope, a.mask).cmp(&claim_key(10143, pool, b.scope, b.mask))))
        .cloned();
    let Some(best) = best else {
        let reasons = ["quote_expired", "quote_unavailable", "budget_exceeded", "edge_below_threshold"].into_iter().filter(|r| evaluations.iter().any(|e| e.status == *r)).collect();
        return abstain(reasons, evaluations);
    };
    let proposal = Proposal {
        scope: best.scope,
        mask: best.mask,
        quantity_atoms: quantity,
        quote_atoms: best.quote_atoms.unwrap(),
        worst_cost_atoms: best.worst_cost_atoms.unwrap(),
        expected_payout_atoms: best.expected_payout_atoms.unwrap(),
        edge_atoms: best.edge_atoms.unwrap(),
        edge_bps: best.edge_bps.unwrap(),
        slippage_bps: config.slippage_bps,
        forecast_ppm: best.forecast_ppm,
    };
    Decision { outcome: "propose", reasons: vec![], proposal: Some(proposal), evaluations }
}
