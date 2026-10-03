//! Enumerated LMSR reference oracle for testing future fixed-point/factored code.
//! Floating-point outputs must never authorize transfers or settle positions.

use crate::{Payoff, PayoffError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingError {
    Payoff(PayoffError),
    InvalidLiquidity,
    InvalidLiabilities,
    InvalidQuantity,
    ImpossibleCondition,
}

impl From<PayoffError> for PricingError {
    fn from(error: PayoffError) -> Self {
        Self::Payoff(error)
    }
}

/// Uniform-prior, fixed-b snapshot. All amounts use whole collateral units.
#[derive(Clone, Debug)]
pub struct ReferenceLmsr {
    space: Payoff,
    b: f64,
    liabilities: Vec<f64>,
}

impl ReferenceLmsr {
    /// Prototype domain: 1e-6 <= b <= 1e9 and 0 <= q[x]/b <= 100.
    /// These are reference-computation limits, not chosen deployment parameters.
    pub fn new(events: u8, b: f64, liabilities: Vec<f64>) -> Result<Self, PricingError> {
        let space = Payoff::new(events, 0)?;
        if !b.is_finite() || !(1e-6..=1e9).contains(&b) {
            return Err(PricingError::InvalidLiquidity);
        }
        if liabilities.len() != usize::from(space.state_count())
            || liabilities
                .iter()
                .any(|q| !q.is_finite() || !(0.0..=100.0).contains(&(q / b)))
        {
            return Err(PricingError::InvalidLiabilities);
        }
        Ok(Self {
            space,
            b,
            liabilities,
        })
    }

    fn weights(&self) -> (f64, Vec<f64>) {
        let max = self.liabilities.iter().copied().fold(0.0, f64::max);
        let weights = self
            .liabilities
            .iter()
            .map(|q| ((q - max) / self.b).exp())
            .collect();
        (max, weights)
    }

    /// C(q) via log-sum-exp; includes the initial b*ln(number of states).
    pub fn cost(&self) -> f64 {
        let (max, weights) = self.weights();
        max + self.b * weights.iter().sum::<f64>().ln()
    }

    pub fn distribution(&self) -> Vec<f64> {
        let (_, weights) = self.weights();
        let total: f64 = weights.iter().sum();
        weights.iter().map(|w| w / total).collect()
    }

    /// Infinitesimal price, not the average fill price for a finite trade.
    pub fn probability(&self, claim: Payoff) -> Result<f64, PricingError> {
        self.space.union(claim)?;
        Ok(self
            .distribution()
            .iter()
            .enumerate()
            .filter(|(state, _)| claim.mask() & (1 << state) != 0)
            .map(|(_, probability)| probability)
            .sum())
    }

    /// Analytics only: this does not define a tradable conditional security.
    pub fn conditional_probability(
        &self,
        claim: Payoff,
        given: Payoff,
    ) -> Result<f64, PricingError> {
        let joint = self.probability(claim.intersection(given)?)?;
        let denominator = self.probability(given)?;
        if denominator == 0.0 {
            return Err(PricingError::ImpossibleCondition);
        }
        Ok(joint / denominator)
    }

    /// Positive quantity buys; negative quantity sells. Returns signed collateral
    /// paid to the pool and a new snapshot, without mutating this one.
    /// No fees, ownership, balances, or solvency checks: this is a math simulation.
    /// Nonzero quantities require 1e-9 <= abs(quantity/b) <= 1.
    pub fn simulate_trade(
        &self,
        claim: Payoff,
        quantity: f64,
    ) -> Result<(f64, Self), PricingError> {
        claim.validate_tradable()?;
        let probability = self.probability(claim)?;
        let scaled = quantity / self.b;
        if !quantity.is_finite()
            || (quantity != 0.0 && !(self.b / 1e9..=self.b).contains(&quantity.abs()))
        {
            return Err(PricingError::InvalidQuantity);
        }
        let mut next = self.liabilities.clone();
        for (state, liability) in next.iter_mut().enumerate() {
            if claim.mask() & (1 << state) != 0 {
                *liability += quantity;
            }
        }
        let after = Self::new(self.space.event_count(), self.b, next)?;
        // Equivalent to C(q+s*f)-C(q); expm1/log1p avoid cancellation on small trades.
        let collateral = self.b * (probability * scaled.exp_m1()).ln_1p();
        Ok((collateral, after))
    }
}
