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
    let protocol = next()?;
    if protocol != 1 && protocol != 2 {
        return Err("Unsupported protocol".into());
    }
    let n = next()?;
    let (a, b) = if protocol == 1 { (next()?, next()?) } else { (0, 1) };
    let liquidity = next()?;
    if !(2..=32).contains(&n) || liquidity == 0 || protocol == 1 && (a >= n || b >= n || a == b) {
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
    let mut given: Vec<(u8, bool)> = Vec::new();
    if protocol == 2 {
        let count = next()?;
        if !(1..=3).contains(&count) {
            return Err("Invalid assumptions".into());
        }
        for _ in 0..count {
            let event = next()?;
            let answer = next()?;
            if event >= n || answer > 1 || given.iter().any(|(known, _)| *known as u128 == event) {
                return Err("Invalid assumptions".into());
            }
            given.push((event as u8, answer == 1));
        }
    }
    if words.next().is_some() {
        return Err("Unexpected fields".into());
    }
    // Common scaling preserves the distribution and avoids unit-dependent b limits.
    let model = FactoredLmsr::new(n as u8, 1.0, factors, order).map_err(|e| format!("{e:?}"))?;
    let p = |e: &[(u8, bool)]| model.probability(e).map_err(|e| format!("{e:?}"));
    if protocol == 2 {
        let all = p(&given)?;
        if !(all > 0.0) {
            return Err("Impossible assumptions".into());
        }
        let mut yes = Vec::new();
        let mut given_yes = Vec::new();
        for event in 0..n as u8 {
            yes.push(format!("{:.17e}", p(&[(event, true)])?));
            let conditional = match given.iter().find(|(known, _)| *known == event) {
                Some((_, answer)) => f64::from(u8::from(*answer)),
                None => {
                    let mut with = given.clone();
                    with.push((event, true));
                    p(&with)? / all
                }
            };
            given_yes.push(format!("{conditional:.17e}"));
        }
        return Ok(format!(
            "{{\"given\":{all:.17e},\"yes\":[{}],\"givenYes\":[{}]}}",
            yes.join(","),
            given_yes.join(",")
        ));
    }
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
            "1 1 0 0 100 0",
        ] {
            assert!(calculate(input).is_err(), "{input}");
        }
    }

    fn order(n: usize) -> String {
        (0..n).map(|i| i.to_string()).collect::<Vec<_>>().join(" ")
    }

    fn numbers(output: &str, key: &str) -> Vec<f64> {
        let rest = &output[output.find(&format!("\"{key}\":")).unwrap() + key.len() + 3..];
        let end = if rest.starts_with('[') {
            rest.find(']').unwrap() + 1
        } else {
            rest.find([',', '}']).unwrap()
        };
        rest[..end]
            .trim_matches(['[', ']'])
            .split(',')
            .map(|v| v.parse().unwrap())
            .collect()
    }

    #[test]
    fn wide_pools_and_scenarios() {
        let wide = calculate(&format!("1 32 0 1 100 {} 0", order(32))).unwrap();
        assert!((numbers(&wide, "a")[0] - 0.5).abs() < 1e-15);
        let pair = calculate(&format!("1 16 0 1 100 {} 1 3 0 0 0 100", order(16))).unwrap();
        let scenario = calculate(&format!("2 16 100 {} 1 3 0 0 0 100 1 0 1", order(16))).unwrap();
        let joint = numbers(&pair, "joint")[0];
        let a = numbers(&pair, "a")[0];
        let given_yes = numbers(&scenario, "givenYes");
        assert_eq!(given_yes.len(), 16);
        assert!((given_yes[1] - joint / a).abs() < 1e-12);
        assert_eq!(given_yes[0], 1.0);
        assert!((numbers(&scenario, "given")[0] - a).abs() < 1e-12);
        let two = calculate(&format!("2 16 100 {} 1 3 0 0 0 100 2 0 0 5 1", order(16))).unwrap();
        assert_eq!(numbers(&two, "givenYes")[0], 0.0);
        assert_eq!(numbers(&two, "givenYes")[5], 1.0);
    }

    #[test]
    fn rejects_bad_scenarios() {
        let o = order(5);
        for input in [
            format!("2 5 100 {o} 0 0"),
            format!("2 5 100 {o} 0 4 0 1 1 1 2 1 3 1"),
            format!("2 5 100 {o} 0 2 1 1 1 0"),
            format!("2 5 100 {o} 0 1 5 1"),
            format!("2 5 100 {o} 0 1 0 2"),
            format!("2 5 100 {o} 0 1 0 1 extra"),
            format!("2 33 100 {} 0 1 0 1", order(33)),
            format!("2 1 100 0 0 1 0 1"),
        ] {
            assert!(calculate(&input).is_err(), "{input}");
        }
    }
}
