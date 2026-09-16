# @stackmaster/plugin-dev

插件 iframe 开发壳(阶段四 WP-F1 建壳;WP-F5 完整工作区 demo):Vite 应用
(vanilla TS,无框架),为前端各 WP 提供可运行的开发联调环境。**本阶段仅开发
联调**;正式的 iframe 插件形态(独立来源、postMessage 宿主协议、自适应高度/
主题/语言)归阶段五,落点为 `packages/web-component` + `@stackmaster/embed-runtime`。

## 启动(WP-F5 完整工作区 demo)

```bash
# 0) 后端拓扑(需要会话联调时):PostgreSQL + Redis + MinIO + session-api + vm-worker
pnpm --filter @stackmaster/session-api compose:app:up   # session-api 发布 13000

# 1) 构建 vm-ui(开发壳加载其 dist 产物;turbo build 会先于本包自动执行)
pnpm build

# 2) 启动开发壳
pnpm --filter @stackmaster/plugin-dev dev    # http://localhost:5173
```

页面挂载:

- **创建会话表单**:`challengeId` / `challengeVersion` / `embedSessionId` /
  `embedToken` 四输入(预填开发演示值;真实 embed token 由服务端间签发,
  D-API-11/15,凭证走环境变量不入库)+「创建并连接」按钮——提交即执行
  `create_session`(Cookie 交付)→ 认证 WSS `connect`;
- **`<sm-workspace>` 工作区**:创建成功后组合根注入
  (`workspace.client = client`),工作区内部完成
  `new ProjectionDataSource(client.store)` 装配与事件接线;
- **菜单动作联调路径**(真实会话端到端):
  1. 菜单「打开」开 栈视图 / 自由视图 / 寄存器视图(可多开、拖拽排布);
  2. 「指令步进」→ `step` 动作 → 投影增量回流刷新视图与 revision 显示;
  3. 「重启测试环境」→ `reset` 动作(运行中可点);会话终态(won/failed)
     时 reset 禁用并呈现「测试环境已结束,请新建会话」——点「新建会话」
     (或壳内同名按钮)走 `close_session` + `create_session` 新流程;
  4. 断线(停掉 session-api)→ 横幅呈现最近一次公开投影 + 重连中
     (attempt / retryDelayMs);恢复后端后自动 `sync_projection` 对齐;
  5. 菜单动作错误(限流 / 越权等)→ userVisibleError 呈现(含 explanation)。

> 真实会话端到端的自动化验收归 WP-F7 Playwright 最小集;本 WP 以组件级 +
> mock 全链路集成测试收口(见 `packages/vm-ui/test/workspace/`)。

## 嵌入面 demo 拓扑与人工走查(阶段五 WP-51/52 交付;验收证据《阶段五验收评审》)

宿主模拟页 × 插件文档页的**独立来源双端口拓扑**(嵌入协议 §4.1 默认演示形态):

| 面 | URL | 承载 |
|---|---|---|
| 宿主模拟页(签发代理 + 建 iframe + 控制面板) | `http://localhost:5173/host-mock/` | 本包 vite dev(dev-only 中间件 `host-mock/dev-server.mjs`) |
| 插件文档页(正式产物 `<pwn-memory-vm>`) | `http://localhost:5174/` | `pnpm --filter @stackmaster/plugin-dev dev:plugin-site`(plugin-site-server.mjs,CSP `script-src 'self'`) |
| session-api(compose) | `http://localhost:13000` | `pnpm --filter @stackmaster/session-api compose:app:up`(demo-override 登记 5173/5174 origin) |

人工走查路径(签发 → 嵌入 → 握手 → 会话全流程):

```bash
# 0) 后端拓扑 + 题目种子(演示 challengeId 经 k6/seed-challenge.mjs 路径登记)
pnpm --filter @stackmaster/session-api compose:app:up

# 1) 构建产物(web-component 自包含 dist + vm-ui dist;turbo build 覆盖)
pnpm build

# 2) 两个开发服务(两个终端)
pnpm --filter @stackmaster/plugin-dev dev              # 5173 宿主模拟页
pnpm --filter @stackmaster/plugin-dev dev:plugin-site  # 5174 插件文档页

# 3) 浏览器打开 http://localhost:5173/host-mock/ :
#    能力授予勾选(theme/language/auto_resize)→「签发并嵌入」→ 握手面板
#    ready / 协商版本 / 计数面板 → 工作区挂载 → 主题/语言下拉切换 → step 步进
```

- **签发代理凭证**:dev-only 中间件持 `SESSION_API_HOST_BACKEND_TOKEN` 环境变量
  调 session-api `POST /auth/embed-tokens`(compose dev 拓扑的合成值;凭证只走
  环境变量,不入库不入浏览器,D-API-75 通道 a 的宿主后端替身);
- **引导配置取回**:`POST /host-api/embed-bootstrap`(esid POST 体换取
  `{embedToken, sessionApiOrigin, challengeId, challengeVersion, embedSessionId}`),
  对 `PLUGIN_SITE_ORIGIN` 白名单(缺省 `http://localhost:5174`,逗号分隔可扩)
  回显精确 ACAO,fail-closed;
- **冒烟脚本**(E2E 同款前置):`pnpm --filter @stackmaster/plugin-dev exec
  playwright test e2e/embed-protocol.spec.ts` 或组件冒烟六步
  `node host-mock/smoke-embed.mjs`(前置 = 步骤 0~2 + `SESSION_API_HOST_BACKEND_TOKEN`);
- **描述包双通道**(开发壳页面,非宿主模拟页):`http://localhost:5173/`
  缺省夹具通道、`?descriptor=formal` 正式下发通道,见下节。

## 加载模型(为什么开发壳不 import vm-ui)

dependency-cruiser 规则 `no-backend-dependency-on-browser-packages`
(tooling/dependency-cruiser.cjs)把 `apps/*` 全部视为浏览器可达包的**非消费
方**——apps 静态导入 `packages/vm-ui`、`packages/web-component` 即红灯。
这与本仓库的目标拓扑一致:真实平台上,宿主页面加载的是**已发布的组件
bundle**(阶段五形态),而不是把组件包打进宿主构建图。

因此开发壳按同一拓扑消费 vm-ui:

- `vite.config.ts` 把 `packages/vm-ui/dist` 配为 `publicDir`(静态资源形态
  提供);`index.html` 用 `<script type="module" src="/index.js">` 直接加载
  vm-ui 产物,加载即注册 `<sm-workspace>` 等组件;
- 壳逻辑(`src/main.ts`)经**运行时动态 import**(`import(/* @vite-ignore */
  "/index.js")`)取命名导出(如 `SessionClient`)——URL 是运行时字符串,不进
  构建图、不产生 dependency-cruiser 模块依赖边;
- vm-ui 产物**自包含**(lit 内联,见 `packages/vm-ui/README.md`),不依赖
  打包器解析裸模块导入;
- `@stackmaster/vm-ui` 以 devDependencies 声明(不 import):只为 turbo
  `^build` 构建序与工作区链接。

## 会话 API 反代(开发联调)

`vite.config.ts` 把 `/sessions` 与 `/auth` 同源代理到 session-api,使浏览器
侧请求与开发壳同源(Cookie `SameSite=Strict` 路径,《前端实施计划》§五):

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_API_ORIGIN` | `http://127.0.0.1:13000` | 反代目标(compose:app:up 发布端口) |
| `SESSION_API_PROXY` | (开) | 设为 `off` 关闭反代(纯静态开发) |

注意:

- 走反代时浏览器请求同源,无需额外 CORS/Origin 登记;
- 若关闭反代、直连后端跨端口联调,须在 session-api 的
  `SESSION_API_ALLOWED_ORIGINS` 登记开发 origin(如 `http://localhost:5173`);
- embed token 开发签发(服务端间行,D-API-11/15)由开发脚本持 bearer 共享
  凭证调 `POST /auth/embed-tokens`,凭证走环境变量,不入库。

## 构建 / 测试

- `pnpm build`:`vite build`(产物 dist/)+ `tsc -b --force`(emitDeclarationOnly,
  满足根 tsconfig project references;vite 先行构建并清空 dist,`--force`
  确保声明文件随后必然重新产出,不被 tsbuildinfo 判定跳过);
- `pnpm test`:jsdom 冒烟(壳结构、表单接线、新建会话流程、终态引导事件,
  客户端以替身注入);`<sm-workspace>` 的元素注册与渲染由 `packages/vm-ui`
  自身测试覆盖——本包测试环境不加载 vm-ui 产物(见上)。

## 描述包双通道(WP-F8 夹具注入 → WP-54 双通道并存)

开发壳的题目描述包(debugMode 门控 + FE-ED-06 提示阶梯 + FE-ED-07 错误教学
注解 + 题目静态面)由**两条并存通道**供给,`?descriptor=` 查询参数切换:

### 夹具通道(缺省;开发态零依赖正式部署)

- URL:`http://localhost:5173/`(不带 `descriptor` 参数即夹具通道);
- 数据源:`fixtures/dev-descriptor.json`(照公开描述包数据形态自建的本地
  夹具,占位数据零秘密;加载面 = dev server 静态路径
  `/fixtures/dev-descriptor.json`);
- **fail-soft**:夹具缺失(如纯静态部署未带夹具)时状态行降级明示
  「夹具描述包未加载:调试模式切换项隐藏」,不阻塞解题模式;
- 夹具同时是**测试锚**:形态自检测试(对公开 Schema)在
  `test/descriptor.test.ts` 与 `packages/challenge-schema/test/
  fixture-consistency.test.ts` 双侧生效(对齐锚 = 公开 Schema,阶段四定案
  延续)。

### 正式下发通道(`?descriptor=formal`;WP-54)

- URL 形态:`http://localhost:5173/?descriptor=formal&challengeId=<ID>&challengeVersion=<SEMVER>`
  (题目上下文缺省回落表单演示值;**以 URL 参数为 boot 时一次获取的上下文,
  表单创建不同题目上下文时请刷新页面**);
- 数据流:`fetchChallengeDescriptor`(vm-ui 描述包客户端加载器)→
  `GET {origin}/descriptors/{challengeId}/{version}`(WP-50 端点)→
  **完整性校验**(响应体 SHA-256 与 `ETag` 登记摘要比对)+
  **客户端尺寸护栏双闸**(字节 / 深度 / 数组 / 字符串,与服务端 §8.3 成对)
  → **结构校验**(对齐锚 = 公开 Schema)→ 强类型视图注入工作区;
- 失败语义(全部确定性):404 / 网络失败 / 哈希不符 / 超限 / 坏形态 →
  工作区「题目描述未加载」缺席明示面板,会话与解题不受影响,零重试风暴
  (网络失败至多一次显式重试);
- **同源反代**:`vite.config.ts` 把 `/descriptors` 代理到 session-api(环境
  变量 `SESSION_API_ORIGIN`,与 `/sessions` 反代同源形态)——`ETag` 非简单
  响应头,跨源读取需服务端 `Access-Control-Expose-Headers: ETag`;开发壳经
  同源反代消费免服务端配置。若关闭反代直连后端(`SESSION_API_PROXY=off`),
  加载器将因 ETag 不可读确定性缺席(呈现 = 缺席明示,非故障);
- 真实链路前置:compose 拓扑已登记目标题目(session-api
  `k6/seed-challenge.mjs` 路径),E2E 用例见 `e2e/descriptor.spec.ts`
  (正式下发数据驱动 hintLadder / 错误解释全链路)。

### 注入点(两通道共用)

- `applyChallengeDescriptor`:`debugModeAvailable`(= 描述包 `debugMode`,
  FE-WS-06 模式切换门槛)+ `challengeDescriptor`(hintLadder → 教学面板提示
  ladder,publicErrorMapping → 错误解释 teachingNote);
- `applyDescriptorState`(WP-54):`descriptorStatus`(loading / loaded /
  absent)+ `challengeStatic`(标题 / 简介 / VM Profile / encodingTable
  静态面,`loaded` 时渲染;`absent` 时呈现缺席明示面板)。

### 调试通道联调(沿 WP-F8)

切换到调试模式后工作区经 `DebugChannelClient` 连接 `/sessions/debug-channel`
(vite 反代 `/sessions` 已覆盖,ws 同源升级),attach 起点 = 会话当前
revision(重放对齐由 session-api 调试编排承担)。

## 测试(WP-F8 增补;WP-54 扩展)

- `test/descriptor.test.ts`:夹具 JSON 形态自检(debugMode / hintLadder /
  publicErrorMapping 齐备;占位数据零秘密面)、`applyChallengeDescriptor`
  注入断言(含 debugMode 缺省 false 口径)、boot 描述包 fail-soft 降级、
  既有 `wireSessionDemo` 接线回归;WP-54 增补:通道解析、静态面投影
  (`descriptorStaticFace`)、接入状态注入(`applyDescriptorState`)、
  boot 正式通道成功注入 / 失败缺席明示(夹具通道未触达断言)。

## E2E 门禁与复跑(WP-74:axe 三预设真机 + 三浏览器矩阵 + reduced-motion)

### 门禁形态自查:为什么 `e2e-matrix` 不进 turbo 任务图

`e2e-matrix` 是 **CI 承载**的门禁(真机浏览器 × docker compose 全拓扑 × 固定端口
独占),不是 turbo 任务:

- `turbo.json` 只登记 `build` / `typecheck` / `test` / `lint:rust` —— 无任何
  e2e 任务,`pnpm build` / `typecheck` / `test` 均不触发 Playwright;
- 本地入口 = `pnpm --filter @stackmaster/plugin-dev test:e2e`(默认 chromium
  全量 spec);矩阵入口 = 下文的 `E2E_MATRIX=1 … e2e/browser-matrix.spec.ts`;
- 拓扑单例(固定端口 5173 / 5174 / 5175 / 13000;**同一时刻只允许一个 E2E
  进程**),`workers: 1` / `fullyParallel: false`(真实后端共享单拓扑,
  会话并发预算 D-API-50)⇒ **spec 内串行**;矩阵 12 格(六宽度 × 两面)在
  chromium / firefox / webkit 之间同样串行,另 5 个 chromium 口径附加格
  (主题 / 键盘 / reduced-motion / 高对比度 / 非根路径)。

### 前置(三条都必需)

```bash
pnpm build                                                   # 1) 被测产物
pnpm --filter @stackmaster/plugin-dev exec playwright install chromium firefox webkit  # 2) 浏览器(CI 加 --with-deps)
export SESSION_API_HOST_BACKEND_TOKEN=host-backend-shared-credential-0123456789        # 3) 凭证(只经环境变量)
```

### env 清单(全部可选值都有缺省,仅凭证无缺省)

| 变量 | 缺省 | 作用 |
|---|---|---|
| `SESSION_API_HOST_BACKEND_TOKEN` | **无(必需)** | 服务端间签发 embed token 的共享凭证;compose dev 合成值见 `apps/session-api/compose/app.yaml` |
| `E2E_MATRIX` | 未设 | `1` = 追加 firefox / webkit 项目(chromium 恒在);`playwright.config.ts:22` |
| `E2E_KEEP_COMPOSE` | 未设 | `1` = teardown 保留拓扑(调试 / 多步复跑;CI 用它跨两次 Playwright 调用复用同一次冷构建) |
| `E2E_SKIP_COMPOSE` | 未设 | `1` = setup / teardown 都不碰 compose(假设拓扑已在跑) |
| `SESSION_API_ORIGIN` | `http://127.0.0.1:13000` | session-api 直连源(签发 / seed) |
| `E2E_ALLOWED_ORIGIN` | `http://localhost:13000` | CSRF 闸改写目标;须与拓扑 `SESSION_API_ALLOWED_ORIGINS` 一致 |
| `E2E_TENANT_ID` / `E2E_USER_ID` / `E2E_CHALLENGE_ID` / `E2E_CHALLENGE_VERSION` | `e2e-tenant` / `e2e-user` / `chal-e2e-plugin-dev` / `1.0.0` | global-setup 登记题目上下文 |
| `WORKER_CARGO_PROFILE` | `debug` | compose 内 vm-worker 构建 profile;CI = `release`(D-API-64) |
| `PLAYWRIGHT_JSON_OUTPUT_NAME` | 未设 | 矩阵 JSON 报告落点(CI 取 `.tmp/e2e-matrix-report.json`) |

### 复跑命令(原文可复制)

```bash
# A. 默认门禁(单浏览器 chromium 全量 spec;拓扑由 global-setup 拉起 / teardown 收尾)
pnpm --filter @stackmaster/plugin-dev test:e2e

# B. axe 三预设真机门禁 + reduced-motion(chromium 口径;归档自动写 reports/axe/<运行日期>/)
pnpm --filter @stackmaster/plugin-dev exec playwright test e2e/axe-contrast.spec.ts e2e/reduced-motion.spec.ts --project=chromium

# C. 三浏览器矩阵(六宽度 × 两面 × 三引擎;串行)
E2E_MATRIX=1 pnpm --filter @stackmaster/plugin-dev exec playwright test e2e/browser-matrix.spec.ts

# C'. 逐引擎复跑(WebKit linux 复跑义务的补测锚)
E2E_MATRIX=1 pnpm --filter @stackmaster/plugin-dev exec playwright test e2e/browser-matrix.spec.ts --project=webkit

# D. 保留拓扑调试(步骤 A/B/C 之间共享同一次冷构建)
E2E_KEEP_COMPOSE=1 pnpm --filter @stackmaster/plugin-dev test:e2e
pnpm --filter @stackmaster/session-api compose:app:down        # 调试完手动下线
```

### axe 归档纪律(`e2e/reports/axe/<YYYY-MM-DD>/`)

- **归档即历史证据**:目录按**运行当日**生成,路径无覆盖开关 —— `2026-09-11/`
  是 WP-55 的测量证据,只增不改(WP-74 首件修掉了「硬编码 WP-55 日期 + 标题
  绑定 WP-55」导致每次跑 axe 都覆写历史目录的缺陷);
- 面矩阵 = 三预设 × 既有扫描面,共 **10 份 JSON** + `summary.md`:插件面
  registers / stack × light / dark / terminal(6)、降级面 light / terminal(2)、
  壳面 light / terminal(2);
- 不可达格如实登记:shell dark(本机 headless 不绘制 root 级暗色画布,半暗态伪影)、
  degraded dark(降级形态无握手 ⇒ 无 `theme_changed` 通道,宿主元素外部锚被插件
  写回 resolvedTheme);
- 预设承载:**light / dark** 走嵌入协议 `theme_changed`;**terminal 不经协议**
  (`EMBED_THEMES` 冻结),由外部 `data-sm-theme` 锚承载(插件文档页预置 /
  运行期写入 / 独立使用形态 `theme` 属性 —— 见 `e2e/helpers/theme-anchor.ts`);
- CI 只**归档 artifact**(`e2e-matrix-artifacts`),不提交归档 —— 落仓由本地 /
  主控波次执行。

### 三浏览器矩阵结果登记纪律

矩阵(12 格 × 三引擎 + 5 个 chromium 口径附加格)在**纯 CSS 目标**下差异应极小;
任何差异都要:

1. 如实登记在阶段文档 / WP 报告的实测行(引擎 + 宽度 + 面 + 断言 + 现象);
2. **附最小复现**(`--project=<引擎>` + 单个 spec / 单个 describe 的精确命令,
   必要时附 `--grep`);
3. 平台级不可达(如 WebKit Windows 无 WebSocket)与产品缺陷**分开登记**,
   前者走「环境不可达 + linux CI 复跑义务」口径,后者开缺陷。

CI 的矩阵报告以 artifact 形式归档(`apps/plugin-dev/.tmp/e2e-matrix-report.json`,
JSON reporter);本地矩阵复跑不落仓。

### reduced-motion 断言与「装饰不承载信息」

`e2e/reduced-motion.spec.ts` 断言的是**终态契约**(契约全文 = C1~C9 见
`e2e/helpers/decoration.ts` 文件头):reduce 下零非 `none` 动画 + 扫描线层不可见
+ 装饰不承载信息(`aria-hidden="true"` / 零文本 / 零可聚焦后代 / `pointer-events: none`),
界面功能不降级;no-preference 正面对照要求扫描线层与光标闪烁**按契约在场**。
效果面实装归 WP-74 的效果面波次(`packages/vm-ui/src/**`),故正面对照在实装前
为**有意承载的红灯**(失败信息含契约描述与实测计数);reduce 侧在实装前恒真、
实装后成为真实守护断言。
