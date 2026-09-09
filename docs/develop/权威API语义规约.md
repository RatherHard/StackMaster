# 权威 API 语义规约(D-API 决策记录)

| 项 | 值 |
|---|---|
| 状态 | 实现期决策记录(阶段三起持续增补;WP-0 首批决策 2026-09-09,WP-8 收口全量) |
| 日期 | 2026-09-09 |
| 上游依据 | 计划书 5.3(运行时拓扑)、8.2(嵌入协议字段与接收校验)、8.3(请求护栏)、9.1(生命周期)、9.2(威胁模型);阶段三任务分解 WP-0~WP-8;会话动作协议语义(§5.1 / §5.2 / §九);嵌入协议 §六;WP-1 数据分类清单 §6.5–§6.7(v1.10) |
| 效力范围 | `apps/session-api`(信任域 2)的路由、通道、凭证链路与运维参数;与冻结契约冲突时以 `@stackmaster/protocol` 及上游文档为准 |

**变更纪律**:本文是实现期决策(D-API-*)的单一登记处,不是冻结契约;每条决策若触及冻结契约面(字段、枚举、语义),必须先走 WP-1 §1.3 契约变更流程再回填本文。阶段三各 WP 交付时在此登记其决策;阶段三验收评审(WP-8)逐条复核。

---

## 一、路由与通道形态

### D-API-1 动作通道 WSS-only;会话命令走 REST;HTTP 路由表为实现面文档(阶段三 WP-0 / WP-4 承接)

12 种动作**不设 REST 镜像端点**,只经认证 WSS 通道承载(5.3 拓扑:WSS 承载动作与增量下发;REST 面最小化)。五个会话级命令走 HTTPS REST(5.3:"HTTPS:会话生命周期、提交、embed token 签发")。若决策变更(动作增设 REST 镜像),须先改 WP-0 契约(阶段三任务分解 WP-4 完成标准)。

HTTP 路由表为**实现面文档登记**,不作 JSON Schema 契约(WP-0 冻结纪律);初始登记如下(WP-4 实现时如有调整,在此回填):

| 路由(形态示意) | 命令 | 请求体契约 | 成功响应契约 |
|---|---|---|---|
| `POST /sessions` | `create_session` | `SessionCommandRequest`(`create_session` 分支) | `SessionCommandResponse`(`create_session` 分支) |
| `POST /sessions/projection-sync` | `sync_projection` | `sync_projection` 分支 | `sync_projection` 分支 |
| `GET /sessions/checkpoints` | `list_checkpoints` | `list_checkpoints` 分支 | `list_checkpoints` 分支 |
| `POST /sessions/submissions` | `submit` | `submit` 分支 | `submit` 分支 |
| `POST /sessions/close` | `close_session` | `close_session` 分支 | `close_session` 分支 |

登记要点:会话定位以**请求体 `payload.sessionId` 为权威锚**(与凭证绑定三方比对),路径不携带会话标识——避免"路径 ID 与体 ID 双真源"及 URL 中会话标识经代理 / 访问日志扩散的面;`embed token` 签发端点(宿主后端 → session-api)归 WP-2 登记与实现。非 2xx 响应体 = 冻结 `PublicError` Schema(既有契约,零新增),HTTP 状态 ↔ 结果类型映射归 WP-4。

### D-API-2 WSS 传输帧随会话动作协议版本编号;连接级版本锚定(阶段三 WP-0)

`WssFrame` 是会话动作协议的传输面,不设第 5 类版本常量:`protocolVersion` 取值 = `SESSION_ACTION_PROTOCOL_VERSION`,受理集合锚点 = `SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS`(窗口期追加 N-1),N-1 窗口语义同会话动作协议语义 §5.2。**连接级锚定**:服务端以首帧 `protocolVersion` 为本连接的解释版本,此后任何帧携带其他版本一律拒绝(确定性 `PublicError` 错误帧);响应帧不携带新版本——信封按请求版本解释(语义文档 §5.2),故"版本协商"不存在独立握手消息,首帧即协商。

### D-API-3 会话凭证:claims 冻结、载体与交付面为实现决策(阶段三 WP-0 冻结字段面;WP-2 / WP-5 落地)

契约冻结面 = `SessionCredentialClaims` 七字段签名前集合(`@stackmaster/protocol/server-only`;WP-1 清单 §6.6)。实现决策:

- **签名载体**:WP-2 从 JWT(EdDSA / ES256)与 PASETO v4.public 中择一;候选约束:密钥仅域 2、可装下七字段 claims、签发 / 校验仅后端可达。落地时在此回填选择与理由;
- **交付面**:create-session 响应**不携带凭证字段**(契约冻结纪律,WP-1 §6.5);凭证经 HTTP 响应头(如 `Set-Cookie`,带 `HttpOnly` + `Secure` + CSRF 防护)或等价头机制交付;**禁入 URL query、禁入日志、禁入错误响应**(WP-2 传输卫生)。WSS 升级前的凭证呈递候选:Cookie(浏览器 WebSocket 无法自定义请求头)或 `Sec-WebSocket-Protocol` 承载;WP-5 择一并回填;
- **TTL**:签发 TTL ≤ `MAX_SESSION_CREDENTIAL_TTL_SECONDS`(86400 s 外圈护栏);推荐 ≤ 会话 wall-clock 预算(3600 s)+ 续期余量,具体值 WP-2 配置化落地时回填;
- **token 消费失败响应面**:统一失败形态防枚举(过期 / 已消费 / 绑定不符不区分,细节仅入受控日志与审计)——WP-2 实现时按此执行并回填红灯矩阵锚点。

## 二、版本窗口与幂等窗口(协议 §5.2 / §4.3 的"实现期参数"承诺兑现)

### D-API-4 N-1 版本窗口与幂等窗口 TTL 运维参数(阶段三 WP-0 定约定与默认值;WP-4 配置化生效)

| 参数 | 默认值 | 约束与语义 | 生效 |
|---|---|---|---|
| 版本受理集合 | `SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS`(当前 `[1]`) | 冻结期恒含当前版本;破坏性变更窗口期追加 N-1,REST 命令体与 WSS 帧共用(各按其版本 Schema 独立校验) | WP-4(REST)/ WP-5(帧)按集合路由 |
| N-1 窗口时长 | 90 天 | 配置键 `SESSION_PROTOCOL_N1_WINDOW_DAYS`;`0` = 立即下线旧版(无发布压力期禁用);窗口结束移除受理集合中的 N-1 | WP-4 启动校验读取 |
| 幂等窗口 TTL | 300 s | 配置键 `IDEMPOTENCY_WINDOW_TTL_SECONDS`;语义不变(D-W8-9:`(sessionId, key)` 规范化负载比较,同键同负载字节相同重放、异负载确定性拒绝)——窗口是效率设施,正确性由 `baseRevision` 与串行保证(§4.3) | WP-3 持久化面切换 Redis 后端时配置化,进程内实现同键读取 |

窗口期满下线旧版属部署动作,不递增任何版本号;两参数均须过启动校验(缺失 / 非法即拒绝启动,fail-closed,沿 WP-1 工程载体纪律)。

## 三、通道行为

### D-API-5 传输层序号与关联 ID 的语义边界(阶段三 WP-0)

WSS 帧 `seq` 与 `requestId` 只承担**传输层关联与诊断**:帧序 = 执行序(权威序即到达序,单会话串行语义文档 §4.4),防重放与串行确认由载荷内 `clientSeq` / `idempotencyKey` / `baseRevision` 承担——传输层序号不重复、不替代、不兜底协议语义(避免双真源)。`seq` 允许跳号(控制通道不要求稠密);接收端高水位检查为可选诊断,不得以"seq 乱序"为由拒绝一个载荷层合法的动作(权威判定只在载荷层)。帧 `requestId` 为发送方生成、响应对应帧回显;与 `ActionResponse.requestId`(服务端生成,载荷层)语义独立,两者不复用同名值空间。

### D-API-6 心跳与空闲:RFC 6455 协议层 ping/pong,不设应用层心跳帧(阶段三 WP-0)

`WssFrame.type` 封闭为三值(`action` / `action_response` / `error`),心跳/保活走 WebSocket 协议层 ping/pong 帧与空闲超时(实现归 WP-5:升级后服务端定期 ping,pong 超时判定空闲并断开,断开走断线恢复路径)。应用层保活消息会扩大帧类型面并给"探测会话存活粒度"增加信号面,故不入契约;扩展消息类型 = 协议版本演进。

### D-API-7 contract-smoke 覆盖面不变的理由(阶段三 WP-0 边界声明落档)

WP-0 新增四根 Schema(会话命令请求 / 响应、WSS 帧、会话凭证 claims)不加入 `tooling/contract-smoke` 的 §2 实例校验映射(`PROTOCOL_CONTRACTS`):新契约面**终止于编排器(TS 侧闭环)**——消费方是阶段三 `apps/session-api`(Fastify / Zod 同源校验),Rust 引擎进程协议 v1 零消费、版本号不动(阶段三任务分解 WP-0 边界声明)。跨语言机检不因此缺位:全部新增 fixture 照常进入 §3 规范化摘要清单(`fixtures:manifest` 遍历全部 fixture,Rust 侧逐条复算,178 条比对含 WP-0 新增 44 个);§1 Schema 编译遍历 `packages/protocol/schema/*.schema.json` 全量,新 Schema 的 2020-12 可编译性(serde + schemars 可消费的结构形态)照常被验证。若未来 verifier(阶段六)需要消费会话凭证或命令契约,按 WP-1 §1.3 流程扩 §2 映射并补 serde 镜像。

### D-API-8 命令记法同义映射(阶段三 WP-0)

计划书 9.1 与会话动作协议语义 §5.1 以连字符记法书写命令(create-session / sync-projection / list-checkpoints);wire 契约枚举取 snake_case(`create_session` / `sync_projection` / `list_checkpoints` / `submit` / `close_session`),与 12 动作 `type`(`write_bytes` / `run_to_event` / `checkout_checkpoint`)同记法。两套记法是同一命令集的排版变体,语义无差;文档与代码各自沿用其惯例,不作机器转换面的依据。

## 四、登记中的决策(后续 WP 回填)

以下决策点已在阶段三任务分解 §六登记,由对应 WP 交付时在此回填;WP-0 只冻结其契约前提:

| 决策点 | 承接 WP | 契约前提(WP-0 已冻结) |
|---|---|---|
| token 消费失败响应面细节、CORS / Cookie 卫生 | WP-2 | D-API-3 统一失败形态;`SessionCredentialClaims` 七字段 |
| 快照加密层级、Redis 分级降级、幂等缓存后端 | WP-3 | D-API-4 幂等 TTL 配置键;快照 SERVER_ONLY blob 只存取不解析(D-W8-11) |
| HTTP 状态 ↔ 结果类型映射、请求护栏数值 | WP-4 | D-API-1 路由表;错误响应 = 冻结 `PublicError` |
| 断线保持窗口、多连接策略、背压、WSS 频率限制 | WP-5 | D-API-2 连接级版本锚定;D-API-6 心跳;帧载荷纯复用 |
| 限流默认值、checkpoint 配额数值 | WP-6 | 协议外圈护栏 `MAX_CHECKPOINTS_PER_SESSION`(配额必须 ≤ 协议上限) |
| 指标标签纪律、k6 场景 | WP-8 | —— |
