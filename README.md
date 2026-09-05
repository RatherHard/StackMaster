# StackMaster

**可嵌入、可回放、可解释的 Pwn 概念实验室** —— 后端权威 VM + 浏览器公开投影,以 Web 插件形态嵌入各类 CTF 平台,让初学者通过直接操作内存学习 pwn 基础。

> StackMaster **不是**浏览器中的完整 Linux 或 x86 模拟器。它把内存可视化地展现在学习者面前,让学习者通过指定的操作方式直接操作内存、解决 VM 中的谜题,从而理解栈帧、缓冲区与返回地址等 pwn 核心概念。

## 为什么做这个

由于 AI 的冲击,CTF 新生赛放经典题的必要性已经丧失,新生难以获得学习的正向反馈。StackMaster 用"可视化内存 VM + 服务端会话"替代传统题型:

- 学习者**直观看到**内存布局、寄存器与指令的相互作用,而不是面对黑盒二进制;
- 学习者的每次操作都在服务端权威会话中执行,可单步、可回退、可回放、可解释失败原因;
- 出题人通过题目 DSL 自定义虚拟指令集、寄存器与内存布局,方便地维护渐进式题目;
- CTF 平台以 Web 插件(独立来源 iframe + Web Component)接入,不强制宿主技术栈。

## 安全模型

核心原则:**后端权威 VM,浏览器公开投影**。

```text
═══ 信任域 1:浏览器展示域(完全不可信)═══
  宿主 CTF 平台 → 插件 iframe(Lit Web Components)
  只持有公开投影、题面与 UI 状态;篡改浏览器不影响成绩

═══ 信任域 2:接入编排域(无秘密)═══
  会话编排器(Fastify):认证、限流、revision/幂等校验、会话路由

═══ 信任域 3:权威执行域(秘密驻留区,无网络出口)═══
  VM Worker(Rust,每会话独立进程)
  VmState、私有题目包、隐藏测试、seed、权威判题都在这里;
  投影经 ProjectionPolicy 白名单脱敏后才能离开

═══ 信任域 4:裁决审计域(独立部署)═══
  独立 verifier(重放动作日志裁决)+ 管理后台
```

由结构保证的三条规则:

1. **秘密不出执行域** —— `VmState`、私有题目包、隐藏测试和 seed 只存在于 VM Worker 进程内,浏览器任何位置(主线程、Worker、IndexedDB)都不可能有隐藏关键信息;
2. **跨域只传投影** —— 编排器、网络通道与浏览器上只出现白名单过滤后的公开投影;TS 与 Rust 之间没有共享代码,只有 `@stackmaster/protocol` 的 JSON Schema 契约;
3. **隔离可机器验证** —— 依赖边界(dependency-cruiser / cargo workspace)与浏览器产物扫描在 CI 强制执行。

服务端会话串行执行一切动作;单步、回退、checkpoint、回放与最终裁决均以服务端为准,且独立 verifier 复用同一份回放引擎重放裁决。前端混淆、禁用右键、检测 DevTools 不是反作弊手段——有效控制只在服务端。

## 非目标

不做完整 CPU/OS 模拟器、完整 x86-64 指令集、ELF 加载器、真实 shellcode、完整 glibc、复杂堆分配器、在线编辑器、AI 自动 exploit、多人实时协作;**浏览器端永远不存在本地权威执行或本地判题**。

## MVP 范围(11.1)

第一版聚焦 **栈帧、缓冲区与返回地址** 闭环:栈内存可视化、`RSP`/`RBP`/`RIP`、局部 buffer 与 saved RBP / return address、little-endian、`write_bytes`、`push/pop`、`call/ret`、服务端单步/回退/checkpoint/时间线、分级提示与可解释错误、公开描述包 + 私有判题包双包格式、iframe Demo 与 Web Component、会话 API 与断线恢复、独立 verifier 与审计日志、6–10 道渐进式题目。

完成标准:学习者能打开题目、观察栈帧、构造 payload、经服务端会话执行受控操作、看到投影变化、解释失败原因、回退重试并完成一次服务端裁决提交;同时篡改浏览器内存既拿不到隐藏信息,也影响不了成绩。

## 仓库结构

```text
stackmaster/
├── apps/                     # TS 应用(阶段二起搭建)
│   ├── session-api/          # 会话编排器(信任域 2)
│   ├── verifier/             # 独立裁决服务(信任域 4)
│   ├── admin/                # 管理后台
│   └── plugin-dev/           # 插件 iframe 开发壳
├── packages/                 # TS 包(pnpm workspaces)
│   ├── protocol/             # @stackmaster/protocol:Zod 契约 → JSON Schema(已落地,会话动作协议 v1)
│   ├── challenge-schema/     # 公开/私有题目包 Schema(WP-4,进行中)
│   ├── challenge-compiler/   # DSL → 受限 IR(仅后端)
│   ├── embed-runtime/        # postMessage 嵌入协议(宿主侧 SDK)
│   ├── web-component/        # <pwn-memory-vm>(Lit 3)
│   ├── vm-ui/                # 投影渲染:字节视图、寄存器、调用栈、时间线
│   └── react-wrapper/        # 可选 React 薄包装
├── vm-engine/                # Rust workspace(信任域 3,阶段二起搭建)
│   ├── vm-worker/            # 单会话进程入口,stdio JSON 协议
│   ├── vm-core/              # 纯 VM 语义(safe Rust,无 async、无直接 IO)
│   ├── vm-runtime/           # COW 快照、动作日志、回放
│   └── projection/           # ProjectionPolicy 白名单与脱敏
├── tooling/                  # ESLint、dependency-cruiser 等工程配置(已落地)
└── docs/                     # 项目计划书(唯一权威来源)与各阶段交付文档
```

依赖方向由 CI 强制:所有 TS 包只通过 `@stackmaster/protocol` 共享契约;IR 与题目包是版本化**序列化格式**,不是共享代码;TS 构建图不得引用 vm-engine 任何产物。

## 技术栈

| 层 | 选型 |
|---|---|
| 浏览器 UI | Lit 3 + TypeScript,语义化 DOM + 虚拟列表 + SVG |
| 契约 | Zod → JSON Schema 2020-12(`@stackmaster/protocol`);题目包 JSON Schema + Ajv |
| 传输 | HTTPS + Fastify(REST);认证 WSS + JSON 消息 |
| 服务运行时 | Node.js LTS(≥22) |
| VM 引擎 | Rust(`#![forbid(unsafe_code)]`,无 async、无直接 IO,确定性状态机) |
| 数据 | PostgreSQL 16+(唯一权威存储);Redis 7+(可重建、带 TTL 状态);MinIO / S3 |
| 工程 | pnpm workspaces + Turborepo + Cargo workspace;Vitest + fast-check、cargo test + proptest、Playwright、k6 |

Rust 收益来自安全与语义保真,不是速度——回放不得依赖当前时间、随机数或调度顺序,题目随机化只用可复现的服务端 seed。

## 快速开始

环境要求:Node.js ≥ 22、pnpm(≥ 11;Rust 工具链在阶段二后需要)。

```bash
pnpm install            # 安装 TS 依赖(workspaces)

pnpm build              # Turborepo 全量构建(tsc -b 逐包)
pnpm test               # 测试(Vitest)
pnpm lint               # ESLint
pnpm typecheck          # tsc project references
pnpm lint:deps          # 依赖边界检查(dependency-cruiser)
pnpm fixtures:manifest  # golden fixture 规范化摘要清单(生成;--check 校验)
pnpm smoke:contract     # Rust 侧契约冒烟(需 Rust 工具链;tooling/contract-smoke)
pnpm scan:public        # 公开产物隔离扫描
```

> 阶段一(契约与信任模型冻结)已于 2026-09-05 关闭(见 [`docs/phases/阶段一验收评审.md`](docs/phases/阶段一验收评审.md));下一步进入阶段二(后端 VM Core 与会话编排),`apps/` 与 `vm-engine/` 随阶段二落地。下列命令在对应阶段完成后可用:
>
> ```bash
> cd vm-engine && cargo test                # 引擎测试 + proptest
> cargo clippy --all-targets -- -D warnings
> cargo +nightly miri test -p vm-core       # UB 检查
>
> docker compose up -d                      # PostgreSQL + Redis + MinIO + session-api + verifier
> ```

## 当前进展与路线图

开发阶段与里程碑见计划书第十二章;阶段一任务分解见 [`docs/phases/阶段一任务分解.md`](docs/phases/阶段一任务分解.md)。

| 工作包 | 内容 | 状态 |
|---|---|---|
| WP-0 | 最小工程载体(pnpm workspaces + Turborepo + 工具链) | ✅ 完成 |
| WP-1 | 数据分类与秘密零驻留清单 v1.1 | ✅ 冻结 |
| WP-2 | 会话动作协议 v1(Zod 契约 + JSON Schema 落盘 + 语义文档) | ✅ 冻结 |
| WP-3 | 投影与错误契约 | ✅ 冻结 |
| WP-4 | 题目双包 Schema 与最小 DSL 范围 | ✅ 冻结 |
| WP-5 | iframe handshake 与嵌入协议 | ✅ 冻结 |
| WP-6 | 版本策略、规范化序列化、golden fixture 跨语言冒烟、ADR-8 与阶段收尾 | ✅ 完成(阶段一关闭) |
| 阶段二+ | TS 服务层、Rust VM 引擎(ADR-8 维持 Rust)、UI、题目与集成测试 | ⏳ 待开始 |

技术路线纪律:当前处于 **T0 最小闭环**(单实例编排器、每会话独立 Worker 进程、Docker Compose)。K8s、消息中间件、微服务拆分、二进制投影编码、VM Core WASM 化均属 T2/T3 选项,进入条件(benchmark 或教学数据证据)满足前不引入。

## 文档

| 文档 | 说明 |
|---|---|
| [`docs/项目计划书.md`](docs/项目计划书.md) | **唯一权威来源**:产品定位、四信任域架构、VM 语义、题目 DSL、判题与威胁模型、测试验收 |
| [`docs/README.md`](docs/README.md) | docs 目录索引:contracts(冻结契约)/ adr(决策)/ phases(阶段分解与验收)/ develop(设计文档) |
| [`docs/contracts/数据分类与秘密零驻留清单.md`](docs/contracts/数据分类与秘密零驻留清单.md) | WP-1 交付:每个跨域字段的 PUBLIC / SERVER_ONLY / BOUNDARY 分类与"秘密不进浏览器"论证 |
| [`docs/phases/阶段一任务分解.md`](docs/phases/阶段一任务分解.md) | 阶段一 WP-0 ~ WP-6 任务、依赖与退出条件 |
| [`docs/phases/阶段一验收评审.md`](docs/phases/阶段一验收评审.md) | WP-6 交付:阶段一退出条件逐条评审与门禁证据 |
| [`docs/contracts/版本策略.md`](docs/contracts/版本策略.md) | WP-6 交付:四类版本定义、判题 / 回放记录项、生产环境锁定 |
| [`docs/contracts/规范化JSON序列化.md`](docs/contracts/规范化JSON序列化.md) | WP-6 交付:`stackmaster-canonical-json/1` 规范化规则(TS / Rust 双实现) |
| [`docs/adr/ADR-8-vm-core语言产能决策.md`](docs/adr/ADR-8-vm-core语言产能决策.md) | WP-6 交付:vm-core 维持 Rust 的产能决策与回退 tripwire |
| [`packages/protocol/docs/会话动作协议语义.md`](packages/protocol/docs/会话动作协议语义.md) | WP-2 交付:会话动作协议 v1 语义 |
| [`docs/develop/Vm 模块设计.md`](docs/develop/Vm%20模块设计.md) | Vm 模块设计文档 |

CLAUDE.md 是 Claude Code 在本仓库工作的操作规范(计划书的执行摘要);两者冲突时以计划书为准。

## 参与开发须知

- 涉及协议、投影、题目包 Schema 的改动,**必须先更新契约与 golden fixture,再改实现**;
- 涉及认证、投影生成、判题的代码,提交前必须做安全审查,并逐条自查安全红线(浏览器完全不可信、秘密零驻留、侧信道粗化等);
- 文档、提交信息与面向人的注释用中文;代码标识符用英文;提交遵循 Conventional Commits(`feat|fix|refactor|docs|test|chore|perf|ci:`);
- 新功能先写测试(TDD),测试用行为描述命名;
- **不提交** `.env`、私有题目包样本、真实隐藏 flag;`private-bundles` 类内容永不进入 git。

## 许可证

本项目以 [**GPL-3.0-or-later**](LICENSE)(GNU 通用公共许可证第 3 版或(任选其)更新版本)发布。

- 仓库内的代码与文档均适用该许可证;私有题目包内容与隐藏 flag 不属于本仓库,不受本许可证影响;
- 阶段二起对外发包的 npm 包(`web-component`、`react-wrapper`、`embed-runtime`)发布时需随包附带 LICENSE 副本(workspaces 打包不会自动携带仓库根目录的 LICENSE),并保持 `license: "GPL-3.0-or-later"` 标注。
