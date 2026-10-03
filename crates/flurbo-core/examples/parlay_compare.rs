//! Offline comparison runner. No RPC, private keys, transactions or new dependencies.
use flurbo_core::factored::FactoredLmsr;
use flurbo_core::parlay_learning::{IsingModel, LearningMarket, Rates};
use std::{env, fs, process};

const RATES: Rates = Rates {
    fields: 0.2,
    pairs: 0.2,
};

fn main() {
    match run(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(csv) => print!("{csv}"),
        Err(error) => {
            eprintln!("parlay comparison: {error}");
            process::exit(1);
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    match args.first().map(String::as_str) {
        Some("synthetic") if args.len() == 1 => synthetic(),
        Some("flow") if args.len() == 1 => flow(),
        Some("replay") if args.len() == 7 => {
            let events = args[1].parse().map_err(|_| "invalid event count")?;
            let liquidity = args[2].parse().map_err(|_| "invalid liquidity")?;
            let rates = Rates {
                fields: args[3].parse().map_err(|_| "invalid field rate")?,
                pairs: args[4].parse().map_err(|_| "invalid pair rate")?,
            };
            if args[5] != "--csv" { return Err("expected --csv".into()); }
            let data = fs::read_to_string(&args[6]).map_err(|e| e.to_string())?;
            replay(events, liquidity, rates, &data)
        }
        _ => Err("usage: cargo run --example parlay_compare -- synthetic | flow | replay EVENTS B FIELD_RATE PAIR_RATE --csv PATH".into()),
    }
}

// Fixed portable PRNG, so experiments do not change across platforms or versions.
struct Rng(u64);
impl Rng {
    fn sample(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1_u64 << 53) as f64)
    }
}

fn prob(distribution: &[f64], scope: u16) -> f64 {
    distribution
        .iter()
        .enumerate()
        .filter(|(s, _)| (*s as u16) & scope == scope)
        .map(|(_, p)| p)
        .sum()
}

fn mse(model: &IsingModel, truth: &[f64]) -> f64 {
    model
        .scopes()
        .map(|s| (model.probability(s).unwrap() - prob(truth, s)).powi(2))
        .sum::<f64>()
        / f64::from((1_u16 << model.events()) - 1)
}

fn kl(model: &IsingModel, truth: &[f64]) -> f64 {
    truth
        .iter()
        .zip(model.distribution().unwrap())
        .map(|(p, q)| p * (p / q).ln())
        .sum::<f64>()
        .max(0.0)
}

fn truth(scenario: &str, step: usize) -> Vec<f64> {
    if scenario == "higher_order" {
        return vec![0.225, 0.025, 0.025, 0.225, 0.025, 0.225, 0.225, 0.025];
    }
    let sign = if scenario == "regime_change" && step >= 2000 {
        -1.0
    } else {
        1.0
    };
    IsingModel::new(3, vec![-sign, -sign, 0.0, 2.0 * sign, 0.0, 0.0])
        .unwrap()
        .distribution()
        .unwrap()
}

fn synthetic() -> Result<String, String> {
    let mut out = String::from("scenario,seed,step,model,mse_all_claims,kl_joint,p_ab,p_abc\n");
    for scenario in [
        "stationary",
        "regime_change",
        "noisy",
        "poison_recovery",
        "higher_order",
    ] {
        for seed in [7, 19, 41] {
            let mut rng = Rng(seed);
            let uniform = IsingModel::uniform(3).unwrap();
            let mut models = vec![
                (
                    "pairwise_all",
                    LearningMarket::new(uniform.clone(), 10.0).unwrap(),
                ),
                (
                    "pairwise_singles",
                    LearningMarket::new(uniform.clone(), 10.0).unwrap(),
                ),
                (
                    "independent_all",
                    LearningMarket::new(uniform.clone(), 10.0).unwrap(),
                ),
                ("uniform", LearningMarket::new(uniform, 10.0).unwrap()),
            ];
            for step in 0..=4000 {
                let true_distribution = truth(scenario, step);
                // Evaluate before exposing this step's target. Outcomes never train the model.
                if step % 100 == 0 {
                    for (name, market) in &models {
                        out.push_str(&format!(
                            "{scenario},{seed},{step},{name},{:.10},{:.10},{:.10},{:.10}\n",
                            mse(market.model(), &true_distribution),
                            kl(market.model(), &true_distribution),
                            market.model().probability(3).unwrap(),
                            market.model().probability(7).unwrap()
                        ));
                    }
                }
                if step == 4000 {
                    break;
                }
                let scope = 1 + (rng.sample() * 7.0) as u16;
                let clean = prob(&true_distribution, scope);
                let target = match scenario {
                    "noisy" => (clean + 0.2 * (2.0 * rng.sample() - 1.0)).clamp(0.001, 0.999),
                    "poison_recovery" if (1000..2000).contains(&step) => 1.0 - clean,
                    _ => clean,
                };
                for (name, market) in &mut models {
                    if *name == "uniform"
                        || (*name == "pairwise_singles" && scope.count_ones() != 1)
                    {
                        continue;
                    }
                    let rates = if *name == "independent_all" {
                        Rates {
                            fields: 0.2,
                            pairs: 0.0,
                        }
                    } else {
                        RATES
                    };
                    market
                        .observe(scope, target, rates)
                        .map_err(|e| format!("{scenario}/{seed}/{step}: {e:?}"))?;
                }
            }
        }
    }
    Ok(out)
}

/// Same exogenous signed YES flow to the learner and actual FactoredLmsr reference.
/// Negative YES flow is funded here as buying the Boolean complement, never naked selling.
/// This toy flow is deliberately NOT a model of informed traders or historical performance.
fn flow() -> Result<String, String> {
    let mut out = String::from(
        "seed,step,model,mse_all_claims,receipts_hypothetical,expected_payout,worst_payout,min_initial_collateral_observed,expected_pnl,actual_claim_units,virtual_shadow_abs_units\n",
    );
    for seed in [7, 19, 41] {
        let mut rng = Rng(seed);
        let b = 10.0;
        let mut current = FactoredLmsr::new(3, b, vec![], vec![0, 1, 2]).unwrap();
        let mut learned = LearningMarket::new(IsingModel::uniform(3).unwrap(), b).unwrap();
        let true_distribution = truth("stationary", 0);
        let mut revenue = [0.0, 0.0];
        let mut liabilities = [0.0; 8];
        let mut funding = [0.0_f64, 0.0];
        let mut virtual_abs = 0.0;
        let mut actual_units = 0.0;
        for step in 1..=600 {
            let scope = 1 + (rng.sample() * 7.0) as u16;
            let buy_yes = rng.sample() < prob(&true_distribution, scope);
            let quantity = 0.1 + 0.4 * rng.sample();
            let events: Vec<u8> = (0..3).filter(|i| scope & (1 << i) != 0).collect();
            let state_count = 1_u16 << events.len();
            let all_yes_mask = 1_u16 << (state_count - 1);
            let mask = if buy_yes {
                all_yes_mask
            } else {
                ((1_u16 << state_count) - 1) ^ all_yes_mask
            } as u8;
            let (paid, next) = current
                .simulate_trade(&events, mask, quantity)
                .map_err(|e| format!("baseline flow: {e:?}"))?;
            let update = learned
                .trade_signal(scope, if buy_yes { quantity } else { -quantity }, RATES)
                .map_err(|e| format!("learning flow: {e:?}"))?;
            current = next;
            actual_units += quantity;
            revenue[0] += paid;
            // Buying NO equals buying a complete set for q and selling q YES.
            revenue[1] += update.reference_cost.unwrap() + if buy_yes { 0.0 } else { quantity };
            virtual_abs += update
                .shadows
                .iter()
                .map(|s| s.virtual_quantity.abs())
                .sum::<f64>();
            for (s, liability) in liabilities.iter_mut().enumerate() {
                if ((s as u16) & scope == scope) == buy_yes {
                    *liability += quantity;
                }
            }
            let maximum = liabilities.iter().copied().fold(0.0, f64::max);
            if (maximum - current.max_liability()).abs() > 1e-8 {
                return Err("baseline and independent terminal payout ledger disagree".into());
            }
            for (required, cash) in funding.iter_mut().zip(revenue) {
                *required = required.max(maximum - cash);
            }
            if step % 100 == 0 {
                let baseline_mse = (1_u16..8)
                    .map(|s| {
                        let evidence: Vec<_> = (0..3)
                            .filter(|i| s & (1 << i) != 0)
                            .map(|i| (i, true))
                            .collect();
                        (current.probability(&evidence).unwrap() - prob(&true_distribution, s))
                            .powi(2)
                    })
                    .sum::<f64>()
                    / 7.0;
                let expected: f64 = liabilities
                    .iter()
                    .zip(&true_distribution)
                    .map(|(l, p)| l * p)
                    .sum();
                for (i, name, error) in [
                    (0, "flurbo_factored", baseline_mse),
                    (
                        1,
                        "pairwise_order_adapter",
                        mse(learned.model(), &true_distribution),
                    ),
                ] {
                    out.push_str(&format!("{seed},{step},{name},{error:.10},{:.10},{expected:.10},{maximum:.10},{:.10},{:.10},{:.10},{:.10}\n",
                        revenue[i], funding[i], revenue[i] - expected, actual_units, if i == 1 { virtual_abs } else { 0.0 }));
                }
            }
        }
    }
    Ok(out)
}

#[derive(Debug)]
struct Row {
    sequence: u64,
    timestamp_ms: u64,
    scope: u16,
    quantity: f64,
}

fn parse_csv(events: u8, b: f64, data: &str) -> Result<Vec<Row>, String> {
    if data.len() > 2_000_000 {
        return Err("CSV exceeds 2 MB".into());
    }
    let mut lines = data.lines();
    if lines.next() != Some("sequence,timestamp_ms,scope,quantity") {
        return Err("expected header sequence,timestamp_ms,scope,quantity; normalized signed YES quantities only".into());
    }
    let mut rows: Vec<Row> = Vec::new();
    for (line, text) in lines.enumerate() {
        if rows.len() == 1_000 {
            return Err("at most 1000 rows per replay".into());
        }
        let fields: Vec<_> = text.split(',').collect();
        let bad = || format!("invalid replay row {}", line + 2);
        if fields.len() != 4 {
            return Err(bad());
        }
        let row = Row {
            sequence: fields[0].parse().map_err(|_| bad())?,
            timestamp_ms: fields[1].parse().map_err(|_| bad())?,
            scope: fields[2].parse().map_err(|_| bad())?,
            quantity: fields[3].parse().map_err(|_| bad())?,
        };
        if row.scope == 0
            || row.scope >= (1_u16 << events)
            || !row.quantity.is_finite()
            || row.quantity == 0.0
            || row.quantity.abs() > b
            || rows.last().is_some_and(|prev| {
                row.sequence <= prev.sequence || row.timestamp_ms < prev.timestamp_ms
            })
        {
            return Err(bad());
        }
        rows.push(row);
    }
    if rows.is_empty() {
        return Err("empty replay".into());
    }
    Ok(rows)
}

fn replay(events: u8, b: f64, rates: Rates, data: &str) -> Result<String, String> {
    let model = IsingModel::uniform(events).map_err(|e| format!("{e:?}"))?;
    let mut market = LearningMarket::new(model, b).map_err(|e| format!("{e:?}"))?;
    let rows = parse_csv(events, b, data)?;
    let mut out = String::from(
        "sequence,timestamp_ms,traded_scope,signed_yes_quantity,derived_target,shadow_scope,p_before,p_after,starting_imbalance,virtual_quantity,ending_imbalance,reference_cost\n",
    );
    for row in rows {
        let update = market
            .trade_signal(row.scope, row.quantity, rates)
            .map_err(|e| format!("sequence {}: {e:?}", row.sequence))?;
        for shadow in update.shadows {
            out.push_str(&format!(
                "{},{},{},{:.10},{:.10},{},{:.10},{:.10},{:.10},{:.10},{:.10},{:.10}\n",
                row.sequence,
                row.timestamp_ms,
                row.scope,
                row.quantity,
                update.target,
                shadow.scope,
                shadow.before_probability,
                shadow.after_probability,
                shadow.starting_imbalance,
                shadow.virtual_quantity,
                shadow.ending_imbalance,
                update.reference_cost.unwrap()
            ));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    const CSV: &str = "sequence,timestamp_ms,scope,quantity\n1,1000,3,0.2\n2,1000,1,-0.1\n";

    #[test]
    fn replay_is_deterministic_and_reports_every_shadow() {
        let result = replay(2, 10.0, RATES, CSV).unwrap();
        assert_eq!(result, replay(2, 10.0, RATES, CSV).unwrap());
        assert_eq!(result.lines().count(), 7);
        // A late bad row returns no partial report to the caller.
        assert!(replay(2, 10.0, RATES, &(CSV.to_string() + "3,999,1,0.1\n")).is_err());
    }

    #[test]
    fn malformed_duplicate_reversed_or_out_of_domain_replays_fail() {
        for data in [
            CSV.replace("2,1000", "1,1000"),
            CSV.replace("2,1000", "2,999"),
            CSV.replace("3,0.2", "4,0.2"),
            CSV.replace("0.2", "NaN"),
            CSV.replace("0.2", "0"),
            CSV.replace("0.2", "11"),
            CSV.replace("quantity", "price"),
            CSV.to_string() + "\n",
        ] {
            assert!(replay(2, 10.0, RATES, &data).is_err(), "{data}");
        }
        assert!(replay(9, 10.0, RATES, CSV).is_err());
        assert!(
            replay(
                2,
                10.0,
                Rates {
                    fields: f64::NAN,
                    pairs: 0.2
                },
                CSV
            )
            .is_err()
        );
    }
}
