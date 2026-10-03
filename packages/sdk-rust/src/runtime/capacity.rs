//! Process-wide per-origin request caps; no automatic replay of a transaction.
use super::http::url_parts;
use crate::{
    error::{FlurboError, Result},
    time::now_seconds,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
};
#[derive(Default)]
struct Bucket {
    starts: VecDeque<i64>,
    active: usize,
    until: i64,
}
static BUCKETS: OnceLock<Mutex<HashMap<String, Bucket>>> = OnceLock::new();
fn buckets() -> &'static Mutex<HashMap<String, Bucket>> {
    BUCKETS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn busy() -> FlurboError {
    FlurboError::new(
        "rate_limited",
        "Request capacity reached. Retry after the cooldown.",
    )
}
pub struct Permit(String);
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut all) = buckets().lock() {
            if let Some(b) = all.get_mut(&self.0) {
                b.active = b.active.saturating_sub(1);
            }
        }
    }
}
pub fn permit(url: &str) -> Result<Permit> {
    acquire(url, false)
}
pub fn rpc_permit(url: &str) -> Result<Permit> {
    acquire(url, true)
}
fn acquire(url: &str, rpc: bool) -> Result<Permit> {
    let key = format!(
        "{}:{}",
        if rpc { "rpc" } else { "api" },
        url_parts(url).ok_or_else(busy)?.origin
    );
    let mut all = buckets().lock().map_err(|_| busy())?;
    if !all.contains_key(&key) && all.len() >= 64 {
        return Err(busy());
    }
    let b = all.entry(key.clone()).or_default();
    let now = now_seconds();
    while b.starts.front().is_some_and(|t| *t <= now - 60) {
        b.starts.pop_front();
    }
    if b.active >= 4 || b.starts.len() >= (if rpc { 600 } else { 100 }) || now < b.until {
        return Err(busy());
    }
    b.active += 1;
    b.starts.push_back(now);
    Ok(Permit(key))
}
pub fn cooldown(url: &str, value: Option<&str>) {
    set_cooldown(url, value, false);
}
pub fn rpc_cooldown(url: &str, value: Option<&str>) {
    set_cooldown(url, value, true);
}
fn set_cooldown(url: &str, value: Option<&str>, rpc: bool) {
    let Some(p) = url_parts(url) else { return };
    let now = now_seconds();
    let until = value
        .and_then(|v| {
            v.parse::<i64>()
                .ok()
                .map(|s| now.saturating_add(s.max(1)))
                .or_else(|| crate::time::parse_http_date(v))
        })
        .unwrap_or(now + 60)
        .max(now + 1);
    if let Ok(mut all) = buckets().lock() {
        if let Some(b) = all.get_mut(&format!("{}:{}", if rpc { "rpc" } else { "api" }, p.origin)) {
            b.until = b.until.max(until);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrency_and_cooldown_shared_across_clients() {
        let u = "https://capacity-unit.invalid";
        let holds: Vec<_> = (0..4).map(|_| permit(u).unwrap()).collect();
        assert!(permit(u).is_err());
        drop(holds);
        let p = permit(u).unwrap();
        cooldown(u, Some("60"));
        drop(p);
        assert!(permit(u).is_err());
    }
    #[test]
    fn rolling_budget() {
        let u = "https://capacity-count.invalid";
        for _ in 0..100 {
            drop(permit(u).unwrap());
        }
        assert!(permit(u).is_err());
    }
}
