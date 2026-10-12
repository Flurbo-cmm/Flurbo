//! Liquidity-sensitive LMSR over factored liabilities. Floating point; never authorizes transfers.

use crate::factored::{Factor, FactoredError, FactoredLmsr};
use std::f64::consts::LN_2;

/// Othman, Pennock, Reeves and Sandholm applied to the 2^events joint answer states with a
/// uniform seed of initial_depth / rate shares per state that nobody owns. The seed cancels in
/// every cost difference, so the state is the liability tables alone and
/// depth = initial_depth + rate * mean_x L(x), rate = commission / (events ln 2).
#[derive(Clone, Debug)]
pub struct LsFactored {
    events: u8,
    initial_depth: f64,
    rate: f64,
    factors: Vec<Factor>,
    order: Vec<u8>,
    inner: FactoredLmsr,
}

impl LsFactored {
    /// commission in [0.01, 0.2]; rate = commission / (events ln 2). Invalid commission or depth: InvalidLiquidity.
    pub fn new(
        events: u8,
        initial_depth: f64,
        commission: f64,
        factors: Vec<Factor>,
        order: Vec<u8>,
    ) -> Result<Self, FactoredError> {
        if !(1..=32).contains(&events) {
            return Err(FactoredError::InvalidEventCount);
        }
        if !commission.is_finite() || !(0.01..=0.2).contains(&commission) {
            return Err(FactoredError::InvalidLiquidity);
        }
        let rate = commission / (f64::from(events) * LN_2);
        Self::with_rate(events, initial_depth, rate, factors, order)
    }

    fn with_rate(
        events: u8,
        initial_depth: f64,
        rate: f64,
        factors: Vec<Factor>,
        order: Vec<u8>,
    ) -> Result<Self, FactoredError> {
        if !initial_depth.is_finite() || initial_depth <= 0.0 {
            return Err(FactoredError::InvalidLiquidity);
        }
        let depth = initial_depth + rate * mean_liability(&factors);
        let inner = FactoredLmsr::new(events, depth, factors.clone(), order.clone())?;
        Ok(Self {
            events,
            initial_depth,
            rate,
            factors,
            order,
            inner,
        })
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    pub fn seed(&self) -> f64 {
        self.initial_depth / self.rate
    }

    pub fn depth(&self) -> f64 {
        self.initial_depth + self.rate * mean_liability(&self.factors)
    }

    /// depth * ln(sum_x exp(L(x) / depth)). Excludes the seed, which cancels in every quote.
    pub fn cost(&self) -> f64 {
        self.inner.cost()
    }

    pub fn max_liability(&self) -> f64 {
        self.inner.max_liability()
    }

    pub fn probability(&self, assignments: &[(u8, bool)]) -> Result<f64, FactoredError> {
        self.inner.probability(assignments)
    }

    /// Instantaneous price of a local claim: w(A) + rate * (popcount(mask) / 2^scope.len()) * H(w).
    pub fn price(&self, scope: &[u8], mask: u8) -> Result<f64, FactoredError> {
        check_claim(self.events, scope, mask)?;
        let mut weight = 0.0;
        for local in 0..1_usize << scope.len() {
            if mask & (1 << local) != 0 {
                weight += self.probability(&assignment(scope, local))?;
            }
        }
        let share = f64::from(mask.count_ones()) / (1_usize << scope.len()) as f64;
        Ok(weight + self.rate * share * self.entropy()?)
    }

    /// Same validation and merging as FactoredLmsr::simulate_trade, quantity limit = current depth.
    /// Returns (after.cost() - self.cost(), after).
    pub fn simulate_trade(
        &self,
        scope: &[u8],
        mask: u8,
        quantity: f64,
    ) -> Result<(f64, Self), FactoredError> {
        check_claim(self.events, scope, mask)?;
        let depth = self.depth();
        if !quantity.is_finite()
            || (quantity != 0.0 && !(depth / 1e9..=depth).contains(&quantity.abs()))
        {
            return Err(FactoredError::InvalidQuantity);
        }
        if quantity == 0.0 {
            return Ok((0.0, self.clone()));
        }
        let mut factors = Vec::with_capacity(self.factors.len() + 1);
        let mut values = vec![0.0; 1 << scope.len()];
        for factor in &self.factors {
            if factor.scope == scope {
                for (total, value) in values.iter_mut().zip(&factor.values) {
                    *total += value;
                }
            } else {
                factors.push(factor.clone());
            }
        }
        for (state, value) in values.iter_mut().enumerate() {
            if mask & (1 << state) != 0 {
                *value += quantity;
            }
        }
        factors.push(Factor {
            scope: scope.to_vec(),
            values,
        });
        let after = Self::with_rate(
            self.events,
            self.initial_depth,
            self.rate,
            factors,
            self.order.clone(),
        )?;
        Ok((after.cost() - self.cost(), after))
    }

    /// H(w) = ln Z - E_w[L] / depth for w(x) proportional to exp(L(x) / depth).
    fn entropy(&self) -> Result<f64, FactoredError> {
        let depth = self.depth();
        let mut expected = 0.0;
        for factor in &self.factors {
            for (local, value) in factor.values.iter().enumerate() {
                if *value != 0.0 {
                    expected += self.probability(&assignment(&factor.scope, local))? * value;
                }
            }
        }
        Ok(self.cost() / depth - expected / depth)
    }
}

fn mean_liability(factors: &[Factor]) -> f64 {
    factors
        .iter()
        .map(|f| f.values.iter().sum::<f64>() / f.values.len() as f64)
        .sum()
}

fn assignment(scope: &[u8], local: usize) -> Vec<(u8, bool)> {
    scope
        .iter()
        .enumerate()
        .map(|(bit, &event)| (event, local & (1 << bit) != 0))
        .collect()
}

fn check_claim(events: u8, scope: &[u8], mask: u8) -> Result<(), FactoredError> {
    if scope.is_empty()
        || scope.len() > 3
        || scope.iter().any(|&event| event >= events)
        || scope.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(FactoredError::InvalidScope);
    }
    let full = ((1_u16 << (1 << scope.len())) - 1) as u8;
    if mask == 0 || mask == full || mask & !full != 0 {
        return Err(FactoredError::InvalidClaim);
    }
    Ok(())
}
