//! 协议版本常量与帧上限(引擎进程协议 §二、§三冻结值)。
//!
//! `ENGINE_PROCESS_PROTOCOL_VERSION` 是引擎进程协议的独立版本号(5.6 第 4 类
//! 契约;版本策略 §二登记):覆盖帧格式、命令信封与受支持的 Schema 面版本。
//! 它不与会话动作协议(`SESSION_ACTION_PROTOCOL_VERSION`)共用编号空间——
//! 后者随 `ActionRequest.protocolVersion` 传输,由 Schema `const 1` 校验。
//! TS 侧镜像常量在 `packages/protocol/src/version.ts`,双侧一致性由
//! contract-smoke 机检(§八)。

/// 引擎进程协议当前版本(ready 帧自报;破坏性变更递增并按版本策略保留窗口)。
pub const ENGINE_PROCESS_PROTOCOL_VERSION: u64 = 1;

/// 单帧上限(帧载荷 = 不含行界 LF 的 JSON 文本字节数)。
///
/// 推导见协议文档 D-F2:最大合法帧是快照导出(教学规模 `VmState` 的十六进制
/// 展开 + 信封开销);16 MiB 为教学规模上界,超限即引擎故障,fail-closed。
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 引擎自报版本(`vmEngineVersion`):与私有包 `vmEngineVersion` 声明比对,
/// 不一致按 `challenge_invalid` 方向拒绝装载(版本策略 §四)。
pub const VM_ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 引擎构建 ID:编译期由 `VM_ENGINE_BUILD_ID` 环境变量注入;未注入时为
/// `dev`(开发构建)。与私有包 `engineBuildId` 声明比对(若声明)。
pub const ENGINE_BUILD_ID: &str = match option_env!("VM_ENGINE_BUILD_ID") {
    Some(build_id) => build_id,
    None => "dev",
};
