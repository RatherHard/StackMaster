# 分发改版与 UI 重设计 —— 决策登记(主控)

> **状态**:生效中 · **建立** 2026-09-18 · **范围** = `docs/phases/分发改版与UI重设计任务分解与接手入口.md` 的 **WP-90 ~ WP-99**
> **定位**:本文是「接手入口 §4.0 前置定案(P0-决)」与「启动票据契约设计草案 §十二 实施前须补」两处的**主控裁定落地记录**。
> **纪律**:本文只登记**决策**(选定值 + 理由 + 否决项理由);实现事实回填 `CLAUDE.md` 与 `docs/phases/**`。本文**不动**产品定位与四条底线(那些已于 2026-09-18 文档面修订完毕,再改即扩权)。

---

## 〇、编号与依据

| 项 | 编号 | 依据 |
|---|---|---|
| UI 侧 7 项待定案 | **D-UI-1 ~ D-UI-7** | `docs/develop/前端的交互和开发设计.md`「本版待定案」+ 接手入口 §4.0 |
| 分发侧实施前须钉死项 | **D-LT-1 ~ D-LT-4** | `docs/develop/启动票据契约设计草案.md` §十二 + §〇.1 |

**裁决原则**(本文全部条目的共同口径):

1. **不扩权**:范围外的开放遗留(#1 / #21 / #27 / #33 / #36 等)**只登记不顺手改**;
2. **不发明需求**:新需求文本未要求的机制(拖拽中自动滚动、可调分界、窄屏抽屉……)**一律不做**,并写明「本次不做」;
3. **可读性判据换载体但不变松**(接手入口 §3.2):废止下限 ⇒ 改由「左半侧纵向滚动 + 每个视图位有确定高度」满足;**判据仍是「不得出现视图被压到装不下一行字节」**。

---

## 一、UI 侧 7 项待定案(阻塞 WP-93 / WP-94)

### D-UI-1 · 左右两分比例是否可调

- **裁定**:**不可调**;固定 **1 : 1**(`grid-template-columns: 1fr 1fr`),**无分界拖拽手柄**。
- **理由**:① 需求原文只要求「左右两分(紧密贴合,无间隙)」与新需求第 ① 条「无描边、**无分隔条**」——可拖拽分界本身就是一条分隔条,与该条直接冲突;② 新布局把「可压缩以适配」整条移除,可调比例在本版**无承载对象**(比例可调的前提是两侧都能被压缩);③ 固定 1:1 使几何成为常量,几何护栏(WP-95)可断言确定值。
- **否决项**:
  - 「拖拽分界 + 持久化比例」——**否决**:触碰「无分隔条」硬约束,且引入新的持久化面(vm-ui 无 `indexedDB` / `idb-keyval`,不应为此新开);
  - 「固定档(1:1 / 2:1 / 1:2 三档)」——**否决**:需求未要求,且三档需要新的切换入口(菜单已四组定案),属发明需求。
- **回退条件**:若真机取证显示 1:1 下左半侧宽度装不下一行字节(见 D-UI-5 的 452.4px 底线),再行裁定;不得静默改。

### D-UI-2 · 左半侧「上下两半」的视图位数量

- **裁定**:**固定两个可见视图位**(上 / 下),**数量不可配置**。
- **理由**:需求原文逐字为「在**上下两半**显示视图(任一时刻可见**两个视图位**)」——数量由需求文本直接给定;且「固定窗口集 + 无开 / 关状态」(D-MP-1)已把「数量可变」这一维度取消过一次,不应再引入第二个可变维度。
- **可滚动性**:视图类型登记表内**未勾选隐藏的**视图位按顺序**纵向堆叠**,超出两个可见位者由**左半侧纵向滚动**承载(满足可读性纪律:**不压缩,只滚动**)。
- **几何契约(必须机检;由 WP-95 落成 E2E 断言)**:
  1. 左半侧 = **滚动容器**:`scrollHeight > clientHeight` 至少在一个真实视口下成立(证明「溢出由内部滚动承载」而不是压扁);
  2. **每个可见视图位的 `clientHeight` ≥ 一个「面板 chrome + N 行字节」的下限**,**N ≥ 1 为红线,N = 4 为目标**(历史反例 146px vs chrome 182.1px = 连一行都看不见);
  3. 面板 chrome 的取值**不引用**任何已废止的常量(`MIN_ROW_HEIGHT_PX` / `columnMinHeightPx` 均已退场)——实现侧须给出**新常量 + 推导注释**,WP-95 断言该**渲染结果**,不断言算式;
  4. `document.documentElement.scrollHeight ≤ innerHeight + 1`(整页不溢出;溢出不得上浮到文档层)。

### D-UI-3 · `Ctrl + ↑ / ↓` 与浏览器 / OS 快捷键冲突处置

- **裁定**:`Ctrl + ArrowUp` / `Ctrl + ArrowDown` 为**唯一**切换组合键;在**左半侧元素**上以 `keydown` 捕获并 **`preventDefault()`** 覆盖浏览器默认(Ctrl+↑/↓ 的页面滚动)。
  - **作用域**:键盘事件监听落在**左半侧**容器(而非 `window`),避免与 payload 画布 / 输入框内的按键冲突;
  - **不注册**任何 OS 级组合键,不做 `Ctrl+Alt` 等变体;
  - **行为**:把焦点/视图位切换一格(上一 / 下一可见视图位),**边界处不环绕**(到达首 / 末视图位即停,可预期);
  - **原分隔条方向键**(`role="separator"` + 方向键)随分隔条一并**退场**(D-UI-1 已无分隔条)。
- **理由**:需求未要求可重绑定;`preventDefault` 是浏览器内覆盖页面滚动默认行为的标准且足够的手段。

### D-UI-4 · 拖拽落点语义是否保留

- **裁定**:**只保留列表内重排**这一种落点语义(列表项拖拽 = 调整视图在纵向堆叠中的**顺序**);原**三类落点**(同列堆叠 / 跨列移动 / 列间空隙新建列位)**整体废止**(它们依赖列结构,列结构已随 Niri 条带退场)。
- **与遗留 #34 的关系**:#34(拖拽落点出视口即不可达 / 缺拖拽中自动滚动)的**成因载体是「工作区高于宿主视口」**;整页布局下视口 = 浏览器视口,左半侧自身是滚动容器,列表项高度固定且列表很短 ⇒ **本次不实现拖拽中自动滚动**(需求未要求,且无触发场景)。#34 的**结案条件** = WP-97 真机复跑按本裁定重测后判定,不得据「拖拽语义已简化」直接记为已修复。
- **键盘等价路径**:列表项的**勾选**与**上下移动**必须有键盘路径(无障碍基线不得回退,见 D-UI-7)。裁定 = 列表项自身可聚焦,`Space` 切换勾选,`Alt + ↑ / ↓` 在列表内上下移动该条目;焦点顺序 = 视觉顺序。

### D-UI-5 · 响应式 / 窄屏行为

- **裁定**:整页布局**不改变形态**(左半侧 + 右半侧恒同屏);窄屏(视口宽 < 两半侧可读宽之和)时 **左半侧获得 `min-width` 底线,页面横向滚动**。
- **底线取值(有推导,不取裸值)**:左半侧 `min-width = ` **452.4px** —— 该值**不是新发明**,是既有严格推导值 `58ch × 7.8px`(十六进制行不折行的最小可读宽,`packages/vm-ui/src/workspace/layout-presets.ts`)。本次把它**从「列宽下限」改挂为「左半侧宽下限」`:列条带废止 ⇒ 该推导的**载体**由列宽变为左半侧宽。
- **否决项**:
  - 「窄屏隐藏右半侧 / 改为抽屉或 Tab 切换」——**否决**:需求把右半侧定为「**固定**」,隐藏即违反;
  - 「窄屏改为上下堆叠」——**否决**:同上(左右两分是需求形态);
  - 「新增断点阈值表 P0/P1/P2 的替代物」——**否决**:预设阈值表已废止,不应换个名字复活。
- **⚠ 与遗留 #36 的关系(不得当作已解决)**:#36 的**实测约束仍然有效** —— 字节视图自带 `14rem`(224px)侧栏,故「免折行需 ≈766px 视图宽」。#36 的**载体变更**为「左半侧宽度」:**本裁定的 452.4px 是「不折行的十六进制行」底线,不含该 14rem 侧栏**。#36 **不结案**(WP-97 在 WP-95 门禁里按左半侧实际宽度重新核算并登记读数)。

### D-UI-6 · 主题退役后 `--sm-*` token 收敛口径

- **裁定**:**保留全部 21 枚 token 名**,取值收敛为**终端单套**;**删除 light / dark / auto 三套变量记录与预设切换面**(`SM_THEME_PRESET_VALUES` 收敛为 `["terminal"]`;`data-sm-theme` 锚属性与 `SM_THEME_VALUES` 的 `auto` 分支退场;系统跟随 `@media (prefers-color-scheme)` 分支退场)。
- **保留 token 名的理由**:组件侧逐处已是 `var(--sm-*, <字面量回退>)`,**保留名字 = 组件零改动、三步走(改锚 → 改组件 → 删旧值)不必同时进行**;且在 WP-96 退役嵌入协议之前,`EMBED_THEMES` 与 `data-sm-theme` 的**物理删除必须与实现同批**(接手入口 §3.1 第 3 条)。
- **收敛的实质**:ⓐ 变量记录由 3 套降为 1 套;ⓑ **fallback 字面量必须一并改为终端值或删除** —— 否则「终端单主题」在 token 缺失时会静默回落成浅色(这类「看起来生效」的失败模式正是本仓库反复踩过的坑);ⓒ `--sm-scanline-opacity` / `--sm-caret-blink` / `--sm-canvas-sprite-filter` 在单主题下**取值恒有定义**,不再有「light 下取 0」的口径。
- **否决项**:「删 token 名 + 组件内联终端字面量」——**否决**:会在组件里复制 21 处色值(违反单一来源),且 axe 真机校准面会翻倍。
- **登记义务**:token 键集断言(`test/theming/theme-terminal.test.ts` 的 21 键精确锁定)按单主题重写,不是删除。

### D-UI-7 · 无障碍:地标命名 / 焦点序 / `aria-live` + 列表按钮的键盘路径

- **裁定**:① **视图类型名移入视图内左上角**后,**窗口面板的地标名保持原样**(`sm-workspace` 面板名不动),内层视图 region 名继续带窗口维度(既有 `byte.viewAria` / `instr.viewAria` / `vma.ariaScoped` 口径保留)——即**不因标题栏消失而改名**,避免二次 axe 地标重名回归;
  ② **无边框不改变语义结构**:每个视图位仍是独立面板/region,相邻贴合只由几何形成,**不得**用 `role="presentation"` / `aria-hidden` 简化掉视图位;
  ③ **列表按钮键盘路径**(见 D-UI-4):展开 / 收起可聚焦(`aria-expanded`),条目可聚焦,`Space` 勾选,`Alt + ↑/↓` 移动;`aria-live="polite"` 播报「已显示 / 已隐藏 / 已移动到第 N 位」;
  ④ **axe 真机基线不得回退**:WP-95 按**新面集合**重跑,`violations = 0`;若某面在单主题下**无法自动判定**(`incomplete`),按遗留 #14 口径**如实分列**,不得写成「正向通过」。
- **原口径保留**:`role="log"` 误用与地标重名两类历史违规的修法**不得回退**(M1 已修:去掉 `role="log"`、保留 `aria-live="polite"`、内层 region 名带窗口维度)。

---

## 二、分发侧实施前须钉死项(启动票据)

> **上层裁定已在位**:`启动票据契约设计草案.md` **§〇.1**(六项全部采纳草案建议)—— D1 = **方案 A**(query + 服务端立即消费 + 302 抹除);TTL 缺省 **300s**、天花板 3600;签发端点 **`POST /auth/launch-tickets`**、限流缺省 **60/min**、天花板 100000;不加「换票改 POST + 同站校验」;`/auth/embed-tokens` 与嵌入协议**同批硬切**;不绑定 IP / UA。**下列四项是把 §十二 的开口补死。**

### D-LT-1 · 契约面颗粒度与族边界

- **裁定**:启动票据契约族 = **两份跨边界载荷 Schema**:
  1. **`LaunchTicketRequest`**(`POST /auth/launch-tickets` 请求体,**恰两键** `challengeId` / `version`,strictObject);
  2. **`LaunchTicketResponse`**(签发响应体,**恰两键** `launchUrl` / `expiresAt`)。
- **票据令牌本身不在契约包内**:票据值 = **≥128 bit CSPRNG 的 base64url(22 字符)不透明串**,其「绑定字段」由 **Redis `launch:{jti}` 服务端写入**承载,**不签发、不解析 claims** ⇒ **不新增 claims Schema**(与 `EmbedTokenClaims` 不同:后者是签名载荷、需跨语言校验;本票据是不透明持有证明)。
- **版本面**:新增 **`LAUNCH_TICKET_PROTOCOL_VERSION = 1`** + `SUPPORTED_LAUNCH_TICKET_PROTOCOL_VERSIONS` + `LAUNCH_TICKET_SCHEMA_BASE_ID = https://stackmaster.dev/schemas/launch-ticket/v1`;**`$id` 命名空间独立**,`schema/registry.ts` 与 `docs/contracts/版本策略.md` §二 **同批**登记(WP-78 的缺口教训:代码常量 / 命名空间 / 版本表三者必须齐备)。
- **不做**:签发请求 / 响应**不携带 `protocolVersion` 字段**(沿 `HostScoresResponse` / `VerdictQueryResponse` 先例:N-1 受理是**路由级事实**,回显版本判定细节即扩大探测面;契约版本由 `$id` 命名空间承载)。

### D-LT-2 · 票据形态、有效期与单次消费的落地取值

| 项 | 裁定值 | 落地要点 |
|---|---|---|
| 承载 | **URL query**(`?t=<ticket>`) | D1 = A;服务端消费后 **302** 抹除 |
| 熵 / 编码 | **≥128 bit CSPRNG**,**base64url 22 字符** | 生成器 = 域内单一函数;长度上限 ≈ 128 字符(护栏) |
| 有效期 | **缺省 300 s**,配置键 `SESSION_API_LAUNCH_TICKET_TTL_SECONDS`,**天花板 3600**;非正 / 超限即拒绝启动(三道闸同既有配置键纪律) | Redis TTL **同值**;响应回 `expiresAt`(Unix epoch 秒) |
| 单次消费 | **Redis Lua CAS 原子消费**(先消费成功 → 再签发凭证;失败不留半态) | 消费即删除;Redis 不可用 ⇒ **503 `store_unavailable`,fail-closed 不降级** |
| 绑定 | `(tenantId, challengeId, version, expiresAt)` 逐字段校验 | **不绑定 IP / UA**(§〇.1 第 6 项);不在 `launchUrl` 内暴露 tenantId |
| 换票路由 | `GET /app/c/:challengeId/:version?t=<ticket>` | ⓪ `Sec-Fetch-Mode: navigate`;① 存在且未过期;② 未消费;③ 绑定逐字一致 ⇒ 任一不满足 = **401 统一形态** |
| 幂等 | **不幂等**(单次消费即设计);重复打开 = 401 + 「地址已失效,请向平台重新获取」 | — |

### D-LT-3 · 日志 / Referer / 浏览器历史的处置(实施范围)

- **裁定**:⓪ 换票路由与签发端点**必须**走**查询串脱敏**(查询串中的票据字段一律不落日志);① 换票响应与页面响应**必须**带 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`;② **反代侧脱敏为运维硬要求**,写入部署指南,但**本仓库不给未实测的配置片段**(遵 D-API-138 纪律);③ **机检**:应用侧「零票据落日志」必须有机器断言(不得只靠注释)。
- **不做**:**不**把票据写进 PG / 审计账 / 指标标签(草案 §五末);`launch:` 键域**禁止** `KEYS` 类全扫。

### D-LT-4 · 产品定位表述与 `docs/user/**` 回填时机

- **裁定**:用户面文档(`docs/user/**`)**只在 WP-96 退役落地后**回填(WP-98 承接);**在此之前不改** —— 现在改 = 让文档描述不存在的形态。
- **平台后端迁移指引**:`docs/user/宿主平台接入指南.md` 的改写属 **WP-96**,与退役面删除**同批**;WP-91/92 期间只做实现与**设计稿**,不改用户文档。
- **术语纪律(接手入口 §3.3)**:涉及**页面**处**不再使用「宿主」二字**(宿主页面退役);「宿主 / 宿主平台」(服务端集成方)与「宿主代码 / 宿主环境」(底线第 4 条)保留,**一个字都不许改**。

---

## 二·补、D-LT-5 · 换票之后「会话怎么建」——**实现前发现的契约缺口,本项为闭合裁定**

### 缺口(为什么必须新裁一项)

既有链是:**平台后端 `POST /auth/embed-tokens` 取 embed token → 交给浏览器 → 浏览器 `create_session` 携带 token**(三方比对:payload × 签名 claims × 签发存储记录)。

新链换成 **服务端下发地址**(票在 URL 里,浏览器拿到的是凭证 Cookie),于是出现一个**文档面没有回答的问题**:

> 换票成功之后,`create_session` **凭什么授权**?`CreateSessionRequestPayloadSchema` 的 `embedToken` 是**必填**的
> (`packages/protocol/src/session-command/session-command-request.ts:49-62`),而新链里**没有任何东西会交给浏览器一个 embed token**。

⇒ 这是「实现未开工」阶段必然撞上的第一个硬缺口。**必须在写路由之前定案**(否则实现 agent 会各自发明,正是本仓库反复登记的缺陷族)。

### 三个候选与裁定

| 候选 | 做法 | 裁定 |
|---|---|---|
| **A** | 保持冻结面不动:页面服务端在换票后**用 host backend token 自己调 `POST /auth/embed-tokens`** 铸一个绑定 `(tenant, user, challenge, version)` 的 embed token,再交给页面 JS 去 `create_session` | **否决** —— 为了让浏览器重新拿到 token,**必须把 host backend token 下发到浏览器可达面**(或做一条等价的「无鉴权换取」),而那是**全局宿主凭证**(同时保护 `/host/scores` 全租户成绩面)⇒ 触碰安全红线,一票否决。另:这与「浏览器对 token 保持不透明、不由浏览器持有」的既有口径直接冲突 |
| **B** | **换票产出「启动授权凭证」**(绑定 tenant / challenge / version,短时、单次、`Set-Cookie`),`create_session` 改为**以该凭证为授权来源**;`embedToken` 自 payload 退场 | ✅ **采纳** |
| **C** | 换票时服务端**直接建会话**,页面只调 `sync_projection` | 否决 —— 把「打开地址」与「开始做题」两步压成一步,失去「先看题面再开始」的既有形态;且换票语义从「授权」膨胀为「授权 + 建会话」,错误面合流(401 与建会话失败不可分),与「统一 401 三态同形」纪律冲突 |

### D-LT-5 裁定正文

1. **换票产出 = 启动授权凭证**(`Set-Cookie`,`SameSite` 保持既有策略、**同源下可用**;`credentialCookiePath` 沿用既有装配),**不是** embed token,也**不是**会话凭证 —— 它证明的是「这个浏览器被授予了**(tenant, challengeId, version)** 的入场权」,仅此而已。凭证**绑定题目**(与 embed token 的七字段口径同族,但**不是同一契约**:不携带 `embedSessionId`,因为本形态没有嵌入会话)。
2. **`create_session` 的授权来源改为该凭证**,`embedToken` 从 `create_session` payload **退场**。这属**破坏性变更** ⇒ 走契约纪律 5.6 的**正常演进流程**(与嵌入协议面「整体退役」是**两件事**,不得混为一谈):
   - `SESSION_ACTION_PROTOCOL_VERSION` **递增为 2**;`SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS` 在窗口期承载 `[2, 1]`;
   - **先改契约包与 golden fixture → 再改实现**(铁律 1);
   - 服务端**身份派生路径不变**:租户 / 用户 / 题目**只**从「凭证签名 claims × 签发存储记录」派生,payload 只提供**导航信息**(`challengeId` / `challengeVersion`),且必须与凭证绑定**逐字一致**(不一致 = 冻结错误码,不得降级为「以 payload 为准」);
   - 请求体**依旧零身份字段**(硬门槛保持;`strictObject` 即拒)。
3. **`embedSessionId` 的处置**:**保留在凭证 claims 内还是移除,由 WP-91 按「凭证类 Schema 的最小充分字段集」裁决并登记**;倾向**移除**(本形态无嵌入会话,留着会让绑定面出现一个无法解释的字段)。**不得**让它在 payload 里继续必填。
4. **`/auth/embed-tokens` 端点**仍按原裁定**随嵌入协议同批硬切退役**(D-LT-1 不变);本项只改变「谁提供授权」,不改变退役节奏。
5. **`GET /host/scores`(WP-78)与 `SESSION_API_HOST_BACKEND_TOKEN`** 的处置**零改动**(仍只服务平台后端,不下发到浏览器)。
6. **`userId` 无来源 —— 本项一并裁定(侦察取证:全链无来源)**。旧链的 `userId` 由**平台后端在 embed 签发请求体里自报**(`/auth/embed-tokens` 的 body);新链的 `LaunchTicketRequest` **恰两键**,按 D-LT-1 **不得**再加第三键。
   - **裁定**:新增配置键 **`SESSION_API_LAUNCH_USER_ID`**(缺省 `"launch-anon"`,须过配置三道闸:known / schema / 合法冻结标识符),作为**该部署的启动面占位主体**;换票时以它作为 `issueSessionCredential` 的 `userId`。
   - **理由**:① 与既有纪律一致(身份由**服务端配置**派生,**永不**由请求体 / URL 自报);② 不新增表、不新增身份面 —— 本版**没有终端用户账号**这一事实在 §五 已定案(「无终端用户账号」),**不得为了填一个必填字段而伪造一个用户体系**;③ `sessionId` 仍是**逐次唯一**的(会话行),成绩面(`verdicts`)本就以会话为主键,故**成绩可分**、`userId` 只是主体归属占位。
   - **如实登记的后果**:同一部署下所有学习者的 `userId` 相同 ⇒ **`userId` 维度的统计与配额不可分**(租户预算与 `sessionId` 维度不受影响)。这是**显式接受的代价**,登记在此;**不得**在文档或 UI 里把 `userId` 说成「每个学习者」。
   - **否决项**:(a) 给 `LaunchTicketRequest` 加第三键 `userId` —— **否决**:与 D-LT-1「恰两键」及「身份不由客户端自报」冲突;(b) 服务端随机生成 `userId` —— **否决**:不可复现、无审计意义、且会让同一学习者每次入场变成新主体。
7. **审计 kind:本批零新增**(与 WP-82 采集面同口径)。启动票据的签发 / 换票**不新增** `audit_log` kind —— `audit_log` 的 **十值封闭集**有只读冻结断言(`test/audit/audit-kinds.test.ts`),而「票据签发」与既有 `embed_token_issued`(**同为「凭证签发」族**)语义同族 ⇒ 可审计性由**受控日志 + 指标 + 披露点 fail-closed** 承载,**不扩审计账**。若将来合规要求票据事件入库,**须复开本项**并同批改 `src/auth/ports.ts` 集合 + 两处断言 + compose 端断言。

### D-LT-5 实施细化(2026-09-18 补;WP-91 第一步实施后暴露的口径缺口,**逐字按此实现**)

> **背景**:第一步实施中发现原第 1 条存在**内部张力** —— 文中说换票产出「**不是会话凭证**」,但既有唯一可复用的签发函数 `issueSessionCredential`(`apps/session-api/src/auth/consumption.ts:239-267`)**强制要求已存在的会话行**(`SessionCredentialClaimsSchema` 的 `sessionId` 必填)。若照字面「复用会话凭证」,就等于**在换票时建会话** —— 那正是被否决的候选 **C**。故补本节把这条链的**契约形状固定下来**,消除实现 agent 的猜测空间。

**5a. 新增契约:`LaunchGrantClaims`(启动授权凭证的签名载荷)**

| 字段 | 类型 | 说明 |
|---|---|---|
| `tenantId` | 冻结标识符 | 服务端派生(凭证 × 白名单),**永不**来自请求体 / URL |
| `userId` | 冻结标识符 | 服务端配置派生(`SESSION_API_LAUNCH_USER_ID`,缺省 `launch-anon`;见第 6 条) |
| `challengeId` | 冻结标识符 | 公开导航信息,签发时由请求体给出 |
| `challengeVersion` | `X.Y.Z` | 同上 |
| `jti` | 冻结标识符 | **单次消费**键(换票时写 `launchGrant:{jti}`,消费即删 / 置废) |
| `expiresAt` | 非负整数(epoch 秒) | 短时;TTL 与票据同一配置族 |

- **无 `sessionId`、无 `embedSessionId`** —— 这两者的缺失正是「授权凭证 ≠ 会话凭证」的结构性表达;
- 分类 = **BOUNDARY**(载荷本身可穿越浏览器,浏览器**不解析**);解析器**只经 `server-only` 子路径导出**(沿 `EmbedTokenClaims` / `SessionCredentialClaims` 先例);
- `$id` 命名空间归**会话动作协议族**(它与 `create_session` 同族演进),即 `SESSION_ACTION_SCHEMA_BASE_ID`。

**5b. 换票 = 校验 → Lua CAS 消费票据 → 签发起动授权凭证 → `Set-Cookie` → 302**

- **不建会话**(候选 C 已否决);**不调用** `issueSessionCredential`(它留给「已有会话」的既有路径);
- 启动授权凭证的**签发与校验端口** = 新增一对(`issueLaunchGrant` / `consumeLaunchGrant`);实现可复用既有 `TokenSigner` 的签名原语与 `token:{jti}` 的 GETDEL 消费范式,**但键域与端口独立**(`launchGrant:{jti}`),**不得**与 `token:{jti}` 混用。

**5c. `create_session`(v2)消费该凭证**

- 请求体 = 恰两键 `{ challengeId, challengeVersion }`;
- 授权来源 = **启动授权凭证 Cookie**;身份 / 题目绑定由「凭证签名 claims × 凭证签发存储记录」派生;
- payload 的 `challengeId` / `challengeVersion` 必须与凭证 claims **逐字一致**,否则 = 拒绝(`PublicError` 冻结枚举内,**不新增 code**);
- 通过后**才**建会话行(既有的并发预算 / 双包装载 / 超时语义**零改动**),并按既有 `create_session` 响应面回投影;
- 凭证**单次消费**:消费即失效(重放 = 拒绝)。

**5d. 本细化不改变的东西**:换票失败语义仍是**统一 401 三态同形**;`/auth/embed-tokens` 仍**退役**;`/host/scores` 与 `SESSION_API_HOST_BACKEND_TOKEN` **零改动**;审计 kind **零新增**。

### 对既有编号的边界说明(防误读)

- 本项**新增** `D-LT-5`,**不修改** D-LT-1(契约面颗粒度)与 D-LT-2(票据形态);`LaunchTicketRequest` / `LaunchTicketResponse` 两份载荷 Schema **形状不变**;
- 本项**新增的契约工作量** = 会话动作协议 v2(`create_session` payload 变更 + fixture 双向 + 语义文档 §5.1 更新 + 版本策略表行),**再加**启动授权凭证的 claims Schema(视第 3 条裁决而定);
- **WP-90 的范围因此扩大**:不再只是「启动票据两件套」,还包含**会话动作协议 v2 的 create_session 变更**。WP-90 的完成标准**不变**(门禁全绿 + fixture 重算 + smoke:contract),但**读数会变**(Schema 数 / 接受数 / 拒绝数)。

---

## 三、本次「不做」清单(显式登记,不以沉默代替结论)

| # | 项 | 理由 |
|---|---|---|
| 1 | 左右分界拖拽 / 比例可调 | D-UI-1(触碰「无分隔条」) |
| 2 | 视图位数量可配置 | D-UI-2(需求给定两个) |
| 3 | 拖拽中自动滚动 | D-UI-4(需求未要求;整页布局下无触发场景) |
| 4 | 窄屏抽屉 / 上下堆叠 / 隐藏右半侧 | D-UI-5(需求把右半侧定为固定) |
| 5 | 主题切换面(含 `auto` 系统跟随) | D-UI-6(终端单主题) |
| 6 | 票据 claims Schema / 票据签名 | D-LT-1(不透明持有证明,服务端存绑定) |
| 7 | 签发端点 / 换票的 `protocolVersion` 回显字段 | D-LT-1(路由级 N-1 事实) |
| 8 | 并行轨 WP-81a / 84 / 85 / 86 等既有开放遗留 | §〇 裁决原则 1(范围外,只登记不顺手改) |

---

## 四、派生义务(WP-90 ~ WP-99 内的落点)

| # | 义务 | 落点 |
|---|---|---|
| 1 | `packages/protocol` 新增契约族 + fixture(双向)+ `schema/` 产物 + classification 登记 | **WP-90** |
| 2 | `tooling/contract-smoke/src/smoke.rs` 的 `PROTOCOL_CONTRACTS` 增两行(请求 / 响应) | **WP-90** |
| 3 | `docs/contracts/启动票据协议.md` 新建;`数据分类与秘密零驻留清单.md` 增该族字段分类;`版本策略.md` §二 增族 + 嵌入协议退役标注 | **WP-90** |
| 4 | `pnpm fixtures:manifest`(重算)、`pnpm smoke:contract` | **WP-90** |
| 5 | 几何护栏按「不得出现视图压到装不下一行字节」立判据(不得断言已废止的 `MIN_ROW_HEIGHT_PX`) | **WP-95**(承接遗留 **#33**) |
| 6 | 遗留 #34 / #36 / #37 / #1 / #30 / #35 的结案判定按改版重测 | **WP-97**(不得据改版直接记为已修复) |
| 7 | 用户文档回填 | **WP-98** |
| 8 | 遗留清单 / 评审 §六 双射维持 + `CLAUDE.md` 事实段回填 | **WP-99** |

---

## 五、WP-91 实施回填(2026-09-18;**第一步已落地 / 第二步受阻**)

> **本节由 WP-91 实施 agent 追加**,登记**实际落地值 / 偏离 / 受阻**。主控裁定 D-LT-1 ~ D-LT-5 **一条未改**;本节的全部内容都是「按裁定做出来的东西长什么样」+「哪里没做、为什么」。

### 1. 落地范围:分两步执行

WP-91 的任务书要求「先做不依赖 WP-90 契约面的部分」。**执行结果**:

| 步骤 | 范围 | 状态 |
|---|---|---|
| **第一步** | `launch:{jti}` 存储端口 + 内存替身 + Redis Lua CAS、配置键、限流维度、日志脱敏、票据生成器 | ✅ **已落地并全绿**(见下 §2) |
| **第二步** | 签发路由 `POST /auth/launch-tickets`、换票路由 `GET /app/c/:challengeId/:version`、`create_session` 消费链改造、`/auth/embed-tokens` 退役 | ⛔ **未开工**(受阻,见下 §4) |

**未写任何半成品路由**:第二步没有在 `server.ts` / `index.ts` / `runtime.ts` 任一装配点留下占位注册。第一步的成果是**自洽可合入**的:它是键域 + 配置 + 日志三件基础设施,独立于任何路由即有完整语义(有端口契约、有双实现、有测试)。

### 2. 实际落地值(逐项)

**键域**:`launch:{jti}`(第五键域),分级 **fail-closed**;登记于 D-API-24 表 + 计划书 `:427`。消费语义 = **比较并交换(CAS)**,**不是** `token:{jti}` 的 GETDEL —— 两处刻意的语义选择(绑定不符**不消费**;四种「无有效记录」**同形**返回 null)见 D-API-155 的理由。

**配置键 4 个**:`SESSION_API_LAUNCH_TICKET_TTL_SECONDS`(300 / 3600,**引用契约常量**)、`SESSION_API_LAUNCH_USER_ID`(`"launch-anon"`,过 `isFrozenIdentifier`)、`SESSION_API_PUBLIC_ORIGIN`(**缺省 null**)、`SESSION_API_LAUNCH_TICKET_ISSUANCE_PER_MINUTE`(60 / 100000)。四键**均不进 `REQUIRED_ENV_KEYS`**(D-LT-5.6 与 D-LT-2 均未要求必备;`PUBLIC_ORIGIN` 缺失是「该部署不启用签发面」的合法形态)。

**限流维度**:`launch_ticket_rate`(第五值),键 `rate:{锚租户}:launch_tickets`,触顶走既有唯一出口 → 429 逐字节冻结形态,**零新增冻结面**。

**日志脱敏**:`redactRequestUrl(url)` 纯函数 + `req` 序列化器接线。**取值 = 剥离整个查询串**(见 §3 偏离 1)。机检 = **真实装配路径的运行时断言**(主)+ 纯函数单测(辅),共 9 例。

**票据生成器**:`src/launch/ticket-token.ts`,单一模块承载「生成 / 形态校验 / 键派生」三件事。熵 = **16 字节 = 128 bit** ⇒ base64url 无填充**恰 22 字符** = 契约常量 `LAUNCH_TICKET_TOKEN_LENGTH`(17 字节会得 23 字符 —— 实测确认,已在代码注释里记下这条推导,防后人「取大一点更安全」)。

### 3. 偏离(逐条显式列出)

1. **日志脱敏取「剥离整个查询串」而非「只 censor `t`」** —— 任务书两种都允许(「剥离 query 或对 `t` 参数做 censor」)。选整体剥离的理由 = **参数名漂移免疫**;代价(丢失查询串诊断信息)如实登记在代码注释与 D-API-155。**机检两层都写**,其中「秘密挂在任意参数名下都被剥离」有专门用例。
2. **新增了第 4 个配置键 `SESSION_API_LAUNCH_TICKET_ISSUANCE_PER_MINUTE`** —— 任务书的「配置键改 5 处」清单只列了 3 个键,但 §A 同时给出了限流「缺省 60/min、天花板 100000」两个数值;按本仓库「常量默认值 + 配置天花板双闸」的统一形态,这两个数值必须有落点,否则只能硬编码。**登记为增补**,键名沿 `SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE` 先例。
3. **`SESSION_API_PUBLIC_ORIGIN` 的形态闸比 CORS 白名单更严**:新增 `isLaunchPublicOrigin` = 共用 `isExactOrigin` + 显式拒 `*`。**原因是一个实测出来的既有缺陷**(见 §5 缺陷 2)。**只加严、不改共用函数**。
4. **未实现「换票时就建会话 + 发会话凭证」**(任务书 §B 的字面写法)—— 理由见 §4,**这是本次最重要的偏离**。

### 4. 受阻:第二步为何未开工(**岔路裁定与本 agent 的选择**)

**岔路**:任务书 §B 的字面要求是「换票 = `manager.createSession(...)` + **复用 `issueSessionCredential` 发会话凭证**」;而主控裁定 **D-LT-5 第 1 条逐字规定**「换票产出 = **启动授权凭证**……**不是会话凭证**」,且 D-LT-5 的候选表里 **候选 C(换票时服务端直接建会话)已被明确否决**(理由:把「打开地址」与「开始做题」压成一步;换票语义从「授权」膨胀为「授权 + 建会话」,401 与建会话失败不可分,与「统一 401 三态同形」纪律冲突)。两者**不能同时成立**。

**本 agent 的选择 = 遵守 D-LT-5**(任务书亦明示「D-LT-1 ~ D-LT-5 是主控裁定,逐字遵守」)。⇒ 换票路由必须签发**启动授权凭证**,而它需要:

1. 一份**新的 claims Schema**(绑定 `(tenantId, challengeId, version)`,**不含** `sessionId`、**不含** `embedSessionId`)—— 按 D-LT-5「对既有编号的边界说明」,它**属于 WP-90 的契约工作量**(原文:「本项新增的契约工作量 = 会话动作协议 v2……**再加**启动授权凭证的 claims Schema」);
2. **会话动作协议 v2**(`SESSION_ACTION_PROTOCOL_VERSION` → 2、`create_session` payload 收为恰两键 `{challengeId, challengeVersion}`、`embedToken` / `embedSessionId` 退场)。

**实测取证(截至本回填)**:`packages/protocol/src/` 工作树**只有** `launch-ticket/` 三文件(两份载荷 + 形态常量)与 `limits.ts` / `version.ts` / `classification.ts` / `registry.ts` / `index.ts` 的对应改动;**没有**启动授权凭证 claims Schema;**`session-command-request.ts` 的 `CreateSessionRequestPayloadSchema` 仍是四键**(`challengeId` / `challengeVersion` / `embedSessionId` / `embedToken`),`SESSION_ACTION_PROTOCOL_VERSION` **仍为 1**;`packages/protocol/dist/` **不含** `launch-ticket/`(该族尚未提交,`dist` 为旧产物)。⇒ **WP-90 未落地第二步所需的两项契约**。

**为什么不自行绕过**(三条路都被堵死):
- ❌ **在 session-api 里抄一份启动授权凭证 Schema**:直接违反任务书「**不得**自己在 session-api 里抄一份 Schema 字面量(违反契约单一来源)」与契约纪律 5.6;
- ❌ **退回任务书 §B 的会话凭证写法**:等于**复活被否决的候选 C**,且让 `create_session` 的角色变成「回读既有会话」——那是**发明第三种协议**,任务书明令禁止(「不要自行发明第三种协议。宁可不做,不可做错」);
- ❌ **先发一个「空凭证」占位**:会造出一个语义未定的凭证面,**比不做更坏**(一旦有人依赖它,协议就被冻结在错误形态上)。

**结论(自洽性)**:第一步**完全自洽**(键域 / 配置 / 日志三件套不依赖任何第二步契约);第二步**不自洽** —— 它在 WP-90 落地前**无法收口**。⇒ **按任务书的要求停下来登记岔路与推荐,不硬做**。

**给主控的建议**:第二步的开工前置 = WP-90 补齐 ①启动授权凭证 claims Schema ②会话动作协议 v2(含 golden fixture 与 `smoke:contract` 读数更新)。前置满足后,第二步的实现路径**已经清晰**,无需再裁定:换票 = `Sec-Fetch-Mode: navigate` → 票据存在未过期 → **Lua CAS 原子消费** → 路径字段与绑定逐字比对 → **签发起动授权凭证(Set-Cookie)** → **302 到不含票据的干净路径** + `Cache-Control: no-store` + `Referrer-Policy: no-referrer`;`create_session` v2 = 以凭证为唯一授权来源、payload 只提供导航信息且必须与凭证绑定逐字一致。

### 5. 侦察中发现的既有缺陷(只登记,未修;详见 D-API-156)

1. **`hostScoresRoutes` 生产未挂载**:`src/index.ts:26-40` **未传** `hostScoresRoutes`,而 `server.ts:170` 仅非 undefined 才注册 ⇒ **生产 `GET /host/scores` 从未挂载**(WP-78 交付面在生产不可用);测试夹具传了 ⇒ 测试全绿。**与 WP-76 `debugChannel` 漏传同一缺陷族**。**未修**(范围外,一行修复,建议单独立项)。
2. **`isExactOrigin` 不真的禁通配**(注释与实现对不上,实测 `https://*.example.com` 被判合法)。影响 CORS 白名单(无实际危害)。**未改共用函数**(会改变既有配置面受理范围),WP-91 只在自己的键上加严。

### 6. 审计 kind 与冻结面(逐条确认零新增)

- **审计 kind 十值封闭集未动**(D-LT-5.7):第一步**零 `audit_log` 写入**、零新增 kind;受控日志 + 指标承载。
- **零新增冻结错误面**:未新增任何 `PublicError` 常量;第一步不产生任何响应面。
- **投影脱敏零改动**;**未触碰** `packages/embed-runtime` / `react-wrapper` / `web-component` / `docs/contracts/嵌入协议.md` / `apps/plugin-dev`;**未改** `docs/user/**`;**未改** `docs/phases/**`。

---

## 五、实施回填(2026-09-18;WP-93 / WP-94 落地登记)

> **性质**:本节是**实施回填**(实际落地值 + 偏离),不改任何裁定。裁定正文见 §一(D-UI-1~7)与 §二(D-LT-1~4)。
> **落地范围**:`packages/vm-ui`(模型 / 工作区组件 / 菜单 / 主题 / i18n / 测试 / 几何 harness)、`packages/web-component`(宿主定高链 + 终端单值锚)、`apps/plugin-dev`(开发壳整页布局 + E2E)。

### 5.1 逐条兑现(裁定 → 落地)

| 裁定 | 落地值 / 载体 |
|---|---|
| **D-UI-1** 固定 1:1、不可调、无分界手柄 | `packages/vm-ui/src/workspace/sm-workspace.ts` 的 `.ws-body { display: grid; grid-template-columns: repeat(2, minmax(452.4px, 1fr)) }`;**无 gap / 无 border / 无 divider**;**无**任何分界拖拽代码。**偏离说明(见 5.3 ①)**:两轨写法由 `1fr 1fr` 改为 `repeat(2, minmax(452.4px, 1fr))`,理由 = 纯 `1fr` 在 768px 视口下右半侧会被压到 316px(低于 D-UI-5 底线);宽视口下两者**等价**(严格等分)。 |
| **D-UI-2** 固定两个可见视图位、数量不可配置 | 常量 `VISIBLE_VIEW_SLOT_COUNT = 2`;视图位在 `.ws-stack` 内**纵向堆叠**、高度由 `viewSlotHeightPx(leftRoleHeightPx)` **内联为像素**(= 等分左半侧可视高,**下限 = chrome + 4 行**);空间不足**只滚动、不压缩**。落地算式:`视位高 = max(floor((左半侧可视高 − 列表按钮高 − 留白) ÷ 2), ceil(chrome + 4 × 20.8))`。 |
| **D-UI-3** `Ctrl+↑/↓` 唯一、左半侧捕获、`preventDefault`、不环绕 | 监听落在 `.ws-left`(`@keydown`);`preventDefault()` 无条件调用;`stepActiveView(delta, isEligible)` **边界不环绕**(到首 / 末即 no-op);当前视图名经常驻 `role="status"` 宣读。**补充口径(见 5.3 ②)**:切换域 = **左半侧渲染集**(排除固定承载于右半侧的 payload)。 |
| **D-UI-4** 只保留列表内重排 + 键盘等价路径 | 列表项 `<li class="view-list-item" data-view-type data-view-index tabindex="0">` + 原生 `<input type="checkbox">`;`Alt+↑/↓` 移动条目(`preventDefault`);pointer 拖拽落点 = **列表内目标位置**(静态 class `drop-before` / `drop-after`);原三类 Niri 落点代码整条删除。**不实现拖拽中自动滚动**(与裁定一致)。 |
| **D-UI-5** 窄屏不改变形态、左半侧 `min-width = 452.4px`、页面横向滚动 | `.ws-left { min-inline-size: 452.4px }` + `.ws-body` 的 `minmax(452.4px, 1fr)` ⇒ 网格宽超出视口 ⇒ **文档层横向滚动**。**关键落地条件(见 5.3 ③)**:`sm-workspace :host`、`.tab-area`、harness 的 `html/body` **一律不得给 `overflow: hidden`**(隐藏会把 `overflow-x` 升格为裁剪,内容宽不上浮到文档层 ⇒ 右半侧不可达)。真机读数见 5.4。 |
| **D-UI-6** 保留 21 枚 token 名、收敛为终端一套、删除 light/dark/auto | `SM_THEME_PRESET_VALUES = ["terminal"]`;`SM_THEME_VALUES = ["terminal"]`(无 `auto`);`SM_THEME_VARIABLES` 单套 21 枚;锚样式表 = **`:root` 级缺省(未设锚即终端)+ 单一 `[data-sm-theme="terminal"]` 锚(同值)**。回退值处置见 5.5。 |
| **D-UI-7** 地标名不变、内层 region 保留窗口维度、列表按钮键盘路径、axe 基线不回退 | 面板 `aria-label=${title}` **逐字保留**;`.view-label` 为面板内第一个元素(非独立标题栏);列表按钮 `<details>/<summary>` + 条目可聚焦 + `aria-live="polite"` 播报;**左半侧不再渲染 payload 视图位**(见 5.3 ④)⇒ `landmark-unique` 恢复零违规。 |
| §二 D-LT-* | **本批未动**(启动票据 / 分发侧属 WP-90~92,另一轨)。 |

### 5.2 废止面清点(确认「整条退出、不留兼容别名」)

| 废止面 | 处置 |
|---|---|
| 列的有序序列 / 列间水平滚动 / 列内二叉分割 | 模型层与渲染层整条删除(`columns` / `tabIds` / `widthRatio` / `rowHeights` / `viewportWidth` 全部不再存在) |
| 视口宽预设 P0 / P1 / P2 + `WIDE_MIN_PX` / `NARROW_MAX_PX` 档位判定 + `selectLayoutPreset` / `layoutPresetById` / `LayoutPresetId` / `LAYOUT_PRESETS` | 删除;机检断言其**不再导出**(`test/workspace/layout-presets.test.ts`) |
| 列宽五档 `COLUMN_WIDTH_PRESETS` | 删除 |
| 列间 / 窗间分隔条(`role="separator"` + 方向键) | 删除(`layout-divider.ts` 整文件删除) |
| 三类拖拽落点(同列堆叠 / 跨列移动 / 列间空隙新建列位) | 删除(**只保留列表内重排**) |
| 「重置布局」 | 删除;新语义 = 「**重置视图**」=`resetViews()`(恢复默认顺序 + 全选) |
| 焦点列居中相机 | 删除(`layout-camera.ts` 整文件删除) |
| 窗高下限 `MIN_ROW_HEIGHT_PX` / `columnMinHeightPx` / `columnChromePx` / 拖拽像素语义 | 删除;**D-API-152 条目本身作为历史决策保留在案** |
| `content-visibility` 视口外降级渲染 | **保留**(`data-render-degrade="content-visibility"` 标记面保留) |
| `prefers-reduced-motion` 降级 | **保留**;降级对象改为**左半侧丝滑滚动动画**(`.ws-stack { scroll-behavior: smooth }` → reduce 下 `auto`) |
| `MIN_COLUMN_WIDTH` / `HEX_ROW_MIN_CHARS` / `MONOSPACE_CHAR_WIDTH_PX` 推导值 | **保留**;载体改为**左半侧宽度底线**(`SIDE_PANEL_MIN_WIDTH_PX = MIN_COLUMN_WIDTH`)。**遗留 #36 不结案**(该推导**不含**字节视图自带的 `14rem` 侧栏;免折行实测仍需 ≈766px 视图宽)。 |

### 5.3 实际落地中的**偏离与裁定外补充**(逐条给证据)

1. **`.ws-body` 两轨写法**:`1fr 1fr` → `repeat(2, minmax(SIDE_PANEL_MIN_WIDTH_PX, 1fr))`。
   **理由**:D-UI-5 要求「窄屏左半侧获得 min-width 底线、页面横向滚动」。纯 `1fr 1fr` 在 768px 视口下把右半侧压到 316px(< 452.4px),与「两半侧都要可读」的裁定前提冲突。
   **证据**:真机 768×900 ⇒ `left/right = 452/452`,`documentScrollWidth = 905 > innerWidth 768`。
2. **`Ctrl+↑/↓` 切换域 = 左半侧渲染集(不含 payload)**。裁定原文只说「切换一个可见视图位」,未定义「可见」是否含固定承载于右半侧的 payload。落地取「与左半侧渲染集一致」(9 项)——否则会停在「左半侧没有对应视图位」的视图上(状态行宣读它但界面无变化)。
   **实现**:`stepActiveView(delta, isEligible?)` / `setActiveView(type, isEligible?)` 新增**可选**过滤回调(模型自身零 payload 字面量)。
3. **`overflow` 纪律(裁定外的新增硬约束,但为 D-UI-5 的必要条件)**:`sm-workspace :host` / `.ws-body` / `.tab-area` / E2E harness 的 `html,body` **一律 `overflow: visible`**。
   **理由**:实测发现 `overflow-y: hidden` 会把 `overflow-x` 升格为 `auto`/裁剪 ⇒ body 自己成为裁剪容器、内容宽**不上浮到文档层** ⇒ `documentElement.scrollWidth` 停在视口宽、**右半侧不可达**(实测 375px 视口下 `docScrollWidth=375` 而工作区网格宽 905)。这不是可选项,而是 D-UI-5 的承载条件。
4. **左半侧不渲染 payload 视图位**(裁定 A)。裁定未明说,但需求原文把右半侧定为「payload 搭建窗口(**固定**)」⇒ 左半侧 = 管理**其他**视图的窗口。
   **证据**:修复前真机/单测均观测到两个缺陷 —— ①同一内容元素被两处 ChildPart 争夺(后提交的右半侧赢得节点,左半侧留**空面板**);②axe `landmark-unique` **真违规**(`.ws-left` 内 payload 面板与 `.ws-right` 同名)。修复后 `landmark` 用例与 axe 面恢复零违规。
   **模型层不动**:payload 仍在登记集合内、`visible` 标志保留(列表按钮仍可勾选)——**D-MP-1「全部常驻」不破**。
5. **「视图位高度测量补正」**:`render()` 读的是**上一帧**几何,而首帧 `.ws-left` 尚不存在 ⇒ 首帧只能用 `window.innerHeight` 估算。新增 `updated()` 里的测量补正(测得值与上次算式输入不同才补一次渲染,防渲染循环)。
   **证据**:修复前 4 个视口下视图位高度一律 = 423px(首帧估算值),与 `stackClientHeight`(709 / 571 / 703 / 470)不符;修复后逐视口正确。
6. **字节视图高度链修复**(整页布局的连带必要项,属既有缺陷):`sm-byte-view :host` 原为**固定** `block-size: 24rem`(384px)⇒ ①高视口下视图位装不下更多行;②窄屏工具区换行长高时数据区被压到 **0~1 行**(`content-visibility` 的 `contain-intrinsic-size` 让面板内容按估算高排布)。落地:**`block-size: 100%`**;窗口化列表加**可读性地板**(`flex-shrink: 0` + `min-block-size = 4 行` + `max-block-size: 100%`);`.byte-view` 承担滚动(`overflow-y: auto`)。
   **证据**:修复前 768 宽档 `listClientHeight = 47px`(1 行)、1024 档 `104px`、1440 档 `196px`;修复后四档一律 `≥ 83.2px`(4 行地板)。
7. **模板字面量注释里不得出现反引号**(新增机检纪律)。TypeScript 5.9 的 scanner 会把 `css`/`html` 模板字面量**内部注释**里的反引号当成模板定界符 ⇒ 整个文件解析崩塌,而**单测根本跑不到**(整包 import 即失败)。本次施工中出现 **3 次**(`sm-workspace.ts` ×2、`byte-view.ts` ×1)。
   **机检**:`packages/vm-ui/test/render/template-literal-safety.test.ts` —— 对 `src/**` 与 `test/**` 每个 `.ts` 跑公开 API `ts.transpileModule({ reportDiagnostics: true })` 并断言零诊断;**红灯自证已实测**(临时在 `byte-view.ts` 注释里加回一对反引号 ⇒ 该用例变红并报 `byte-view.ts:657: ';' expected.`;还原后转绿)。
   模板字面量**外部**的注释(文件头 JSDoc 等)里的反引号**无害**,不在机检范围(与纪律一致)。

### 5.4 真机几何读数(必需证据;chromium,可复跑)

**入口**:`node packages/vm-ui/test/geometry/measure-workspace-geometry.cjs`(harness = `test/geometry/workspace-harness.html` + `mount-workspace.mjs`,整页骨架 `html/body` 不裁剪 + 工作区 `100dvh`;**本次实测 exit 0**)。

| 视口 | 左/右 clientWidth | 水平间隙 | 视图位 clientHeight | 字节列表可视高 | 左半侧 stack(client/scroll) | 文档纵向溢出 | 文档横向溢出 |
|---|---|---|---|---|---|---|---|
| 1440×900 | **720 / 720** | **0px** | 349px | 162px(≈7.8 行) | **709 / 3205** | **0px** | 0px |
| 1024×768 | **512 / 512** | **0px** | 280px | 83px(4 行地板) | **571 / 2584** | **0px** | 0px |
| 768×900 | **452 / 452** | **0px** | 346px | 83px(4 行地板) | **703 / 3178** | **0px** | **+137px(页面横向滚动)** |
| 375×667 | **452 / 452** | **0px** | 265px | 83px(4 行地板) | **470 / 2449** | **0px** | **+530px(页面横向滚动)** |

- **D-UI-1**:左右严格 1:1(Δ=0)、水平间隙 **0px**、`column-gap: normal`、无 border(四档全绿)。
- **D-UI-2 / 可读性判据**:视图位高度下限 = `ceil(chrome + 4 × 20.8)` = **264px**,四档实测 265 / 280 / 346 / 349 **全部达标**;字节列表可视高 **≥ 83.2px(4 行地板)** 四档全达标;字节视图**渲染数据行 16 行**。
- **遗留 #37 消解证据**:四档 `documentElement.scrollHeight ≤ innerHeight + 1`(**纵向溢出 0px**),而左半侧 `scrollHeight > clientHeight`(**它是滚动容器**)——「溢出由左半侧内部滚动承载、不上浮到文档层」成立。
- **D-UI-5 证据**:窄档(768 / 375)两半侧各 452px ⇒ 网格 905px > 视口 ⇒ 文档层横向可滚(`+137` / `+530`),右半侧**可达**。

### 5.5 主题回退值处置(D-UI-6 ⓑ 的落地账)

`packages/vm-ui/src/**` 共扫出 **178** 处 `var(--sm-*, <回退>)`;**改动 162 处**(删除浅色回退值);**保留 16 处**,逐类理由:

| 保留类 | 处数 | 理由 |
|---|---|---|
| `var(--sm-font-mono, <SM_MONO_FONT_STACK>)` | 13 | 回退值**逐字等于**终端字体栈;且 `test/theming/theme.test.ts` 的「字体栈回退值一致性」机检要求 `checked > 0`(防 19 处副本各自漂移)——删光会让该机检失去语料 |
| `--sm-scanline-opacity, 0` / `--sm-caret-blink, 0s` / `--sm-canvas-sprite-filter, none` | 3 | **非颜色中性值**,不产生浅色回落;且删除会让动画声明在自定义属性缺席时按无效值处理(动画立即生效 / 闪烁) |

**新机检(严格、无豁免)**:`test/theming/theme.test.ts` 断言每个 `var(--sm-*, <回退>)` 的回退值**必须**为「省略 / 逐字等于该 token 终端值 / `none`|`0`|`0s`」之一;系统颜色关键词与 `rgb(0 0 0 …)` 一律红。

### 5.6 门禁读数(真实;执行于 2026-09-18)

| 命令 | 读数 |
|---|---|
| `pnpm --filter @stackmaster/vm-ui build` | exit 0(`dist/sm-workspace-*.js` 413.82 kB / gzip 106.38 kB) |
| `pnpm --filter @stackmaster/vm-ui typecheck` | **exit 0** |
| `pnpm --filter @stackmaster/vm-ui test` | **69 passed / 1 failed files;843 passed / 4 failed tests** —— 唯一红点 = `test/client/session-client.test.ts` 4 例,**属并行协议 v2 轨**(`c8cba90 feat(protocol): 会话动作协议 v2`),非本次改动面 |
| `test/workspace` 定向 | **15 files / 206 tests 全绿** |
| `pnpm --filter @stackmaster/web-component build` / `test` / `typecheck` | **exit 0** / **9 files 80 tests 全绿** / **exit 0** |
| `pnpm --filter @stackmaster/plugin-dev build` / `test` / `typecheck` | **exit 0** / **2 files 28 tests 全绿** / **exit 0** |
| `pnpm build` | **13/13 tasks exit 0** |
| `pnpm typecheck` | 17/18 pass;唯一红 = `@stackmaster/session-api`(`session-routes.ts` 的 `payload` 类型)——**并行协议 v2 轨** |
| `pnpm lint` | 唯一红 = `apps/session-api/test/wss/channel.integration.test.ts` 未用导入 —— **并行轨**;本次改动面 **0 违规** |
| `$env:NODE_OPTIONS='--max-old-space-size=12288'; pnpm lint:deps` | **exit 0**(依赖方向未破) |
| `pnpm scan:public` | **exit 0** |
| 真机几何 | **exit 0**(4 视口全绿,读数见 5.4) |

**未实测(明文登记,不得视为通过)**:`pnpm test`(根聚合,含并行轨红点)、全量 E2E / axe 面矩阵、`E2E_MATRIX`、`test:compose` / `test:coverage` 完整形态、`test:miri` / `fuzz:smoke`。
**E2E 未跑的原因**:本机 **Docker 不可用**(`docker ps` 报无法连接 dockerDesktopLinuxEngine)⇒ session-api 拓扑起不来 ⇒ Playwright `globalSetup` 的 `waitForReady` 必然失败。E2E 断言已按新语义重写(`workspace-layout.spec.ts` 覆盖 D-UI-1~7 + 几何读数,`workspace-windows.spec.ts` 覆盖固定视图集),**真机复跑归 WP-95**。

### 5.7 已知必然失效但**未改**的 E2E 断言(主题单值化的连带面;属 WP-95/96)

`apps/plugin-dev/e2e/` 中以下断言因「宿主落锚恒为 `terminal`」必然失效(逐 file:line):
1. `embed-protocol.spec.ts:83` / `:364` `expect(appearance.resolvedTheme).toBe("light")`;
2. `embed-protocol.spec.ts:336` / `:409` `toHaveAttribute("data-sm-theme", "dark")`;
3. `browser-matrix.spec.ts:146` 同上;
4. `axe-contrast.spec.ts:382` `toHaveAttribute("data-sm-theme", "dark")`(该文件 26 / 39 / 184 / 377 行「插件落二值 + 落 dark」的表述同步失效);
5. `axe-contrast.spec.ts:366 / 373` 的 `light` 面语境与单主题冲突 ⇒ 面矩阵需在 WP-95 重排。

### 5.8 遗留处置(只登记,不越权结案)

- **#33 护栏义务**:已由新增几何 harness 的判据承接(视图位高 ≥ chrome + 4 行 / 字节列表可视高 ≥ 4 行 / 左半侧是滚动容器 / 文档层不溢出);**仍开放**(判据换载体,义务不变)。
- **#35 / #37**:载体已按裁定消解(开发壳与宿主都给了整页定高链,零纵向溢出有真机读数);**结案判定归 WP-97**。
- **#36**:**不结案** —— `SIDE_PANEL_MIN_WIDTH_PX` 不含字节视图的 `14rem` 侧栏,免折行仍需 ≈766px 视图宽(改版后约束左半侧宽度)。
- **#34**:只保留列表内重排 ⇒ 原成因(工作区高于视口)消失,**不实现拖拽中自动滚动**;**结案判定归 WP-97**。
- **未顺手改的裁定外事项**:`sm-timeline.ts` 的 `.current-badge` 仍用系统色 `highlight` / `highlighttext`(非 `var()` 回退值,不在 D-UI-6 的裁定面内)——登记待真机 axe 裁决。
