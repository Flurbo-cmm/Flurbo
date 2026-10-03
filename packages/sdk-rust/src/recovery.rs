//! One recovery step for a journal entry (protocol/specs/transactions.md). Pure: the caller supplies what
//! the chain shows. nonce_latest is eth_getTransactionCount(wallet, "latest"); the nonce is used once
//! nonce_latest > nonce. The contract rejects a trade only when block.timestamp > deadline.
use serde::{Deserialize, Serialize};

pub const FINAL: [&str; 6] = ["confirmed", "reverted", "mismatch", "replaced", "expired", "abandoned"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub status: String,
    #[serde(default)]
    pub action: String,
    pub nonce: Option<u64>,
    pub deadline: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainView {
    pub tx_found: bool,
    pub receipt_status: Option<u8>,
    pub nonce_latest: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub status: String,
    pub action: String,
}

fn step(status: &str, action: &str) -> Step {
    Step { status: status.into(), action: action.into() }
}

pub fn recovery_step(entry: &RecoveryEntry, chain: &ChainView, now: i64) -> Step {
    if FINAL.contains(&entry.status.as_str()) {
        return step(&entry.status, "none");
    }
    if entry.status == "planned" {
        return step("abandoned", "release"); // nothing was signed
    }
    match chain.receipt_status {
        Some(1) => return step("broadcast", "verify"),
        Some(0) => return step("reverted", "release"),
        _ => {}
    }
    if chain.tx_found {
        return step("broadcast", "poll");
    }
    if entry.nonce.is_some_and(|n| chain.nonce_latest > n) {
        return step("replaced", "release");
    }
    if entry.deadline.is_some_and(|d| now > d) {
        return step("expired", "release");
    }
    // Same signed bytes, same hash: sending again cannot create a second transaction.
    step(&entry.status, "rebroadcast")
}
