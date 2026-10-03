//! Research on the operator's machine (protocol/specs/research.md). Retrieval is explicit and allowlisted;
//! retrieved text is untrusted data; the model has no tools and never sees keys or wallet details; every
//! output is validated; every failure is an abstention with a reason.
use std::collections::HashSet;
use std::fmt;
use std::io::Read;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha3::Digest;

use super::http::{agent, is_loopback, is_timeout, join, url_parts};
use crate::error::{FlurboError, Result};
use crate::research::{
    build_research_prompt_with_requirements, evidence_failure, forecast_from_model_with_requirements, is_citable_evidence, js_slice, projected_evidence_time, validate_model_output, Evidence,
    EvidenceRequirement, ModelOutput, Prompt, PromptEvent, Provenance, Validation, ValidationContext, EVIDENCE_SCHEMA,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub event: u32,
    pub url: String,
}

pub trait Retriever: Send + Sync {
    fn retrieve(&self, sources: &[Source], now: i64) -> Vec<Evidence>;
}

/// reason is one of provider_not_configured, provider_unavailable, rate_limited, timeout, malformed_output.
pub fn provider_error(reason: &str, message: impl Into<String>) -> FlurboError {
    FlurboError::new(reason, message)
}

pub trait Forecaster: Send + Sync {
    /// "model", "fixture" or "custom". A fixture or custom rule is never reported as a model.
    fn kind(&self) -> &str;
    fn name(&self) -> String;
    fn complete(&self, prompt: &Prompt) -> Result<String>;
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_blocks(body: &str, tag: &str) -> String {
    // HTML tag names are ASCII. Preserve byte offsets in non-ASCII source text.
    let lower = body.to_ascii_lowercase();
    let (open, close) = (format!("<{}", tag), format!("</{}>", tag));
    let mut out = String::new();
    let mut at = 0;
    while let Some(start) = lower[at..].find(&open).map(|i| i + at) {
        out.push_str(&body[at..start]);
        match lower[start..].find(&close) {
            Some(end) => {
                out.push(' ');
                at = start + end + close.len();
            }
            None => {
                at = start;
                break;
            }
        }
    }
    out.push_str(&body[at..]);
    out
}

pub fn extract_text(body: &str, content_type: &str) -> String {
    if !content_type.contains("html") {
        return collapse(body);
    }
    let mut text = body.to_string();
    for tag in ["script", "style", "noscript", "svg"] {
        text = strip_blocks(&text, tag);
    }
    let mut out = String::new();
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    for (a, b) in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'")] {
        out = out.replace(a, b);
    }
    collapse(&out)
}

fn title_of(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find('<')? + open_end;
    let t = text[open_end..close].trim();
    (!t.is_empty() && t.chars().count() <= 160).then(|| t.to_string())
}

/// Fetches allowlisted HTTPS pages (by default the source each market publishes for its events).
/// allow_local_http permits plain HTTP to this machine only (local test evidence).
pub struct HttpRetriever {
    allow: HashSet<String>,
    allow_local_http: bool,
    max_bytes: usize,
    max_sources: usize,
    agent: ureq::Agent,
}

impl HttpRetriever {
    pub fn new(allow_hosts: &[String], allow_local_http: bool) -> Self {
        HttpRetriever { allow: allow_hosts.iter().map(|h| h.to_lowercase()).collect(), allow_local_http, max_bytes: 2_000_000, max_sources: 6, agent: agent(Duration::from_secs(10)) }
    }

    fn allowed(&self, url: &str) -> bool {
        let Some(u) = url_parts(url) else { return false };
        !u.has_userinfo && ((u.scheme == "https" && self.allow.contains(&u.host)) || (self.allow_local_http && u.scheme == "http" && u.host != "::1" && is_loopback(&u.host)))
    }

    /// Limit the complete body, not just its excerpt. Oversized sources are unusable.
    pub fn with_max_bytes(mut self, max_bytes: usize) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    fn get(&self, url: &str) -> Option<(ureq::Response, String)> {
        let mut url = url.to_string();
        for _ in 0..4 {
            if !self.allowed(&url) {
                return None;
            }
            let r = self.agent.get(&url).set("Accept", "text/html,application/json,text/plain").call().ok()?;
            if (300..400).contains(&r.status()) {
                url = join(&url, r.header("Location")?); // redirects are followed by hand, re-checking the allowlist
                continue;
            }
            return Some((r, url));
        }
        None
    }
}

impl Retriever for HttpRetriever {
    fn retrieve(&self, sources: &[Source], now: i64) -> Vec<Evidence> {
        let mut out = Vec::new();
        for source in sources.iter().take(self.max_sources) {
            // A failed source is skipped; research abstains if nothing usable remains.
            let Some((r, final_url)) = self.get(&source.url) else { continue };
            let content_type = r.header("Content-Type").unwrap_or("").to_lowercase();
            let textual = content_type.contains("text/") || content_type.contains("application/json") || content_type.contains("application/xhtml");
            if r.status() != 200 || !textual || r.header("Content-Range").is_some() {
                continue;
            }
            let modified = r.header("Last-Modified").map(String::from);
            let mut raw = Vec::new();
            // Read one extra byte to distinguish a complete bounded response from truncation.
            if r.into_reader().take((self.max_bytes as u64).saturating_add(1)).read_to_end(&mut raw).is_err() || raw.is_empty() || raw.len() > self.max_bytes {
                continue;
            }
            let text = String::from_utf8_lossy(&raw).to_string();
            let excerpt = js_slice(&extract_text(&text, &content_type), 4000);
            if excerpt.trim().is_empty() {
                continue;
            }
            let digest = sha2_hex(&raw);
            out.push(Evidence {
                schema: EVIDENCE_SCHEMA.into(),
                id: format!("src-{}", out.len() + 1),
                url: final_url.clone(),
                requested_url: source.url.clone(),
                title: Some(title_of(&text).unwrap_or_else(|| final_url.clone())),
                publisher: url_parts(&final_url).map(|u| u.origin.split("://").nth(1).unwrap_or("").to_string()),
                final_url,
                retrieved_at: now,
                publisher_released_at: None,
                http_last_modified: modified.as_deref().and_then(crate::time::parse_http_date).filter(|t| *t >= 0),
                content_sha256: digest,
                excerpt,
                complete_document: true,
                captured_bytes: raw.len() as u64,
                event_ids: vec![source.event],
            });
        }
        out
    }
}

fn sha2_hex(b: &[u8]) -> String {
    // SHA-256 via the k256 dependency tree (sha2 is re-exported by k256's ecdsa feature).
    let d = k256::sha2::Sha256::digest(b);
    d.iter().map(|x| format!("{:02x}", x)).collect()
}

/// Deterministic evidence for offline tests and examples. Labelled as fixture evidence.
pub struct FixtureRetriever {
    pub records: Vec<Evidence>,
}

impl Retriever for FixtureRetriever {
    fn retrieve(&self, _: &[Source], now: i64) -> Vec<Evidence> {
        self.records.iter().map(|r| Evidence { retrieved_at: now, ..r.clone() }).collect()
    }
}

/// A timeout and bounded retries for transport errors, 429 and 5xx only. Provider error bodies are never
/// surfaced (they can echo keys or prompts).
fn post(agent: &ureq::Agent, url: &str, headers: &[(&str, &str)], body: &Value, max_retries: u32) -> Result<Value> {
    for attempt in 0..=max_retries {
        let mut request = agent.post(url).set("Content-Type", "application/json");
        for (k, v) in headers {
            request = request.set(k, v);
        }
        match request.send_string(&body.to_string()) {
            Ok(r) => {
                let text = r.into_string().map_err(|_| provider_error("provider_unavailable", "The model provider could not be reached."))?;
                return serde_json::from_str(&text).map_err(|_| provider_error("malformed_output", "The model returned no text."));
            }
            Err(ureq::Error::Status(code, r)) => {
                if (code == 429 || code >= 500) && attempt < max_retries {
                    let retry = r.header("Retry-After").and_then(|v| v.parse::<u64>().ok()).unwrap_or(1 << attempt);
                    sleep(Duration::from_secs(retry.min(10)));
                    continue;
                }
                let reason = if code == 429 { "rate_limited" } else { "provider_unavailable" };
                return Err(provider_error(reason, format!("The model provider refused the request (HTTP {}).", code)));
            }
            Err(ureq::Error::Transport(t)) => {
                if attempt < max_retries {
                    sleep(Duration::from_millis(500 << attempt));
                    continue;
                }
                if is_timeout(&t) {
                    return Err(provider_error("timeout", "The model provider did not respond in time."));
                }
                return Err(provider_error("provider_unavailable", "The model provider could not be reached."));
            }
        }
    }
    Err(provider_error("provider_unavailable", "The model provider failed."))
}

/// Any service implementing the OpenAI chat completions API (hosted providers, or a local model server).
pub struct OpenAiCompatible {
    base: String,
    model: String,
    key: Option<String>,
    max_retries: u32,
    agent: ureq::Agent,
    name: String,
}

impl fmt::Debug for OpenAiCompatible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OpenAiCompatible({})", self.name)
    }
}

impl OpenAiCompatible {
    pub fn new(base_url: &str, model: &str, api_key: Option<String>, timeout: Duration, max_retries: u32) -> Result<Self> {
        let u = url_parts(base_url).ok_or_else(|| FlurboError::invalid("Use HTTPS for a remote model provider."))?;
        let local = is_loopback(&u.host);
        if u.scheme != "https" && !local {
            return Err(FlurboError::invalid("Use HTTPS for a remote model provider."));
        }
        if api_key.is_none() && !local {
            return Err(provider_error("provider_not_configured", "No API key configured for the model provider."));
        }
        Ok(OpenAiCompatible {
            base: format!("{}/", base_url.trim_end_matches('/')),
            model: model.into(),
            key: api_key,
            max_retries: max_retries.min(3),
            agent: agent(timeout),
            name: format!("{}/{}", u.host, model),
        })
    }
}

impl Forecaster for OpenAiCompatible {
    fn kind(&self) -> &str {
        "model"
    }
    fn name(&self) -> String {
        self.name.clone()
    }
    fn complete(&self, prompt: &Prompt) -> Result<String> {
        let auth = self.key.as_ref().map(|k| format!("Bearer {}", k));
        let headers: Vec<(&str, &str)> = auth.as_deref().map(|a| vec![("Authorization", a)]).unwrap_or_default();
        let body = json!({"model": self.model, "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": prompt.system}, {"role": "user", "content": prompt.user}]});
        let r = post(&self.agent, &format!("{}chat/completions", self.base), &headers, &body, self.max_retries)?;
        r["choices"][0]["message"]["content"].as_str().map(String::from).ok_or_else(|| provider_error("malformed_output", "The model returned no text."))
    }
}

pub struct AnthropicMessages {
    base: String,
    model: String,
    key: String,
    max_tokens: u32,
    max_retries: u32,
    agent: ureq::Agent,
}

impl fmt::Debug for AnthropicMessages {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AnthropicMessages(anthropic/{})", self.model)
    }
}

impl AnthropicMessages {
    pub fn new(model: &str, api_key: Option<String>, timeout: Duration, max_retries: u32) -> Result<Self> {
        let key = api_key.ok_or_else(|| provider_error("provider_not_configured", "No API key configured for the model provider."))?;
        Ok(AnthropicMessages { base: "https://api.anthropic.com/".into(), model: model.into(), key, max_tokens: 1500, max_retries: max_retries.min(3), agent: agent(timeout) })
    }

    /// Another endpoint with the same wire format (a proxy, or a local test server).
    pub fn with_base_url(mut self, base_url: &str) -> Self {
        self.base = format!("{}/", base_url.trim_end_matches('/'));
        self
    }
}

impl Forecaster for AnthropicMessages {
    fn kind(&self) -> &str {
        "model"
    }
    fn name(&self) -> String {
        format!("anthropic/{}", self.model)
    }
    fn complete(&self, prompt: &Prompt) -> Result<String> {
        let body = json!({"model": self.model, "max_tokens": self.max_tokens, "temperature": 0, "system": prompt.system,
            "messages": [{"role": "user", "content": prompt.user}]});
        let r = post(&self.agent, &format!("{}v1/messages", self.base), &[("x-api-key", &self.key), ("anthropic-version", "2023-06-01")], &body, self.max_retries)?;
        let text: String = r["content"].as_array().map(|a| a.iter().filter(|c| c["type"] == "text").filter_map(|c| c["text"].as_str()).collect()).unwrap_or_default();
        if text.is_empty() {
            return Err(provider_error("malformed_output", "The model returned no text."));
        }
        Ok(text)
    }
}

/// A fixed reply, for offline tests and examples. Always reported as a fixture, never as a model.
pub type ReplyFn = dyn Fn(&Prompt) -> Result<String> + Send + Sync;

pub struct FixtureForecaster {
    pub name: String,
    pub reply: Box<ReplyFn>,
}

impl FixtureForecaster {
    pub fn fixed(reply: &str, name: &str) -> Self {
        let reply = reply.to_string();
        FixtureForecaster { name: name.into(), reply: Box::new(move |_| Ok(reply.clone())) }
    }
}

impl Forecaster for FixtureForecaster {
    fn kind(&self) -> &str {
        "fixture"
    }
    fn name(&self) -> String {
        self.name.clone()
    }
    fn complete(&self, prompt: &Prompt) -> Result<String> {
        (self.reply)(prompt)
    }
}

#[derive(Debug, Clone)]
pub enum Research {
    Ok { output: ModelOutput, fresh_evidence: u32, forecast: Value, evidence: Vec<Evidence>, provenance: Provenance },
    Abstain { reason: String, detail: String, model_reason: Option<String>, evidence: Vec<Evidence>, provenance: Option<Provenance> },
}

/// Request budgets: per cycle (reset by the runner) and per rolling hour, counted in this process.
pub struct Researcher {
    pub retriever: Box<dyn Retriever>,
    /// Err when no provider is configured: every research call then abstains with that reason.
    pub forecaster: std::result::Result<Box<dyn Forecaster>, FlurboError>,
    pub max_age: i64,
    pub per_cycle: u32,
    pub per_hour: usize,
    counts: Mutex<(u32, Vec<i64>)>,
}

impl Researcher {
    pub fn new(retriever: Box<dyn Retriever>, forecaster: std::result::Result<Box<dyn Forecaster>, FlurboError>, max_age: i64, per_cycle: u32, per_hour: usize) -> Self {
        Researcher { retriever, forecaster, max_age, per_cycle, per_hour, counts: Mutex::new((0, vec![])) }
    }

    pub fn reset_cycle(&self) {
        self.counts.lock().unwrap().0 = 0;
    }

    pub fn research(&self, pool: &str, title: &str, events: &[PromptEvent], sources: &[Source], t: i64) -> Research {
        self.research_with_requirements(pool, title, events, sources, t, events.iter().map(|e| e.index + 1).max().unwrap_or(0), &[])
    }

    pub fn research_with_requirements(&self, pool: &str, title: &str, events: &[PromptEvent], sources: &[Source], t: i64, event_count: u32, requirements: &[EvidenceRequirement]) -> Research {
        let f = match &self.forecaster {
            Ok(f) => f,
            Err(e) => return Research::Abstain { reason: e.code.clone(), detail: e.message.clone(), model_reason: None, evidence: vec![], provenance: None },
        };
        let provenance = Provenance { kind: f.kind().into(), name: f.name() };
        {
            let mut c = self.counts.lock().unwrap();
            c.1.retain(|x| *x > t - 3600);
            if c.0 >= self.per_cycle || c.1.len() >= self.per_hour {
                return Research::Abstain {
                    reason: "request_budget_exhausted".into(),
                    detail: "The research request budget is used up.".into(),
                    model_reason: None,
                    evidence: vec![],
                    provenance: Some(provenance),
                };
            }
        }
        let evidence = self.retriever.retrieve(sources, t);
        if evidence.is_empty() {
            return Research::Abstain {
                reason: "no_sources".into(),
                detail: "No evidence could be retrieved from the allowed sources.".into(),
                model_reason: None,
                evidence,
                provenance: Some(provenance),
            };
        }
        let requested: Vec<u32> = events.iter().map(|e| e.index).collect();
        let ctx = ValidationContext { requested_events: &requested, event_count, evidence: &evidence, now: t, max_evidence_age_seconds: self.max_age, evidence_requirements: requirements };
        let usable: Vec<&Evidence> = evidence.iter().filter(|e| is_citable_evidence(e, t, event_count)).collect();
        let failure = if usable.is_empty() { Some("invalid_evidence") } else { evidence_failure(&usable, &ctx) };
        if let Some(reason) = failure {
            return Research::Abstain {
                reason: reason.into(),
                detail: "Retrieved evidence does not satisfy every event's requirements.".into(),
                model_reason: None,
                evidence,
                provenance: Some(provenance),
            };
        }
        {
            let mut c = self.counts.lock().unwrap();
            c.0 += 1;
            c.1.push(t);
        }
        let reply = match f.complete(&build_research_prompt_with_requirements(title, events, &evidence, t, event_count, requirements)) {
            Ok(r) => r,
            Err(e) => return Research::Abstain { reason: e.code.clone(), detail: e.message.clone(), model_reason: None, evidence, provenance: Some(provenance) },
        };
        match validate_model_output(&reply, &ctx) {
            Validation::Abstain { reason, model_reason } => {
                Research::Abstain { reason: reason.into(), detail: format!("The forecast was not used: {}.", reason), model_reason, evidence, provenance: Some(provenance) }
            }
            Validation::Ok(output) => {
                let fresh = output
                    .evidence_ids
                    .iter()
                    .filter(|i| {
                        evidence.iter().any(|e| {
                            &e.id == *i && requested.iter().any(|event| e.event_ids.contains(event)) && projected_evidence_time(e, &requested, requirements).is_some_and(|at| t - at <= self.max_age)
                        })
                    })
                    .count() as u32;
                let forecast = forecast_from_model_with_requirements(&output, pool, &evidence, &provenance, t, requirements);
                Research::Ok { output, fresh_evidence: fresh, forecast, evidence, provenance }
            }
        }
    }
}
