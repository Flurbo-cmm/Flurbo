use flurbo_core::{
    Payoff,
    pricing::{PricingError, ReferenceLmsr},
};

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 2e-12 * expected.abs().max(1e-50),
        "{actual} != {expected}"
    );
}

#[test]
fn matches_independent_decimal_fixtures() {
    for line in include_str!("fixtures/lmsr.csv").lines().skip(1) {
        let c: Vec<_> = line.split(',').collect();
        let events = c[1].parse().unwrap();
        let model = ReferenceLmsr::new(
            events,
            c[2].parse().unwrap(),
            c[3].split(';').map(|q| q.parse().unwrap()).collect(),
        )
        .unwrap();
        let claim = Payoff::new(events, c[4].parse().unwrap()).unwrap();
        let (cost, after) = model.simulate_trade(claim, c[5].parse().unwrap()).unwrap();
        close(cost, c[6].parse().unwrap());
        close(after.probability(claim).unwrap(), c[7].parse().unwrap());
    }
}

#[test]
fn all_claims_share_one_coherent_distribution() {
    let model = ReferenceLmsr::new(
        3,
        100.0,
        vec![60.0, 10.0, 10.0, 60.0, 30.0, 20.0, 80.0, 40.0],
    )
    .unwrap();
    close(model.distribution().iter().sum(), 1.0);
    for mask in 1..255 {
        let claim = Payoff::new(3, mask).unwrap();
        let p = model.probability(claim).unwrap();
        close(p + model.probability(claim.complement()).unwrap(), 1.0);
        let (paid, after) = model.simulate_trade(claim, 5.0).unwrap();
        assert!(paid >= 5.0 * p && paid <= 5.0);
        assert!(after.probability(claim).unwrap() > p);
        close(paid, after.cost() - model.cost());
        let (received, restored) = after.simulate_trade(claim, -5.0).unwrap();
        close(paid, -received);
        close(restored.cost(), model.cost());
    }
    let a = Payoff::event(3, 0).unwrap();
    let b = Payoff::event(3, 1).unwrap();
    close(
        model.probability(a.union(b).unwrap()).unwrap(),
        model.probability(a).unwrap() + model.probability(b).unwrap()
            - model.probability(a.intersection(b).unwrap()).unwrap(),
    );
    close(
        model.conditional_probability(a, b).unwrap() * model.probability(b).unwrap(),
        model.probability(a.intersection(b).unwrap()).unwrap(),
    );
}

#[test]
fn rejects_invalid_inputs_and_leaves_snapshot_unchanged() {
    let model = ReferenceLmsr::new(2, 100.0, vec![0.0; 4]).unwrap();
    let a = Payoff::event(2, 0).unwrap();
    for b in [0.0, -1.0, f64::NAN, f64::INFINITY, 1e10] {
        assert!(ReferenceLmsr::new(2, b, vec![0.0; 4]).is_err());
    }
    for q in [
        vec![0.0; 3],
        vec![-1.0; 4],
        vec![f64::NAN; 4],
        vec![10001.0; 4],
    ] {
        assert!(ReferenceLmsr::new(2, 100.0, q).is_err());
    }
    for quantity in [f64::NAN, f64::INFINITY, 101.0, 1e-10, -1.0] {
        assert!(model.simulate_trade(a, quantity).is_err());
    }
    assert!(
        model
            .simulate_trade(Payoff::new(2, 15).unwrap(), 1.0)
            .is_err()
    );
    assert!(model.probability(Payoff::event(3, 0).unwrap()).is_err());
    assert_eq!(
        model.conditional_probability(a, Payoff::new(2, 0).unwrap()),
        Err(PricingError::ImpossibleCondition)
    );
    let (zero, after) = model.simulate_trade(a, 0.0).unwrap();
    assert_eq!(zero, 0.0);
    close(after.cost(), model.cost());
    close(model.cost(), 100.0 * 4_f64.ln());
    close(model.probability(a).unwrap(), 0.5);
}
