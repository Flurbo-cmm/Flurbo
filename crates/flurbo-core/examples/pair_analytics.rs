//! Read-only pilot snapshot analytics. No transaction output or network access.
use flurbo_core::factored::{Factor, FactoredLmsr};
use std::io::{self, Read};

fn calculate(input: &str) -> Result<String, String> {
    let mut words = input.split_whitespace();
    let mut next = || {
        words
            .next()
            .ok_or("Missing field")?
            .parse::<u128>()
            .map_err(|_| "Invalid integer")
    };
    if next()? != 1 {
        return Err("Unsupported protocol".into());
    }
    let n = next()?;
    let a = next()?;
    let b = next()?;
    let liquidity = next()?;
    if !(2..=4).contains(&n) || a >= n || b >= n || a == b || liquidity == 0 {
        return Err("Invalid pair or liquidity".into());
    }
    let mut order = Vec::new();
    for _ in 0..n {
        let v = next()?;
        if v >= n {
            return Err("Invalid order".into());
        }
        order.push(v as u8);
    }
    let count = next()?;
    if count > 64 {
        return Err("Too many factors".into());
    }
    let mut factors = Vec::new();
    for _ in 0..count {
        let mask = next()?;
        if mask == 0 || mask >= 1 << n || mask.count_ones() > 3 {
            return Err("Invalid factor scope".into());
        }
        let scope: Vec<u8> = (0..n as u8).filter(|i| mask & (1 << i) != 0).collect();
        let mut values = Vec::new();
        for _ in 0..1 << scope.len() {
            values.push(next()? as f64 / liquidity as f64);
        }
        factors.push(Factor { scope, values });
    }
    if words.next().is_some() {
        return Err("Unexpected fields".into());
    }
    // Common scaling preserves the distribution and avoids unit-dependent b limits.
    let model = FactoredLmsr::new(n as u8, 1.0, factors, order).map_err(|e| format!("{e:?}"))?;
    let p = |e: &[(u8, bool)]| model.probability(e).map_err(|e| format!("{e:?}"));
    let pa = p(&[(a as u8, true)])?;
    let pb = p(&[(b as u8, true)])?;
    let pnb = p(&[(b as u8, false)])?;
    let joint = p(&[(a as u8, true), (b as u8, true)])?;
    let other = p(&[(a as u8, true), (b as u8, false)])?;
    Ok(format!(
        "{{\"a\":{pa:.17e},\"b\":{pb:.17e},\"joint\":{joint:.17e},\"givenYes\":{:.17e},\"givenNo\":{:.17e},\"independent\":{:.17e},\"difference\":{:.17e}}}",
        joint / pb,
        other / pnb,
        pa * pb,
        joint - pa * pb
    ))
}

fn main() {
    let mut input = String::new();
    let result = io::stdin()
        .take(32_769)
        .read_to_string(&mut input)
        .map_err(|_| "Cannot read input".to_string())
        .and_then(|_| {
            if input.len() > 32_768 {
                Err("Input too large".into())
            } else {
                calculate(&input)
            }
        });
    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uniform_and_correlated() {
        assert!(
            calculate("1 4 0 1 100 0 1 2 3 0")
                .unwrap()
                .contains("2.50000000000000000e-1")
        );
        assert_ne!(
            calculate("1 2 0 1 100 0 1 1 3 0 0 0 100").unwrap(),
            calculate("1 2 0 1 100 0 1 0").unwrap()
        );
    }
    #[test]
    fn rejects_bad_snapshot() {
        for input in [
            "",
            "1 2 0 0 100 0 1 0",
            "1 2 0 1 0 0 1 0",
            "1 2 0 1 100 0 0 0",
            "1 2 0 1 100 0 1 0 extra",
            "1 2 0 1 1 0 1 1 3 0 0 0 101",
        ] {
            assert!(calculate(input).is_err(), "{input}");
        }
    }
}
