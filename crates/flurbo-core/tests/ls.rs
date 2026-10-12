use flurbo_core::{
    factored::{Factor, FactoredError, FactoredLmsr},
    ls::LsFactored,
};
use std::f64::consts::LN_2;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn unit(&mut self) -> f64 {
        self.next() as f64 / (1_u64 << 31) as f64
    }
}

fn empty(events: u8, depth: f64, commission: f64) -> LsFactored {
    LsFactored::new(events, depth, commission, vec![], (0..events).collect()).unwrap()
}

fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} != {expected} within {tolerance}"
    );
}

fn random_claim(rng: &mut Lcg) -> (Vec<u8>, u8) {
    let scopes: [&[u8]; 6] = [&[0], &[1], &[2], &[0, 1], &[1, 2], &[0, 1, 2]];
    let scope = scopes[(rng.next() % 6) as usize].to_vec();
    let full = (1_u16 << (1 << scope.len())) - 1;
    let mask = (1 + rng.next() % u64::from(full - 1)) as u8;
    (scope, mask)
}

#[test]
fn depth_starts_at_initial_and_adds_rate_times_mean_liability() {
    let pool = empty(2, 10.0, 0.05);
    assert_eq!(pool.depth(), 10.0);
    let rate = 0.05 / (2.0 * LN_2);
    assert!((pool.rate() - rate).abs() <= 1e-15 * rate);
    let (_, after) = pool.simulate_trade(&[0], 2, 1.0).unwrap();
    near(after.depth(), 10.0 + pool.rate() / 2.0, 1e-12);
}

#[test]
fn empty_cost_equals_fixed_depth_funding() {
    let pool = empty(2, 10.0, 0.05);
    near(pool.cost(), 10.0 * 2.0 * LN_2, 1e-12);
    let fixed = FactoredLmsr::new(2, 10.0, vec![], vec![0, 1]).unwrap();
    near(pool.cost(), fixed.cost(), 1e-12);
}

#[test]
fn matches_independent_decimal_fixtures() {
    let mut current: Option<(String, LsFactored)> = None;
    let mut rows = 0;
    for line in include_str!("fixtures/ls_lmsr.csv").lines().skip(1) {
        let cells: Vec<_> = line.split(',').collect();
        let name = cells[0].to_string();
        let events: u8 = cells[1].parse().unwrap();
        let initial: f64 = cells[2].parse().unwrap();
        let commission = cells[3].parse::<f64>().unwrap() / 10_000.0;
        let step: usize = cells[4].parse().unwrap();
        let scope: Vec<u8> = cells[5].split(';').map(|v| v.parse().unwrap()).collect();
        let mask: u8 = cells[6].parse().unwrap();
        let quantity: f64 = cells[7].parse().unwrap();
        let expected_cost: f64 = cells[8].parse().unwrap();
        let expected_depth: f64 = cells[9].parse().unwrap();
        let pool = match current.take() {
            Some((previous, pool)) if previous == name && step > 0 => pool,
            _ => {
                assert_eq!(step, 0, "{name}");
                empty(events, initial, commission)
            }
        };
        let (cost, after) = pool.simulate_trade(&scope, mask, quantity).unwrap();
        near(cost, expected_cost, 1e-9 * expected_cost.abs().max(1.0));
        near(after.depth(), expected_depth, 1e-9);
        current = Some((name, after));
        rows += 1;
    }
    assert_eq!(rows, 23);
}

#[test]
fn homogeneous_of_degree_one() {
    let factors = |gamma: f64| {
        vec![
            Factor {
                scope: vec![0],
                values: vec![3.0 * gamma, 11.0 * gamma],
            },
            Factor {
                scope: vec![1, 2],
                values: vec![0.0, 4.0 * gamma, 9.0 * gamma, 1.5 * gamma],
            },
            Factor {
                scope: vec![0, 1, 2],
                values: (0..8).map(|j| f64::from(j) * 1.25 * gamma).collect(),
            },
        ]
    };
    let base = LsFactored::new(3, 20.0, 0.05, factors(1.0), vec![0, 1, 2]).unwrap();
    for gamma in [0.5, 3.0] {
        let scaled = LsFactored::new(3, 20.0 * gamma, 0.05, factors(gamma), vec![0, 1, 2]).unwrap();
        near(
            scaled.cost(),
            gamma * base.cost(),
            1e-9 * gamma * base.cost(),
        );
        near(
            scaled.depth(),
            gamma * base.depth(),
            1e-9 * gamma * base.depth(),
        );
    }
}

#[test]
fn prices_of_a_partition_sum_between_one_and_one_plus_commission() {
    let commission = 0.05;
    let mut pool = empty(3, 10.0, commission);
    let total = |pool: &LsFactored| -> f64 {
        (0..8)
            .map(|j| pool.price(&[0, 1, 2], 1 << j).unwrap())
            .sum()
    };
    near(total(&pool), 1.0 + commission, 1e-12);
    let mut rng = Lcg(7);
    let mut trades = 0;
    while trades < 20 {
        let (scope, mask) = random_claim(&mut rng);
        let quantity = pool.depth() * (0.05 + 0.95 * rng.unit());
        if let Ok((_, after)) = pool.simulate_trade(&scope, mask, quantity) {
            pool = after;
            trades += 1;
            let sum = total(&pool);
            assert!(sum >= 1.0 && sum <= 1.0 + commission + 1e-12, "{sum}");
        }
    }
}

#[test]
fn path_independent_and_split_invariant() {
    let pool = empty(3, 10.0, 0.05);
    let (a1, p) = pool.simulate_trade(&[0], 2, 4.0).unwrap();
    let (a2, p) = p.simulate_trade(&[1, 2], 8, 3.0).unwrap();
    let (a3, p) = p.simulate_trade(&[0], 2, -1.5).unwrap();
    let (b1, q) = pool.simulate_trade(&[1, 2], 8, 3.0).unwrap();
    let (b2, q) = q.simulate_trade(&[0], 2, 2.5).unwrap();
    near(a1 + a2 + a3, b1 + b2, 1e-9);
    near(p.cost(), q.cost(), 1e-9);
    near(p.depth(), q.depth(), 1e-9);

    let (once, _) = pool.simulate_trade(&[0, 1], 9, 10.0).unwrap();
    let mut split = pool.clone();
    let mut paid = 0.0;
    for _ in 0..10 {
        let (cost, after) = split.simulate_trade(&[0, 1], 9, 1.0).unwrap();
        paid += cost;
        split = after;
    }
    near(paid, once, 1e-9);
}

#[test]
fn round_trip_returns_the_same_cost() {
    let pool = empty(2, 10.0, 0.05);
    let (start, pool) = pool.simulate_trade(&[0, 1], 8, 3.0).unwrap();
    assert!(start > 0.0);
    let (paid, held) = pool.simulate_trade(&[0], 2, 7.0).unwrap();
    let (received, back) = held.simulate_trade(&[0], 2, -7.0).unwrap();
    near(back.cost(), pool.cost(), 1e-12);
    near(back.depth(), pool.depth(), 1e-12);
    near(paid + received, 0.0, 1e-9);
}

#[test]
fn balanced_volume_keeps_exactly_the_commission() {
    let pool = empty(2, 10.0, 0.05);
    let (yes, pool) = pool.simulate_trade(&[0], 2, 10.0).unwrap();
    let (no, _) = pool.simulate_trade(&[0], 1, 10.0).unwrap();
    near(yes + no, 10.5, 1e-9);
}

#[test]
fn loss_never_exceeds_funding() {
    let mut pool = empty(3, 10.0, 0.05);
    let funding = pool.cost();
    let mut rng = Lcg(2026);
    let mut cash = funding;
    let mut accepted = 0;
    for _ in 0..200 {
        let (scope, mask) = random_claim(&mut rng);
        let size = pool.depth() * (0.01 + 0.99 * rng.unit());
        let quantity = if rng.next() % 3 == 0 { -size } else { size };
        if let Ok((cost, after)) = pool.simulate_trade(&scope, mask, quantity) {
            cash += cost;
            pool = after;
            accepted += 1;
            assert!(pool.cost() >= pool.max_liability() - 1e-9);
            assert!(cash >= pool.max_liability() - 1e-9);
            assert!(pool.max_liability() - (cash - funding) <= funding + 1e-9);
        }
    }
    assert!(accepted >= 100, "{accepted}");
}

#[test]
fn deeper_pool_moves_less_per_share() {
    let move_of = |pool: &LsFactored| {
        let before = pool.probability(&[(0, true)]).unwrap();
        let (_, after) = pool.simulate_trade(&[0], 2, 1.0).unwrap();
        after.probability(&[(0, true)]).unwrap() - before
    };
    let start = empty(2, 10.0, 0.05);
    let mut pool = start.clone();
    for mask in [2, 1] {
        let mut left: f64 = 50.0;
        while left > 0.0 {
            let chunk = left.min(pool.depth());
            pool = pool.simulate_trade(&[0], mask, chunk).unwrap().1;
            left -= chunk;
        }
    }
    near(pool.probability(&[(0, true)]).unwrap(), 0.5, 1e-12);
    assert!(pool.depth() > start.depth());
    assert!(move_of(&pool) < move_of(&start));
}

#[test]
fn rejects_invalid_commission_and_depth() {
    for commission in [0.0, 0.005, 0.25, f64::NAN] {
        assert_eq!(
            LsFactored::new(2, 10.0, commission, vec![], vec![0, 1]).err(),
            Some(FactoredError::InvalidLiquidity)
        );
    }
    for depth in [0.0, f64::NAN] {
        assert_eq!(
            LsFactored::new(2, depth, 0.05, vec![], vec![0, 1]).err(),
            Some(FactoredError::InvalidLiquidity)
        );
    }
}
