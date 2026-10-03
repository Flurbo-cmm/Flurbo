//! JSON-RPC to the operator's own chain endpoint. Provider error text can contain endpoint details or keys,
//! so it is never surfaced: callers get a kind and a safe message.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use super::http::{agent, is_loopback, is_timeout, url_parts};
use crate::error::{FlurboError, Result};

pub trait Rpc: Send + Sync {
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}

pub fn rpc_error(kind: &str, message: String) -> FlurboError {
    let mut e = FlurboError::new(if kind == "timeout" { "timeout" } else { "network" }, message);
    e.rpc_kind = Some(kind.into());
    e
}

pub struct JsonRpc {
    url: String,
    agent: ureq::Agent,
    ids: AtomicU64,
}

impl JsonRpc {
    pub fn new(url: &str, timeout: Duration) -> Result<Self> {
        let p = url_parts(url).ok_or_else(|| FlurboError::invalid("The RPC URL must use HTTP or HTTPS."))?;
        if p.scheme != "http" && p.scheme != "https" {
            return Err(FlurboError::invalid("The RPC URL must use HTTP or HTTPS."));
        }
        if p.scheme == "http" && !is_loopback(&p.host) {
            return Err(FlurboError::invalid("Plain HTTP is only allowed for a local chain."));
        }
        Ok(JsonRpc { url: url.into(), agent: agent(timeout), ids: AtomicU64::new(1) })
    }
}

impl Rpc for JsonRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let _permit = super::capacity::rpc_permit(&self.url)?;
        let id = self.ids.fetch_add(1, Ordering::Relaxed);
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let response = self.agent.post(&self.url).set("Content-Type", "application/json").send_string(&request.to_string());
        let text = match response {
            Ok(r) => r.into_string().map_err(|_| rpc_error("unavailable", format!("The chain endpoint failed {}.", method)))?,
            Err(ureq::Error::Status(429, r)) => {super::capacity::rpc_cooldown(&self.url,r.header("Retry-After"));return Err(FlurboError::new("rate_limited","RPC rate limited. Retry after the cooldown."));},
            Err(ureq::Error::Status(_, r)) => r.into_string().map_err(|_| rpc_error("unavailable", format!("The chain endpoint failed {}.", method)))?,
            Err(ureq::Error::Transport(t)) if is_timeout(&t) => return Err(rpc_error("timeout", format!("The chain did not answer {} in time.", method))),
            Err(_) => return Err(rpc_error("unavailable", format!("The chain endpoint could not be reached for {}.", method))),
        };
        let body: Value = serde_json::from_str(&text).map_err(|_| rpc_error("unavailable", format!("The chain endpoint failed {}.", method)))?;
        if body.get("error").is_some_and(|e| !e.is_null()) {
            return Err(rpc_error("rejected", format!("The chain rejected {}.", method)));
        }
        if body.get("id").and_then(Value::as_u64) != Some(id) || body.get("result").is_none() {
            return Err(rpc_error("unavailable", format!("The chain endpoint failed {}.", method)));
        }
        Ok(body["result"].clone())
    }
}

pub fn hex_u128(v: &Value) -> Result<u128> {
    v.as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .and_then(|h| u128::from_str_radix(if h.is_empty() { "0" } else { h }, 16).ok())
        .ok_or_else(|| FlurboError::new("invalid_response", "The chain returned an unexpected number."))
}

pub fn to_hex(n: u128) -> String {
    format!("0x{:x}", n)
}
