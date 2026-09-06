//! `projection`:ProjectionPolicy 白名单求值与执行域内脱敏(ADR-7)。
//!
//! 投影的白名单过滤与脱敏在数据离开执行域之前完成——本 crate 生成
//! `PublicStateProjection` / `ProjectionDelta` / 公开事件与粗化错误,
//! 是"跨域只传投影"三原则(数据分类清单 §二)的引擎侧落点(WP-7 实现语义)。
//!
//! 确定性纪律同 [`vm-core`](https://docs.rs/vm-core):`#![no_std]` 结构性禁止
//! std::time / std::io / std::net / std::fs(ENG-2),`#![forbid(unsafe_code)]`(ENG-1)。
#![no_std]
#![forbid(unsafe_code)]
