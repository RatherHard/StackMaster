//! `projection`:ProjectionPolicy 白名单求值与执行域内脱敏(ADR-7;WP-7)。
//!
//! # 定位:跨域只传投影的引擎侧落点
//!
//! 投影的白名单过滤与脱敏在数据离开执行域之前完成(驻留三原则 2,ADR-7):
//! 本 crate 消费 `vm-core` 的权威状态(`VmState` / 私有事件 / 调用帧),按
//! `ProjectionPolicy` 白名单生成 `PublicStateProjection` / `ProjectionDelta` /
//! 公开事件与粗化错误——它们是唯一允许离开 worker 进程的状态形态;`VmState`
//! 及其子类型无任何序列化路径(SERVER_ONLY 类型只有禁令,数据分类清单 §3.1)。
//!
//! # 模块图
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`policy`] | 策略装配与求值:白名单 / 窗口 / 级别 / 地址可见性分类(I-9 判定依据) |
//! | [`types`] | 冻结契约输出类型(与 `@stackmaster/protocol` 字段集一一对应)+ 规范化文本 |
//! | [`events`] | 公开事件管线:私有日志 → 白名单过滤 → 可见性过滤 → 稠密编号 → 确定性聚合 |
//! | [`error`] | 错误粗化:16 码能力矩阵生成侧强制 / coarse 零解释(ZR-P6)/ E-3 来源约束 |
//! | [`project`] | 投影生成:完整投影 / 增量(脏范围合并 + 字节预算)/ 调用栈摘要 / 控制流渲染 |
//! | [`display`] | 调试通道展示数据:伪指令流 / 函数表(ADR-DC1 条款 8;源 = 公开代码区字节,IR 不出进程) |
//! | [`response`] | 响应面装配:已执行(含教学性失败)与执行前拒绝两形态(§4.4 耦合) |
//! | [`canon`] | 生成面规范化 JSON 文本写入器(与 vm-runtime / worker 消费面同文法) |
//!
//! # 确定性纪律(与 vm-core 同)
//!
//! `#![no_std]` 结构性禁止 std::time / std::io / std::net / std::fs(ENG-2),
//! `#![forbid(unsafe_code)]`(ENG-1),零外部依赖(ENG-4)。全部生成函数是
//! `(策略, 静态声明面, 状态, 动作观察)` 的纯函数:I-4(相同可见状态与动作
//! ⇒ 字节相同的公开响应)由差分测试套件锁定(随机秘密差分 + 探针变体,
//! T-SC1 / T-SC4)。

#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod canon;
pub mod display;
pub mod error;
pub mod events;
pub mod policy;
pub mod project;
pub mod response;
pub mod types;

#[cfg(test)]
pub(crate) mod differential;
#[cfg(test)]
pub(crate) mod testkit;

/// 投影生成拒绝(方向注释:worker 映射——装配面拒绝属确定性安全终止)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    /// 策略装配或静态声明面与状态布局矛盾(白名单引用不存在的区域 / 高亮
    /// 目标不可见等;方向 `challenge_invalid`,宁可拒绝不近似执行)。
    ChallengeInvalid(&'static str),
    /// 生成面缺陷(能力矩阵违规、谓词不可达形态等;方向 `engine_error`)。
    EngineDefect(&'static str),
}

impl From<policy::PolicyError> for ProjectionError {
    fn from(value: policy::PolicyError) -> Self {
        // 策略装配拒绝 = challenge_invalid 方向(装配镜像复验纪律)。
        let _ = value;
        ProjectionError::ChallengeInvalid("projection_policy_rejected")
    }
}
