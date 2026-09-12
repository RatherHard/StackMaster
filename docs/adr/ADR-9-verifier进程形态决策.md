# ADR-9 verifier 进程形态决策(Q1 定案 · 阶段六 WP-61)

| 项 | 值 |
|---|---|
| 状态 | **已决策(2026-09-12):候选 (b) 正式启用——Node verifier 服务(`apps/verifier`,信任域 4)+ vm-worker 新增裁决重放命令面(引擎进程协议 additive 演进,阶段六边界裁决 2 契约面 (b) 落位)**;本文件是该决策的定案记录与复核依据,与计划书冲突时以计划书为准 |
| 决策人口径 | 阶段六任务分解 §六 Q1(WP-61 定案记 ADR / D-API);主控预决策框架内成文 |
| 关联 | 计划书 5.2(信任域 4)/ 5.3 / 5.8、9.1、ADR-3 / ADR-8、版本策略 §三 / §四.4、快照与回放语义规约 §五、引擎进程协议 §二变更纪律 / §四 / §九、会话编排语义规约 D-W8-9 / §六、判题语义规约 §七 / §八·一、阶段六任务分解 WP-61 / WP-62 / §一边界裁决 2~3;D-API-87(实现面登记)/ D-API-94 ~ 96(WP-62 增补) |

---

## 一、决策内容

**verifier 以 Node 服务形态交付(`apps/verifier`,信任域 4),裁决重放经引擎进程协议新增的 `verify` 命令面委托 vm-worker 执行;TS 侧零裁决语义(纯搬运与落库)。**

三候选取舍:

- **定案 = 候选 (b)**:Node verifier 服务 + vm-worker 新增重放 / 裁决命令面。理由见 §三;
- **否决候选 (a) Rust 原生 verifier(vm-engine workspace 兄弟 crate,进程内消费 `replay()`)**:该形态要求 vm-engine workspace 引入 PostgreSQL / S3 / HTTP 服务依赖与 async 运行时生态,与引擎纪律(纯同步状态机、无 async / 无直接 IO、依赖最小化,CLAUDE.md §Rust 引擎纪律)和"Rust 服务 infra 无仓库先例"的工程事实直接冲突;服务面(PG 队列消费、对象存储、运维面)本就是 TS 生态的既有强项(session-api 形态镜像)。按 ADR-8 tripwire 条款登记本否决理由:**该否决是工程边界裁决,不构成对 ADR-8"单一回放实现"的任何松动——候选 (a) 的进程内复用收益已被候选 (b) 的"同一二进制 + 同一 `replay()` 调用"完整继承**;
- 候选 (c) 其他(含"verifier 直连 PG 读取后自研 TS 重放"):违反 ADR-8 单一实现硬约束,结构性排除,不展开。

## 二、定案理由(为何候选 (b))

1. **ADR-8 同锚的最强形态**:回放与判题语义全部在 Rust 侧单一实现——`verify` 命令在 worker 进程内部直接调用既有 `vm_runtime::replay`(与黄金回放同一份代码、同一装配器 `assemble_replay_config`),TS 侧零裁决逻辑;不存在"第二套重放"的表达位;
2. **ADR-3 禁 FFI 满足**:进程边界 spawn + stdio JSON 协议(引擎进程协议既有形态),与编排器同一通信纪律,零新跨语言机制;
3. **版本策略 §四.4 同锁的结构性保证**:verifier 服务复用 `stackmaster/session-api:dev` 同一镜像——镜像同一性保证两服务 spawn **同一份** vm-worker 构建;外加双层运行时锁定:worker 侧 `mirror.vmEngineVersion == VM_ENGINE_VERSION`(与 load 同闸)+ verifier 侧 bundle lock 复核(包声明 vs `ready` 自报,不一致 = `replay_mismatch` 方向拒裁);
4. **CLAUDE.md 依赖规则的预留形态**:`challenge-schema` 可被 verifier 依赖的 TS 应用形态已在 5.5 登记;dependency-cruiser 新增 `verifier-workspace-deps-allowlist`(protocol / challenge-schema 之外全禁,session-core 亦不依赖——信任域 4 与编排核心结构解耦);
5. **引擎进程协议 additive 演进有先例**:协议从未独立部署(单仓同发),D-F10(`load` 信封增补 `publicDescriptor`)与阶段四调试面命令族(`load_variant` / `debug_*`)已两次以 additive 变体追加演进且版本维持 1;verify 命令面沿同一纪律(`ENGINE_PROCESS_PROTOCOL_VERSION` 维持 1,旧编排器不触发新命令,新编排器对旧 worker 得 `unknown_command` fail-closed,方向安全)。

## 三、进程与协议形态(定案要点)

- **一次性裁决进程**:每个 run spawn 一个 vm-worker(`ready` 握手版本比对 fail-closed → `verify` 单命令 → `shutdown`,进程不复用)——与"单会话单进程"(ADR-3)同形态,verify 仅在**未装载阶段**受理(独立裁决进程形态;已装载会话进程不可达,`state_violation`);
- **verify 请求面**(主控定案落地):私有包 + 公开描述包 + 六记录项上下文(`ReplayContext` 镜像)+ 规范化动作日志(`stackmaster-action-log/1` 规范化文本);响应 = 裁决面(11 值结果类型,零新增字面)+ 重放逐项结论(matched / diverged / context_mismatch / fault)+ `logDigest` 复算值;响应整体 SERVER_ONLY(仅 verifier 受控日志 / 审计与落库消费,零浏览器可达面);**不设预留字段**——WP-62 隐藏测试执行面的增补走引擎进程协议变更纪律;
- **帧体上界论证**(D-F2 框架):verify 请求帧 = 双包 + 动作日志。双包为登记管线上游受护栏载荷(单包天花板 4 MiB,D-API-76 同族);动作日志长度受运行时结构护栏 `ACTION_LOG_LIMIT`(10 000 条)约束、单条目内存差分受写入预算约束。服务侧预检 `VERIFIER_MAX_ACTION_LOG_BYTES`(默认 4 MiB,天花板 = `MAX_FRAME_BYTES` 16 MiB)在 spawn 之前确定性拒裁(超限 = run failed,裁决不可用 ≠ 判负),帧层 16 MiB 硬顶为第二道闸;
- **`export_action_log` 配套命令面**:submit 时编排器经该命令取引擎权威重放材料(六记录项上下文 + 规范化动作日志文本)随 `submissions.reference` 落库(D-W8-9 引用形态的引擎权威面补全;`stackmaster-session-submit/1` 引用字段面零改动,`replay` 为 WP-61 增补必选字段)。配套新增 `SessionOrchestrator.exportReplayMaterial()`(串行队列承载;最小结构复验后原样透传,零语义解析)。

## 四、裁决映射与拒裁方向(WP-61 重放面;WP-62 隐藏测试汇总在此之上合成)

| 管线结论 | 裁决 / 处置 | 方向锚点 |
|---|---|---|
| 六记录项缺项(引用结构 / `replay` 缺席) | **裁决无效**:`challenge_invalid` 落 verdicts | 版本策略 §三"缺项的裁决不可审计,视同无效";主控定案 challenge_invalid 方向 |
| `log_digest` 复算不符 | **拒裁**:run failed,不落 verdicts(重试新 run 行) | D-API-85 绑定锚;篡改检测在重放之前即拒 |
| 版本未登记 / 双包缺失 | `challenge_invalid` 落 verdicts | D-API-32 challenge_invalid 行(版本未登记 / 双包缺失同形) |
| 双包哈希与 `challenge_versions` 登记值不符 | **拒裁**:run failed(存储完整性事实,可能瞬时;fail-closed 不落裁决) | 主控定案"哈希不符拒裁";裁决不可用 ≠ 判负 |
| 对象取回越权(AccessDenied)/ 存储不可达 | **拒裁**:run failed | 最小授权面红灯;裁决不可用 ≠ 判负 |
| `verify_bundle_lock` 不一致(包声明引擎构建 vs worker `ready` 自报) | `replay_mismatch` 落 verdicts | 版本策略 §四.4;主控定案 replay_mismatch 方向 |
| seed 策略 = `server_random_per_session` | `challenge_invalid` 落 verdicts(零 worker 往返) | 边界裁决 3:v1 seed 零驻留,重放不摄入 seed;D-J8 触发时随行演进 |
| 重放逐项漂移(`vm_runtime::replay::Mismatch`) | `replay_mismatch` 落 verdicts(SERVER_ONLY detail 携带条目序 / 字段 / 期望 / 实际) | `replay_detects_tampered_log` 语义在服务面复锚 |
| 重放上下文错配(`ContextMismatch`) | `challenge_invalid` 落 verdicts | 题目侧错配方向(replay.rs 文档登记的响应面映射落定) |
| 运行时故障(谓词预算 / 内存护栏 / 版本锁定) | `challenge_invalid` 落 verdicts | D-W8-5 方向表 |
| 运行时故障(其余) | `engine_error` 落 verdicts | 同上 |
| 重放逐项一致,终态 `won` | `success` 落 verdicts | 判题语义 §五(won 只在检查点) |
| 重放逐项一致,`failed`(引擎结局标签可粗化) | `program_crash` / `memory_fault` / `resource_limit` / `engine_error` 落 verdicts | 判题语义 §七 classify 同源标签 |
| 重放逐项一致,非 won(failed 判题条件 / running / paused) | `wrong_answer` 落 verdicts | fail-closed:未达成成功条件不判成功 |

### 四·一、WP-62 增补:隐藏测试裁决与 11 值汇总合成(2026-09-12;主控预决策框架内成文)

**执行位置定案**:隐藏测试在 **vm-worker `verify` 命令内**执行——重放逐项比对完成后,在**重放终态**上由引擎侧判题驱动执行(`vm_core::judge::hidden::run_hidden_tests`,零第二实现):基线 = 重放终态,每测试独立克隆;`predicate_probe` 在基线上直接求值;`reference_payload` 经输入槽写入 + 运行至终止(预算 = 基线剩余全局步数);`classify_outcome` 7 值分类。引擎面为最小 additive 扩展:`vm_runtime::replay` 增 `replay_with_final`(返回重放终态运行时;既有 `replay()` 委托之,逐项比对语义零改动)+ `SessionRuntime::engine_mut` 只读装配面访问器;`vm-core` 判题语义零变更。交互期与重放期的执行形态差异即在此收口:判题语义规约 §七的"会话 settle 后由判题方驱动"在 verifier 面落为"重放 settle 完成后由 verify 命令驱动"——交互执行路径(host / SessionRuntime 动作循环)不执行隐藏测试,隐藏测试内容只存在于 vm-worker 进程内与 verdicts SERVER_ONLY 明细列。

**D-H2 边界维持**:双包 Schema v1 无输入槽声明,`JudgingContext.input_sink` 恒 `None`(D-W8-6 同款,装配复验对非空 `reference_payload` 载荷即拒)——verifier 不私扩契约面,通用输入槽增补走 WP-1 §1.3 契约变更流程(登记为非目标);v1 隐藏测试语料按 `predicate_probe` 形态制作(载荷空),空载荷 `reference_payload` 语料合法(基线克隆直接运行至终止)。

**11 值汇总合成规则**(失败方向优先 / fail-closed,沿判题语义规约 §1.1;交互 `won` / `failed` 与正式裁决相互独立的独立性锚 = 规则②):

- **①(终态失败优先)** 重放终态 `failed` ⇒ 引擎结局标签粗化(§四既有映射:`program_crash` / `memory_fault` / `resource_limit` / `engine_error`,其余 `wrong_answer`)**优先于**隐藏测试结论——fail-closed:交互期已失败的方向不被隐藏测试"救回"(也不被改写);
- **②(隐藏测试失败方向)** 终态非 `failed` 且任一隐藏测试判定 ≠ `expectedResult` ⇒ 失败方向 = 该测试 `classify_outcome` 值的映射(下表);任一隐藏测试失败即否定 `success`——**交互 `won` ≠ 强制 `success`**;
- **③(成功合成)** 隐藏测试全部通过 ∧ 终态 `won` ⇒ `success`;
- **④(非终态 fail-closed)** 隐藏测试全过 ∧ 终态非 `won`(`running` / `paused`)⇒ `wrong_answer`(未达成成功条件不判成功);
- **⑤(汇总执行面异常)** 隐藏测试驱动错误(基线谓词预算耗尽,当前驱动面唯一错误变体)⇒ `engine_error` 方向——与重放面谓词预算耗尽(`challenge_invalid`,§四行)有意区分:重放逐项比对已在预算内完成,耗尽发生在 verifier 汇总附加记账上,归裁决基础设施方向(非成绩、不自动重试、显式重提);判题语义规约 §1.3 的交互路径方向零改动,差异如实登记;
- 重放漂移 / 上下文错配 / 运行时故障路径:隐藏测试**不执行**(汇总面 `skipped`),裁决走 §四既有映射——汇总语义不参与。

**7 值 × 汇总矩阵(逐格可测;失败测试的 `classify_outcome` 值 → 11 值承载)**:

| 失败测试的 classify 值 | 汇总 verdict | 端到端可达性(v1) |
|---|---|---|
| `success`(条件达成但 ≠ 期望,如期望 crash) | `wrong_answer` | 可达(独立锚语料) |
| `wrong_answer` | `wrong_answer` | 可达 |
| `invalid_action` | `invalid_action` | **结构性不可达**(需输入槽 + 非空载荷,D-H2 边界;映射格由映射函数单测承载) |
| `program_crash` | `program_crash` | 可达 |
| `memory_fault` | `memory_fault` | 可达 |
| `resource_limit` | `resource_limit` | 可达 |
| `timeout` | `timeout` | **结构性不可达**(分类器不产生,worker 看门狗补充面;映射格由映射函数单测承载) |

**裁决细节零公开面**:verify 响应的隐藏测试汇总面仅含逐测试**索引 + classify 值 + expected 比对结论 + 总判定**——谓词内容、命中详情、testId 不进报告(判题语义规约 §1.5 载荷纪律的响应面延伸);verifier 落库 `verdicts.detail`(004 预留 JSONB 明细列,零新迁移)整体 SERVER_ONLY,零浏览器可达面(D-API-96)。

**裁决域审计发射**(D-API-90 三值,verifier 侧;发射矩阵与方向码封闭集 = D-API-95):裁决完成 ⇒ `verdict_completed`;重放失败(执行面故障 / 重试耗尽)⇒ `verdict_replay_failed`;拒裁(digest 复算不符 / 双包哈希不符 / 对象取回越权 / bundle lock 不一致 / 六记录项缺项等形态完备性事实)⇒ `verdict_rejected`(detail 携方向码,零秘密载荷)。发射与 run 处置**同事务**落库(append-only;审计失败即处置回滚,fail-closed 与 D-API-91 同构)。

**裁决幂等**(库层 + 队列层双层):`verdicts.submission_id` 唯一(005 迁移)+ complete 事务 `ON CONFLICT DO NOTHING`;认领 SQL 排除已有 verdicts 的 submission。同 submission 重复裁决确定性同判、不重复写入。

**重试语义**:run 失败(无法产生任何裁决的形态)以新 pending run 行承载重试,默认上限 3 次(`VERIFIER_MAX_RUN_ATTEMPTS`);耗尽后不再入队(同 submission 残留 pending 行一并收口),查询面恒为 pending(D-API-84 fail-closed 方向;`failed ≠ 非成绩裁决`)。

## 五、v1 seed 无应用面的边界登记(边界裁决 3)

- verifier 对 seed **零驻留**:不取快照、不持有快照密钥、不摄入会话种子;`verify` 请求的会话种子字段为协议预留受理位(v1 恒空——`fixed` 策略种子在包内,装配互斥闸自动拒绝携带);
- `server_random_per_session` 题目的提交在 v1 裁决面收敛为 `challenge_invalid`(种子不可得 ⇒ 重放自零起始不可达;零 worker 往返的确定性短路)——这是边界裁决 3"重放不摄入 seed 即可逐字节复现"在策略层面的机械化表达:**v1 生产题目集必须使用 `fixed` 种子策略**(WP-68 题目集制作纪律);
- D-J8(真实实例 ASLR)触发时裁决面随行演进(`replay_mismatch` 语义扩展派生路径复核),本决策不做任何预留实现。

## 六、已登记的实现期适配(与主控预决策的偏差,如实报告)

1. **"challenge_versions 登记 vmEngineVersion"的登记载体**:001 迁移的 `challenge_versions` 表实际登记的版本面为 `vm_profile_version` + 双包 SHA-256 摘要,无独立 `vm_engine_version` 列。定案落地为:**引擎版本的登记载体 = 私有包声明字节(其完整性由登记摘要担保)+ worker `ready` 自报互证**(bundle lock);不另立第二登记列——版本策略 §四.1"任何后续部署变更都产生新版本记录,而不改动既有记录",双列登记构成双真源。worker 装载期的同闸校验(`mirror.vmEngineVersion == VM_ENGINE_VERSION`)是结构性第二道防线;
2. **host 拓扑的角色治理降级**:容器拓扑下 verifier 使用独立 PG 角色(`verifier-db-init.sql` 最小授权)与独立 MinIO 最小授权用户(`verifier-minio-init.sh`,GetObject on `private-bundles/*` 与 `public-descriptors/*` 双桶——公开描述包是公开产物,双包各归其桶,001 迁移对象名语义);host 降级形态以依赖服务管理面凭证运行(角色治理脚本不适用于宿主进程),如实登记,CI 始终为完整容器拓扑;
3. **恢复会话提交的重放边界**:崩溃替换恢复(`replace_from_snapshot`)清空 worker 进程内动作日志,恢复后提交的 `export_action_log` 自快照 revision 起始——verify 的重放自零起始不可达,逐项比对确定性收敛为 `replay_mismatch`(fail-closed 方向;不静默放行、不判负)。日志分段时间线重放列为 T2 演进登记。

## 七、miri 扩展评估(阶段三验收评审 §六.11 承接;结论:**不新增 miri 面**)

**评估对象**:vm-runtime / projection 本包新增触达面(零引擎语义变更基线下的复用面加码)。

**评估范围与本 WP 实际变更的对照**:

| 变更 | 位置 | miri 评估 |
|---|---|---|
| `ReplayReport.final_status`(additive 字段) | vm-runtime `replay.rs` | 纯字段赋值(`VmStatus` Copy 语义),零新指针 / 索引 / 掩蔽算术;既有 `replay()` 比对路径不变,处于既有 miri 覆盖的调用图内 |
| `assemble_replay_config` 提取(纯重构) | vm-worker `session/assemble.rs` | 代码移动,零新语义;且 **vm-worker 不在 miri 门槛对象内**(miri 对象 = vm-core UB 敏感面,CLAUDE.md 门禁 4) |
| `verify` 命令面(装配 + 日志解析 + replay 委托) | vm-worker `session/verify.rs` | 消费 `ActionLog::from_canonical_text`(vm-runtime)——该解析面的 UB 敏感子操作(规范化 JSON 文法、整数域守卫、hex 解析)已在 `form_hardening` / `action_log_parse_rejects_drifted_payload` 红灯矩阵与 **cargo-fuzz `action_log_parse` 目标(本 WP 新增)** 承载;`canon` / `state_form` 的纯手写解析属 vm-runtime,为既有 miri 门槛边缘——评估结论:其新增暴露路径仅"不可信日志文本入站"(fuzz 已定向覆盖),无新增指针别名 / 未初始化内存 / 越界算术形态,不构成 miri 面扩张的触发证据 |
| projection | 零触碰 | — |

**结论**:不强制新增 miri 面。理由:(1) 本 WP 对引擎三 crate 的唯一语义变更是 `ReplayReport` 的 additive 只读字段;(2) 新增不可信输入面(动作日志文本)的防线是确定性解析拒绝(Err 不 panic),其无 panic 性质由 fuzz 定向机检(任意字节不 panic)与形态读回红灯矩阵共同承载——这正是 fuzz(解析面)与 miri(UB 面)的既有分工;(3) vm-worker 新增代码不在 miri 门槛对象内。**复核触发条件**:若 vm-runtime 的 `canon` / `state_form` 手写解析器进入 miri 门槛对象(引擎纪律演进),或动作日志解析引入指针级优化(零拷贝切片等),重启本评估。

## 八、cargo-fuzz 语料加码(同上承接;沿既有形态,比例适度)

- **新增目标 `action_log_parse`**(`vm-engine/fuzz/fuzz_targets/action_log_parse.rs`):字节 → UTF-8 → `ActionLog::from_canonical_text`(规范化语法 + `stackmaster-action-log/1` 形态 + 条目域复验)→ `hash_hex` 复算 → 序列化读回往返(哈希逐字节一致断言);判定纪律同既有三目标:任意字节不 panic、畸形必须 Err;
- **语料纪律**:不提交种子语料(动作日志属提交面内容,沿 `challenge_bundle` 目标"私有题目包样本永不入 git"的同源纪律),libfuzzer 空语料起步;
- 接线:`pnpm fuzz:smoke` 脚本与 CI `rust-fuzz` job 各增一条(60 s 限时冒烟,与既有目标同参数)。

## 九、tripwire 与复核条件

1. **ADR-8 tripwire 延伸**:verifier 复用面出现 Rust 产能摩擦(verify 命令面的语义演进持续受阻)时,按 ADR-8 §四重启评估流程;契约与 fixture 不变,TS 回退路线重新可议;
2. **队列形态 T2 复核**:多实例 verifier 规模化触发时复核 PG 轮询 ↔ LISTEN/NOTIFY(D-API-85 登记);观察面 = `verifier_queue_depth` / `verifier_verify_duration_seconds`(/metrics);
3. **重放吞吐**:裁决时延与队列深度数字进扩展评估报告(T2 判据输入;任务分解 §六风险表预案)。
