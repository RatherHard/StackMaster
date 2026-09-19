# StackMaster 开发规范

本文件是 Claude Code 在本仓库工作的操作规范,是 `docs/项目计划书.md`(唯一权威来源)的执行摘要。两者冲突时以计划书为准,并回过头更新本文件。

## 项目一句话

StackMaster 是一个**可回放、可解释的 Pwn 概念实验室**:后端权威 VM + 浏览器公开投影,**以与 API 同源的独立页面形态交付**(服务端签发一次性启动地址并下发,学习者直接打开该地址),让初学者通过直接操作内存学习 pwn 基础。MVP 聚焦"栈帧、缓冲区与返回地址"闭环(计划书 11.1)。

**分发改版状态(2026-09-18)**:此表述为**目标态**;~~可嵌入~~、~~Web 插件(独立来源 iframe + Web Component)形态嵌入各类 CTF 平台~~ **已于文档面退役** —— 计划书与四条底线第 4 条的修订**本批已执行**,但**磁盘实现仍是插件形态**(`apps/plugin-dev`、`packages/embed-runtime|web-component|react-wrapper` 未删),退役**尚未落地**,见「在途改版」小节。

**非目标**:不做完整 CPU/OS 模拟器、完整 x86-64 指令集、ELF 加载器、真实 shellcode、完整 glibc、复杂堆分配器、在线编辑器、AI 自动 exploit、多人实时协作;浏览器端永远不存在本地权威执行或本地判题。

## 四条底线(计划书十六章,任何改动不得违反)

1. VM Core、完整状态和隐藏判题信息完全隔离在后端。
2. 浏览器只接收可公开的脱敏投影,不负责最终计分或权威状态保存。
3. 服务端会话串行执行所有动作;单步、回退、checkpoint、回放和最终裁决均以服务端为准。
4. **题目 DSL 不执行任意宿主代码，以与 API 同源的独立页面分发（不提供与第三方页面共享 DOM 或执行上下文的嵌入形态），并保持 Core、UI、协议和平台适配层解耦。**

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
│   ├── admin/                # 最小管理面(只读:题目登记 / 裁决查询 / 成绩导出;独立凭证与网络域,
│   │                         #   自有只读库角色 admin_ro;不入页面分发链路)——信任域 4
│   ├── page-app/             # **新增(2026-09-18 分发改版)**:与 API 同源的独立页面应用(替代 plugin-dev 的插件壳职能)
│   └── ~~plugin-dev/~~       # **退役(2026-09-18 分发改版)**:插件 iframe 开发壳与接入 Demo(替代 = page-app + 启动票据签发端点)
├── packages/                 # TypeScript 包
│   ├── protocol/             # @stackmaster/protocol:Zod 契约 → JSON Schema(跨语言契约唯一来源)
│   ├── challenge-schema/     # 公开/私有题目包 JSON Schema 与字段分类校验器
│   ├── challenge-compiler/   # DSL → 受限 IR(仅后端)
│   ├── ~~embed-runtime/~~    # **退役(2026-09-18 分发改版)**:postMessage 嵌入协议(宿主侧 SDK);替代 = 启动票据 / 启动地址
│   ├── ~~web-component/~~    # **退役(2026-09-18 分发改版)**:<pwn-memory-vm>(Lit 3);替代 = page-app 内 Lit 组件
│   ├── vm-ui/                # 投影渲染:字节视图、寄存器、调用栈、时间线、Payload 构造器
│   └── ~~react-wrapper/~~    # **退役(2026-09-18 分发改版)**:可选 React 薄包装
├── vm-engine/                # Rust workspace(cargo)——信任域 3,仅后端
│   ├── vm-worker/            # 二进制:单会话进程入口,stdio / 本地 socket JSON 协议
│   ├── vm-core/              # 纯 VM 语义
│   ├── vm-runtime/           # COW 快照、规范化动作日志、回放、私有题目包加载
│   └── projection/           # ProjectionPolicy 白名单与脱敏
├── tooling/                  # eslint、dependency-cruiser、clippy 配置、CI 脚本与隔离扫描
└── docs/                   # 文档(索引:docs/README.md;contracts 契约与规则 / adr 决策 / phases 阶段分解与验收 / develop 设计文档)
```

依赖方向由 CI 强制(dependency-cruiser / cargo workspace 声明,5.5):

- TS:`protocol` 可被所有 TS 包依赖(唯一跨域共享面);`challenge-schema` 只被 challenge-compiler、session-api、verifier、admin 依赖(WP-79 起,admin 按公开包 Schema 展示题目登记元数据);`vm-ui` 只依赖 `protocol`(~~`vm-ui` / `web-component` / `embed-runtime` / `react-wrapper` 只依赖 `protocol`~~ —— 2026-09-18 分发改版:`web-component` / `embed-runtime` / `react-wrapper` 三包**退役**,不再计依赖面)。`admin` 对工作区包的依赖面 = `protocol` + `challenge-schema`(数据面是自有只读库角色直连 PG,**禁 app→app 依赖**;dependency-cruiser `admin-workspace-deps-allowlist` 强制)。
- Rust:`vm-core` ← vm-runtime、projection、vm-worker;`vm-runtime` 与 `projection` ← vm-worker。
- 跨语言规则:IR 与题目包是版本化**序列化格式**,不是共享代码;VM Core 不知道自己运行在 Lit、React、iframe 还是 Node.js 里。

## 技术栈速查(5.4;ADR 全文见计划书 5.4)

| 层 | 选型 |
|---|---|
| 浏览器 UI | Lit 3 + TypeScript;Vite ~~library mode 多入口~~(2026-09-18 分发改版:插件三形态打包退役 ⇒ **页面应用 application build**;library mode 仅服务内部包);语义化 DOM + lit-virtualizer + SVG;IndexedDB(idb-keyval) |
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
- 服务端对一切入站数据(HTTP、WSS;~~postMessage 转发的动作~~ —— 2026-09-18 分发改版:嵌入协议整体退役)按同一契约重新校验,不信任客户端类型标注;
- 每类契约(~~嵌入协议~~ ⇒ **启动票据 / 启动地址**、会话动作协议、题目包 Schema、引擎进程协议)携带独立版本号;破坏性变更递增版本并保留 N-1 兼容窗口(**例外**:嵌入协议**整体退役**,不适用 N-1 演进窗口,走硬切 + 迁移指引;**启动票据属新契约面,须先契约后实现**);
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
4. cargo miri(vm-core UB 敏感面:掩蔽算术 / 译码边界 / 页与 COW / 快照克隆 / 条件求值;本地全量入口 `pnpm test:miri`)+ cargo-fuzz(题目包、动作与 IR 解析器);
5. golden fixture 跨语言往返一致;
6. 浏览器产物隔离扫描(不得含引擎代码、私有题目包内容、vm-worker 二进制);
7. Compose 集成测试:会话创建 → 动作 → 投影 → 断线重连 → 提交裁决全链路;
8. Playwright E2E:~~iframe 嵌入~~ ⇒ 页面分发(启动地址进入的同源页面;2026-09-18 分发改版)、Chrome/Firefox/Safari、断线恢复;
9. k6 benchmark 归档(T2 触发判据)。

新功能先写测试(TDD);测试用行为描述命名;错误反馈断言要覆盖"可解释性"而不只是状态码。

## 开发工作流与提交规范

- 复杂功能先出实现计划再写代码;涉及协议、投影、题目包 Schema 的改动,必须先更新 `protocol` / `challenge-schema` 契约与 golden fixture,再改实现;
- 涉及认证、投影生成、协议、题目包校验、判题的代码,提交前必须做安全审查;
- 文档、提交信息与面向人的注释用中文;代码标识符用英文;
- Conventional commits:`feat|fix|refactor|docs|test|chore|perf|ci: <描述>`;对外发包用 Changesets —— **仅契约包**(`protocol`、`challenge-schema` 等);~~对外发包(`web-component`、`react-wrapper`、`embed-runtime`)用 Changesets~~ **2026-09-18 退役(分发改版)**:前端三包随嵌入协议整体退役,**不再对外发包**;
- 不提交 `.env`、私有题目包样本、真实隐藏 flag;`private-bundles` 类内容永不进入 git。

## 阶段三落地事实(2026-09-10,WP-8 收口;只登记事实,纪律仍以上文与计划书为准)

- **Compose 一键拓扑**:`pnpm --filter @stackmaster/session-api compose:app:up / compose:app:down`(PostgreSQL + Redis + MinIO + session-api + vm-worker 冒烟;session-api 发布 13000,依赖 15432 / 16379 / 19000 / 19001);拓扑集成入口 `test:compose`(container / host 双形态,CI 为完整 linux 拓扑);开发上手文档 `apps/session-api/README.md`;
- **可观测端点**:`GET /healthz`(liveness)、`GET /readyz`(readiness)、`GET /metrics`(Prometheus 文本;五指标族:动作 RTT / 并发会话 / 队列深度 / Worker 占用 / 投影增量字节;标签零秘密零标识符,机检 `assertMetricsTextDiscipline`);OpenTelemetry 为 T0 可选增量(仅登记 D-API-72);
- **k6 基线**:`pnpm --filter @stackmaster/session-api k6:baseline`(docker grafana/k6,场景在 `apps/session-api/k6/`;不设通过阈值,结果归档 `apps/session-api/k6/results/`);
- **覆盖率入口**:仓库根 `pnpm test:coverage`(vitest projects 聚合 apps + packages,整体门槛 ≥ 80%;完整门禁形态 `SESSION_API_IT=1 pnpm test:coverage`,纳入容器门控集成测试;配置文件为根 `vitest.coverage.config.ts`——不得改名 `vitest.config.ts`,包级 vitest 会误读);
- **TS 测试规模**(阶段三末):session-api 345 passed / 30 skipped(容器门控);集成 75 passed(`test:integration` + compose 套件);Rust 基线 318 × debug / release 双 profile 全绿。

## 中期 M1「可用性地基」落地事实(2026-09-16,WP-70 ~ WP-73 收口;只登记事实,纪律仍以上文与计划书为准)

- **工作区模型 = 固定窗口集(D-MP-1)**:窗口集合 = 注册表登记的全部类型(10 类)**各恰一实例、常驻**;窗口**没有开 / 关状态**,只有「视口内 / 暂离(条带滚出视野)」。模型层 `WorkspaceLayoutModel.bindWindows(bindings, columns?)` 一次性绑窗(**窗口 id ≡ 类型键** ⇒ 单实例结构性保证),`focusWindow(type)` 聚焦(不创建实例),`isWindowSetComplete` 不变量机检;`openTab` / `closeTab` / `formatTabTitle` / 类型内序号 / 关闭入口 / 空态引导**全部退场**。绑定点 = 工作区接入(首帧前)+ `tabTypes` 换绑,与「接入会话」解耦 ⇒ **模式切换只换绑数据源、布局零副作用**(`layoutSnapshot` 深度相等有断言)。菜单「打开」组 → **「窗口」聚焦组**(锚点 `data-window-type` + class `.focus-window` + `aria-pressed`,无禁用态,不留 `data-tab-type` 兼容别名)。
- **布局 = Niri 式,预设单一来源**:`src/workspace/layout-presets.ts` 三张常量表(**P0** 宽屏 5 列 / **P1** 中宽 3 列 / **P2** 窄条单列)为默认列排布**唯一来源**,经 `bindWindows(entries, columns)` **单点注入**(工作区层不得持有第二份默认布局);`selectLayoutPreset(viewportWidth)` 纯函数选档。三表「10 类型各恰一次、无重无漏」机检固定。阈值推导:字符宽 7.8px(13px × 0.6em)× 行 58ch ⇒ `MIN_COLUMN_WIDTH` **452.4px**、`NARROW_MAX_PX` **468.4px**、`WIDE_MIN_PX` **932.8px**(含真实列间空隙 = 列间距 ×2 + 分隔条宽 12;此处按实现侧推导登记,已由主控采纳为定案口径)。布局状态进快照面:`columns[].widthRatio` / `columns[].rowHeights`(和恒 1、单窗列恒 `[1]`)/ `viewportWidth`;「重置布局」= 清空尺寸调整 + 应用**当前视口宽对应预设**。分隔条(`role=separator` + `tabindex=0`,pointer + 方向键)、焦点列相机纯函数 `cameraScrollLeft`(按 `prefers-reduced-motion` 降级)、三类拖拽落点(`stack` / `cross-column` / `new-column`)、列宽五档 + 重置入口**仅在菜单「布局」组**(标题栏保持零控件)。视口外降级渲染 = `content-visibility: auto` + `contain-intrinsic-size: auto 9rem`(择一登记;零 JS)。
- **主题 = 21 token × 3 预设**:`SM_THEME_PRESET_VALUES = ["light","dark","terminal"]`(light / dark 新增值取系统色关键字 ⇒ 零视觉变化;effect 面在 light / dark 取 `0` / `0s`)。**嵌入协议 `EMBED_THEMES` 三值零改动**(冻结面);`terminal` 由 `data-sm-theme="terminal"` 承载 + 宿主 appearance 映射为 dark(`#applyAppearanceToHost` 保留外部锚 + `#observeAnchor()` 锚变更观察)。决策登记 D-API-110。**2026-09-17 M3 WP-80 增补第 21 枚**:`--sm-canvas-sprite-filter`(深底画布垃圾桶 / 缩放光栅精灵处理;light `none` / dark·terminal `brightness(1.6)`)—— 该增补**取代** D-API-110「定案 1:零新增 token 硬约束」的绝对表述(见 D-API-130;授权来源 = M1 遗留项「深色画布光栅精灵可见性」,2026-09-17 移交 M3 并由 WP-80 承接)。`theme-terminal.test.ts` 的精确键集断言已由 20 同步为 **21**。
- **调试档投影接线(WP-70)**:工厂 `createDebugDataSource` 的 options 扩为 `DebugDataSourceAssemblyOptions`(运输面 & 数据源面,显式解构),工作区缺省装配传 `projectionProvider: () => session.store.snapshot ?? null`;未提供 provider 时 `regions()` / `registers()` 恒空的行为保留(以反例固定)。**装配路径集成测试**已补(既有测试经 `debugDataSourceFactory` 测试接缝绕开真实装配路径 = 缺陷漏网原因,已登记在测试文件头)。
- **台账**:中期决策登记于 `docs/develop/权威API语义规约.md` §三·二十一(**D-API-110 ~ 116**);WP 勾选与证据行在 `docs/phases/中期任务分解.md` §二(含 WP-74 前置项两包的承接登记);用户面文档 `docs/user/界面帮助手册.html` 已同步固定窗口模型(§1.1 / §1.3 / §2.1;列宽窗高 / 预设 / 重置 / 响应式降级等待 WP-72 后由 WP-77 回填)。
- **测试规模(M1 收口)**:vm-ui **62 files / 766 passed**(M1 前 54/624,零 skip / todo);E2E chromium 全量含新增 `e2e/workspace-layout.spec.ts`(8 例)与 `e2e/workspace-windows.spec.ts`(3 例);axe 真机 `e2e/axe-contrast.spec.ts` **3/3 例、6 个可达面 violations = 0**。
- **全窗口常驻暴露的 4 条 axe 违规已清零**(判定依据 = 逐面比对 HEAD 归档:五面均为 0 违规且 `dark-registers` 面 `color-contrast` 仅检查 1 个节点、零 `blockly` 命中 ⇒ 相关节点在 M1 前根本不在场;WP-72 关闭 `content-visibility` 复跑同例仍红,排除降级渲染嫌疑):①`role="log"` 误用于 `<ol>`(违 `aria-allowed-role` 且使 `<li>` 失 list 父级)⇒ 去掉 role、保留 `aria-live="polite"`;②窗口面板与内层视图**地标重名** ⇒ 面板名不动(WP-71 同源承诺保留),内层 region 名带窗口维度(`byte.viewAria` / `instr.viewAria` / `vma.ariaScoped`,`SmVmaList` 新增 `viewLabel`);③暗色 Blockly 画布 `.blocklyToolboxCategoryLabel` 对比度 **1.35:1** ⇒ 新增 `src/payload/blockly-theme.ts`:官方主题 API 的 `componentStyles` 映射 6 项组件样式为 `var(--sm-*)`(内联 + `var()` ⇒ 三档即时生效、组件内零色值复制)+ 同根样式表覆盖两处 Blockly 字面值(标签自身 `color:#fff` 声明继承不可覆盖,是唯一必需改写);实测 1.35 → **17.66**(暗)/ **18.87**(亮)。**遗留**:**深色画布上垃圾桶 / 缩放光栅精灵的可见性 —— 已由 WP-74 复核确认未承接,2026-09-17 移交 M3**(补偿规则需按主题生效,但样式表在画布宿主 shadow 根内、主题锚在树外,树内样式表无法匹配树外祖先 ⇒ 无效规则已删除;修法 = 把主题锚镜像进 shadow 树,或新增「深底精灵处理」token,**须先定 token 名与值**;承接载体 = **M3 WP-80**,**2026-09-17 订正:原登记「M3 WP-81 遗留移交清单」是失效指针** —— WP-81 实为 canary 契约收口(`docs/phases/中期任务分解.md:342`),不含「遗留移交清单」;按 M3 分派口径**丙**逐项核对 `WP-78 ~ WP-82` 后落定实现 WP = **WP-80**(M3 中唯一触及 Blockly 画布与 `src/payload/blockly-theme.ts` 主题接缝者))。
- **主 chunk 体积**:`dist/sm-workspace-*.js` 实测 **1,353.13 kB**(gzip 328.65 kB 量级)。**该体积在 M1 之前即已越过中期计划 §一.2.3 的 1.3MB 触发线**(两次独立测量 1,327.59 / 1,328.12 kB,且中期零新增依赖、零新增入口)⇒ 判为既有体积,拆分评估为**已触发的待决项**(不属 M1 交付面;M1 净增约 25.5 kB)。
- **全窗口常驻的渲染负担观测**(风险表「全窗口常驻」行证据,可复跑):1440×900 下窗口 **10** / `sm-workspace` shadow 节点 **251** / 降级面板 **10** / 聚焦交互 RTT **68~84 ms**。

## 中期 M2「终端风格与交互补全」落地事实(2026-09-17,WP-74 ~ WP-77 收口;只登记事实,纪律仍以上文与计划书为准)

- **终端主题全组件落地(WP-74)**:全部消费主题变量的组件(16 个)零硬编码色、逐处走 `var(--sm-*, <字面量回退>)`;**回退字面量 = 原字面量逐字** ⇒ light / dark **零视觉变化**(唯一例外 `--sm-divider-faint` 暗色 `8% 黑 → 10% 白`,判为**修正**并已登记;`.client-step-pause` 保留 `--sm-accent`,terminal 下呈青绿而非琥珀,语义张力已登记)。**未新增任何 token**(`theme-terminal.test.ts` 精确锁定 20 键)。等宽字体栈 **19 处逐字统一**为 `SM_MONO_FONT_STACK`;字号下限 13px(7 处 `0.75rem → 0.8125rem`,几何值零改动)。
- **效果面三件(扫描线 / 光标闪烁 / 终端标题栏)**:全部动画声明包在 `@media (prefers-reduced-motion: no-preference)` 内、reduce 下 `display: none`;装饰一律 `aria-hidden="true"` + 零文本 + 零可聚焦后代 + 不承载信息;扫描线 `opacity ≤ 0.06` 且 `pointer-events: none` **落在基态规则**(静态属性,reduce 侧同样断言)。light / dark 下强度取 `0` ⇒ 不可见。
- **主题护栏 = 自校验全组件机检(非手写清单)**:`THEME_COMPONENT_TAGS`(16 消费)+ `THEME_EXEMPT_TAGS`(2 豁免,各附理由)的**并集必须等于源码 `@customElement("…")` 真实清单**(递归扫描 `src/**/*.ts`)⇒ **新增 / 改名组件忘记登记直接变红**。另含字号下限机检(rem×16 折算)与**字体栈回退值漂移机检**(防 19 处副本各自漂移)。
- **axe 真机门禁(chromium)**:三预设 × 既有扫描面,**9 个可达面 `violations = 0`**;归档 `e2e/reports/axe/<运行当日>/`(**按日期新增,无覆盖开关**;WP-55 的 `2026-09-11/` 为只增不改的历史证据)。不可达格如实登记:`shell dark`、`degraded dark`、**`degraded terminal`**(降级形态不安装文档级 token 样式表 ⇒ 锚在场但无变量可级联;**拒绝用 harness 注入产品路径不会产生的样式表制造假绿**)。
- **真机门禁的价值 = 抓出测试接缝漏掉的缺陷**:首跑即抓出 `.pseudo-asm[data-pseudo-asm-source="solve"]` 对比度 **4.47:1**(`graytext` 落在面板色上,正文门槛 4.5:1)。该节点**此前不可达** —— 跳转链死绑定(D-API-117)修好前链恒空,故 M1 归档里此节点根本不在场(与 M1「暗色 Blockly」1.35:1 同机理)。教训:`graytext` 在**浅底与深底都不达标**,「降低前景色」表达次要性与 13px 正文门槛**结构性不相容** ⇒ 改用系统字体 + 标题文案区分。
- **三浏览器矩阵(E2E_MATRIX=1)**:firefox / webkit 实跑 **58 passed / 28 failed / 22 skipped**。**webkit 为环境级阻断、非产品缺陷**:本机 Windows headless 建不了认证 WSS 动作通道(`[client_error] 动作通道未连接`),故全面失败 —— 这正是「WebKit linux 复跑义务」被限定的原因,清偿载体 = `e2e-matrix` 的 ubuntu job。**2026-09-17 订正:该归因已被推翻(勿沿用)** —— ubuntu 的 `e2e-matrix` job 跑起来后,webkit 在 375/768/1024/1440/1920px 的嵌入面**与**壳面共 10 格以**同一形态**失败(`connection-status` 恒 `reconnecting`,断言 `Expected "connected"`;另 320px 壳面 `step-button` 恒 `disabled` 同因),而 chromium / firefox 同格全绿 ⇒ **不是环境级阻断、清偿载体已用尽**,须按**真实 webkit 兼容缺陷**重开调查。**2026-09-17 调查完成,根因已定案**:webkit 的 WSS 升级被服务端以 **`401`** 拒(浏览器控制台 `Unexpected response code: 401`,服务端日志同步记录六次 `GET /sessions/channel` 全 401、`responseTime ≈ 0.3ms`),而 chromium / firefox 同 URL 同页面 **`open`**。机制 = 升级认证走**凭证 preHandler(Cookie 呈递)**(`apps/session-api/src/wss/wss-plugin.ts:7-10`),而客户端注释所称「**同源**升级自动携带会话 Cookie」在本拓扑下**不成立**(插件页 `:5174` ≠ API `:13000`,且位于宿主页 iframe 内)⇒ **WebKit 最严的跨源 / 第三方 Cookie 策略使握手不带凭证**。修法方向与两个未定分项、以及「**属认证面改动,须走契约 + 安全审查**」的处置纪律,见 `docs/phases/中期任务分解.md` §二 WP-74 末段。逐用例证据同处。
- **CI/门禁形态**:新增 `e2e-matrix` job(`.github/workflows/ci.yml`,chromium + firefox + webkit);**不进 turbo 任务图**(保持 CI 承载),本地复跑命令与 env 清单在 `apps/plugin-dev/README.md`。**`e2e-matrix` 在 CI 实跑绿至少一次(E-3)未达成** —— job 已落地并通过静态校验,首跑证据待推送后由 ubuntu 产出。**2026-09-17 进展**:四个历史红的根因已修(engine 侧 rustfmt 漂移 / **Node 22 与本地 24 的微任务跳数差** / MinIO 镜像不再可匿名拉取——compose 与 matrix 各一处)⇒ **run 32 起 6 个 job 中 5 个绿**,仅 `e2e-matrix` 仍红;矩阵红点经 Playwright `github` reporter 转为**公开注解**后**逐用例具名**(14 failed / 10 skipped / 27 passed),其中 **320px 三引擎横向溢出已定位并修复**(真凶 = Blockly 挂到 `document.body` 的文本测量画布,见 `docs/phases/中期任务分解.md` §二 E-3),webkit 连接面 10 格待处置。**E-3「CI 实跑绿至少一次」仍未取得**;另 `ts-gate` 转为**间歇**(vm-ui 包,本地 12/12 未复现)⇒ 其绿**不可视为稳定绿**。**2026-09-17 收口后进展(run 37 / 38,两个独立 run 逐条一致)**:矩阵收敛为 `29 passed / 12 failed / 10 skipped`,**chromium 与 firefox 已全绿**(320px 画布修复实证生效:webkit 320px 现红在**连接断言**而非溢出),**12 个失败逐条为 `[webkit]` 连接面** ⇒ 红点**可复现且单一根因**,即上条定案的跨源 WS 认证面。`ts-gate` 间歇坐实(红 run 34 / 37,绿 run 32 / 38);因**同一失败零逐用例注解**,已查明其为**套件级 / 进程级失败而非逐用例失败**(配置式 `github-actions` reporter 经本地实证确实生效),故补**「失败日志 → 公开注解」桥**(`76170c7`;job 日志 403 / artifacts 401,注解是唯一免凭证通道)待其下次红时定名。**当前 CI = 6 个 job 中 5 个绿**,唯一红点 = webkit 认证面(须契约 + 安全审查,不在收尾轮改);遗留汇总见 `docs/phases/中期任务分解.md` §二 M3「收口 · 中期验收评审」遗留移交清单。
- **调试档缺陷两类(均属「测试接缝绕开生产装配」缺陷族,D-API-120)**:①生产入口 `main()` 漏传 `debugChannel` ⇒ `/sessions/debug-channel` **404**(修于 `a35bb01`;测试接缝自己传了该参数故漏网);②修好接线后 `debug_attach` 恒 `internal_error`,根因**不在通道实现而在题目形态** —— E2E / 演示拓扑**唯一驱动**的种子题是 **IR 模式**,而调试变体契约要求**字节模式**(ADR-DC1)⇒ 真机**恒**失败(修于 `c295c87`;Node 侧或走占位变体供给、或把 IR 拒绝当**期望**断言)。**纪律启示**:凡「测试接缝与生产装配路径不一致」的包,必须补一条**装配路径**集成测试。
- **调试通道推送模型(冻结口径)**:attach 回执 `status:"running"` + `debug_function_table`,**指令流随 `debug_paused` 才下发**(`packages/protocol/docs/调试通道协议语义.md:189-193`)。E2E 断言「不步进即见指令行」与之冲突 ⇒ **以契约为准、改用例**(未改冻结面)。**遗留**:单 `ret` 种子下唯一可达断点即入口自身,形成「设断点需指令行 / 指令行需暂停」循环依赖 ⇒ 已按 UX 口径 **(a1) 产品侧落地**(attach 未携带对齐暂停时,前端以**公开投影的 RIP** 触发一次 `debug_run_to_breakpoint([rip])`,落点 = `debug-data-source.ts#pauseAtCurrentRip`;冻结帧族 / 推送时机 / 错误码**零改动**),真机实测首个暂停 `breakpoint@0x401000` + 该地址指令流 16 条。**(a1) 的用户可见性另暴露两处死选择器族缺陷并已修**:指令视图 flex 高度链写在渲染输出中**不存在**的 `.layout` 上(渲染根实为 `section.instruction-view`);`<sm-window-list>` 的 `static styles` 在 light DOM 架构(`createRenderRoot()` 返回宿主 ⇒ Lit `adoptStyles` 不执行)下**不可达** ⇒ 结构样式改随模板 `<style>` 落到 light DOM(修前列表**不是滚动容器**、锚点行落在视口外 ≈2539px;修后 `scrollHeight 1814 > clientHeight 173`、锚点行 y=731)。**新遗留(第 7 步伪汇编 chip 未达成,唯一红点)**:调试实例 = attach 时按 `origin.revision` **重放权威动作日志**得到的克隆,而动作日志**只在 `submit` 时落库**(`session-manager.ts#persistActionLogDelta`)⇒ **未提交会话**的克隆恒为种子初始态(栈区全 `0x00`;真机取证:请求 `targetRevision:1`、实际对齐 `revision:0`)⇒ 栈行 8 字节非地址 ⇒ 跳转链 / chip **结构性**不成立;待定案修法 = 对齐源改用**在途会话的权威动作日志**(`SubmitReference.actionLog`)或种子题栈上预置指向代码区的返回地址。
- **测试规模(M2 收口)**:vm-ui **64 files / 806 passed**(M1 收口 62 / 766;零 skip;末轮 +8 用例 = (a1) 首个暂停 4 + 列表结构 3 + 指令视图高度链 1);session-api **62 passed | 12 skipped(74 files)/ 607 passed | 94 skipped**,真机 IT(真实 Rust worker)`test/debug` + `test/scan` **99 passed**;`pnpm build` 12/12。**主 chunk 体积** `dist/sm-workspace-*.js` 实测 **1,373.15 kB**(M1 收口 1,353.13 kB ⇒ M2 净增约 **20.0 kB**;该体积在 M1 之前即已越过 §一.2.3 的 1.3MB 触发线,仍属已触发的待决项)。
- **M2 末轮新登记的既有缺陷(未修,建议独立 WP)**:指令视图中**每个指令行实测行高 113px**(表头行 21px)——`.row-address` / `.row-bytes` 是 `white-space: pre` 单元格,而 Lit 模板内的换行被**保留**为幻影空行。后果:一屏只显示 ≈**1.5 行**(而非 ≈8 行),锚点行的面板内可见比例仅 **0.14**(仍 > 0,故 `toBeInViewport` 是**真绿但很薄**);面板 231px 与视图固定 `24rem` 的几何张力属既有事实。修法小(**收窄模板空白**),但会改动表格视觉 ⇒ 不塞进 M2 收口,单独立项。

## 中期 M3「成绩面 / 管理面 / 声明面 / canary 收口 / 采集面 / 体积拆分」落地事实(2026-09-17,WP-78 ~ WP-83 + 四项遗留移交 + 收口;只登记事实,纪律仍以上文与计划书为准)

- **WP-78 成绩同步只读接口**:新增 `GET /host/scores`(宿主成绩同步),复用导出的 `hostBackendTokenMatches`(**单进程内单份实现**,不另写第二套校验);查询参数白名单**恰为** `cursor` / `limit` / `tenantId`(多余参数即 **400**);游标 = `verdicts.id` keyset 分页(**并发插入下无零遗漏保证,已在契约与文档中明示**);批量上限 `SESSION_API_HOST_SCORES_BATCH`(默认 500 / 天花板 5000),**超限返回 400 而非截断**;限流键 = `rate:{字典序最小租户}:host_scores`;SQL **恰取七列**;**零 DDL / 零新角色 / 零新 GRANT**。宿主→租户绑定经可选 `SESSION_API_HOST_TENANTS`(逗号分隔白名单):**空或缺省 ⇒ 成绩面返回 404 同形 fail-closed**;查询参数只能在白名单内**再选**,**永不从查询参数派生租户**。存放 `apps/session-api/src/host-scores/`。
- **WP-79 分支 A 最小管理面(D-MP-5 定案 = 落地)**:新增 `apps/admin`(只读控制台;**独立凭证** `ADMIN_CREDENTIAL_SHA256`,sha256 + `timingSafeEqual`;**独立网络域** `admin-net` 与独立部署,**不入插件链路**);自有**只读**库角色 `admin_ro`(**不得 `BYPASSRLS`**)+ RLS 迁移 **`009_admin_row_level_security.sql`** + `compose/admin-db-init.sql`;三只读面(题目登记列表 / 裁决查询 / 成绩导出)**全部 GET**,成绩导出经 `HostScoresResponseSchema.parse()` **单出口**复用 WP-78 契约(零第二套实现);闸序**冻结** 401 → 429 → 404 → 400 → 查询 → 审计 → 派发;**零 app→app 依赖**(`admin` 只依赖 `protocol` + `challenge-schema`,由 dependency-cruiser `admin-workspace-deps-allowlist` 强制)。**审计口径(主控裁决)**:管理面**只读查询不进 `audit_log`**(`audit_log` 十值封闭集 = **安全事件账**,只读查询属数据事件),**零新增审计 kind**;可审计性由受控日志 + 指标 + 披露点 fail-closed 承载,**若将来合规要求读操作入库须复开 D-API-59**。**compose 三处阻断性片段**(缺任一则起不来):`db-roles-init.sql` 建 `admin_ro` 角、`deps.yaml` 健康探针 `grep -qx 2 → 3` 且只读不变量断言 `rolname IN (…, 'admin_ro')`(**不加则被提权的 `admin_ro` 会静默绕过 RLS**)、`app.yaml` 的 `admin` / `admin-db-init` / `admin-net`。
- **WP-80 M10 出题者积木最小声明面**:公开描述包新增**顶层可选**字段 **`authorBlocks`**(顶层字段 **16 → 17**,**不进 `required`**);形状 = 1–16 × `{id, displayText, interfaceId, kind ∈ {address,immediate,length}, slots(≤4), actions(≤8)}`;**`actions` 只能是 12 个公开动作的冻结枚举**;`args` 值 = 字面量(≤64)或 `{slot: <本模板槽键>}` 结构引用 ⇒ **非图灵完备,不构成任意宿主执行**;新增四条检查器规则 `XS-BLOCK-IFACE-REF` / `XS-BLOCK-SLOT-FORM` / `XS-BLOCK-ARG-ALLOW` / **`XS-BLOCK-NO-EFFECT`**(**递归扫描**效果原语与私有键名,**含展示文本**)+ `authorBlocks[].id` 纳入既有 `XS-ID-UNIQUE`;`CHALLENGE_PACKAGE_SCHEMA_VERSION` **维持 1**(additive)。**字段名必须避开 `interfaces`**(`FORBIDDEN_PUBLIC_PROPERTIES` 硬约束,公开包任意嵌套深度不得出现该键名)。**客户端校验能力边界(结构性)**:`XS-BLOCK-IFACE-REF` 的「接口是否存在」**在客户端不可实现**(`vm-ui` 不依赖 `challenge-schema`,依赖纪律 5.5)⇒ **权威面 = 服务端 + 编译链,客户端只做形状闸**。同时清偿 M1 遗留的**深色画布光栅精灵可见性**:新增第 **21** 枚主题 token **`--sm-canvas-sprite-filter`**(light `none` / dark·terminal `brightness(1.6)`;真机对比度 dark 1.84 → **3.07**、terminal 1.82 → **3.04**)。
- **WP-81 canary 契约收口(XS-CANARY-CORR)**:定案 = **(c) 双层语义分离**(**哨兵槽模式 T** / **参考值模式 R**);(a) 否决 = **安全剧场**(隐藏区字节玩家永远写不到 ⇒ canary 恒不触发),(b) 否决 = 字面形态**不可实现**且只有放宽 `project.rs` fail-closed 才成立(正面触碰红线第 1 / 4 条与 I-3 / I-9);**决定性取证** = 引擎自身 canary happy-path 测试即用 `visibility:"public"` + `containsSecret:false`(`session_lifecycle.rs:848-870`)⇒ 冲突实质 = **规则面缺一种模式,不是可见性语义有争议**;**canary 值是否为判题秘密 = 分模式**(模式 T 的期望值**不是另存秘密**,而是装载期从初始内存截取,`exec.rs:288-301` ⇒ 槽在可见区时**结构性不是判题秘密**;模式 R 才 SERVER_ONLY);**CH-05 = 不切换**(无试用数据 + 会改一道已发布题的裁决语义)。**本包只结定案面;实现与 P1~P6 待派单(建议 WP-81a),其中「跨语言互证机检」已定为 WP-81a 的完成标准**(现状 `vm-engine/**` 对 `XS-CANARY-CORR` **零测试引用**,仅 `assemble.rs:661-662` 一句注释 —— 这正是冲突能活到 M3 的原因)。
- **WP-82 试用环境与指标采集最小面**:`docs/user/试用环境部署指南.md`(D-API-138;**纪律 = 未实测不给配置片段**,运维端点暴露面定案 = D-API-104 选项② 反代准入)+ `docs/phases/中期试用报告模板.md`(24 观察点可得性分类,与采集面逐数一致)。**采集载体重建**:新增 `teaching_events` 表(`apps/session-api/migrations/008_teaching_events.sql`)——`ENABLE` + **`FORCE` ROW LEVEL SECURITY** + 租户绑定政策(**谓词逐字同 007**,GUC 缺失 ⇒ 谓词恒假 ⇒ 零行 fail-closed)+ **两段式保留期**(跨租户仅放行**租户枚举读**,删除逐租户经租户绑定政策 ⇒ **零跨域 DELETE 政策行、零 `USING (true)`**)+ `BEFORE UPDATE` / `BEFORE TRUNCATE` 双触发器(**DELETE 不设触发器 = 与 `audit_log` 的唯一一处分野**,因本表带保留期)+ `kind` **三值库层 CHECK** + `UNIQUE(tenant_id, kind, source_ref)` 幂等锚;授权随表同批落迁移(理由:`compose/session-api-db-init.sql` **首启执行、早于迁移**,其 `ON ALL SEQUENCES` 覆盖不到新建序列)。**三条硬约束**:审计 kind **零新增**(十值封闭集不变,机检语句面零 `audit_log` + 全文零审计 kind 字面);采集面**不经 `/metrics`**(机检零 `prom-client` 导入);采集失败**不影响会话主链路**(采集器**永不抛错**,折叠为**旁路账** `failed=true` + 可选 `onFailure` 回调,**审计账 fail-closed 不动**)。**三类服务端可派生**:会话创建 / `verdicts` 成绩方向(冻结 11 值之 `success`,SQL 层 + 派生层**双层过滤**)/ `action_log` 已接受 `undo` 计数;口径字面**单源**(`kinds.ts` 常量以**绑定参数**注入,SQL 文本零字面)。**零学习者标识(六重结构性断言)**:DDL 面无 `user_id` / 无原始 `session_id`;端口面**没有任何返回行级数据的方法**;聚合 SQL **只在 `GROUP BY` 消费** `subject_digest` 且 **SELECT 不含该列**;真库扫描落库文本;聚合输出键集恒等冻结九键;**编译期** `@ts-expect-error` 断言派生入口只收权威行集合。`subjectDigest = SHA-256(tenantId ‖ 0x00 ‖ sessionId)`,**只在库内**用于幂等与分组,**任何端口都不返回**。**「提示使用」= v1 暂不可采集**(`not_collectible_v1`;**库层 kind 封闭集不含 `hit_used` ⇒ 伪造计数值结构性不可写入**;`CLIENT_REPORTED_TEACHING_KINDS = []` ⇒ **零客户端自报**)。聚合 = 受控查询(冻结**九键** + 单点组装 + `assertTeachingAggregateDiscipline` **八类机检**且每类有红灯反例)。**⚠ 未达成**:`runtime.ts` **生产接线未做** ⇒ 采集面当前**仅经 `buildTeachingCollection(pool)` 单点装配交付**(单测与 IT 都经该单点装配,不存在「测试接缝绕开生产装配」)。
- **WP-83 主 chunk 体积拆分**:主 chunk **1,379.02 → 428.65 kB(−68.9%)**,gzip **336.36 → 107.97 kB**;首屏静态图 1,396.71 → 452.51 kB;惰性 chunk 945.82 kB;Blockly 占拆分前主 chunk 的 **65.5% raw / 64.1% gzip**。**两处改动必需**(积木注册表 + 入口桶),**只改一处 = 假绿**;`packages/web-component` 的 `codeSplitting: false` 是**结构性上限**(其单产物形态无法再分);**零新增依赖(含 devDependency)**。义务 **CLOSED**。
- **调试克隆对齐源(遗留第 6 项)**:对齐源改为**在途权威动作日志**(`SubmitReference.actionLog`,经 `getSessionSummary.acceptedActionLog`)⊕ 已落库基线前缀;`origin.revision` 收紧为**精确对齐点**;该 revision **不可得时在 spawn 前冻结拒绝**(`invalid_input_format` / `"revision is not available"`),**不静默退回种子态**(静默退回会把「对齐失败」伪装成正常克隆,是更坏的失败模式)。
- **M3 收口轮真机 axe 修复**:真机 axe 抓出 `plugin-dev-shell` / light 面 **`scrollable-region-focusable`(serious)** —— `sm-payload-tab` 的 `<ol class="output-log">` 是滚动容器却无 `tabindex`。修法 = 给该 `<ol>` 及**同渲染点同成因**的 `.program-list` 加 `tabindex="0"`(axe 标准修法;不动 `aria-live`、不加可聚焦后代、不动 CSS 几何、零新增依赖)。**归因**:缺 `tabindex` 属**既有缺陷**;把 needle 推过 axe「真实溢出 ≥13px」判定线的触发条件是 **WP-83 惰性宿主**(`<sm-payload-tab-host>` 无样式插入 payload 窗口 DOM 链;节点集恒定 146 ⇒ 变的是几何)。修复后 **9/9 面 violations = 0**。**遗留**:该宿主的**高度 / 宽度链未复核**(**不得因 axe 转绿即判定无几何回归**);3 个 terminal 面的「0」主要建立在 axe **无法自动判定**之上(非正向通过)。
- **台账与文档**:M3 决策登记于 `docs/develop/权威API语义规约.md` **§三·二十三(D-API-122 ~ 151,共 30 条,两批并入并各自逐块机检 19/19 与 11/11 等同)**;**编号有意非连续**,分派固定为 122~126 WP-78 / 127~130 WP-80 / 131~133 WP-81 / 134~136 WP-79 / 137~140 WP-82(文档面)/ 141 遗留-e2e-descriptor / 142~144 遗留-5 / 145 遗留第 6 项 / 146~148 WP-83 / 149~151 WP-82(实现子集)。中期验收评审成文于 `docs/phases/中期验收评审.md`(E-1~E-8 + 门禁证据 + **遗留 32 项**);WP 勾选与证据行在 `docs/phases/中期任务分解.md` §二。
- **测试规模(M3 收口)**:`pnpm test` **26/26 tasks 全绿** —— `session-api` 72 files / **757 passed | 13 skipped**;`vm-ui` 70 / **866 passed**(M2 收口 806 ⇒ 净增 60);`challenge-schema` 8 / **268 passed**;`challenge-compiler` 9 / 127;`admin` 9 files / **87 passed**(2 skipped);`web-component` 9 / 82;`embed-runtime` 4 / 62;`plugin-dev` 2 / 28;`session-core` 28;`react-wrapper` 1 / 8。`pnpm build` 13/13、`typecheck` 18/18、`lint:deps` **1357 模块 / 4300 依赖零违规**、`lint:deps:self-test` **20 组边**、`scan:public` **0 违规 / 3 条既有豁免**、`fixtures:manifest --check` **254 一致**、`smoke:contract` **21 Schema / 67 接受 / 143 拒绝 / 254 摘要比对**、`test:rust` 13 target 全 `ok`、真机 axe **9/9 面 0 违规**;**全部 exit 0**。**未实测 / 环境阻断(明文登记,不得视为通过)**:`test:coverage`(完整形态)、`test:miri`、`fuzz:smoke`、全量 E2E、`test:compose`(本机镜像不可重建)、`E2E_MATRIX` / CI `e2e-matrix`(webkit 12 格红 + `ts-gate` 间歇红)。

## 用户验收测试发现的缺陷修复(2026-09-17,D-API-152;只登记事实,纪律仍以上文与计划书为准)

- **缺陷 = 窗高下限无依据(工作区窗口被压扁)**:宽度侧下限是**严格推导**的(`58ch × 7.8px` ⇒ `MIN_COLUMN_WIDTH` = 452.4px = 十六进制行不折行),高度侧却是一个**无推导的裸 `9rem`**(= 144px)。**真机实测**(中宽 P1、嵌入形态、列高 656px):4 窗列每窗 **146px**(贴着 144 + 上下边框),而面板 chrome(标题栏 26 + 字节视图边框 1 + 工具区 133.3 + 列头行 21.8)实测 **182.1px** ⇒ **该下限连一行字节都装不下**。**因下限存在(并非缺失),它一路躲过了 axe 9/9 面与全套 E2E** —— 「下限有无依据」比「有无护栏」隐蔽得多。
- **修法**:`MIN_ROW_HEIGHT_PX = ceil(182.1 + N(=4) × 20.8) = `**266px**(`packages/vm-ui/src/workspace/layout-divider.ts:53`,由常量插值、无魔数);推导输入与 **N = 4 的理由**(= 一次 `read` 的 32 字节跨度,MVP 栈帧教学闭环)登记在 `layout-presets.ts` 的「块轴(高度)阈值推导」段,与宽度侧**同法**。`columnMinHeightPx(heights) = max_i(266 / ratio_i) + columnChromePx(n)`(**是比例的函数**,等分时**逐值退化**为原算式 268/560/852/1144/2896)。
- **溢出列拖拽改像素语义**:统一基准 `F = 列高 − columnChromePx(n)`;`rowHeightsAfterDrag` 按像素夹取 —— **富余列仍像素和守恒**(既有不变量不变),**被压窗贴住下限后多余位移转为列盒长高**(列盒 ≡ 内容高、由滚动承载),**被压窗永不低于下限**。**拖拽像素基准在 `pointerdown` 冻结**:旧实现每步重读 `clientHeight`,而列高在拖拽中会被下限顶高 ⇒ 同一手势把列盒顶高 **137px**、非相邻窗跟着变高(真机才暴露)。
- **伴生缺陷(同批修复)**:字节视图「特殊显示」列的 Lit 模板把**字面换行写在声明了 `white-space: pre` 的标签内部** ⇒ 每个 cell 渲染 2 个行盒 ⇒ 数据行实测 **187.17px**(应为 20.8px)。**这与 M2 登记的「指令视图每行 113px」是同族缺陷,而字节视图这一处当时被漏掉**(M3 只修了指令视图)。**修后真机**:普通数据行 **20.8px ✔**;挂跳转链的行 93.19px(= 20.8 + 72.39 跳转链块)、挂寄存器标注的行 43.59px —— **两者余高归因到别的组件,非本族产物**。同族第二实例 = `src/views/instruction/sm-instruction-view.ts:681` 的 `.jump-target` 按钮(继承 `.row-text` 的 `pre-wrap`),一并修复。**机检** = `test/render/pre-whitespace-family.test.ts`(9 例;源码文本扫描 + CSS 继承语义 + 跨文件作用域「双向一跳」;**修复前临时回退实测 3 条真实违规必红**:两个 span + 该 button)。
- **门禁读数**:`e2e/workspace-layout.spec.ts` **9 例** + `e2e/workspace-windows.spec.ts` **3 例** = **12 passed / 0 failed**(**原 8 例逐字未改、断言零放宽**,新增第 9 例 = 溢出列 regime:被压窗 `≥ MIN_ROW_HEIGHT_PX`、非相邻窗不动、列盒增量 ≡ 被增大窗增量);vm-ui **71 files / 895 passed**(M3 收口 70 / 866);typecheck / `scan:public` / eslint / `lint:deps`(1371 模块 / 4329 依赖)**全部 exit 0**。
- **诊断订正(留档,勿沿用错判)**:①「高度下限只在拖拽路径使用、未落到布局」**错** —— 下限一直生效(`.tab-panel { min-block-size }`),缺陷是**取值无依据**;②「`flex-basis: 0` + 比例和恒 1 ⇒ 自由空间恒为 0 ⇒ 拖拽数学上不可能」**错** —— 真机实测列 0 富余 **824px**、拖拽确实生效(只是只兑现 7.5px)。两条 E2E 失效的**真成因** = 266px 下限把 3 窗列顶到 852px ⇒ 工作区 1163.3px、**页面高 1322px** ⇒ 交互几何落到 **900px 视口之外**,浏览器对**视口外坐标不命中**页面内容(`event.target === html`)⇒ 组件收不到事件。**产品侧无解**(不等式:需条带顶 < 399px,实测菜单 + 简介 + 状态行 = 294px ⇒ 条带顶 453px;旧下限 144px 时该点只剩 **11px** 余量 ⇒ 旧用例是靠 11px 侥幸绿的),修法落在 **E2E 夹具**(拖拽前把起点与终点一起滚进视口,真实用户同样先滚动;**零断言变化**)。
- **dev 壳陷阱(已加固,勿回退)**:`apps/plugin-dev/vite.config.ts` 的 `server.watch.ignored` 含 `**/*.tmpdir` / `**/.tmp/**` —— 写文件工具与编辑器的原子写会留下 `.<name>.<pid>.<guid>.tmpdir/`,Windows 对该目录内文件的 `watch` 返回 **EBUSY 会让 Vite 的 FSWatcher 整个进程退出**(实测三次)。**按前缀匹配会漏**(见过 `._…tmpdir` 与 `.…tmpdir` 两种前缀),**必须按后缀 `.tmpdir` 匹配**。dev-only,零生产影响。
- **本次新登记的遗留 5 项(D-API-152 修复面之外)**:见 `docs/phases/中期遗留清单.md` §十 与 `docs/phases/中期验收评审.md` §六 **#33 ~ #37**(编号双射)—— 几何 / 可读性无门禁(#33);拖拽落点出视口即不可达、缺拖拽中自动滚动(#34);开发壳 `.tab-area` 无高度上限(#35);**`MIN_COLUMN_WIDTH` 的「十六进制行不折行」前提在现有三档列宽下不成立** —— 字节视图自带 `14rem` 侧栏,列内实际只有 ≈220px,**免折行需列宽 ≈1000px**(#36,**建议优先处置**:该推导表会让依据它的人得出错误结论);宿主未给工作区定高 ⇒ **条带自身纵向滚动在两种已发布形态下都不会出现**(#37)。
- **未实测(明文登记,不得视为通过)**:`test:coverage` 完整形态、`test:miri`、`fuzz:smoke`、全量 E2E、`E2E_MATRIX`(webkit 12 格)、`test:compose`(本机镜像不可重建)。

### 在途改版(未落地,不得当现状):前端整页布局 + 终端单主题(2026-09-18,D-API-153)

> **本节登记的是「正在改、尚未落地」的要求,不是落地事实** —— 以下任何一条**都还没有出现在磁盘实现里**;不要据本节判断产品现状、不要据它改 E2E 断言或用户文档。
>
> **2026-09-18 分发改版执行注(文档面 = 本批已执行)**:本节的**文档面**部分(计划书 + 本文件四条底线第 4 条的修订)**已于本批执行完毕** —— 计划书 §一 / §二 / §三 / 5.2 / 5.3 / 5.4 / 5.5 / 5.6 / 5.8 / 六 / 八 / 九 / 十一 / 十二 / 十三 / 十四 / 十五 / 十六 / 十七 与 `CLAUDE.md`(项目一句话、四条底线第 4 条、仓库结构、依赖方向、技术栈、契约纪律、门禁、提交规范、章节速查)均已按「与 API 同源的独立页面分发」改写并逐处加退役标注(治理依据 = `docs/develop/计划书与底线修订草案(分发改版).md` **§〇.2 主控裁定**)。**仍未执行** = 本节其余各项(整页布局 / 终端单主题 / **代码与契约的物理删除**)—— 磁盘实现仍是插件形态;同批取代注已加至 `docs/中期计划.md` §2.1 / D-MP-2 与 `docs/README.md` 索引。**不得据文档面修订单方面删代码 / 删契约 / 改 E2E 断言。**

- **要求要点(9 条,浓缩)**:① 窗口为**无边框紧密贴合的矩形**(无间隙 / 无描边 / 无分隔条);② **工作区占据整个页面**(整页布局);③ **页面右半侧固定为 payload 搭建窗口**;④ **左半侧 = 视图管理窗口**(管理其他所有视图);⑤ 左半侧在**上下两半显示视图**、**纵向堆叠**、**上下滚动**;⑥ 滚动带**丝滑动画**;⑦ **视图类型名写在视图内左上角**(无独立标题栏);⑧ **`Ctrl + ↑ / ↓` 上下切换视图窗口**;⑨ UI 风格 = **简洁的黑客 Linux 终端风格**。
- **4 项现场定案**:① 原口述「页面**有**半侧」为笔误,裁定为**左半侧**(依据:第 ⑤⑥ 条均锚定「左半侧…上下滚动」);② 列表按钮的「勾选」= **控制左半侧显示哪些视图** —— 视图**仍全部常驻**,未勾选属「**暂离**」的第二种成因(第一种仍是滚出可视区)⇒ **D-MP-1 不修订**(无开 / 关状态);③ **主题只保留终端一种**,`light` / `dark` **退役**;④ 「无边框紧密贴合」**连带废止窗高下限**(D-API-152 的 `MIN_ROW_HEIGHT_PX` = 266px)**与列高下限**(`columnMinHeightPx` / `columnChromePx` / 拖拽像素语义);**D-API-152 条目本身是历史决策,不得删除**。
- **取代与保留**:取代 Niri 式列条带全部(列间水平滚动、列内二叉分割、P0 / P1 / P2 预设与阈值表、列宽五档、列间与窗间分隔条、三类拖拽落点、重置布局、焦点列相机);**保留** `content-visibility` 视口外降级渲染与 `prefers-reduced-motion` 降级(后者降级对象改为**丝滑滚动动画**)。
- **⚠ 文档目标态 vs 磁盘实现**:`docs/develop/前端的交互和开发设计.md` 的「工作区组件」一节现为**目标态**;**磁盘实现仍是 Niri 式列条带**(+ light / dark / terminal 三预设)⇒ **现状核对 / E2E 断言 / 用户文档一律以磁盘实现为准**,直到改版落地后统一回填。需求拆解侧同步登记:`docs/develop/前端交互需求拆解.md` §二(**FE-WS-01 ~ FE-WS-15** + 状态横幅 + 「已废止条目登记」)。
- **冻结契约面只有一处(2026-09-18 下午订正;原记「两处」是把布局快照面误计为契约面)**:**嵌入协议面**(`EMBED_PROTOCOL_VERSION` / `EMBED_THEMES` / 嵌入协议 V-1~V-13)。其处置已现场定案为**整体退役**(见下条),**不是「收窄枚举 + 递增版本」** ⇒ 按版本演进的契约变更流程(改分类论证 → 改契约包与 fixture → 评审 → 再改实现,契约纪律 5.6)**对本面不适用**(该路径作废);`fixtures:manifest` 重算随之不再是本面的义务。
- **「契约面二 = 布局快照面」的说法已撤销**:`WorkspaceLayoutSnapshot` 定义在 `packages/vm-ui/src/workspace/workspace-model.ts:92`,而 **`packages/protocol` 对 `layoutSnapshot` / `widthRatio` / `rowHeights` / `viewportWidth` 零命中** ⇒ **它不是冻结契约面** ⇒ 按**内部模型自由重构 + 同步改 vm-ui 测试**处理,**无需契约变更流程**;且**全仓零 `idb-keyval` / `indexedDB`** ⇒ **无持久化面、无迁移义务**。
- **2026-09-18 下午新增定案三项(同属未落地要求)**:
  - **⑤ 嵌入协议面整体退役 —— 取消插件形式,页面分发为唯一形态**:`EMBED_PROTOCOL_VERSION` / `EMBED_THEMES` / 嵌入协议 V-1~V-13 / `packages/embed-runtime` / `packages/react-wrapper` / `packages/web-component` **随协议整体退役,不做版本演进**。**退役面**还包括 `docs/contracts/嵌入协议.md`、`apps/plugin-dev`(**宿主模拟页 `/host-mock/`** / **5174 插件产物页** / **embed token 签发面**)与 `e2e/reports/axe/**` 中的 **`plugin-iframe-*` 面矩阵**(历史归档**只增不改**)。**⚠ 本项是底线级 + 产品定位级变更**。**（文档面已于本批执行,见上方执行注;实现与物理删除仍未落地。）**
  - **⑥ 「工作区占据整个页面」= 顶层页面 `100dvh` + 左半侧内部滚动**(无宿主高度上报、无 iframe)⇒ **`MAX_EMBED_HEIGHT_PX` / `height_changed` / `auto_resize` 属退役面**。
  - **⑦ 菜单**:原**「布局」组 → 「视图」组**(勾选显示 / 排序 / 「重置视图」= 恢复默认顺序与全选)⇒ 菜单四组 = **窗口 / 视图 / 模式 / 运行**;**⚠ 与左半侧列表按钮功能重叠**(同为「勾选 + 排序」),**「谁是唯一入口」仍未定**。
- **三件事必须写清(2026-09-18 下午;均属未落地口径)**:
  1. **⑤ 属底线级 + 产品定位级变更** ⇒ 须修订本文件(**`CLAUDE.md`**)**四条底线第 4 条**与 `docs/项目计划书.md`(**§一 / §二 产品定位**、**§5.4 与 `:341` 分发形态**、**第八章 插件嵌入与协议**、**5.5 结构**);**该修订已于本批执行(2026-09-18)** —— 本文件四条底线第 4 条与计划书十六章第 4 条现为**同一措辞(L1,方案 B)**:「题目 DSL 不执行任意宿主代码，以与 API 同源的独立页面分发（不提供与第三方页面共享 DOM 或执行上下文的嵌入形态），并保持 Core、UI、协议和平台适配层解耦。」**底线 1 / 2 / 3 一字未动**;计划书 §八 标题已改为「页面分发、协议与部署」,**不再有「默认嵌入」的口子**。
  2. **§五 已于 2026-09-18 成文**(权威文本 = `docs/develop/前端重设计与分发形态改版.md` **§五**;四项定案 = ① **载体与同源关系 = 与 session-api 同源**(页面由 session-api 或**同域反代**提供,同域两路径如 `/app` 与 `/api`);② **授权入口 = 服务端下发地址**(服务端签发票据 → 地址携带 → 页面**服务端换票**);③ **题目与租户定位 = 服务端分发、一题一址**(`challengeId` / `version` 属**公开导航信息**,**租户与授权由服务端绑定、不由 URL 自报**);④ **迁移路径 = 硬切 + 迁移指引**(**不留并存窗口**;退役走下线公告 + 指引,不适用契约纪律 5.6 的 N-1 演进窗口))⇒ **计划书 + 四条底线第 4 条的修订已于本批执行(2026-09-18)**;**当前阻塞 = 「实现未开工」**(签发端点 / 换票 / `page-app` 均未开始,退役面代码与契约仍在磁盘上)。**仍未定案(实施前须钉死)**:票据形态(URL query 还是 fragment;长度 / 熵 / 有效期 / 单次消费与重放防护)、**签发端点**的路由 / 鉴权 / 限流键与错误语义(**属新契约面,须先契约后实现**)、换票响应与失败语义、票据进访问日志 / Referer 泄漏的处置、**产品定位表述与 `docs/user/**` 回填时机**;**保留面** = `/host/scores`(WP-78,**不属嵌入协议**)、`SESSION_API_HOST_BACKEND_TOKEN`(保留并扩展用途)、信任域(计划书 5.2)与 ADR-7 投影脱敏边界**零改动**。
  3. **唯一权威来源(计划书 + 本文件)已完成文档面修订;替代设计仍未落地** ⇒ **磁盘实现仍按现状有效** ⇒ **不得据退役决定删代码 / 删契约 / 改 E2E 断言**(删 `packages/embed-runtime` / `react-wrapper` / `web-component`、删 `docs/contracts/嵌入协议.md`、改 `e2e/embed-protocol.spec.ts` 断言,一律禁止)。**状态核对口径**:文档 = **目标态**(与 API 同源的独立页面分发);**磁盘 = 现状(插件形态)** ⇒ 现状核对 / E2E 断言 / `docs/user/**` 一律以磁盘实现为准,两者不一致由遗留 **#38** 承接。
- **可读性纪律不得误读(关键)**:**废止窗高 / 列高下限 ≠ 放松可读性** —— 本版把「压缩以适配」这一机制**整条移除**,改由「**左半侧纵向滚动 + 每个视图位有确定高度**」满足;**判据 = 若落地实现仍出现「视图被压到装不下一行字节」即违反本条**(历史反例 = 2026-09-17 取证:4 窗列每窗 **146px**,而面板 chrome 实测 **182.1px**,连一行字节都看不见)。
- **遗留承接 = #38**(P0:需求文档与磁盘实现不一致 ⇒ 不处置会让「按文档核对现状」得出错误结论):见 `docs/phases/中期遗留清单.md` **§十一** 与 `docs/phases/中期验收评审.md` **§六 #38**(编号双射;两处均已按 2026-09-18 下午定案订正);同批 **#1 载体退役**(webkit 跨源 WSS 认证面,**不是被修复,而是失去载体 ⇒ 不得记为已修复**)、**#30 / #35 / #37 由改版消解(待落地结案)**(属宿主 / iframe 形态的产物)、**#34 载体退役(待拖拽语义定案)**(整页布局下视口 = 浏览器视口)、**#33 仍开放且不得消解**(护栏判据随下限废止改以「不得出现视图压到装不下一行字节」为准则)、**#36 载体变更(不结案)**(免折行实测约束仍有效,改版后约束**左半侧宽度**,**不得当作已解决**)。

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
| 页面分发、协议与部署（原「插件嵌入与协议」，2026-09-18 分发改版） | 八 |
| 权威判题与威胁模型 | 九 |
| 前端性能约束 | 十 |
| MVP 定义 | 十一 |
| 开发阶段 | 十二 |
| 测试与验收 | 十三 |
