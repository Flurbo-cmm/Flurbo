//! Deterministic execution policy (protocol/specs/transactions.md).
//!
//! Software checks in a compliant runtime: they bound what this runtime does, not what the wallet key can do.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::claims::{pays_in, ClaimRef};
use crate::num::{dec, dec_opt};
use crate::protocol::{SERVICE_MAX_ATOMS, SERVICE_SLIPPAGE_BPS};

pub const VIOLATIONS: [&str; 18] = [
    "SERVICE_LIMIT", "MARKET_NOT_ALLOWED", "MARKET_CLOSED", "MARKET_NOT_RESOLVED", "TOO_CLOSE_TO_CLOSE", "ACTION_DISABLED",
    "HOLDINGS_INSUFFICIENT", "QUANTITY_LIMIT", "TRADE_COST_LIMIT", "SLIPPAGE_LIMIT", "QUOTE_STALE", "TOTAL_SPEND_LIMIT",
    "WINDOW_SPEND_LIMIT", "POSITION_LIMIT", "WORST_CASE_LOSS_LIMIT", "GAS_FEE_LIMIT", "GAS_RESERVE", "PENDING_LIMIT",
];
pub const UNFINISHED: [&str; 3] = ["planned", "signed", "broadcast"];

pub fn unfinished(status: &str) -> bool {
    UNFINISHED.contains(&status)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub seconds: i64,
    #[serde(with = "dec")]
    pub atoms: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    #[serde(with = "dec")]
    pub total_atoms: i128,
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gas {
    #[serde(with = "dec")]
    pub max_fee_wei: i128,
    #[serde(with = "dec")]
    pub reserve_wei: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub markets: Vec<String>,
    #[serde(with = "dec")]
    pub max_quantity_atoms: i128,
    #[serde(with = "dec")]
    pub max_trade_cost_atoms: i128,
    pub max_slippage_bps: i64,
    pub spend: Spend,
    #[serde(with = "dec")]
    pub max_position_atoms: i128,
    #[serde(with = "dec")]
    pub max_worst_case_loss_atoms: i128,
    pub gas: Gas,
    pub quote_max_age_seconds: i64,
    pub min_seconds_before_close: i64,
    pub max_pending: usize,
    pub allow_sell: bool,
    pub allow_redeem: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyMarket {
    pub namespace: String,
    #[serde(default)]
    pub pool: String,
    pub event_count: u32,
    pub closes_at: i64,
    pub open: bool,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub scope: u32,
    pub mask: String,
    #[serde(with = "dec")]
    pub quantity_atoms: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyWallet {
    #[serde(with = "dec")]
    pub native_balance_wei: i128,
    pub holdings: Vec<Holding>,
}

/// The fields of a journal entry the policy reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEntry {
    #[serde(default)]
    pub id: String,
    pub action: String,
    pub namespace: String,
    pub claim: Option<ClaimRef>,
    #[serde(with = "dec")]
    pub quantity_atoms: i128,
    #[serde(with = "dec")]
    pub limit_atoms: i128,
    #[serde(default, with = "dec_opt")]
    pub cost_atoms: Option<i128>,
    pub status: String,
    pub planned_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub action: String,
    pub namespace: String,
    pub claim: ClaimRef,
    #[serde(with = "dec")]
    pub quantity_atoms: i128,
    #[serde(with = "dec")]
    pub limit_atoms: i128,
    pub slippage_bps: i64,
    pub quote_block_timestamp: i64,
    #[serde(with = "dec")]
    pub gas_limit: i128,
    #[serde(with = "dec")]
    pub max_fee_per_gas: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyInput {
    pub policy: Policy,
    pub now: i64,
    pub market: PolicyMarket,
    pub wallet: PolicyWallet,
    pub journal: Vec<PolicyEntry>,
    pub candidate: Candidate,
}

fn same(a: Option<&ClaimRef>, scope: u32, mask: &str) -> bool {
    a.is_some_and(|a| a.scope == scope && a.mask == mask)
}

/// What a buy counts toward spending: confirmed cost, the limit while unfinished or unknown, else zero.
pub fn spend_of(e: &PolicyEntry) -> i128 {
    if e.action != "buy" {
        return 0;
    }
    if e.status == "confirmed" {
        return e.cost_atoms.unwrap_or(0);
    }
    if unfinished(&e.status) || e.status == "mismatch" {
        return e.limit_atoms;
    }
    0
}

/// Agent cost basis in this pool minus the lowest total payout over every Yes/No outcome.
pub fn worst_case_loss(inp: &PolicyInput) -> i128 {
    let (market, candidate) = (&inp.market, &inp.candidate);
    let mut positions: BTreeMap<(u32, u32), i128> = BTreeMap::new();
    let mut cost = 0i128;
    let mut add = |claim: &ClaimRef, q: i128| *positions.entry((claim.scope, claim.mask_u32())).or_insert(0) += q;
    for e in &inp.journal {
        let Some(claim) = e.claim.as_ref().filter(|_| e.namespace == market.namespace) else { continue };
        if e.action == "buy" && e.status == "confirmed" {
            add(claim, e.quantity_atoms);
            cost += e.cost_atoms.unwrap_or(0);
        } else if e.action == "buy" && unfinished(&e.status) {
            add(claim, e.quantity_atoms);
            cost += e.limit_atoms;
        } else if (e.action == "sell" || e.action == "redeem") && e.status == "confirmed" {
            add(claim, -e.quantity_atoms);
        }
    }
    add(&candidate.claim, candidate.quantity_atoms);
    cost += candidate.limit_atoms;
    let floor = (0..(1u32 << market.event_count))
        .map(|state| positions.iter().filter(|((s, m), q)| **q > 0 && pays_in(*s, *m, state)).map(|(_, q)| *q).sum::<i128>())
        .min()
        .unwrap_or(0);
    cost - floor
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyResult {
    pub ok: bool,
    pub violations: Vec<&'static str>,
}

pub fn evaluate_policy(inp: &PolicyInput) -> PolicyResult {
    let (p, now, market, wallet, journal, c) = (&inp.policy, inp.now, &inp.market, &inp.wallet, &inp.journal, &inp.candidate);
    let mut found: Vec<&'static str> = Vec::new();
    let (action, quantity, limit) = (c.action.as_str(), c.quantity_atoms, c.limit_atoms);
    let buy = action == "buy";
    let trade = buy || action == "sell";
    if !(1..=SERVICE_MAX_ATOMS).contains(&quantity) || limit > SERVICE_MAX_ATOMS || (trade && !SERVICE_SLIPPAGE_BPS.contains(&c.slippage_bps)) {
        found.push("SERVICE_LIMIT");
    }
    if !p.markets.contains(&c.namespace) || c.namespace != market.namespace {
        found.push("MARKET_NOT_ALLOWED");
    }
    let closed = !market.open || now >= market.closes_at;
    if trade && closed {
        found.push("MARKET_CLOSED");
    }
    if action == "redeem" && !market.resolved {
        found.push("MARKET_NOT_RESOLVED");
    }
    if trade && !closed && market.closes_at - now < p.min_seconds_before_close {
        found.push("TOO_CLOSE_TO_CLOSE");
    }
    if (action == "sell" && !p.allow_sell) || (action == "redeem" && !p.allow_redeem) {
        found.push("ACTION_DISABLED");
    }
    let held: i128 = wallet.holdings.iter().filter(|h| h.scope == c.claim.scope && h.mask == c.claim.mask).map(|h| h.quantity_atoms).sum();
    if !buy && held < quantity {
        found.push("HOLDINGS_INSUFFICIENT");
    }
    if quantity > p.max_quantity_atoms {
        found.push("QUANTITY_LIMIT");
    }
    if buy && limit > p.max_trade_cost_atoms {
        found.push("TRADE_COST_LIMIT");
    }
    if trade && c.slippage_bps > p.max_slippage_bps {
        found.push("SLIPPAGE_LIMIT");
    }
    if trade && now - c.quote_block_timestamp > p.quote_max_age_seconds {
        found.push("QUOTE_STALE");
    }
    if buy {
        if journal.iter().map(spend_of).sum::<i128>() + limit > p.spend.total_atoms {
            found.push("TOTAL_SPEND_LIMIT");
        }
        for w in &p.spend.windows {
            if journal.iter().filter(|e| e.planned_at >= now - w.seconds).map(spend_of).sum::<i128>() + limit > w.atoms {
                found.push("WINDOW_SPEND_LIMIT");
            }
        }
        let pending_same: i128 = journal
            .iter()
            .filter(|e| e.action == "buy" && unfinished(&e.status) && e.namespace == c.namespace && same(e.claim.as_ref(), c.claim.scope, &c.claim.mask))
            .map(|e| e.quantity_atoms)
            .sum();
        if held + pending_same + quantity > p.max_position_atoms {
            found.push("POSITION_LIMIT");
        }
        if worst_case_loss(inp) > p.max_worst_case_loss_atoms {
            found.push("WORST_CASE_LOSS_LIMIT");
        }
    }
    let fee = c.gas_limit * c.max_fee_per_gas;
    if fee > p.gas.max_fee_wei {
        found.push("GAS_FEE_LIMIT");
    }
    if wallet.native_balance_wei - fee < p.gas.reserve_wei {
        found.push("GAS_RESERVE");
    }
    if journal.iter().filter(|e| unfinished(&e.status)).count() >= p.max_pending {
        found.push("PENDING_LIMIT");
    }
    let violations: Vec<&'static str> = VIOLATIONS.iter().copied().filter(|v| found.contains(v)).collect();
    PolicyResult { ok: violations.is_empty(), violations }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPolicy {
    pub mode: String,
    #[serde(with = "dec")]
    pub max_trade_cost_atoms: i128,
    pub spend: Spend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlurboLimits {
    #[serde(default, with = "dec_opt")]
    pub max_trade_cost_atoms: Option<i128>,
    #[serde(default)]
    pub windows: Vec<Window>,
}

/// The policy Flurbo publishes for the agent (GET /policy).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlurboPolicy {
    pub version: i64,
    pub paused: bool,
    pub live_enabled: bool,
    pub limits: FlurboLimits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    #[serde(with = "dec")]
    pub max_trade_cost_atoms: i128,
    pub windows: Vec<Window>,
    pub live_allowed: bool,
    pub reason: Option<String>,
}

/// Flurbo's published policy tightens the local configuration; it never loosens it.
pub fn effective_policy(local: &LocalPolicy, flurbo: Option<&FlurboPolicy>, read_at: Option<i64>, now: i64, policy_max_age_seconds: i64) -> EffectivePolicy {
    let server_max = flurbo.and_then(|f| f.limits.max_trade_cost_atoms);
    let max_trade = match server_max {
        Some(s) if s < local.max_trade_cost_atoms => s,
        _ => local.max_trade_cost_atoms,
    };
    let mut windows = local.spend.windows.clone();
    if let Some(f) = flurbo {
        windows.extend(f.limits.windows.iter().cloned());
    }
    let stale = read_at.is_none_or(|r| now - r > policy_max_age_seconds);
    let reason = if local.mode != "live" {
        Some("local_paper_mode")
    } else if let Some(f) = flurbo {
        if !f.live_enabled {
            Some("live_disabled")
        } else if f.paused {
            Some("paused")
        } else if stale {
            Some("policy_stale")
        } else {
            None
        }
    } else {
        Some("policy_stale")
    };
    EffectivePolicy { max_trade_cost_atoms: max_trade, windows, live_allowed: reason.is_none(), reason: reason.map(String::from) }
}
