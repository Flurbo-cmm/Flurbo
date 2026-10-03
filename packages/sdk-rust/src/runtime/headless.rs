//! Headless transport for the Flurbo agent runtime API. The credential is sent only in the Authorization
//! header, never in a URL, and never included in errors or logs.
use std::fmt;
use std::time::Duration;

use serde_json::{json, Value};

use super::http::{agent, is_loopback, segment, url_parts};
use crate::error::{FlurboError, Result};
use crate::protocol::{parse_deployment, Deployment, PROTOCOL_HEADER, PROTOCOL_VERSION, RUNTIME_API_BASE, STOP_CODES};

pub fn token_ok(token: &str) -> bool {
    let p: Vec<&str> = token.splitn(3, '_').collect();
    p.len() == 3
        && p[0] == "fla1"
        && p[1].len() == 16
        && p[1].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && p[2].len() == 43
        && p[2].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// Whether an API error means the runtime must stop starting new actions.
pub fn is_stop(e: &FlurboError) -> bool {
    e.api_code.as_deref().is_some_and(|c| STOP_CODES.contains(&c))
}

fn api_error(api_code: &str, message: &str, status: Option<u16>) -> FlurboError {
    let code = match status {
        Some(401) => "unauthenticated",
        Some(403) => "forbidden",
        Some(404) => "not_found",
        Some(409) => "conflict",
        Some(429) => "rate_limited",
        _ => "unavailable",
    };
    let mut e = FlurboError::new(code, message);
    e.status = status;
    e.api_code = Some(api_code.into());
    e
}

pub struct RuntimeClient {
    origin: String,
    token: String,
    agent: ureq::Agent,
}

impl fmt::Debug for RuntimeClient {
    // never print the credential
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RuntimeClient({})", self.origin)
    }
}

impl RuntimeClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        let p = url_parts(base_url).ok_or_else(|| FlurboError::invalid("Use HTTPS for the Flurbo API."))?;
        if p.scheme != "https" && !(p.scheme == "http" && is_loopback(&p.host) && p.host != "::1") {
            return Err(FlurboError::invalid("Use HTTPS for the Flurbo API."));
        }
        if !token_ok(token) {
            return Err(FlurboError::new("unauthenticated", "The agent credential is missing or malformed."));
        }
        Ok(RuntimeClient { origin: p.origin, token: token.into(), agent: agent(Duration::from_secs(20)) })
    }

    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}{}{}", self.origin, RUNTIME_API_BASE, path);
        let _permit = super::capacity::permit(&url)?;
        let request = self.agent.request(method, &url).set("Authorization", &format!("Bearer {}", self.token)).set(PROTOCOL_HEADER, PROTOCOL_VERSION);
        let response = match body {
            Some(b) => request.set("Content-Type", "application/json").send_string(&b.to_string()),
            None => request.call(),
        };
        match response {
            Ok(r) => {
                let text = r.into_string().map_err(|_| api_error("NETWORK", "The Flurbo API could not be reached.", None))?;
                if text.is_empty() {
                    return Ok(Value::Null);
                }
                serde_json::from_str(&text).map_err(|_| api_error("NETWORK", "The Flurbo API could not be reached.", None))
            }
            Err(ureq::Error::Status(status, r)) => {
                if status==429 {super::capacity::cooldown(&url,r.header("Retry-After"));}
                let parsed: Value = r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
                let code = parsed.get("code").and_then(Value::as_str).unwrap_or("UNAVAILABLE");
                let message = parsed.get("error").and_then(Value::as_str).filter(|m| m.len() < 300).unwrap_or("The Flurbo API refused the request.");
                Err(api_error(code, message, Some(status)))
            }
            Err(_) => Err(api_error("NETWORK", "The Flurbo API could not be reached.", None)),
        }
    }

    pub fn session(&self) -> Result<Value> {
        self.call("GET", "/session", None)
    }

    pub fn deployments(&self) -> Result<Vec<Deployment>> {
        let r = self.call("GET", "/deployments", None)?;
        let list = r.get("deployments").and_then(Value::as_array).filter(|_| r["schema"] == "flurbo.agent-deployments.v1");
        let list = list.ok_or_else(|| FlurboError::new("invalid_response", "Unexpected deployments response."))?;
        list.iter().map(parse_deployment).collect()
    }

    pub fn market(&self, namespace: &str) -> Result<Value> {
        self.call("GET", &format!("/markets/{}", segment(namespace)), None)
    }

    pub fn validate_trade(&self, namespace: &str, scope: u32, mask: u32, quantity: &str) -> Result<Value> {
        self.call("POST", &format!("/markets/{}/validate-trade", segment(namespace)), Some(json!({"scope":scope,"mask":mask.to_string(),"quantityAtoms":quantity})))
    }

    pub fn pair_analytics(&self, namespace: &str, a: u32, b: u32) -> Result<Value> {
        self.call("POST", &format!("/markets/{}/pair-analytics", segment(namespace)), Some(json!({"a": a, "b": b})))
    }

    pub fn wallet(&self, namespace: &str, claims: Value) -> Result<Value> {
        self.call("POST", &format!("/markets/{}/wallet", segment(namespace)), Some(json!({"claims": claims})))
    }

    pub fn policy(&self) -> Result<Value> {
        self.call("GET", "/policy", None)
    }

    pub fn heartbeat(&self, beat: Value) -> Result<Value> {
        self.call("POST", "/heartbeat", Some(beat))
    }

    pub fn decision(&self, decision: Value) -> Result<Value> {
        self.call("POST", "/decisions", Some(decision))
    }

    pub fn report_execution(&self, report: Value) -> Result<Value> {
        self.call("POST", "/executions", Some(report))
    }

    pub fn execution(&self, hash: &str) -> Result<Value> {
        self.call("GET", &format!("/executions/{}", segment(hash)), None)
    }
}
