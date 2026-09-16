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
└── docs/                   # 文档(索引:docs/README.md;contracts 契约与规则 / adr 决策 / phases 阶段分解与验收 / develop 设计文档)
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
4. cargo miri(vm-core UB 敏感面:掩蔽算术 / 译码边界 / 页与 COW / 快照克隆 / 条件求值;本地全量入口 `pnpm test:miri`)+ cargo-fuzz(题目包、动作与 IR 解析器);
5. golden fixture 跨语言往返一致;
6. 浏览器产物隔离扫描(不得含引擎代码、私有题目包内容、vm-worker 二进制);
7. Compose 集成测试:会话创建 → 动作 → 投影 → 断线重连 → 提交裁决全链路;
8. Playwright E2E:iframe 嵌入、Chrome/Firefox/Safari、断线恢复;
9. k6 benchmark 归档(T2 触发判据)。

新功能先写测试(TDD);测试用行为描述命名;错误反馈断言要覆盖"可解释性"而不只是状态码。

## 开发工作流与提交规范

- 复杂功能先出实现计划再写代码;涉及协议、投影、题目包 Schema 的改动,必须先更新 `protocol` / `challenge-schema` 契约与 golden fixture,再改实现;
- 涉及认证、投影生成、协议、题目包校验、判题的代码,提交前必须做安全审查;
- 文档、提交信息与面向人的注释用中文;代码标识符用英文;
- Conventional commits:`feat|fix|refactor|docs|test|chore|perf|ci: <描述>`;对外发包(`web-component`、`react-wrapper`、`embed-runtime`)用 Changesets;
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
- **主题 = 20 token × 3 预设**:`SM_THEME_PRESET_VALUES = ["light","dark","terminal"]`(light / dark 新增值取系统色关键字 ⇒ 零视觉变化;effect 面在 light / dark 取 `0` / `0s`)。**嵌入协议 `EMBED_THEMES` 三值零改动**(冻结面);`terminal` 由 `data-sm-theme="terminal"` 承载 + 宿主 appearance 映射为 dark(`#applyAppearanceToHost` 保留外部锚 + `#observeAnchor()` 锚变更观察)。决策登记 D-API-110。
- **调试档投影接线(WP-70)**:工厂 `createDebugDataSource` 的 options 扩为 `DebugDataSourceAssemblyOptions`(运输面 & 数据源面,显式解构),工作区缺省装配传 `projectionProvider: () => session.store.snapshot ?? null`;未提供 provider 时 `regions()` / `registers()` 恒空的行为保留(以反例固定)。**装配路径集成测试**已补(既有测试经 `debugDataSourceFactory` 测试接缝绕开真实装配路径 = 缺陷漏网原因,已登记在测试文件头)。
- **台账**:中期决策登记于 `docs/develop/权威API语义规约.md` §三·二十一(**D-API-110 ~ 116**);WP 勾选与证据行在 `docs/phases/中期任务分解.md` §二(含 WP-74 前置项两包的承接登记);用户面文档 `docs/user/界面帮助手册.html` 已同步固定窗口模型(§1.1 / §1.3 / §2.1;列宽窗高 / 预设 / 重置 / 响应式降级等待 WP-72 后由 WP-77 回填)。
- **测试规模(M1 收口)**:vm-ui **62 files / 766 passed**(M1 前 54/624,零 skip / todo);E2E chromium 全量含新增 `e2e/workspace-layout.spec.ts`(8 例)与 `e2e/workspace-windows.spec.ts`(3 例);axe 真机 `e2e/axe-contrast.spec.ts` **3/3 例、6 个可达面 violations = 0**。
- **全窗口常驻暴露的 4 条 axe 违规已清零**(判定依据 = 逐面比对 HEAD 归档:五面均为 0 违规且 `dark-registers` 面 `color-contrast` 仅检查 1 个节点、零 `blockly` 命中 ⇒ 相关节点在 M1 前根本不在场;WP-72 关闭 `content-visibility` 复跑同例仍红,排除降级渲染嫌疑):①`role="log"` 误用于 `<ol>`(违 `aria-allowed-role` 且使 `<li>` 失 list 父级)⇒ 去掉 role、保留 `aria-live="polite"`;②窗口面板与内层视图**地标重名** ⇒ 面板名不动(WP-71 同源承诺保留),内层 region 名带窗口维度(`byte.viewAria` / `instr.viewAria` / `vma.ariaScoped`,`SmVmaList` 新增 `viewLabel`);③暗色 Blockly 画布 `.blocklyToolboxCategoryLabel` 对比度 **1.35:1** ⇒ 新增 `src/payload/blockly-theme.ts`:官方主题 API 的 `componentStyles` 映射 6 项组件样式为 `var(--sm-*)`(内联 + `var()` ⇒ 三档即时生效、组件内零色值复制)+ 同根样式表覆盖两处 Blockly 字面值(标签自身 `color:#fff` 声明继承不可覆盖,是唯一必需改写);实测 1.35 → **17.66**(暗)/ **18.87**(亮)。**遗留**:深色画布上垃圾桶 / 缩放**光栅精灵**的可见性(补偿规则需按主题生效,但样式表在画布宿主 shadow 根内、主题锚在树外,树内样式表无法匹配树外祖先 ⇒ 无效规则已删除;修法 = 把主题锚镜像进 shadow 树,或新增「深底精灵处理」token,归 WP-74)。
- **主 chunk 体积**:`dist/sm-workspace-*.js` 实测 **1,353.13 kB**(gzip 328.65 kB 量级)。**该体积在 M1 之前即已越过中期计划 §一.2.3 的 1.3MB 触发线**(两次独立测量 1,327.59 / 1,328.12 kB,且中期零新增依赖、零新增入口)⇒ 判为既有体积,拆分评估为**已触发的待决项**(不属 M1 交付面;M1 净增约 25.5 kB)。
- **全窗口常驻的渲染负担观测**(风险表「全窗口常驻」行证据,可复跑):1440×900 下窗口 **10** / `sm-workspace` shadow 节点 **251** / 降级面板 **10** / 聚焦交互 RTT **68~84 ms**。

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
