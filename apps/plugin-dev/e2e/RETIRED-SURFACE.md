# plugin-dev E2E 面处置清单(WP-95;退役面登记,不删)

> **性质**:本文件是「**退役 ≠ 现在可删**」(接手入口 §3.1 第 3 条)要求的**逐文件登记**。
> `apps/plugin-dev` 属 WP-96 的物理删除面;WP-95 只做两件事:
> ① 把**能改的**夹具换成启动地址链(`e2e/helpers/launch-chain.ts`);② 把**改不动的**
> 如实登记在此(**其链路已失效**,不是断言失败,而是**被测对象不存在**)。
>
> **纪律**:不得为了让这些用例变绿而放松断言。它们的红是**结构性**的(表单 / embed token /
> 宿主 iframe 面已由 WP-91 退役),只能随 WP-96 删除该面而消解。

## 1. 链路失效的**结构性**事实(2026-09-18 / WP-91)

| 面 | 状态 | 证据 |
|---|---|---|
| `POST /auth/embed-tokens` | **端点已退役** | WP-91 第三步(DRY 硬切);`docs/contracts/嵌入协议.md` 整体退役 |
| 开发壳表单 4 键(`challengeId` / `challengeVersion` / `embedSessionId` / `embedToken`) | **不存在** | 新链 `create_session` payload **恰两键** `{challengeId, challengeVersion}`(D-LT-5 5c) |
| `scripts/issue-embed-token.mjs` | **仍在磁盘(退役面)** | WP-96 删除 |
| `host-mock/**`(宿主模拟页 / 5174 插件产物页) | **仍在磁盘(退役面)** | 同上 |
| 嵌入协议面(`EMBED_THEMES` 三值 / `theme_changed` / `data-sm-theme` 落 dark) | **整体退役** | D-UI-6 终端单主题 + WP-90 契约退役标注 |

## 2. 逐文件处置

| 文件 | 依赖的旧面 | 处置 | 依据 |
|---|---|---|---|
| `e2e/fixtures.ts#createdSession` | 表单 4 键 + `issue-embed-token.mjs` | **改不动(保留原函数,登记为退役)**。新链版本 = `e2e/helpers/launch-chain.ts#openWorkspaceViaLaunchAddress`(同体裁、换链路)。**注**:plugin-dev 的 dev 壳源(`:5173`)与 API 源(`:13000`)**跨源** ⇒ 换票 Cookie 的呈递前提与「真形态(同源)」不同;真形态的链由 `apps/page-app/e2e/launch-chain.spec.ts` 承担 | D-LT-5 / WP-91 |
| `e2e/embed-protocol.spec.ts` | 嵌入协议**五消息 / 能力枚举 / 主题三值**(`appearance.resolvedTheme` 断言 light / dark) | **改不动** ⇒ 整文件随 WP-96 删除 | 嵌入协议整体退役(D-API-153 第 5 项) |
| `e2e/browser-matrix.spec.ts` | 同上(:146 断言 `data-sm-theme="dark"`)+ 320px 画布面 | **改不动** ⇒ 整文件随 WP-96 删除;其**可迁移的那一条**(320px 横向溢出)**已由 WP-95 的几何护栏在 page-app 侧承接**(四视口 × D-UI-5 横向滚动断言) | WP-93/94 实测 + 本 WP 几何护栏 |
| `e2e/axe-contrast.spec.ts` | `plugin-iframe-*` / `plugin-dev-shell-*` / `plugin-degraded-*` 九面(light / dark / terminal 三预设) | **改不动** ⇒ 整文件随 WP-96 删除;**新面集合**已由 `apps/page-app/e2e/axe-matrix.spec.ts`(9 面,新形态)与归档目录 `apps/page-app/e2e/reports/axe/**` 承接;历史归档 `apps/plugin-dev/e2e/reports/axe/**` **只增不改** | D-UI-6 / D-UI-7 ④ / 遗留 #13 #14 |
| `e2e/descriptor.spec.ts` | `createSessionViaForm` + `?descriptor=formal` 正式通道 | **可改**(换 `openWorkspaceViaLaunchAddress` + 描述包经 `/descriptors/:id/:version`),但**描述包登记脚本走 compose**,本机不可实测 ⇒ **未改**(不提交无法验证的半改) | 本机 Docker 引擎不可达 |
| `e2e/session.spec.ts` | `createSessionViaForm` | **可改**(同上),**未改**(同上:本机不可实测) | 同上 |
| `e2e/payload.spec.ts` | `createSessionViaForm` | **可改**,**未改**(同上) | 同上 |
| `e2e/workspace-layout.spec.ts` | `createSessionViaForm`(20 处) | **可改**,**未改**(同上) | 同上 |
| `e2e/workspace-windows.spec.ts` | `createSessionViaForm`(8 处) | **可改**,**未改**(同上) | 同上 |
| `e2e/breakpoint-linkage.spec.ts` | `createSessionViaForm` + 调试通道 | **可改**,**未改**(同上);**本文件另含 WP-95 的遗留 #20 断言收紧**(`toBeInViewport({ ratio: 0.9 })` + 锚点行行高 ≤ 28px) | 遗留 #20 |
| `e2e/disconnect-recovery.spec.ts` | `createSessionViaForm` + 断线注入 | **可改**,**未改**(同上) | 同上 |
| `e2e/reduced-motion.spec.ts` | `createSessionViaForm` | **可改**,**未改**(同上) | 同上 |

## 3. 为什么「可改的」也没改(不提交无法验证的半改)

被标记为「可改」的六个 spec 都把 `createdSession` 换成
`openWorkspaceViaLaunchAddress` 即可**在语法上**跑起来;但它们的**服务端前置**
(题目登记 / 描述包 / 调试通道)全部依赖 `e2e/global-setup.ts` 拉起的 **compose 拓扑**,
而本机 **Docker 引擎不可达**(`dockerDesktopLinuxEngine` 管道缺失,已多次实测):

- 改了也**无法实测** ⇒ 无法区分「改对了」与「改出新问题」;
- 半改更坏(本仓库既有登记:`k6` 三场景与 compose 集成用例同理,**承接方同一批**);
- 这批 spec 的**载体本身**在 WP-96 就要删除 ⇒ 投入改造的价值进一步下降。

**承接方**:WP-96(与退役面删除同批)—— 要么随面删除,要么在真拓扑可用时改走
`helpers/launch-chain.ts`。**本清单即移交依据**。
