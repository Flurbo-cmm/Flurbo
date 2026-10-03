//! Errors. Messages are safe to show: no credentials, keys or upstream bodies.
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlurboError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
    /// The runtime API's machine code (for example CREDENTIAL_REVOKED), when the error came from it.
    pub api_code: Option<String>,
    /// JSON-RPC failure kind: timeout, unavailable or rejected.
    pub rpc_kind: Option<String>,
}

impl FlurboError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        FlurboError { code: code.into(), message: message.into(), status: None, api_code: None, rpc_kind: None }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message)
    }
}

impl fmt::Display for FlurboError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for FlurboError {}

pub type Result<T> = std::result::Result<T, FlurboError>;
