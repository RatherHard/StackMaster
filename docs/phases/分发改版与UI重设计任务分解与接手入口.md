# 分发改版与 UI 重设计 —— 任务分解与接手入口

> **这是给下一个 agent 的入口文档。开工前从头读完,再动手。**
> **建立** 2026-09-18 · **状态** **执行中:WP-90 ~ WP-95a ✅ 已落地;WP-96 起在途**(逐 WP 状态见 **§四** 的「状态」列与 **§九**) · **阶段归属** 由主控另定(本分解**不预先占用阶段号**;下述 WP 号可整体替换,编号不承载语义)

---

## 一、30 秒现状

> **2026-09-19 订正(勿沿用原文)**:原文此处写「**计划与契约面已全部定案并落到文档;实现一行没写。** 磁盘上的代码**仍是旧的插件形态 + Niri 式列条带**」—— **该表述已失效**。
> **现况**:**契约面与实现均已落地(WP-90 ~ WP-95a)**;剩余 = **WP-96 ~ WP-99**。落地事实段见 `CLAUDE.md`「**分发改版与 UI 重设计落地事实**」。
> **仍未执行的一件事 = 退役面的物理删除**(`packages/embed-runtime|react-wrapper|web-component`、`apps/plugin-dev`、`docs/contracts/嵌入协议.md`、会话动作协议 v1 分支)⇒ 归 **WP-96**;**在此之前不得据退役决定删代码 / 删契约 / 改 E2E 断言** —— 该冻结期**已由主控于 2026-09-19 解除**(授权依据 = `docs/develop/decisions-分发改版与UI重设计.md` **§四·补.3 / 四·补.4**)。

已定案的两件事:

| 改版 | 定案 | 权威文本 |
|---|---|---|
| **A · 分发改版** | 取消插件形式;**与 API 同源的独立页面**;平台后端调签发端点取得**一次性启动地址**并下发给学习者 | 工作稿 **§五** + `启动票据契约设计草案.md` **§〇.1** + **D-API-153 / D-API-154** |
| **B · UI 重设计** | 整页布局;左右两分(右 = payload 固定 / 左 = 视图管理窗口);无边框紧密贴合;类型名在视图内左上角;列表按钮(勾选 + 排序);`Ctrl+↑/↓`;**终端单主题**(light/dark 退役) | `前端的交互和开发设计.md`「工作区组件」一节(**目标态**)+ 其 2026-09-18 增补 |

**唯一权威来源已有依据且文档面已修订完毕**:`docs/项目计划书.md` + 四条底线第 4 条。

---

## 二、开工前必读(按顺序)

1. **`CLAUDE.md`** —— 仓库纪律(四条底线、安全红线、依赖方向、门禁)。**它的「在途改版」小节是本次的现状索引。**
2. **`docs/develop/前端重设计与分发形态改版.md` §五** —— 分发形态四项定案 + 拓扑 + 边界。
3. **`docs/develop/启动票据契约设计草案.md`** —— 六项裁定 + 攻击面 + 9 条机检 + **§十二 实施前须补**。
4. **`docs/develop/前端的交互和开发设计.md`** —— 「工作区组件」一节(**目标态**)+ **本版待定案**。
5. **`docs/develop/前端交互需求拆解.md` §二** —— FE-WS-01~15 + 「已废止条目登记」。
6. **`docs/phases/中期遗留清单.md`** —— 遗留 #33~#38(含 #38 = 本次的总承接项);`中期验收评审.md` §六 同号。
7. **`docs/develop/权威API语义规约.md` D-API-153 / D-API-154** —— 决策正文。

---

## 三、铁律(违反即返工)

### 3.1 流程铁律

1. **先契约后实现**(契约纪律 5.6):凡动 `packages/protocol` / `challenge-schema` 的面,**必须**先改契约包与 golden fixture → 再改实现。**启动票据是全新契约族,不许「顺手加个路由」。**
2. **两处冻结契约面只有一处要动**:**嵌入协议面整体退役**(不是版本递增);**布局快照面不是契约面**(`WorkspaceLayoutSnapshot` 在 `packages/vm-ui`,已查证)。**不要再去动 `packages/protocol` 里的布局字段 —— 那里根本没有。**
3. **退役 ≠ 现在可删**:`packages/embed-runtime|react-wrapper|web-component`、`apps/plugin-dev`、`docs/contracts/嵌入协议.md`、`e2e/embed-protocol.spec.ts` 的删除**必须与实现同批**,且**先有迁移指引**。
4. **两处文档同批**:改 `docs/phases/中期遗留清单.md` 就必须同批改 `中期验收评审.md` §六(**编号双射 {1..38}**);改遗留项状态就同批改两处。
5. **不得以沉默代替结论**:任何「待定案」项要么定案(选定值 + 理由 + 否决项理由),要么显式写「本次不做」。
6. **不得借修订扩权**:范围外的问题**报上来**,不要顺手改。

### 3.2 可读性纪律(最容易误读的一条)

**废止窗高 / 列高下限 ≠ 放松可读性。** 新布局把「压缩以适配」机制**整条移除**,改由「**左半侧纵向滚动 + 每个视图位有确定高度**」满足。
**判据**:落地实现**不得出现「视图被压到装不下一行字节」**。历史反例:4 窗列每窗 146px,而面板 chrome 实测 182.1px。

### 3.3 「宿主」三义项(不得混改)

| 义项 | 处置 |
|---|---|
| **宿主页面**(嵌 iframe 的第三方页面) | **退役**;**涉及「页面」处不得再用「宿主」二字** |
| **宿主 / 宿主平台**(服务端集成方) | **保留**(只与 API 交互,不与页面共享运行环境) |
| **宿主代码 / 宿主环境**(底线第 4 条前半句) | **一个字都不许改** |

---

## 四、排期(批次 + 依赖 + 关键路径)

### 4.0 前置定案(主控;不可由 agent 代决)

**P0-决** —— UI 侧 7 项待定案必须先定(见 `前端的交互和开发设计.md`「本版待定案」):① 左右两分比例是否可调;② 视图位数量(固定 2 还是可配);③ `Ctrl+↑/↓` 与浏览器/OS 快捷键冲突处置;④ 拖拽落点语义去留;⑤ 窄屏降级;⑥ 主题退役后 `--sm-*` token 收敛口径;⑦ 「视图」菜单组与左半侧列表按钮的**唯一入口**。
⇒ **这 7 项不阻塞 WP-90(契约),但阻塞 WP-93 / WP-94(UI 实现)。**

> **✅ 已裁定(2026-09-18,主控)** —— **权威文本 = `docs/develop/decisions-分发改版与UI重设计.md`**(编号 **D-UI-1 ~ D-UI-7**),并同批钉死分发侧实施前开口(**D-LT-1 ~ D-LT-4**)与**本次「不做」清单**。
> **裁定摘要**(逐条理由与否决项见该文,勿在此处复述口径):
> ① **不可调,固定 1:1,无分界拖拽**(「无分隔条」硬约束);② **固定两个可见视图位**(需求给定),超出者由左半侧纵向滚动承载;③ **`Ctrl+↑/↓` 唯一**、在**左半侧**捕获并 `preventDefault`,边界不环绕,原分隔条方向键随分隔条退场;④ **拖拽只保留列表内重排**一种落点,原三类落点废止,**不实现拖拽中自动滚动**;⑤ **窄屏不改变形态**,左半侧取 `min-width = 452.4px`(既有推导值改挂载体)⇒ 页面横向滚动,**否决**隐藏右半侧 / 上下堆叠;⑥ **保留 21 枚 token 名、收敛为终端一套值**,删除 light / dark / auto 三套记录与切换面,**且 fallback 字面量必须同批改终端的**(防静默回落浅色);⑦ 视图类型名移入视图内左上角后**地标名不变**、内层 region 保留窗口维度,列表按钮补**键盘路径**(`Space` 勾选 / `Alt+↑↓` 移动),axe 基线不得回退。
> **⑦ 的补充裁定(唯一入口)**:左半侧列表按钮 = **视图显示与否 + 排序的唯一入口**;菜单「窗口」组保留**聚焦**语义(点击 = 聚焦并滚动到该视图),**不再承载勾选 / 排序**。WP-93 按此实现。

> **状态图例(§4.1 ~ §4.3 的 WP 单元格前缀)**:✅ = **已落地**(逐条证据行见 **§九**);🟡 = **在途**(本轮执行中);⬜ = **待开工**。**勾选 = 已落地事实,不是计划**。

### 4.1 批次 0 —— 阻塞一切

| WP | 内容 | 为何最先 | 完成标准(全部 exit 0) |
|---|---|---|---|
| ✅ **WP-90 · 启动票据契约族** | `packages/protocol` 新增契约族 + `LAUNCH_TICKET_PROTOCOL_VERSION = 1`(Zod → JSON Schema);golden fixture(valid / invalid 双向);`docs/contracts/启动票据协议.md`;`docs/contracts/数据分类与秘密零驻留清单.md` 增该族字段分类;`docs/contracts/版本策略.md` 增族 + 嵌入协议退役标注 | 契约纪律 5.6;**它是 WP-91/92 的前提** | `pnpm build` / `typecheck` / `test`(protocol 单测)/ `fixtures:manifest`(重算一致)/ `smoke:contract` / `lint:deps` / `scan:public` |

### 4.2 批次 1 —— 契约后可并行

| WP | 内容 | 依赖 | 完成标准 |
|---|---|---|---|
| ✅ **WP-91 · 后端签发与换票** | `POST /auth/launch-tickets`(鉴权复用 `hostBackendTokenMatches`,**单份实现**);换票路由(服务端内,`Sec-Fetch-Mode: navigate` 校验);Redis 新键域 `launch:{jti}`(fail-closed);`RateLimitDimension += launch_ticket_rate`;配置键 `SESSION_API_LAUNCH_TICKET_TTL_SECONDS`;**日志脱敏机检**;`/auth/embed-tokens` 退役 | WP-90 | session-api 测试绿(含**单次消费原子性**、**401 三态逐字节同形**、**429 逐字节**、**404 同形**、**URL/body 参数不得进入租户派生路径**机检);`test:integration` |
| ✅ **WP-92 · `apps/page-app`** | 与 API 同源托管的页面应用;`100dvh` 布局壳;构建形态(application build,非 library mode) | WP-90 | `pnpm build`;同源能打开并完成一次换票(本地真机) |
| ✅ **WP-93 · UI 改版 A(布局)** | 整页布局;左右两分;无边框紧密贴合;类型名移入视图内左上角;左半侧视图管理窗口(上下两半、纵向堆叠、上下滚动、**丝滑动画** + `prefers-reduced-motion` 降级);列表按钮(勾选 / 排序);`Ctrl+↑/↓` | **P0-决 ①~④⑦** | vm-ui 单测绿;**真机几何读数**(左半侧滚动可达、无「装不下一行字节」) |
| ✅ **WP-94 · UI 改版 B(模型与主题)** | 布局快照面按新模型**自由重构** + 改 vm-ui 测试;`WorkspaceLayoutSnapshot` 字段替换;**终端单主题**(light/dark 退役,token 收敛) | WP-93(同轨) | vm-ui 单测绿;主题 token 键集断言更新;`scan:public` |
| ✅ **WP-95 · 门禁改造**(+ **WP-95a** 遗留 #39 修复,同批) | **几何护栏**(遗留 #33):断言每视图位高度 ≥ 可读下限 **且**字节视图可见行数;E2E 改页面分发;axe 面矩阵**重定义**(`plugin-iframe-*` 退役 ⇒ 新形态面集合) | WP-92/93/94 | 全量 E2E 绿;axe 归档 9/9 面 0 违规(**新面集合**);`E2E_MATRIX` 三引擎 |

### 4.3 批次 2 —— 收口

| WP | 内容 | 依赖 | 完成标准 |
|---|---|---|---|
| ✅ **WP-96 · 迁移与退役**(2026-09-19/20 落地) | `docs/user/宿主平台接入指南.md` 改写(调签发端点 + 下发地址);退役面**清点后删除**(三包 + `plugin-dev` + `docs/contracts/嵌入协议.md` + 相关 E2E + `MAX_EMBED_HEIGHT_PX`/`height_changed`/`auto_resize`);Changesets 收敛为仅契约包 | WP-91~95 | `pnpm build` / `lint:deps`(模块数下降)/ `scan:public`;退役面**零残留**;宿主迁移指引成文 —— **已达成(2026-09-28 WP-97 复核)**:退役面五处**均不在磁盘**(`apps/plugin-dev` / `packages/{embed-runtime,web-component,react-wrapper}` / `docs/contracts/嵌入协议.md`);落地提交 `9fbb78b`(WP-96 尾,32 文件 +731/−309)+ 推送 `a070acb` 起 59 个提交 |
| ✅ **WP-97 · 遗留真机复跑**(2026-09-28) | 三引擎真机复跑:**#1(webkit 跨源认证)载体退役验证**;#9 `e2e-matrix` 面集合重定义;**#34 / #35 / #37 结案判定**;#36 左半侧宽度下免折行约束重算 | WP-95/96 | `E2E_MATRIX=1` 实测读数;**#1 不得记为「已修复」**(是失去载体) —— **已达成**:`E2E_MATRIX=1` = **51 passed / 24 skipped / 0 failed**(三引擎逐格同形;axe 九面归档 `2026-09-28/run-1`);**#1 保持「失去载体」口径并新增未实测登记**(同源形态的 webkit 认证 WSS 握手——矩阵用桩、真拓扑本机 Docker 不可达,`E2E_LAUNCH_CHAIN=1` = **2 skipped 非通过**);**#9** artifact 面已落地、CI 面保持开放;**#34 / #35 / #37 结案判定已出**(依据见评审 **§六·三** 与清单 **§三 / §十**);**#36** 已于 WP-95a 结案 |
| ✅ **WP-98 · 用户文档回填**(2026-09-19 落地) | `docs/user/界面帮助手册.html` / `学习者上手指南.md`(**只在实现落地后**才改;现在改 = 让文档说谎);`出题人文档` 如有受影响 | WP-95 | 用户文档与磁盘行为一致 —— 落地提交 `f247b48`(界面帮助手册:整页布局 / 终端单主题 / 启动地址链)+ `7867232`(学习者上手指南 / 试用环境部署指南 / 出题人两页) |
| ⬜ **WP-99 · 验收评审** | 阶段收口评审;**更新遗留清单与评审 §六**(同批,维持双射);`CLAUDE.md` 事实段回填 | 全部 | 遗留 #38 结案;新增遗留同号登记 |

### 4.4 并行轨(与本次改版无关的既有开放遗留,可随时派单)

| 建议 WP | 覆盖遗留 | 备注 |
|---|---|---|
| **WP-81a** | canary 实现 + P1~P6 + **跨语言互证机检**(完成标准) | 已定案待派单 |
| **WP-84** | #21(P0,`objectId` 未登记公开面,**必须先于任何公开面扩展**)/ #22 / #24 | 优先级高 |
| **WP-85** | #13 / #14 / #20 | 证据面改造 |
| **WP-86** | **#27(P0,采集面生产接线)** / #28 / #29 | 不接线则采集面「虽绿但零数据」 |
| **WP-87** | #1 / #9 | ⚠ **已被 WP-97 取代**:载体退役后修法路径改变,**派单前先与主控确认** |
| **WP-88** | #30 | **条件性**:#30 已改判「由改版消解」,仅当改版未落地而仍需复核旧链时派单 |

### 4.5 关键路径

```
P0-决(主控 7 项) ✅ ──────────┐
                              ▼
WP-90(契约)✅ ─▶ WP-91(后端)✅ ─▶ WP-95(门禁)✅ ─▶ WP-96(迁移退役)✅ ─▶ WP-97(真机复跑)✅ ─▶ WP-98 ✅ ─▶ WP-99 ⬜
        └────▶ WP-92(page-app)✅ ─┘
        └────▶ WP-93 ✅ ──▶ WP-94 ✅ ─┘
```

**进度(2026-09-28 WP-97 收口)**:`P0-决`(D-UI-1~7 / D-LT-1~5)与 **WP-90 ~ WP-98 已全部落地**(WP-97 真机复跑与遗留结案判定于 2026-09-28 完成);**唯一未开工 = WP-99(阶段收口评审 + 遗留清单 / 评审 §六 / `CLAUDE.md` 事实段回填)**。

**最短关键路径 = WP-90 → WP-91 → WP-95 → WP-96 → WP-97 → WP-99(WP-98 已落地,不再占关键路径)。**

---

## 五、门禁命令(全绿或**显式登记未跑**)

```powershell
pnpm build; pnpm typecheck; pnpm test; pnpm lint; pnpm lint:deps; pnpm lint:deps:self-test
pnpm test:rust; pnpm scan:public; pnpm fixtures:manifest; pnpm smoke:contract
pnpm test:miri; pnpm fuzz:smoke
$env:SESSION_API_IT='1'; pnpm test:coverage        # 完整覆盖率形态

# E2E(**默认形态不需要 Docker、不需要任何 env**)
pnpm --filter @stackmaster/page-app test:e2e                       # 构建 + chromium 全量(23 passed / 2 skipped)
$env:E2E_MATRIX='1'; pnpm --filter @stackmaster/page-app test:e2e  # 追加 firefox / webkit(51 passed / 24 skipped / 0 failed)

# 真拓扑启动地址链(**需要 compose 拓扑 + page-app 产物被 session-api 托管**;本机 Docker 不可达 ⇒ 按设计 skip,不是通过)
#   前置四步见 apps/page-app/README.md §5.2(compose:app:up → 构建 vm-ui + page-app → 种子登记 → 注入凭证)
$env:SESSION_API_HOST_BACKEND_TOKEN='host-backend-shared-credential-0123456789'
$env:SESSION_API_ORIGIN='http://127.0.0.1:13000'
$env:E2E_SKIP_COMPOSE='1'                          # 对接已在运行的旧拓扑
$env:E2E_LAUNCH_CHAIN='1'; pnpm --filter @stackmaster/page-app exec playwright test e2e/launch-chain.spec.ts
```

**已知环境事实**:① `pnpm lint:deps` 本机默认堆 OOM ⇒ 需 `NODE_OPTIONS=--max-old-space-size=12288`(遗留 #18);② 本机镜像**不可重建**(docker daemon 代理被拒)⇒ `test:compose` 本机**不可达**(遗留 #19),不是「未做」。

---

## 六、陷阱清单(本仓库真实踩过的,逐条都是教训)

### 6.1 文件与工具

1. **绝不用 PowerShell 的 `Get-Content` / `Set-Content` / `-Raw` 改写工作文件** —— 本仓库是 **LF UTF-8**,PowerShell 文本往返会按 legacy 码页回写产生**非法 UTF-8 并静默丢行**(已发生真实事故)。**一律用 read / edit / write 工具。**
2. **PowerShell 没有 heredoc** —— `git commit -F - <<'EOF'` 会解析失败,用**多个 `-m`**。
3. **PowerShell 5.1 不支持 `??`** —— 用 `if/else` 赋默认值。
4. **超长行文档的 `read` 会截断**(>2000 字符的行),`edit` 的 old_string 可能匹配不到 —— 需要**逐字节扫描**定位(本仓库已有一处 2000+ 字符的行)。

### 6.2 dev 壳 / Vite

5. **写文件会杀死 dev server**:原子写留下的 `.<name>.<pid>.<guid>.tmpdir/` 被 Windows 锁住 ⇒ Vite 的 FSWatcher 撞 `EBUSY` ⇒ **整个进程退出**(实测三次)。已在 `apps/plugin-dev/vite.config.ts` 加 `watch.ignored` 含 **`**/*.tmpdir`**(**必须按后缀匹配** —— 前缀有 `._…` 与 `.…` 两种,按前缀会漏)。**勿回退此项。**

### 6.3 会骗人的「绿」

6. **单元绿 + 结构断言绿 ≠ 功能在**:vm-ui **895 单测全绿**时,窗高拖拽在真机上失效(只兑现 7.5px),是 **E2E 抓出来的**。
7. **axe 绿 ≠ 几何对**:axe **9/9 面 0 违规**时,窗口被压到 **146px**(连一行字节都看不见)。
8. **改了 vm-ui 必须重建两处产物**:`pnpm --filter @stackmaster/vm-ui run build` **与** `pnpm --filter @stackmaster/web-component build` —— 5174 服务的是 `web-component/dist/index.js`(内联单产物),不重建则 E2E 看到**旧产物**,给你**假红或假绿**。
9. **`dist/` 已 gitignore**,重建不污染工作树。
10. **校验正则会误报**:`^[+-](1|2|3)\.` 曾把 §5.6 的契约清单编号误判成「底线 1/2/3 被改」。**宽正则不能当结论**,要看命中内容。

### 6.4 文档与记录

11. **目标态 ≠ 现状**:需求文档现已描述**不存在的 UI**。**现状核对 / E2E 断言 / 用户文档一律以磁盘实现为准**,直到实现落地。
12. **退役面清点 ≠ 现在可删**。
13. **动了 `docs/phases/` 就要维持双射**(#33~#38 ↔ 评审 §六),并同批改两处。

---

## 七、第一批动作(建议直接照做)

1. **读** §二 的 7 份文档(**先读 CLAUDE.md 的「在途改版」小节**)。
2. **确认工作树干净**:`git status --short`(应为 clean);确认**代码面零改动**是你自己引入前的基线。
3. **建契约**:按 `启动票据契约设计草案.md` §二 的字段表与 §〇.1 的裁定值,在 `packages/protocol` 新增契约族 + 版本常量 + **golden fixture 双向**。
4. **跑**:`pnpm build && pnpm fixtures:manifest && pnpm smoke:contract`(**注意 `fixtures:manifest` 是重算,不是 `--check`**)。
5. **写契约文档** + **登记数据分类**(票据字段进入 `docs/contracts/数据分类与秘密零驻留清单.md` —— **这一步不能省**:它是「秘密不进浏览器」的机检来源)。
6. 契约全绿后再进 WP-91。

---

## 八、不要做什么

- ❌ **不要**改 `docs/项目计划书.md` 的产品定位/底线**以外的**口径 —— 文档面修订**已完成**,再改就是扩权。
- ❌ **不要**在实现落地前改写 `docs/user/**`(描述已发布行为;现在改 = 让文档说谎)。
- ❌ **不要**因为「嵌入协议退役了」就删包、删契约、删/改 E2E 断言。
- ❌ **不要**把「布局快照面」当契约面(它不是)。
- ❌ **不要**在未定案前自行选 UI 的 7 项待定案值 —— 那是主控的决策面。
- ❌ **不要**跑 git push / 改 CI 配置 / 启停 docker(除非主控要求)。
- ❌ **不要**用「单元测试全绿」当作功能已完成的证据。

---

## 九、已完成(勿重做)

| 提交 | 内容 |
|---|---|
| `d3867de` / `2fa39f3` | **权威来源分发改版**:计划书 + 四条底线第 4 条(方案 B)改写;全量退役标注;状态口径统一 |
| `14adf20` | **§五 分发形态设计成文**(四项定案 + 拓扑 + 边界 + 迁移 + 安全论证) |
| `bc91481` / `6c9e4a5` | 五项定案注入 + 传播(含订正「布局快照面非契约面」) |
| `42b83e5` | **启动票据契约设计草案**(六项裁定)+ **D-API-154** |
| `f8f3575` / `b57f955` | 前端改版要求注入需求文档 + 传播(遗留 #38 建立) |
| `bc3481f` / `9cf334f` / `0072f6c` / `c5ca042` / `e822ef6` | 窗高下限 266px、幻影行盒 187→20.8px、Vite watcher 加固、axe 归档、D-API-152 |
| `e8cdc7b` | **WP-90 契约族已落地**(分发改版批次 0):启动票据两份恰两键载荷 + `LAUNCH_TICKET_PROTOCOL_VERSION` / `SUPPORTED_*` / `$id` 命名空间 + 族内形态常量(签发路由 / 换票路径模板 / 查询参数名 / 令牌长度 22)+ 地址与 TTL 数值护栏 + classification 与公开注册表登记 + golden fixture 双向 22 个 + contract-smoke `PROTOCOL_CONTRACTS` 两行 + `docs/contracts/启动票据协议.md` / 数据分类清单 §6.12 / 版本策略 §二 增行与嵌入协议退役标注。⚠ **登记口径(如实)**:WP-90 的**代码与 fixture 文件**因多 agent 共用同一工作树与同一 git index,被同批并发的 WP-91 提交(`e8cdc7b`,`feat(session-api): …`)一并入库 —— **内容完整无误**(`git show --stat e8cdc7b` 可逐文件核实),但该提交的信息只叙述 WP-91;**文档三处随 doc 提交 `581926b` / `e43a185` 入库**。后续在同一工作树并行开工时,提交前必须核对 `git show --stat` 而非只看提交信息 |
| `581926b` / `e43a185` | **WP-90 文档面**:`docs/contracts/启动票据协议.md` 新建(时序 / 两份载荷字段表 / 票据形态与生命周期 / 换票与统一 401 / Redis `launch:{jti}` fail-closed / 攻击面与残留风险 / 关系与已退役面 / 机检 9 条);数据分类清单 §6.12 + §二 两行 + v1.20;版本策略 §二 增族 + 嵌入协议退役标注;README 索引增行 |
| `c8cba90` | **WP-90 第二批(D-LT-5)**:会话动作协议 **v2** —— `create_session` 请求载荷**恰两键** `{challengeId, challengeVersion}`(`embedToken` / `embedSessionId` 退场,授权来源 = 换票产出的启动授权凭证 Cookie);`SESSION_ACTION_PROTOCOL_VERSION = 2` + 窗口期受理集合 `[2, 1]` + `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION`,契约包同批导出**三份 v1 冻结面**(`CreateSessionRequestPayloadV1Schema` / `SessionCommandRequestV1Schema` / `ActionRequestV1Schema` / `WssFrameV1Schema`;服务端两个注册表在装配期断言「受理集合每版都有 Schema」,缺一即拒绝启动);新增**启动授权凭证 claims** `LaunchGrantClaims`(恰六字段、无 `sessionId` / `embedSessionId`;server-only 注册表,`$id` 归会话动作协议族);`schema/` 产物重建(会话动作协议族 `$id` 切 `…/session-action/v2`)+ 同族 fixture 全部自洽 + v1 fixture 目录三份 + `launch-grant-claims` 双向 fixture。**同批文档**:`packages/protocol/docs/会话动作协议语义.md` §5.1 / §5.2 / §九、`投影与错误契约语义.md` §5.2、`docs/develop/引擎进程协议.md` §2.2(并登记**不联动递增引擎进程协议版本**的判定依据:`create_session` 命令面引擎零消费、引擎消费的六个 Schema 形状零改动)、数据分类清单 §6.5 / §6.12.1 / v1.21、版本策略 §二「会话动作协议」行改为当前 2、`启动票据协议.md` §四 / §4.1 |
| `e8cdc7b`…`dfcb521` | **WP-91 第一步(后端基础设施)**:Redis 新键域 **`launch:{jti}`** 存储端口 + 内存替身 + **Lua CAS** 原子消费;启动票据面**四个配置键**(TTL / 天花板 / 公开 origin / 签发频率)+ 新限流维度 `launch_ticket_rate`;`redactRequestUrl` 请求日志查询串脱敏(D-LT-3 ⓪)。决策 **D-API-155 ~ D-API-157** |
| `1592565` / `3634311` | **WP-91 第二 / 三步(签发 / 换票 / 消费链 / 退役)**:① 两张版本注册表登记 v1 冻结面,解析结果放宽为形状联合(不把 v1 载荷硬套 v2 形状);② `POST /auth/launch-tickets`(复用 `hostBackendTokenMatches`、白名单锚租户、**导入契约 Schema 零字面量**、题目公开面校验、频率闸;闸序 401 → 404 面未启用 → 400 → 429 → 404 题目 → 201;整段包在既有 `mapDomainFailure` 内 ⇒ 429 / 503 天然冻结形态);③ `GET /app/c/:challengeId/:version?t=` 换票(`Sec-Fetch-Mode: navigate` → 票据形态 → **Lua CAS 消费** → 绑定逐字比对 → **签发起动授权凭证** → `Set-Cookie` → **302 干净路径** + `no-store` + `no-referrer`;**不建会话、不调 `issueSessionCredential`**);④ `create_session` v2 消费链(新键域 `launchGrant:{jti}` GETDEL 单次消费;身份只由「签名 claims × 签发记录」派生;payload 仅导航且逐字校验,不一致 = 401);⑤ **装配四处同改**并**顺带修复 D-API-156 缺陷 1**(`index.ts` 补传 `hostScoresRoutes` ⇒ 生产 `GET /host/scores` 恢复挂载);⑥ `/auth/embed-tokens` 端点退役(v1 分支函数保留,物理删除归 WP-96)。**机检 9 条**落 `test/launch/launch-routes.test.ts`(19 例)+ 真机 Redis 原子性版。决策 **D-API-158 ~ D-API-160** |
| `aabcce8` / `2814d26` / `9afee6b` / `7553545` 等 8 个 | **WP-93 + WP-94(UI 改版 A/B)**:布局模型按「**一条有序视图列表 + 勾选 + 焦点**」重写(不变量:每登记类型恰一次无重无漏 / id ≡ 类型键 / 焦点唯一 / **无「隐藏即消失」语义**);`sm-workspace` 整页 `100dvh` + `repeat(2, minmax(452.4px, 1fr))` 两分(**无 gap / 无 border / 无 divider**)+ 右半侧固定 payload(**同一实例**)+ 左半侧视图管理窗口(`<details>` + 原生 checkbox 勾选 + 列表内拖拽 / `Alt+↑↓` 重排)+ `Ctrl+↑↓`(左半侧捕获 + `preventDefault` + **不环绕**)+ 类型名移入视图内左上角(删 `.tab-bar`);`layout-camera.ts` / `layout-divider.ts` 与全部列 / 分隔条 / 相机代码删除;**主题单值化**(21 枚 token 名保留、收敛为终端一套、锚改 `:root` 级缺省;178 处回退值中 162 处删浅色回退、16 处保留并逐条给理由)+ **无豁免的严格回退值机检**;`web-component` 宿主定高链 + 终端单值锚;开发壳整页布局(**遗留 #35 / #37 载体消解**)。**新增两条硬证据**:① 真机几何 harness(4 视口 exit 0);② **模板字面量安全机检**(本次施工被 TS 5.9 scanner「模板注释里的反引号」坑 3 次且单测完全抓不到,现以公开 API 机检并做**红灯自证**) |
| `2300bb3` / `d626149` / 主控轮 | **主控决策面 + 门禁复核**:`docs/develop/decisions-分发改版与UI重设计.md` 建立(**D-UI-1 ~ D-UI-7** 全部裁定 + **D-LT-1 ~ D-LT-5** 与「D-LT-5 实施细化 5a~5d」+ 本次「不做」清单 8 项)并编入 `docs/README.md` 索引;接手入口 §4.0 标注已裁定 |
| `WP-92`(本轮) | **`apps/page-app` + 同源页面托管**:① 新应用包(application build;**不静态依赖 vm-ui** —— 产物经 publicDir 落 `dist/vm-ui/`,运行期按 URL 动态 import,沿用 `plugin-dev` 加载模型);② 引导序列 = 路径解析 → 载产物 → `SessionClient()`(同源相对路径)→ `createSession({challengeId, challengeVersion})` **不带 token**(授权 = 启动授权凭证 Cookie)→ `connect()` → 描述包(失败 = 缺席明示、不阻塞)→ 挂 `<sm-workspace>` + 注入组合根属性;③ 整页 `100dvh` 链 + **禁止 `overflow: hidden`**(会把 `overflow-x` 升格为裁剪 ⇒ 窄屏右半侧不可达);④ session-api 侧 `@fastify/static`(新增配置键 `SESSION_API_PAGE_APP_DIR`,过三道闸)+ **`wildcard: false` 与注册序双保证**换票路由优先;⑤ 装配四处同改 + **装配路径防漏传源码面机检**;⑥ 测试:page-app 单测 23 例 + **真机冒烟 5 例**(真 chromium + 真 vm-ui 产物)+ 托管/优先级集成 8 例。决策 **D-API-161**;**未做**:真后端全链冒烟(本机 Docker 不可达)与 k6 / compose 链路改写,承接方 = **WP-95** |

| `WP-95`(本轮) | **门禁改造**:① **几何护栏升级为真浏览器 E2E**(`apps/page-app/e2e/geometry-guard.spec.ts`;承接 **遗留 #33**;逐条断言 **D-UI-2 四条**,四视口 × 三引擎 **27 例**;**不断言任何常量算式** —— 已废止的 `MIN_ROW_HEIGHT_PX` / `columnMinHeightPx` / `columnChromePx` 不在断言里,`layout-presets.ts` 的高度面常量也不被引用;含**反例自证**实测三条);**护栏首跑即抓出真实缺口**:字节视图**完整可见数据行**在窄档为 **0**(chromium 1024×768 / 768×900;firefox 同两档;webkit 1024 / 768 / 375),**N ≥ 1 红线在 9/12 个「引擎 × 视口」格上不成立**,成因 = 列头行窄档折 4 行(21.8 → **84.2px**)+ 工具区换行 ⇒ chrome(≈296~410px)超过视图位高(267~350px);缺口以 `<引擎>:<视口>` 登记表留档 + 双层层「状态已变即红」机检,**修法在 `packages/vm-ui`(本 WP 不改产品代码)**;② **E2E 改页面分发** = `apps/page-app/e2e/{helpers/launch-chain.ts,launch-chain.spec.ts}`(`POST /auth/launch-tickets` → **顶层导航** `page.goto(launchUrl)` → 断言 302 后地址栏无 `?t=` → `connection-status=connected`;含票据单次消费 = 401);plugin-dev 侧新建同链夹具 + **`e2e/RETIRED-SURFACE.md`**(逐文件:可改 / 改不动 + 理由 + 承接方;可改而未改的理由 = **本机 Docker 不可达 ⇒ 无法实测**);③ **axe 面矩阵重定义**(`apps/page-app/e2e/axe-matrix.spec.ts` **9 面** = 1440×{default,list-open,instruction,payload} / 1024×{default,list-open} / 768×default / 375×{default,payload};归档 `apps/page-app/e2e/reports/axe/<日期>/<run-N>/`,**同日不覆盖** + **确定性规范化**(剥 `esid` / Lit 标记 / 键排序 / LF)+ `summary.md` **两栏分列** + **未扫描面清单**;9 面 **violations = 0**,但 **9 面全部含 `color-contrast` 的 incomplete**(62 ~ 132 节点/面,合计 839)**如实分列** —— 单主题下 axe 无法自动判定全部对比度);④ **`E2E_MATRIX` 三引擎挂到 page-app**(plugin-dev 保留一份):**本机实测三引擎**(整套 **51 passed / 24 skipped**),但 **#1 不得记为已修复**(载体退役的验证,结案归 WP-97);⑤ 遗留 **#20** 断言收紧(`toBeInViewport({ratio:0.9})` + 锚点行行高 ≤ 28px)。决策 **D-API-162 ~ D-API-165**;**未实测**:真拓扑启动地址链(`E2E_LAUNCH_CHAIN`)/ 全量 plugin-dev E2E / k6 / `test:compose`(Docker 引擎不可达)、#20 收紧用例 |

| ✅ `WP-95a`(遗留 #39 修复;2026-09-19) | **窄档字节视图完整可见数据行 = 0 的修复**(承接 WP-95 护栏首跑抓出的 P0 产品缺陷):① `byte-tab.ts` 的 VMA 侧栏折叠判定由**视口媒体查询**改为**容器查询**(`@container (max-width: 40rem)`,`:host` 加 `contain` / `container-type: inline-size`)—— 旧写法在 1024 档视口 > 640px 故不折叠,而视图位只有 512px(**媒体查询 vs 容器查询的类别错误**);② `byte-view.ts` 的 `.byte-row` 第三轨 `1fr → minmax(0,1fr)` + 表头行三段 `white-space: nowrap`(列头行 84.19 → **21.8px**);③ 工具区窄档紧凑(`input` 收口 `14ch` / 两行 `nowrap` / `@container` 收紧内边距,工具区 166.3 → **92.3px**)。**真机逐格读数(完整可见数据行,修前 → 修后)**:chromium `4→8 / 0→5 / 0→7 / 1→5`、firefox `7→9 / 0→5 / 0→9 / 1→5`、webkit `6→8 / 0→5 / 0→8 / 0→4`(视口序 1440×900 / 1024×768 / 768×900 / 375×667)⇒ **12/12 格满足红线 `N ≥ 1`,并 12/12 达 `N = 4` 目标**;`KNOWN_GEOMETRY_GAPS` **清空**(登记机制保留);`E2E_MATRIX=1` **51 passed / 24 skipped / 0 failed**;**反例自证** = 红线阈值临时改 9 ⇒ chromium 四档全红且失败文本回读**实测行数**,还原后全绿。**规格改述同批**(D-UI-2 补 / D-UI-5 补):`SIDE_PANEL_MIN_WIDTH_PX` **数值未改**、只改述含义(不含 `14rem` 侧栏;< ≈766px 必有降级 = 已接受的代价);**#36 随之结案**。决策 = **D-API-166**;**未做(不得视为通过)**:axe 面矩阵收尾复跑见 `0cd4780`(9 面 violations = 0,但 9 面**全部**含 `color-contrast` 的 `incomplete`,如实分列)、plugin-dev 全量 E2E、`test:coverage` / `test:miri` / `fuzz:smoke` / `test:compose`(Docker 引擎不可达) |

| ✅ `WP-97`(真机收口;2026-09-28) | **三引擎真机复跑 + 遗留结案判定**(在 WP-96 退役面落地**之后**跑,故本轮读数才是新形态的权威读数):① **`E2E_MATRIX=1 pnpm --filter @stackmaster/page-app test:e2e` = 51 passed / 24 skipped / 0 failed**(exit 0,44.5s);**三引擎逐格** = chromium **23 / 2 / 0**、firefox **14 / 11 / 0**、webkit **14 / 11 / 0**(每引擎 25 例;差额 9 例 = axe 面矩阵为 **chromium 门禁口径**,firefox / webkit 整面 `test.skip`,与 chromium 的 2 例 `launch-chain` 跳过合计恰好 24);**axe 九面**当日归档 `apps/page-app/e2e/reports/axe/2026-09-28/run-1/`(9 面 JSON、violations = 0;`color-contrast` 的 incomplete **两栏分列**口径不变)。② **#1(webkit 跨源认证)载体退役验证 = 口径不变,#1 不得记为「已修复」** —— 新形态三引擎**无引擎特异性失败**(webkit 与原 12 格红面逐格同形),**但矩阵不覆盖握手面**:会话应答由 `page.route("/sessions")` **桩**提供(`page-app.spec.ts:92` / `geometry-guard.spec.ts:236` / `axe-matrix.spec.ts:313`)⇒ **WSS 升级与 Cookie 呈递未发生**,`connection-status=connected` 是页面按桩应答写入的**客户端状态**;握手面唯一载体 = `apps/page-app/e2e/launch-chain.spec.ts`,本机 **Docker 引擎不可达**(2026-09-28 复核:`\\.\pipe\dockerDesktopLinuxEngine` 与 `\\.\pipe\docker_engine` **均不存在**、`docker info` 失败、`127.0.0.1:13000` 的 `/healthz` 与 `/readyz` 均不可达、13000 端口**零监听**)⇒ 带 `E2E_LAUNCH_CHAIN=1` 实跑 = **2 skipped(非通过)**;**新增未实测登记 = 同源形态的 webkit 认证 WSS 握手**。③ **#9** artifact 面已落地(`ci.yml:119-120` job 已切到 page-app + `E2E_MATRIX: "1"` + 归档 `apps/page-app/e2e/reports/axe/**`;本机读数与 job 注释**逐字一致**),**CI 面保持开放**(主控 2026-09-28 指示「不要管 CI」)。④ **#34 / #35 / #37 结案判定**:#34 = **载体消亡 + 触发条件结构性不成立**(真机量 `ul.view-list`:3 引擎 × 2 视口 `scrollHeight ≡ clientHeight` = 234 / 244 / 224、**10 条目恒全可见**、`itemsOutsideListBox = 0`、`itemsOffscreen = 0`;拖拽路径**仍无自动滚动**但「落点在列表之外」有**明示播报** + 键盘等价路径 `Alt+↑↓`)⇒ **结案**,触发条件改写为「`ul.view-list` 成为滚动容器时」;#37 = **已消解且判据已机检化**(`documentElement.scrollHeight ≡ innerHeight` = **900/900**、**667/667**;`.ws-stack` 恒 `scroll > client` = client 449/162~471/232 vs scroll 2449~3232;判据 = `page-app.spec.ts:158` 与 `:174`,**三引擎全绿**);#35 = **载体已物理删除**(`apps/plugin-dev` 不在磁盘、源码面 `.tab-area` **零命中**)。⑤ **#36** 已于 WP-95a 结案(≈766px 升格为 `N = 4` 阈值依据),本轮复核无需重算。**未实测(明文登记,不得视为通过)**:启动地址链真机 E2E(Docker 不可达)/ CI `e2e-matrix` / `test:integration` / `test:compose` / `test:miri` / `fuzz:smoke` / `test:coverage` 完整形态 |

**主控复核的门禁读数(2026-09-18,本机实测,非 lane 自报;用于对标后续 WP)**:`pnpm build` **13/13 ✅**;`pnpm typecheck` **18/18 ✅**;`pnpm lint` **exit 0 ✅**;`lint:deps` **1436 模块 / 4458 依赖零违规 ✅**;`lint:deps:self-test` **20 组边 ✅**;`fixtures:manifest --check` **289 一致 ✅**;`smoke:contract` **24 Schema / 70 接受 / 162 拒绝 / 289 摘要比对 / serde 15 / private-bundle 10 ✅**;`scan:public` **0 违规 / 3 条既有豁免 ✅**;`pnpm test --continue` **25/26**,唯一红 = **`@stackmaster/web-component#test` 1 例** —— 该例断言的是**本包自己发出的 v1 `create_session`(带 `embedToken` / `embedSessionId`)**,属**结构性**(非字面量),随 **WP-96 物理删除该包自然消解**;**不得**为让它变绿而把该包移植到新链(与退役方向相悖)。**未实测(明文登记,不得视为通过)**:`test:integration` / `test:compose`(本机 **Docker 引擎不可达**,`dockerDesktopLinuxEngine` 管道缺失)/ 全量 E2E / `E2E_MATRIX` / `test:coverage` 完整形态 / `test:miri` / `fuzz:smoke`。

**这些已完成项不需要重做;它们对应的「实现」才是待办。**

---

## 十、交接确认清单(开工前自检)

- [ ] 我读了 `CLAUDE.md` 的「在途改版」小节,知道**文档是目标态、磁盘是现状**
- [ ] 我知道**唯一权威来源已修订**(计划书 + 底线第 4 条),不需要再改产品定位
- [ ] 我知道**先契约后实现**,且启动票据是**新契约族**
- [ ] 我知道**可读性纪律**(废止下限 ≠ 放松可读性)与**「宿主」三义项**
- [ ] 我知道**退役 ≠ 现在可删**
- [ ] 我知道动 `docs/phases/` 要**同批维持双射**
- [ ] 我知道**单元绿 ≠ 功能在**,几何类改动**必须真机取证**
- [ ] 我知道本机 `lint:deps` 需放大堆、`test:compose` 不可达(是环境事实,不是「未做」)
