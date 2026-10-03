//! Live execution (protocol/specs/transactions.md), in the same crash-safe order as the TypeScript runtime:
//!   plan under the lock (policy check and spend reservation in one step)
//!   re-check permission, assign the nonce and sign under the lock, recording the signed bytes
//!   broadcast outside the lock; a failure or timeout here is "unknown", never "failed"
//!   reconcile from the chain; resend only the identical signed bytes
use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::chain::{Block, ChainReader, Receipt};
use super::headless::{is_stop, RuntimeClient};
use super::journal::{owner, policy_entries, uuid4, FileJournal, JournalEntry, ReceiptFacts, ReportState};
use super::rpc::to_hex;
use crate::amounts::{buy_limit, sell_minimum};
use crate::claims::ClaimRef;
use crate::effects::{verify_effect, EffectIntent};
use crate::error::{FlurboError, Result};
use crate::policy::{evaluate_policy, Candidate, Holding, Policy, PolicyInput, PolicyMarket, PolicyWallet};
use crate::protocol::{Deployment, SERVICE_MAX_ATOMS};
use crate::recovery::{recovery_step, ChainView, RecoveryEntry};
use crate::signer::{transaction_hash, Signer, Tx1559};
use crate::transaction::{build_transaction, validate_transaction, Claim, Intent, UnsignedCall};

pub const MAX_GAS: u128 = 15_000_000;
pub const SDK_LANGUAGE: &str = "rust";
pub const SDK_VERSION: &str = "0.2.0";

/// What the executor asks its runner: the current effective policy, whether live execution is allowed
/// now, the clock, where to log and whom to tell when Flurbo says to stop.
pub trait Controls: Send + Sync {
    fn policy(&self) -> Policy;
    fn live_allowed(&self) -> (bool, Option<String>);
    fn now(&self) -> i64;
    fn log(&self, event: &str, detail: Value);
    fn stop(&self, code: &str);
}

/// Fixed answers, for tests and simple embeddings.
pub struct FixedControls {
    pub policy: Policy,
    pub allowed: bool,
}

impl Controls for FixedControls {
    fn policy(&self) -> Policy {
        self.policy.clone()
    }
    fn live_allowed(&self) -> (bool, Option<String>) {
        (self.allowed, (!self.allowed).then(|| "blocked".to_string()))
    }
    fn now(&self) -> i64 {
        crate::time::now_seconds()
    }
    fn log(&self, _: &str, _: Value) {}
    fn stop(&self, _: &str) {}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Planned {
    Entry(Box<JournalEntry>),
    Rejected(Vec<&'static str>),
    SimulationFailed(String),
}

/// The outcome of one execution request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// confirmed, reverted, mismatch, replaced, expired, abandoned, pending, blocked, rejected_by_policy,
    /// simulation_failed, approval_pending, quote_unavailable or price_moved
    pub status: String,
    pub reason: Option<String>,
    pub violations: Vec<&'static str>,
    pub entry_id: Option<String>,
    pub hash: Option<String>,
    pub cost_atoms: Option<String>,
}

impl Outcome {
    fn of(status: &str, reason: Option<String>) -> Self {
        Outcome { status: status.into(), reason, violations: vec![], entry_id: None, hash: None, cost_atoms: None }
    }
}

/// A buy, sell or redemption chosen by a strategy, before limits and deadlines are derived.
#[derive(Debug, Clone)]
pub struct ExecutionRequest {
    pub decision_id: String,
    pub deployment: Deployment,
    pub action: String,
    pub claim: Claim,
    pub quantity_atoms: i128,
    pub slippage_bps: i128,
    pub quote_atoms: i128,
    pub quote_block: Block,
}

fn report_intent(e: &JournalEntry) -> Value {
    match e.action.as_str() {
        "approve" => json!({"action": "approve", "claim": null, "quantityAtoms": "0", "limitAtoms": e.limit_atoms, "deadline": null}),
        "redeem" => json!({"action": "redeem", "claim": e.claim, "quantityAtoms": e.quantity_atoms, "limitAtoms": "0", "deadline": null}),
        _ => json!({"action": e.action, "claim": e.claim, "quantityAtoms": e.quantity_atoms, "limitAtoms": e.limit_atoms, "deadline": e.deadline}),
    }
}

fn num(s: &str) -> i128 {
    s.parse().unwrap_or(0)
}

fn intent_of(e: &JournalEntry) -> Result<Intent> {
    let claim = || e.claim.as_ref().map(|c| Claim { scope: c.scope, mask: c.mask_u32() }).ok_or_else(|| FlurboError::invalid("The journal entry has no claim."));
    let deadline = || e.deadline.ok_or_else(|| FlurboError::invalid("The journal entry has no deadline."));
    Ok(match e.action.as_str() {
        "approve" => Intent::Approve { amount_atoms: num(&e.limit_atoms) },
        "redeem" => Intent::Redeem { claim: claim()?, quantity_atoms: num(&e.quantity_atoms) },
        "buy" => Intent::Buy { claim: claim()?, quantity_atoms: num(&e.quantity_atoms), limit_atoms: num(&e.limit_atoms), deadline: deadline()? },
        "sell" => Intent::Sell { claim: claim()?, quantity_atoms: num(&e.quantity_atoms), limit_atoms: num(&e.limit_atoms), deadline: deadline()? },
        _ => return Err(FlurboError::invalid("Unknown journal action.")),
    })
}

fn facts(r: &Receipt) -> ReceiptFacts {
    ReceiptFacts { block_number: r.block_number.to_string(), gas_used: r.gas_used.to_string(), effective_gas_price: r.effective_gas_price.map(|p| p.to_string()) }
}

pub struct Executor {
    pub chain: Arc<ChainReader>,
    pub signer: Arc<dyn Signer>,
    pub journal: Arc<FileJournal>,
    pub client: Option<Arc<RuntimeClient>>,
    pub controls: Arc<dyn Controls>,
    pub wait: Duration,
    pub poll: Duration,
    pub wallet: String,
}

impl Executor {
    fn semantic_check(&self, d: &Deployment, scope: u32, mask: u32, quantity: &str) -> Option<&'static str> {
        let response = self.client.as_ref().and_then(|c|c.validate_trade(&d.namespace,scope,mask,quantity).ok());
        let reason = response.as_ref().map(|r|crate::semantics::semantic_error(r,d,scope,mask,quantity,self.controls.now())).unwrap_or(Some("SEMANTICS_UNAVAILABLE"));
        let disabled = reason.is_none() && response.as_ref().is_some_and(crate::semantics::semantics_disabled);
        if let Some(code)=reason.or(if disabled { Some("SEMANTICS_DISABLED") } else { None }) { self.controls.log(code,json!({"namespace":d.namespace,"scope":scope,"mask":mask.to_string()})); }
        reason
    }
    pub fn new(chain: Arc<ChainReader>, signer: Arc<dyn Signer>, journal: Arc<FileJournal>, client: Option<Arc<RuntimeClient>>, controls: Arc<dyn Controls>, wait: Duration) -> Self {
        let wallet = signer.address();
        Executor { chain, signer, journal, client, controls, wait, poll: Duration::from_millis(1000), wallet }
    }

    /// Everything up to and including the policy check and reservation.
    pub fn plan(&self, d: &Deployment, intent: &Intent, decision_id: &str, quote_block: Option<&Block>, slippage_bps: i64) -> Result<Planned> {
        let tx: UnsignedCall = build_transaction(intent, d, &self.wallet)?;
        if self.chain.simulate(&self.wallet, &tx.to, &tx.data).is_err() {
            return Ok(Planned::SimulationFailed("The transaction would revert at the latest block.".into()));
        }
        let Ok(estimate) = self.chain.estimate_gas(&self.wallet, &tx.to, &tx.data) else {
            return Ok(Planned::SimulationFailed("Gas could not be estimated.".into()));
        };
        let gas = estimate * 120 / 100;
        if gas == 0 || gas > MAX_GAS {
            return Ok(Planned::SimulationFailed("Gas is outside the service limit.".into()));
        }
        let (fees, native, head, resolved) = (self.chain.fees()?, self.chain.native_balance(&self.wallet)?, self.chain.block(None)?, self.chain.resolved(&d.pool)?);
        let (policy, snapshot) = (self.controls.policy(), self.journal.read()?);
        let mut claims: Vec<ClaimRef> = Vec::new();
        let mut note = |c: ClaimRef| {
            if !claims.contains(&c) {
                claims.push(c)
            }
        };
        for e in &snapshot.entries {
            if let Some(c) = e.claim.as_ref().filter(|_| e.namespace == d.namespace) {
                note(c.clone());
            }
        }
        if let Some(c) = intent.claim() {
            note(ClaimRef::new(c.scope, c.mask));
        }
        let mut holdings = Vec::new();
        for c in &claims {
            holdings.push(Holding { scope: c.scope, mask: c.mask.clone(), quantity_atoms: self.chain.holdings(&d.pool, &self.wallet, c.scope, c.mask_u32())? as i128 });
        }
        let now = self.controls.now();
        let market = PolicyMarket {
            namespace: d.namespace.clone(),
            pool: d.pool.clone(),
            event_count: d.event_count,
            closes_at: d.closes_at as i64,
            open: !resolved && head.timestamp < d.closes_at as i64,
            resolved,
        };
        self.journal.locked(|j| {
            let fee = (gas * fees.max_fee_per_gas) as i128;
            let violations = match intent {
                Intent::Approve { amount_atoms } => {
                    let mut v = Vec::new();
                    if *amount_atoms < 1 || *amount_atoms > SERVICE_MAX_ATOMS {
                        v.push("SERVICE_LIMIT");
                    }
                    if !policy.markets.contains(&d.namespace) {
                        v.push("MARKET_NOT_ALLOWED");
                    }
                    if fee > policy.gas.max_fee_wei {
                        v.push("GAS_FEE_LIMIT");
                    }
                    if native as i128 - fee < policy.gas.reserve_wei {
                        v.push("GAS_RESERVE");
                    }
                    if j.entries.iter().filter(|e| !e.is_final()).count() >= policy.max_pending {
                        v.push("PENDING_LIMIT");
                    }
                    v
                }
                _ => {
                    let claim = intent.claim().unwrap();
                    let (quantity, limit) = match intent {
                        Intent::Buy { quantity_atoms, limit_atoms, .. } | Intent::Sell { quantity_atoms, limit_atoms, .. } => (*quantity_atoms, *limit_atoms),
                        Intent::Redeem { quantity_atoms, .. } => (*quantity_atoms, 0),
                        Intent::Approve { .. } => unreachable!(),
                    };
                    let input = PolicyInput {
                        policy: policy.clone(),
                        now,
                        market: market.clone(),
                        wallet: PolicyWallet { native_balance_wei: native as i128, holdings: holdings.clone() },
                        journal: policy_entries(j),
                        candidate: Candidate {
                            action: intent.action().into(),
                            namespace: d.namespace.clone(),
                            claim: ClaimRef::new(claim.scope, claim.mask),
                            quantity_atoms: quantity,
                            limit_atoms: limit,
                            slippage_bps,
                            quote_block_timestamp: quote_block.map(|b| b.timestamp).unwrap_or(now),
                            gas_limit: gas as i128,
                            max_fee_per_gas: fees.max_fee_per_gas as i128,
                        },
                    };
                    evaluate_policy(&input).violations
                }
            };
            if !violations.is_empty() {
                return Ok(Planned::Rejected(violations));
            }
            let (quantity, limit, deadline) = match intent {
                Intent::Approve { amount_atoms } => ("0".to_string(), amount_atoms.to_string(), None),
                Intent::Redeem { quantity_atoms, .. } => (quantity_atoms.to_string(), "0".to_string(), None),
                Intent::Buy { quantity_atoms, limit_atoms, deadline, .. } | Intent::Sell { quantity_atoms, limit_atoms, deadline, .. } => {
                    (quantity_atoms.to_string(), limit_atoms.to_string(), Some(*deadline))
                }
            };
            let entry = JournalEntry {
                id: uuid4(),
                action: intent.action().into(),
                namespace: d.namespace.clone(),
                pool: d.pool.clone(),
                claim: intent.claim().map(|c| ClaimRef::new(c.scope, c.mask)),
                quantity_atoms: quantity,
                limit_atoms: limit,
                deadline,
                status: "planned".into(),
                planned_at: now,
                decision_id: Some(decision_id.into()),
                to: tx.to.clone(),
                data: tx.data.clone(),
                gas: Some(gas.to_string()),
                max_fee_per_gas: Some(fees.max_fee_per_gas.to_string()),
                max_priority_fee_per_gas: Some(fees.max_priority_fee_per_gas.to_string()),
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
                extra: Map::new(),
            };
            j.entries.push(entry.clone());
            Ok(Planned::Entry(Box::new(entry)))
        })
    }

    /// Signs a planned entry; None if it is no longer planned or live execution is no longer allowed.
    pub fn sign(&self, entry_id: &str, d: &Deployment) -> Result<Option<JournalEntry>> {
        self.journal.locked(|j| {
            let highest = j.entries.iter().filter(|x| !x.is_final()).filter_map(|x| x.nonce).max();
            let Some(e) = j.entries.iter_mut().find(|x| x.id == entry_id).filter(|x| x.status == "planned") else { return Ok(None) };
            let (allowed, reason) = self.controls.live_allowed();
            if !allowed {
                e.status = "abandoned".into();
                e.final_at = Some(self.controls.now());
                e.note = Some(format!("not signed: {}", reason.unwrap_or_default()));
                return Ok(None);
            }
            if e.action == "buy" {
                let reason = match e.claim.as_ref() { Some(c) => self.semantic_check(d,c.scope,c.mask_u32(),&e.quantity_atoms), None => Some("SEMANTICS_UNAVAILABLE") };
                if let Some(reason)=reason { e.status="abandoned".into(); e.final_at=Some(self.controls.now()); e.note=Some(reason.into()); return Ok(None); }
            }
            let call = UnsignedCall { chain_id: 10143, from: self.wallet.clone(), to: e.to.clone(), data: e.data.clone(), value: 0 };
            validate_transaction(&call, &intent_of(e)?, d, &self.wallet)?;
            let pending = self.chain.nonce(&self.wallet, "pending")?;
            let nonce = highest.map_or(pending, |h| pending.max(h + 1));
            let parse = |s: &Option<String>| s.as_deref().and_then(|v| v.parse::<u128>().ok()).unwrap_or(0);
            let raw = self.signer.sign_transaction(&Tx1559 {
                chain_id: 10143,
                nonce,
                to: e.to.clone(),
                data: e.data.clone(),
                value: 0,
                gas: parse(&e.gas),
                max_fee_per_gas: parse(&e.max_fee_per_gas),
                max_priority_fee_per_gas: parse(&e.max_priority_fee_per_gas),
            })?;
            e.status = "signed".into();
            e.nonce = Some(nonce);
            e.hash = Some(transaction_hash(&raw)?.to_lowercase());
            e.raw_transaction = Some(raw);
            e.signed_at = Some(self.controls.now());
            Ok(Some(e.clone()))
        })
    }

    pub fn broadcast(&self, e: &JournalEntry) -> Result<()> {
        let hash = e.hash.clone().unwrap_or_default();
        if self.chain.send_raw(e.raw_transaction.as_deref().unwrap_or("")).is_err() {
            self.controls.log("broadcast_uncertain", json!({"hash": hash})); // recovery looks the hash up; nothing new is signed
            return Ok(());
        }
        self.journal.locked(|j| {
            if let Some(x) = j.entries.iter_mut().find(|y| y.id == e.id && y.status == "signed") {
                x.status = "broadcast".into();
                x.broadcast_at = Some(self.controls.now());
            }
            Ok(())
        })?;
        self.controls.log("broadcast", json!({"hash": hash}));
        Ok(())
    }

    pub fn reconcile_entry(&self, entry_id: &str) -> Result<Option<JournalEntry>> {
        let Some(e) = self.journal.read()?.entries.into_iter().find(|x| x.id == entry_id) else { return Ok(None) };
        if e.is_final() {
            return Ok(Some(e));
        }
        if e.status == "planned" && self.controls.now() - e.planned_at < 60 && e.owner.pid != std::process::id() {
            return Ok(Some(e)); // a fresh plan of a live process; it re-checks before signing
        }
        let head = self.chain.block(None)?;
        let receipt = match &e.hash {
            Some(h) => self.chain.receipt(h)?,
            None => None,
        };
        let tx_found = receipt.is_some() || match &e.hash {
            Some(h) => self.chain.transaction_found(h)?,
            None => false,
        };
        // A receipt counts once one more block is built on it, the same depth Flurbo's verifier requires.
        let settled = receipt.as_ref().filter(|r| head.number > r.block_number);
        let step = recovery_step(
            &RecoveryEntry { status: e.status.clone(), action: e.action.clone(), nonce: e.nonce, deadline: e.deadline.map(|d| d as i64) },
            &ChainView { tx_found, receipt_status: settled.map(|r| r.status), nonce_latest: self.chain.nonce(&self.wallet, "latest")? },
            head.timestamp,
        );
        let now = self.controls.now();
        let update: Box<dyn Fn(&mut JournalEntry)> = match (step.action.as_str(), settled) {
            ("verify", Some(r)) => {
                let allowance = if e.action == "approve" { Some(self.chain.allowance(&self.wallet, &e.pool, &to_hex(r.block_number as u128))?.to_dec()) } else { None };
                let intent = EffectIntent {
                    action: e.action.clone(),
                    wallet: self.wallet.clone(),
                    pool: e.pool.clone(),
                    claim: e.claim.clone(),
                    quantity_atoms: num(&e.quantity_atoms),
                    limit_atoms: if e.action == "redeem" { 0 } else { num(&e.limit_atoms) },
                };
                let effect = verify_effect(&intent, r.status, &r.logs, allowance.as_deref());
                let f = facts(r);
                Box::new(move |x: &mut JournalEntry| {
                    x.status = effect.status.clone();
                    x.final_at = Some(now);
                    x.cost_atoms = if effect.status == "confirmed" { effect.collateral_atoms.map(|a| a.to_string()) } else { None };
                    x.receipt = Some(f.clone());
                })
            }
            ("release", _) => {
                let (status, f) = (step.status.clone(), receipt.as_ref().map(facts));
                Box::new(move |x: &mut JournalEntry| {
                    x.status = status.clone();
                    x.final_at = Some(now);
                    if f.is_some() {
                        x.receipt = f.clone();
                    }
                })
            }
            ("rebroadcast", _) => {
                if self.chain.send_raw(e.raw_transaction.as_deref().unwrap_or("")).is_ok() {
                    self.controls.log("rebroadcast_same_bytes", json!({"hash": e.hash}));
                }
                return Ok(Some(e));
            }
            ("poll", _) if e.status == "signed" => Box::new(move |x: &mut JournalEntry| {
                x.status = "broadcast".into();
                x.broadcast_at = Some(now);
            }),
            _ => return Ok(Some(e)),
        };
        self.journal.locked(|j| {
            let Some(x) = j.entries.iter_mut().find(|y| y.id == entry_id) else { return Ok(None) };
            if x.status != e.status {
                return Ok(Some(x.clone()));
            }
            update(x);
            Ok(Some(x.clone()))
        })
    }

    pub fn reconcile_all(&self) -> Result<Vec<Option<JournalEntry>>> {
        let open: Vec<String> = self.journal.read()?.entries.iter().filter(|x| !x.is_final()).map(|x| x.id.clone()).collect();
        let mut results = Vec::new();
        for id in open {
            match self.reconcile_entry(&id) {
                Ok(r) => results.push(r),
                Err(err) => self.controls.log("reconcile_failed", json!({"entry": id, "code": err.code})),
            }
        }
        Ok(results)
    }

    /// Reports every transaction that reached the network, idempotently, and records Flurbo's status.
    pub fn report(&self) -> Result<()> {
        let Some(client) = &self.client else { return Ok(()) };
        const FINAL_FLURBO: [&str; 4] = ["confirmed", "reverted", "mismatch", "attributed-elsewhere"];
        for e in self.journal.read()?.entries {
            let landed = e.hash.is_some() && ["broadcast", "confirmed", "reverted", "mismatch"].contains(&e.status.as_str());
            let done = e.report.status == "rejected" || (e.report.status == "accepted" && e.report.flurbo_status.as_deref().is_some_and(|s| FINAL_FLURBO.contains(&s)));
            if !landed || done {
                continue;
            }
            let hash = e.hash.clone().unwrap();
            let r = if e.report.status == "accepted" {
                client.execution(&hash)
            } else {
                client.report_execution(json!({"namespace": e.namespace, "hash": hash, "intent": report_intent(&e), "decisionId": e.decision_id, "nonce": e.nonce,
                    "sdk": {"language": SDK_LANGUAGE, "version": SDK_VERSION}}))
            };
            let mut stop = false;
            let (status, flurbo_status) = match r {
                Ok(v) => ("accepted", v.get("status").and_then(Value::as_str).map(String::from)),
                Err(err) => {
                    stop = is_stop(&err);
                    if stop {
                        self.controls.stop(err.api_code.as_deref().unwrap_or(""));
                    }
                    (if err.api_code.as_deref() == Some("HASH_CONFLICT") { "rejected" } else { "pending" }, err.api_code.clone())
                }
            };
            self.journal.locked(|j| {
                if let Some(x) = j.entries.iter_mut().find(|y| y.id == e.id) {
                    x.report = ReportState { status: status.into(), attempts: x.report.attempts + 1, flurbo_status: flurbo_status.clone() };
                }
                Ok(())
            })?;
            if stop {
                return Ok(());
            }
        }
        Ok(())
    }

    pub fn wait_for(&self, entry_id: &str) -> Result<Option<JournalEntry>> {
        let until = Instant::now() + self.wait;
        loop {
            let e = self.reconcile_entry(entry_id)?;
            if e.as_ref().is_none_or(|x| x.is_final()) || Instant::now() > until {
                return Ok(e);
            }
            sleep(self.poll);
        }
    }

    fn run(&self, d: &Deployment, intent: &Intent, decision_id: &str, quote_block: Option<&Block>, slippage_bps: i64) -> Result<Outcome> {
        let entry = match self.plan(d, intent, decision_id, quote_block, slippage_bps)? {
            Planned::Entry(e) => e,
            Planned::Rejected(v) => return Ok(Outcome { violations: v, ..Outcome::of("rejected_by_policy", None) }),
            Planned::SimulationFailed(detail) => return Ok(Outcome::of("simulation_failed", Some(detail))),
        };
        let Some(signed) = self.sign(&entry.id, d)? else {
            return Ok(Outcome::of("blocked", Some(self.controls.live_allowed().1.unwrap_or_else(|| "not_planned".into()))));
        };
        self.broadcast(&signed)?;
        self.report()?;
        let done = self.wait_for(&signed.id)?;
        self.report()?;
        let status = done.as_ref().filter(|x| x.is_final()).map(|x| x.status.clone()).unwrap_or_else(|| "pending".into());
        Ok(Outcome { entry_id: Some(signed.id), hash: signed.hash, cost_atoms: done.and_then(|x| x.cost_atoms), ..Outcome::of(&status, None) })
    }

    fn precheck(&self, d: &Deployment, claim: Claim, quantity: i128, limit: i128, quote_block: &Block, slippage_bps: i128) -> Result<Vec<&'static str>> {
        let (resolved, head) = (self.chain.resolved(&d.pool)?, self.chain.block(None)?);
        let held = self.chain.holdings(&d.pool, &self.wallet, claim.scope, claim.mask)? as i128;
        let input = PolicyInput {
            policy: self.controls.policy(),
            now: self.controls.now(),
            market: PolicyMarket { namespace: d.namespace.clone(), pool: d.pool.clone(), event_count: d.event_count, closes_at: d.closes_at as i64, open: !resolved && head.timestamp < d.closes_at as i64, resolved },
            wallet: PolicyWallet { native_balance_wei: 0, holdings: vec![Holding { scope: claim.scope, mask: claim.mask.to_string(), quantity_atoms: held }] },
            journal: policy_entries(&self.journal.read()?),
            candidate: Candidate {
                action: "buy".into(),
                namespace: d.namespace.clone(),
                claim: ClaimRef::new(claim.scope, claim.mask),
                quantity_atoms: quantity,
                limit_atoms: limit,
                slippage_bps: slippage_bps as i64,
                quote_block_timestamp: quote_block.timestamp,
                gas_limit: 0,
                max_fee_per_gas: 0,
            },
        };
        Ok(evaluate_policy(&input).violations.into_iter().filter(|v| *v != "GAS_FEE_LIMIT" && *v != "GAS_RESERVE").collect())
    }

    pub fn execute(&self, c: &ExecutionRequest) -> Result<Outcome> {
        let (allowed, reason) = self.controls.live_allowed();
        if !allowed {
            return Ok(Outcome::of("blocked", Some(reason.unwrap_or_else(|| "blocked".into()))));
        }
        let d = &c.deployment;
        let deadline_for = |b: &Block| ((b.timestamp + 300) as u64).min(d.closes_at - 1);
        let slippage = c.slippage_bps as i64;
        match c.action.as_str() {
            "redeem" => return self.run(d, &Intent::Redeem { claim: c.claim, quantity_atoms: c.quantity_atoms }, &c.decision_id, None, 0),
            "sell" => {
                let intent = Intent::Sell { claim: c.claim, quantity_atoms: c.quantity_atoms, limit_atoms: sell_minimum(c.quote_atoms, c.slippage_bps), deadline: deadline_for(&c.quote_block) };
                return self.run(d, &intent, &c.decision_id, Some(&c.quote_block), slippage);
            }
            _ => {}
        }
        if let Some(reason)=self.semantic_check(d,c.claim.scope,c.claim.mask,&c.quantity_atoms.to_string()) { return Ok(Outcome::of("blocked",Some(reason.into()))); }
        let mut limit = buy_limit(c.quote_atoms, c.slippage_bps);
        let mut quote_block = c.quote_block.clone();
        if self.journal.read()?.entries.iter().any(|e| e.action == "approve" && e.pool == d.pool && !e.is_final()) {
            return Ok(Outcome::of("approval_pending", Some("An approval for this pool is still being confirmed.".into())));
        }
        let early = self.precheck(d, c.claim, c.quantity_atoms, limit, &quote_block, c.slippage_bps)?;
        if !early.is_empty() {
            return Ok(Outcome { violations: early, ..Outcome::of("rejected_by_policy", None) });
        }
        if self.chain.allowance(&self.wallet, &d.pool, "latest")?.to_u128().is_some_and(|a| (a as i128) < limit) {
            let approval = self.run(d, &Intent::Approve { amount_atoms: limit }, &c.decision_id, None, 0)?;
            if approval.status != "confirmed" {
                if approval.status == "rejected_by_policy" {
                    return Ok(approval);
                }
                return Ok(Outcome::of("approval_pending", Some(format!("Approval {}; the purchase waits for the next cycle.", approval.status))));
            }
            quote_block = self.chain.block(None)?; // re-quote; a higher cost is never accepted to force the fill
            let Some(again) = self.chain.quote(&d.pool, "buy", c.claim.scope, c.claim.mask, c.quantity_atoms as u128, &quote_block)? else {
                return Ok(Outcome::of("quote_unavailable", Some("The pool no longer quotes this claim at this size.".into())));
            };
            let again_limit = buy_limit(again as i128, c.slippage_bps);
            if again_limit > limit {
                return Ok(Outcome::of("price_moved", Some("The price rose after the approval; the next cycle decides again.".into())));
            }
            limit = again_limit;
        }
        let intent = Intent::Buy { claim: c.claim, quantity_atoms: c.quantity_atoms, limit_atoms: limit, deadline: deadline_for(&quote_block) };
        self.run(d, &intent, &c.decision_id, Some(&quote_block), slippage)
    }
}
