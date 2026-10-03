//! The agent loop, same configuration format (flurbo.agent-config.v1) and behavior as the TypeScript runtime.
//!
//! research -> validated forecast -> strategy -> policy -> quote and simulation -> journal -> sign -> broadcast
//! -> receipt -> verify -> report. Paper mode never constructs a signer.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha3::Digest;

use super::chain::{Block, ChainReader};
use super::config::{AgentConfig, ProviderConfig};
use super::executor::{Controls, ExecutionRequest, Executor, SDK_LANGUAGE, SDK_VERSION};
use super::headless::{is_stop, RuntimeClient};
use super::journal::{uuid4, FileJournal};
use super::research::{AnthropicMessages, FixtureForecaster, Forecaster, HttpRetriever, OpenAiCompatible, Research, Researcher, Retriever, Source};
use super::rpc::JsonRpc;
use crate::claims::{claim_key, ClaimRef};
use crate::error::{FlurboError, Result};
use crate::policy::{effective_policy, EffectivePolicy, FlurboPolicy, LocalPolicy, Policy};
use crate::protocol::Deployment;
use crate::research::{PromptEvent, Provenance};
use crate::signer::{LocalKeySigner, Signer};
use crate::strategy::{self, candidate_claims, JointForecast, Quote, StrategyConfig, StrategyMarket};
use crate::transaction::Claim;

pub type QuoteFn<'a> = dyn Fn(&[(u32, u32)], i128) -> HashMap<String, Quote> + 'a;

/// What a strategy sees: the market, a validated forecast and a quote function that reads the pool contract
/// at one pinned block. It returns a decision; it never builds, signs or sends a transaction.
pub struct StrategyContext<'a> {
    pub market: &'a StrategyMarket,
    pub forecast: &'a JointForecast,
    pub now: i64,
    pub quote: &'a QuoteFn<'a>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrategyProposal {
    pub scope: u32,
    pub mask: u32,
    pub quantity_atoms: i128,
    pub quote_atoms: i128,
    pub slippage_bps: i128,
    pub edge_atoms: Option<i128>,
    pub edge_bps: Option<i128>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrategyDecision {
    /// "propose" or "abstain"
    pub outcome: String,
    pub reasons: Vec<String>,
    pub explanation: String,
    pub proposal: Option<StrategyProposal>,
}

impl StrategyDecision {
    pub fn abstain(reason: &str, explanation: &str) -> Self {
        StrategyDecision { outcome: "abstain".into(), reasons: vec![reason.into()], explanation: explanation.into(), proposal: None }
    }
}

/// Any strategy: the reference joint-edge or your own.
pub trait Strategy: Send + Sync {
    fn id(&self) -> String;
    fn version(&self) -> String;
    fn decide(&self, ctx: &StrategyContext) -> Result<StrategyDecision>;
}

/// The reference strategy.
pub struct JointEdgeStrategy {
    pub config: StrategyConfig,
}

impl JointEdgeStrategy {
    pub fn from_config(c: &AgentConfig) -> Self {
        let n = |s: &str| s.parse::<i128>().unwrap_or(0);
        JointEdgeStrategy {
            config: StrategyConfig {
                quantity_atoms: n(&c.strategy.quantity_atoms),
                slippage_bps: c.strategy.slippage_bps as i128,
                min_edge_bps: c.strategy.min_edge_bps as i128,
                min_edge_atoms: n(&c.strategy.min_edge_atoms),
                max_cost_atoms: n(&c.strategy.max_cost_atoms),
                min_evidence: c.strategy.min_evidence,
                include_singles: c.strategy.include_singles,
            },
        }
    }
}

impl Strategy for JointEdgeStrategy {
    fn id(&self) -> String {
        strategy::STRATEGY_ID.into()
    }
    fn version(&self) -> String {
        strategy::STRATEGY_VERSION.into()
    }
    fn decide(&self, ctx: &StrategyContext) -> Result<StrategyDecision> {
        let (m, f) = (ctx.market, ctx.forecast);
        let claims = candidate_claims(&m.pool, m.event_count, &f.events, self.config.include_singles);
        let quotes = (ctx.quote)(&claims, self.config.quantity_atoms);
        let d = strategy::decide(m, f, &self.config, ctx.now, &quotes);
        let explanation = match &d.proposal {
            None => "No covered claim clears the edge threshold after the quoted cost and slippage allowance.".to_string(),
            Some(p) => format!(
                "Forecast {}.{}% that the claim pays; quoted cost {} atoms, at most {} with slippage; estimated edge {} atoms before gas.",
                (p.forecast_ppm + 500) / 10_000,
                (p.forecast_ppm + 500) % 10_000 / 1_000,
                p.quote_atoms,
                p.worst_cost_atoms,
                p.edge_atoms
            ),
        };
        Ok(StrategyDecision {
            outcome: d.outcome.into(),
            reasons: d.reasons.iter().map(|r| r.to_string()).collect(),
            explanation,
            proposal: d.proposal.map(|p| StrategyProposal {
                scope: p.scope,
                mask: p.mask,
                quantity_atoms: p.quantity_atoms,
                quote_atoms: p.quote_atoms,
                slippage_bps: p.slippage_bps,
                edge_atoms: Some(p.edge_atoms),
                edge_bps: Some(p.edge_bps),
            }),
        })
    }
}

type LogFn = dyn Fn(&str, Value) + Send + Sync;
type ClockFn = dyn Fn() -> i64 + Send + Sync;

/// Runner state the executor consults: Flurbo's policy, the stop request and any stop code from Flurbo.
pub struct Shared {
    pub config: AgentConfig,
    pub stop_file: PathBuf,
    /// Set only for the final heartbeat when a run ends, so Flurbo shows the runtime as stopped.
    pub stopped: std::sync::atomic::AtomicBool,
    pub flurbo: Mutex<Option<(FlurboPolicy, i64)>>,
    pub blocked_by: Mutex<Option<String>>,
    pub last_error: Mutex<Option<String>>,
    log: Box<LogFn>,
    clock: Box<ClockFn>,
}

impl Shared {
    pub fn effective(&self) -> EffectivePolicy {
        let local = LocalPolicy { mode: self.config.mode.clone(), max_trade_cost_atoms: self.config.policy.max_trade_cost_atoms, spend: self.config.policy.spend.clone() };
        let f = self.flurbo.lock().unwrap().clone();
        effective_policy(&local, f.as_ref().map(|x| &x.0), f.as_ref().map(|x| x.1), self.now(), self.config.policy_max_age_seconds)
    }
    pub fn paused(&self) -> bool {
        self.flurbo.lock().unwrap().as_ref().is_some_and(|f| f.0.paused)
    }
    pub fn blocked(&self) -> Option<String> {
        self.blocked_by.lock().unwrap().clone()
    }
}

impl Controls for Shared {
    fn policy(&self) -> Policy {
        let e = self.effective();
        let mut p = self.config.policy.clone();
        p.max_trade_cost_atoms = e.max_trade_cost_atoms;
        p.spend.windows = e.windows;
        p
    }
    fn live_allowed(&self) -> (bool, Option<String>) {
        if let Some(b) = self.blocked() {
            return (false, Some(b));
        }
        if self.stop_file.exists() {
            return (false, Some("stop_requested".into()));
        }
        let e = self.effective();
        (e.live_allowed, e.reason)
    }
    fn now(&self) -> i64 {
        (self.clock)()
    }
    fn log(&self, event: &str, detail: Value) {
        (self.log)(event, detail)
    }
    fn stop(&self, code: &str) {
        let mut b = self.blocked_by.lock().unwrap();
        if b.is_none() {
            (self.log)("stopped_new_actions", json!({"code": code}));
        }
        *b = Some(code.into());
    }
}

/// Paper trades: priced at the quote at the decision's block, no market impact, strictly newer block per
/// claim, and a paper budget. No signer is involved.
pub struct PaperBook {
    pub file: PathBuf,
    budget: i128,
}

impl PaperBook {
    pub fn read(&self) -> Vec<Value> {
        fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["fills"].as_array().cloned()).unwrap_or_default()
    }

    fn fill(&self, journal: &FileJournal, record: Value) -> Result<std::result::Result<Value, &'static str>> {
        journal.with_lock(|| {
            let fills = self.read();
            let n = |v: &Value| v.as_str().and_then(|s| s.parse::<i128>().ok()).unwrap_or(0);
            if fills.iter().any(|x| x["decisionId"] == record["decisionId"]) {
                return Ok(Err("already_filled"));
            }
            if fills.iter().any(|x| x["claim"] == record["claim"] && x["namespace"] == record["namespace"] && n(&x["snapshotBlock"]) >= n(&record["snapshotBlock"])) {
                return Ok(Err("same_quote_block"));
            }
            if fills.iter().map(|x| n(&x["costAtoms"])).sum::<i128>() + n(&record["costAtoms"]) > self.budget {
                return Ok(Err("paper_budget"));
            }
            let mut saved = json!({"id": uuid4()});
            saved.as_object_mut().unwrap().extend(record.as_object().unwrap().clone());
            let mut all = fills;
            all.push(saved.clone());
            let doc = json!({"schema": "flurbo.agent-paper.v1", "model": "quote-at-snapshot-no-impact-v1", "fills": all});
            fs::write(&self.file, serde_json::to_string_pretty(&doc).unwrap()).map_err(|_| FlurboError::new("io", "The paper book could not be written."))?;
            Ok(Ok(saved))
        })
    }
}

/// Everything a runner can be given instead of building it from the configuration.
#[derive(Default)]
pub struct RunnerOptions {
    pub env: Option<HashMap<String, String>>,
    pub client: Option<Arc<RuntimeClient>>,
    pub chain: Option<Arc<ChainReader>>,
    pub signer: Option<Arc<dyn Signer>>,
    pub retriever: Option<Box<dyn Retriever>>,
    pub forecaster: Option<Box<dyn Forecaster>>,
    pub strategy: Option<Box<dyn Strategy>>,
    pub log: Option<Box<LogFn>>,
    pub now: Option<Box<ClockFn>>,
}

pub struct AgentRunner {
    pub config: AgentConfig,
    pub dir: PathBuf,
    pub shared: Arc<Shared>,
    pub client: Option<Arc<RuntimeClient>>,
    pub chain: Arc<ChainReader>,
    pub signer: Option<Arc<dyn Signer>>,
    pub journal: Arc<FileJournal>,
    pub paper: PaperBook,
    pub researcher: Researcher,
    pub strategy: Box<dyn Strategy>,
    pub executor: Option<Executor>,
    pub runtime_id: String,
    pub started_at: i64,
    saved: Value,
    verified: HashSet<String>,
    last_cycle_at: Option<i64>,
    runtime_file: PathBuf,
    outbox_file: PathBuf,
}

fn default_log(event: &str, detail: Value) {
    let mut line = json!({"at": crate::time::iso(crate::time::now_seconds()), "event": event});
    if let Value::Object(m) = detail {
        line.as_object_mut().unwrap().extend(m);
    }
    println!("{}", line);
}

fn forecaster_from(config: &AgentConfig, dir: &Path, env: &dyn Fn(&str) -> Option<String>) -> std::result::Result<Box<dyn Forecaster>, FlurboError> {
    let timeout = |ms: Option<u64>| Duration::from_millis(ms.unwrap_or(60_000));
    match &config.research.provider {
        ProviderConfig::OpenaiCompatible { base_url, model, api_key_env, timeout_ms, max_retries } => {
            let key = api_key_env.as_deref().and_then(env);
            Ok(Box::new(OpenAiCompatible::new(base_url, model, key, timeout(*timeout_ms), max_retries.unwrap_or(2))?))
        }
        ProviderConfig::Anthropic { model, api_key_env, timeout_ms, max_retries } => Ok(Box::new(AnthropicMessages::new(model, env(api_key_env), timeout(*timeout_ms), max_retries.unwrap_or(2))?)),
        ProviderConfig::Fixture { reply_file } => {
            let path = dir.join("..").join(reply_file);
            let name = format!("fixture:{}", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            Ok(Box::new(FixtureForecaster {
                name,
                reply: Box::new(move |_| fs::read_to_string(&path).map_err(|_| FlurboError::new("provider_unavailable", "The fixture reply file could not be read."))),
            }))
        }
        ProviderConfig::None => Err(FlurboError::new("provider_not_configured", "No research provider is configured. Set research.provider in the configuration.")),
    }
}

impl AgentRunner {
    pub fn new(config: AgentConfig, options: RunnerOptions) -> Result<Self> {
        let RunnerOptions { env, client, chain, signer, retriever, forecaster, strategy, log, now } = options;
        let lookup = move |k: &str| -> Option<String> {
            match &env {
                Some(m) => m.get(k).cloned(),
                None => std::env::var(k).ok(),
            }
            .filter(|v| !v.trim().is_empty())
        };
        let dir = PathBuf::from(&config.state_dir);
        fs::create_dir_all(&dir).map_err(|_| FlurboError::new("io", "The state directory could not be created."))?;
        let runtime_file = dir.join("runtime.json");
        let saved: Value = fs::read_to_string(&runtime_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
        let runtime_id = saved["runtimeId"].as_str().map(String::from).unwrap_or_else(|| format!("rt-{}", uuid4()));
        let clock: Box<ClockFn> = now.unwrap_or_else(|| Box::new(crate::time::now_seconds));
        let started_at = clock();
        let client = match client {
            Some(c) => Some(c),
            None => lookup(&config.api.credential_env).map(|t| RuntimeClient::new(&config.api.base_url, t.trim())).transpose()?.map(Arc::new),
        };
        let chain = match chain {
            Some(c) => c,
            None => Arc::new(ChainReader::new(Box::new(JsonRpc::new(&config.chain.rpc_url, Duration::from_secs(15))?))),
        };
        // Paper mode never constructs a signer.
        let signer: Option<Arc<dyn Signer>> = if config.mode == "live" {
            Some(match signer {
                Some(s) => s,
                None => {
                    let key = lookup(&config.signer.key_env).ok_or_else(|| {
                        FlurboError::invalid(format!("Set {} to the dedicated agent wallet key (testnet only). Never use a deployer, settlement, reviewer or personal wallet.", config.signer.key_env))
                    })?;
                    Arc::new(LocalKeySigner::new(key.trim())?)
                }
            })
        } else {
            None
        };
        let journal_wallet = signer.as_ref().map(|s| s.address()).unwrap_or_else(|| format!("0x{}", "00".repeat(20)));
        let journal = Arc::new(FileJournal::new(&dir, &journal_wallet)?);
        let forecaster = match forecaster {
            Some(f) => Ok(f),
            None => forecaster_from(&config, &dir, &lookup),
        };
        let r = &config.research;
        let retriever = retriever.unwrap_or_else(|| Box::new(HttpRetriever::new(&r.retriever.allow_hosts, r.retriever.allow_local_http.unwrap_or(false))));
        let researcher = Researcher::new(retriever, forecaster, r.max_evidence_age_days * 86_400, r.per_cycle, r.per_hour);
        let strategy = strategy.unwrap_or_else(|| Box::new(JointEdgeStrategy::from_config(&config)));
        let shared = Arc::new(Shared {
            config: config.clone(),
            stop_file: dir.join("stop.request"),
            stopped: std::sync::atomic::AtomicBool::new(false),
            flurbo: Mutex::new(None),
            blocked_by: Mutex::new(None),
            last_error: Mutex::new(None),
            log: log.unwrap_or_else(|| Box::new(default_log)),
            clock,
        });
        let executor =
            signer.as_ref().map(|s| Executor::new(chain.clone(), s.clone(), journal.clone(), client.clone(), shared.clone() as Arc<dyn Controls>, Duration::from_secs(config.schedule.wait_seconds)));
        Ok(AgentRunner {
            paper: PaperBook { file: dir.join("paper.json"), budget: config.paper_budget_atoms.parse().unwrap_or(0) },
            outbox_file: dir.join("outbox.json"),
            runtime_file,
            config,
            dir,
            shared,
            client,
            chain,
            signer,
            journal,
            researcher,
            strategy,
            executor,
            runtime_id,
            started_at,
            saved,
            verified: HashSet::new(),
            last_cycle_at: None,
        })
    }

    fn now(&self) -> i64 {
        self.shared.now()
    }

    fn log(&self, event: &str, detail: Value) {
        self.shared.log(event, detail)
    }

    pub fn wallet(&self) -> String {
        self.signer.as_ref().map(|s| s.address()).unwrap_or_else(|| "paper".into())
    }

    pub fn blocked_by(&self) -> Option<String> {
        self.shared.blocked()
    }

    fn stop_requested(&self) -> bool {
        self.shared.stop_file.exists()
    }

    pub fn state(&self) -> &'static str {
        if self.shared.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            "stopped"
        } else if self.stop_requested() {
            "stopping"
        } else if self.blocked_by().is_some() {
            "blocked"
        } else if self.shared.paused() {
            "paused"
        } else {
            "running"
        }
    }

    /// Calls the Flurbo API; failures are recorded and a stop code blocks new actions.
    fn api<T>(&self, f: impl FnOnce(&RuntimeClient) -> Result<T>) -> Option<T> {
        let client = self.client.as_ref()?;
        match f(client) {
            Ok(v) => Some(v),
            Err(e) => {
                *self.shared.last_error.lock().unwrap() = Some(e.api_code.clone().unwrap_or(e.code.clone()));
                if is_stop(&e) {
                    self.shared.stop(e.api_code.as_deref().unwrap_or(""));
                }
                None
            }
        }
    }

    fn accept(&self, p: &Value) {
        let parsed = serde_json::from_value::<FlurboPolicy>(json!({"version": p["version"], "paused": p["paused"], "liveEnabled": p["liveEnabled"], "limits": p["limits"]}));
        if let Ok(f) = parsed {
            *self.shared.flurbo.lock().unwrap() = Some((f, self.now()));
        }
    }

    pub fn refresh_policy(&self) {
        if let Some(p) = self.api(|c| c.policy()) {
            self.accept(&p);
        }
    }

    pub fn heartbeat(&self) {
        let pending = self.journal.read().map(|j| j.entries.iter().filter(|e| !e.is_final()).count()).unwrap_or(0);
        let policy = self.shared.policy();
        let hashed = json!({"mode": self.config.mode, "policy": policy, "strategy": self.config.strategy}).to_string();
        let policy_hash: String = k256::sha2::Sha256::digest(hashed.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect();
        let flurbo_version = self.shared.flurbo.lock().unwrap().as_ref().map(|f| f.0.version);
        let beat = json!({
            "runtimeId": self.runtime_id, "sdk": {"language": SDK_LANGUAGE, "version": SDK_VERSION}, "mode": self.config.mode, "state": self.state(),
            "policy": {"hash": policy_hash, "flurboVersion": flurbo_version, "summary": {"maxTradeCostAtoms": policy.max_trade_cost_atoms.to_string(),
                "windows": policy.spend.windows, "totalAtoms": policy.spend.total_atoms.to_string(), "maxPending": policy.max_pending}},
            "pending": pending, "startedAt": self.started_at, "lastCycleAt": self.last_cycle_at, "lastErrorCode": *self.shared.last_error.lock().unwrap(),
        });
        if let Some(r) = self.api(|c| c.heartbeat(beat)) {
            self.accept(&r);
        }
    }

    /// Decisions are reported as self-reported records; failed reports wait in a local outbox.
    fn report_decision(&self, decision: Value) {
        let mut outbox: Vec<Value> = fs::read_to_string(&self.outbox_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        outbox.push(decision);
        let mut remaining: Vec<Value> = Vec::new();
        for item in outbox {
            if remaining.is_empty() && self.api(|c| c.decision(item.clone())).is_some() {
                continue;
            }
            remaining.push(item);
        }
        let keep = remaining.len().saturating_sub(200);
        let _ = fs::write(&self.outbox_file, Value::Array(remaining[keep..].to_vec()).to_string());
    }

    fn market_cycle(&mut self, d: &Deployment) -> Result<()> {
        let key = format!("{}{}", d.namespace, d.code_hashes.pool);
        if !self.verified.contains(&key) {
            self.chain.verify_deployment(d)?;
            self.verified.insert(key);
        }
        let Some(detail) = self.api(|c| c.market(&d.namespace)) else { return Ok(()) };
        let (head, resolved) = (self.chain.block(None)?, self.chain.resolved(&d.pool)?);
        let market = StrategyMarket {
            pool: d.pool.clone(),
            event_count: d.event_count,
            open: !resolved && head.timestamp < d.closes_at as i64,
            resolved,
            closes_at: d.closes_at as i64,
            snapshot_block_hash: head.hash.clone(),
        };
        if !market.open {
            self.log("market_closed", json!({"namespace": d.namespace}));
            return Ok(());
        }
        if d.closes_at as i64 - self.now() < self.config.policy.min_seconds_before_close {
            self.log("too_close_to_close", json!({"namespace": d.namespace}));
            return Ok(());
        }
        let listed = detail["events"].as_array().cloned().unwrap_or_default();
        let events: Vec<PromptEvent> = listed.iter().filter_map(|e| serde_json::from_value(e.clone()).ok()).collect();
        for a in 0..events.len() {
            for b in a + 1..events.len() {
                if self.blocked_by().is_some() || self.stop_requested() {
                    return Ok(());
                }
                self.decide_pair(d, &detail, &listed, &events, (a, b), &market, &head)?;
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn decide_pair(&mut self, d: &Deployment, detail: &Value, listed: &[Value], events: &[PromptEvent], pair: (usize, usize), market: &StrategyMarket, head: &Block) -> Result<()> {
        let (a, b) = pair;
        let (ia, ib) = (events[a].index, events[b].index);
        let decision_id = format!("d-{}", uuid4());
        let mut sources: Vec<Source> = listed
            .iter()
            .filter(|e| e["index"].as_u64().is_some_and(|i| i as u32 == ia || i as u32 == ib))
            .filter_map(|e| e["source"]["referenceUrl"].as_str().map(|u| Source { event: e["index"].as_u64().unwrap() as u32, url: u.into() }))
            .collect();
        if let Some(extra) = self.config.research.retriever.extra_sources.as_ref().and_then(|m| m.get(&d.namespace)) {
            sources.extend(extra.iter().filter(|s| s.event == ia || s.event == ib).cloned());
        }
        let base = json!({"schema": "flurbo.agent-runtime-decision.v1", "decisionId": decision_id, "namespace": d.namespace, "createdAt": self.now()});
        let with = |extra: Value| {
            let mut v = base.clone();
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let title = detail["title"].as_str().unwrap_or("");
        let requirements = self.config.research.evidence_requirements.get(&d.namespace).map(Vec::as_slice).unwrap_or(&[]);
        let found = self.researcher.research_with_requirements(&d.pool, title, &[events[a].clone(), events[b].clone()], &sources, self.now(), d.event_count, requirements);
        let (output, fresh, forecast_doc, provenance) = match found {
            Research::Abstain { reason, detail, provenance, .. } => {
                let p = provenance.unwrap_or(Provenance { kind: "custom".into(), name: "unconfigured".into() });
                self.log("research_abstained", json!({"namespace": d.namespace, "events": [ia, ib], "reason": reason}));
                self.report_decision(with(json!({"outcome": "abstain", "reasons": [reason], "provenance": p, "summary": crate::research::js_slice(&detail, 600)})));
                return Ok(());
            }
            Research::Ok { output, fresh_evidence, forecast, provenance, .. } => (output, fresh_evidence, forecast, provenance),
        };
        let provenance = if ["model", "fixture", "custom"].contains(&provenance.kind.as_str()) { provenance } else { Provenance { kind: "custom".into(), name: provenance.name } };
        let chain = self.chain.clone();
        let pool = d.pool.clone();
        let quote = move |claims: &[(u32, u32)], quantity: i128| -> HashMap<String, Quote> {
            let mut out = HashMap::new();
            for (scope, mask) in claims {
                if let Ok(Some(amount)) = chain.quote(&pool, "buy", *scope, *mask, quantity.max(0) as u128, head) {
                    if amount > 0 && (amount as i128) <= quantity {
                        out.insert(claim_key(10143, &pool, *scope, *mask), Quote { amount_atoms: amount as i128, expires_at: head.timestamp + 60, block_hash: head.hash.clone() });
                    }
                }
            }
            out
        };
        let forecast = JointForecast { events: output.events.clone(), states_ppm: output.states_ppm.clone(), fresh_evidence: fresh };
        let decision = self.strategy.decide(&StrategyContext { market, forecast: &forecast, now: self.now(), quote: &quote })?;
        let summary = crate::research::js_slice(&decision.explanation, 600);
        let Some(p) = decision.proposal.clone().filter(|_| decision.outcome == "propose") else {
            let reasons = if decision.reasons.is_empty() { vec!["strategy_abstained".to_string()] } else { decision.reasons.clone() };
            self.log("strategy_abstained", json!({"namespace": d.namespace, "events": [ia, ib], "reasons": reasons}));
            self.report_decision(with(json!({"outcome": "abstain", "reasons": reasons, "provenance": provenance, "forecast": forecast_doc, "summary": summary})));
            return Ok(());
        };
        if ![10, 50, 100].contains(&p.slippage_bps) {
            return Err(FlurboError::invalid("The strategy chose an unsupported slippage."));
        }
        let claim = ClaimRef::new(p.scope, p.mask);
        let candidate = json!({"claim": claim, "quantityAtoms": p.quantity_atoms.to_string(), "quoteAtoms": p.quote_atoms.to_string(), "slippageBps": p.slippage_bps as i64,
            "edgeAtoms": p.edge_atoms.map(|e| e.to_string()), "edgeBps": p.edge_bps.map(|e| e as i64), "quoteBlock": head.number.to_string()});
        if self.config.mode == "paper" {
            let response = self.client.as_ref().and_then(|c| c.validate_trade(&d.namespace, p.scope, p.mask, &p.quantity_atoms.to_string()).ok());
            let reason = response.as_ref().map(|r| crate::semantics::semantic_error(r, d, p.scope, p.mask, &p.quantity_atoms.to_string(), self.now())).unwrap_or(Some("SEMANTICS_UNAVAILABLE"));
            if reason.is_none() && response.as_ref().is_some_and(crate::semantics::semantics_disabled) {
                self.log("SEMANTICS_DISABLED", json!({"namespace":d.namespace}));
            }
            if let Some(reason) = reason {
                self.log(reason, json!({"namespace":d.namespace}));
                self.report_decision(with(json!({"outcome":"abstain","reasons":[reason],"provenance":provenance,"forecast":forecast_doc,"candidate":candidate,"summary":"The purchase did not pass outcome compatibility checks."})));
                return Ok(());
            }
            let record = json!({"decisionId": decision_id, "namespace": d.namespace, "claim": claim, "quantityAtoms": p.quantity_atoms.to_string(),
                "costAtoms": p.quote_atoms.to_string(), "snapshotBlock": head.number.to_string(), "filledAt": self.now()});
            let r = self.paper.fill(&self.journal, record)?;
            match &r {
                Ok(_) => self.log("paper_trade", json!({"namespace": d.namespace, "claim": claim})),
                Err(reason) => self.log("paper_skipped", json!({"namespace": d.namespace, "claim": claim, "reason": reason})),
            }
            let (outcome, reasons) = match r {
                Ok(_) => ("paper", vec![]),
                Err(reason) => ("abstain", vec![reason]),
            };
            self.report_decision(with(json!({"outcome": outcome, "reasons": reasons, "provenance": provenance, "forecast": forecast_doc, "candidate": candidate, "summary": summary})));
            return Ok(());
        }
        self.refresh_policy();
        let executor = self.executor.as_ref().ok_or_else(|| FlurboError::invalid("Live mode needs a signer."))?;
        let result = executor.execute(&ExecutionRequest {
            decision_id: decision_id.clone(),
            deployment: d.clone(),
            action: "buy".into(),
            claim: Claim { scope: p.scope, mask: p.mask },
            quantity_atoms: p.quantity_atoms,
            slippage_bps: p.slippage_bps,
            quote_atoms: p.quote_atoms,
            quote_block: head.clone(),
        })?;
        let mut logged = json!({"namespace": d.namespace, "status": result.status});
        if let Some(h) = &result.hash {
            logged["hash"] = json!(h);
        }
        if !result.violations.is_empty() {
            logged["violations"] = json!(result.violations);
        }
        self.log("execution", logged);
        let rejected = result.status == "rejected_by_policy" || result.status == "blocked";
        let reasons: Vec<String> = if !result.violations.is_empty() {
            result.violations.iter().map(|v| v.to_string()).collect()
        } else if result.status == "blocked" {
            vec![result.reason.clone().unwrap_or_default()]
        } else {
            vec![]
        };
        let mut report = with(json!({"outcome": if rejected { "rejected_by_policy" } else { "trade" }, "reasons": reasons, "provenance": provenance, "forecast": forecast_doc,
            "candidate": candidate, "summary": summary}));
        if !result.violations.is_empty() {
            report["violations"] = json!(result.violations);
        }
        if let Some(h) = &result.hash {
            report["execution"] = json!({"hash": h, "status": result.status});
        }
        self.report_decision(report);
        Ok(())
    }

    pub fn cycle(&mut self) {
        self.researcher.reset_cycle();
        self.refresh_policy();
        self.heartbeat();
        if let Some(ex) = &self.executor {
            if let Err(e) = ex.reconcile_all().and_then(|_| ex.report()) {
                self.log("reconcile_failed", json!({"code": e.code}));
            }
        }
        if self.blocked_by().is_none() && !self.stop_requested() && self.client.is_some() {
            let markets = self.config.markets.clone();
            let deployments = self.api(|c| c.deployments()).unwrap_or_default();
            for d in deployments.iter().filter(|x| markets.contains(&x.namespace)) {
                if let Err(e) = self.market_cycle(d) {
                    *self.shared.last_error.lock().unwrap() = Some(e.code.clone());
                    self.log("market_cycle_failed", json!({"namespace": d.namespace, "code": e.code}));
                }
            }
        }
        self.last_cycle_at = Some(self.now());
        let mut saved = if self.saved.is_object() { self.saved.clone() } else { json!({}) };
        let o = saved.as_object_mut().unwrap();
        o.insert("runtimeId".into(), json!(self.runtime_id));
        o.insert("startedAt".into(), json!(self.started_at));
        o.insert("lastCycleAt".into(), json!(self.last_cycle_at));
        o.insert("blockedBy".into(), json!(self.blocked_by()));
        o.insert("lastErrorCode".into(), json!(*self.shared.last_error.lock().unwrap()));
        let _ = fs::write(&self.runtime_file, serde_json::to_string_pretty(&saved).unwrap());
        self.heartbeat();
    }

    /// Reconciles and reports existing transactions only. Never starts a new action.
    pub fn recover(&self) -> Result<Value> {
        self.refresh_policy();
        let Some(ex) = &self.executor else { return Ok(json!({"reconciled": 0, "message": "Paper mode has no transactions to recover."})) };
        let r = ex.reconcile_all()?;
        ex.report()?;
        let open = self.journal.read()?.entries.iter().filter(|e| !e.is_final()).count();
        Ok(json!({"reconciled": r.len(), "open": open}))
    }

    pub fn request_stop(&self) -> Result<()> {
        fs::write(&self.shared.stop_file, self.now().to_string()).map_err(|_| FlurboError::new("io", "The stop request could not be written."))
    }

    pub fn run(&mut self, once: bool) {
        let _ = fs::remove_file(&self.shared.stop_file);
        self.log("started", json!({"runtimeId": self.runtime_id, "mode": self.config.mode, "wallet": self.wallet(), "markets": self.config.markets}));
        let mut last_beat = Instant::now();
        loop {
            self.cycle();
            if once || self.stop_requested() {
                break;
            }
            let until = Instant::now() + Duration::from_secs(self.config.schedule.interval_seconds);
            while Instant::now() < until && !self.stop_requested() {
                sleep(Duration::from_millis(500));
                if last_beat.elapsed() > Duration::from_secs(self.config.schedule.heartbeat_seconds) {
                    self.heartbeat();
                    last_beat = Instant::now();
                }
            }
            if self.stop_requested() {
                break;
            }
        }
        // Every ended run tells Flurbo it stopped, whether it was asked to stop or ran once, so the dashboard
        // never shows a finished runtime as running.
        let _ = fs::remove_file(&self.shared.stop_file);
        self.shared.stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        self.heartbeat();
        self.shared.stopped.store(false, std::sync::atomic::Ordering::SeqCst);
        self.log("stopped", json!({"runtimeId": self.runtime_id}));
    }

    pub fn status(&self) -> Value {
        let entries = if self.dir.join("journal.json").exists() { self.journal.read().map(|j| j.entries).unwrap_or_default() } else { vec![] };
        let pending: Vec<Value> = entries.iter().filter(|e| !e.is_final()).map(|e| json!({"id": e.id, "action": e.action, "status": e.status, "hash": e.hash})).collect();
        let recent: Vec<Value> = entries.iter().rev().take(10).rev().map(|e| json!({"action": e.action, "status": e.status, "hash": e.hash, "costAtoms": e.cost_atoms})).collect();
        let blocked = self.saved.get("blockedBy").filter(|v| !v.is_null()).cloned();
        json!({
            "runtimeId": self.runtime_id, "mode": self.config.mode, "wallet": self.wallet(), "stopRequested": self.stop_requested(),
            "locked": self.dir.join("journal.lock").exists(), "pending": pending, "recent": recent, "paperFills": self.paper.read().len(),
            "lastCycleAt": self.saved.get("lastCycleAt").cloned().unwrap_or(Value::Null),
            "state": if self.stop_requested() { "stopping" } else if blocked.is_some() { "blocked" } else { "ready" },
            "blockedBy": blocked.unwrap_or(Value::Null), "lastErrorCode": self.saved.get("lastErrorCode").cloned().unwrap_or(Value::Null),
        })
    }
}
