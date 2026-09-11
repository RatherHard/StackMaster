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

## 夹具描述包注入(WP-F8 / FE-WS-06)

- `fixtures/dev-descriptor.json`:本地夹具公开描述包——照
  `packages/challenge-schema/test/fixtures/public-descriptor/basic.json` 的
  **数据形态**自建(零代码依赖,数据占位无秘密;`debugMode: true` +
  `hintLadder` + `publicErrorMapping` 齐备);
- 开发壳 boot 读入后经 `applyChallengeDescriptor` 注入工作区装配:
  `debugModeAvailable`(= 描述包 `debugMode`,true 才呈现解题/调试模式切换
  项,FE-WS-06 门槛)+ `challengeDescriptor`(hintLadder → 教学面板提示
  ladder,publicErrorMapping → 错误解释 teachingNote);
- 加载面 = dev server 静态路径 `/fixtures/dev-descriptor.json`;**fail-soft**:
  描述包缺失(如纯静态部署未带夹具)时状态行降级明示「夹具描述包未加载:
  调试模式切换项隐藏」,不阻塞解题模式;
- 调试通道联调:切换到调试模式后工作区经 `DebugChannelClient` 连接
  `/sessions/debug-channel`(vite 反代 `/sessions` 已覆盖,ws 同源升级),
  attach 起点 = 会话当前 revision(重放对齐由 session-api 调试编排承担)。

## 测试(WP-F8 增补)

- `test/descriptor.test.ts`:夹具 JSON 形态自检(debugMode / hintLadder /
  publicErrorMapping 齐备;占位数据零秘密面)、`applyChallengeDescriptor`
  注入断言(含 debugMode 缺省 false 口径)、boot 描述包 fail-soft 降级、
  既有 `wireSessionDemo` 接线回归。
