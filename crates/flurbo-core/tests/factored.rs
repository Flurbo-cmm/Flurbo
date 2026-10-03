use flurbo_core::{
    Payoff,
    factored::{Factor, FactoredError, FactoredLmsr},
    pricing::ReferenceLmsr,
};

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 3e-11 * expected.abs().max(1e-60),
        "{actual} != {expected}"
    );
}

// Independent full-state expansion belongs only in the tests, never in the factored evaluator.
fn enumerate(events: u8, factors: &[Factor]) -> Vec<f64> {
    (0..1_usize << events)
        .map(|state| {
            factors
                .iter()
                .map(|factor| {
                    let local = factor
                        .scope
                        .iter()
                        .enumerate()
                        .fold(0, |index, (bit, &event)| {
                            index | (((state >> event) & 1) << bit)
                        });
                    factor.values[local]
                })
                .sum()
        })
        .collect()
}

#[test]
fn costs_reserves_and_all_conjunctions_match_enumeration() {
    let orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    for b in [1e-6, 0.25, 100.0, 1e9] {
        for seed in 0..12 {
            let scopes = [vec![], vec![0], vec![1, 2], vec![0, 2], vec![0, 1, 2]];
            let factors: Vec<_> = scopes
                .into_iter()
                .enumerate()
                .map(|(i, scope)| {
                    let values = (0..1 << scope.len())
                        .map(|j| ((seed * 17 + i * 7 + j * 13) % 43) as f64 * b / 10.0)
                        .collect();
                    Factor { scope, values }
                })
                .collect();
            let q = enumerate(3, &factors);
            let oracle = ReferenceLmsr::new(3, b, q.clone()).unwrap();
            for order in orders {
                let model = FactoredLmsr::new(3, b, factors.clone(), order.to_vec()).unwrap();
                close(model.cost(), oracle.cost());
                close(model.max_liability(), q.iter().copied().fold(0.0, f64::max));
                assert_eq!(model.peak_table_entries(), 8);
                // Ternary enumeration: unobserved, false, true for each event.
                for code in 0..27 {
                    let mut code = code;
                    let mut evidence = vec![];
                    for event in 0..3 {
                        if code % 3 != 0 {
                            evidence.push((event, code % 3 == 2));
                        }
                        code /= 3;
                    }
                    let mut mask = 0;
                    for state in 0..8 {
                        if evidence
                            .iter()
                            .all(|&(event, yes)| (state & (1 << event) != 0) == yes)
                        {
                            mask |= 1 << state;
                        }
                    }
                    close(
                        model.probability(&evidence).unwrap(),
                        oracle.probability(Payoff::new(3, mask).unwrap()).unwrap(),
                    );
                }
            }
        }
    }
}

#[test]
fn disconnected_and_constant_factors_keep_the_state_count_and_cost_offset() {
    let model = FactoredLmsr::new(
        3,
        10.0,
        vec![Factor {
            scope: vec![],
            values: vec![7.0],
        }],
        vec![2, 0, 1],
    )
    .unwrap();
    close(model.cost(), 7.0 + 10.0 * 8_f64.ln());
    close(model.max_liability(), 7.0);
    close(model.probability(&[(2, true), (0, false)]).unwrap(), 0.25);
    assert_eq!(model.induced_width(), 0);
    assert_eq!(model.peak_table_entries(), 2);
    let uniform = FactoredLmsr::new(1, 1.0, vec![], vec![0]).unwrap();
    close(uniform.cost(), 2_f64.ln());
    assert_eq!(uniform.max_liability(), 0.0);
}

#[test]
fn thirty_two_event_chain_uses_four_entry_tables_and_matches_closed_form() {
    let factors = (0..31)
        .map(|i| Factor {
            scope: vec![i, i + 1],
            values: vec![0.0, 1.0, 1.0, 0.0],
        })
        .collect();
    let model = FactoredLmsr::new(32, 10.0, factors, (0..32).collect()).unwrap();
    close(
        model.cost(),
        10.0 * (2_f64.ln() + 31.0 * 0.1_f64.exp().ln_1p()),
    );
    close(model.max_liability(), 31.0);
    close(model.probability(&[(31, true)]).unwrap(), 0.5);
    let correlation = ((1.0 - 0.1_f64.exp()) / (1.0 + 0.1_f64.exp())).powi(31);
    close(
        model.probability(&[(0, false), (31, false)]).unwrap(),
        (1.0 + correlation) / 4.0,
    );
    assert_eq!(model.induced_width(), 1);
    assert_eq!(model.peak_table_entries(), 4);
}

#[test]
fn supplied_order_and_new_scope_are_both_checked_for_fill_in() {
    let star: Vec<_> = (1..4)
        .map(|i| Factor {
            scope: vec![0, i],
            values: vec![0.0; 4],
        })
        .collect();
    assert_eq!(
        FactoredLmsr::new(4, 1.0, star.clone(), vec![0, 1, 2, 3]).unwrap_err(),
        FactoredError::WidthExceeded
    );
    let model = FactoredLmsr::new(4, 1.0, star, vec![1, 2, 3, 0]).unwrap();
    assert_eq!(model.induced_width(), 1);
    assert_eq!(model.check_additional_scope(&[1, 2]), Ok(()));
    // Three leaf edges plus the center form K4, requiring width three.
    assert_eq!(
        model.check_additional_scope(&[1, 2, 3]),
        Err(FactoredError::WidthExceeded)
    );
    // The same leaf conjunction is still cheap to QUERY by clamping evidence.
    close(
        model
            .probability(&[(1, true), (2, true), (3, true)])
            .unwrap(),
        0.125,
    );
    assert_eq!(
        model.check_additional_scope(&[0, 1, 2, 3]),
        Err(FactoredError::InvalidScope)
    );
    assert_eq!(
        model.check_additional_scope(&[]),
        Err(FactoredError::InvalidScope)
    );
}

#[test]
fn width_two_cycle_and_noncontiguous_scopes_match_a_separate_enumerator() {
    let factors: Vec<_> = [vec![0, 1], vec![1, 2], vec![2, 3], vec![0, 3]]
        .into_iter()
        .map(|scope| Factor {
            scope,
            values: vec![0.0, 0.5, 2.0, 1.0],
        })
        .collect();
    let q = enumerate(4, &factors);
    let model = FactoredLmsr::new(4, 2.0, factors, vec![0, 1, 2, 3]).unwrap();
    close(
        model.cost(),
        2.0 * q.iter().map(|q| (q / 2.0).exp()).sum::<f64>().ln(),
    );
    close(model.max_liability(), q.into_iter().fold(0.0, f64::max));
    assert_eq!(model.induced_width(), 2);
}

#[test]
fn log_domain_preserves_rare_probabilities_at_the_numeric_boundary() {
    let model = FactoredLmsr::new(
        1,
        1.0,
        vec![Factor {
            scope: vec![0],
            values: vec![0.0, 100.0],
        }],
        vec![0],
    )
    .unwrap();
    close(
        model.probability(&[(0, false)]).unwrap(),
        1.0 / (1.0 + 100_f64.exp()),
    );
    close(model.cost(), 100.0);
    close(model.max_liability(), 100.0);
}

#[test]
fn rejects_invalid_domains_and_capacity_without_mutating_snapshots() {
    for events in [0, 33] {
        assert!(FactoredLmsr::new(events, 1.0, vec![], vec![]).is_err());
    }
    for b in [0.0, -1.0, f64::NAN, f64::INFINITY, 1e-7, 1e10] {
        assert!(FactoredLmsr::new(1, b, vec![], vec![0]).is_err());
    }
    for order in [vec![], vec![0, 0], vec![0, 2], vec![0]] {
        assert_eq!(
            FactoredLmsr::new(2, 1.0, vec![], order).unwrap_err(),
            FactoredError::InvalidOrder
        );
    }
    for factor in [
        Factor {
            scope: vec![1, 0],
            values: vec![0.0; 4],
        },
        Factor {
            scope: vec![0, 0],
            values: vec![0.0; 4],
        },
        Factor {
            scope: vec![2],
            values: vec![0.0; 2],
        },
        Factor {
            scope: vec![0],
            values: vec![0.0],
        },
        Factor {
            scope: vec![0],
            values: vec![f64::NAN, 0.0],
        },
        Factor {
            scope: vec![0],
            values: vec![-1.0, 0.0],
        },
        Factor {
            scope: vec![0],
            values: vec![f64::INFINITY, 0.0],
        },
    ] {
        assert!(FactoredLmsr::new(2, 1.0, vec![factor], vec![0, 1]).is_err());
    }
    let constant = Factor {
        scope: vec![],
        values: vec![1.0],
    };
    assert_eq!(
        FactoredLmsr::new(1, 1.0, vec![constant.clone(); 65], vec![0]).unwrap_err(),
        FactoredError::TooManyFactors
    );
    let full = FactoredLmsr::new(1, 1.0, vec![constant; 64], vec![0]).unwrap();
    assert_eq!(
        full.check_additional_scope(&[0]),
        Err(FactoredError::TooManyFactors)
    );
    assert_eq!(
        full.probability(&[(1, true)]),
        Err(FactoredError::InvalidEvidence)
    );
    assert_eq!(
        full.probability(&[(0, true), (0, false)]),
        Err(FactoredError::InvalidEvidence)
    );
    close(full.cost(), 64.0 + 2_f64.ln());
    // Conservative sum-of-maxima bound rejects even mutually exclusive contributions.
    let excessive = vec![
        Factor {
            scope: vec![0],
            values: vec![60.0, 0.0],
        },
        Factor {
            scope: vec![0],
            values: vec![0.0, 60.0],
        },
    ];
    assert_eq!(
        FactoredLmsr::new(1, 1.0, excessive, vec![0]).unwrap_err(),
        FactoredError::InvalidValues
    );
}

#[test]
fn every_local_boolean_trade_matches_enumerated_quotes_and_updated_distribution() {
    for scope_bits in 1_u8..8 {
        let scope: Vec<_> = (0..3).filter(|i| scope_bits & (1 << i) != 0).collect();
        let states = 1_usize << scope.len();
        let full = ((1_u16 << states) - 1) as u8;
        for b in [1e-6, 100.0, 1e9] {
            let factors = vec![
                Factor {
                    scope: scope.clone(),
                    values: (0..states).map(|i| b * (2.0 + i as f64 / 4.0)).collect(),
                },
                Factor {
                    scope: vec![0, 2],
                    values: vec![0.0, b / 2.0, b, b / 4.0],
                },
            ];
            let liabilities = enumerate(3, &factors);
            let oracle = ReferenceLmsr::new(3, b, liabilities.clone()).unwrap();
            let model = FactoredLmsr::new(3, b, factors, vec![2, 0, 1]).unwrap();
            for mask in 1..full {
                let global_mask = (0..8).fold(0, |global, state| {
                    let local = scope.iter().enumerate().fold(0, |index, (bit, event)| {
                        index | (((state >> event) & 1) << bit)
                    });
                    global
                        | if mask & (1 << local) != 0 {
                            1 << state
                        } else {
                            0
                        }
                });
                let claim = Payoff::new(3, global_mask).unwrap();
                for quantity in [-b, -b / 1e9, 0.0, b / 1e9, b] {
                    let (expected, oracle_after) = oracle.simulate_trade(claim, quantity).unwrap();
                    let (paid, after) = model.simulate_trade(&scope, mask, quantity).unwrap();
                    close(paid, expected);
                    close(after.cost(), oracle_after.cost());
                    if quantity.abs() == b {
                        close(paid, oracle_after.cost() - oracle.cost());
                    }
                    let maximum = liabilities
                        .iter()
                        .enumerate()
                        .map(|(state, q)| {
                            q + if global_mask & (1 << state) != 0 {
                                quantity
                            } else {
                                0.0
                            }
                        })
                        .fold(0.0, f64::max);
                    close(after.max_liability(), maximum);
                    for state in 0..8 {
                        let evidence: Vec<_> = (0..3)
                            .map(|event| (event, state & (1 << event) != 0))
                            .collect();
                        close(
                            after.probability(&evidence).unwrap(),
                            oracle_after.distribution()[state],
                        );
                    }
                    let (refund, restored) = after.simulate_trade(&scope, mask, -quantity).unwrap();
                    close(paid, -refund);
                    close(restored.cost(), model.cost());
                    close(restored.max_liability(), model.max_liability());
                }
            }
            close(model.cost(), oracle.cost());
        }
    }
}

#[test]
fn trade_scope_reuse_merges_duplicates_and_does_not_spend_capacity() {
    let mut factors = vec![
        Factor {
            scope: vec![],
            values: vec![0.0]
        };
        62
    ];
    for _ in 0..2 {
        factors.push(Factor {
            scope: vec![0],
            values: vec![0.0, 0.5],
        });
    }
    let model = FactoredLmsr::new(2, 10.0, factors, vec![0, 1]).unwrap();
    assert_eq!(
        model.check_additional_scope(&[0]),
        Err(FactoredError::TooManyFactors)
    );
    assert_eq!(
        model.simulate_trade(&[1], 2, 1.0).unwrap_err(),
        FactoredError::TooManyFactors
    );
    // Selling consumes the aggregate of both exact-scope tables.
    let (_, sold) = model.simulate_trade(&[0], 2, -1.0).unwrap();
    close(sold.cost(), 10.0 * 4_f64.ln());
    let (_, bought) = sold.simulate_trade(&[1], 2, 1.0).unwrap();
    let mut current = bought;
    for _ in 0..80 {
        current = current.simulate_trade(&[1], 2, 0.1).unwrap().1;
    }
    close(current.max_liability(), 9.0);
}

#[test]
fn rejected_trades_preserve_snapshot_and_enforce_local_selling_limits() {
    let model = FactoredLmsr::new(
        4,
        1.0,
        (1..4)
            .map(|i| Factor {
                scope: vec![0, i],
                values: vec![1.0; 4],
            })
            .collect(),
        vec![1, 2, 3, 0],
    )
    .unwrap();
    let before = model.cost();
    assert_eq!(
        model.simulate_trade(&[1, 2, 3], 128, 1.0).unwrap_err(),
        FactoredError::WidthExceeded
    );
    // Global q is positive, but there is no exact-scope table to sell from.
    assert_eq!(
        model.simulate_trade(&[1], 2, -1.0).unwrap_err(),
        FactoredError::InvalidValues
    );
    for (scope, mask) in [
        (vec![], 1),
        (vec![1, 0], 2),
        (vec![0, 0], 2),
        (vec![4], 2),
        (vec![0, 1, 2, 3], 2),
        (vec![0], 0),
        (vec![0], 3),
        (vec![0], 4),
    ] {
        assert!(model.simulate_trade(&scope, mask, 1.0).is_err());
        assert!(model.simulate_trade(&scope, mask, 0.0).is_err());
    }
    for quantity in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        1.01,
        -1.01,
        1e-10,
        -1e-10,
    ] {
        assert_eq!(
            model.simulate_trade(&[0], 2, quantity).unwrap_err(),
            FactoredError::InvalidQuantity
        );
    }
    close(model.cost(), before);
    assert_eq!(model.induced_width(), 1);
    // No-op does not add an otherwise unsupported scope.
    let (paid, after) = model.simulate_trade(&[1, 2, 3], 128, 0.0).unwrap();
    assert_eq!(paid, 0.0);
    close(after.cost(), before);
    assert_eq!(after.induced_width(), 1);
    let (_, after) = model.simulate_trade(&[1, 2], 8, 1.0).unwrap();
    assert_eq!(after.induced_width(), 2);

    let limit = FactoredLmsr::new(
        1,
        1.0,
        vec![Factor {
            scope: vec![0],
            values: vec![0.0, 100.0],
        }],
        vec![0],
    )
    .unwrap();
    assert_eq!(
        limit.simulate_trade(&[0], 2, 1.0).unwrap_err(),
        FactoredError::InvalidValues
    );
    close(limit.max_liability(), 100.0);
}

#[test]
fn thirty_two_event_trade_roundtrip_preserves_bounded_tables() {
    let model = FactoredLmsr::new(32, 10.0, vec![], (0..32).collect()).unwrap();
    let (paid, after) = model.simulate_trade(&[0, 15, 31], 128, 10.0).unwrap();
    close(paid, 10.0 * (0.125 * 1_f64.exp_m1()).ln_1p());
    close(after.max_liability(), 10.0);
    assert_eq!(after.peak_table_entries(), 8);
    close(
        after
            .probability(&[(0, true), (15, true), (31, true)])
            .unwrap(),
        1_f64.exp() / (7.0 + 1_f64.exp()),
    );
    let (refund, restored) = after.simulate_trade(&[0, 15, 31], 128, -10.0).unwrap();
    close(refund, -paid);
    close(restored.cost(), model.cost());
    assert_eq!(restored.max_liability(), 0.0);
    // Zero tables retain their declared graph; trading never silently rewrites it.
    assert_eq!(restored.peak_table_entries(), 8);
}
