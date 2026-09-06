# docs 目录索引

本目录承载项目文档。**[`项目计划书.md`](项目计划书.md) 是唯一权威来源**,与其余文档冲突时以计划书为准;`CLAUDE.md`(仓库根)是其执行摘要。

## 目录结构

| 位置 | 内容 |
|---|---|
| `项目计划书.md` | 唯一权威来源:产品定位、四信任域架构、VM 语义、题目 DSL、判题与威胁模型、测试验收 |
| `contracts/` | **冻结契约与规则文档**(WP 交付物中"活"的规范面):字段分类、DSL 边界、嵌入协议、版本策略、规范化序列化 |
| `adr/` | **架构决策记录**(ADR 全文见计划书 5.4;本目录收录决策的执行记录与复核依据) |
| `phases/` | **阶段任务分解与验收评审**(随阶段推进增长) |
| `develop/` | **设计期文档**(模块设计与整改裁决过程记录,非冻结契约) |

## 文档清单

### contracts/(冻结契约与规则)

| 文档 | 交付 | 说明 |
|---|---|---|
| [数据分类与秘密零驻留清单.md](contracts/数据分类与秘密零驻留清单.md) | WP-1 | 每个跨域字段的 PUBLIC / SERVER_ONLY / BOUNDARY 分类与"秘密不进浏览器"论证;机检条目供 CI 直接引用 |
| [最小DSL范围.md](contracts/最小DSL范围.md) | WP-4 | 指令面 / 谓词面 / 编排面词汇的唯一来源;明确禁止项 |
| [嵌入协议.md](contracts/嵌入协议.md) | WP-5 | postMessage 消息契约、handshake 时序与校验规则 V-1 – V-13 |
| [版本策略.md](contracts/版本策略.md) | WP-6 | 四类版本的定义与关系、判题 / 回放记录项、生产环境锁定 |
| [规范化JSON序列化.md](contracts/规范化JSON序列化.md) | WP-6 | `stackmaster-canonical-json/1`:TS 与 Rust 双实现跨语言一致的前提 |

### adr/

| 文档 | 说明 |
|---|---|
| [ADR-8-vm-core语言产能决策.md](adr/ADR-8-vm-core语言产能决策.md) | vm-core 维持 Rust 的产能决策、证据与回退 tripwire(2026-09-05) |

### develop/(设计期与实现期文档)

| 文档 | 说明 |
|---|---|
| [Vm 模块设计.md](develop/Vm 模块设计.md) | Vm 模块设计(硬规范与语义) |
| [Vm 模块设计冲突与整改方案.md](develop/Vm 模块设计冲突与整改方案.md) | G / D 系列裁决与整改批次记录 |
| [Vm 模块后续审查事项与整改清单.md](develop/Vm 模块后续审查事项与整改清单.md) | R 系列审查整改与回归纪律 |
| [引擎进程协议.md](develop/引擎进程协议.md) | 编排器 / verifier ↔ vm-worker 进程协议:版本登记、帧格式、命令面、职责切分与错误语义(WP-1,冻结) |
| [秘密零驻留CI检查项映射.md](develop/秘密零驻留CI检查项映射.md) | 零驻留清单机检条目 → CI 检查项落点与反例位置(随 WP 接线更新) |

### phases/

| 文档 | 说明 |
|---|---|
| [阶段一任务分解.md](phases/阶段一任务分解.md) | WP-0 ~ WP-6 任务、依赖与退出条件(已全部完成) |
| [阶段一验收评审.md](phases/阶段一验收评审.md) | 阶段一退出条件逐条评审、门禁证据与阶段二移交项 |
| [阶段二任务分解.md](phases/阶段二任务分解.md) | WP-0 ~ WP-9:vm-engine 工程载体、challenge-compiler、vm-core / vm-runtime / projection / vm-worker、会话编排核心、测试强化与收尾 |

## 相关文档(包内)

契约语义文档随契约单一来源放在包内(`packages/*/docs`),由包发布物携带:

- [`packages/protocol/docs/会话动作协议语义.md`](../packages/protocol/docs/会话动作协议语义.md)(WP-2);
- [`packages/protocol/docs/投影与错误契约语义.md`](../packages/protocol/docs/投影与错误契约语义.md)(WP-3);
- [`packages/challenge-schema/docs/双包Schema语义.md`](../packages/challenge-schema/docs/双包Schema语义.md)(WP-4);
- [`packages/challenge-compiler/docs/装载与编译期校验语义.md`](../packages/challenge-compiler/docs/装载与编译期校验语义.md)(阶段二 WP-2)。

工具文档:[`tooling/contract-smoke/README.md`](../tooling/contract-smoke/README.md)(跨语言契约冒烟)。

## 变更纪律

`contracts/` 与包内契约语义文档均为冻结面:任何变更须先走 WP-1 §1.3 契约变更流程(先改分类论证 → 改契约包与 fixture → 评审 → 再改实现)。新增 ADR 落 `adr/`(命名 `ADR-<编号>-<主题>.md`);新阶段开工时在 `phases/` 增加任务分解与验收评审。
