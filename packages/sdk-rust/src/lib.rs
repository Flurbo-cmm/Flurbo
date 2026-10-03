//! Flurbo agent SDK for Rust (protocol v1, Monad testnet only). The protocol core is pure and checked against
//! the shared fixtures in protocol/fixtures; the runtime (module `runtime`) runs on the operator's machine.
pub mod abi;
pub mod amounts;
pub mod claims;
pub mod effects;
pub mod error;
pub mod num;
pub mod policy;
pub mod protocol;
pub mod recovery;
pub mod research;
pub mod runtime;
pub mod signer;
pub mod strategy;
pub mod semantics;
pub mod time;
pub mod transaction;
pub mod u256;

pub use error::{FlurboError, Result};
