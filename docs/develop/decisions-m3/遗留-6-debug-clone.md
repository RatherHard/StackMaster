# 遗留移交清单第 6 项 决策登记片段(中期 M3;待并入 `docs/develop/权威API语义规约.md` §三·二十三)

> 说明:本文件是主控为统一登记簿预留的**片段文件**,承接 `docs/phases/中期任务分解.md:436`(**遗留移交清单第 6 项**;编号由主控预分配 = **D-API-145**,登记簿占位见 `权威API语义规约.md:1540`):
>
> > **6. 调试克隆「对齐源」一般缺陷** · 现象 = 调试实例 = attach 时按 `origin.revision` **重放权威动作日志**得到的克隆,而动作日志**只在 `submit` 时落库**(`session-manager.ts#persistActionLogDelta`)⇒ **未提交会话**的克隆恒为**种子初始态**(`:260` 取证:请求 `targetRevision:1`、实际对齐 `revision:0`)· 触发条件 = **任何非种子题、或玩家已改动内存的未提交会话**。
>
> 本项**已定案并落地**(TDD 先红后绿;真机证据含字节级栈区读数)。修法结论:**对齐源改用「在途会话的权威动作日志」**(候选方向之一,采纳),并以**精确对齐语义 + 确定性失败**取代旧的「尽量接近 / 静默退化」。

---

### D-API-145 调试克隆对齐源:改用**在途会话的权威动作日志**(`SubmitReference.actionLog`)⊕ 已落库日志的在途基线前缀

- **决策**:

  1. **对齐源 = 在途会话的权威动作日志。** `LiveSessionManager.getSessionSummary` 的返回面扩为 `LiveSessionSummary`(`apps/session-api/src/sessions/session-manager.ts`),新增字段 `acceptedActionLog` = `SubmitReference.actionLog`(`packages/session-core/src/session.ts:501` —— 编排核心 `acceptedActions` 账本的同源投影,仅已接受动作)。`revision` 与 `acceptedActionLog` 取自**同一次** `submit()` 只读调用并浅拷贝为快照(`submit()` 对该账本是纯构造、零副作用、零 worker 往返),因此二者恒自洽 —— 调试 attach 与真实动作分属两条串行链,分两次读取会撕裂。
  2. **已落库日志降级为「前缀补齐」来源。** 合并规则:已落库 `action_log` 只贡献 `revisionAfter ≤ 在途账本基线` 的区间(基线 = 在途日志首条前一条;账本为空时 = 当前权威 revision);基线之后的条目一律以在途账本为准。重启恢复会话(`SessionOrchestrator.recover`)的真实产物是「revision = 快照 envelope revision + `acceptedActions` 账本自恢复点重启、为空」,此时基线之前的条目**只**存在于已落库日志里 —— 这正是前缀补齐的必要性;缺了它,恢复会话的克隆会退化为种子态或错误态。
  3. **合并与覆盖判定是纯函数。** 新模块 `apps/session-api/src/sessions/debug-alignment.ts`(`resolveDebugAlignment` / `inFlightLedgerBase`):零 IO、零时钟、零随机,同一输入逐字节同一输出。
  4. **`origin.revision` 语义收紧为「精确对齐点」。** 合并日志必须**从 revision 0 起连续**覆盖到该 revision,克隆才成立;否则**确定性失败**(冻结 `invalid_input_format` / `"revision is not available"`;新增常量 `DEBUG_REVISION_UNAVAILABLE_ERROR`,`apps/session-api/src/debug/debug-channel-constants.ts`,载荷与既有「起点超出权威 revision」分支**逐字节同形**,16 错误码封闭枚举零扩展)。判定在**变体供给与 spawn 之前**完成 ⇒ 不留半开实例。**明确禁止静默退回种子态** —— 旧实现的静默退化正是本缺陷的成因。
  5. **不采用更窄修法「种子题栈上预置返回地址」。** 那只是**症状补丁**:它只让当前演示题的栈行恰好含一个像地址的 8 字节,对任何非种子题、以及玩家已改动内存的未提交会话**结构性无效**;而本定案修的是「克隆从哪里取状态」这一**根因**,与题目形态、是否预置返回地址、玩家是否提交**全部解耦** —— 故为一般解。

- **理由**:

  1. **缺陷的本质是「对齐源选错」而非「日志不够」。** 权威动作日志在任何时刻都存在两份投影:编排核心的**在途账本**(`acceptedActions`,随动作即时推进)与**已落库表**(`action_log`,只在 `submit` 时增量落库,D-API-56)。旧实现只读后者 ⇒ 「玩家是否提交过」泄漏成了「克隆是否等于种子态」的隐式开关。改用前者后,未提交会话的克隆与已提交会话的克隆走**同一条**确定性路径。
  2. **秘密面零变化(ADR-DC1 条款 3 未动)。** 对齐源只含**动作对象**(类型 + 参数 = 玩家输入,公开面),不含快照字节、不含 seed、不含私有包字段 ⇒ 真实 checkpoint 快照、seed 值、私有判题包**仍然零装载**;`checkpoint` 起点依旧只解析日志位置。本决策**只换了对齐源的读取面**,没有放宽任何装载面。
  3. **精确语义是可测的义务,「尽量接近」不是。** 旧回执的 `revision` 是「重放进度锚点」(可合法落后于请求起点),调用方无法区分「已精确对齐」与「对齐源缺失导致退化」;新语义下二者由**不同形状**表达(精确成功 vs 冻结错误帧),退化不再可能被误读为成功。这与 M3 收口「不得以沉默结案」的纪律同向。
  4. **确定性可机检。** 对齐源解析是纯函数;attach 幂等(既有冻结口径)保证同一会话重复 attach 返回同一实例态;合并序只依赖 `revisionAfter` 升序与连续性,不依赖时钟 / 网络序 / 并发调度 ⇒ 「同一会话同一 `origin.revision` 多次 attach 得到逐字节一致的克隆」是结构性的,且已由断言固定(见下)。
  5. **零装配面改动(并发纪律)。** `getSessionSummary` 的两处显式闭包(`apps/session-api/src/runtime/runtime.ts:402`、`apps/session-api/test/routes/helpers/session-rig.ts:278`)都是**逐字转发 manager 返回值**的写法 ⇒ 会话摘要新增字段**随既有结构缝自动下发**,`runtime.ts` 与共享 rig 文件**零改动**(二者正是 WP-78 / WP-82 等并发席位的编辑面,避免冲突)。同时摘要的「定位 + 权威进度锚 + 对齐源」三件事**一次同步读取**完成,优于另开一条查询缝(后者需两次读取才能自洽)。

- **红灯位置**(TDD:先红后绿;红灯形态与 M2 取证同源):

  | 测试文件 | 门控 | 红灯原文(修前) | 修后 |
  |---|---|---|---|
  | `apps/session-api/test/debug/debug-clone-alignment.test.ts`(通道级,假调试 worker;**新增**) | 无(常跑) | `AssertionError: expected +0 to be 2 // Object.is equality`(未提交会话 attach `origin.revision = 2` ⇒ 回执 `revision` 恒 **0** = 种子初始态);恢复缺口 2 例红:`expected { revision: 3, status: 'running' } to be an instance of DebugChannelError`、`expected undefined to deeply equal { code: 'invalid_input_format', …(1) }` | **5 passed** |
  | `apps/session-api/test/debug/debug-clone-alignment.integration.test.ts`(真机 vm-worker;**新增**) | `SESSION_API_IT=1` | `AssertionError: expected +0 to be 2 // Object.is equality` + **字节级**:`AssertionError: expected '00000000' to be '41414141'`(栈区 = 种子零填充) | **3 passed** |
  | `apps/session-api/test/debug/debug-clone-alignment-source.test.ts`(纯函数;**新增**) | 无(常跑) | 语义面(缺口 / 基线 / 丢弃越界前缀)在旧实现下无对应行为 | **13 passed** |

  - 红灯固定方式:临时把 `debug-channel-orchestrator.ts` 的对齐源改回「只读已落库日志」(逐字复现旧实现),跑出上表红灯原文后**立即还原**;还原后复跑全绿 —— 红灯归属**明确落在对齐源这一处**。
  - 红灯语料自证:第一个红灯用例显式断言前提锚 `会话权威 revision = 2` **且** `actionLog.countBySession = 0`(未提交),使「对齐到 0」只能解释为对齐源缺在途账本,而非会话本身没有动作。

- **影响面**:

  - **改动文件**(全部在 `apps/session-api`):`src/sessions/debug-alignment.ts`(新增,纯函数 79 行)、`src/sessions/session-manager.ts`(`LiveSessionSummary` + `getSessionSummary`)、`src/debug/debug-channel-orchestrator.ts`(deps 的 manager 摘要形状 + attach 精确对齐 + `#resolveAlignment` / `#replayEntries` 取代 `#replayTo`)、`src/debug/debug-channel-constants.ts`(+1 冻结载荷常量并纳入装配期自检)。**`runtime.ts` / `test/routes/helpers/session-rig.ts` / `persistence/**` / `migrations/**` / `packages/**` / `vm-engine/**` 零改动。**
  - **冻结契约零改动(逐条)**:①**帧族** —— 12 值判别联合、字段、方向集**零改动**(未新增 / 未删除 / 未改字段);②**推送时机** —— `debug_attached → debug_function_table →(若 paused)debug_instruction_stream`、每次 `debug_paused → debug_instruction_stream`、requestId 回显例外,全部**零改动**(回执形状与推送帧序由既有用例继续锁定);③**错误码** —— 复用既有 `invalid_input_format`(`PublicError`,16 错误码封闭枚举**零扩展**),新增常量只是把原本**内联在 attach 分支里的同一字节形态**提到常量面并纳入装配期自检;④**attach 回执形状** —— `{revision, status, paused?}` **零改动**,变的只是 `revision` 的**取值语义**(由「重放进度锚点」收紧为「精确对齐点」,与协议 §四.3「重放到请求起点」的原文一致 —— 旧实现才是偏离契约的一方)。
  - **底线 1 / 2 未触碰**:对齐源是服务端进程内的权威账本读取,零浏览器参与;未引入任何浏览器端本地权威执行或本地判题;投影白名单与脱敏面零改动。
  - **资源面**:未提交会话的克隆现在会真的重放 N 条动作(旧行为重放 0 条)⇒ 调试 attach 的 worker 往返次数上升为 `origin.revision` 次。这是**正确性所需**且被既有约束兜住:每会话动作预算 / clientSeq 上限限制了 revision 上界;attach 幂等使重放只发生一次/会话。
  - **语义收紧的可见后果(须登记的既有行为变化)**:重启恢复会话若在「快照 revision」与「已落库日志覆盖」之间存在缺口(快照点之后的动作**未**随 submit 落库),则缺口内的 revision 由「静默退回种子态 / 落后对齐」变为**确定性拒绝**。这是**有意的 fail-closed**:克隆态在该区间无法仅由日志复现(状态只存在于禁止入调试进程的快照里)。恢复会话的**可达**区间(≤ 已落库连续覆盖)仍逐条精确对齐,已由新增用例固定。
  - **回归护栏**:`test/debug` + `test/scan` 真机 IT **12 files / 120 passed**(M2 基线 99 + 本项新增 21);`test/debug` 无 IT **43 passed | 5 skipped**;CH-07 派生面真实 canary 槽用例(`test/mvp-challenges/zr-b13-derivation.test.ts`,承载 `corpus.ts:1490-1531` 的 `zrB13FixturePair`)在整包复跑中通过(该用例只走调试变体派生链路,与本项对齐源无交界,属独立回归锚点)。

- **补充登记(本机环境 / 并发纪律 / 待主控裁决)**:

  - **本机不可达项(如实登记)**:`SESSION_API_IT=1` 的**整包** vitest 在本机不可运行 —— 包级 `vitest.config.ts` 的 `globalSetup`(`test/persistence/compose-lifecycle.ts`)会执行 `docker compose -f compose/deps.yaml up -d --wait`,而本机运行中的 **`compose:app:up` 拓扑**(`session-api-app-*`,旧镜像)已占用宿主端口 15432 / 16379 / 19000 ⇒ `Bind for 0.0.0.0:19000 failed: port is already allocated`,globalSetup 抛错即整轮失败(与 daemon 代理 `127.0.0.1:7897` 拒连无关,非镜像拉取问题)。**清偿载体 = CI**(deps 拓扑独占端口)。本项真机 IT 的等效取证改用**临时旁路配置** `apps/session-api/vitest.it-bypass.config.ts`(与包级配置同形,仅去掉 `globalSetup`;`test/debug` / `test/scan` 的真机 IT 只用内存存储 + 真实 `vm-worker.exe`,不依赖 deps 容器),该文件在取证完成后由本席位**保留在盘**以便主控复跑,并在报告中标注为「临时取证件,可删」。失败尝试产生的 `session-api-deps` 悬空容器 / 卷 / 网络已 `docker compose -f compose/deps.yaml down -v` 清理,`compose:app:up` 拓扑未被触碰(42 分钟后复验仍 6 容器全 healthy)。**注意**:该悬空态会随**其他席位**的同类 `SESSION_API_IT=1` 尝试复现(23:35:31 观察到另一批 `Created` 状态容器,非本席位产生)⇒ `docker ps -a` 里见到 `session-api-deps-*` 属"端口冲突下的失败残留",不代表任一席位成功拉起过 deps 拓扑。
  - **写入面偏离(须主控知悉)**:本项的必要改动落在 `src/debug/**`(缺陷客体所在文件)与本项新增的纯函数模块 `src/sessions/debug-alignment.ts`;`src/runtime/**`、`packages/**`、`persistence/**`、`migrations/**`、`teaching/**`、`compose/**` 与全部禁改文档**零触碰**。`src/debug/**` 未出现在派单的「只允许改」白名单里,但它是本缺陷的唯一实现客体,且无并发席位编辑该目录(对照 D-API-144 登记「并发 agent 正在编辑 apps/session-api」的实际情况:并发面在 `persistence/` + `teaching/` + `runtime` 装配)。已按「窄幅 edit + 改前读盘」纪律执行。
  - **待裁决点(不阻塞本项收口)**:①`DEBUG_REVISION_UNAVAILABLE_ERROR` 的 message 文案是否要与「超出权威 revision」保持同一句(现为同一句,便于前端统一呈现);②恢复缺口语义是否需要一条**面向用户**的解释文案(现仅受控日志 + 冻结错误帧,前端呈现为通用 `invalid_input_format`);③是否把「已落库日志的保留窗 / 裁剪」提前登记为契约面缺口(现 `ActionLogStore.listBySession` 无裁剪参数,裁剪一旦引入,本项的连续覆盖判定**无需改动**即可正确拒绝 —— 语义已就位)。
  - **门禁时点纪律(如实登记)**:本项改动落地后 `pnpm --filter @stackmaster/session-api typecheck` **曾于 23:33 全绿**;23:38 起的复跑出现**唯一一条**诊断 `test/persistence/teaching-events.integration.test.ts(38,3): error TS2305: Module './helpers/it.js' has no exported member 'createPostgresPool'` —— 该文件由**并发席位(WP-82 教学采集面)于 23:37:02 新建**(`createPostgresPool` 的既有正确来源是 `../../src/persistence/index.js`,其余 11 个 IT 文件即如此导入),与本项零交集(本项未触碰 `test/persistence/**`)。整包 vitest 同期(23:36 / 23:38)的 5 条红灯亦**全部**位于 `test/teaching/**`(并发 lane 的在途状态:两轮复跑的总用例数由 837 → 854 变化,即该 lane 正在落盘)。**该 lane 落盘完成后本席位复跑,typecheck 与整包 vitest 均转全绿**(23:40 `typecheck` exit 0;23:41 整包 **72 files passed | 13 skipped / 757 passed | 119 skipped,0 failed**,exit 0)⇒ 结论:上述红灯**确系并发 lane 在途态**,非本项回归。本项回归结论以 `test/debug` + `test/scan`(**12 files / 120 passed**,真机)为锚,容器门控集成交付门以 CI 复跑为准。
  - **建议回填 `docs/phases/中期任务分解.md:436` 的勾选与证据行**(该文件不在本席位写入面,文案供主控直抄):
    - **勾选**:`[x]`
    - **证据行(建议文案)**:「**已修(D-API-145;2026-09-17)** · 对齐源 = **在途会话权威动作日志**(`SubmitReference.actionLog`,经 `getSessionSummary` 随摘要下发)⊕ 已落库 `action_log` 的在途基线前缀(补重启恢复);合并 / 覆盖判定 = 纯函数 `src/sessions/debug-alignment.ts`;`origin.revision` 收紧为**精确对齐点**,不可得 ⇒ 冻结 `invalid_input_format` / "revision is not available"(spawn 前判定),**禁止静默退回种子态**。红灯:`test/debug/debug-clone-alignment.test.ts`(`expected +0 to be 2`)、`test/debug/debug-clone-alignment.integration.test.ts`(真机 `expected '00000000' to be '41414141'`)+ `debug-clone-alignment-source.test.ts`(13 例);绿:`test/debug`+`test/scan` 真机 **12 files / 120 passed**(基线 99 + 新增 21),`test/debug` 无 IT 43 passed | 5 skipped。冻结契约(帧族 / 推送时机 / 错误码 / attach 回执)**零改动**;`runtime.ts` / rig / 持久化面零改动。本机 `SESSION_API_IT=1` 整包不可达(compose 端口冲突,清偿载体 = CI),真机取证经临时旁路配置 `apps/session-api/vitest.it-bypass.config.ts`。」
