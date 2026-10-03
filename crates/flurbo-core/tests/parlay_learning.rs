use flurbo_core::parlay_learning::{IsingModel, LearningError, LearningMarket, Rates};

const RATES: Rates = Rates {
    fields: 0.2,
    pairs: 0.2,
};

fn close(a: f64, b: f64, tolerance: f64) {
    assert!((a - b).abs() < tolerance, "{a} != {b}");
}

fn ce(p: f64, target: f64) -> f64 {
    -target * p.ln() - (1.0 - target) * (-p).ln_1p()
}

#[test]
fn exact_distribution_matches_independent_analytic_fixture() {
    // exp(theta) = [2,3], exp(W) = 5: weights [1,2,3,30].
    let model = IsingModel::new(2, vec![2_f64.ln(), 3_f64.ln(), 5_f64.ln()]).unwrap();
    for (actual, weight) in model
        .distribution()
        .unwrap()
        .iter()
        .zip([1.0, 2.0, 3.0, 30.0])
    {
        close(*actual, weight / 36.0, 1e-14);
    }
    close(model.probability(1).unwrap(), 32.0 / 36.0, 1e-14);
    close(model.probability(3).unwrap(), 30.0 / 36.0, 1e-14);
}

#[test]
fn every_gradient_component_matches_finite_differences_for_every_claim() {
    let parameters = vec![-0.7, 0.3, 0.1, 0.9, -0.4, 0.6];
    let model = IsingModel::new(3, parameters.clone()).unwrap();
    for scope in model.scopes() {
        for target in [0.04, 0.37, 0.89] {
            let gradient = model.gradient(scope, target).unwrap();
            for i in 0..parameters.len() {
                let mut up = parameters.clone();
                let mut down = parameters.clone();
                up[i] += 1e-5;
                down[i] -= 1e-5;
                let a = IsingModel::new(3, up).unwrap().probability(scope).unwrap();
                let b = IsingModel::new(3, down)
                    .unwrap()
                    .probability(scope)
                    .unwrap();
                close(gradient[i], (ce(a, target) - ce(b, target)) / 2e-5, 1e-9);
            }
        }
    }
}

#[test]
fn gradient_step_reduces_observed_cross_entropy_and_changes_related_prices() {
    let model = IsingModel::uniform(3).unwrap();
    let next = model.updated(3, 0.6, RATES).unwrap();
    assert!(ce(next.probability(3).unwrap(), 0.6) < ce(0.25, 0.6));
    assert!(next.probability(1).unwrap() > 0.5);
    assert!(next.probability(7).unwrap() > 0.125);
    // A full dense gradient can also move C through the A-C and B-C features.
    // Do not assume initially independent events are frozen during learning.
    assert!(next.probability(4).unwrap() > 0.5);
    assert!(next.parameters()[3] > 0.0);
}

#[test]
fn shadow_books_reconcile_once_without_creating_real_orders() {
    let mut market = LearningMarket::new(IsingModel::uniform(3).unwrap(), 10.0).unwrap();
    let before = market.clone();
    let report = market.trade_signal(3, 0.8, RATES).unwrap();
    assert_eq!(report.order_quantity, Some(0.8));
    assert_eq!(report.shadows.len(), 7);
    let expected = before.model().updated(3, report.target, RATES).unwrap();
    assert_eq!(market.model(), &expected);
    for shadow in &report.shadows {
        let i = usize::from(shadow.scope - 1);
        close(
            shadow.starting_imbalance,
            before.imbalances()[i] + if shadow.scope == 3 { 0.8 } else { 0.0 },
            1e-14,
        );
        close(
            shadow.starting_imbalance + shadow.virtual_quantity,
            market.imbalances()[i],
            1e-14,
        );
        close(
            1.0 / (1.0 + (-shadow.ending_imbalance / 10.0).exp()),
            shadow.after_probability,
            1e-14,
        );
    }
    let real_cost = 10.0 * (0.75 + 0.25 * (0.8_f64 / 10.0).exp()).ln();
    close(report.reference_cost.unwrap(), real_cost, 1e-14);
    let observation = market.observe(1, 0.6, RATES).unwrap();
    assert_eq!(observation.reference_cost, None);
    assert_eq!(observation.order_quantity, None);
}

#[test]
fn shadow_resets_do_not_preserve_the_original_lmsr_cost_path() {
    // With SGD disabled, shadowing undoes the real price displacement, so prices
    // stay fixed. The two finite trades are NOT a cost-neutral LMSR round trip.
    // This test protects against claiming shadow accounting preserves cost paths.
    let mut market = LearningMarket::new(IsingModel::uniform(2).unwrap(), 10.0).unwrap();
    let zero = Rates {
        fields: 0.0,
        pairs: 0.0,
    };
    let before = market.clone();
    let buy = market.trade_signal(3, 1.0, zero).unwrap();
    let sell = market.trade_signal(3, -1.0, zero).unwrap();
    assert_eq!(market, before);
    close(buy.shadows[2].virtual_quantity, -1.0, 1e-14);
    close(sell.shadows[2].virtual_quantity, 1.0, 1e-14);
    assert!(buy.reference_cost.unwrap() + sell.reference_cost.unwrap() > 0.0);
}

#[test]
fn input_and_numeric_failures_never_mutate_either_state() {
    let mut market = LearningMarket::new(IsingModel::uniform(2).unwrap(), 10.0).unwrap();
    let before = market.clone();
    for target in [f64::NAN, f64::INFINITY, 0.0, 1.0, -0.1] {
        assert!(market.observe(1, target, RATES).is_err());
        assert_eq!(market, before);
    }
    for scope in [0, 4, 256] {
        assert!(market.observe(scope, 0.4, RATES).is_err());
        assert_eq!(market, before);
    }
    for quantity in [0.0, 11.0, -11.0, f64::NAN] {
        assert!(market.trade_signal(1, quantity, RATES).is_err());
        assert_eq!(market, before);
    }
    assert!(
        market
            .observe(
                1,
                0.4,
                Rates {
                    fields: -0.1,
                    pairs: 0.2
                }
            )
            .is_err()
    );
    assert_eq!(market, before);
    let mut edge = LearningMarket::new(IsingModel::new(1, vec![12.0]).unwrap(), 10.0).unwrap();
    let before = edge.clone();
    assert!(edge.observe(1, 1.0 - 1e-10, RATES).is_err());
    assert_eq!(edge, before);
    assert_eq!(IsingModel::uniform(9), Err(LearningError::EventCount));
    assert_eq!(
        IsingModel::new(3, vec![12.0; 6]),
        Err(LearningError::NumericDomain)
    );
    assert!(LearningMarket::new(IsingModel::uniform(2).unwrap(), f64::NAN).is_err());
}

#[test]
fn pairwise_information_recovers_dependence_that_singletons_cannot_identify() {
    // Symmetric pair: marginal P(A)=P(B)=1/2 for every coupling strength.
    let truth = IsingModel::new(2, vec![-1.0, -1.0, 2.0]).unwrap();
    let mut full = IsingModel::uniform(2).unwrap();
    let mut singles = full.clone();
    for _ in 0..6000 {
        for scope in 1..=3 {
            let target = truth.probability(scope).unwrap();
            full = full.updated(scope, target, RATES).unwrap();
            if scope.count_ones() == 1 {
                singles = singles.updated(scope, target, RATES).unwrap();
            }
        }
    }
    for scope in 1..=3 {
        close(
            full.probability(scope).unwrap(),
            truth.probability(scope).unwrap(),
            0.002,
        );
    }
    close(singles.probability(3).unwrap(), 0.25, 1e-12);
    assert!((singles.probability(3).unwrap() - truth.probability(3).unwrap()).abs() > 0.1);
}

#[test]
fn singleton_only_inference_is_not_a_proof_of_convergence_to_joint_truth() {
    // Even parity has uniform singleton/pair moments, but P(ABC)=0.025, not .125.
    // Pairwise learning cannot identify this pure higher-order dependence.
    let truth = [0.225, 0.025, 0.025, 0.225, 0.025, 0.225, 0.225, 0.025];
    let model = IsingModel::uniform(3).unwrap();
    let mut learned = model.clone();
    for scope in 1_u16..8 {
        if scope.count_ones() <= 2 {
            let target = truth
                .iter()
                .enumerate()
                .filter(|(s, _)| (*s as u16) & scope == scope)
                .map(|(_, p)| p)
                .sum();
            learned = learned.updated(scope, target, RATES).unwrap();
        }
    }
    close(learned.probability(7).unwrap(), 0.125, 1e-14);
    close(learned.probability(7).unwrap() - truth[7], 0.1, 1e-14);
}

#[test]
fn eight_event_model_is_normalized_and_obeys_every_pair_frechet_bound() {
    let parameters: Vec<f64> = (0..36).map(|i| ((i % 5) as f64 - 2.0) * 0.1).collect();
    let model = IsingModel::new(8, parameters).unwrap();
    close(model.distribution().unwrap().iter().sum(), 1.0, 1e-14);
    for a in 0..8 {
        for b in a + 1..8 {
            let pa = model.probability(1 << a).unwrap();
            let pb = model.probability(1 << b).unwrap();
            let joint = model.probability((1 << a) | (1 << b)).unwrap();
            assert!(joint <= pa.min(pb) + 1e-14);
            assert!(joint + 1e-14 >= (pa + pb - 1.0).max(0.0));
        }
    }
}
