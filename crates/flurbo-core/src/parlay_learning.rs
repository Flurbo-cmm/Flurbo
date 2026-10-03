//! Research comparison only: ParlayMarket v3 eqs. 11, 13 and Appendix C.2.
//! Exact enumeration (1..=8 events), not the production bounded-width pool.
//! Virtual shadow books are never ownership, collateral, or executable quotes.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LearningError {
    EventCount,
    Parameters,
    NumericDomain,
    Scope,
    Target,
    Rate,
    Liquidity,
    Quantity,
}

const EPS: f64 = 1e-10;

/// Separate rates reproduce the paper's field/coupling configuration and ablations.
#[derive(Clone, Copy, Debug)]
pub struct Rates {
    pub fields: f64,
    pub pairs: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IsingModel {
    events: u8,
    /// Fields first, then pair couplings (0,1), (0,2), ..., (n-2,n-1).
    parameters: Vec<f64>,
}

impl IsingModel {
    pub fn new(events: u8, parameters: Vec<f64>) -> Result<Self, LearningError> {
        if !(1..=8).contains(&events) {
            return Err(LearningError::EventCount);
        }
        let n = usize::from(events);
        if parameters.len() != n * (n + 1) / 2
            || parameters.iter().any(|v| !v.is_finite() || v.abs() > 12.0)
        {
            return Err(LearningError::Parameters);
        }
        let model = Self { events, parameters };
        model.distribution()?;
        Ok(model)
    }

    pub fn uniform(events: u8) -> Result<Self, LearningError> {
        if !(1..=8).contains(&events) {
            return Err(LearningError::EventCount);
        }
        let n = usize::from(events);
        Self::new(events, vec![0.0; n * (n + 1) / 2])
    }

    pub fn events(&self) -> u8 {
        self.events
    }

    pub fn parameters(&self) -> &[f64] {
        &self.parameters
    }

    pub fn scopes(&self) -> std::ops::Range<u16> {
        1..(1_u16 << self.events)
    }

    fn check_scope(&self, scope: u16) -> Result<(), LearningError> {
        if !self.scopes().contains(&scope) {
            return Err(LearningError::Scope);
        }
        Ok(())
    }

    fn features(&self, state: u16) -> Vec<f64> {
        let mut features = Vec::with_capacity(self.parameters.len());
        for i in 0..self.events {
            features.push(f64::from(u8::from(state & (1 << i) != 0)));
        }
        for i in 0..self.events {
            for j in i + 1..self.events {
                features.push(f64::from(u8::from(
                    state & ((1 << i) | (1 << j)) == ((1 << i) | (1 << j)),
                )));
            }
        }
        features
    }

    /// Stable exact normalization; no loopy belief propagation or silent clipping.
    pub fn distribution(&self) -> Result<Vec<f64>, LearningError> {
        let energies: Vec<f64> = (0..(1_u16 << self.events))
            .map(|s| {
                self.features(s)
                    .iter()
                    .zip(&self.parameters)
                    .map(|(f, p)| f * p)
                    .sum()
            })
            .collect();
        let high = energies.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let low = energies.iter().copied().fold(f64::INFINITY, f64::min);
        if high - low > 24.0 {
            return Err(LearningError::NumericDomain);
        }
        let weights: Vec<f64> = energies.iter().map(|e| (e - high).exp()).collect();
        let z: f64 = weights.iter().sum();
        Ok(weights.into_iter().map(|w| w / z).collect())
    }

    pub fn probability(&self, scope: u16) -> Result<f64, LearningError> {
        self.check_scope(scope)?;
        Ok(probability(&self.distribution()?, scope))
    }

    /// Derivative of CE(target, P(all events in scope are YES)). Appendix C.2.
    pub fn gradient(&self, scope: u16, target: f64) -> Result<Vec<f64>, LearningError> {
        self.check_scope(scope)?;
        if !target.is_finite() || !(EPS..=1.0 - EPS).contains(&target) {
            return Err(LearningError::Target);
        }
        let distribution = self.distribution()?;
        let q = probability(&distribution, scope);
        check_probability(q)?;
        let mut mean = vec![0.0; self.parameters.len()];
        let mut conditional = mean.clone();
        for (s, mass) in distribution.iter().enumerate() {
            for (i, feature) in self.features(s as u16).iter().enumerate() {
                mean[i] += mass * feature;
                if (s as u16) & scope == scope {
                    conditional[i] += mass * feature / q;
                }
            }
        }
        Ok(mean
            .iter()
            .zip(conditional)
            .map(|(m, c)| (q - target) / (1.0 - q) * (c - m))
            .collect())
    }

    pub fn updated(&self, scope: u16, target: f64, rates: Rates) -> Result<Self, LearningError> {
        if [rates.fields, rates.pairs]
            .iter()
            .any(|r| !r.is_finite() || !(0.0..=1.0).contains(r))
        {
            return Err(LearningError::Rate);
        }
        let gradient = self.gradient(scope, target)?;
        let parameters = self
            .parameters
            .iter()
            .zip(gradient)
            .enumerate()
            .map(|(i, (p, g))| {
                p - if i < usize::from(self.events) {
                    rates.fields
                } else {
                    rates.pairs
                } * g
            })
            .collect();
        Self::new(self.events, parameters)
    }
}

fn probability(distribution: &[f64], scope: u16) -> f64 {
    distribution
        .iter()
        .enumerate()
        .filter(|(s, _)| (*s as u16) & scope == scope)
        .map(|(_, p)| p)
        .sum()
}

fn check_probability(p: f64) -> Result<(), LearningError> {
    if !p.is_finite() || !(EPS..=1.0 - EPS).contains(&p) {
        return Err(LearningError::NumericDomain);
    }
    Ok(())
}

fn logit(p: f64) -> f64 {
    p.ln() - (-p).ln_1p()
}

fn sigmoid(x: f64) -> f64 {
    if x >= 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let e = x.exp();
        e / (1.0 + e)
    }
}

#[derive(Clone, Debug)]
pub struct ShadowTrade {
    pub scope: u16,
    pub before_probability: f64,
    pub after_probability: f64,
    /// Imbalance after the real order (if this is the traded scope), before shadowing.
    pub starting_imbalance: f64,
    pub virtual_quantity: f64,
    pub ending_imbalance: f64,
}

#[derive(Clone, Debug)]
pub struct LearningStep {
    pub scope: u16,
    pub target: f64,
    pub gradient: Vec<f64>,
    /// None means an explicit probability observation, not an executed trade.
    pub order_quantity: Option<f64>,
    /// Hypothetical binary LMSR cost before learning; NOT on-chain or executable.
    pub reference_cost: Option<f64>,
    pub shadows: Vec<ShadowTrade>,
}

/// Exact model plus a virtual two-outcome LMSR imbalance for every YES conjunction.
/// Shadow quantities reconcile b*logit(p) after one SGD step. They never mint claims.
#[derive(Clone, Debug, PartialEq)]
pub struct LearningMarket {
    model: IsingModel,
    liquidity: f64,
    imbalances: Vec<f64>,
}

impl LearningMarket {
    pub fn new(model: IsingModel, liquidity: f64) -> Result<Self, LearningError> {
        if !liquidity.is_finite() || !(1e-6..=1e9).contains(&liquidity) {
            return Err(LearningError::Liquidity);
        }
        let distribution = model.distribution()?;
        let mut imbalances = Vec::new();
        for scope in model.scopes() {
            let p = probability(&distribution, scope);
            check_probability(p)?;
            imbalances.push(liquidity * logit(p));
        }
        Ok(Self {
            model,
            liquidity,
            imbalances,
        })
    }

    pub fn model(&self) -> &IsingModel {
        &self.model
    }

    pub fn imbalances(&self) -> &[f64] {
        &self.imbalances
    }

    pub fn observe(
        &mut self,
        scope: u16,
        target: f64,
        rates: Rates,
    ) -> Result<LearningStep, LearningError> {
        self.step(scope, target, rates, None)
    }

    /// Explicit adapter: signed YES shares imply a post-order binary-LMSR target.
    /// This assumption is not a claim to know a real trader's probability belief.
    pub fn trade_signal(
        &mut self,
        scope: u16,
        quantity: f64,
        rates: Rates,
    ) -> Result<LearningStep, LearningError> {
        self.model.check_scope(scope)?;
        if !quantity.is_finite() || quantity == 0.0 || quantity.abs() > self.liquidity {
            return Err(LearningError::Quantity);
        }
        let p = self.model.probability(scope)?;
        let target = sigmoid(logit(p) + quantity / self.liquidity);
        self.step(scope, target, rates, Some(quantity))
    }

    fn step(
        &mut self,
        scope: u16,
        target: f64,
        rates: Rates,
        order: Option<f64>,
    ) -> Result<LearningStep, LearningError> {
        // Build a complete candidate first; every error leaves model AND books unchanged.
        let gradient = self.model.gradient(scope, target)?;
        let model = self.model.updated(scope, target, rates)?;
        let candidate = Self::new(model, self.liquidity)?;
        let before = self.model.distribution()?;
        let after = candidate.model.distribution()?;
        let mut shadows = Vec::new();
        for s in self.model.scopes() {
            let index = usize::from(s - 1);
            let starting = self.imbalances[index]
                + if s == scope {
                    order.unwrap_or(0.0)
                } else {
                    0.0
                };
            let ending = candidate.imbalances[index];
            shadows.push(ShadowTrade {
                scope: s,
                before_probability: probability(&before, s),
                after_probability: probability(&after, s),
                starting_imbalance: starting,
                virtual_quantity: ending - starting,
                ending_imbalance: ending,
            });
        }
        let p = probability(&before, scope);
        let reference_cost = order
            .map(|quantity| self.liquidity * (p * (quantity / self.liquidity).exp_m1()).ln_1p());
        *self = candidate;
        Ok(LearningStep {
            scope,
            target,
            gradient,
            order_quantity: order,
            reference_cost,
            shadows,
        })
    }
}
