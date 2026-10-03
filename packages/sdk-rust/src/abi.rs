//! ABI encoding for the protocol's calls: every argument is a static type (protocol/specs/contracts.md).
//!
//! Selectors and event topics are fixed by the protocol and checked against protocol/fixtures/calldata.json.
use crate::error::{FlurboError, Result};
use crate::u256::U256;

pub const SELECTORS: [(&str, &str); 20] = [
    ("buy", "0x3e6b6cde"), ("sell", "0xc39849c5"), ("redeem", "0xdf992423"), ("quoteBuy", "0xa6a83dde"), ("quoteSell", "0xf29d0ba9"),
    ("holdings", "0x90fc2c7b"), ("payoutFraction", "0xf0f54950"), ("closesAt", "0x39a3a99a"), ("eventCount", "0x71be2e4a"), ("collateral", "0xd8dfeb45"),
    ("collateralDecimals", "0xec9c6c30"), ("settlementRulesHash", "0x03a79426"), ("resolved", "0x3f6fa655"), ("resolvedState", "0x1bb51c6a"),
    ("voidMask", "0x91187684"), ("funded", "0xf3a504f2"), ("approve", "0x095ea7b3"), ("allowance", "0xdd62ed3e"), ("balanceOf", "0x70a08231"), ("decimals", "0x313ce567"),
];
pub const TOPIC_TRADED: &str = "0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5";
pub const TOPIC_REDEEMED: &str = "0x3e24bbc5ae535f3f571a815b8ba9fc70c94ad494d812f0210c3da99fad2173ae";

const TRADE: &[&str] = &["uint32", "uint256", "uint128", "uint128", "uint256"];

fn signature(name: &str) -> &'static [&'static str] {
    match name {
        "buy" | "sell" => TRADE,
        "redeem" | "quoteBuy" | "quoteSell" => &["uint32", "uint256", "uint128"],
        "holdings" => &["address", "uint32", "uint256"],
        "payoutFraction" => &["uint32", "uint256"],
        "approve" => &["address", "uint256"],
        "allowance" => &["address", "address"],
        "balanceOf" => &["address"],
        _ => &[],
    }
}

fn bits(kind: &str) -> u32 {
    match kind {
        "uint8" => 8,
        "uint32" => 32,
        "uint128" => 128,
        "address" => 160,
        "bool" => 1,
        _ => 256,
    }
}

pub fn selector(name: &str) -> Option<&'static str> {
    SELECTORS.iter().find(|(n, _)| *n == name).map(|(_, s)| *s)
}

/// One call argument: a number, a canonical decimal string, an address or a boolean.
#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Uint(U256),
    Text(String),
    Bool(bool),
}

impl From<u128> for Arg {
    fn from(v: u128) -> Arg {
        Arg::Uint(U256::from_u128(v))
    }
}
impl From<u64> for Arg {
    fn from(v: u64) -> Arg {
        Arg::Uint(U256::from_u128(v as u128))
    }
}
impl From<u32> for Arg {
    fn from(v: u32) -> Arg {
        Arg::Uint(U256::from_u128(v as u128))
    }
}
impl From<&str> for Arg {
    fn from(v: &str) -> Arg {
        Arg::Text(v.to_string())
    }
}
impl From<String> for Arg {
    fn from(v: String) -> Arg {
        Arg::Text(v)
    }
}

fn bad(message: impl Into<String>) -> FlurboError {
    FlurboError::invalid(message)
}

pub fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|c| c.is_ascii_hexdigit())
}

fn word(kind: &str, value: &Arg) -> Result<String> {
    let n = match (kind, value) {
        ("address", Arg::Text(s)) if is_address(s) => U256::from_hex(s).unwrap(),
        ("address", _) => return Err(bad("Invalid address.")),
        ("bool", Arg::Bool(b)) => U256::from_u128(*b as u128),
        ("bool", _) => return Err(bad("Invalid boolean.")),
        (_, Arg::Uint(n)) => *n,
        (_, Arg::Text(s)) => match U256::from_dec(s) {
            Some(n) => n,
            None if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) && !s.starts_with('0') => return Err(bad(format!("Value out of range for {}.", kind))),
            None => return Err(bad(format!("Invalid {}.", kind))),
        },
        (_, Arg::Bool(_)) => return Err(bad(format!("Invalid {}.", kind))),
    };
    if n.bits() > bits(kind) {
        return Err(bad(format!("Value out of range for {}.", kind)));
    }
    Ok(n.word_hex())
}

pub fn encode_call(name: &str, args: &[Arg]) -> Result<String> {
    let sel = selector(name).ok_or_else(|| bad("Unsupported function."))?;
    let kinds = signature(name);
    if args.len() != kinds.len() {
        return Err(bad(format!("{} takes {} arguments.", name, kinds.len())));
    }
    let mut out = sel.to_string();
    for (k, a) in kinds.iter().zip(args) {
        out.push_str(&word(k, a)?);
    }
    Ok(out)
}

fn lower_hex(data: &str) -> Option<String> {
    let d = data.to_lowercase();
    (d.starts_with("0x") && d[2..].bytes().all(|c| c.is_ascii_hexdigit())).then_some(d)
}

/// Rejects unknown selectors, wrong lengths and non-canonical words.
pub fn decode_call(data: &str) -> Result<(&'static str, Vec<U256>)> {
    let data = lower_hex(data).filter(|d| d.len() >= 10).ok_or_else(|| bad("Invalid calldata."))?;
    let name = SELECTORS.iter().find(|(_, s)| *s == &data[..10]).map(|(n, _)| *n).ok_or_else(|| bad("Unsupported function."))?;
    let kinds = signature(name);
    let body = &data[10..];
    if body.len() != kinds.len() * 64 {
        return Err(bad("Invalid calldata length."));
    }
    let mut args = Vec::new();
    for (i, kind) in kinds.iter().enumerate() {
        let v = U256::from_hex(&body[i * 64..i * 64 + 64]).unwrap();
        if v.bits() > bits(kind) {
            return Err(bad("Non-canonical calldata."));
        }
        args.push(v);
    }
    Ok((name, args))
}

pub fn decode_words(data: &str, count: usize) -> Result<Vec<U256>> {
    let unexpected = || FlurboError::new("invalid_response", "Unexpected contract return data.");
    let d = lower_hex(data).ok_or_else(unexpected)?;
    if d.len() != 2 + count * 64 {
        return Err(unexpected());
    }
    Ok((0..count).map(|i| U256::from_hex(&d[2 + i * 64..2 + i * 64 + 64]).unwrap()).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Log {
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolEvent {
    Traded { address: String, trader: String, scope: u32, mask: U256, is_buy: bool, quantity: u128, collateral_amount: u128 },
    Redeemed { address: String, owner: String, scope: u32, mask: U256, quantity: u128, collateral_amount: u128 },
}

fn is_topic(t: &str) -> bool {
    t.len() == 66 && t.starts_with("0x") && t[2..].bytes().all(|c| c.is_ascii_hexdigit())
}

/// A decoded pool event, or None for any other (or malformed) log.
pub fn decode_pool_log(log: &Log) -> Option<PoolEvent> {
    let topics: Vec<String> = log.topics.iter().map(|t| t.to_lowercase()).collect();
    if topics.len() != 4 || !topics.iter().all(|t| is_topic(t)) {
        return None;
    }
    let who = U256::from_hex(&topics[1])?;
    let scope = U256::from_hex(&topics[2])?;
    let mask = U256::from_hex(&topics[3])?;
    if who.bits() > 160 || scope.bits() > 32 {
        return None;
    }
    let address = log.address.to_lowercase();
    let scope = scope.to_u64()? as u32;
    if topics[0] == TOPIC_TRADED {
        let w = decode_words(&log.data, 3).ok()?;
        if w[0].bits() > 1 || w[1].bits() > 128 || w[2].bits() > 128 {
            return None;
        }
        return Some(PoolEvent::Traded { address, trader: who.address(), scope, mask, is_buy: !w[0].is_zero(), quantity: w[1].to_u128()?, collateral_amount: w[2].to_u128()? });
    }
    if topics[0] == TOPIC_REDEEMED {
        let w = decode_words(&log.data, 2).ok()?;
        if w[0].bits() > 128 || w[1].bits() > 128 {
            return None;
        }
        return Some(PoolEvent::Redeemed { address, owner: who.address(), scope, mask, quantity: w[0].to_u128()?, collateral_amount: w[1].to_u128()? });
    }
    None
}
