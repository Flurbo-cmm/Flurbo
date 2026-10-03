//! The only place a transaction is signed. Keys stay in the operator's runtime: never sent to Flurbo, never
//! logged, never placed in a model prompt. Remote signers (a KMS or a signing service) implement the same
//! `Signer` trait.
use std::fmt;

use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

use crate::error::{FlurboError, Result};

pub fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

pub fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

pub fn from_hex(s: &str) -> Result<Vec<u8>> {
    let h = s.strip_prefix("0x").ok_or_else(|| FlurboError::invalid("Expected 0x-prefixed hex."))?;
    if h.len() % 2 != 0 {
        return Err(FlurboError::invalid("Expected an even number of hex digits."));
    }
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).map_err(|_| FlurboError::invalid("Invalid hex."))).collect()
}

pub fn keccak_hex(data: &str) -> Result<String> {
    Ok(to_hex(&keccak(&from_hex(data)?)))
}

pub fn transaction_hash(raw: &str) -> Result<String> {
    keccak_hex(raw)
}

/// An EIP-1559 transaction on Monad testnet. Value is always zero for the protocol's calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tx1559 {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: String,
    pub data: String,
    pub value: u128,
    pub gas: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
}

pub trait Signer: Send + Sync {
    fn address(&self) -> String;
    fn kind(&self) -> &str;
    /// The signed raw transaction as 0x hex.
    fn sign_transaction(&self, tx: &Tx1559) -> Result<String>;
    /// An EIP-191 personal_sign signature as 0x hex (65 bytes).
    fn sign_message(&self, message: &str) -> Result<String>;
}

fn rlp_bytes(b: &[u8], out: &mut Vec<u8>) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else {
        rlp_len(b.len(), 0x80, out);
        out.extend_from_slice(b);
    }
}

fn rlp_len(len: usize, offset: u8, out: &mut Vec<u8>) {
    if len < 56 {
        out.push(offset + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let start = be.iter().position(|x| *x != 0).unwrap();
        out.push(offset + 55 + (8 - start) as u8);
        out.extend_from_slice(&be[start..]);
    }
}

fn rlp_uint(v: u128, out: &mut Vec<u8>) {
    let be = v.to_be_bytes();
    let start = be.iter().position(|x| *x != 0).unwrap_or(16);
    rlp_bytes(&be[start..], out);
}

fn rlp_list(items: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    rlp_len(items.len(), 0xc0, &mut out);
    out.extend_from_slice(items);
    out
}

fn fields(tx: &Tx1559) -> Result<Vec<u8>> {
    let to = from_hex(&tx.to)?;
    if to.len() != 20 {
        return Err(FlurboError::invalid("Invalid recipient."));
    }
    let mut f = Vec::new();
    rlp_uint(tx.chain_id as u128, &mut f);
    rlp_uint(tx.nonce as u128, &mut f);
    rlp_uint(tx.max_priority_fee_per_gas, &mut f);
    rlp_uint(tx.max_fee_per_gas, &mut f);
    rlp_uint(tx.gas, &mut f);
    rlp_bytes(&to, &mut f);
    rlp_uint(tx.value, &mut f);
    rlp_bytes(&from_hex(&tx.data)?, &mut f);
    f.push(0xc0); // empty access list
    Ok(f)
}

/// The EIP-2718 payload that is signed: 0x02 || rlp([...fields]).
pub fn unsigned_serialized(tx: &Tx1559) -> Result<Vec<u8>> {
    let mut out = vec![0x02];
    out.extend(rlp_list(&fields(tx)?));
    Ok(out)
}

pub struct LocalKeySigner {
    key: SigningKey,
    address: String,
}

impl LocalKeySigner {
    pub fn new(private_key: &str) -> Result<Self> {
        let malformed = || FlurboError::invalid("The agent key must be 32 bytes of hex with a 0x prefix.");
        if private_key.len() != 66 {
            return Err(malformed());
        }
        let bytes = from_hex(private_key).map_err(|_| malformed())?;
        let key = SigningKey::from_slice(&bytes).map_err(|_| malformed())?;
        let point = key.verifying_key().to_encoded_point(false);
        let address = to_hex(&keccak(&point.as_bytes()[1..])[12..]);
        Ok(LocalKeySigner { key, address })
    }

    /// Reads the key from an environment variable. The value is never echoed, even in errors.
    pub fn from_env(variable: &str) -> Result<Self> {
        match std::env::var(variable) {
            Ok(v) if !v.trim().is_empty() => Self::new(v.trim()),
            _ => Err(FlurboError::invalid(format!(
                "Set {} to the dedicated agent wallet key (testnet only). Never use a deployer, settlement, reviewer or personal wallet.",
                variable
            ))),
        }
    }

    fn sign_digest(&self, digest: &[u8; 32]) -> Result<(Vec<u8>, u8)> {
        // RFC 6979 deterministic nonces and low-s normalization, as every reference signer.
        let (sig, recid) = self.key.sign_prehash_recoverable(digest).map_err(|_| FlurboError::new("signing_failed", "Signing failed."))?;
        Ok((sig.to_bytes().to_vec(), recid.to_byte()))
    }
}

impl fmt::Debug for LocalKeySigner {
    // never print key material
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LocalKeySigner({})", self.address)
    }
}

impl Signer for LocalKeySigner {
    fn address(&self) -> String {
        self.address.clone()
    }

    fn kind(&self) -> &str {
        "local-key"
    }

    fn sign_transaction(&self, tx: &Tx1559) -> Result<String> {
        let digest = keccak(&unsigned_serialized(tx)?);
        let (sig, parity) = self.sign_digest(&digest)?;
        let mut f = fields(tx)?;
        rlp_uint(parity as u128, &mut f);
        let strip = |b: &[u8]| b[b.iter().position(|x| *x != 0).unwrap_or(b.len())..].to_vec();
        rlp_bytes(&strip(&sig[..32]), &mut f);
        rlp_bytes(&strip(&sig[32..]), &mut f);
        let mut out = vec![0x02];
        out.extend(rlp_list(&f));
        Ok(to_hex(&out))
    }

    fn sign_message(&self, message: &str) -> Result<String> {
        let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
        prefixed.extend_from_slice(message.as_bytes());
        let (mut sig, parity) = self.sign_digest(&keccak(&prefixed))?;
        sig.push(27 + parity);
        Ok(to_hex(&sig))
    }
}
