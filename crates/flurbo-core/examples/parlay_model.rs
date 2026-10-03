//! Explicit synthetic model export for the local funded execution rehearsal.
use flurbo_core::parlay_learning::{IsingModel, LearningMarket, Rates};

fn main() {
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
    let parameters = learner
        .model()
        .parameters()
        .iter()
        .map(|p| format!("\"{p:.17e}\""))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"schema\":\"flurbo.ising-model.v1\",\"events\":2,\"parameters\":[{parameters}],\"source\":\"synthetic: uniform start; observe A AND B target 0.8; field/pair rates 0.2; b=10\"}}"
    );
}
