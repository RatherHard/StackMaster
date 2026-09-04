# StackMaster 开发规范

本文件是 Claude Code 在本仓库工作的操作规范,是 `docs/项目计划书.md`(唯一权威来源)的执行摘要。两者冲突时以计划书为准,并回过头更新本文件。

## 项目一句话

StackMaster 是一个**可嵌入、可回放、可解释的 Pwn 概念实验室**:后端权威 VM + 浏览器公开投影,以 Web 插件(独立来源 iframe + Web Component)形态嵌入各类 CTF 平台,让初学者通过直接操作内存学习 pwn 基础。MVP 聚焦"栈帧、缓冲区与返回地址"闭环(计划书 11.1)。

**非目标**:不做完整 CPU/OS 模拟器、完整 x86-64 指令集、ELF 加载器、真实 shellcode、完整 glibc、复杂堆分配器、在线编辑器、AI 自动 exploit、多人实时协作;浏览器端永远不存在本地权威执行或本地判题。

## 四条底线(计划书十六章,任何改动不得违反)

1. VM Core、完整状态和隐藏判题信息完全隔离在后端。
2. 浏览器只接收可公开的脱敏投影,不负责最终计分或权威状态保存。
3. 服务端会话串行执行所有动作;单步、回退、checkpoint、回放和最终裁决均以服务端为准。
4. 题目 DSL 不执行任意宿主代码;默认使用独立来源 iframe;保持 Core、UI、协议和平台适配层解耦。

## 安全红线(每次涉及数据流动的改动逐条自查)

- **浏览器完全不可信**(9.2)。任何发送到浏览器的数据——投影、错误、事件、长度、时序——都视为可被选手完整读取。
- `VmState`、私有题目包、隐藏测试、seed、权威快照、完整 IR 只存在于 vm-worker 进程内(信任域 3,5.2)。
- 投影的白名单过滤与脱敏在执行域内完成(ADR-7);编排器、网络通道与浏览器上只允许出现公开投影。
- 禁止发送到浏览器:隐藏 flag、隐藏测试、私有目标条件、私有 capability 返回值、完整 IR、原始快照、完整事件日志、内部堆栈与文件路径(9.2)。
- 禁止 FFI / N-API 内嵌;TS 与 Rust 只通过进程边界(spawn + JSON 协议)通信(ADR-3)。
- TS 构建图不得引用 vm-engine 任何产物;浏览器不得加载 VM Core、可执行 IR 或私有题目包(5.5,CI 产物扫描强制)。
- 服务端从认证上下文派生用户/租户/题目,不接受请求体或 postMessage 自报身份(6.2)。
- 侧信道约束:错误精度按 ProjectionPolicy 粗化;投影、错误与回放不得通过长度、时序或分类差异间接泄露秘密(9.2)。
- 前端混淆、禁用右键、检测 DevTools 不是反作弊手段;有效控制只在服务端串行执行、独立重放、隐藏测试、短期凭证、限流与审计(9.2)。
- 公开描述包与私有判题包字段严格分离,禁止通过默认值、引用 ID 或 Schema 元数据从公开包推导私有字段(7.1、13.2)。

## 仓库结构与依赖方向

```text
stackmaster/
├── apps/                     # TypeScript 应用(pnpm workspaces)
│   ├── session-api/          # 会话编排器(Fastify;管理 vm-worker 进程池)——信任域 2
│   ├── verifier/             # 独立裁决服务(复用 vm-engine 回放实现)——信任域 4
│   ├── admin/                # 管理后台(独立凭证与部署)——信任域 4
│   └── plugin-dev/           # 插件 iframe 开发壳与接入 Demo
├── packages/                 # TypeScript 包
│   ├── protocol/             # @stackmaster/protocol:Zod 契约 → JSON Schema(跨语言契约唯一来源)
│   ├── challenge-schema/     # 公开/私有题目包 JSON Schema 与字段分类校验器
│   ├── challenge-compiler/   # DSL → 受限 IR(仅后端)
│   ├── embed-runtime/        # postMessage 嵌入协议(宿主侧 SDK)
│   ├── web-component/        # <pwn-memory-vm>(Lit 3)
│   ├── vm-ui/                # 投影渲染:字节视图、寄存器、调用栈、时间线、Payload 构造器
│   └── react-wrapper/        # 可选 React 薄包装
├── vm-engine/                # Rust workspace(cargo)——信任域 3,仅后端
│   ├── vm-worker/            # 二进制:单会话进程入口,stdio / 本地 socket JSON 协议
│   ├── vm-core/              # 纯 VM 语义
│   ├── vm-runtime/           # COW 快照、规范化动作日志、回放、私有题目包加载
│   └── projection/           # ProjectionPolicy 白名单与脱敏
├── tooling/                  # eslint、dependency-cruiser、clippy 配置、CI 脚本与隔离扫描
└── docs/
```

依赖方向由 CI 强制(dependency-cruiser / cargo workspace 声明,5.5):

- TS:`protocol` 可被所有 TS 包依赖(唯一跨域共享面);`challenge-schema` 只被 challenge-compiler、session-api、verifier 依赖;`vm-ui` / `web-component` / `embed-runtime` / `react-wrapper` 只依赖 `protocol`。
- Rust:`vm-core` ← vm-runtime、projection、vm-worker;`vm-runtime` 与 `projection` ← vm-worker。
- 跨语言规则:IR 与题目包是版本化**序列化格式**,不是共享代码;VM Core 不知道自己运行在 Lit、React、iframe 还是 Node.js 里。

## 技术栈速查(5.4;ADR 全文见计划书 5.4)

| 层 | 选型 |
|---|---|
| 浏览器 UI | Lit 3 + TypeScript;Vite library mode 多入口;语义化 DOM + lit-virtualizer + SVG;IndexedDB(idb-keyval) |
| 契约 | `@stackmaster/protocol`(Zod → JSON Schema);题目包 JSON Schema 2020-12 + Ajv |
| 传输 | HTTPS + Fastify(REST);认证 WSS(@fastify/websocket)+ JSON 消息 |
| 服务运行时 | Node.js LTS(≥22) |
| VM 引擎 | Rust(safe Rust,无 async、无直接 IO),进程边界交付 `vm-worker` |
| 数据 | PostgreSQL 16+(唯一权威存储);Redis 7+(只存可重建、带 TTL 状态);MinIO / S3(私有判题包、trace) |
| 工程 | pnpm workspaces + Turborepo + Cargo workspace;Vitest + fast-check、cargo test + proptest、Playwright、axe-core、k6 |
| 边界强制 | dependency-cruiser + ESLint + cargo clippy |
| 可观测 | Pino / tracing + OpenTelemetry + Prometheus |
| CI/CD | GitHub Actions + Changesets(npm 发布) |

## Rust 引擎纪律(vm-engine/*,ADR-8)

- 每个 crate 顶部 `#![forbid(unsafe_code)]`,纯 safe Rust 同步状态机;
- 无 async、无直接 IO;禁用 `std::time`、`rand`、`std::io`、`std::net` 与文件系统;时钟与随机源由 trait 注入(6.3);
- release 构建 `overflow-checks = true`;溢出触发时按 `engine_error` 安全终止,不得静默回绕;
- 地址与 archBits 位宽架构值(G1/D1:出题人指定 32/64,以 64 位容器承载、高位按位宽掩蔽)在 VM Core 内是一等公民(端序内建);题目 DSL 与公开 API 用明确的十六进制字符串(6.2);
- verifier 与交互执行复用**同一份**回放引擎代码(ADR-8),禁止写第二套实现;
- Rust 收益来自安全与语义保真,不是速度——不要为性能引入 unsafe、async 或低层优化。

## 契约纪律(5.6)

- `protocol` / `challenge-schema` 包是契约单一来源;Zod schema 同时产出 TS 类型与 JSON Schema;JSON Schema 是 TS 与 Rust 的共同权威,Rust 以 serde + schemars 消费;
- 服务端对一切入站数据(HTTP、WSS、postMessage 转发的动作)按同一契约重新校验,不信任客户端类型标注;
- 每类契约(嵌入协议、会话动作协议、题目包 Schema、引擎进程协议)携带独立版本号;破坏性变更递增版本并保留 N-1 兼容窗口;
- 错误类型也是契约:`PublicError` 枚举保持稳定,前端不得解析非契约字段;
- 修改协议必须同步更新 golden fixture:同一组样例必须被 TS 与 Rust 校验器同时接受或拒绝,且规范化 JSON 序列化一致。

## 确定性与回放(6.3)

- 回放不得依赖当前时间、浏览器随机数、网络响应顺序、宿主线程调度或浏览器未定义行为;
- 题目需要随机化时只用可复现的服务端 seed,并把 seed 策略与环境版本写入回放信息;
- 动作日志 append-only,每次操作记录:类型与参数、前后状态哈希、内存/寄存器变化、事件序号、题目版本、VM Profile 与引擎版本;
- 内存按固定大小分页,COW 快照,不逐步复制完整状态;
- 生产环境锁定执行环境版本,不得自动使用"最新引擎"(7.4)。

## API 与会话安全基线(6.2、9.1)

所有状态变化走统一动作链路:`ActionRequest → 认证/授权/revision/幂等校验 → 服务端 VM 状态转换 → 私有目标条件检查 → ProjectionPolicy 脱敏 → ActionResponse / ProjectionDelta`。

服务端必须:校验会话 token 绑定;校验 `baseRevision`;以 `idempotencyKey` 防重;单会话内串行;对动作参数、地址、区域权限、操作数与资源预算重新校验。浏览器不得提交自制快照、状态哈希或成功标志覆盖服务端状态。稳定结果类型:`success`、`wrong_answer`、`invalid_action`、`program_crash`、`memory_fault`、`resource_limit`、`timeout`、`engine_error`、`challenge_invalid`、`replay_mismatch`、`cancelled`(9.1)。

## 前端约束(第十章)

- 浏览器任何位置(主线程、Worker、IndexedDB)只保存公开投影与 UI 状态;
- 按"教学动作或关键事件"粒度返回 `ProjectionDelta`,不逐条指令发完整投影;服务端维护 dirty range 合并连续写入;
- 用 `requestAnimationFrame` 合帧,只更新变化的内存 cell,不重绘整张内存表;
- 断线时只展示最近一次收到的公开投影;重连走 `sync-projection`;禁止降级为本地 VM 执行;
- Web Worker(可选)仅做公开投影合并与渲染辅助,不得运行 VM;
- 动画只用 transform / opacity 等 compositor 友好属性;字节视图用语义化 DOM + 虚拟列表,控制流关系用 SVG;屏幕阅读器信息不得只存在 Canvas 中;
- 传输层二进制编码、压缩等优化必须有 benchmark 证据后才引入(10.1)。

## 技术路线纪律(5.1)

当前处于 **T0 最小闭环**(TS 服务层 + Rust VM Engine、单实例编排器、每会话独立 Worker 进程、Docker Compose),目标是 MVP 验收。K8s、Kafka/NATS 等消息中间件、微服务拆分、二进制投影编码、VM Core WASM 化均属 T2/T3 选项——进入条件(benchmark 或教学数据证据)满足前不得引入。工程精力优先投给正确性、可解释性和测试覆盖。

## 测试与质量门禁(5.8、第十三章,CI 全部必过)

1. TS:tsc(project references)+ ESLint;Rust:cargo clippy(`-D warnings`)+ cargo fmt 检查;
2. dependency-cruiser 依赖边界 + 引擎确定性 lint + `#![forbid(unsafe_code)]` 检查;
3. 单元与属性测试:Vitest + fast-check / cargo test + proptest;覆盖率整体 ≥ 80%,`vm-core`、`vm-runtime`、`projection`、`challenge-compiler` ≥ 90%;
4. cargo miri(vm-core 无未定义行为)+ cargo-fuzz(题目包、动作与 IR 解析器);
5. golden fixture 跨语言往返一致;
6. 浏览器产物隔离扫描(不得含引擎代码、私有题目包内容、vm-worker 二进制);
7. Compose 集成测试:会话创建 → 动作 → 投影 → 断线重连 → 提交裁决全链路;
8. Playwright E2E:iframe 嵌入、Chrome/Firefox/Safari、断线恢复;
9. k6 benchmark 归档(T2 触发判据)。

新功能先写测试(TDD);测试用行为描述命名;错误反馈断言要覆盖"可解释性"而不只是状态码。

## 常用命令

> WP-0 已落地 TS 工程基线:pnpm workspaces + Turborepo,含 `packages/protocol`、`packages/challenge-schema`、`tooling/`(ESLint flat config 与 dependency-cruiser 配置)。WP-1 已冻结数据分类与秘密零驻留清单(`docs/数据分类与秘密零驻留清单.md`);WP-2 已冻结会话动作协议 v1(`packages/protocol`:Zod 契约 + JSON Schema 2020-12 落盘 + `docs/会话动作协议语义.md`);WP-3 已冻结投影与错误契约(`PublicStateProjection` 7 字段及子类型、`ProjectionDelta`/`DirtyRange` 增量、`PublicError` 16 值错误码 + 逐 code 能力矩阵、`ProjectionPolicy` server-only 专用面;语义见 `packages/protocol/docs/投影与错误契约语义.md`;`ProjectionPolicy` Schema 仅经 `@stackmaster/protocol/server-only` 子路径供后端包消费,浏览器可达包导入即 dependency-cruiser 违规)。WP-4 已冻结题目双包 Schema 与最小 DSL 范围(`packages/challenge-schema`:公开描述包 / 私有判题包 JSON Schema 2020-12、`schema/classification.json` 字段分类清单、严格 JSON 扫描器、Ajv 校验器与 `checkChallengePair` 字段分类检查器(规则 ID 对齐 WP-1 §12.6,逐规则红灯样例);私有面仅经 `@stackmaster/challenge-schema/server-only` 子路径供后端包消费,Schema 存在不等于可下发;DSL 范围见 `docs/最小DSL范围.md`,契约语义见 `packages/challenge-schema/docs/双包Schema语义.md`)。双包契约已按《Vm 模块设计冲突与整改方案》完成 G1–G4 重定基(2026-09-04,契约层整改全部落地):公开包 `vmProfile.archBits`(32/64)必填位宽声明、区域六类(新增作者自定义 `custom`,publicLabel 承载类型名)、区域大小与页大小收紧为 4KB 的倍数,检查器规则 `XS-ARCH-WIDTH`(跨包位宽域)与 `XS-MEM-PAGE-ALIGN`(VMA 页对齐,Schema multipleOf 之外的纵深防御);G2/D3 寄存器双命名空间保留模型(一般名自由命名 `^[A-Z][A-Z0-9_]{0,15}` + FLAG 保留区 `^FLAG[A-Z0-9_]*`)、必选核心寄存器 RSP/RBP/RIP、上限放宽(总 256 / 可见 64),检查器 `XS-REG-CORE`/`XS-REG-NAMESPACE` 接替已废止的 `XS-REG-FROZEN`;G4/D4 指令面自由设定——基线 opcode 20 个(`read`/`write` 废止、新增 `leave`)、IR op 双形态(基线小写枚举 ∪ 大写自定义助记符)、私有包 `customInstructions`(微算子封闭集 v1,直线序列)与 `interfaces`(效果原语封闭集 v1;`interfaceId` ∈ [0x100, 0xFFFF],保留带 [0x0, 0xFF] 为内置 exit 不开放声明)声明面、`syscall` 封闭单值伪操作、`dslSchemaVersion`/`irFormatVersion` = 2、字段分类清单 19 字段,检查器新增 `XS-CUSTOM-DEF`/`XS-CUSTOM-REF`/`XS-CUSTOM-DISPLAY`/`XS-SYSCALL-DECL`/`XS-IFACE-REF`/`XS-IR-LEAVE`;作者自定义 = 私有包内声明式映射表(数据)+ 引擎封闭原语解释执行,无宿主侧注册、无脚本形态,「题目 DSL 不执行任意宿主代码」红线不变。`apps/` 与 `vm-engine/` 自阶段二起搭建,下列命令中 vm-engine 与 docker compose 部分在对应阶段落地前执行会失败,属预期现象。

```bash
pnpm install                              # 安装 TS 依赖(workspaces)
pnpm build                                # Turborepo 全量构建(tsc -b 逐包)
pnpm dev                                  # plugin-dev 开发壳(Vite;阶段二落地)
pnpm test / pnpm lint / pnpm typecheck    # 测试 / ESLint / tsc project references
pnpm lint:deps                            # 依赖边界检查(dependency-cruiser)

cd vm-engine
cargo test                                # 引擎测试 + proptest
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo +nightly miri test -p vm-core       # UB 检查
RUSTFLAGS="-C overflow-checks=on" cargo build --release

docker compose up -d                      # dev:PostgreSQL + Redis + MinIO + session-api + verifier + Vite
```

## 开发工作流与提交规范

- 复杂功能先出实现计划再写代码;涉及协议、投影、题目包 Schema 的改动,必须先更新 `protocol` / `challenge-schema` 契约与 golden fixture,再改实现;
- 涉及认证、投影生成、协议、题目包校验、判题的代码,提交前必须做安全审查;
- 文档、提交信息与面向人的注释用中文;代码标识符用英文;
- Conventional commits:`feat|fix|refactor|docs|test|chore|perf|ci: <描述>`;对外发包(`web-component`、`react-wrapper`、`embed-runtime`)用 Changesets;
- 不提交 `.env`、私有题目包样本、真实隐藏 flag;`private-bundles` 类内容永不进入 git。

## 计划书章节速查

| 主题 | 章节 |
|---|---|
| 产品定位、目标用户、边界与非目标 | 一、二、三 |
| 四信任域架构与运行时拓扑 | 5.2、5.3 |
| 技术选型与 ADR | 5.4 |
| Monorepo 结构与依赖方向 | 5.5 |
| 契约与版本化 | 5.6 |
| 数据持久化 | 5.7 |
| 部署、可观测、质量门禁 | 5.8 |
| VM 语义、状态模型、确定性 | 六 |
| 题目 DSL 与双包模型 | 七 |
| 插件嵌入与协议 | 八 |
| 权威判题与威胁模型 | 九 |
| 前端性能约束 | 十 |
| MVP 定义 | 十一 |
| 开发阶段 | 十二 |
| 测试与验收 | 十三 |
