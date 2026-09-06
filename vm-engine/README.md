# vm-engine

Rust workspace(信任域 3,仅后端;ADR-8):权威执行域引擎。

| crate | 职责 | 依赖 |
|---|---|---|
| `vm-core` | 纯 VM 语义:状态模型、内存 / 寄存器、指令执行、判题 | — |
| `vm-runtime` | COW 快照、规范化动作日志、回放、私有题目包装载 | vm-core |
| `projection` | ProjectionPolicy 白名单求值与执行域内脱敏(ADR-7) | vm-core |
| `vm-worker` | 二进制:单会话进程入口,stdio JSON 协议;时钟 / 随机源实现层 | vm-core、vm-runtime、projection |

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

契约消费(serde + schemars 镜像、引擎进程协议)按阶段二 WP-1 接线,实现严格
消费阶段一冻结契约,不另造私有格式。
