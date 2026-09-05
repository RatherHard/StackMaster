# ADR-8 产能决策:vm-core 语言选定(阶段一收口 · WP-6)

| 项 | 值 |
|---|---|
| 状态 | **已决策(2026-09-05):维持 Rust,回退预案不触发**;本文件是该决策在阶段一收口时的执行记录与复核依据,与计划书 5.4 ADR-8 冲突时以计划书为准 |
| 决策人口径 | 计划书规定"阶段一结束时"决定;本记录据阶段一实际证据作出 |
| 关联 | 计划书 5.4(ADR-1 / ADR-3 / ADR-8)、§十四"Rust 人才与维护风险"、阶段一任务分解 WP-1(`VmState` 归属)与 WP-6 |

---

## 一、决策内容

**vm-core(及 vm-runtime、projection)以 Rust 实现,维持计划书 ADR-8 基线;TypeScript 回退路线保留但不触发。**

回退预案(计划书原文:"若阶段一结束时无 Rust 产能,回退为 TypeScript vm-core")的触发条件是"无 Rust 产能"。阶段一结束时点的产能证据见 §二;结论:未触发。

## 二、产能证据(阶段一结束时点,2026-09-05)

| 维度 | 证据 |
|---|---|
| 工具链 | Windows 11 x64 + stable-x86_64-pc-windows-msvc(1.98.1)安装即用;MSVC 14.44 + Windows SDK 在位;`cargo new → build → run` 全链路通过 |
| 生态 | `tooling/contract-smoke`(WP-6 冒烟)依赖 serde / serde_json / schemars / sha2 / jsonschema 五个生态包,下载、编译、clippy(`-D warnings`)、测试一次通过——契约消费面的生态可行性已实证 |
| 语言面 | ADR-8 已把 Rust 范围锁死为纯同步状态机:`#![forbid(unsafe_code)]`、无 async、无直接 IO、时钟与随机源 trait 注入。需要产能的"语言表面积"是 Rust 的一个小子集,学习与审查成本有界 |
| 产能结构 | 本项目以 AI 辅助开发为主力产能,"Rust 人才稀缺"风险(§十四)的结构性权重下降;审查负担由 clippy(-D warnings)、miri、fuzz(13.1)承接 |
| 回退成本 | 协议已 JSON Schema 化 + golden fixture 摘要清单锁双语言一致(WP-6);TS 回退与后续替换的成本上界已被契约纪律钉死(计划书 ADR-8 回退预案的前提已兑现) |

## 三、决策理由(为何维持 Rust)

1. **判定可信度依赖单实现**:verifier 与交互执行必须复用同一份回放引擎代码(计划书 ADR-8);"双实现消除分歧"是判题公信力的结构性要求,TS / Rust 双实现并存反而是最差形态;
2. **教学语义即内存破坏**:`u64` 地址、little-endian、位宽掩蔽、整数溢出语义是教学核心(R1-R15 已把 archBits / 溢出安全终止写进契约);Rust 对这些是一等公民,TS 需要 lint 纪律模拟(计划书 ADR-1 修订动因);
3. **确定性由语言与工具链保证**:`overflow-checks`、miri、fuzz 是引擎确定性(6.3)的机器保证,不是约定;
4. **回退预案作为保险而非默认**:契约纪律已使回退成本有界,但回退本身要重写 vm-core / vm-runtime / projection 并重新建立确定性证据——没有触发条件满足时不应支付该成本。

## 四、回退 tripwire(不触发 ≠ 永久豁免)

阶段二设置显式复核点:若阶段二中期评审(引擎 crate 首个可运行里程碑)出现以下**任一**情形,重新召开本决策:

1. 引擎 crate(vm-core / vm-runtime / projection)里程碑连续两次评审未达成,且瓶颈被判定为 Rust 产能而非范围问题;
2. `#![forbid(unsafe_code)]` / 无 async / 无 IO 纪律出现无法在不违反门禁的前提下维持的实现阻塞;
3. 跨语言契约纪律(fixture 摘要 + 冒烟)在阶段二实践中失守,双语言一致性成本超出预算。

tripwire 触发 → 按计划书回退预案执行(TS vm-core),契约与 fixture 不变;未触发 → 本决策顺延覆盖阶段三及以后,除非契约面发生需要重开 ADR 的变化。

## 五、对既有交付物的影响

- WP-1 的 `VmState` 归属悬置解除:阶段二按 Rust 实现 `VmState` 字段集合(WP-1 冻结的字段集合不变);
- `docs/版本策略.md` §四:verifier 与交互执行同锁同一引擎构建,由本决策的"单实现"理由支撑;
- 阶段二开工前置:CI 接入 cargo clippy(-D warnings)/ fmt / miri / fuzz 门禁(CLAUDE.md §测试与质量门禁),`tooling/contract-smoke` 纳入流水线;
- 本机工具链证据(§二)属环境事实,不写入仓库依赖;CI 环境的 Rust 工具链由阶段二工程化提供。
