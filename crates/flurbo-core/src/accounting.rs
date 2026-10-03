//! Integer reference accounting for a single unresolved cluster.
//! This is not a trading endpoint: callers supply already-authorized collateral
//! movements. This module neither computes prices nor authenticates owners or
//! transfers tokens. Never feed it floating-point quote conversions for execution.

use std::collections::HashMap;

use crate::{Payoff, PayoffError};

/// Local simulation identity, not an authenticated wallet address.
pub type AccountId = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountingError {
    Payoff(PayoffError),
    ZeroQuantity,
    InsufficientHoldings,
    InsufficientCollateral,
    UncoveredLiability,
    ArithmeticOverflow,
    InconsistentLiability,
}

impl From<PayoffError> for AccountingError {
    fn from(error: PayoffError) -> Self {
        Self::Payoff(error)
    }
}

/// Each quantity unit pays one collateral atomic unit in a winning state.
/// All values are u128 atomic units, not whole-token amounts. One instance owns
/// one cluster's accounting; cross-cluster identity is a future integration concern.
/// No settlement, deposits/withdrawals after creation, transfers, or fees API yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceLedger {
    space: Payoff,
    collateral: u128,
    liabilities: Vec<u128>,
    holdings: HashMap<(AccountId, u8), u128>,
}

enum Side {
    Buy,
    Sell,
}

impl ReferenceLedger {
    /// Records the supplied initial subsidy; this does not calculate the LMSR
    /// funding requirement or verify an external token balance.
    pub fn new(events: u8, subsidy: u128) -> Result<Self, AccountingError> {
        let space = Payoff::new(events, 0)?;
        Ok(Self {
            space,
            collateral: subsidy,
            liabilities: vec![0; usize::from(space.state_count())],
            holdings: HashMap::new(),
        })
    }

    pub fn collateral(&self) -> u128 {
        self.collateral
    }

    pub fn liabilities(&self) -> &[u128] {
        &self.liabilities
    }

    pub fn required_collateral(&self) -> u128 {
        self.liabilities.iter().copied().max().unwrap_or(0)
    }

    /// Coverage surplus, not withdrawable profit.
    pub fn headroom(&self) -> u128 {
        self.collateral - self.required_collateral()
    }

    pub fn holdings(&self, owner: AccountId, claim: Payoff) -> Result<u128, AccountingError> {
        self.space.union(claim)?;
        Ok(*self.holdings.get(&(owner, claim.mask())).unwrap_or(&0))
    }

    /// Records a purchase after the caller validates pricing and collateral receipt.
    /// Coverage alone does not establish a fair or authorized purchase price.
    /// On error, the entire ledger remains unchanged.
    pub fn record_buy(
        &mut self,
        owner: AccountId,
        claim: Payoff,
        quantity: u128,
        collateral_received: u128,
    ) -> Result<(), AccountingError> {
        self.record_trade(owner, claim, quantity, collateral_received, Side::Buy)
    }

    /// Records a sale of owned units at a separately validated collateral payout.
    /// Remaining liabilities, including every other owner's claims, stay covered.
    /// On error, the entire ledger remains unchanged.
    pub fn record_sell(
        &mut self,
        owner: AccountId,
        claim: Payoff,
        quantity: u128,
        collateral_paid: u128,
    ) -> Result<(), AccountingError> {
        self.record_trade(owner, claim, quantity, collateral_paid, Side::Sell)
    }

    fn record_trade(
        &mut self,
        owner: AccountId,
        claim: Payoff,
        quantity: u128,
        cash: u128,
        side: Side,
    ) -> Result<(), AccountingError> {
        let owned = self.holdings(owner, claim)?;
        claim.validate_tradable()?;
        if quantity == 0 {
            return Err(AccountingError::ZeroQuantity);
        }
        let (new_owned, new_collateral) = match side {
            Side::Buy => (
                owned
                    .checked_add(quantity)
                    .ok_or(AccountingError::ArithmeticOverflow)?,
                self.collateral
                    .checked_add(cash)
                    .ok_or(AccountingError::ArithmeticOverflow)?,
            ),
            Side::Sell => (
                owned
                    .checked_sub(quantity)
                    .ok_or(AccountingError::InsufficientHoldings)?,
                self.collateral
                    .checked_sub(cash)
                    .ok_or(AccountingError::InsufficientCollateral)?,
            ),
        };
        let mut liabilities = self.liabilities.clone();
        for (state, liability) in liabilities.iter_mut().enumerate() {
            if claim.mask() & (1 << state) != 0 {
                *liability = match side {
                    Side::Buy => liability
                        .checked_add(quantity)
                        .ok_or(AccountingError::ArithmeticOverflow)?,
                    Side::Sell => liability
                        .checked_sub(quantity)
                        .ok_or(AccountingError::InconsistentLiability)?,
                };
            }
        }
        if liabilities
            .iter()
            .any(|liability| *liability > new_collateral)
        {
            return Err(AccountingError::UncoveredLiability);
        }

        // All fallible checks finish before any stored state changes.
        if new_owned == 0 {
            self.holdings.remove(&(owner, claim.mask()));
        } else {
            self.holdings.insert((owner, claim.mask()), new_owned);
        }
        self.liabilities = liabilities;
        self.collateral = new_collateral;
        Ok(())
    }
}
