//! A 256-bit unsigned integer, big endian, for ABI words only. Arithmetic on amounts uses u128/i128.
use std::cmp::Ordering;
use std::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct U256(pub [u8; 32]);

impl U256 {
    pub const ZERO: U256 = U256([0; 32]);

    pub fn from_u128(v: u128) -> U256 {
        let mut b = [0u8; 32];
        b[16..].copy_from_slice(&v.to_be_bytes());
        U256(b)
    }

    /// Canonical decimal digits only; None on overflow or any other character.
    pub fn from_dec(s: &str) -> Option<U256> {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
            return None;
        }
        let mut b = [0u8; 32];
        for c in s.bytes() {
            let mut carry = (c - b'0') as u32;
            for byte in b.iter_mut().rev() {
                let v = *byte as u32 * 10 + carry;
                *byte = v as u8;
                carry = v >> 8;
            }
            if carry != 0 {
                return None;
            }
        }
        Some(U256(b))
    }

    /// Up to 64 hex digits, with or without 0x.
    pub fn from_hex(s: &str) -> Option<U256> {
        let h = s.strip_prefix("0x").unwrap_or(s);
        if h.is_empty() || h.len() > 64 || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let padded = format!("{:0>64}", h);
        let mut b = [0u8; 32];
        for i in 0..32 {
            b[i] = u8::from_str_radix(&padded[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(U256(b))
    }

    pub fn bits(&self) -> u32 {
        for (i, byte) in self.0.iter().enumerate() {
            if *byte != 0 {
                return (32 - i as u32) * 8 - byte.leading_zeros();
            }
        }
        0
    }

    pub fn to_u128(&self) -> Option<u128> {
        if self.bits() > 128 {
            return None;
        }
        let mut b = [0u8; 16];
        b.copy_from_slice(&self.0[16..]);
        Some(u128::from_be_bytes(b))
    }

    pub fn to_u64(&self) -> Option<u64> {
        self.to_u128().and_then(|v| u64::try_from(v).ok())
    }

    pub fn is_zero(&self) -> bool {
        self.0.iter().all(|b| *b == 0)
    }

    pub fn word_hex(&self) -> String {
        self.0.iter().map(|b| format!("{:02x}", b)).collect()
    }

    /// The low 20 bytes as a lowercase 0x address.
    pub fn address(&self) -> String {
        format!("0x{}", self.0[12..].iter().map(|b| format!("{:02x}", b)).collect::<String>())
    }

    pub fn to_dec(&self) -> String {
        let mut digits = Vec::new();
        let mut n = self.0;
        while n.iter().any(|b| *b != 0) {
            let mut rem = 0u32;
            for byte in n.iter_mut() {
                let v = (rem << 8) | *byte as u32;
                *byte = (v / 10) as u8;
                rem = v % 10;
            }
            digits.push(b'0' + rem as u8);
        }
        if digits.is_empty() {
            return "0".into();
        }
        digits.reverse();
        String::from_utf8(digits).unwrap()
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.cmp(&other.0)
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Debug for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_dec())
    }
}

impl fmt::Display for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_dec())
    }
}
