//! `vm-runtime`:COW 快照、规范化动作日志、回放与私有题目包装载。
//!
//! 依赖方向(5.5):vm-core ← vm-runtime ← vm-worker。快照导出 / 导入形态是
//! 阶段三持久化的对接面;回放引擎本体在本 crate,阶段六 verifier 复用同一实现(ADR-8)。
//!
//! 确定性纪律同 [`vm-core`](https://docs.rs/vm-core):`#![no_std]` 结构性禁止
//! std::time / std::io / std::net / std::fs(ENG-2),`#![forbid(unsafe_code)]`(ENG-1);
//! 时钟与随机源由 trait 注入,实现归 vm-worker 进程层。
#![no_std]
#![forbid(unsafe_code)]
