use flurbo_core::factored::FactoredLmsr;
use flurbo_core::funded_repricing::{FundedRepricing, RepricingError};
use flurbo_core::parlay_learning::{IsingModel, LearningMarket, Rates};

fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 1e-9 * (1.0 + a.abs().max(b.abs())),
        "{a} != {b}"
    );
}

fn covered(m: &FundedRepricing) {
    assert!(m.cash() + 1e-8 >= m.required_reserve());
    // Independently settle EVERY terminal outcome against the cash account.
    for liability in m.liabilities() {
        assert!(m.cash() + 1e-8 >= *liability);
    }
}

#[test]
fn unchanged_uniform_bias_matches_existing_factored_maker() {
    let mut funded = FundedRepricing::new(3, 10.0).unwrap();
    let mut baseline = FactoredLmsr::new(3, 10.0, vec![], vec![0, 1, 2]).unwrap();
    close(funded.cash(), baseline.cost());
    for (scope, mask, qty) in [
        (vec![0, 1], 8_u8, 2.0),
        (vec![2], 2, 1.0),
        (vec![0, 1], 8, -1.0),
    ] {
        let payoff: Vec<_> = (0..8)
            .map(|s| {
                let local = scope
                    .iter()
                    .enumerate()
                    .fold(0, |a, (i, e)| a | (((s >> e) & 1) << i));
                mask & (1 << local) != 0
            })
            .collect();
        let (paid, next) = funded
            .simulate_trade(funded.revision(), &payoff, qty)
            .unwrap();
        let (reference, next_baseline) = baseline.simulate_trade(&scope, mask, qty).unwrap();
        close(paid, reference);
        close(next.max_liability(), next_baseline.max_liability());
        funded = next;
        baseline = next_baseline;
        covered(&funded);
    }
}

#[test]
fn learning_reprices_existing_positions_without_minting_shadow_liabilities() {
    let m = FundedRepricing::new(2, 10.0).unwrap();
    let (_, m) = m
        .simulate_trade(0, &[false, false, false, true], 2.0)
        .unwrap();
    let mut learner = LearningMarket::new(IsingModel::uniform(2).unwrap(), 10.0).unwrap();
    learner
        .observe(
            3,
            0.8,
            Rates {
                fields: 0.2,
                pairs: 0.2,
            },
        )
        .unwrap();
    let (receipt, next) = m
        .simulate_reprice(m.revision(), learner.model(), 100.0, 1.0)
        .unwrap();
    assert_eq!(next.liabilities(), m.liabilities());
    assert!(receipt.funding_added > 0.0);
    close(next.cash(), m.cash() + receipt.funding_added);
    for (actual, learned) in next
        .distribution()
        .iter()
        .zip(learner.model().distribution().unwrap())
    {
        close(*actual, learned);
    }
    // Independently derived normalized-target reserve: max_x(q(x) - b*ln p(x)).
    let reserve = m
        .liabilities()
        .iter()
        .zip(learner.model().distribution().unwrap())
        .map(|(q, p)| q - 10.0 * p.ln())
        .fold(f64::NEG_INFINITY, f64::max);
    close(receipt.reserve_after, reserve);
    covered(&next);
}

#[test]
fn limits_reject_without_mutation_and_revisions_bind_to_trades_and_updates() {
    let m = FundedRepricing::new(2, 10.0).unwrap();
    let unchanged = m.clone();
    let model = IsingModel::new(2, vec![1.0, 0.0, 0.5]).unwrap();
    assert_eq!(
        m.simulate_reprice(0, &model, 0.0, 1.0),
        Err(RepricingError::FundingLimit)
    );
    assert_eq!(
        m.simulate_reprice(0, &model, 100.0, 0.01),
        Err(RepricingError::MovementLimit)
    );
    assert_eq!(m, unchanged);
    let (_, traded) = m
        .simulate_trade(0, &[false, true, false, true], 1.0)
        .unwrap();
    assert_eq!(
        traded.simulate_reprice(0, &model, 100.0, 1.0),
        Err(RepricingError::StaleRevision)
    );
    let (_, repriced) = m.simulate_reprice(0, &model, 100.0, 1.0).unwrap();
    assert_eq!(
        repriced.simulate_trade(0, &[false, true, false, true], 1.0),
        Err(RepricingError::StaleRevision)
    );
    assert_eq!(
        repriced.simulate_reprice(0, &model, 100.0, 1.0),
        Err(RepricingError::StaleRevision)
    );
}

#[test]
fn round_trip_extraction_is_real_and_charged_to_external_funding() {
    let initial = FundedRepricing::new(1, 10.0).unwrap();
    let claim = [false, true];
    let (buy, held) = initial.simulate_trade(0, &claim, 1.0).unwrap();
    // Publicly predictable bullish update: buy before it, sell afterward.
    let model = IsingModel::new(1, vec![2.0]).unwrap();
    let (receipt, changed) = held.simulate_reprice(1, &model, 100.0, 1.0).unwrap();
    let (sell, sold) = changed.simulate_trade(2, &claim, -1.0).unwrap();
    let trader_profit = -sell - buy;
    assert!(trader_profit > 0.3);
    assert!(receipt.funding_added > trader_profit);
    assert_eq!(sold.liabilities(), &[0.0, 0.0]);
    close(
        sold.cash(),
        initial.cash() + receipt.funding_added - trader_profit,
    );
    covered(&sold);
    // Without any repricing, the same round trip returns its original cost.
    let (normal_sell, _) = held.simulate_trade(1, &claim, -1.0).unwrap();
    close(buy + normal_sell, 0.0);
}

#[test]
fn cheaper_update_retains_surplus_and_reuses_it_for_later_funding() {
    let m = FundedRepricing::new(1, 10.0).unwrap();
    let skewed = IsingModel::new(1, vec![2.0]).unwrap();
    let (_, expensive) = m.simulate_reprice(0, &skewed, 100.0, 1.0).unwrap();
    let (receipt, cheap) = expensive
        .simulate_reprice(1, &IsingModel::uniform(1).unwrap(), 0.0, 1.0)
        .unwrap();
    assert_eq!(receipt.funding_added, 0.0);
    assert!(cheap.cash() > cheap.required_reserve());
    assert_eq!(cheap.cash(), expensive.cash());
    let (receipt, expensive_again) = cheap.simulate_reprice(2, &skewed, 0.0, 1.0).unwrap();
    assert_eq!(receipt.funding_added, 0.0);
    covered(&expensive_again);
}

#[test]
fn independent_ledger_and_cash_reconcile_across_repeated_adversarial_updates() {
    let mut m = FundedRepricing::new(3, 10.0).unwrap();
    let mut ledger = [0.0; 8];
    let mut cash = m.cash();
    let mut budget = 60.0;
    let mut accepted = 0;
    let mut rejected = 0;
    for step in 0..200 {
        let sign = if step % 2 == 0 { 1.0 } else { -1.0 };
        let model = IsingModel::new(3, vec![sign, -sign, sign, 0.5, -0.5, sign]).unwrap();
        // The attacker sees the proposed update and buys the states it makes dearer.
        let claim: Vec<_> = m
            .distribution()
            .iter()
            .zip(model.distribution().unwrap())
            .map(|(old, target)| target > *old)
            .collect();
        let (buy, held) = m.simulate_trade(m.revision(), &claim, 0.5).unwrap();
        for (q, pays) in ledger.iter_mut().zip(&claim) {
            if *pays {
                *q += 0.5;
            }
        }
        cash += buy;
        m = held;
        match m.simulate_reprice(m.revision(), &model, budget, 1.0) {
            Ok((receipt, changed)) => {
                budget -= receipt.funding_added;
                cash += receipt.funding_added;
                m = changed;
                accepted += 1;
            }
            Err(RepricingError::FundingLimit) => rejected += 1,
            other => panic!("unexpected update result: {other:?}"),
        }
        covered(&m);
        assert_eq!(m.liabilities(), &ledger);
        let (sell, sold) = m.simulate_trade(m.revision(), &claim, -0.5).unwrap();
        for (q, pays) in ledger.iter_mut().zip(&claim) {
            if *pays {
                *q -= 0.5;
            }
        }
        cash += sell;
        m = sold;
        close(m.cash(), cash);
        assert_eq!(m.liabilities(), &ledger);
        covered(&m);
    }
    assert!(accepted > 0);
    assert!(rejected > 0);
    assert!(budget >= 0.0);
}

#[test]
fn malformed_inputs_and_boundary_sizes_are_checked() {
    for events in [0, 9, 255] {
        assert_eq!(
            FundedRepricing::new(events, 10.0),
            Err(RepricingError::Domain)
        );
    }
    for b in [0.0, f64::NAN, f64::INFINITY, 1e10] {
        assert_eq!(FundedRepricing::new(2, b), Err(RepricingError::Domain));
    }
    let m = FundedRepricing::new(1, 10.0).unwrap();
    for qty in [0.0, f64::NAN, f64::INFINITY, 11.0, 1e-10] {
        assert_eq!(
            m.simulate_trade(0, &[false, true], qty),
            Err(RepricingError::Quantity)
        );
    }
    for payoff in [vec![], vec![false], vec![false, false], vec![true, true]] {
        assert_eq!(
            m.simulate_trade(0, &payoff, 1.0),
            Err(RepricingError::Claim)
        );
    }
    assert_eq!(
        m.simulate_trade(0, &[false, true], -1.0),
        Err(RepricingError::Liability)
    );
    let model = IsingModel::uniform(1).unwrap();
    for (budget, movement) in [(f64::NAN, 1.0), (-1.0, 1.0), (1.0, f64::NAN), (1.0, 1.1)] {
        assert_eq!(
            m.simulate_reprice(0, &model, budget, movement),
            Err(RepricingError::Domain)
        );
    }
    assert_eq!(
        m.simulate_reprice(0, &IsingModel::uniform(2).unwrap(), 1.0, 1.0),
        Err(RepricingError::Domain)
    );
    let m = FundedRepricing::new(8, 1e9).unwrap();
    let mut params = vec![0.0; 36];
    params[0] = 12.0;
    params[1] = -12.0;
    let model = IsingModel::new(8, params).unwrap();
    let (_, next) = m.simulate_reprice(0, &model, 1e12, 1.0).unwrap();
    covered(&next);
    for (p, target) in next
        .distribution()
        .iter()
        .zip(model.distribution().unwrap())
    {
        close(*p, target);
    }
}
