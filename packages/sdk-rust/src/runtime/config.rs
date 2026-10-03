//! flurbo.agent-config.v1, the same configuration file the TypeScript and Python runtimes read. Secrets are
//! never in it: it names the environment variables that hold them.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::research::Source;
use crate::error::{FlurboError, Result};
use crate::policy::Policy;
use crate::research::EvidenceRequirement;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConfig {
    pub base_url: String,
    pub credential_env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainConfig {
    pub rpc_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerConfig {
    pub kind: String,
    pub key_env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub interval_seconds: u64,
    pub heartbeat_seconds: u64,
    pub wait_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieverConfig {
    pub kind: String,
    #[serde(default)]
    pub allow_hosts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_local_http: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_sources: Option<HashMap<String, Vec<Source>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProviderConfig {
    #[serde(rename_all = "camelCase")]
    OpenaiCompatible {
        base_url: String,
        model: String,
        api_key_env: Option<String>,
        timeout_ms: Option<u64>,
        max_retries: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Anthropic {
        model: String,
        api_key_env: String,
        timeout_ms: Option<u64>,
        max_retries: Option<u32>,
    },
    /// A fixed reply read from a file, for offline runs and demonstrations. Always reported as a fixture, not AI.
    #[serde(rename_all = "camelCase")]
    Fixture {
        reply_file: String,
    },
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchConfig {
    pub retriever: RetrieverConfig,
    pub provider: ProviderConfig,
    pub per_cycle: u32,
    pub per_hour: usize,
    pub max_evidence_age_days: i64,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub evidence_requirements: HashMap<String, Vec<EvidenceRequirement>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategySettings {
    pub id: String,
    pub quantity_atoms: String,
    pub slippage_bps: i64,
    pub min_edge_bps: i64,
    pub min_edge_atoms: String,
    pub max_cost_atoms: String,
    pub include_singles: bool,
    pub min_evidence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub schema: String,
    pub api: ApiConfig,
    pub chain: ChainConfig,
    pub signer: SignerConfig,
    pub state_dir: String,
    pub mode: String,
    pub markets: Vec<String>,
    pub schedule: Schedule,
    pub research: ResearchConfig,
    pub strategy: StrategySettings,
    pub policy: Policy,
    pub policy_max_age_seconds: i64,
    pub paper_budget_atoms: String,
}

pub fn default_config() -> Value {
    serde_json::json!({
        "schema": "flurbo.agent-config.v1",
        "api": {"baseUrl": "https://flurbo.singu.online", "credentialEnv": "FLURBO_AGENT_TOKEN"},
        "chain": {"rpcUrl": "https://testnet-rpc.monad.xyz"},
        "signer": {"kind": "local-key", "keyEnv": "FLURBO_AGENT_PRIVATE_KEY"},
        "stateDir": ".flurbo-agent", "mode": "paper", "markets": ["pilot"],
        "schedule": {"intervalSeconds": 300, "heartbeatSeconds": 30, "waitSeconds": 90},
        "research": {"retriever": {"kind": "http", "allowHosts": ["github.com"]}, "provider": {"kind": "none"}, "perCycle": 2, "perHour": 20, "maxEvidenceAgeDays": 14},
        "strategy": {"id": "joint-edge", "quantityAtoms": "1000000", "slippageBps": 50, "minEdgeBps": 500, "minEdgeAtoms": "10000", "maxCostAtoms": "2000000", "includeSingles": true, "minEvidence": 1},
        "policy": {"markets": ["pilot"], "maxQuantityAtoms": "2000000", "maxTradeCostAtoms": "2000000", "maxSlippageBps": 50,
                   "spend": {"totalAtoms": "20000000", "windows": [{"seconds": 86400, "atoms": "10000000"}]}, "maxPositionAtoms": "5000000", "maxWorstCaseLossAtoms": "10000000",
                   "gas": {"maxFeeWei": "100000000000000000", "reserveWei": "200000000000000000"}, "quoteMaxAgeSeconds": 30, "minSecondsBeforeClose": 120, "maxPending": 2,
                   "allowSell": false, "allowRedeem": false},
        "policyMaxAgeSeconds": 120, "paperBudgetAtoms": "50000000"
    })
}

fn env_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && (b[0].is_ascii_uppercase() || b[0] == b'_') && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

fn has_key_material(text: &str) -> bool {
    let b = text.as_bytes();
    (0..b.len().saturating_sub(65)).any(|i| b[i] == b'0' && (b[i + 1] == b'x') && b[i + 2..i + 66].iter().all(u8::is_ascii_hexdigit) && !b.get(i + 66).is_some_and(u8::is_ascii_hexdigit))
}

pub fn parse_config(value: &Value) -> Result<AgentConfig> {
    let bad = |m: &str| FlurboError::invalid(format!("Configuration: {}", m));
    if value.get("schema").and_then(Value::as_str) != Some("flurbo.agent-config.v1") {
        return Err(bad("schema must be flurbo.agent-config.v1."));
    }
    let c: AgentConfig = serde_json::from_value(value.clone()).map_err(|e| bad(&format!("{}.", e)))?;
    if c.mode != "paper" && c.mode != "live" {
        return Err(bad("mode must be paper or live."));
    }
    if c.markets.is_empty() {
        return Err(bad("list at least one market."));
    }
    if !c.policy.markets.iter().all(|m| c.markets.contains(m)) {
        return Err(bad("policy.markets must be a subset of markets."));
    }
    if ![10, 50, 100].contains(&c.policy.max_slippage_bps) || c.strategy.slippage_bps > c.policy.max_slippage_bps || ![10, 50, 100].contains(&c.strategy.slippage_bps) {
        return Err(bad("slippage must be 10, 50 or 100 and within the policy."));
    }
    if !env_name(&c.api.credential_env) || !env_name(&c.signer.key_env) {
        return Err(bad("credential and key settings must name environment variables."));
    }
    let text = value.to_string();
    let lower = text.to_lowercase();
    if has_key_material(&text) && (lower.contains("\"privatekey\"") || lower.contains("\"secret\"")) {
        return Err(bad("secrets do not belong in the configuration file."));
    }
    if c.schedule.interval_seconds < 10 || c.schedule.heartbeat_seconds < 5 {
        return Err(bad("schedule too aggressive."));
    }
    for (namespace, requirements) in &c.research.evidence_requirements {
        if !c.markets.contains(namespace)
            || requirements.iter().any(|r| r.event >= 4 || !["release", "background"].contains(&r.freshness.as_str()))
            || (1..requirements.len()).any(|i| requirements[..i].iter().any(|r| r.event == requirements[i].event))
        {
            return Err(bad("research.evidenceRequirements must contain configured markets and unique event requirements with release or background freshness."));
        }
    }
    for s in [&c.strategy.quantity_atoms, &c.strategy.min_edge_atoms, &c.strategy.max_cost_atoms, &c.paper_budget_atoms] {
        crate::amounts::parse_atoms(s, "strategy amount").map_err(|_| bad("amounts must be decimal strings."))?;
    }
    Ok(c)
}
