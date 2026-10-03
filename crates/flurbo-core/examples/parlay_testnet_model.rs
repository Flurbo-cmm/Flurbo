//! Declared sparse synthetic fixture for the eight-event funded testnet pool.
//! Learn A/B only, then embed it exactly with six independent uniform events.
use flurbo_core::parlay_learning::{IsingModel, LearningMarket, Rates};

fn fixture() -> (IsingModel, IsingModel) {
    let mut learner = LearningMarket::new(IsingModel::uniform(2).unwrap(), 10.0).unwrap();
    learner
        .observe(
            3,
            0.8,
            Rates {
                fields: 0.1,
                pairs: 0.1,
            },
        )
        .unwrap();
    let learned = learner.model().clone();
    let mut parameters = vec![0.0; 36];
    parameters[0] = learned.parameters()[0];
    parameters[1] = learned.parameters()[1];
    parameters[8] = learned.parameters()[2]; // First pair in eight-event ordering is A/B.
    (learned, IsingModel::new(8, parameters).unwrap())
}

fn main() {
    let (_, model) = fixture();
    let parameters = model
        .parameters()
        .iter()
        .map(|p| format!("\"{p:.17e}\""))
        .collect::<Vec<_>>()
        .join(",");
    println!("{{\"schema\":\"flurbo.ising-model.v1\",\"events\":8,\"parameters\":[{parameters}],\"source\":\"synthetic-testnet-v1: one A AND B observation, target 0.8, field/pair rates 0.1, b=10; two-event learner embedded exactly with C through H independent and uniform\"}}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_preserves_ab_and_declared_independence_without_pruning() {
        let (learned, model) = fixture();
        for scope in 1..=3 {
            assert!(
                (model.probability(scope).unwrap() - learned.probability(scope).unwrap()).abs()
                    < 1e-12
            );
        }
        for event in 2..8 {
            assert!((model.probability(1 << event).unwrap() - 0.5).abs() < 1e-12);
            assert!(
                (model.probability(3 | (1 << event)).unwrap()
                    - model.probability(3).unwrap() * 0.5)
                    .abs()
                    < 1e-12
            );
        }
        assert_eq!(model.parameters().iter().filter(|&&p| p != 0.0).count(), 3);
        assert!(model.parameters().iter().sum::<f64>() * 10.0 < 2.0);
    }
}
