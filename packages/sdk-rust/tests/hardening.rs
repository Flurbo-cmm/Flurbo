//! Hostile RPC and API responses must be refused, never panic or wrap.
use std::collections::HashMap;

use flurbo_sdk::error::Result;
use flurbo_sdk::protocol::{CodeHashes, Deployment};
use flurbo_sdk::runtime::chain::ChainReader;
use flurbo_sdk::runtime::executor::{fee_wei, gas_with_margin, MAX_GAS};
use flurbo_sdk::runtime::rpc::Rpc;
use flurbo_sdk::runtime::runner::listed_events_match;
use flurbo_sdk::signer::{from_hex, keccak_hex};
use flurbo_sdk::time::parse_http_date;
use serde_json::{json, Value};

struct Node(HashMap<&'static str, Value>);

impl Rpc for Node {
    fn call(&self, method: &str, _params: Value) -> Result<Value> {
        Ok(self.0.get(method).cloned().unwrap_or(Value::Null))
    }
}

fn node(pairs: &[(&'static str, Value)]) -> ChainReader {
    ChainReader::new(Box::new(Node(pairs.iter().cloned().collect())))
}

fn deployment() -> Deployment {
    Deployment {
        namespace: "pilot".into(),
        chain_id: 10143,
        pool: format!("0x{}", "1".repeat(40)),
        resolver: format!("0x{}", "2".repeat(40)),
        code_hashes: CodeHashes { pool: format!("0x{}", "a".repeat(64)), resolver: format!("0x{}", "b".repeat(64)) },
        rules_hash: format!("0x{}", "c".repeat(64)),
        closes_at: 1_790_726_400,
        event_count: 2,
    }
}

#[test]
fn hex_with_multibyte_characters_is_rejected() {
    for s in ["0x\u{20ac}0", "0x0\u{e9}", "0x\u{1f600}", "0x\u{e9}\u{e9}"] {
        assert!(from_hex(s).is_err(), "{s}");
        assert!(keccak_hex(s).is_err(), "{s}");
    }
    assert_eq!(from_hex("0xdeAD").unwrap(), vec![0xde, 0xad]);
    assert_eq!(from_hex("0x").unwrap(), Vec::<u8>::new());
    assert!(from_hex("0xzz").is_err());
    assert!(from_hex("0xabc").is_err());
}

#[test]
fn deployment_check_refuses_non_ascii_code() {
    let chain = node(&[
        ("eth_chainId", json!("0x279f")),
        ("eth_getBlockByNumber", json!({"number": "0x10", "hash": format!("0x{}", "d".repeat(64)), "timestamp": "0x6a000000"})),
        ("eth_getCode", json!("0x\u{20ac}0")),
    ]);
    assert!(chain.verify_deployment(&deployment()).is_err());
}

#[test]
fn gas_price_beyond_range_is_refused() {
    assert!(node(&[("eth_gasPrice", json!(format!("0x{:x}", u128::MAX / 100)))]).fees().is_err());
    let fees = node(&[("eth_gasPrice", json!("0xba43b7400")), ("eth_maxPriorityFeePerGas", json!("0x3b9aca00"))]).fees().unwrap();
    assert_eq!(fees.max_fee_per_gas, 60_000_000_000);
    assert_eq!(fees.max_priority_fee_per_gas, 1_000_000_000);
}

#[test]
fn gas_margin_never_wraps_under_the_service_limit() {
    assert_eq!(gas_with_margin(250_000), Some(300_000));
    assert_eq!(gas_with_margin(MAX_GAS * 100 / 120), Some(MAX_GAS));
    assert_eq!(gas_with_margin(MAX_GAS * 100 / 120 + 1), None);
    assert_eq!(gas_with_margin(0), None);
    assert_eq!(gas_with_margin(u128::MAX / 120 * 2 + 3), None);
    assert_eq!(gas_with_margin(u128::MAX), None);
}

#[test]
fn fee_past_the_signed_range_is_none() {
    assert_eq!(fee_wei(300_000, 60_000_000_000), Some(18_000_000_000_000_000));
    assert_eq!(fee_wei(300_000, (1u128 << 127) / 300_000 + 1), None);
    assert_eq!(fee_wei(1, u128::MAX), None);
    assert_eq!(fee_wei(0, u128::MAX), Some(0));
}

#[test]
fn http_dates_outside_the_imf_fixdate_form_are_rejected() {
    assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777));
    assert_eq!(parse_http_date("Fri, 31 Dec 9999 23:59:59 GMT"), Some(253_402_300_799));
    for s in [
        "Sun, 06 Nov 100000000000000000 08:49:37 GMT",
        "Sun, 06 Nov 19940 08:49:37 GMT",
        "Sun, 06 Nov -994 08:49:37 GMT",
        "Sun, 06 Nov 1994 -1:49:37 GMT",
        "Sun, 06 Nov 1994 08:-1:37 GMT",
        "Sun, 06 Nov 1994 08:49:-1 GMT",
    ] {
        assert_eq!(parse_http_date(s), None, "{s}");
    }
}

#[test]
fn market_detail_must_list_exactly_the_deployed_events() {
    let ev = |i: u64| json!({"index": i, "question": "q"});
    assert!(listed_events_match(&[ev(0), ev(1)], 2));
    assert!(!listed_events_match(&[ev(0), ev(1), ev(2)], 2));
    assert!(!listed_events_match(&[ev(0)], 2));
    assert!(!listed_events_match(&[ev(1), ev(0)], 2));
    assert!(!listed_events_match(&[ev(0), json!({"index": "1"})], 2));
    let many: Vec<Value> = (0..5000).map(ev).collect();
    assert!(!listed_events_match(&many, 4));
}
