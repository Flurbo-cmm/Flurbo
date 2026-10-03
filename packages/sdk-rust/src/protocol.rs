//! Protocol version 1 constants and deployment validation (protocol/README.md, specs/contracts.md).
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{FlurboError, Result};

pub const PROTOCOL_VERSION: &str = "1";
pub const PROTOCOL_HEADER: &str = "Flurbo-Agent-Protocol";
pub const RUNTIME_API_BASE: &str = "/api/agent-runtime/v1";
pub const CHAIN_ID: u64 = 10143;
pub const DEPLOYMENT_INTERFACE: &str = "flurbo.pilot-pool.v1";
pub const COLLATERAL: &str = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc";
pub const COLLATERAL_DECIMALS: u64 = 6;
pub const SERVICE_MAX_ATOMS: i128 = 100_000_000;
pub const SERVICE_SLIPPAGE_BPS: [i64; 3] = [10, 50, 100];
pub const MAX_DEADLINE_SECONDS: u64 = 300;
pub const SCOPES: [&str; 4] = ["markets:read", "wallet:read", "runtime:report", "executions:report"];
pub const STOP_CODES: [&str; 6] = ["UNAUTHENTICATED", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "INVITE_REQUIRED", "AGENT_ARCHIVED", "SCOPE_REQUIRED"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeHashes {
    pub pool: String,
    pub resolver: String,
}

/// A validated flurbo.agent-deployment.v1 record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub namespace: String,
    pub chain_id: u64,
    pub pool: String,
    pub resolver: String,
    pub code_hashes: CodeHashes,
    pub rules_hash: String,
    pub closes_at: u64,
    pub event_count: u32,
}

fn lower_hex_of(s: &str, len: usize) -> bool {
    s.len() == len + 2 && s.starts_with("0x") && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub(crate) fn namespace_ok(s: &str) -> bool {
    s == "pilot" || s.strip_prefix("practice-").is_some_and(|h| h.len() == 40 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

/// Validates a deployment record. Limits looser than the protocol's are refused, not trusted.
pub fn parse_deployment(d: &Value) -> Result<Deployment> {
    let bad = |what: &str| FlurboError::new("invalid_response", format!("Unsupported deployment: {}.", what));
    let s = |k: &str| d.get(k).and_then(Value::as_str);
    if s("schema") != Some("flurbo.agent-deployment.v1") {
        return Err(bad("schema"));
    }
    if s("interface") != Some(DEPLOYMENT_INTERFACE) {
        return Err(bad("interface"));
    }
    if d.get("chainId").and_then(Value::as_u64) != Some(CHAIN_ID) {
        return Err(bad("chain"));
    }
    let namespace = s("namespace").filter(|n| namespace_ok(n)).ok_or_else(|| bad("namespace"))?;
    let c = &d["collateral"];
    if c["address"].as_str() != Some(COLLATERAL) || c["decimals"].as_u64() != Some(COLLATERAL_DECIMALS) {
        return Err(bad("collateral"));
    }
    let pool = s("pool").filter(|v| lower_hex_of(v, 40)).ok_or_else(|| bad("pool"))?;
    let resolver = s("resolver").filter(|v| lower_hex_of(v, 40)).ok_or_else(|| bad("resolver"))?;
    let h = &d["codeHashes"];
    let hashes: Vec<Option<&str>> = vec![h["pool"].as_str(), h["resolver"].as_str(), s("rulesHash")];
    if !hashes.iter().all(|v| v.is_some_and(|v| lower_hex_of(v, 64))) {
        return Err(bad("hashes"));
    }
    let closes_at = d.get("closesAt").and_then(Value::as_u64);
    let event_count = d.get("eventCount").and_then(Value::as_u64).filter(|n| (2..=4).contains(n));
    let (Some(closes_at), Some(event_count)) = (closes_at, event_count) else { return Err(bad("market shape")) };
    let l = &d["limits"];
    let service = l["maxQuantityAtoms"].as_str() == Some("100000000") && l["maxLimitAtoms"].as_str() == Some("100000000")
        && l["slippageBps"] == serde_json::json!([10, 50, 100]) && l["maxDeadlineSeconds"].as_u64() == Some(300);
    if !service {
        return Err(bad("service limits"));
    }
    Ok(Deployment {
        namespace: namespace.into(),
        chain_id: CHAIN_ID,
        pool: pool.into(),
        resolver: resolver.into(),
        code_hashes: CodeHashes { pool: hashes[0].unwrap().into(), resolver: hashes[1].unwrap().into() },
        rules_hash: hashes[2].unwrap().into(),
        closes_at,
        event_count: event_count as u32,
    })
}
