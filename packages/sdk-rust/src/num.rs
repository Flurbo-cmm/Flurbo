//! Serde adapters: amounts travel as decimal strings in JSON and are exact i128 in memory.
use serde::{de::Error, Deserialize, Deserializer, Serializer};
use serde_json::Value;

fn from_value<E: Error>(v: Value) -> Result<i128, E> {
    match v {
        Value::String(s) => s.parse::<i128>().map_err(|_| E::custom("expected a decimal integer string")),
        Value::Number(n) if n.is_i64() || n.is_u64() => Ok(n.as_i64().map(i128::from).unwrap_or_else(|| n.as_u64().unwrap() as i128)),
        _ => Err(E::custom("expected a decimal integer string")),
    }
}

pub mod dec {
    use super::*;
    pub fn serialize<S: Serializer>(v: &i128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i128, D::Error> {
        from_value(Value::deserialize(d)?)
    }
}

pub mod dec_opt {
    use super::*;
    pub fn serialize<S: Serializer>(v: &Option<i128>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.serialize_str(&v.to_string()),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i128>, D::Error> {
        match Value::deserialize(d)? {
            Value::Null => Ok(None),
            v => from_value(v).map(Some),
        }
    }
}
