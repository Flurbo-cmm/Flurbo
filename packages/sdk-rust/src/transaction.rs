//! The only transactions a runtime may sign, built and then validated on the final bytes before signing:
//! chain, contract, token, method, amounts and beneficiary (the pool credits msg.sender, so the signer must be
//! the agent wallet).
use crate::abi::{decode_call, encode_call, Arg};
use crate::claims::validate_claim;
use crate::error::{FlurboError, Result};
use crate::protocol::{Deployment, COLLATERAL, SERVICE_MAX_ATOMS};
use crate::u256::U256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Claim {
    pub scope: u32,
    pub mask: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    Approve { amount_atoms: i128 },
    Buy { claim: Claim, quantity_atoms: i128, limit_atoms: i128, deadline: u64 },
    Sell { claim: Claim, quantity_atoms: i128, limit_atoms: i128, deadline: u64 },
    Redeem { claim: Claim, quantity_atoms: i128 },
}

impl Intent {
    pub fn action(&self) -> &'static str {
        match self {
            Intent::Approve { .. } => "approve",
            Intent::Buy { .. } => "buy",
            Intent::Sell { .. } => "sell",
            Intent::Redeem { .. } => "redeem",
        }
    }
    pub fn claim(&self) -> Option<Claim> {
        match self {
            Intent::Approve { .. } => None,
            Intent::Buy { claim, .. } | Intent::Sell { claim, .. } | Intent::Redeem { claim, .. } => Some(*claim),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsignedCall {
    pub chain_id: u64,
    pub from: String,
    pub to: String,
    pub data: String,
    pub value: u128,
}

fn refuse(message: &str) -> FlurboError {
    FlurboError::invalid(format!("Refusing to sign: {}.", message))
}

fn amount(v: i128) -> Result<Arg> {
    u128::try_from(v).map(Arg::from).map_err(|_| refuse("negative amount"))
}

pub fn build_transaction(intent: &Intent, deployment: &Deployment, wallet: &str) -> Result<UnsignedCall> {
    let (to, data) = match intent {
        Intent::Approve { amount_atoms } => (COLLATERAL.to_string(), encode_call("approve", &[deployment.pool.as_str().into(), amount(*amount_atoms)?])?),
        Intent::Redeem { claim, quantity_atoms } => {
            (deployment.pool.clone(), encode_call("redeem", &[claim.scope.into(), claim.mask.into(), amount(*quantity_atoms)?])?)
        }
        Intent::Buy { claim, quantity_atoms, limit_atoms, deadline } | Intent::Sell { claim, quantity_atoms, limit_atoms, deadline } => (
            deployment.pool.clone(),
            encode_call(intent.action(), &[claim.scope.into(), claim.mask.into(), amount(*quantity_atoms)?, amount(*limit_atoms)?, (*deadline).into()])?,
        ),
    };
    let tx = UnsignedCall { chain_id: 10143, from: wallet.to_lowercase(), to, data, value: 0 };
    validate_transaction(&tx, intent, deployment, wallet)?;
    Ok(tx)
}

fn eq(word: &U256, v: i128) -> bool {
    v >= 0 && *word == U256::from_u128(v as u128)
}

pub fn validate_transaction(tx: &UnsignedCall, intent: &Intent, deployment: &Deployment, wallet: &str) -> Result<()> {
    if tx.chain_id != 10143 || deployment.chain_id != 10143 {
        return Err(refuse("not Monad testnet"));
    }
    if tx.value != 0 {
        return Err(refuse("value must be zero"));
    }
    if tx.from.to_lowercase() != wallet.to_lowercase() {
        return Err(refuse("the signer is not the agent wallet"));
    }
    let (name, args) = decode_call(&tx.data)?;
    if name != intent.action() {
        return Err(refuse("the method differs from the intent"));
    }
    let max = U256::from_u128(SERVICE_MAX_ATOMS as u128);
    if let Intent::Approve { amount_atoms } = intent {
        if tx.to.to_lowercase() != COLLATERAL {
            return Err(refuse("approvals are only for test AUSD"));
        }
        if args[0].address() != deployment.pool {
            return Err(refuse("the spender is not the pool"));
        }
        if !eq(&args[1], *amount_atoms) || args[1].is_zero() || args[1] > max {
            return Err(refuse("the approval amount is outside the service limit"));
        }
        return Ok(());
    }
    if tx.to.to_lowercase() != deployment.pool {
        return Err(refuse("the contract is not the published pool"));
    }
    let claim = intent.claim().unwrap();
    let (scope, mask, quantity) = (&args[0], &args[1], &args[2]);
    let quantity_atoms = match intent {
        Intent::Buy { quantity_atoms, .. } | Intent::Sell { quantity_atoms, .. } | Intent::Redeem { quantity_atoms, .. } => *quantity_atoms,
        Intent::Approve { .. } => unreachable!(),
    };
    if *scope != U256::from_u128(claim.scope as u128) || *mask != U256::from_u128(claim.mask as u128) || !eq(quantity, quantity_atoms) {
        return Err(refuse("the claim or quantity differs from the intent"));
    }
    if validate_claim(claim.scope as i64, &claim.mask.to_string(), deployment.event_count as i64).is_err() {
        return Err(refuse("the claim is not supported in this pool"));
    }
    if quantity.is_zero() || *quantity > max {
        return Err(refuse("the quantity is outside the service limit"));
    }
    if let Intent::Buy { limit_atoms, deadline, .. } | Intent::Sell { limit_atoms, deadline, .. } = intent {
        let (limit, when) = (&args[3], &args[4]);
        if !eq(limit, *limit_atoms) || *limit > max || (matches!(intent, Intent::Buy { .. }) && limit.is_zero()) {
            return Err(refuse("the limit differs from the intent or the service limit"));
        }
        if *when != U256::from_u128(*deadline as u128) || *deadline >= deployment.closes_at {
            return Err(refuse("the deadline differs from the intent or is after the close"));
        }
    }
    Ok(())
}
