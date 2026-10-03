//! Payoff algebra, reference pricing, and integer accounting for small event clusters.

pub mod accounting;
pub mod factored;
pub mod funded_repricing;
pub mod parlay_learning;
pub mod pricing;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoffError {
    UnsupportedEventCount,
    InvalidEvent,
    InvalidState,
    OutOfRangeMask,
    DifferentStateSpaces,
    ConstantClaim,
    InvalidPartition,
}

/// Bit `x` is one iff this claim pays one unit in terminal state `x`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Payoff {
    events: u8,
    mask: u8,
}

impl Payoff {
    pub fn new(events: u8, mask: u8) -> Result<Self, PayoffError> {
        if !(1..=3).contains(&events) {
            return Err(PayoffError::UnsupportedEventCount);
        }
        let payoff = Self { events, mask };
        if mask & !payoff.full_mask() != 0 {
            return Err(PayoffError::OutOfRangeMask);
        }
        Ok(payoff)
    }

    /// Event `index` is the corresponding bit of the terminal-state index.
    pub fn event(events: u8, index: u8) -> Result<Self, PayoffError> {
        let mut payoff = Self::new(events, 0)?;
        if index >= events {
            return Err(PayoffError::InvalidEvent);
        }
        for state in 0..payoff.state_count() {
            if state & (1 << index) != 0 {
                payoff.mask |= 1 << state;
            }
        }
        Ok(payoff)
    }

    pub fn mask(self) -> u8 {
        self.mask
    }

    pub fn event_count(self) -> u8 {
        self.events
    }

    pub fn state_count(self) -> u8 {
        1 << self.events
    }

    fn full_mask(self) -> u8 {
        ((1_u16 << self.state_count()) - 1) as u8
    }

    pub fn payout(self, state: u8) -> Result<u8, PayoffError> {
        if state >= self.state_count() {
            return Err(PayoffError::InvalidState);
        }
        Ok((self.mask >> state) & 1)
    }

    pub fn complement(self) -> Self {
        Self {
            mask: self.mask ^ self.full_mask(),
            ..self
        }
    }

    fn ensure_same_space(self, other: Self) -> Result<(), PayoffError> {
        if self.events != other.events {
            return Err(PayoffError::DifferentStateSpaces);
        }
        Ok(())
    }

    pub fn intersection(self, other: Self) -> Result<Self, PayoffError> {
        self.ensure_same_space(other)?;
        Self::new(self.events, self.mask & other.mask)
    }

    pub fn union(self, other: Self) -> Result<Self, PayoffError> {
        self.ensure_same_space(other)?;
        Self::new(self.events, self.mask | other.mask)
    }

    pub fn validate_tradable(self) -> Result<(), PayoffError> {
        if self.mask == 0 || self.mask == self.full_mask() {
            return Err(PayoffError::ConstantClaim);
        }
        Ok(())
    }

    /// Checks a payout identity valid for either a split or its inverse merge.
    /// Ownership, quantity, and cluster compatibility must be enforced by a ledger.
    pub fn validate_partition(self, left: Self, right: Self) -> Result<(), PayoffError> {
        self.ensure_same_space(left)?;
        self.ensure_same_space(right)?;
        self.validate_tradable()?;
        left.validate_tradable()?;
        right.validate_tradable()?;
        if left.mask & right.mask != 0 || left.mask | right.mask != self.mask {
            return Err(PayoffError::InvalidPartition);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_route_has_the_expected_terminal_payouts() {
        let a = Payoff::event(2, 0).unwrap();
        let b = Payoff::event(2, 1).unwrap();
        let target = a.intersection(b).unwrap();
        let residual = a.intersection(b.complement()).unwrap();
        assert_eq!(
            (a.mask(), b.mask(), target.mask(), residual.mask()),
            (10, 12, 8, 2)
        );
        assert_eq!(a.validate_partition(target, residual), Ok(()));
        for state in 0..4 {
            assert_eq!(
                a.payout(state).unwrap(),
                target.payout(state).unwrap() + residual.payout(state).unwrap()
            );
        }
    }

    #[test]
    fn boolean_algebra_matches_each_terminal_state_exhaustively() {
        for events in 1..=3 {
            let full = Payoff::new(events, 0).unwrap().full_mask();
            for left_mask in 0..=full {
                let left = Payoff::new(events, left_mask).unwrap();
                assert_eq!(left.complement().complement(), left);
                for right_mask in 0..=full {
                    let right = Payoff::new(events, right_mask).unwrap();
                    let and = left.intersection(right).unwrap();
                    let or = left.union(right).unwrap();
                    assert_eq!(
                        and.complement(),
                        left.complement().union(right.complement()).unwrap()
                    );
                    for state in 0..left.state_count() {
                        let a = left.payout(state).unwrap();
                        let b = right.payout(state).unwrap();
                        assert_eq!(and.payout(state).unwrap(), a * b);
                        assert_eq!(or.payout(state).unwrap(), u8::from(a + b > 0));
                    }
                }
            }
        }
    }

    #[test]
    fn partitions_match_payoff_conservation_exhaustively() {
        // All parents and child pairs for the initial two-event integration.
        for parent_mask in 0..16 {
            let parent = Payoff::new(2, parent_mask).unwrap();
            for left_mask in 0..16 {
                for right_mask in 0..16 {
                    let left = Payoff::new(2, left_mask).unwrap();
                    let right = Payoff::new(2, right_mask).unwrap();
                    let nonconstant = [parent_mask, left_mask, right_mask]
                        .iter()
                        .all(|m| *m > 0 && *m < 15);
                    let conserved = (0..4).all(|state| {
                        parent.payout(state).unwrap()
                            == left.payout(state).unwrap() + right.payout(state).unwrap()
                    });
                    assert_eq!(
                        parent.validate_partition(left, right).is_ok(),
                        nonconstant && conserved
                    );
                }
            }
        }
    }

    #[test]
    fn invalid_inputs_return_errors() {
        for events in [0, 4, 8, 255] {
            assert_eq!(
                Payoff::new(events, 0),
                Err(PayoffError::UnsupportedEventCount)
            );
        }
        assert_eq!(Payoff::new(2, 16), Err(PayoffError::OutOfRangeMask));
        assert_eq!(Payoff::event(2, 2), Err(PayoffError::InvalidEvent));
        let a = Payoff::event(2, 0).unwrap();
        let other = Payoff::event(3, 0).unwrap();
        assert_eq!(a.payout(4), Err(PayoffError::InvalidState));
        assert_eq!(a.union(other), Err(PayoffError::DifferentStateSpaces));
        assert_eq!(
            a.intersection(other),
            Err(PayoffError::DifferentStateSpaces)
        );
        assert_eq!(
            a.validate_partition(a, other),
            Err(PayoffError::DifferentStateSpaces)
        );
        assert_eq!(
            a.validate_partition(a, a),
            Err(PayoffError::InvalidPartition)
        );
        for mask in [0, 15] {
            assert_eq!(
                Payoff::new(2, mask).unwrap().validate_tradable(),
                Err(PayoffError::ConstantClaim)
            );
        }
    }
}
