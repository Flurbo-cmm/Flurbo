//! Amounts and probabilities as exact integers (protocol/specs/numbers.md). No floating point.
use crate::error::{FlurboError, Result};

pub const PPM: i128 = 1_000_000;
pub const AUSD_DECIMALS: u32 = 6;

fn bad(label: &str) -> FlurboError {
    FlurboError::invalid(format!("Invalid {}.", label))
}

/// A canonical decimal string of at most 39 digits that fits in uint128.
pub fn parse_atoms(value: &str, label: &str) -> Result<u128> {
    let canonical = !value.is_empty() && value.len() <= 39 && value.bytes().all(|c| c.is_ascii_digit()) && (value == "0" || !value.starts_with('0'));
    if !canonical {
        return Err(bad(label));
    }
    value.parse::<u128>().map_err(|_| bad(label))
}

/// "1.25" with 6 decimals is 1250000. Excess precision is rejected, never rounded.
pub fn parse_decimal(value: &str, decimals: u32) -> Result<i128> {
    let v = value.trim();
    let (whole, fraction) = match v.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (v, None),
    };
    let whole_ok = !whole.is_empty() && whole.len() <= 31 && whole.bytes().all(|c| c.is_ascii_digit()) && (whole == "0" || !whole.starts_with('0'));
    let fraction_ok = fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|c| c.is_ascii_digit()));
    if !whole_ok || !fraction_ok {
        return Err(FlurboError::invalid("Enter a positive decimal amount."));
    }
    let fraction = fraction.unwrap_or("");
    if fraction.len() as u32 > decimals {
        return Err(FlurboError::invalid(format!("At most {} decimal places are supported.", decimals)));
    }
    let padded = format!("{:0<width$}", fraction, width = decimals as usize);
    let frac: i128 = if padded.is_empty() { 0 } else { padded.parse().unwrap() };
    Ok(whole.parse::<i128>().unwrap() * 10i128.pow(decimals) + frac)
}

pub fn percent_to_ppm(text: &str) -> Result<i128> {
    let ppm = parse_decimal(text, 4)?;
    if ppm > PPM {
        return Err(FlurboError::new("invalid_forecast", "Percentages cannot exceed 100."));
    }
    Ok(ppm)
}

pub fn ceil_div(a: i128, b: i128) -> Result<i128> {
    if b <= 0 || a < 0 {
        return Err(FlurboError::invalid("Invalid division."));
    }
    Ok((a + b - 1) / b)
}

/// Division toward zero, as BigInt division in the TypeScript reference (Rust's `/` already truncates).
pub fn trunc_div(a: i128, b: i128) -> i128 {
    a / b
}

/// Floor division for non-negative operands.
pub fn floor_div(a: i128, b: i128) -> i128 {
    a.div_euclid(b)
}

pub fn buy_limit(quote: i128, bps: i128) -> i128 {
    (quote * (10_000 + bps) + 9_999) / 10_000
}

pub fn sell_minimum(quote: i128, bps: i128) -> i128 {
    quote * (10_000 - bps) / 10_000
}

pub fn frechet_bounds(p_a: i128, p_b: i128) -> Result<(i128, i128)> {
    for p in [p_a, p_b] {
        if !(0..=PPM).contains(&p) {
            return Err(FlurboError::new("invalid_forecast", "Probabilities must be between 0% and 100%."));
        }
    }
    Ok(((p_a + p_b - PPM).max(0), p_a.min(p_b)))
}

/// Two events from marginals and their joint. Contradictory input is rejected, never repaired.
pub fn joint_from_pair(a: u32, b: u32, p_a: i128, p_b: i128, p_both: i128) -> Result<(Vec<u32>, Vec<i128>)> {
    if a == b {
        return Err(FlurboError::new("invalid_forecast", "Choose two different events."));
    }
    let (low, high) = frechet_bounds(p_a, p_b)?;
    if p_both < low || p_both > high {
        return Err(FlurboError::new("invalid_forecast", "The chance of both is outside what the two chances allow."));
    }
    let (first, second, p_first, p_second) = if a < b { (a, b, p_a, p_b) } else { (b, a, p_b, p_a) };
    Ok((vec![first, second], vec![PPM - p_first - p_second + p_both, p_first - p_both, p_second - p_both, p_both]))
}
