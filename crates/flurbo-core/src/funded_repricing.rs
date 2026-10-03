//! Funded learning-to-pricing reference, not transaction authorization.
//! Dense enumeration, f64 math, no wallets or token transfers. See FUNDED_REPRICING.md.

use crate::parlay_learning::IsingModel;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepricingError {
    Domain,
    Claim,
    Quantity,
    Liability,
    StaleRevision,
    FundingLimit,
    MovementLimit,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RepricingReceipt {
    pub reserve_before: f64,
    pub reserve_after: f64,
    /// Hypothetical external contribution, never a debit to trader balances.
    pub funding_added: f64,
    /// Total variation distance bounds the move of every Boolean claim probability.
    pub total_variation: f64,
}

/// One cash account and distinct actual payout / pricing-bias vectors.
/// Every accepted operation returns a new snapshot, leaving its input unchanged.
/// Aggregate liability checks do NOT replace per-owner position checks.
#[derive(Clone, Debug, PartialEq)]
pub struct FundedRepricing {
    events: u8,
    liquidity: f64,
    liabilities: Vec<f64>,
    bias: Vec<f64>,
    cash: f64,
    revision: u64,
}

impl FundedRepricing {
    /// Simulate the initial uniform LMSR subsidy b*ln(2^events).
    pub fn new(events: u8, liquidity: f64) -> Result<Self, RepricingError> {
        if !(1..=8).contains(&events)
            || !liquidity.is_finite()
            || !(1e-6..=1e9).contains(&liquidity)
        {
            return Err(RepricingError::Domain);
        }
        let mut market = Self {
            events,
            liquidity,
            liabilities: vec![0.0; 1 << events],
            bias: vec![0.0; 1 << events],
            cash: 0.0,
            revision: 0,
        };
        market.cash = market.required_reserve();
        Ok(market)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn liabilities(&self) -> &[f64] {
        &self.liabilities
    }

    pub fn bias(&self) -> &[f64] {
        &self.bias
    }

    pub fn cash(&self) -> f64 {
        self.cash
    }

    pub fn max_liability(&self) -> f64 {
        self.liabilities.iter().copied().fold(0.0, f64::max)
    }

    /// C_bias(q) - min(bias). Bias is normalized to minimum zero.
    /// This is a reference real-arithmetic reserve, NOT an integer transfer bound.
    pub fn required_reserve(&self) -> f64 {
        let energies = self.energies();
        let high = energies.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        self.liquidity * (high + energies.iter().map(|v| (v - high).exp()).sum::<f64>().ln())
    }

    pub fn distribution(&self) -> Vec<f64> {
        let energies = self.energies();
        let high = energies.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let weights: Vec<_> = energies.iter().map(|v| (v - high).exp()).collect();
        let z: f64 = weights.iter().sum();
        weights.iter().map(|w| w / z).collect()
    }

    /// Signed cash paid TO the pool, with fixed bias during this trade.
    /// Payoff is one boolean per terminal state (not an API for the on-chain pool).
    /// Caller must independently enforce ownership, deadlines and slippage.
    pub fn simulate_trade(
        &self,
        expected_revision: u64,
        payoff: &[bool],
        quantity: f64,
    ) -> Result<(f64, Self), RepricingError> {
        self.check_revision(expected_revision)?;
        if payoff.len() != self.liabilities.len()
            || !payoff.iter().any(|v| *v)
            || payoff.iter().all(|v| *v)
        {
            return Err(RepricingError::Claim);
        }
        if !quantity.is_finite()
            || !(self.liquidity / 1e9..=self.liquidity).contains(&quantity.abs())
        {
            return Err(RepricingError::Quantity);
        }
        let mut next = self.clone();
        for (q, pays) in next.liabilities.iter_mut().zip(payoff) {
            if *pays {
                *q += quantity;
            }
            if *q < 0.0 || *q > 100.0 * self.liquidity {
                return Err(RepricingError::Liability);
            }
        }
        // Stable cost difference for a binary payoff; avoid subtracting large costs.
        let p: f64 = self
            .distribution()
            .iter()
            .zip(payoff)
            .filter_map(|(p, pays)| pays.then_some(p))
            .sum();
        let paid = self.liquidity * (p * (quantity / self.liquidity).exp_m1()).ln_1p();
        next.cash += paid;
        next.revision += 1;
        Ok((paid, next))
    }

    /// Match a learned joint distribution at CURRENT actual liabilities.
    /// b*ln(p(x))-q(x), shifted by its minimum, changes prices without changing q.
    /// Limits and the revision are supplied explicitly; authentication is outside
    /// this research API. max_funding is hypothetical money available for THIS update.
    pub fn simulate_reprice(
        &self,
        expected_revision: u64,
        model: &IsingModel,
        max_funding: f64,
        max_total_variation: f64,
    ) -> Result<(RepricingReceipt, Self), RepricingError> {
        self.check_revision(expected_revision)?;
        if model.events() != self.events
            || !max_funding.is_finite()
            || max_funding < 0.0
            || !max_total_variation.is_finite()
            || !(0.0..=1.0).contains(&max_total_variation)
        {
            return Err(RepricingError::Domain);
        }
        let probabilities = model.distribution().map_err(|_| RepricingError::Domain)?;
        let movement = self
            .distribution()
            .iter()
            .zip(&probabilities)
            .map(|(old, new)| (new - old).abs())
            .sum::<f64>()
            / 2.0;
        if movement > max_total_variation {
            return Err(RepricingError::MovementLimit);
        }
        let mut next = self.clone();
        next.bias = probabilities
            .iter()
            .zip(&self.liabilities)
            .map(|(p, q)| self.liquidity * p.ln() - q)
            .collect();
        let low = next.bias.iter().copied().fold(f64::INFINITY, f64::min);
        for value in &mut next.bias {
            *value -= low;
        }
        let reserve_after = next.required_reserve();
        let funding_added = (reserve_after - self.cash).max(0.0);
        if funding_added > max_funding {
            return Err(RepricingError::FundingLimit);
        }
        // Retain any surplus. A cheaper update never withdraws funding.
        next.cash = self.cash.max(reserve_after);
        next.revision += 1;
        Ok((
            RepricingReceipt {
                reserve_before: self.required_reserve(),
                reserve_after,
                funding_added,
                total_variation: movement,
            },
            next,
        ))
    }

    fn energies(&self) -> Vec<f64> {
        self.liabilities
            .iter()
            .zip(&self.bias)
            .map(|(q, a)| (q + a) / self.liquidity)
            .collect()
    }

    fn check_revision(&self, expected: u64) -> Result<(), RepricingError> {
        if expected != self.revision || expected == u64::MAX {
            Err(RepricingError::StaleRevision)
        } else {
            Ok(())
        }
    }
}
