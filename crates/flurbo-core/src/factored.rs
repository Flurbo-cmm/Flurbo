//! Bounded-width LMSR snapshot oracle. Floating point; never authorizes transfers.

#[derive(Clone, Debug)]
pub struct Factor {
    /// Strictly increasing global event indices. Local state bit i selects scope[i].
    pub scope: Vec<u8>,
    /// Nonnegative liability contributions in whole collateral units, not CPT probabilities.
    pub values: Vec<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactoredError {
    InvalidEventCount,
    InvalidLiquidity,
    InvalidScope,
    InvalidValues,
    InvalidOrder,
    InvalidEvidence,
    InvalidClaim,
    InvalidQuantity,
    TooManyFactors,
    WidthExceeded,
}

#[derive(Clone, Debug)]
struct Table {
    scope: u32,
    values: Vec<f64>,
}

/// q(x) = sum of local factor tables; p(x) is proportional to exp(q(x)/b).
/// Supports 1..=32 binary events, <=64 factors, and induced width <=2 under a fixed order.
#[derive(Clone, Debug)]
pub struct FactoredLmsr {
    events: u8,
    b: f64,
    factors: Vec<Table>,
    order: Vec<u8>,
    width: u32,
}

impl FactoredLmsr {
    /// Reference domain: 1e-6 <= b <= 1e9, each contribution >=0, sum of factor maxima / b <=100.
    /// The last check is conservative: incompatible maxima can cause rejection of a valid q.
    pub fn new(
        events: u8,
        b: f64,
        factors: Vec<Factor>,
        order: Vec<u8>,
    ) -> Result<Self, FactoredError> {
        if !(1..=32).contains(&events) {
            return Err(FactoredError::InvalidEventCount);
        }
        if !b.is_finite() || !(1e-6..=1e9).contains(&b) {
            return Err(FactoredError::InvalidLiquidity);
        }
        if factors.len() > 64 {
            return Err(FactoredError::TooManyFactors);
        }
        let mut sorted = order.clone();
        sorted.sort_unstable();
        if sorted != (0..events).collect::<Vec<_>>() {
            return Err(FactoredError::InvalidOrder);
        }
        let mut tables = Vec::with_capacity(factors.len());
        let mut scaled_maxima = 0.0;
        for factor in factors {
            let scope = scope_mask(events, &factor.scope)?;
            if factor.values.len() != 1 << factor.scope.len()
                || factor.values.iter().any(|q| !q.is_finite() || *q < 0.0)
            {
                return Err(FactoredError::InvalidValues);
            }
            scaled_maxima += factor.values.iter().copied().fold(0.0, f64::max) / b;
            tables.push(Table {
                scope,
                values: factor.values,
            });
        }
        if scaled_maxima > 100.0 {
            return Err(FactoredError::InvalidValues);
        }
        let width = induced_width(tables.iter().map(|f| f.scope).collect(), &order)?;
        Ok(Self {
            events,
            b,
            factors: tables,
            order,
            width,
        })
    }

    pub fn induced_width(&self) -> u32 {
        self.width
    }

    /// Largest joined table before eliminating a variable; at most eight entries.
    pub fn peak_table_entries(&self) -> usize {
        1 << (self.width + 1)
    }

    /// Structural check for appending a factor, NOT trade execution or validation of its values.
    /// Never assumes that cheap inference before a trade implies cheap inference after it.
    pub fn check_additional_scope(&self, scope: &[u8]) -> Result<(), FactoredError> {
        if scope.is_empty() {
            return Err(FactoredError::InvalidScope);
        }
        let candidate = scope_mask(self.events, scope)?;
        if self.factors.len() == 64 {
            return Err(FactoredError::TooManyFactors);
        }
        let mut scopes: Vec<_> = self.factors.iter().map(|f| f.scope).collect();
        scopes.push(candidate);
        induced_width(scopes, &self.order).map(|_| ())
    }

    /// b*log(sum_x exp(q(x)/b)), including the initial b*n*ln(2) subsidy.
    pub fn cost(&self) -> f64 {
        self.b * self.eliminate(&[None; 32], true)
    }

    /// max_x q(x), evaluated with max-sum elimination. No wallet or collateral balance check.
    pub fn max_liability(&self) -> f64 {
        self.eliminate(&[None; 32], false)
    }

    /// Probability of a conjunction of event assignments, including non-neighboring events.
    /// Duplicate event indices are rejected; empty evidence has probability one.
    /// This is analytics, not a tradable conditional or finite-size fill price.
    pub fn probability(&self, assignments: &[(u8, bool)]) -> Result<f64, FactoredError> {
        let mut evidence = [None; 32];
        for &(event, value) in assignments {
            if event >= self.events || evidence[usize::from(event)].is_some() {
                return Err(FactoredError::InvalidEvidence);
            }
            evidence[usize::from(event)] = Some(value);
        }
        Ok((self.eliminate(&evidence, true) - self.eliminate(&[None; 32], true)).exp())
    }

    /// Simulate a local Boolean claim: mask bit x pays one in local state x.
    /// Scope must be sorted, nonempty and contain at most three events; constants are rejected.
    /// Positive quantity buys, negative sells; returns signed collateral paid and a new snapshot.
    /// Nonzero quantities require b/1e9 <= abs(quantity) <= b. Zero is an unchanged no-op.
    /// Exact-scope factors are merged; selling cannot make that local table negative, even
    /// when liabilities on other scopes would keep global q nonnegative. No ownership,
    /// fees, balances, or solvency checks. Floating-point results never authorize transfers.
    pub fn simulate_trade(
        &self,
        scope: &[u8],
        mask: u8,
        quantity: f64,
    ) -> Result<(f64, Self), FactoredError> {
        let candidate = scope_mask(self.events, scope)?;
        if scope.is_empty() {
            return Err(FactoredError::InvalidScope);
        }
        let states = 1_usize << scope.len();
        let full = ((1_u16 << states) - 1) as u8;
        if mask == 0 || mask == full || mask & !full != 0 {
            return Err(FactoredError::InvalidClaim);
        }
        if !quantity.is_finite()
            || (quantity != 0.0 && !(self.b / 1e9..=self.b).contains(&quantity.abs()))
        {
            return Err(FactoredError::InvalidQuantity);
        }
        if quantity == 0.0 {
            return Ok((0.0, self.clone()));
        }

        let mut factors = Vec::with_capacity(self.factors.len() + 1);
        let mut values = vec![0.0; states];
        for table in &self.factors {
            if table.scope == candidate {
                for (total, value) in values.iter_mut().zip(&table.values) {
                    *total += value;
                }
            } else {
                factors.push(Factor {
                    scope: (0..self.events)
                        .filter(|event| table.scope & (1_u32 << event) != 0)
                        .collect(),
                    values: table.values.clone(),
                });
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
        // Revalidate the entire post-trade graph and numerical domain before quoting.
        let after = Self::new(self.events, self.b, factors, self.order.clone())?;
        let mut probability = 0.0;
        for state in 0..states {
            if mask & (1 << state) != 0 {
                let evidence: Vec<_> = scope
                    .iter()
                    .enumerate()
                    .map(|(bit, &event)| (event, state & (1 << bit) != 0))
                    .collect();
                probability += self.probability(&evidence)?;
            }
        }
        // C(q+s*f)-C(q), avoiding subtraction of nearly equal global costs.
        let collateral = self.b * (probability * (quantity / self.b).exp_m1()).ln_1p();
        Ok((collateral, after))
    }

    fn eliminate(&self, evidence: &[Option<bool>; 32], log_sum: bool) -> f64 {
        let mut tables = self.factors.clone();
        if log_sum {
            for table in &mut tables {
                for value in &mut table.values {
                    *value /= self.b;
                }
            }
        }
        for &event in &self.order {
            let bit = 1_u32 << event;
            let (bucket, mut rest): (Vec<_>, Vec<_>) =
                tables.into_iter().partition(|f| f.scope & bit != 0);
            let joined = bucket.iter().fold(bit, |scope, f| scope | f.scope);
            // The constructor validates this width for the same fixed elimination order.
            debug_assert!(joined.count_ones() <= 3);
            let remaining = joined & !bit;
            let mut values = vec![f64::NEG_INFINITY; 1 << remaining.count_ones()];
            for local in 0..1 << joined.count_ones() {
                let assignment = expand(joined, local);
                if evidence[usize::from(event)]
                    .is_some_and(|value| value != (assignment & bit != 0))
                {
                    continue;
                }
                let value = bucket
                    .iter()
                    .map(|f| f.values[project(f.scope, assignment)])
                    .sum();
                let index = project(remaining, assignment);
                values[index] = if log_sum {
                    log_add(values[index], value)
                } else {
                    values[index].max(value)
                };
            }
            rest.push(Table {
                scope: remaining,
                values,
            });
            tables = rest;
        }
        tables.iter().map(|f| f.values[0]).sum()
    }
}

fn scope_mask(events: u8, scope: &[u8]) -> Result<u32, FactoredError> {
    if scope.len() > 3
        || scope.iter().any(|&v| v >= events)
        || scope.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(FactoredError::InvalidScope);
    }
    Ok(scope.iter().fold(0, |mask, &v| mask | (1_u32 << v)))
}

fn induced_width(mut scopes: Vec<u32>, order: &[u8]) -> Result<u32, FactoredError> {
    let mut width = 0;
    for &event in order {
        let bit = 1_u32 << event;
        let joined = scopes
            .iter()
            .filter(|&&s| s & bit != 0)
            .fold(bit, |a, &b| a | b);
        width = width.max(joined.count_ones() - 1);
        if width > 2 {
            return Err(FactoredError::WidthExceeded);
        }
        scopes.retain(|s| s & bit == 0);
        scopes.push(joined & !bit);
    }
    Ok(width)
}

fn expand(mut scope: u32, local: usize) -> u32 {
    let mut state = 0;
    let mut index = 0;
    while scope != 0 {
        let bit = 1_u32 << scope.trailing_zeros();
        if local & (1 << index) != 0 {
            state |= bit;
        }
        scope &= !bit;
        index += 1;
    }
    state
}

fn project(mut scope: u32, state: u32) -> usize {
    let mut local = 0;
    let mut index = 0;
    while scope != 0 {
        let bit = 1_u32 << scope.trailing_zeros();
        if state & bit != 0 {
            local |= 1 << index;
        }
        scope &= !bit;
        index += 1;
    }
    local
}

fn log_add(a: f64, b: f64) -> f64 {
    if a == f64::NEG_INFINITY {
        return b;
    }
    if b == f64::NEG_INFINITY {
        return a;
    }
    a.max(b) + (-(a - b).abs()).exp().ln_1p()
}
