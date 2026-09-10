//! 会话装配与执行托管(WP-8):私有包 + 公开描述包 → 引擎 / 判题 / 投影
//! 策略的装配管线,以及协议命令到 [`SessionRuntime`](vm_runtime::runtime)
//! 执行链路的托管(`host`)。模块地图:
//!
//! - [`assemble`]:装配器——契约镜像 → `EngineConfig` / `JudgingSpec` /
//!   `ProjectionPolicy` / `ReplayContext` 的唯一转换点(判题语义规约
//!   "契约面经 vm-worker 镜像层转换为本文类型"的落点);决策记录
//!   D-W8-1 ~ D-W8-6 见 `docs/develop/会话编排语义规约.md`;
//! - [`host`]:会话托管——`apply_action` 的写分类前置(D-P1)→ 运行时
//!   执行 → 响应面装配(WP-7 `response` 面唯一入口)、投影查询、快照
//!   导出 / 导入;
//! - [`watchdog`]:wall-clock 看门狗(9.1 资源面;引擎 crate 无时钟,
//!   超时由本进程层实现);
//! - [`variant`]:调试实例装配与托管(阶段四 WP-41;ADR-DC1 条款 2/3/4/5/8
//!   ——变体零装载、确定性动作重放、任意地址读 / 检索 / 展示数据,真实
//!   私有包与真实快照导入路径零接入)。
//!
//! 秘密零驻留:本模块只存在于 worker 进程内;一切对外返回值都经出站契约
//! 面(`crate::contract::outbound`)转换与冻结 Schema 自检。

pub mod assemble;
pub mod host;
pub mod variant;
pub mod watchdog;
