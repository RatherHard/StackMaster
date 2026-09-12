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
| [ADR-9-verifier进程形态决策.md](adr/ADR-9-verifier进程形态决策.md) | verifier 进程形态 Q1 定案(候选 (b):Node verifier + vm-worker 裁决重放命令面)、裁决映射与拒裁方向、隐藏测试 11 值汇总合成(§四·一,7×11 矩阵)、fuzz / miri 评估(2026-09-12) |

### develop/(设计期与实现期文档)

| 文档 | 说明 |
|---|---|
| [Vm 模块设计.md](develop/Vm 模块设计.md) | Vm 模块设计(硬规范与语义) |
| [Vm 模块设计冲突与整改方案.md](develop/Vm 模块设计冲突与整改方案.md) | G / D 系列裁决与整改批次记录 |
| [Vm 模块后续审查事项与整改清单.md](develop/Vm 模块后续审查事项与整改清单.md) | R 系列审查整改与回归纪律 |
| [引擎进程协议.md](develop/引擎进程协议.md) | 编排器 / verifier ↔ vm-worker 进程协议:版本登记、帧格式、命令面、职责切分与错误语义(WP-1,冻结;阶段六 WP-61 additive 演进:裁决重放命令面 export_action_log / verify,§4.9,版本维持 1) |
| [秘密零驻留CI检查项映射.md](develop/秘密零驻留CI检查项映射.md) | 零驻留清单机检条目 → CI 检查项落点与反例位置(随 WP 接线更新) |
| [指令规约.md](develop/指令规约.md) | vm-core 逐 opcode 执行语义权威规约:统一执行入口、位宽 / 栈 / 标志模型、异常与事件面、调用与 Canary、自定义指令与接口派发(WP-4) |
| [判题语义规约.md](develop/判题语义规约.md) | vm-core 判题语义权威规约:谓词求值、权威成功 / 失败判定、多阶段状态机运行时、seed 策略与派生、隐藏测试执行(WP-5);§八·一 正式裁决 11 值汇总语义(阶段六 WP-62) |
| [快照与回放语义规约.md](develop/快照与回放语义规约.md) | vm-runtime 权威规约:COW 分页快照与 checkpoint、规范化动作日志(6.3 清单)、revision / undo / checkout / reset 语义、回放一致性、版本锁定与资源计数(WP-6) |
| [权威API语义规约.md](develop/权威API语义规约.md) | session-api / verifier(D-API-* )实现期决策单一登记处:路由与通道形态、凭证链路、版本窗口与幂等窗口运维参数、通道行为、工程载体纪律(配置 fail-closed / 日志纪律 / 优雅停机)、限流与配额、跨域机检、指标面与 k6 基线(阶段三 WP-0 ~ WP-8 全量;阶段六 WP-60 / WP-61:D-API-83~89;阶段六 WP-64:D-API-90~93;阶段六 WP-62:D-API-94~96;阶段六 WP-63:D-API-97~100;阶段六 WP-65:全面租户隔离与限流预算复核 D-API-101~104——PG RLS 全表域与连接层租户上下文注入、Q6 限流七键逐键定案、Redis 键域 T1 边界复核、/metrics 生产暴露面收敛;阶段六 WP-66:容器级 Worker 隔离 D-API-105~106——Q4 容器池定案(缺省进程池 / 显式启用)、执行形态接口与镜像策略、语义保持测试面与冷启动 / 镜像预算量化登记;阶段六 WP-68 题目集部分:MVP 题目集登记与发布面 D-API-107(8 道渐进式题目)、D-J8 产品决策登记 D-API-108(不启用真实实例 ASLR)、ZR-B13 非平凡复算 fixture 接入 D-API-109) |

### phases/

| 文档 | 说明 |
|---|---|
| [阶段一任务分解.md](phases/阶段一任务分解.md) | WP-0 ~ WP-6 任务、依赖与退出条件(已全部完成) |
| [阶段一验收评审.md](phases/阶段一验收评审.md) | 阶段一退出条件逐条评审、门禁证据与阶段二移交项 |
| [阶段二任务分解.md](phases/阶段二任务分解.md) | WP-0 ~ WP-9:vm-engine 工程载体、challenge-compiler、vm-core / vm-runtime / projection / vm-worker、会话编排核心、测试强化与收尾 |
| [阶段二验收评审.md](phases/阶段二验收评审.md) | 阶段二退出条件逐条评审(十条全过)、13.1 清单逐条核对、门禁证据与 ADR-8 tripwire 验收点结论(WP-9) |
| [阶段三任务分解.md](phases/阶段三任务分解.md) | WP-0 ~ WP-8:会话级命令与传输信封契约冻结、session-api 工程载体、认证与凭证、持久化与快照加密静止、REST 生命周期、认证 WSS 与投影下发、限流配额、跨域载荷机检与 Compose 集成、可观测与收尾 |
| [阶段三验收评审.md](phases/阶段三验收评审.md) | 阶段三退出条件逐条评审(§五退出条件 → 可复跑证据)、13.3 / 13.5 条目核对表、TS / Rust / 覆盖率 / fixture / ZR-ENG 映射门禁证据汇总与阶段四 / 五 / 六移交项(WP-8) |
| [阶段四任务分解.md](phases/阶段四任务分解.md) | 三轨道统一分解:前端落地(WP-F1~F7,承接《前端实施计划》)、调试通道后端与契约演进(WP-40~44,ADR-DC1 §四)、汇合与教学组件面(WP-F8/F9 + FE-ED 系 + WP-45);依赖图、里程碑与十条退出条件 |
| [阶段四验收评审.md](phases/阶段四验收评审.md) | 阶段四退出条件逐条评审(§五十条 → 可复跑证据)、清单 A 类 19 条勾稽表、门禁证据汇总、决策点定案记录(Q3/Q5/debugMode/ASLR/SeedDeriver 黄金向量/推送模型/虚拟列表裁决)与阶段五 / 六移交清单(WP-45) |
| [阶段五任务分解.md](phases/阶段五任务分解.md) | WP-50 ~ WP-56:嵌入交付通道与描述包下发定案(前置)、embed-runtime 宿主侧 SDK 与 react-wrapper、插件 Shell 正式实现(web-component 占位退场)、主题与语言机制面(vm-ui 增量)、M2 描述包正式下发接入、测试与门禁(13.3 iframe 面 E2E / axe 真机补测 / 13.4 浏览器矩阵)、验收评审;边界裁决(契约零新增基线、主题/语言为实现义务非美化、CDN 归生产部署面)、六决策点与十条退出条件 |
| [阶段六任务分解.md](phases/阶段六任务分解.md) | WP-60 ~ WP-68:裁决呈现通道与异步裁决语义定案(前置,契约先行)、verifier 独立裁决服务(信任域 4)、隐藏测试裁决与正式裁决汇总(判题驱动复用)、正式裁决结果呈现(vm-ui 增量)与 ZR-T4 收口、审计面完善与归档、全面租户隔离与限流租户预算复核、容器级 Worker 隔离(T1)、安全测试收口(9.2 / 13.5 与裁决可复现)、MVP 题目集 / T3 扩展评估与验收评审;边界裁决(T0 收口与 T1 进入次序、v1 seed 无应用面的裁决重放语义、T2 / T3 边界、admin 不在本阶段)、六决策点(Q1~Q6)与十一条退出条件 |
| [阶段五验收评审.md](phases/阶段五验收评审.md) | 阶段五退出条件逐条评审(§五十条:9 ✅ + 1 ⚠️ 环境依赖遗留 → 阶段五可退出)、七工作包交付清单、门禁证据汇总(TS 1875 / Rust 684 / IT 1904 / E2E 21 / 覆盖率 90.06+ / axe 真机零 violations)、决策点定案记录(Q1~Q6 + 实现期定案收编 D-API-78~82)与环境依赖遗留登记(WebKit linux CI 复跑义务、屏幕阅读器 / Windows 高对比度人工抽样)(WP-56) |
| [阶段六安全测试收口.md](phases/阶段六安全测试收口.md) | WP-67 收口报告:9.2 威胁模型四边界逐格证据表(裁决边界攻击面矩阵:裁决伪造 / 重放请求伪造 / verdict 重询滥用 / 侧信道观察逐格锚)、13.5 秘密零驻留四类取证(构建产物 / 运行时含 verifier seed 零驻留与容器零留存 / 投影泄漏 ZR-P1~P8 / 客户端篡改 ZR-T1~T4)、裁决可复现矩阵(跨重启 / 跨部署双实例 / golden 三路一致延伸 / 独立性矩阵:T1 退出条件两条达成)、侧信道论证(裁决时延 = 队列深度函数)、T-SC1~T-SC4 取证与 WP-68 逐题移交登记、阶段五遗留义务逐条核验(WebKit CI 复跑挂账 / 人工抽样挂账 / IT 承载确认)、新增测试清单与红灯证据如实登记、门禁汇总(TS 2088 / Rust 728 双 profile / IT 107+83 / compose host 29 用例) |

## 相关文档(包内)

契约语义文档随契约单一来源放在包内(`packages/*/docs`),由包发布物携带:

- [`packages/protocol/docs/会话动作协议语义.md`](../packages/protocol/docs/会话动作协议语义.md)(WP-2);
- [`packages/protocol/docs/投影与错误契约语义.md`](../packages/protocol/docs/投影与错误契约语义.md)(WP-3);
- [`packages/challenge-schema/docs/双包Schema语义.md`](../packages/challenge-schema/docs/双包Schema语义.md)(WP-4);
- [`packages/challenge-compiler/docs/装载与编译期校验语义.md`](../packages/challenge-compiler/docs/装载与编译期校验语义.md)(阶段二 WP-2)。

应用上手文档:[`apps/session-api/README.md`](../apps/session-api/README.md)(阶段三 WP-8:Compose 一键拓扑、环境变量与迁移、test:compose 双形态、Windows 降级路径、/metrics 指标面、k6 基线、常见问题)。

工具文档:[`tooling/contract-smoke/README.md`](../tooling/contract-smoke/README.md)(跨语言契约冒烟)。

## 变更纪律

`contracts/` 与包内契约语义文档均为冻结面:任何变更须先走 WP-1 §1.3 契约变更流程(先改分类论证 → 改契约包与 fixture → 评审 → 再改实现)。新增 ADR 落 `adr/`(命名 `ADR-<编号>-<主题>.md`);新阶段开工时在 `phases/` 增加任务分解与验收评审。
