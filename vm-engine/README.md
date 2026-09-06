# vm-engine

Rust workspace(信任域 3,仅后端;ADR-8):权威执行域引擎。

| crate | 职责 | 依赖 |
|---|---|---|
| `vm-core` | 纯 VM 语义:状态模型、内存 / 寄存器、指令执行、判题 | — |
| `vm-runtime` | COW 快照、规范化动作日志、回放、私有题目包装载 | vm-core |
| `projection` | ProjectionPolicy 白名单求值与执行域内脱敏(ADR-7) | vm-core |
| `vm-worker` | 二进制 + 库:单会话进程入口,stdio NDJSON 协议;契约消费面;时钟 / 随机源实现层 | vm-core、vm-runtime、projection + serde / serde_json / jsonschema / schemars(进程边界层,ENG-4 白名单登记) |

## 确定性纪律(机器强制)

- 全 crate `#![forbid(unsafe_code)]`(ENG-1);
- 引擎三 crate `#![no_std]`:std::time / std::io / std::net / std::fs 结构性不可用,
  时钟与随机源由 trait 注入、vm-worker 进程层提供实现(ENG-2);
- release 构建 `overflow-checks = true`(workspace profile;ENG-3,运行时反例:
  `vm-core` 的 `release_overflow_checks_active`,在 `cargo test --release` 下红灯);
- 引擎三 crate 运行时依赖 ⊆ 允许清单,禁 rand / getrandom / chrono 等(ENG-4);
- 第二层 clippy 禁用清单 `tooling/engine-lints/clippy.toml`(ENG-5)。

门禁统一入口:`node tooling/check-engine-discipline.mjs`(根脚本 `pnpm lint:rust`),
含 fmt --check、clippy `-D warnings`、覆盖率门槛与每条门禁的必触发反例自检;
条目 → CI 检查项映射见 `docs/develop/秘密零驻留CI检查项映射.md`。

## 契约消费与进程协议(WP-1)

- `vm-worker`(lib)`contract` 模块:serde 类型镜像(ActionRequest / PrivateChallengeBundle)+
  冻结 JSON Schema 校验器(编译期内嵌)+ 规范化序列化 `stackmaster-canonical-json/1`
  (自 `tooling/contract-smoke` 提升,冒烟 crate 经路径依赖消费同一实现);
- `vm-worker`(lib)`protocol` 模块:引擎进程协议骨架——`ENGINE_PROCESS_PROTOCOL_VERSION = 1`、
  stdio NDJSON 帧层(单帧上限 / 半包 / 一切协议层违规 fail-closed)、命令信封与 Worker 状态机;
  语义权威:`docs/develop/引擎进程协议.md`(冻结);
- 引擎面(VM 执行 / 投影 / 快照内容)按 WP-3 ~ WP-8 接线;骨架对通过契约校验的合法命令
  返回确定性 `internal_error` 占位。
