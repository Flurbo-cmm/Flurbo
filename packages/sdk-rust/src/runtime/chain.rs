//! Chain reads on the operator's own RPC. Prices are only the pool's quoteBuy / quoteSell at a pinned block.
use serde_json::{json, Value};

use super::rpc::{hex_u128, to_hex, Rpc};
use crate::abi::{decode_words, encode_call, Arg, Log};
use crate::error::{FlurboError, Result};
use crate::protocol::{Deployment, COLLATERAL, COLLATERAL_DECIMALS};
use crate::signer::keccak_hex;
use crate::u256::U256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub number: u64,
    pub hash: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub status: u8,
    pub block_number: u64,
    pub block_hash: String,
    pub gas_used: u128,
    pub effective_gas_price: Option<u128>,
    pub logs: Vec<Log>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fees {
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
}

pub struct ChainReader {
    pub rpc: Box<dyn Rpc>,
}

fn unexpected(what: &str) -> FlurboError {
    FlurboError::new("invalid_response", format!("The chain returned {}.", what))
}

impl ChainReader {
    pub fn new(rpc: Box<dyn Rpc>) -> Self {
        ChainReader { rpc }
    }

    fn word(&self, to: &str, data: &str, tag: &str) -> Result<U256> {
        let r = self.rpc.call("eth_call", json!([{"to": to, "data": data}, tag]))?;
        Ok(decode_words(r.as_str().unwrap_or(""), 1)?[0])
    }

    fn small(&self, to: &str, data: &str, tag: &str) -> Result<u128> {
        self.word(to, data, tag)?.to_u128().ok_or_else(|| unexpected("an out-of-range value"))
    }

    pub fn block(&self, tag: Option<u64>) -> Result<Block> {
        let tag = tag.map(|n| to_hex(n as u128)).unwrap_or_else(|| "latest".into());
        let b = self.rpc.call("eth_getBlockByNumber", json!([tag, false]))?;
        let hash = b.get("hash").and_then(Value::as_str).ok_or_else(|| unexpected("no block"))?;
        Ok(Block { number: hex_u128(&b["number"])? as u64, hash: hash.to_lowercase(), timestamp: hex_u128(&b["timestamp"])? as i64 })
    }

    pub fn chain_id(&self) -> Result<u64> {
        Ok(hex_u128(&self.rpc.call("eth_chainId", json!([]))?)? as u64)
    }

    /// protocol/specs/contracts.md: every check before trading on a deployment.
    pub fn verify_deployment(&self, d: &Deployment) -> Result<()> {
        let fail = |what: &str| FlurboError::new("invalid_response", format!("Unsupported deployment {}: {}.", d.namespace, what));
        if self.chain_id()? != 10143 {
            return Err(fail("the RPC is not Monad testnet (10143)"));
        }
        let head = to_hex(self.block(None)?.number as u128);
        for (address, expected) in [(&d.pool, &d.code_hashes.pool), (&d.resolver, &d.code_hashes.resolver)] {
            let code = self.rpc.call("eth_getCode", json!([address, head]))?;
            let code = code.as_str().unwrap_or("0x");
            if code == "0x" || keccak_hex(code)? != *expected {
                return Err(fail("contract code differs from the published deployment"));
            }
        }
        let call = |name: &str| encode_call(name, &[]).unwrap();
        if format!("0x{}", self.word(&d.pool, &call("settlementRulesHash"), &head)?.word_hex()) != d.rules_hash {
            return Err(fail("settlement rules differ"));
        }
        if self.small(&d.pool, &call("closesAt"), &head)? != d.closes_at as u128 {
            return Err(fail("close time differs"));
        }
        if self.small(&d.pool, &call("eventCount"), &head)? != d.event_count as u128 {
            return Err(fail("event count differs"));
        }
        if self.word(&d.pool, &call("collateral"), &head)?.address() != COLLATERAL {
            return Err(fail("collateral differs"));
        }
        if self.small(COLLATERAL, &call("decimals"), &head)? != COLLATERAL_DECIMALS as u128 {
            return Err(fail("collateral decimals differ"));
        }
        Ok(())
    }

    /// None when the pool refuses to quote this claim at this size.
    pub fn quote(&self, pool: &str, side: &str, scope: u32, mask: u32, quantity: u128, at: &Block) -> Result<Option<u128>> {
        let data = encode_call(if side == "buy" { "quoteBuy" } else { "quoteSell" }, &[scope.into(), mask.into(), quantity.into()])?;
        match self.small(pool, &data, &to_hex(at.number as u128)) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.rpc_kind.as_deref() == Some("rejected") => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn resolved(&self, pool: &str) -> Result<bool> {
        Ok(!self.word(pool, &encode_call("resolved", &[])?, "latest")?.is_zero())
    }

    pub fn holdings(&self, pool: &str, owner: &str, scope: u32, mask: u32) -> Result<u128> {
        self.small(pool, &encode_call("holdings", &[Arg::Text(owner.into()), scope.into(), mask.into()])?, "latest")
    }

    pub fn allowance(&self, owner: &str, spender: &str, tag: &str) -> Result<U256> {
        self.word(COLLATERAL, &encode_call("allowance", &[Arg::Text(owner.into()), Arg::Text(spender.into())])?, tag)
    }

    pub fn native_balance(&self, owner: &str) -> Result<u128> {
        hex_u128(&self.rpc.call("eth_getBalance", json!([owner, "latest"]))?)
    }

    pub fn nonce(&self, owner: &str, tag: &str) -> Result<u64> {
        Ok(hex_u128(&self.rpc.call("eth_getTransactionCount", json!([owner, tag]))?)? as u64)
    }

    pub fn simulate(&self, sender: &str, to: &str, data: &str) -> Result<Value> {
        self.rpc.call("eth_call", json!([{"from": sender, "to": to, "data": data, "value": "0x0"}, "latest"]))
    }

    pub fn estimate_gas(&self, sender: &str, to: &str, data: &str) -> Result<u128> {
        hex_u128(&self.rpc.call("eth_estimateGas", json!([{"from": sender, "to": to, "data": data, "value": "0x0"}]))?)
    }

    pub fn fees(&self) -> Result<Fees> {
        let price = hex_u128(&self.rpc.call("eth_gasPrice", json!([]))?)?;
        let priority = self.rpc.call("eth_maxPriorityFeePerGas", json!([])).and_then(|v| hex_u128(&v)).unwrap_or(0);
        let max_fee = price * 120 / 100;
        Ok(Fees { max_fee_per_gas: max_fee, max_priority_fee_per_gas: priority.min(max_fee) })
    }

    pub fn send_raw(&self, raw: &str) -> Result<Value> {
        self.rpc.call("eth_sendRawTransaction", json!([raw]))
    }

    pub fn transaction_found(&self, hash: &str) -> Result<bool> {
        Ok(!self.rpc.call("eth_getTransactionByHash", json!([hash]))?.is_null())
    }

    pub fn receipt(&self, hash: &str) -> Result<Option<Receipt>> {
        let r = self.rpc.call("eth_getTransactionReceipt", json!([hash]))?;
        if r.is_null() {
            return Ok(None);
        }
        let s = |v: &Value| v.as_str().unwrap_or("").to_lowercase();
        let logs = r["logs"]
            .as_array()
            .map(|a| a.iter().map(|l| Log { address: s(&l["address"]), topics: l["topics"].as_array().map(|t| t.iter().map(s).collect()).unwrap_or_default(), data: s(&l["data"]) }).collect())
            .unwrap_or_default();
        Ok(Some(Receipt {
            status: (hex_u128(&r["status"])? == 1) as u8,
            block_number: hex_u128(&r["blockNumber"])? as u64,
            block_hash: s(&r["blockHash"]),
            gas_used: if r["gasUsed"].is_null() { 0 } else { hex_u128(&r["gasUsed"])? },
            effective_gas_price: if r["effectiveGasPrice"].is_null() { None } else { Some(hex_u128(&r["effectiveGasPrice"])?) },
            logs,
        }))
    }
}
