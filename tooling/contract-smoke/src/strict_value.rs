//! 严格 JSON 值模型(重复键拒绝)。
//!
//! serde_json::Value 反序列化默认允许对象重复键(后值静默覆盖),与
//! docs/contracts/规范化JSON序列化.md §二第 1 条不符;本模块自定义 `Deserialize`,
//! 在 visit_map 时以精确拼写检测重复键。孤立代理项在 serde_json 解析层
//! 即报错(`lone leading surrogate…`),按错误分类映射为 TS 侧同名拒绝码。

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Number;
use std::fmt;

/// 严格解析后的 JSON 值;对象保序且键唯一。
#[derive(Debug, Clone, PartialEq)]
pub enum StrictValue {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<StrictValue>),
    Object(Vec<(String, StrictValue)>),
}

impl StrictValue {
    pub fn parse(text: &str) -> Result<StrictValue, crate::canonical::CanonicalError> {
        serde_json::from_str(text).map_err(map_parse_error)
    }

    pub fn as_object(&self) -> Option<&[(String, StrictValue)]> {
        match self {
            StrictValue::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            StrictValue::String(s) => Some(s),
            _ => None,
        }
    }
}

fn map_parse_error(error: serde_json::Error) -> crate::canonical::CanonicalError {
    use crate::canonical::CanonicalError;
    match error.classify() {
        serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
            CanonicalError::InvalidJson
        }
        serde_json::error::Category::Data => {
            let message = error.to_string();
            if message.contains("duplicate key") {
                CanonicalError::DuplicateKey
            } else if message.contains("surrogate") {
                CanonicalError::LoneSurrogate
            } else {
                CanonicalError::InvalidJson
            }
        }
        serde_json::error::Category::Io => CanonicalError::InvalidJson,
    }
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;

        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("任意 JSON 值")
            }

            fn visit_bool<E>(self, value: bool) -> Result<StrictValue, E> {
                Ok(StrictValue::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<StrictValue, E> {
                Ok(StrictValue::Number(Number::from(value)))
            }

            fn visit_u64<E>(self, value: u64) -> Result<StrictValue, E> {
                Ok(StrictValue::Number(Number::from(value)))
            }

            fn visit_f64<E>(self, value: f64) -> Result<StrictValue, E>
            where
                E: de::Error,
            {
                Number::from_f64(value)
                    .map(StrictValue::Number)
                    .ok_or_else(|| de::Error::custom("非有限数值"))
            }

            fn visit_str<E>(self, value: &str) -> Result<StrictValue, E> {
                Ok(StrictValue::String(value.to_owned()))
            }

            fn visit_unit<E>(self) -> Result<StrictValue, E> {
                Ok(StrictValue::Null)
            }

            fn visit_none<E>(self) -> Result<StrictValue, E> {
                Ok(StrictValue::Null)
            }

            fn visit_some<D: Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<StrictValue, D::Error> {
                StrictValue::deserialize(deserializer)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<StrictValue, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = access.next_element()? {
                    items.push(item);
                }
                Ok(StrictValue::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<StrictValue, A::Error> {
                let mut entries: Vec<(String, StrictValue)> = Vec::new();
                while let Some((key, value)) = access.next_entry::<String, StrictValue>()? {
                    if entries.iter().any(|(existing, _)| existing == &key) {
                        return Err(de::Error::custom(format!(
                            "duplicate key: 对象出现重复键 {key:?}"
                        )));
                    }
                    entries.push((key, value));
                }
                Ok(StrictValue::Object(entries))
            }
        }

        deserializer.deserialize_any(StrictVisitor)
    }
}
