//! Offline worked example: actual simulated buy, learned update, funded reprice, sell.
use flurbo_core::funded_repricing::FundedRepricing;
use flurbo_core::parlay_learning::{IsingModel, LearningMarket, Rates};

fn main() {
    let start = FundedRepricing::new(2, 10.0).unwrap();
    let mut learner = LearningMarket::new(IsingModel::uniform(2).unwrap(), 10.0).unwrap();
    let claim = [false, false, false, true];
    let (paid, held) = start.simulate_trade(0, &claim, 1.0).unwrap();
    // An explicitly synthetic probability signal, not historical data or a live feed.
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
    let (receipt, repriced) = held.simulate_reprice(1, learner.model(), 5.0, 0.1).unwrap();
    let (sell_cash, sold) = repriced.simulate_trade(2, &claim, -1.0).unwrap();
    println!("OFFLINE f64 REFERENCE ONLY; no transactions or statistical guarantees");
    println!("Initial simulated funding: {:.9}", start.cash());
    println!("Buy 1 A AND B: {:.9}", paid);
    println!(
        "Required reserve before update: {:.9}",
        receipt.reserve_before
    );
    println!(
        "Required reserve after update: {:.9}",
        receipt.reserve_after
    );
    println!(
        "External funding added (cap 5): {:.9}",
        receipt.funding_added
    );
    println!(
        "Joint total variation (cap 0.1): {:.9}",
        receipt.total_variation
    );
    println!(
        "A AND B probability before/after: {:.9} / {:.9}",
        held.distribution()[3],
        repriced.distribution()[3]
    );
    println!(
        "Unchanged maximum payout on update: {:.9} / {:.9}",
        held.max_liability(),
        repriced.max_liability()
    );
    println!("Sell 1 A AND B proceeds: {:.9}", -sell_cash);
    println!("Trader round-trip profit: {:.9}", -sell_cash - paid);
    println!(
        "Final cash / reserve / maximum payout: {:.9} / {:.9} / {:.9}",
        sold.cash(),
        sold.required_reserve(),
        sold.max_liability()
    );
}
