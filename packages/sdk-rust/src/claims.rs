//! Canonical claims, flurbo.claim.v1 (protocol/specs/claims.md).
//!
//! A claim is (chain, pool, scope, mask). Scope bit i: event i is part of the claim. Local bit j of a state
//! is the answer of the j-th selected event in ascending order; mask bit s: the claim pays in local state s.
use serde::{Deserialize, Serialize};

use crate::error::{FlurboError, Result};

pub const CLAIM_SCHEMA: &str = "flurbo.claim.v1";
pub const CLAIM_RULES: [&str; 4] = ["AND", "OR", "EXACTLY_ONE", "AT_LEAST_TWO"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leg {
    pub event: i64,
    pub yes: bool,
}

/// A claim as it appears in JSON: the mask is a decimal string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClaimRef {
    pub scope: u32,
    pub mask: String,
}

impl ClaimRef {
    pub fn new(scope: u32, mask: u32) -> Self {
        ClaimRef { scope, mask: mask.to_string() }
    }
    pub fn mask_u32(&self) -> u32 {
        self.mask.parse().unwrap_or(0)
    }
}

fn unsupported(message: &str) -> FlurboError {
    FlurboError::new("unsupported_claim", message)
}

pub fn rule_matches(rule: &str, matches: &[bool]) -> Result<bool> {
    if !CLAIM_RULES.contains(&rule) || matches.is_empty() {
        return Err(unsupported("Unsupported payout rule."));
    }
    let count = matches.iter().filter(|m| **m).count();
    Ok(match rule {
        "AND" => count == matches.len(),
        "OR" => count > 0,
        "EXACTLY_ONE" => count == 1,
        _ => count >= 2,
    })
}

pub fn claim_events(scope: i64) -> Result<Vec<u32>> {
    if scope <= 0 || scope >= 16 {
        return Err(unsupported("Invalid claim scope."));
    }
    Ok((0..4).filter(|i| scope & (1 << i) != 0).collect())
}

fn mask_text_ok(mask: &str) -> bool {
    let b = mask.as_bytes();
    !b.is_empty() && b.len() <= 3 && b[0] != b'0' && b.iter().all(|c| c.is_ascii_digit())
}

pub fn validate_claim(scope: i64, mask: &str, events: i64) -> Result<Vec<u32>> {
    if !(2..=4).contains(&events) || !mask_text_ok(mask) {
        return Err(unsupported("Invalid claim."));
    }
    let legs = claim_events(scope)?;
    let m: u64 = mask.parse().unwrap();
    if scope >= (1i64 << events) || legs.len() > 3 || m >= (1u64 << (1u32 << legs.len())) - 1 {
        return Err(unsupported("Unsupported claim."));
    }
    Ok(legs)
}

pub fn claim_valid(scope: i64, mask: &str, events: i64) -> bool {
    validate_claim(scope, mask, events).is_ok()
}

/// Legs are sorted internally by event. Returns (scope, mask).
pub fn encode_claim(events: i64, legs: &[Leg], rule: &str) -> Result<(u32, u32)> {
    if legs.is_empty() || legs.len() > 3 || !CLAIM_RULES.contains(&rule) {
        return Err(unsupported("Choose one to three answers."));
    }
    let mut ordered = legs.to_vec();
    ordered.sort_by_key(|l| l.event);
    let distinct = ordered.windows(2).all(|w| w[0].event != w[1].event);
    if !distinct || ordered.iter().any(|l| l.event < 0 || l.event >= events) {
        return Err(unsupported("Invalid claim answers."));
    }
    if rule == "AT_LEAST_TWO" && legs.len() < 2 {
        return Err(unsupported("Choose at least two answers."));
    }
    let scope = ordered.iter().fold(0u32, |s, l| s | (1 << l.event));
    let mut mask = 0u32;
    for state in 0..(1u32 << ordered.len()) {
        let matches: Vec<bool> = ordered.iter().enumerate().map(|(i, l)| (state & (1 << i) != 0) == l.yes).collect();
        if rule_matches(rule, &matches)? {
            mask |= 1 << state;
        }
    }
    validate_claim(scope as i64, &mask.to_string(), events)?;
    Ok((scope, mask))
}

/// The named rule that encodes to exactly this mask, or None. Masks are never rewritten.
pub fn decode_claim(scope: i64, mask: &str, events: i64) -> Result<Option<(&'static str, Vec<Leg>)>> {
    let selected = validate_claim(scope, mask, events)?;
    let target: u32 = mask.parse().unwrap();
    for rule in CLAIM_RULES {
        if rule == "AT_LEAST_TWO" && selected.len() < 2 {
            continue;
        }
        for state in (0..(1u32 << selected.len())).rev() {
            let legs: Vec<Leg> = selected.iter().enumerate().map(|(i, e)| Leg { event: *e as i64, yes: state & (1 << i) != 0 }).collect();
            if encode_claim(events, &legs, rule)?.1 == target {
                return Ok(Some((rule, legs)));
            }
        }
    }
    Ok(None)
}

pub fn claim_key(chain_id: u64, pool: &str, scope: u32, mask: u32) -> String {
    format!("{}:{}:{}:{}", chain_id, pool.to_lowercase(), scope, mask)
}

pub fn scope_events(scope: u32) -> Vec<u32> {
    (0..31).filter(|i| scope & (1 << i) != 0).collect()
}

/// Does the claim pay in a full-pool assignment (bit i = event i is Yes)?
pub fn pays_in(scope: u32, mask: u32, state: u32) -> bool {
    let mut local = 0u32;
    for (index, event) in scope_events(scope).iter().enumerate() {
        if state & (1 << event) != 0 {
            local |= 1 << index;
        }
    }
    local < 32 && mask & (1 << local) != 0
}

/// As PilotPool.payoutFraction: VOID events are averaged over both answers. VOID is not No.
pub fn payout_fraction(scope: u32, mask: u32, event_count: u32, yes_mask: u32, void_mask: u32) -> Result<(u64, u64)> {
    let full = (1u32 << event_count) - 1;
    if yes_mask & void_mask != 0 || yes_mask > full || void_mask > full {
        return Err(FlurboError::invalid("Invalid resolution."));
    }
    let known = full ^ void_mask;
    let (mut numerator, mut denominator) = (0u64, 0u64);
    for state in 0..=full {
        if state & known != yes_mask {
            continue;
        }
        denominator += 1;
        if pays_in(scope, mask, state) {
            numerator += 1;
        }
    }
    Ok((numerator, denominator))
}

fn position(joint_events: &[u32], event: u32) -> usize {
    joint_events.iter().position(|e| *e == event).expect("the joint forecast covers the claim")
}

/// Probability (ppm) that a claim pays under a joint forecast covering its events.
pub fn claim_probability(joint_events: &[u32], states: &[i128], scope: u32, mask: u32) -> i128 {
    let positions: Vec<usize> = scope_events(scope).iter().map(|e| position(joint_events, *e)).collect();
    let mut total = 0;
    for (s, p) in states.iter().enumerate() {
        let mut local = 0u32;
        for (j, pos) in positions.iter().enumerate() {
            if s & (1 << pos) != 0 {
                local |= 1 << j;
            }
        }
        if mask & (1 << local) != 0 {
            total += p;
        }
    }
    total
}

pub fn covers(joint_events: &[u32], scope: u32) -> bool {
    scope_events(scope).iter().all(|e| joint_events.contains(e))
}

pub fn marginal(joint_events: &[u32], states: &[i128], event: u32) -> i128 {
    let bit = 1usize << position(joint_events, event);
    states.iter().enumerate().filter(|(s, _)| s & bit != 0).map(|(_, p)| p).sum()
}
