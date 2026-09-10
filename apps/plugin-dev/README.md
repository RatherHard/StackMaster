# @stackmaster/plugin-dev

插件 iframe 开发壳(阶段四 WP-F1):Vite 应用(vanilla TS,无框架),为前端
各 WP 提供可运行的开发联调环境。**本阶段仅开发联调**;正式的 iframe 插件
形态(独立来源、postMessage 宿主协议、自适应高度/主题/语言)归阶段五,落点
为 `packages/web-component` + `@stackmaster/embed-runtime`。

## 启动

```bash
# 0) 后端拓扑(需要会话联调时):PostgreSQL + Redis + MinIO + session-api + vm-worker
pnpm --filter @stackmaster/session-api compose:app:up   # session-api 发布 13000

# 1) 构建 vm-ui(开发壳加载其 dist 产物;turbo build 会先于本包自动执行)
pnpm build

# 2) 启动开发壳
pnpm --filter @stackmaster/plugin-dev dev    # http://localhost:5173
```

页面挂载 vm-ui 的 `<sm-workspace>`(空标签页区域占位,WP-F5 实现工作区容器)。

## 加载模型(为什么开发壳不 import vm-ui)

dependency-cruiser 规则 `no-backend-dependency-on-browser-packages`
(tooling/dependency-cruiser.cjs)把 `apps/*` 全部视为浏览器可达包的**非消费
方**——apps 静态导入 `packages/vm-ui`、`packages/web-component` 即红灯。
这与本仓库的目标拓扑一致:真实平台上,宿主页面加载的是**已发布的组件
bundle**(阶段五形态),而不是把组件包打进宿主构建图。

因此开发壳按同一拓扑消费 vm-ui:

- `vite.config.ts` 把 `packages/vm-ui/dist` 配为 `publicDir`(静态资源形态
  提供);`index.html` 用 `<script type="module" src="/index.js">` 直接加载
  vm-ui 产物,加载即注册 `<sm-workspace>`;
- vm-ui 产物**自包含**(lit 内联,见 `packages/vm-ui/README.md`),不依赖
  打包器解析裸模块导入;
- `@stackmaster/vm-ui` 以 devDependencies 声明(不 import):只为 turbo
  `^build` 构建序与工作区链接,不产生 dependency-cruiser 模块依赖边。

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
- `pnpm test`:jsdom 挂载冒烟(壳结构、挂载点、幂等);`<sm-workspace>` 的
  元素注册与渲染由 `packages/vm-ui` 自身测试覆盖——本包测试环境不加载
  vm-ui 产物(见上)。
