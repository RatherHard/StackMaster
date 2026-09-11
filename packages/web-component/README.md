# @stackmaster/web-component

`<pwn-memory-vm>` 承载包——**插件 Shell 正式实现**(阶段五 WP-52;WP-F1 占位桩
已退场)。独立来源 iframe 内的插件视图托管:嵌入握手、esid fragment 一次性
读取、引导配置取回(D-API-75 通道 a)、`height_changed` 上报、主题 / 语言
接线位、会话全流程挂接(`SessionClient` → `<sm-workspace>`)。

> 权威语义:`docs/contracts/嵌入协议.md`(消息契约与 V-1~V-13)、
> `docs/develop/权威API语义规约.md` D-API-75/77(交付通道与运维参数)、
> `docs/develop/阶段五WP52决策草稿.md`(Q3 定案 / demo 拓扑 / 接线点接口)。

## 职责面

- **嵌入握手(插件侧)**:`hello` 发起(T_handshake 窗口内按预算重发、seq
  递增、targetOrigin `*`)、`ready` 消费与宿主 origin 钉住(V-11)、ready 幂等
  重放(§4.5)、方向过滤与逐规则校验(V-1'/V-1/V-2~V-8/V-10)、失败静默 +
  本地计数(V-12,计数键与宿主侧同词汇);
- **能力降级三行(§4.4)**:未授予 `auto_resize` → 不装配高度管道;未授予
  `theme` / `language` → 内置默认(light / zh-CN);`capabilities` 空数组 =
  完全静态形态;
- **会话全流程**:引导配置取回(esid POST 体换取 `{embedToken, sessionApiOrigin,
  challengeId, challengeVersion, embedSessionId}`;浏览器对 token 不解析)→
  create_session(embedToken 随命令体,`embedSessionId = esid`)→ 工作区挂载;
- **降级显示**:静态文案 + 用户可见重试入口,零反射面(不回显任何对端消息
  内容,§4.3);
- **MessageChannel port 路径**:宿主转移 port 后控制面消息改走 port;凭证信封
  为 D-API-75 备用通道 b(默认路径 a 为主,凭证值零回显)。

主题 / 语言接线点接口(WP-53 增量消费)、demo 拓扑(独立来源端口 5174)、
组件 attribute 与 data-testid 清单:**见 `docs/develop/阶段五WP52决策草稿.md`**。

## 依赖边界(Q3 定案)

消费 `@stackmaster/protocol` 公开入口、`@stackmaster/embed-runtime` 无状态
构件(esid 校验 / TypeRateLimiter / 违规计数键;Q4「分层同源」)、
`@stackmaster/vm-ui` 工作区装配。dependency-cruiser 放行横向边:
`web-component → embed-runtime`、`web-component → vm-ui`(WP-52 修订,
反例自检 `pnpm lint:deps:self-test` 同步);`→ web-component` 方向全禁。

## 构建形态

- `pnpm build` = `tsc -b`(emitDeclarationOnly,先产 `dist/*.d.ts`)+
  `vite build`(库模式单入口 `index`,ESM 输出 `dist/index.js`);
  `emptyOutDir: false` 保护 tsc 产物;
- **产物自包含单文件**(lit / vm-ui / protocol / embed-runtime 内联,
  `codeSplitting: false`):插件文档页以 `<script type="module"
  src="./pwn-memory-vm.js">` 相对路径直接加载(非根路径部署兼容);
- **受限 CSP 兼容**:零 eval、零动态外部导入;插件文档页
  (`plugin/index.html`)零内联脚本——`script-src 'self'` 形态自测见
  `test/artifact.test.ts`,demo 服务器(plugin-site-server.mjs)以 CSP 头
  真实运行证明;
- `pnpm scan:public`(仓库根)将本包 dist 纳入公开产物隔离扫描。

## 插件文档页(部署形态)

`plugin/index.html` + 构建产物 `dist/index.js` 整目录拷贝即可部署;页面以
`<pwn-memory-vm bootstrap-endpoint="…">` 实例化(端点 URL 经 attribute 注入,
备选全局 `window.PWN_MEMORY_VM_CONFIG`)。demo 拓扑与 WP-55 Playwright 共用
本页(承载:plugin-dev 的 `dev:plugin-site` 脚本,端口 5174)。

## 版本组合登记(WP-F1 锁定,2026-09-11;WP-52 沿用)

| 依赖 | 锁定范围 | 说明 |
|---|---|---|
| `lit` | `^3.3.3` | Lit 3 最新稳定(与 vm-ui 同源同版) |
| `vite` | `^8.3.0` | 最新稳定(rolldown/oxc 工具链) |
| `jsdom` | `^30.0.1` | 组件测试环境 |

装饰器模式与 vm-ui 一致:`experimentalDecorators: true` +
`useDefineForClassFields: false`(Vite 8 oxc 暂不支持标准装饰器 lowering,
理由详见 `packages/vm-ui/README.md`)。
