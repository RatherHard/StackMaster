# 遗留 e2e descriptor 决策登记片段(中期 M3 遗留移交清单第 3 项;待并入 `docs/develop/权威API语义规约.md` §三·二十三)

> 说明:本文件是主控为统一登记簿预留的**片段文件**,承接 `docs/phases/中期任务分解.md` §二 M3「收口 · 中期验收评审」**遗留移交清单第 3 项**:
>
> > **`descriptor.spec.ts:88`**(口径**乙**原挂账两项之一)· 仍开放 · 触发条件 = 视口 / 断言几何敏感 · 归属 = M3 逐项取证后定案(修产品或改断言),不得以沉默结案。
>
> 本项**已定案并落地**(口径 (b) 改断言);同批的 `browser-matrix.spec.ts:78`(320px)磁盘复核一并登记于本文末。

---

### D-API-141 `descriptor.spec.ts:88` 定案 = **断言(就绪口径)敏感,非产品缺陷**;已改断言

- **决策**:该红灯判为 **(b) 断言 / 就绪口径问题**,**不动产品代码**;修复落点为**共用 E2E 夹具的就绪门槛**——`apps/plugin-dev/e2e/fixtures.ts#createSessionViaForm` 新增第 5 步「动作通道真实就绪」:`await expect(menuStatus(page, "connection-status")).toHaveText("connected")`(结构选择器 + 枚举值,零像素 / 零几何依赖)。原挂账口径「**视口 / 断言几何敏感**」经取证**被推翻并订正**为「**动作通道就绪口径过弱(时序敏感)**」,该用例不设视口、不含任何几何断言。
- **理由**(逐项取证,2026-09-17;拓扑 = compose 全拓扑 + plugin-dev 壳,单机 Windows):
  1. **失败点与几何无关**:`--project=firefox --repeat-each=3` 稳定 **3/3 红**,失败在**该用例第 103 行 `page.evaluate` 内的首次 `client.sendAction`**,抛 `SessionClientError(not_connected)` —— 原文「**动作通道未连接:断线期间不投递动作(等待重连对齐后重试)**」;失败瞬间页面快照:`#dev-status` 已写「会话已创建并连接(sessionId=…)」,而工作区菜单 `connection-status` = **`connecting`**,运行组按钮全 `disabled`。**无任何几何 / 溢出 / 视口断言参与**。
  2. **真因 = 壳文案不是连接信号**:`apps/plugin-dev/src/main.ts:399-403` 在 `client.connect()` 调用之后**立即**写「会话已创建并连接」;而 `SessionClient#connect()`(`packages/vm-ui/src/client/session-client.ts:413-429`)只把状态置为 `connecting` 并发起**异步** WSS 升级。原夹具第 4 步仅校验该文案 ⇒ 门槛在 chromium 上"碰巧"够用、在 firefox 上不足。
  3. **两引擎均无连接缺陷**(探针实测,取证后已删除):「壳文案置位 → `connection-status=connected`」差值 **chromium ≈ 11 ms / firefox ≈ 1249 ms**。firefox 首连明显更慢,**但最终成功**;差异只在握手耗时,不是"建不起通道"(后者是 webkit 的形态:恒定 `reconnecting`,见移交清单第 1 项)。
  4. **产品行为正确**:`connecting` 期间拒绝投递动作是**契约内的对齐语义**(断线期不排队投递),该错误分支有意为之;投影面在通道未就绪时已可用(快照中栈 / 寄存器 / VMA 全部渲染)。故**不存在需修的产品路径**,改动 `packages/vm-ui/src` 反而会破坏对齐语义。**默认未触碰 `packages/vm-ui/src`**(本轮该目录有并发 agent 活动)。
- **红灯位置**:修复前 `e2e/descriptor.spec.ts:88:3`(用例声明行锚点**保持不变**;取证原文见该用例体内首行注释,理由 = 不得因新增文件头注释位移这一被多处引用的锚点)+ 失败行 `e2e/descriptor.spec.ts:103:16`。修复后同锚点转绿。
- **影响面**:
  - 修复位于**全 spec 共用**的 `createSessionViaForm`(经 `createdSession` 夹具被 `session` / `payload` / `workspace-*` / `breakpoint-linkage` / `axe-contrast` / `browser-matrix` 等 spec 复用)⇒ **同类潜在竞态一并收敛**:`disconnect-recovery.spec.ts:43-55` 曾同样依赖「夹具返回时通道已建立」(`channel === null` 即抛「动作通道尚未建立」),现由同一门槛前置兜底。
  - **对 webkit 矩阵格的可预期影响**:webkit 恒不 `connected`,该门槛会把 webkit 的壳体面失败**提前到夹具层**并以 `Expected "connected" / Received "reconnecting"` 报错(原形态 = 下游 `step-button` 恒 `disabled`)。**红格数量与单一根因不变**(仍是移交清单第 1 项的跨源 WS 认证面),但**报错形态与失败位置改变**,与 §二 WP-74 末段「12 格逐条为 `[webkit]` 连接面」的描述并存时须按本条订正阅读。**未在本机取得 webkit 复跑证据**(本机 webkit 属已知 401 阻断形态),此为如实登记的未取证面。
  - **无生产代码改动**:`packages/vm-ui/src` / `packages/protocol` / `apps/session-api` 零改动;无契约、无 golden fixture、无 token 面变化。
- **证据(命令原样可复跑)**:
  ```bash
  # 1) 修复前(红):firefox 稳定 3/3 红
  E2E_MATRIX=1 E2E_SKIP_COMPOSE=1 pnpm --filter @stackmaster/plugin-dev exec playwright test e2e/descriptor.spec.ts --project=firefox --repeat-each=3
  #    → 3 failed / 6 passed;失败原文 `page.evaluate: 动作通道未连接…`(descriptor.spec.ts:103:16)
  # 2) 修复后(绿):同命令 + chromium
  E2E_MATRIX=1 E2E_SKIP_COMPOSE=1 pnpm --filter @stackmaster/plugin-dev exec playwright test e2e/descriptor.spec.ts --project=firefox --project=chromium --repeat-each=3
  #    → 18 passed(firefox 9 + chromium 9)
  # 3) 回归:全量 chromium 门禁
  E2E_SKIP_COMPOSE=1 pnpm --filter @stackmaster/plugin-dev test:e2e
  ```
  - 修复前 chromium 基线:`--project=chromium` **3 passed**(该用例在 chromium 上原即"碰巧"绿,与失败机理一致)。
  - 修复后逐用例:`descriptor.spec.ts` firefox ×3 + chromium ×3 = **18 passed / 0 failed**。
  - **回归(firefox 全量,含矩阵格)**:`E2E_MATRIX=1 … playwright test --project=firefox`(全 spec)⇒ **43 passed / 11 skipped / 0 failed**(4.4 min)⇒ firefox 侧**全绿**,本项不再有任何红点,且共用夹具改动**零回归**。
  - **回归(firefox 320px 格,独立复核)**:`… e2e/browser-matrix.spec.ts --project=firefox --grep "320"` ⇒ **2 passed**(含红灯锚点 `browser-matrix.spec.ts:78` 的嵌入面用例)⇒ 与本节附条(320px 修复磁盘在位)互为印证,且该格在 firefox 上现为**真绿**。
  - **回归(chromium 全量门禁)**:`pnpm --filter @stackmaster/plugin-dev test:e2e` 共跑 **3 次**,每次均为 **36 passed / 1 failed**;3 次的唯一失败项**全部落在 `e2e/embed-protocol.spec.ts`**(`host-mock-state` 未达 `ready` / `waitFor` 20s 超时;两次为 `:388`,一次为 `:228`)。**已证明与本改动无关**:①该 spec 只从 `fixtures.js` 取 `test`,**不使用** `createSessionViaForm` / `createdSession`(`embedViaHostMock` 自带独立会话路径,租户每用例唯一);②**基线对照运行** —— 把本改动的新增断言临时中和后复跑同一条全量命令,**同样 36 passed / 1 failed 且失败点同为 `embed-protocol.spec.ts:228`**;③该 spec **单独整文件复跑 9 passed 全绿**(两个失败点 `:388` / `:228` 同次均绿)。⇒ 判为**本机长会话下的既有偶发竞争**(与 §二 WP-74 末段登记的「非缺陷偶发红」同类),**非本次改动引入**;本轮**如实登记、不粉饰**。
  - 拓扑由外部托管(`E2E_SKIP_COMPOSE=1`;compose 先经 `docker compose … up -d --wait` 起妥,`/readyz` = `{"status":"ok"}`)。**说明**:本机 `docker compose up --build` 不可用 —— 本机 Docker 配置的代理 `127.0.0.1:7897` 未监听,`load metadata` 阶段对 `node:22-bookworm-slim` / `rust:1-bookworm` 报 `connectex refused`;故改用**已在本地的 `stackmaster/session-api:dev` 镜像**免重建起拓扑(该阻断与本项结论无关,如实登记)。
  - 探针产物已删除(`e2e/tmp-probe-connect.spec.ts`,诊断后即删,未留残件);`eslint` 对两个改动文件 **exit 0**。
- **遗留 / 风险**:
  1. **开发壳文案本身仍乐观**(`main.ts:403` 的「已连接」在 `connected` 之前写出)。本轮**未改产品侧文案**:改它需要给 `SessionDemoClientLike` 增加状态订阅面(跨文件 + 影响壳测试),超出本项"改断言"的窄幅范围。**如实登记为候选增量**(非阻塞;E2E 侧已不再依赖该文案做就绪判定)。
  2. 本机 **webkit 复跑证据未取得**(跨源 WS 401 阻断,移交清单第 1 项);本文对 webkit 的影响面为**推演口径**,非实测。
  3. 真机取证环境与 CI 的差异:本文全部结论以**本机真机**四条命令(见上「证据」)为准;CI `e2e-matrix` job 是否曾复现本红灯,取决于该 job 的 spec 集合,本文不作推断。**未在 CI 侧复跑取证。**

---

## 附:同批 `browser-matrix.spec.ts:78`(320px)修复的磁盘复核(未回退)

- **结论**:**`03853cf` 的修复在磁盘上仍在**(无回退迹象)。
- **证据**:
  - `packages/vm-ui/src/payload/blockly-theme.ts:132-133` = 文档级离屏规则常量 `PAYLOAD_MEASURE_CANVAS_CSS`(`canvas.blocklyComputeCanvas{position:absolute;top:-1000px;left:-1000px;}`);`:138-146` = `ensurePayloadMeasureCanvasStyles(doc)` 幂等注入 `ownerDocument`;
  - 同文件 `:155-156` = `ensurePayloadCanvasStyles(host)` **在分支之前无条件**调用该文档级注入(注释明写"两个分支都要注入,避免任一分支提前 return 漏掉");调用点 `packages/vm-ui/src/payload/sm-payload-tab.ts:336`;
  - 反向锁定测试在位:`packages/vm-ui/test/payload/measure-canvas-doc-style.test.ts`(含 `:98` 对 `PAYLOAD_MEASURE_CANVAS_CSS` 含 `canvas.blocklyComputeCanvas` 的断言 = 防"只落 shadow 根"旧实现回归);
  - 红灯锚点文件与行号不变:`apps/plugin-dev/e2e/browser-matrix.spec.ts:78` 仍为 320px 循环内的**嵌入面**用例(`test(\`嵌入面:投影可达 / 无横向溢出 / 核心交互可达 / 受限 CSP 头在场\`)`),`:61` 的 `pluginNoHorizontalOverflow` 断言形态未改。
- **附注(本轮实测)**:本轮**已实跑该格** —— `E2E_MATRIX=1 … e2e/browser-matrix.spec.ts --project=firefox --grep "320"` ⇒ **2 passed**(锚点 `:78` 的嵌入面用例 + `:115` 的壳面用例)⇒ 修复不仅**在磁盘上在位**,且在 firefox 上**实证生效**(与 §二 WP-74 的 CI run 37 / 38 结论一致)。
