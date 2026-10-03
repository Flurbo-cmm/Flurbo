//! Whether a mined receipt shows exactly the reported intent (protocol/specs/transactions.md).
use serde::{Deserialize, Serialize};

use crate::abi::{decode_pool_log, Log, PoolEvent};
use crate::claims::ClaimRef;
use crate::num::dec;
use crate::u256::U256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectIntent {
    pub action: String,
    pub wallet: String,
    pub pool: String,
    pub claim: Option<ClaimRef>,
    #[serde(with = "dec")]
    pub quantity_atoms: i128,
    #[serde(with = "dec")]
    pub limit_atoms: i128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Effect {
    pub status: String,
    /// The collateral the event shows, for confirmed buys, sells and redemptions.
    pub collateral_atoms: Option<i128>,
}

fn mismatch() -> Effect {
    Effect { status: "mismatch".into(), collateral_atoms: None }
}

fn confirmed(amount: Option<u128>) -> Effect {
    Effect { status: "confirmed".into(), collateral_atoms: amount.map(|a| a as i128) }
}

/// receipt_status is 1 for success; logs are the receipt's logs.
pub fn verify_effect(intent: &EffectIntent, receipt_status: u8, logs: &[Log], allowance_after_atoms: Option<&str>) -> Effect {
    if receipt_status != 1 {
        return mismatch();
    }
    let (wallet, pool, limit) = (intent.wallet.to_lowercase(), intent.pool.to_lowercase(), intent.limit_atoms);
    if intent.action == "approve" {
        let ok = allowance_after_atoms.and_then(U256::from_dec).is_some_and(|a| a >= U256::from_u128(limit.max(0) as u128));
        return if ok { confirmed(None) } else { mismatch() };
    }
    let Some(claim) = &intent.claim else { return mismatch() };
    let Some(mask) = U256::from_dec(&claim.mask) else { return mismatch() };
    let quantity = intent.quantity_atoms;
    for log in logs {
        if log.address.to_lowercase() != pool {
            continue;
        }
        match decode_pool_log(log) {
            Some(PoolEvent::Traded { trader, scope, mask: m, is_buy, quantity: q, collateral_amount, .. })
                if scope == claim.scope && m == mask && q as i128 == quantity && trader == wallet =>
            {
                if intent.action == "buy" && is_buy && (collateral_amount as i128) <= limit {
                    return confirmed(Some(collateral_amount));
                }
                if intent.action == "sell" && !is_buy && (collateral_amount as i128) >= limit {
                    return confirmed(Some(collateral_amount));
                }
            }
            Some(PoolEvent::Redeemed { owner, scope, mask: m, quantity: q, collateral_amount, .. })
                if scope == claim.scope && m == mask && q as i128 == quantity && intent.action == "redeem" && owner == wallet =>
            {
                return confirmed(Some(collateral_amount));
            }
            _ => {}
        }
    }
    mismatch()
}
