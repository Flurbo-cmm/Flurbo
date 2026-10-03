use serde_json::Value;
use crate::protocol::Deployment;
use crate::claims::pays_in;

fn is_digest(v: Option<&str>) -> bool { v.is_some_and(|h| h.len()==64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) }

/// Only meaningful after `semantic_error` returned `None`: checks are switched off, so nothing was verified.
pub fn semantics_disabled(r: &Value) -> bool { r["mode"] == "disabled" }

/// Fresh, claim-bound assessment. A missing service never authorizes a new purchase.
pub fn semantic_error(r: &Value, d: &Deployment, scope: u32, mask: u32, quantity: &str, now: i64) -> Option<&'static str> {
    let unavailable = Some("SEMANTICS_UNAVAILABLE");
    if !(2..=4).contains(&d.event_count) { return unavailable; }
    if r["schema"] != "flurbo.semantic-assessment.v1" || r["pool"] != d.pool || r["rulesHash"] != d.rules_hash || r["scope"].as_u64() != Some(scope as u64)
        || r["mask"].as_str() != Some(mask.to_string().as_str()) || r["quantityAtoms"].as_str() != Some(quantity) { return unavailable; }
    let (Some(checked), Some(expires)) = (r["checkedAt"].as_i64(),r["expiresAt"].as_i64()) else { return unavailable; };
    if checked > now.saturating_add(15) || expires <= now || expires.checked_sub(checked) != Some(60) || !is_digest(r["configRevision"].as_str()) { return unavailable; }
    // A valid, claim-bound "disabled" answer proceeds without semantic assurance; any other mode is unavailable.
    if r["mode"] == "disabled" { return None; }
    let (Some(hash), Some(rows)) = (r["rulesDigest"].as_str(),r["matrix"].as_array()) else { return unavailable; };
    if r["mode"] != "enforced" || !is_digest(Some(hash))
        || rows.len()!=1usize<<d.event_count || !["collision","unknown","no_declared_collision"].contains(&r["status"].as_str().unwrap_or(""))
        || !["unknown","partial","complete"].contains(&r["coverage"].as_str().unwrap_or("")) { return unavailable; }
    if rows.iter().enumerate().any(|(s,row)| row["state"].as_u64()!=Some(s as u64) || row["admissible"].as_bool().is_none() || row["pays"].as_bool()!=Some(pays_in(scope,mask,s as u32)))
        || !rows.iter().any(|r|r["admissible"]==true) { return unavailable; }
    let collision = !rows.iter().any(|r|r["admissible"]==true && r["pays"]==true);
    if collision != (r["status"]=="collision") { return unavailable; }
    if collision { return Some("SEMANTIC_COLLISION"); }
    if scope.count_ones()>1 && (r["coverage"]!="complete" || r["status"]=="unknown") { return Some("SEMANTICS_UNKNOWN"); }
    None
}
