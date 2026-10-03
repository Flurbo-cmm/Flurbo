use flurbo_core::{
    Payoff, PayoffError,
    accounting::{AccountingError, ReferenceLedger},
};

fn rejected(
    ledger: &mut ReferenceLedger,
    expected: AccountingError,
    action: impl FnOnce(&mut ReferenceLedger) -> Result<(), AccountingError>,
) {
    let before = ledger.clone();
    assert_eq!(action(ledger), Err(expected));
    assert_eq!(*ledger, before, "failed operation changed stored state");
}

#[test]
fn overlapping_claims_track_each_owner_and_partial_sales() {
    let a = Payoff::event(2, 0).unwrap();
    let both = a.intersection(Payoff::event(2, 1).unwrap()).unwrap();
    let mut ledger = ReferenceLedger::new(2, 100).unwrap();
    ledger.record_buy(1, a, 10, 6).unwrap();
    ledger.record_buy(2, both, 7, 3).unwrap();
    assert_eq!(ledger.liabilities(), [0, 10, 0, 17]);
    assert_eq!(ledger.collateral(), 109);
    ledger.record_sell(1, a, 4, 2).unwrap();
    assert_eq!(ledger.holdings(1, a).unwrap(), 6);
    assert_eq!(ledger.holdings(2, both).unwrap(), 7);
    assert_eq!(ledger.holdings(1, both).unwrap(), 0);
    assert_eq!(ledger.liabilities(), [0, 6, 0, 13]);
    assert_eq!(ledger.headroom(), 94);
    ledger.record_sell(2, both, 7, 5).unwrap();
    ledger.record_sell(1, a, 6, 4).unwrap();
    assert_eq!(ledger.liabilities(), [0; 4]);
    assert_eq!(ledger.holdings(1, a).unwrap(), 0);
    assert_eq!(ledger.holdings(2, both).unwrap(), 0);
    assert_eq!(ledger.collateral(), 100 + 6 + 3 - 2 - 5 - 4);
}

#[test]
fn coverage_uses_largest_terminal_payout_and_protects_other_holders() {
    let a = Payoff::event(2, 0).unwrap();
    let mut ledger = ReferenceLedger::new(2, 10).unwrap();
    // Zero-cash receipts intentionally isolate coverage from pricing.
    ledger.record_buy(1, a, 10, 0).unwrap();
    ledger.record_buy(2, a.complement(), 10, 0).unwrap();
    assert_eq!(ledger.liabilities(), [10; 4]);
    assert_eq!(ledger.required_collateral(), 10);
    assert_eq!(ledger.headroom(), 0);
    rejected(&mut ledger, AccountingError::UncoveredLiability, |l| {
        l.record_buy(1, a, 1, 0)
    });
    rejected(&mut ledger, AccountingError::UncoveredLiability, |l| {
        l.record_sell(1, a, 1, 1)
    });
    rejected(&mut ledger, AccountingError::InsufficientCollateral, |l| {
        l.record_sell(1, a, 1, 11)
    });
    ledger.record_sell(1, a, 10, 0).unwrap();
    assert_eq!(ledger.liabilities(), [10, 0, 10, 0]);
}

#[test]
fn ownership_is_specific_to_user_and_canonical_claim() {
    let a = Payoff::event(2, 0).unwrap();
    let both = Payoff::new(2, 8).unwrap();
    let mut ledger = ReferenceLedger::new(2, 10).unwrap();
    ledger.record_buy(1, a, 5, 2).unwrap();
    for (owner, claim, quantity) in [(2, a, 1), (1, both, 1), (1, a, 6)] {
        rejected(&mut ledger, AccountingError::InsufficientHoldings, |l| {
            l.record_sell(owner, claim, quantity, 0)
        });
    }
    let equivalent = a.intersection(a).unwrap();
    ledger.record_sell(1, equivalent, 5, 2).unwrap();
    assert_eq!(ledger.collateral(), 10);
}

#[test]
fn invalid_claims_and_zero_quantities_cannot_move_cash() {
    assert_eq!(
        ReferenceLedger::new(0, 0),
        Err(AccountingError::Payoff(PayoffError::UnsupportedEventCount))
    );
    let a = Payoff::event(2, 0).unwrap();
    let mut ledger = ReferenceLedger::new(2, 10).unwrap();
    for claim in [Payoff::new(2, 0).unwrap(), Payoff::new(2, 15).unwrap()] {
        rejected(
            &mut ledger,
            AccountingError::Payoff(PayoffError::ConstantClaim),
            |l| l.record_buy(1, claim, 1, 1),
        );
    }
    rejected(
        &mut ledger,
        AccountingError::Payoff(PayoffError::DifferentStateSpaces),
        |l| l.record_buy(1, Payoff::event(3, 0).unwrap(), 1, 1),
    );
    rejected(&mut ledger, AccountingError::ZeroQuantity, |l| {
        l.record_buy(1, a, 0, 10)
    });
    rejected(&mut ledger, AccountingError::ZeroQuantity, |l| {
        l.record_sell(1, a, 0, 10)
    });
}

#[test]
fn large_integer_amounts_are_exact_and_all_additions_check_overflow() {
    let a = Payoff::event(2, 0).unwrap();
    let exact = (1_u128 << 80) + 1;
    let mut ledger = ReferenceLedger::new(2, exact).unwrap();
    ledger.record_buy(1, a, exact, 1).unwrap();
    ledger.record_sell(1, a, exact - 1, 1).unwrap();
    assert_eq!(ledger.liabilities(), [0, 1, 0, 1]);
    assert_eq!(ledger.holdings(1, a).unwrap(), 1);
    assert_eq!(ledger.collateral(), exact);

    let mut full = ReferenceLedger::new(2, u128::MAX).unwrap();
    rejected(&mut full, AccountingError::ArithmeticOverflow, |l| {
        l.record_buy(1, a, 1, 1)
    });
    full.record_buy(1, a, u128::MAX, 0).unwrap();
    rejected(&mut full, AccountingError::ArithmeticOverflow, |l| {
        l.record_buy(1, a, 1, 0)
    });
    // Another owner fits individually, but their overlapping state liability overflows.
    rejected(&mut full, AccountingError::ArithmeticOverflow, |l| {
        l.record_buy(2, Payoff::new(2, 8).unwrap(), 1, 0)
    });
}

#[test]
fn every_three_event_claim_matches_independently_rebuilt_liabilities() {
    let mut ledger = ReferenceLedger::new(3, 0).unwrap();
    let mut positions = Vec::new();
    for mask in 1..255 {
        let claim = Payoff::new(3, mask).unwrap();
        let quantity = u128::from(mask) + 1;
        let owner = u64::from(mask % 3);
        ledger.record_buy(owner, claim, quantity, quantity).unwrap();
        positions.push((claim, quantity));
        for state in 0..8 {
            let expected: u128 = positions
                .iter()
                .map(|(c, q)| u128::from(c.payout(state).unwrap()) * q)
                .sum();
            assert_eq!(ledger.liabilities()[usize::from(state)], expected);
        }
        assert!(ledger.collateral() >= ledger.required_collateral());
    }
    for (claim, quantity) in positions.into_iter().rev() {
        ledger
            .record_sell(u64::from(claim.mask() % 3), claim, quantity, quantity)
            .unwrap();
        assert!(ledger.collateral() >= ledger.required_collateral());
    }
    assert_eq!(ledger.liabilities(), [0; 8]);
    assert_eq!(ledger.collateral(), 0);
}
