# @stackmaster/page-app — 与 API 同源的独立页面应用

> **建立** 2026-09-18(分发改版 **WP-92**)· **状态** 生效中
> **权威来源**:`docs/项目计划书.md` + `CLAUDE.md` 四条底线第 4 条(「以与 API 同源的独立页面分发」)、
> `docs/develop/前端重设计与分发形态改版.md` **§五**(四项定案)、
> `docs/develop/decisions-分发改版与UI重设计.md`(**D-UI-1 ~ D-UI-7** / **D-LT-1 ~ D-LT-5**)、
> 决策登记 `docs/develop/权威API语义规约.md` **D-API-161**。

## 1. 它是什么(与 `plugin-dev` 的关系)

`page-app` 是**页面分发的最终交付物**:学习者打开服务端签发的**一次性启动地址**
(`{SESSION_API_PUBLIC_ORIGIN}/app/c/:challengeId/:version?t=<ticket>`)后,由
session-api 换票(302 + 启动授权凭证 Cookie)回跳到的那个**干净路径页面**。

| | `apps/plugin-dev`(退役中) | `apps/page-app`(本包) |
|---|---|---|
| 形态 | 插件 iframe 开发壳 + 宿主模拟页 | **独立页面**(与 API 同源) |
| 授权 | 表单填 embed token | **服务端签发启动地址 → 换票 → 授权凭证 Cookie** |
| 会话装配 | `create_session` 四键(含 embed token) | `create_session` **恰两键**(导航信息),授权来自 Cookie |
| 依赖面 | 静态 import 浏览器包(经 dev-only 加载模型规避) | 运行期 URL 加载 `@stackmaster/vm-ui` 产物 |

`plugin-dev` 本身属**退役面**(WP-96 物理删除),本包**不继承**它的宿主 / 表单 /
token / `host-mock` 反代任何一面;只沿用它的**会话装配序列**
(创建 → connect → 描述包 → 挂 workspace → 注入属性)。

## 2. 同源拓扑(为什么这样部署)

```text
学习者浏览器
  │
  │ ① 打开 {PUBLIC_ORIGIN}/app/c/:id/:version?t=<一次性票据>
  ▼
session-api(同域;信任域 2)
  │   ② 换票:Sec-Fetch-Mode: navigate → launch:{jti} Lua CAS 单次消费
  │      → 签发起动授权凭证 → Set-Cookie: sm_launch_grant(Path=/sessions,HttpOnly,SameSite=Strict)
  │   ③ 302 到 /app/c/:id/:version(**不含票据**) + Cache-Control: no-store + Referrer-Policy: no-referrer
  │   ④ 静态托管 page-app 产物(本包 dist/)⇒ 返回 index.html
  ▼
page-app(同源页面)
  │   ⑤ 运行期加载 /vm-ui/index.js(vm-ui 构建产物,同源静态资源)
  │   ⑥ POST /sessions  create_session{challengeId, challengeVersion} —— **不带 token**;
  │      授权凭证 Cookie 由 credentials:"include" 自动呈递(同源 ⇒ SameSite=Strict 成立)
  │   ⑦ GET /sessions/channel(认证 WSS,同源升级携带 Cookie)
  │   ⑧ GET /descriptors/:id/:version(公开描述包;**失败 = 缺席明示,不阻塞会话**)
  ▼
<sm-workspace>(整页布局)
```

**`SESSION_API_ALLOWED_ORIGINS` 不需要为 page-app 放宽** —— 这正是「同源」的意义:
页面与 `/sessions` / `/auth` / `/descriptors` 同域,不存在跨源请求。

## 3. 构建

```powershell
# 前置:vm-ui 必须先构建(其产物被拷进本应用产物)
pnpm --filter @stackmaster/vm-ui build

# 构建本应用(application build —— **不是** library mode)
pnpm --filter @stackmaster/page-app build
# 等价:prebuild 自动跑 sync:vm-ui ⇒ vite build ⇒ tsc -b --force
```

**构建形态与 vm-ui 产物的落地方式(两件事必须一起看)**:

1. **application build**:本应用是最终交付物(一个页面),不是被宿主 import 的库
   ⇒ 走 `vite build` 缺省形态(html 入口 + 代码分割 + 资源指纹);
2. **不静态 import vm-ui**:`tooling/dependency-cruiser.cjs` 的
   `no-backend-dependency-on-browser-packages` **禁止 `apps/**` 静态依赖浏览器可达
   包**(安全边界:浏览器包机制面不进服务端可达构建图)。因此:
   - `scripts/sync-vm-ui-dist.mjs`(prebuild 钩子)把 `packages/vm-ui/dist` 同步到
     `public/vm-ui/`;
   - vite 以 `public/` 为 publicDir,整目录拷贝 ⇒ 产物里是 `dist/vm-ui/**`;
   - `src/main.ts` 以**变量型 URL** 动态 `import("/vm-ui/index.js")`(带
     `@vite-ignore`)取回 `SessionClient` 等导出。

   为什么不能直接把 `packages/vm-ui/dist` 指成 publicDir:vite 的 publicDir 语义是
   **内容平铺到 outDir 根**,vm-ui 的 `index.html` / `index.js` 会与本应用产物同名
   相撞(实测 `dist/index.html` 会被覆盖)。`public/vm-ui/` 这层子目录就是为了错开。

产物形态(自包含,`dist/` 一个目录即可托管):

```text
apps/page-app/dist/
├── index.html            # 页面外壳(100dvh 定高链 + 挂载点 #app)
├── assets/index-*.js     # 本应用代码(含 boot 序列)
├── types/                # tsc 声明产物(仅供类型消费,运行期不使用)
└── vm-ui/                # vm-ui 构建产物整目录(运行期按 URL 加载)
```

## 4. 托管(session-api 侧)

session-api 用 `@fastify/static` 托管本包产物,由**一个配置键**开启:

| 配置键 | 缺省 | 含义 |
|---|---|---|
| `SESSION_API_PAGE_APP_DIR` | 未设 ⇒ 用仓库内 `apps/page-app/dist` | 指向本包 `dist` 目录;**显式配了却指不到目录 ⇒ 启动期拒绝**(fail-closed) |

行为:
- **未配置且缺省目录不存在 ⇒ 不注册 `GET /app/**` 静态路由**,但**换票路由照常**
  (换票是服务端语义,与"谁来托管页面"解耦 ⇒ 用同域反代托管页面是合法部署形态);
- **路由优先级**:`GET /app/c/:challengeId/:version`(换票)与静态面共享 `/app`
  前缀。保证 = **注册序**(静态托管在 `launchRoutes` 之后)+ **`wildcard: false`**
  (静态侧不为 `dist/` 之外的通配路径注册处理器 ⇒ 结构上吞不掉动态段)。集成用例
  `apps/session-api/test/launch/static-hosting.test.ts` 锁定;
- **响应头**:页面与其指纹资源一律 `Referrer-Policy: no-referrer`;非指纹资源
  (`index.html` 等)`Cache-Control: no-store`,指纹资源(`assets/**`)可长缓存。

## 5. 本地联调

### 5.1 只跑页面(零后端;可跑)

```powershell
pnpm --filter @stackmaster/page-app test        # 单测(vitest + jsdom;23 例)
pnpm --filter @stackmaster/page-app test:e2e    # 真机冒烟(真 chromium + 真 vm-ui 产物;5 例)
```

`test:e2e` 会先 `pnpm run build`,然后以 `vite preview` 托管**已构建产物**
(端口 5190),并用 Playwright 按契约形态注入 `POST /sessions` 应答。它断言:
两个可见视图位、恰一次 `create_session` 且载荷恰两键、零 401、整页不纵向溢出、
窄屏 375px 右半侧仍可达。

### 5.2 全链(需要后端;本机 Docker 不可用时**不可达**)

```powershell
# ① 起依赖 + session-api(需要 Docker)
pnpm --filter @stackmaster/session-api compose:app:up

# ② 构建页面并让 session-api 托管它(dist 缺省位置即可,无需配环境变量)
pnpm --filter @stackmaster/vm-ui build
pnpm --filter @stackmaster/page-app build

# ③ 登记一道题(k6 种子脚本,走真实登记链路)
$env:SESSION_API_HOST_BACKEND_TOKEN='host-backend-shared-credential-0123456789'
node apps/session-api/k6/seed-challenge.mjs

# ④ 签一张票(宿主凭证;响应恰两键 {launchUrl, expiresAt})
curl.exe -sS -X POST http://127.0.0.1:13000/auth/launch-tickets `
  -H "authorization: Bearer $env:SESSION_API_HOST_BACKEND_TOKEN" `
  -H 'content-type: application/json' `
  -d '{"challengeId":"chal-stack-escape","version":"1.2.3"}'
#   ⇒ 把返回的 launchUrl 贴进浏览器
```

**本机实测登记(如实)**:本机 Docker 不可用(`dockerDesktopLinuxEngine` 管道缺失)
⇒ 上面 ①③④ 三步**未实测**;②(构建)与 5.1(页面侧真机冒烟)已实测通过。
全链复跑归 **WP-95**(门禁改造:几何护栏 + E2E 改页面分发 + axe 面矩阵重定义)。

## 6. 纪律(不得回退)

1. **浏览器侧不做授权判断**:页面从不读票据查询串、不校验租户、不判断"这个地址
   该不该能用"。唯一授权事实来自 `POST /sessions` 的应答(401 = 地址已失效);
2. **失败不重试**:`create_session` 失败即呈现「地址已失效,请向平台重新获取」并停止
   —— 票据与授权凭证都是**单次消费**,重试没有任何成功可能(D-LT-2);
3. **不把长期凭证放进页面**:host backend token、票据、会话凭证一律不进页面代码与
   DOM;页面只依赖 HttpOnly Cookie;
4. **不静态依赖浏览器可达包**(`no-backend-dependency-on-browser-packages`);
5. **`overflow: hidden` 禁用**:`html` / `body` / `#app` 一律不得用 `overflow: hidden`
   —— 它会把 `overflow-x` 升格成**裁剪**,窄屏下内容宽不上浮到文档层 ⇒
   **右半侧不可达**(本仓库 WP-93/94 与 WP-92 各实测一次)。`e2e/page-app.spec.ts`
   的 375px 用例是这条纪律的回归护栏;
6. **描述包缺席不阻塞会话**:取包失败 = `descriptorStatus="absent"` + 明示提示,
   会话照常可用。

## 7. 测试面

| 面 | 载体 | 断言核心 |
|---|---|---|
| 启动地址解析 | `test/launch-path.test.ts`(14 例) | 占位符/段数由**契约模板**推导;非法形态一律 `null`(含尾部斜杠、畸形编码) |
| 引导序列 | `test/boot.test.ts`(9 例) | `createSession` 入参**恰两键**;失败**不重试**;描述包缺席仍 `ready` |
| 真机冒烟 | `e2e/page-app.spec.ts`(5 例) | 两个可见视图位 / 恰一次 `create_session` / 零 401 / 整页不纵向溢出 / 375px 右半侧可达 |
| 服务端托管与优先级 | `apps/session-api/test/launch/static-hosting.test.ts`(8 例) | 换票不被静态吞掉;`/app/` 带 no-store + no-referrer;未配置即不注册但换票照常;装配路径防漏传断言 |
