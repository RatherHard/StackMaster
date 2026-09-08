//! `vm-runtime`:COW 快照、规范化动作日志、回放、私有题目包版本锁定与
//! 会话资源计数(WP-6;计划书 6.3 / 9.1、5.5 vm-runtime 职责、版本策略 §三 / §四)。
//!
//! 依赖方向(5.5):vm-core ← vm-runtime ← vm-worker。快照导出 / 导入形态是
//! 阶段三持久化的对接面;回放引擎本体在本 crate 并与交互执行共用同一份代码
//! ([`runtime::SessionRuntime`]),阶段六 verifier 复用同一实现(ADR-8)。
//!
//! # 模块地图
//!
//! - [`sha256`]:SHA-256(状态哈希 / 日志摘要的摘要原语;FIPS 180-4,测试向量锁定);
//! - [`canon`]:规范化 JSON(`stackmaster-canonical-json/1` 的 JCS 整数域子集)
//!   写入器与严格解析器——动作日志 / 快照载荷的序列化形态;
//! - [`state_form`]:`VmState` 的确定性规范化形态 v1(`stackmaster-vmstate/1`):
//!   状态哈希(SHA-256)、快照载荷的状态段、状态重建(导入侧);
//! - [`identity`]:引擎自报版本与私有包声明锁定的比对(版本策略 §四);
//! - [`snapshot`]:会话快照(COW 承载)、checkpoint 表(签发 / 归属解析 /
//!   恢复)、快照导出 / 导入载荷(`stackmaster-session-snapshot/1`);
//! - [`action_log`]:append-only 规范化动作日志(6.3 记录清单一一对应 +
//!   版本策略 §三回放记录项;`stackmaster-action-log/1`);
//! - [`runtime`]:会话运行时——12 动作的权威执行循环(gate → 执行 → settle →
//!   日志追加)、revision 单调、undo / checkout / reset 的内容回退语义、
//!   资源计数与结构上限强制;
//! - `replay`:回放一致性——同一动作日志在全新运行时上重放,状态哈希序列
//!   逐项比对(黄金回放测试的执行体)。
//!
//! # 确定性纪律(ADR-8,同 vm-core)
//!
//! `#![no_std]` 结构性禁止 std::time / std::io / std::net / std::fs(ENG-2),
//! `#![forbid(unsafe_code)]`(ENG-1);零外部依赖(ENG-4 允许清单 = `vm-core`)。
//! 本 crate 不含时钟与随机源:checkpoint ID 由内容哈希 + 序号确定性签发,
//! 时钟类资源(wall-clock / 超时)只登记不执行(引擎 crate 无时钟,worker
//! 进程层实现归 WP-8)。

#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod action_log;
pub mod canon;
pub mod identity;
pub mod replay;
pub mod runtime;
pub mod sha256;
pub mod snapshot;
pub mod state_form;
