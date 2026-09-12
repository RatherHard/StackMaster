# 权威 API 语义规约(D-API 决策记录)

| 项 | 值 |
|---|---|
| 状态 | 实现期决策记录(阶段三起持续增补;WP-0 首批决策与 WP-1 工程载体纪律 D-API-9 2026-09-09;WP-2 认证与凭证面 D-API-10~D-API-19 2026-09-10;WP-3 持久化面 D-API-20~D-API-26 2026-09-10;WP-4 REST 生命周期路由与请求护栏 D-API-30~D-API-39 2026-09-10;WP-5 认证 WSS 通道与投影下发 D-API-40~D-API-49 2026-09-10;WP-6 限流、配额与会话资源回收 D-API-50~D-API-59 2026-09-10;WP-8 可观测基线、部署收尾 D-API-70~D-API-73 2026-09-10,阶段三全量收口;阶段四 WP-40 / WP-41 调试通道面 D-API-74 2026-09-11 增补;阶段五 WP-50 嵌入交付通道与描述包下发 D-API-75~D-API-77 2026-09-11 增补;**阶段五 WP-51~54 嵌入实现面 D-API-78~D-API-82 2026-09-12 增补(实现期定案收编,全部零契约改动)——既有 D-API-1~77 条目零改动**;**阶段六 WP-60 裁决呈现通道与异步裁决语义 D-API-83~D-API-86 2026-09-12 增补(契约先行:阶段六边界裁决 2 候选新契约面 (a) 落位,protocol 契约增量 `verdict-query-response` 同步冻结——既有 D-API-1~82 条目与既有契约面零改动**) |
| 日期 | 2026-09-10(阶段三全量);2026-09-11 增补 D-API-74(阶段四);2026-09-11 增补 D-API-75~D-API-77(阶段五 WP-50);2026-09-12 增补 D-API-78~D-API-82(阶段五 WP-51~54);2026-09-12 增补 D-API-83~D-API-86(阶段六 WP-60) |
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
| `POST /sessions/checkpoints`(WP-4 调整:GET → POST,见 D-API-30) | `list_checkpoints` | `list_checkpoints` 分支 | `list_checkpoints` 分支 |
| `POST /sessions/submissions` | `submit` | `submit` 分支 | `submit` 分支 |
| `POST /sessions/close` | `close_session` | `close_session` 分支 | `close_session` 分支 |
| `GET /sessions/channel`(WebSocket 升级;WP-5 增补行,见 D-API-40) | 12 动作(`action` 帧) | `WssFrame`(`action` 分支) | `WssFrame`(`action_response` / `error` 分支,按帧下发) |

登记要点:会话定位以**请求体 `payload.sessionId` 为权威锚**(与凭证绑定三方比对),路径不携带会话标识——避免"路径 ID 与体 ID 双真源"及 URL 中会话标识经代理 / 访问日志扩散的面;`embed token` 签发端点(宿主后端 → session-api)归 WP-2 登记与实现。非 2xx 响应体 = 冻结 `PublicError` Schema(既有契约,零新增),HTTP 状态 ↔ 结果类型映射归 WP-4。

**WP-2 增补(2026-09-10)**:签发端点已实现并登记为 **`POST /auth/embed-tokens`**(服务端间行:宿主后端 bearer 认证,非浏览器面;请求 / 响应体形态与拒绝面见 D-API-11 / D-API-14 / D-API-15)。

**阶段五 WP-50 增补(2026-09-11)**:公开描述包下发端点登记为 **`GET /descriptors/:challengeId/:version`**(公开内容行:无凭证 GET、零会话标识、challengeId / version 均为公开内容定位符可入路径;服务序与拒绝面见 D-API-76):

| 路由(阶段五 WP-50 增补行) | 命令 | 请求体契约 | 成功响应契约 |
|---|---|---|---|
| `GET /descriptors/:challengeId/:version` | ——(公开内容读取,非会话命令) | 无(路径参数:challengeId 冻结标识符字符集、version 语义化版本字符集,违规同形 404) | 描述包 JSON 原始字节(`application/json`;`ETag` = 登记摘要;体 = `public-descriptors` 桶对象,逐字节确定性) |

**阶段六 WP-60 增补(2026-09-12)**:裁决查询端点登记为 **`GET /verdicts/:submissionId`**(D-API-83 定案;会话凭证同模型、租户 / 用户归属校验,载荷契约 `VerdictQueryResponse`):

| 路由(阶段六 WP-60 增补行) | 命令 | 请求体契约 | 成功响应契约 |
|---|---|---|---|
| `GET /verdicts/:submissionId` | ——(裁决查询,非会话命令) | 无(路径参数 submissionId 冻结标识符字符集,违规同形 404) | `VerdictQueryResponse`(`@stackmaster/protocol`,`…/schemas/verdict/v1`;pending / verdicted 两态;非 2xx = 冻结 `PublicError`) |

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

## 三·二、工程载体纪律(阶段三 WP-1)

### D-API-9 session-api 进程骨架:配置 fail-closed、日志纪律、优雅停机、错误响应面兜底(阶段三 WP-1)

`apps/session-api` 工程载体(WP-1)固定四项进程纪律,后续 WP(WP-2 ~ WP-8)在此骨架上装配,不得绕开:

**1. 配置加载与启动校验(fail-closed)**——启动校验三道闸,任一不过即非零退出,进程不监听:
- 必备键缺失:`SESSION_API_` 前缀的必备键登记表(代码内 `REQUIRED_ENV_KEYS`)中的键未提供即拒绝。WP-1 骨架期表为空;WP-2 登记凭证签名密钥、WP-3 登记存储端点时逐项补入;
- 未知保留键:`SESSION_API_` 是本应用保留命名空间,出现未登记键(拼写错误)即拒绝,不静默落默认值;
- 取值非法:类型 / 范围 / 枚举校验,含 D-API-4 两键。校验失败消息只含字段名与原因,绝不含字段值(错误面不得成为密钥外泄通道)。

配置键面:`SESSION_API_HOST`(默认 `127.0.0.1`,安全默认——不公开监听)、`SESSION_API_PORT`(默认 3000;`0` = 临时端口,仅 `NODE_ENV=test` 合法,供集成测试随机端口)、`SESSION_API_LOG_LEVEL`(默认 `info`)、`SESSION_API_LOG_ERROR_STACKS`(严格 `true`/`false`,默认 `false`)、`SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS`(默认 10 s,上限 300 s)、`SESSION_PROTOCOL_N1_WINDOW_DAYS` 与 `IDEMPOTENCY_WINDOW_TTL_SECONDS`(D-API-4,默认 90 天 / 300 s;`SESSION_PROTOCOL_N1_WINDOW_DAYS=0` = 立即下线旧版,为合法取值)。空字符串环境变量一律按"未提供"处理(容器编排占位形态)。

**2. 日志纪律(Pino;计划书 5.8 / 9.1,ZR-B7 服务器侧)**——字段纪律:requestId(请求级,首等字段)、sessionId / tenantId / revision 经白名单化子 logger 绑定(`withSessionFields`),防字段命名漂移。redaction 三层:私有包内容、seed / flag 语料、凭证令牌绝对禁入日志(pino redact 路径表兜底浅层误放,主控制是"永不记录请求 / 响应体原文与头部"的调用纪律,req 序列化器白名单只放行 method / url);内部堆栈与文件路径不入日志(err 序列化器只保留 type + message;`SESSION_API_LOG_ERROR_STACKS` 为受控排障的显式演进开关,默认关闭——较计划书 429 行"内部堆栈只进受控日志"取更严形态,受控通道的按需开启即"受控"语义);错误细节不经 HTTP 响应外流。日志 `base` 覆盖默认 pid / hostname(基础设施指纹不入日志)。

**3. 优雅停机(SIGTERM → 停止接单 → 在途会话状态落盘 → 退出)**——停机步骤按注册顺序执行:`stop-accepting-requests`(fastify close,在途请求完成)→ 在途会话状态落盘(WP-3 持久化面注册真实步骤)→ `flush-logs`;全部成功退出码 0,任一步骤失败或超过 `SESSION_API_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS` 强制退出码 1。重复信号不重入。**Windows 触发通道**:Windows 无 POSIX 信号投递(`process.kill` 等价 `TerminateProcess`,处理器不运行),故并行接受 IPC 通道的 `shutdown` 消息触发同一序列——供 Windows 本地与 CI 的进程级集成测试使用;生产面(容器 SIGTERM)不受影响。

**4. 错误响应面兜底(基线 #8 的骨架锚点)**——未匹配路由(404)、框架级 4xx(如畸形 JSON)、未捕获错误(500)一律以冻结 `PublicError` 形态响应(粗化级:`invalid_input_format` / `internal_error` + 静态最小文案),零框架细节、零校验器细节透出,细节只进受控日志;错误载荷常量在装配期过冻结 Schema 自检,契约漂移即拒绝启动。HTTP 状态 ↔ 冻结结果类型的完整映射矩阵仍归 WP-4(D-API-1),本决策只固定兜底底线。请求 ID:接受客户端 `x-request-id` 但只接受冻结标识符字符集(语义文档 §2.1),非法或缺失即服务端生成;响应头回显同一值(与日志 `reqId` 单一真源),客户端输入永不原样进入日志字段。

**5. 健康检查**——`GET /healthz` 为 liveness(骨架期无外部依赖,恒 200);readiness 随 WP-3 存储依赖落地时引入,不在本决策冻结。

## 三·三、认证与凭证面(阶段三 WP-2;D-API-10 ~ D-API-19)

### D-API-10 凭证签名载体:JWT + EdDSA(Ed25519);载荷 = 七字段 claims + exp(阶段三 WP-2)

embed token 与会话凭证统一以 **JWT / EdDSA(Ed25519)** 签发与校验(jose 库,Node WebCrypto)。选型理由:PASETO 无同等维护度;JWT + EdDSA 经 jose 的算法锁定(`algorithms: ["EdDSA"]` + 显式公钥注入)结构性排除 alg 混淆与降级。契约边界不变:`SessionCredentialClaims` / `EmbedTokenClaims` 七字段冻结面是**签名前 claims 集合**,JWT 标准保留字段只引入 `exp`(与 claims.expiresAt 同值,epoch 秒;签发不写 iat / iss / aud / nbf),使载体载荷可按"`claims ∪ {exp}` 的 strictObject"逐字段严格校验——多余字段即形态非法(malformed)。密钥仅信任域 2:`SESSION_API_SIGNING_KEY`(Ed25519 PKCS#8 PEM)经配置三道闸启动校验(createPrivateKey 解析 + 密钥类型断言,fail-closed);装配期 `createTokenSigner` 同时导入私钥(签发)与公钥(校验),verify 路径无签名能力。verify 失败以确定性异常类型表达:kind 三值封闭 `expired` / `signature_invalid` / `malformed`——kind 只进受控日志与审计,不进响应面。载体长度外圈护栏复用 `EMBED_TOKEN_MAX_LENGTH`(4096,会话凭证同值);签发面后置断言超限即抛错,超限载体永不外发。

### D-API-11 embed token 交付面:签发端点响应体 JSON(阶段三 WP-2)

签发端点(宿主后端 → session-api)登记为 **`POST /auth/embed-tokens`**(D-API-1 路由表的服务端间补充行,不属浏览器面)。成功响应 `201`,体为 `{"embedToken": <JWT>, "expiresAt": <epoch 秒>}`——接收方是宿主后端服务器(非浏览器),响应体 JSON 即可;token 不进 URL query(POST 体交付)、不经 postMessage 下发(交付通道归阶段五)、不入日志(req 序列化器白名单)与错误响应。响应体零多余字段(不回显 jti / claims 复述)。

### D-API-12 会话凭证交付面:Set-Cookie(HttpOnly + Secure + SameSite=Strict + Path=/sessions);WSS 沿用 Cookie(阶段三 WP-2;WP-5 落地)

create-session 通过三方比对后,会话凭证经 **`Set-Cookie`** 交付(cookie 名 `sm_session_credential`):`HttpOnly`(浏览器脚本不可读,插件 iframe 在选手控制域内)+ `Secure`(仅 HTTPS 传输)+ `SameSite=Strict`(跨站请求不携带)+ 精确 `Path=/sessions`(仅覆盖五个会话命令路由族,签发端点与其他路径不可见——最小暴露面)。不采用 `__Host-` 前缀:该前缀被浏览器强制要求 `Path=/`,与精确 Path 的最小暴露面诉求冲突。**WSS 升级呈递落定 D-API-3 的 Cookie 候选**:浏览器 WebSocket 无法自定义请求头,WP-5 的升级握手从 Cookie 读凭证(经统一认证入口 `authenticateSessionCredential`);WSS 路由必须位于 Cookie Path 覆盖之下,否则需在装配时调宽 cookie path 参数。

### D-API-13 Secure 属性的 NODE_ENV=test 豁免(阶段三 WP-2)

`Secure` 属性在 `NODE_ENV=test` 下豁免(不写该属性),使 fastify inject 的 http 注入测试可覆盖 Cookie 呈递链路;`NODE_ENV` 为 `development` / `production` 时恒写 `Secure`(浏览器只经 HTTPS 回传)。豁免仅以进程环境变量为锚,不引入额外配置面。

### D-API-14 token 消费顺序、单次消费语义与统一拒绝响应面(阶段三 WP-2)

**消费顺序**(嵌入协议 §六的实现化):①签名验证(域 2 密钥 + exp)→ ②`jti` 单次原子消费(签发记录存在即删除并返回;删除即消费,与比对顺序解耦,保证并发下至多一方成功)→ ③签名 claims × 签发记录比对(tenantId / userId / challengeId / challengeVersion / embedSessionId / expiresAt 六元组全等——租户 / 用户以签发时宿主凭证担保的存储记录为锚,不采信请求体自报)→ ④请求上下文 × claims 比对(create-session 载荷的 challengeId / challengeVersion / embedSessionId)。记录不存在(未签发 / 已消费 / 已吊销 / 记录过期)在端口面同形(`consume` 返回 null),拒绝面因此天然不可区分。

**统一失败响应面(防枚举)**:一切 token 消费失败与凭证校验失败(过期 / 已消费 / 绑定不符 / 伪造 / 吊销后使用 / CSRF 拒绝)恒为 **401 + 冻结 `PublicError` 单一错误码 + 静态文案**:`{"code": "invalid_input_format", "message": "authentication failed"}`——同状态、同码、同文案,响应体字节级一致。选码理由:16 个冻结码中 `permission_denied` 的能力矩阵强制 `addressHex = required-real`(教学解释锚点),认证场景无地址语境不可用;`invalid_input_format` 是唯一 coarse 级、`addressHex` 禁止、可无解释的协议级拒绝码,与 WP-1 骨架错误面(server.ts)同码。拒绝细节以封闭 reason 枚举(如 `expired` / `unknown_jti` / `record_mismatch` / `context_mismatch` / `revoked` / `session_binding` / `csrf_origin`)只进受控日志与审计 detail。

### D-API-15 签发端点宿主认证:Bearer 共享凭证,常数时间比较,先认证后校验体(阶段三 WP-2)

宿主后端以 `Authorization: Bearer <SESSION_API_HOST_BACKEND_TOKEN>` 认证(服务端间共享凭证,嵌入协议 §6.1)。比较取双侧 sha256 摘要后 `timingSafeEqual`——长度差异折叠进摘要比较,不透出长度侧信道。**无凭证 / 错凭证一律统一 401(D-API-14 形态),且先于请求体校验**——未认证方不得以 400 / 401 差异探测请求体字段有效性。已过认证后,请求体按 strictObject 契约(tenantId / userId / challengeId / challengeVersion / embedSessionId,五字段冻结形态)校验,失败 = 400 + 冻结 `{"code": "invalid_input_format", "message": "invalid request"}`,校验器细节(字段路径 / issue 计数之外的一切)只进受控日志。

### D-API-16 CORS:@fastify/cors 精确来源白名单,空表 = 一律不放行(阶段三 WP-2)

`SESSION_API_ALLOWED_ORIGINS`(逗号分隔精确来源,`scheme://host[:port]` 形态,禁通配 / 禁路径 / 禁尾斜杠)驱动 `@fastify/cors` 数组精确匹配:仅命中请求回显 `Access-Control-Allow-Origin`,并恒带 `Access-Control-Allow-Credentials: true`(Cookie 呈递所需)。**配置缺省(空表)= 不放行任何跨源**(fail-closed 默认;浏览器面全拦,非浏览器调用方——宿主后端——不受 CORS 影响)。跨源拒绝以"不回 ACAO 头"表达,不透出任何配置细节。

### D-API-17 CSRF 防护:Cookie 呈递 + 变更方法 ⇒ Origin 必须命中精确白名单(阶段三 WP-2)

SameSite=Strict 为第一层;第二层在凭证校验中间件:**Cookie 呈递 + 变更方法(POST / PUT / PATCH / DELETE)时,`Origin` 头必须精确命中 `SESSION_API_ALLOWED_ORIGINS`**(与 CORS 共用一表),缺失、为空或不符即统一 401(D-API-14 形态,reason = `csrf_origin`)。Bearer 呈递(服务端间 / 非浏览器)不受 CSRF 向量影响,不走本闸。GET / HEAD / OPTIONS 不适用。

### D-API-18 认证端口形状与适配语义:原子单次消费 = GETDEL/Lua,审计 append-only(阶段三 WP-2;WP-4 接 Redis/PG)

WP-2 交付三个端口 + 内存默认实现(`apps/session-api/src/auth/`):`TokenIssuanceStore`(`put` / `consume` / `revoke`;键域 `token:{jti}`,删除即吊销)、`CredentialRevocationStore`(`revoke(jti, ttl)` / `isRevoked`;会话凭证 jti 吊销键,TTL ≥ 凭证剩余有效期)、`AuditSink`(`append(event)`;kind 七值封闭:embed_token_issued / embed_token_consumed / embed_token_revoked / session_credential_issued / create_session / submit / session_force_closed;detail 仅非秘密标量,零凭证材料)。**WP-4 适配约束**:①`consume` 是**原子单次消费**——Redis 适配器须以 `GETDEL` 或 Lua 等价语义实现,不得退化为"读后删"两步(Redis 不可用时该端口 fail-closed,不降级);②AuditSink 的 PG 落库实现须保持 append-only 端口语义(无更新 / 删除路径,数据库层强制方式归 WP-3 的 D-API 决策);③内存实现仅供测试与未接线期(InMemoryAuditSink 以深冻结对象表达 append-only,无容量上限,不得用于生产常驻)。

### D-API-19 认证面配置键登记:五键 + 必备两键(阶段三 WP-2)

| 键 | 必备 | 默认 | 约束 |
|---|---|---|---|
| `SESSION_API_SIGNING_KEY` | 是 | —— | Ed25519 私钥 PKCS#8 PEM;启动期 createPrivateKey 解析 + 密钥类型断言,失败拒绝启动(消息仅字段名与结构原因,绝不回显取值) |
| `SESSION_API_HOST_BACKEND_TOKEN` | 是 | —— | 签发端点宿主共享凭证(bearer);最低长度 16 字符 |
| `SESSION_API_ALLOWED_ORIGINS` | 否 | 缺省 | 逗号分隔精确来源(禁通配 / 路径 / 尾斜杠);缺省 = 不允许任何跨源(D-API-16) |
| `SESSION_API_EMBED_TOKEN_TTL_SECONDS` | 否 | 3600 | 上限 `MAX_EMBED_TOKEN_TTL_SECONDS`(604800);即签发记录 TTL |
| `SESSION_API_SESSION_CREDENTIAL_TTL_SECONDS` | 否 | 3600 | 上限 `MAX_SESSION_CREDENTIAL_TTL_SECONDS`(86400);推荐 ≤ 会话 wall-clock 预算 + 续期余量 |

五键均过配置三道闸(D-API-9);键名带 `SESSION_API_` 前缀,受未知保留键闸校验。

## 三·四、持久化面(阶段三 WP-3;D-API-20 ~ D-API-26)

### D-API-20 PostgreSQL 表域与查询层租户校验(阶段三 WP-3)

表域按计划书 5.7 落地(`apps/session-api/migrations/` 顺序 SQL + 最小 runner `runMigrations`:记录表 `_session_api_migrations` + 会话级咨询锁 + 逐迁移事务,重复执行幂等):题目域 `challenges` / `challenge_versions`(版本链、双包 SHA-256 摘要与 Ed25519 登记签名、对象存储对象名;版本不可变,重复登记确定性拒绝)、会话域 `sessions`(sessionId / tenantId / userId / challengeId / challengeVersion / phase / seed 策略元数据 / 快照锚)与 `checkpoints`(COW 快照密文 blob,origin ∈ {explicit_checkpoint, auto_periodic, session_close})、动作域 `action_log`(append-only、PARTITION BY RANGE (created_at),DEFAULT 分区兜底,月度分区经 `createActionLogPartition` 预建)、裁决域 `submissions`(内部裁决引用)+ `verdicts` / `verifier_runs`(阶段六写入,本阶段零写入)。全部表带租户作用域列;**查询层租户校验强制**:一切按会话定位的查询 WHERE 强制 `tenant_id`(跨租户与"不存在"同形态返回空,防枚举),行级策略归阶段六完善。`checkpoints` 的 DELETE 仅由保留期清理(`purgeExpired`)sanction。

### D-API-21 快照加密层级:应用层整包加密 AES-256-GCM(阶段三 WP-3;D-W8-11 收口)

加密层级取**应用层整包加密**:快照信封(worker 所有 SERVER_ONLY blob,含 `seedState`)在编排器落库前整体序列化为字节并经 AES-256-GCM 加密,PostgreSQL 行内只存密文字节——不依赖存储级加密的部署正确性,备份 / 迁移即密文;密文不参与任何确定性断言(I-4 作用于响应面,nonce 现场随机)。密钥来源 = 环境变量 `SESSION_API_SNAPSHOT_ENCRYPTION_KEY`(base64 的 32 字节;启动校验长度,缺失 / 非法即拒绝启动 fail-closed;错误消息仅字段名与结构原因);密钥管理服务(KMS)与轮换归部署面演进(WP-8)。编排器对快照**只存取不解析**:SnapshotStore 端口进出皆密文,加解密在 SnapshotCipher,快照字段零语义读取(seedState 随信封整体移交 worker)。`challenge_versions` 摘要为 SHA-256(单向,不构成秘密面)。配置键:必备六键 `SESSION_API_POSTGRES_URL` / `SESSION_API_REDIS_URL` / `SESSION_API_MINIO_ENDPOINT` / `SESSION_API_MINIO_ACCESS_KEY` / `SESSION_API_MINIO_SECRET_KEY` / `SESSION_API_SNAPSHOT_ENCRYPTION_KEY`;可选 `SESSION_API_MINIO_PORT`(9000)/ `SESSION_API_MINIO_BUCKET_PRIVATE`(private-bundles)/ `SESSION_API_MINIO_BUCKET_PUBLIC`(public-descriptors)。

### D-API-22 快照密文信封格式与 action_log append-only 强制层(阶段三 WP-3)

**密文信封** `stackmaster-session-snapshot-encrypted/1`:`[4B 魔数 "SMEN"][1B 格式版本][12B GCM nonce][密文 …][16B authTag]`;魔数仅供机检区分密文 / 明文 blob(ZR-B5 存储面),不承载语义;认证失败(密钥不符或篡改)确定性拒绝且不区分原因(防篡改探测)。

**append-only 强制层取数据库层触发器**:`action_log` 上 `BEFORE UPDATE / DELETE`(行级)+ `BEFORE TRUNCATE`(语句级)触发器一律 `RAISE EXCEPTION`——应用连接角色无论权限配置,变更一律在库内被拒(红灯反例:`migrations-appendonly.integration.test.ts` 三连);`REVOKE UPDATE/DELETE` 的应用角色治理归阶段六部署面作第二层。应用层同构:ActionLogStore 端口仅暴露 append 与查询,无变更路径。落库纪律:仅已接受动作(拒绝不入账,D-W8-9 编排器账本同源)、单语句批量插入、与 submit 引用同锚(`submission_ref` 列)。

### D-API-23 seed 零驻留持久化边界与题目登记路径(阶段三 WP-3)

**seed 边界**:`sessions` 行只存 seed 策略元数据(`seed_strategy`),任何存储不存 seed 值;seed 的唯一合法持久化落点是加密快照内的 `seedState`(密文静止)。`server_random_per_session` 会话的编排器重启恢复:load 步使用**现场再生成的一次性种子**(仅瞬时存在于 load 帧构造,不落任何存储),随后 `import_snapshot` 以快照 seedState **整体替换**全部内容状态(快照与回放语义规约 §三 replace_from_snapshot),原始会话种子不参与恢复;`fixed` 策略种子在包内,恢复 load 不携带种子。

**题目登记路径最小实现**(批量制作归 MVP 期):双包 SHA-256 摘要 → 登记签名校验(Ed25519 over `stackmaster-challenge-registration/1` 确定性基线 = form / challengeId / contentVersion / vmProfileVersion / 双摘要,验签公钥经适配器构造注入,fail-closed:无公钥或验签失败一律拒绝)→ 双包入对象存储(私有判题包 → `private-bundles` 桶:服务端专用、桶策略拒绝匿名、静态加密由部署面启用 MinIO SSE-KMS;公开描述包 → `public-descriptors` 桶,CDN 发布与签名 URL 归阶段五)→ 版本行落 PG(版本不可变)。对象命名 `{challengeId}/{version}/{bundle|descriptor}.json`,challengeId 走冻结标识符字符集、version 走 semver 字符集(禁路径穿越)。

### D-API-24 Redis 分级降级与幂等窗口后端切换(阶段三 WP-3)

Redis 键域四键域全部带 TTL、可重建、不作权威(ADR-4)。**可用性分级**(策略表 `REDIS_DEGRADE_POLICY` 即裁决点):

| 依赖 | 分级 | 理由 |
|---|---|---|
| 幂等窗口 `idem:{sessionId}:{key}` | **可降级进程内**(粘性;ResilientIdempotencyWindow) | 窗口是效率设施,正确性由 baseRevision 与单会话串行保证(协议 §4.3);降级只损失跨实例共享窗口 |
| `token:{jti}`(WP-2 经 KeyValueStore 消费) | **fail-closed** | jti 单次消费是凭证重放防线(D-API-18 原子单次消费);降级即语义破坏 |
| `route:{sessionId}` | **fail-closed** | 会话路由定位是投递一致性控制,降级造成双属主投递歧义 |
| `rate:{tenant}:{user}` | **fail-closed** | 限流计数是资源保护控制;数值策略归 WP-6 |

fail-closed 路径确定性:依赖故障翻译为稳定错误码 `store_unavailable` 立即上抛(ioredis `enableOfflineQueue: false` + ready 门),不静默放行;幂等窗口降级后同接口同语义(fresh / replay-identical / conflict / TTL 过期 → fresh)。**幂等缓存后端切换**:进程内(阶段二)→ Redis Lua 原子"比较并登记"(同键同规范化负载 → 字节相同重放裁决;同键异负载 → conflict);键命名 `idem:{sessionId}:{encodeURIComponent(key)}`(幂等键为客户端输入,编码保形防键分隔符注入);TTL = `IDEMPOTENCY_WINDOW_TTL_SECONDS`(D-API-4,默认 300 s),**固定窗口自首次登记起算、重放不续期**(无限重试不得到无限窗口);session-core 的进程内幂等缓存不动(编排核心零改动),Redis 窗口是编排器前置的应用层守卫,装配归 WP-4。

### D-API-25 恢复点策略、自动快照与保留期(阶段三 WP-3)

重启恢复粒度取**恢复到最近快照丢尾**(客户端 sync-projection 对齐;实现小、与崩溃替换恢复同构),动作日志重放追尾列为演进项。恢复点三触发点:①显式 checkpoint(create_checkpoint 回执即快照);②**周期性自动快照**——每 N revision 触发,`SESSION_API_AUTO_SNAPSHOT_EVERY_REVISIONS` 默认 50(AutoSnapshotPolicy 纯策略,装配归 WP-4);③会话关闭(close-session 前落终快照)。`checkpoints.origin` 列区分三触发点。**快照保留期**:`SESSION_API_SNAPSHOT_RETENTION_DAYS` 默认 30 天(计划书 5.7"默认较短"),由 `purgeExpired` 执行(运维定时调用)。恢复流程:.sessions 行(租户强制)→ 版本行 → 双包取回 → 最近密文快照解密 → 产出 session-core `RecoverOptions` 同构的两步恢复输入(load + import_snapshot),复用 `SessionOrchestrator.recover`(编排核心零改动);已关闭会话拒绝恢复、无快照恢复点拒绝(fail-closed,无 I-4 前提)。

### D-API-26 秘密语料扫描的存储面测试锚点(阶段三 WP-3;ZR-B4 / B5 / B6)

存储面机检锚点:①快照 blob 落库**密文断言**——明文语料(seed 十六进制 / FLAG 样式)扫描零命中,红灯反例(故意存明文)证明扫描器可检出;②动作日志为玩家提交可见面 BOUNDARY,本身不加密、但必须零秘密——语料扫描为**测试锚点而非运行时硬闸**:玩家 write_bytes 合法回显(含把 flag 写进可见缓冲区的成功路径)会使任何语料模式在运行期产生真阳性,"玩家回显"是 I-9 / ZR-P8 的 sanctioned 通道,运行期防线是"拒绝不入账 + 投影白名单",本扫描器服务静止存储面与机检(WP-7 录制扫描可复用 `scanSecretCorpus`)。

## 三·五、REST 生命周期路由与请求护栏(阶段三 WP-4;D-API-30 ~ D-API-39)

### D-API-30 生命周期路由落定:list_checkpoints 以 POST 承载;12 动作 WSS-only 维持确认(阶段三 WP-4)

D-API-1 路由表按 WP-4 实现回填一处调整:**`list_checkpoints` 由 GET 改为 `POST /sessions/checkpoints`**。理由:冻结 `SessionCommandRequest` 的 `list_checkpoints` 分支以请求体承载 `{sessionId}`(会话定位权威锚,禁入 URL);而浏览器 `fetch` / XHR 对 GET 不支持携带请求体(部分代理亦会剥离 GET 体),GET 形态将迫使会话标识退化为 query / 头部第二通道,与"路径与 URL 不携带会话标识"的单一真源诉求冲突。调整后五命令统一 POST、统一请求体契约、统一凭证呈递,路由即命令判别(请求体 `command` 字段仅供契约校验,与路由不符按畸形请求同族确定性拒绝)。契约本体(WP-0 冻结 Schema)零改动——本调整只在实现面文档层。

成功状态码:`create_session` = 201(资源创建,`Set-Cookie` 交付凭证,D-API-12),其余命令 = 200。响应面在发送前一律过冻结 `SessionCommandResponseSchema` 自检(漂移即 500 兜底,绝不下发非契约形态)。

**12 动作不设 REST 镜像端点的决策确认维持**(WP-4 完成标准项):动作通道 WSS-only(D-API-1),未新增任何动作 REST 端点,无需修改 WP-0 契约。动作入口在编排侧以会话管理器 `applyAction` 承载(WP-5 WSS 通道复用同一入口);create_checkpoint 的快照落库钩子在该入口装配(见 D-API-37)。

### D-API-31 请求护栏:数值默认值 + 配置天花板;校验失败零细节透出(阶段三 WP-4)

8.3 请求护栏四个维度的数值护栏取**常量默认值 + 配置上限(天花板)**双闸形态,配置不得超过天花板(配置闸 Schema `max` = 天花板常量,超限拒绝启动):

| 护栏 | 默认值 | 天花板 | 配置键 / 强制层 |
|---|---|---|---|
| 请求体字节 | 65536(64 KiB) | 1048576(与 `MAX_WSS_FRAME_BYTES` 同源) | `SESSION_API_MAX_REQUEST_BODY_BYTES`;fastify `bodyLimit` 解析层强制,超限 413 → 冻结 `invalid_input_format`/"request too large" |
| JSON 嵌套深度 | 16 | 64 | `SESSION_API_MAX_JSON_DEPTH`;路由级结构巡检(确定性深度优先),超限 400 → "invalid request" |
| 数组长度 | 256(常量,非配置) | —— | 路由级结构巡检;契约字段的逐字段上限由冻结 Schema 另行强制 |
| 字符串长度 | 4096(常量,≥ `EMBED_TOKEN_MAX_LENGTH`,不与契约冲突) | —— | 路由级结构巡检,先于 Schema 校验触发 |
| clientSeq 单会话预算 | 65536 | 10000000 | `SESSION_API_MAX_CLIENT_SEQ_PER_SESSION`;协议 §4.4,触顶确定性拒绝,恢复路径 = 重新 create_session(计量语义见 D-API-38) |

结构护栏(深度 / 数组 / 字符串)的越界细节(维度、issue 计数、字段路径)只进受控日志;响应面恒为冻结 `PublicError`,零校验器细节(基线 #8;Zod issue 的 message 可能回显输入片段,故日志只记路径与 code,不记 message)。路由级版本受理 = `SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS` 集合路由(D-API-4),各版本以独立 Schema 注册表校验;装配期自检保证受理集合中每个版本都有已注册 Schema(缺实现即拒绝启动)。

### D-API-32 HTTP 状态 ↔ 冻结结果类型映射矩阵(阶段三 WP-4)

一切非 2xx 响应体 = 冻结 `PublicError`(code ∈ 16 冻结码,message 恒为静态模板);同一失败类别恒映射同一三元组(I-4),与隐藏状态无关。载荷常量在装配期过冻结 Schema 自检,漂移即拒绝启动。

| 结果类别 | HTTP | PublicError code | 静态文案 | 判别来源 |
|---|---|---|---|---|
| invalid_action(契约 / 结构校验失败) | 400 | `invalid_input_format` | invalid request | 路由级 |
| 版本不受支持 | 400 | `invalid_input_format` | unsupported protocol version | 受理集合路由 |
| 请求体字节超限 | 413 | `invalid_input_format` | request too large | bodyLimit 413 映射 |
| 认证失败(D-API-14 统一面) | 401 | `invalid_input_format` | authentication failed | 凭证中间件 / token 消费 |
| 会话定位失败(不存在 / 已回收 / 租户不匹配同形) | 404 | `invalid_input_format` | resource not found | 会话注册表(防枚举) |
| session_terminal / cancelled | 409 | `session_terminal` | session is terminal | 编排器域(cancelled 为 WP-6 强制终止预留类别,同形呈现) |
| clientSeq 预算触顶 | 409 | `stale_client_seq` | client sequence budget exhausted | 会话管理器 |
| challenge_invalid(版本未登记 / 双包缺失 / 装载管线拒绝,同形) | 422 | `internal_error` | challenge invalid | 装载管线(防题目枚举) |
| engine_error(worker 崩溃 / 协议违规 / 未知编排失败) | 500 | `internal_error` | internal error | 会话管理器分类 |
| 存储不可用(PersistenceError) | 503 | `internal_error` | storage unavailable | 持久化面 |
| **timeout(worker 看门狗退出码 3 → `watchdog_timeout`)** | **504** | `budget_exhausted` | session timed out | 退出分类(D-F 看门狗;不透出退出码 / 进程细节) |

worker 崩溃的编排侧判别:命令失败(OrchestratorError `worker_crashed` / `invalid_worker_output`)即收割退出(`kill` → `waitExit`),`watchdog_timeout` → timeout(504),其余 → engine_error(500);崩溃会话移出在途表并入 `session_force_closed` 审计。取消类别 `cancelled` 本阶段无产生路径,矩阵预留其呈现形态(WP-6 强制终止接线时启用)。

### D-API-33 认证端口的 Redis 适配:GETDEL 仲裁的单次消费;AuditSink 维持内存实现(阶段三 WP-4)

WP-2 三端口的存储适配以**薄适配器**把 WP-3 `KeyValueStore` 原语接到端口(不改 WP-2 / WP-3 端口形状):

- `TokenIssuanceStore`:键域 `token:{jti}`(与 WP-2 端口语义同键名;jti 为服务端签发 UUID,仍经 `encodeURIComponent` 编码保形——与幂等键同一防键分隔符注入纪律,编码对 UUID 恒等)。`consume` 的**原子单次消费**由 `deleteIfPresent`(Redis `GETDEL`)仲裁:先 GET 取载荷、再以 GETDEL 结果为成功仲裁,并发下至多一方拿到记录,其余一律 null——语义与"GETDEL 单命令取删"等价,未签发 / 已消费 / 已吊销 / 记录过期四态同形(D-API-14 / D-API-18);载荷 JSON 形态在消费侧做最小形状校验,损坏按"无有效记录"处理(fail-closed);
- `CredentialRevocationStore`:键域 `cred-revoked:{jti}`(存在即拒绝;TTL 由调用方按凭证剩余有效期给出);
- `AuditSink`:**维持进程内内存实现**(append-only 深冻结)——`audit_log` 表域与归档归阶段六(D-API-20 预留面不含审计表),内存实现的"不得用于生产常驻"边界在此登记为已知留白,替换实现须保持 append-only 端口语义(D-API-18 ②)。

### D-API-34 readiness 端点:GET /readyz,探针注入,失败面统一(阶段三 WP-4;D-API-9 预留的落地)

`GET /readyz` 为 readiness:探针(生产装配 = PostgreSQL `SELECT 1` / Redis `PING` / MinIO 私有桶 `bucketExists`)全部通过才 200 `{status:"ok"}`;任一失败 = **503 + 冻结 PublicError 统一形态**(`{"code":"internal_error","message":"dependencies unavailable"}`),失败方不透出(仅在受控日志携带探针名)。探针未接线(骨架形态)同样 503——依赖未知不可谎报就绪。`/healthz` liveness 恒 200 语义不变。

### D-API-35 create-session 重复创建与并发预算的接入点(阶段三 WP-4;执行面归 WP-6)

create-session 路由在 embed token 三方比对通过之后、题目装载之前固定一个 **`CreateSessionGuard.beforeCreate(request, identity)` 钩子**(每租户 / 每用户重复创建检测与并发会话预算的挂载点):钩子抛错即拒绝创建(异常经 D-API-32 矩阵呈现,建议 WP-6 落 429 + 确定性冻结形态);缺省未注入 = 放行。本阶段只固定接入点,不实现限流本身(任务分解 WP-4 第 5 条;限流数值与执行面归 WP-6)。

### D-API-36 在途会话注册表与会话定位(阶段三 WP-4 装配面)

编排器域会话注册表(进程内,`LiveSessionManager`)持有在途 `SessionOrchestrator` 实例;一切命令以 **(sessionId, tenantId) 双条件**定位——租户不匹配与不存在同形态返回(防枚举;凭证绑定锚已在凭证中间件先行校验,注册表定位是第二道防线)。已关闭会话从注册表移除:后续命令一律 404(与不存在同形;重开 = 重新 create_session),worker 崩溃会话同刻回收(D-API-32 收割路径)。注册表为单实例进程内形态:多实例编排器的跨实例路由归 `route:{sessionId}` 键域(WP-3 已备 RouteStore 端口,装配归 WP-5 / T1 多实例演进)。

### D-API-37 快照恢复点的编排侧装配:显式 checkpoint + 会话关闭 + 停机冲刷;周期策略过渡形态(阶段三 WP-4;D-API-25 的落地与留白)

恢复点三触发点在本阶段的装配形态:

- **显式 checkpoint**(①):`applyAction` 入口在 `create_checkpoint` 动作被接受后,将编排器账本最近 checkpoint 信封经 `SnapshotPersistence` 整包加密落库(origin = `explicit_checkpoint`,按 checkpointId 幂等去重),并推进 sessions 行快照锚;
- **会话关闭**(③):close-session 在优雅关闭前落最近恢复点(origin = `session_close`),会话行置 closed;
- **停机冲刷**:优雅停机序列注册 `flush-live-sessions` 步骤(在 stop-accepting-requests 之后、close-postgres / close-redis 之前)——对每个在途会话补落未落库恢复点并推进锚(任一失败 → 停机步骤失败 → 退出码 1,不静默丢状态);
- **周期性自动快照**(②)取**过渡形态**:编排核心未暴露逐 revision 的 `export_snapshot` 通道(WP-4 不得改 packages/**),周期策略(`AutoSnapshotPolicy`,间隔 = `SESSION_API_AUTO_SNAPSHOT_EVERY_REVISIONS`)在动作入口判定触点,触发时复用最近 checkpoint 信封落库(origin = `auto_periodic`,信封自身 revision 如实落行;恢复语义本为"最近快照丢尾",D-API-25)。真正的逐 revision export 接线为遗留项,归 WP-5 动作通道(worker 通道暴露后)或编排核心演进。

### D-API-38 clientSeq 预算的计量语义与 WP-5 动作入口(阶段三 WP-4;协议 §4.4)

session-core 的 `clientSeq` 为编排器内部水位(不暴露读取口),预算在会话管理器动作入口**按进入动作路径的次数计量**:每次 `applyAction` 调用先做预算判定,`已计量次数 ≥ SESSION_API_MAX_CLIENT_SEQ_PER_SESSION` 即确定性拒绝(`ClientSeqBudgetExhausted` → 409 / `stale_client_seq`,D-API-32),触顶后继续拒绝直至会话回收;恢复路径 = 重新 create_session。计量为**保守方向**:幂等重放(编排核心命中缓存、不消耗内部水位)同样消耗预算份额——触顶可能早于精确水位,拒绝确定性不变。`manager.applyAction` 即 WP-5 WSS 动作通道的编排入口(串行队列 / 幂等 / baseRevision 预检在编排核心不变);WSS 侧触顶呈现为冻结错误帧,由 WP-5 复用同一映射。

### D-API-39 WP-4 配置键登记:三键(阶段三 WP-4)

| 键 | 必备 | 默认 | 约束 |
|---|---|---|---|
| `SESSION_API_MAX_REQUEST_BODY_BYTES` | 否 | 65536 | 上限 1048576(fastify bodyLimit;D-API-31) |
| `SESSION_API_MAX_JSON_DEPTH` | 否 | 16 | 上限 64(路由级结构护栏;D-API-31) |
| `SESSION_API_MAX_CLIENT_SEQ_PER_SESSION` | 否 | 65536 | 上限 10000000(协议 §4.4 单会话预算;D-API-38) |

三键均过配置三道闸(未知保留键 / 取值天花板,fail-closed);启动监听日志登记受理协议版本集合(`SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS`,N-1 窗口运维观测点,D-API-4)。

## 三·六、认证 WSS 通道与投影下发(阶段三 WP-5;D-API-40 ~ D-API-49)

### D-API-40 WSS 端点、升级认证与连接绑定:GET /sessions/channel;多连接踢旧(阶段三 WP-5)

动作通道端点登记为 **`GET /sessions/channel`**(D-API-1 路由表增补行):位于会话凭证 Cookie `Path=/sessions` 前缀覆盖之下(D-API-12),零装配参数调宽。落定内容:

- **升级即认证**:`authenticateSessionCredential`(REST / WSS 统一入口,Cookie 呈递)以凭证 preHandler 形态在 fastify 生命周期内先行执行——升级前未过认证即 **HTTP 401 + 冻结统一形态**(与 D-API-14 字节级一致,防枚举);GET 升级非变更方法,不走 CSRF 闸(D-API-17);
- **凭证 session ↔ 连接绑定**:`claims.sessionId` 升级即锚定本连接;此后每帧双重校验(帧 `sessionId` 与载荷 `sessionId` 均须等于绑定会话),不符 = 错误帧(`session mismatch`)+ 连接保持(逐帧确定性拒绝,零细节差异防枚举);
- **多连接策略 = 踢旧**(任务分解 WP-5 两候选的择一登记):同会话第二连接升级完成(已过认证)即激活为属主,旧连接收错误帧 `invalid_input_format` / "connection replaced" 后以 close 1008(policy violation)关闭——教学场景同账号重连体验优先;服务端串行不变性是底线:每会话至多一条活跃通道,叠加 manager 单会话串行队列,双层结构下无并发执行;
- **升级后未认证防御面**(preHandler 保证不可达):无凭证锚即无错误帧锚(不伪造 sessionId),直接 close 1008;
- 帧字节护栏在传输层落地:ws 服务端 `maxPayload = MAX_WSS_FRAME_BYTES`,超限帧由协议层 close 1009 强制断开(8.3)。

### D-API-41 通道错误帧矩阵:一切通道级失败 = `WssFrame.error` + 冻结 `PublicError` 静态常量(阶段三 WP-5)

封闭的(失败类别 → code / message / 连接处置)常量表,载荷常量在模块加载期过冻结 Schema 自检(漂移即拒绝启动);畸形帧细节(issue 路径 / 计数 / 越界维度)只进受控日志,且日志零 Zod message(可能回显输入片段):

| 失败类别 | code | 静态文案 | 连接处置 |
|---|---|---|---|
| 畸形帧(JSON 不可解析 / 二进制帧 / 非对象 / 方向违规 / 契约校验失败) | `invalid_input_format` | malformed frame | 保持 |
| 版本不受支持(不在受理集合)与连接锚定后版本漂移 | `invalid_input_format` | unsupported protocol version | 保持 |
| 跨会话(帧或载荷 sessionId 与绑定会话不符) | `invalid_input_format` | session mismatch | 保持 |
| 幂等键冲突(窗口前置守卫) | `idempotency_conflict` | idempotency key conflict | 保持 |
| 消息频率超限 | `budget_exhausted` | message rate limit exceeded | 保持 |
| 发送缓冲超限(背压) | `budget_exhausted` | send buffer limit exceeded | close 1013 |
| 空闲超时 | `budget_exhausted` | connection idle timeout | close 1000 |
| 同会话新连接踢旧 | `invalid_input_format` | connection replaced | close 1008 |
| 编排器域失败(timeout / engine_error / session_terminal / 会话定位失败 / clientSeq 预算触顶 / 存储不可用) | 复用 D-API-32 映射矩阵的载荷面(同 code 同文案) | (同 D-API-32) | 保持(帧级拒绝) |

选码纪律与 D-API-14 同族:`invalid_input_format` 是唯一 coarse 级、无地址、可无解释的协议级拒绝码;`budget_exhausted` 的能力矩阵为 addressHex forbidden + explanation forbidden,恰合资源预算类通道失败的零解释面。**出站帧自检**:一切出站帧(响应 / 错误)先过冻结 `WssFrameSchema`,漂移 = 实现事故——细节进受控日志 + close 1011,绝不下发非契约形态。

### D-API-42 心跳与空闲的通道实现与数值(阶段三 WP-5;D-API-6 的实现落点)

服务端每 `SESSION_API_WSS_HEARTBEAT_INTERVAL_SECONDS`(默认 30,天花板 3600)发送 RFC 6455 协议层 ping;**pong 与任何入站消息都刷新活跃时刻**;静默超过 `SESSION_API_WSS_IDLE_TIMEOUT_SECONDS`(默认 60,天花板 86400)即判空闲:尽力直发错误帧(绕过发送缓冲,空闲断开不受背压状态影响)→ close 1000 → 宽限后 terminate;断开走断线恢复路径(§4.2.3)。**组合约束**:空闲超时必须大于心跳间隔(启动校验独立裁决点,否则每节拍必判空闲)。零应用层心跳帧(帧类型集合封闭,扩展 = 协议版本演进)。

### D-API-43 消息频率限制:每连接令牌桶,容量 = 速率;WP-6 同源钩子(阶段三 WP-5)

`SESSION_API_WSS_MESSAGE_RATE_PER_SECOND`(默认 30,天花板 10000)驱动令牌桶:**容量 = 补充速率**(桶满允许等量突发,长期平均不超过速率)。频率闸同步于消息接收期(先于任何解析),触顶 = 错误帧逐帧确定性拒绝,连接保持、不消耗内部余量。**与 WP-6 每会话动作频率同源**:`MessageRateLimiter` 类时钟可注入、可直接按会话装配(WP-6 的"每会话动作频率"复用同类,计量键从"每连接"换"每会话");跨实例聚合仍归 `rate:{tenant}:{user}` Redis 固定窗口(WP-6)。

### D-API-44 背压:帧数有界发送缓冲,超限断开走恢复路径(阶段三 WP-5)

出站帧**单飞写**(同一时刻至多一帧在等写回调),未回调帧排 FIFO 队列——帧序 = 执行序的传输面前提;`SESSION_API_WSS_SEND_BUFFER_LIMIT`(默认 256,天花板 10000)封顶队列帧数,**不做服务端无界队列**。超限:错误帧绕过已溢出缓冲尽力直发 → close 1013(try again later)→ 断线恢复路径(§4.2.3)。溢出为一次性状态:此后入队一律拒绝,防溢出路径自身再制造无界写。

### D-API-45 断线保持窗口:计时器启动 / 取消归 WP-5,回收执行面归 WP-6(阶段三 WP-5)

`SESSION_API_DISCONNECT_KEEPALIVE_SECONDS`(默认 300,天花板 86400)。服务端侧义务边界(§4.2.3 的服务端前提):**会话不因连接断开而关闭**(manager 在途表不动)、**状态可对齐**(sync-projection 重发缓存投影)。机制:最后一个活跃连接移除时启动计时器,该会话任一新连接激活即取消;到期 = `route:{sessionId}` 释放 + `onKeepaliveExpiry(sessionId, tenantId)` 钩子——**回收执行面(worker 进程 / 会话行 / route 对齐的会话关闭)归 WP-6**,本 WP 只负责计时器启动 / 取消与挂载点。优雅停机时全部保持计时器取消(会话状态由 flush-live-sessions 步骤落盘,恢复归重启恢复路径)。

### D-API-46 动作通道流水线与传输层纪律(阶段三 WP-5;D-API-2 / D-API-5 的落点)

每帧流水线(收序即处理序):**频率闸**(同步,D-API-43)→ 文本 / JSON 形态检查 → **结构护栏**(与 REST 同值装配:深度 / 数组 / 字符串;字节维度由 maxPayload 在协议层强制)→ **版本受理 + 连接锚定**(D-API-2:受理集合 `SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS` 按版本路由至各自帧 Schema,注册表装配期自检;受理集合内的首帧即本连接解释版本,此后任何帧携带其他版本一律错误帧拒绝——"首帧即协商",无独立握手消息)→ **冻结 `WssFrameSchema` 重新校验**(strictObject,零校验器细节透出)→ **方向检查**(客户端 → 服务端只允许 `action`)→ **会话绑定** → **单连接串行链**:幂等窗口前置守卫(比较基准 = 规范化序列化后的完整 `ActionRequest`,传输层帧字段不在契约内,§4.3;fresh / replay-identical → 递入 `manager.applyAction`,同进程字节相同重放由编排核心账本返回缓存响应;conflict → 错误帧 `idempotency_conflict`)→ `manager.applyAction`(**单会话串行不变**,clientSeq 预算 / baseRevision 预检在编排核心)→ `action_response` 信封下发。

传输层纪律(D-API-5 承接):入站 `seq` 不做拒绝依据、不设高水位拒绝(权威判定只在载荷层);出站 `seq` 服务端连接内严格递增(允许跳号);帧 `requestId` 为发送方关联值,响应帧原样回显(与载荷内服务端生成的 `ActionResponse.requestId` 语义独立);响应帧 `protocolVersion` = 连接锚定版本(不携带"新版本",信封按请求版本解释,D-API-2)。

**WP-4 遗留项边界声明**(D-API-37 的过渡形态不变):编排核心未暴露逐 revision 的 `export_snapshot` 通道,也未暴露已接受动作的内部 `clientSeq`(编排器内部水位)——周期快照的逐 revision 触发与 `action_log` 落库(仅已接受动作、拒绝不入账)在本阶段**保持过渡形态未接线**,避免向 append-only 权威日志写入伪 `clientSeq`(载荷层 clientSeq 是客户端自报序号,与编排器账本不同源);二者的接线点在编排核心演进(暴露账本条目或 `applyAction` 回传内部 `clientSeq`),WSS 流水线已在 `manager.applyAction` 返回点预留挂载位。

### D-API-47 投影下发纪律与同步通道边界(阶段三 WP-5;ADR-7)

响应即完整下发:`ActionResponse`(含 `ProjectionDelta` / `publicEvents`)**原样转发执行域产物**——编排器与通道零投影合成、零增量合流、零本地推导;权威 revision 只来自 worker(编排核心账本,ZR-P5 断言增量 ∈ {0,+1})。`sync-projection` 只重发缓存投影且**只在 REST**(`POST /sessions/projection-sync`)——WSS 面不新增同步通道;断线对齐路径 = 重连(升级即凭证重验)→ REST sync-projection 对齐 revision → 以新 baseRevision / 新 clientSeq 区间继续(§4.2.3)。

### D-API-48 连接关闭码登记与优雅停机步骤增补(阶段三 WP-5)

服务端主动关闭的关闭码封闭登记(确定性处置,断开一律走断线恢复路径):

| 处置 | close code | 触发 |
|---|---|---|
| 空闲超时 | 1000(normal closure) | 心跳静默判定(D-API-42) |
| 踢旧 / 升级后未认证防御面 | 1008(policy violation) | 同会话新连接激活(D-API-40) |
| 帧超限 | 1009(message too big) | ws maxPayload 协议层强制 |
| 出站帧契约自检失败 | 1011(internal error) | 实现事故兜底(细节只进受控日志) |
| 优雅停机 | 1001(going away) | close-wss-channels 步骤 |
| 发送缓冲超限 | 1013(try again later) | 背压(D-API-44) |

停机序列增补(承接 D-API-9):**close-wss-channels 先于 stop-accepting-requests**——逐连接冲刷发送缓冲(waitDrained 有界等待)→ close 1001 → 宽限 terminate;通道收尾不被 fastify close 的连接回收路径抢先。其后照旧:stop-accepting-requests → flush-live-sessions → close-postgres → close-redis → flush-logs。

### D-API-49 RouteStore 消费的 T0 单实例形态(阶段三 WP-5;D-API-24 / D-API-36 的落点)

`route:{sessionId}`(fail-closed 键域,D-API-24)在本阶段消费形态:连接激活时 **bind**(属主 = 编排器实例随机 UUID;TTL = 断线保持窗口 + 4×心跳间隔,与会话保活节奏一致)、心跳节拍**续期**、保持窗口到期 / 优雅停机时 **release**。绑定 / 续期失败只进受控日志、**不拒绝连接**:T0 中路由定位未被投递路径消费(单实例无跨实例投递歧义),fail-closed 的完整语义(路由不一致即拒绝投递)在 T1 多实例编排器接线时生效;键域"全部带 TTL、可重建、不作权威"的分级结论不变(D-API-24)。

## 三·七、限流、配额与会话资源回收(阶段三 WP-6;D-API-50 ~ D-API-59)

### D-API-50 限流执行点、数值与触顶呈现:REST 面 = `rate:{tenant}:{user}` 固定窗口 + 429 冻结形态(阶段三 WP-6)

四个限流维度的执行点与数值(默认保守 + 配置化;任务分解 §六"限流默认值"决策点的回填):

| 维度 | 计量域 / 键 | 载体 | 默认值 | 天花板 | 挂载点 |
|---|---|---|---|---|---|
| 每租户 / 每用户请求频率 | `rate:{tenant}:{user}`,固定窗口 60 s | WP-3 `RateLimitCounter`(Redis Lua 原子计数;内存实现同构) | 120 次/分 | 100000 | create-session 守卫(D-API-51)+ 四个凭证命令共闸 |
| 每租户并发会话预算 | 在途会话数(进程内) | `LiveSessionManager` 在途表 + 入场预留 | 8 / 租户 | 10000 | 守卫早期快检 + manager 精确执行面(D-API-52) |
| 提交频率 | `rate:{tenant}:{user}:submit`,固定窗口 60 s | 同上 | 30 次/分 | 100000 | submit 路由专属闸(先于编排入口) |
| 每会话动作频率 | sessionId(进程内) | `MessageRateLimiter` 按会话键(与每连接令牌桶同源) | = `SESSION_API_WSS_MESSAGE_RATE_PER_SECOND`(30/s) | 同通道天花板 | WSS 帧流水线(D-API-53) |

键域纪律:`rate:` 键域内的维度子键(提交频率的 `:submit` 后缀)沿用 WP-3 键域的 TTL 与 fail-closed 分级(D-API-24)——计数器故障以 `store_unavailable` 立即上抛(呈现 503),不降级、不静默放行。**WSS 帧不进 Redis 计数器**:通道帧的频率闸是进程内令牌桶(每连接 + 每会话,D-API-43 / D-API-53),跨实例聚合的 Redis 计数留给 T1 多实例时按租户 / 用户聚合再评估;逐帧 Redis 往返在教学规模下不成比例。

**触顶呈现(确定性,I-4)**:REST 触顶 = **429 + 冻结 `PublicError`**(D-API-32 映射矩阵的 429 预留行落地)——频率类 `{code:"budget_exhausted", message:"rate limit exceeded"}`、并发预算类 `{code:"budget_exhausted", message:"concurrent session budget exceeded"}`,同类别恒同三元组、响应体逐字节一致,零限流器状态(计数、窗口锚、在途数)透出。选码纪律与 D-API-14 / D-API-41 同族:`budget_exhausted` 的能力矩阵 addressHex / explanation 双 forbidden,恰合资源预算类的零解释面。窗口语义:窗口锚定于窗口内首次计数(TTL 自首增起算,与 WP-3 计数器一致),触顶拒绝不回退计数。

### D-API-51 CreateSessionGuard 的 WP-6 执行面:频率闸 + 并发预算早期快检(D-API-35 接入点的落地;阶段三 WP-6)

D-API-35 固定的 `CreateSessionGuard.beforeCreate(request, identity)` 接入点(embed token 三方比对通过之后、题目装载之前)由 `RateLimitedCreateSessionGuard` 实现,按序承载两个维度:①每租户 / 每用户请求频率(`rate:{tenant}:{user}` 固定窗口,触顶抛 `RateLimitExceeded` → 429);②并发会话预算的**早期快检**(读 manager 在途表,触顶抛 `ConcurrentSessionBudgetExhausted` → 429)——快检是 fail-fast(在昂贵的题目装载之前拒绝),预算的**精确执行面**在 manager(D-API-52),双侧呈现同一冻结形态。缺省未注入 = 放行(D-API-35 缺省形态不变,测试可注入替身)。注意接入点位置意味着被守卫拒绝的请求其 embed token jti 已被消费(单次消费语义不变;宿主后端重试需重新签发 token——与"消费成功即令牌作废"的防重放语义一致)。

### D-API-52 并发会话预算的计量语义:在途表 + 同步入场预留(阶段三 WP-6)

预算计量真源 = `LiveSessionManager`:`createSession` 入口在**首个 await 之前**同步完成"检查 + 预留"(`liveCountByTenant + pending ≥ 预算` 即抛 `ConcurrentSessionBudgetExhausted`,否则 `pendingByTenant` 计数 +1)——JS 单线程下该同步段对并发创建原子,**并发创建窗口不超卖**(预算 N 时并发 M 个创建恰 M−N 个在预留检查处被拒);预留 在 finally 中如数释放,创建失败路径(题目装载拒绝等)不泄漏名额;创建成功后名额由在途表承接。close-session / 回收(D-API-55)/ 崩溃收割移出在途表即释放名额。该预算是进程内形态,跨实例聚合归 T1 多实例演进(与 D-API-36 注册表边界一致)。

### D-API-53 每会话动作频率:与每连接令牌桶同源叠加;流水线序与回收联动(阶段三 WP-6)

"每会话动作频率"复用 WP-5 的 `MessageRateLimiter`(同源实现:时钟可注入、判定纯函数、I-4),计量键从"每连接"换"每会话"(`SessionActionRateLimiter` 按 sessionId 建桶,容量同取 `SESSION_API_WSS_MESSAGE_RATE_PER_SECOND`——不新增配置键)。两道闸**叠加**:每连接桶随连接新建(重连即满),每会话桶**跨连接存活**(重连不重置预算,封堵"断线重连刷新令牌桶"的绕行向量)。帧流水线序:`WSS_RATE_LIMIT_ERROR`(连接闸,D-API-43)→ **会话闸** → 后续形态 / 版本 / 绑定检查;会话闸触顶 = 冻结错误帧 `{code:"budget_exhausted", message:"action rate limit exceeded"}`(`WSS_ACTION_RATE_LIMIT_ERROR`,D-API-41 错误帧矩阵增补行),逐帧确定性拒绝、连接保持、不消耗任何余量;两桶皆空时连接闸先行(确定性叠加次序)。桶生命周期:会话首帧惰性创建;断线保持到期回收的组合钩子先逐出桶再进入回收执行面(教学规模下桶数 ≤ 在途会话数,不设容量上限)。错误帧矩阵增补行:

| 失败类别 | code | 静态文案 | 连接处置 |
|---|---|---|---|
| 每会话动作频率超限(会话闸触顶) | `budget_exhausted` | action rate limit exceeded | 保持 |

### D-API-54 存储与快照配额:checkpoint 数量 / 快照字节预算 / 租户存储配额的预执行确定性拒绝(阶段三 WP-6)

三个维度全部在 `create_checkpoint` 进入执行域**之前**判定(manager 动作入口的配额闸,先于 clientSeq 预算计量——配额拒绝不消耗预算份额、不触发 worker 往返):

1. **每会话 checkpoint 数量上限**:默认 = 天花板 = 协议外圈护栏 `MAX_CHECKPOINTS_PER_SESSION`(256;权威 API 语义规约 §四登记表的契约前提——配额必须 ≤ 协议上限,配置超过 256 拒绝启动)。计量 = 编排器 checkpoint 账本长度(`listCheckpoints`),`≥` 上限即拒绝;
2. **快照字节预算**:默认 1 MiB、天花板 64 MiB。计量口径 = 快照信封的规范化 JSON 字节长度(`envelopeByteLength`,确定性、不依赖密文开销);预执行以最近已知 checkpoint 信封为估计(同会话状态增长只会更大,保守方向);
3. **每租户存储配额**:默认 256 MiB、天花板 1 TiB。计量 = 已持久化快照密文行字节合计(`TenantStorageQuotaMeter`:`listSessionsByTenant` × `listBySession` 组合查询——**T0 形态**,端口零新增,只在 create_checkpoint 判定时调用;阶段六全面租户隔离时复核为反规范化计数列)。`≥` 配额即拒绝该租户一切会话的后续 checkpoint。

**超限呈现 = 编排器侧预检确定性拒绝**(与 session-core 预检同形:`status:"rejected"` 的 `ActionResponse` + `userVisibleError{code:"budget_exhausted"}`,静态文案三值:checkpoint quota exceeded / snapshot byte budget exceeded / tenant storage quota exceeded)。选码理由:16 冻结码中 `budget_exhausted` 是资源预算类的协议级拒绝码(能力矩阵 addressHex / explanation 双 forbidden)——零解释面恰好不透出配额内部计量;与 REST 429 / WSS 频率闸同族,通道语义一致。**requestId 为服务端每次签发(D-API-5 关联语义)**:配额拒绝不经编排核心幂等缓存,重放得到语义等价(status / code / message / revision 全同)而 requestId 新生的响应——确定性由语义面承载,与"同状态同请求字节相同"的响应面口径(无 requestId 的冻结 PublicError)不冲突。

**粘性超限标记**:快照字节数只有在该 checkpoint 被引擎接受后才可精确计量;持久化边界复核实际信封字节数,超预算即**不落库**(恢复锚回退上一个预算内快照——"最近快照丢尾"语义容忍)+ 置粘性标记(只升不降),此后该会话一切 `create_checkpoint` 预执行确定性拒绝。同一动作序列恒同一判定序列(I-4)。超限事实只进受控日志(审计 kind 集合冻结见 D-API-59)。

### D-API-55 会话资源回收与终态保留窗口:onKeepaliveExpiry 执行面 + 可调用清理入口(阶段三 WP-6)

**断线保持到期回收**(D-API-45 挂载点的执行面):保持计时器到期时注册表先释放 `route:{sessionId}`(单次释放;回收路径不触碰 route 键,无双重释放),随后进入 `onKeepaliveExpiry(sessionId, tenantId)` 组合钩子(每会话频率桶逐出, D-API-53 → `keepaliveExpiryReaper` → `LiveSessionManager.reclaimDisconnected`):终态恢复点落库(尽力,失败不阻断回收)→ worker 优雅关闭(失败即 `kill` 收割——回收优先于状态细分)→ sessions 行 phase 对齐 `closed` → 移出在途表(释放并发名额,D-API-52)→ `session_force_closed` 审计(detail `{reason:"disconnect_keepalive_expiry"}`)。回收幂等:对已不在途的会话返回 `not_live`(no-op)。钩子异常只进受控日志,不向注册表到期路径传播。重连(任一新连接激活)取消计时器即取消回收——WP-5 已有语义,经组合钩子的装配面全链路测试覆盖。

**终态会话保留窗口**:`SESSION_API_TERMINAL_SESSION_RETENTION_DAYS`(默认 30 天,天花板 3650)约束终态(`closed` / `crashed`)会话行的保留期。**T0 无 cron**:清理入口 = `TerminalSessionCleaner.purgeExpired({terminalRetentionDays, snapshotRetentionDays})`(可调用、幂等;运行时经 `runtime.terminalCleaner` 暴露,Compose 面的定时编排归 WP-7);执行序 = 快照按自身保留期(`purgeExpired`,D-API-25)先行清除 → 终态会话行按窗口清除(active 行不受影响),避免会话行清除后残留无主快照行。为此对 `SessionRepository` 端口做**最小扩展** `purgeTerminalSessionsBefore(cutoffIso): Promise<number>`(memory / PG 双实现同构;PG 为 `DELETE ... WHERE phase IN ('closed','crashed') AND updated_at <= $1`,故障翻译 `store_unavailable`)——持久化面原则不改之下的准许微调,理由:终态行清理是会话生命周期对齐(WP-6 第 3 条)的组成部分,且无既有端口面可组合(无跨租户全量列举)。

### D-API-56 action_log 落库接线:submit 锚点 + 增量补账 + 落库失败语义(阶段三 WP-6;任务 B,D-API-46 遗留项收口)

`LiveSessionManager.submit` 在裁决引用落库(`submissions.record`)之后,把 `SubmitReference.actionLog` 的**增量**落入 `ActionLogStore`(WP-3 端口,append-only):

- **同锚**:增量条目以本次 submissions 行标识为 `submissionRef`——与"和 submit 引用同锚"(WP-3 任务 5)逐字一致;
- **仅已接受动作天然成立**:`SubmitReference.actionLog` 是编排核心账本的权威投影,被拒绝动作本就不入账本(拒绝不入账,D-W8-9);条目 `clientSeq` 是**编排器内部水位**(与裁决引用同源)——D-API-46 的过渡形态(避免写伪 clientSeq)由此收口:落库数据源是 submit 引用(账本权威),不再是载荷层客户端自报值;
- **增量语义**:会话态维护 `persistedActionCount`(已落库条数),每次 submit 只落 `actionLog.slice(persistedActionCount)`——append-only 不重复;重复 submit 零重复追加;无更新 / 删除面(端口形状即强制层,数据库层触发器为第二层,D-API-22);
- **落库失败语义**:submit 响应**成功**、裁决引用**不回滚**——`submissions.reference` 内含完整动作日志,是 verifier 重放的权威锚(阶段六消费面);`persistedActionCount` 不推进,**下次 submit 增量补账**(重试语义);失败细节只进受控日志。审计承载:审计 kind 七值集合冻结(D-API-18),不因实现期接线扩张"落库失败"种类——扩展归阶段六审计面(完整审计覆盖与归档本就归阶段六,任务分解 §三);
- **秘密语料扫描锚点**(WP-3 任务 5):落库动作日志的可见载荷(clientSeq / revisionAfter / action)经 `scanSecretCorpus` 扫描零命中——**测试锚点而非运行时硬闸**(玩家回显是 sanctioned 通道,D-API-26);扫描器红灯自证沿用 WP-3 反例。

### D-API-57 ZR-P4 时序统计面:通道级帧分布统计断言(阶段三 WP-6;T-SC3 承接)

统计口径(任务分解 WP-6 第 4 条,阶段二移交 §六.4 的编排器层承接):同题目同脚本在不同秘密变体下,通道上的响应帧序列与**帧长分布**无可区分差异。恒定成本的不变式由引擎 T-SC2(ZR-P7)在执行域内保证,本层是**通道级兜底统计**——捕获执行域产物之外的通道行为差异(投影形态、事件聚合、错误面、帧化节奏)。落点:`test/limits/zr-p4-frame-statistics.test.ts` + 比较器 `test/wss/helpers/frame-statistics.ts`(WP-7 录制机检可复用)。断言分层(抗-flaky 设计):①帧数一致(次数);②帧类型序列一致(有序性);③**帧长逐位置一致(主断言,逐字节)**;④归一化视图逐字节一致(剥离 sessionId 与服务端 requestId——D-API-5 关联值不承载确定性);⑤时序面只做录制序单调性断言,**不做响应时长分位数 / 绝对时长断言**(避免 CI 时钟抖动红灯)。红灯反例:变更脚本(首动作触发确定性拒绝)的帧分布在第 1 帧即可检出——证明统计面零命中非静默绿灯。真实秘密语料变体(异 seed / 秘密长度变体)随题目 fixture 逐题必跑(ZR-B1 🔜),本决策锁定 harness 与检出能力。

### D-API-58 WP-6 配置键登记:七键(阶段三 WP-6)

| 键 | 必备 | 默认 | 约束 |
|---|---|---|---|
| `SESSION_API_RATE_LIMIT_REQUESTS_PER_MINUTE` | 否 | 120 | 上限 100000(每租户 / 每用户请求频率,窗口恒 60 s;D-API-50) |
| `SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT` | 否 | 8 | 上限 10000(并发会话预算;D-API-52) |
| `SESSION_API_SUBMISSIONS_PER_MINUTE` | 否 | 30 | 上限 100000(提交频率;D-API-50) |
| `SESSION_API_MAX_CHECKPOINTS_PER_SESSION` | 否 | 256 | 上限 = 协议 `MAX_CHECKPOINTS_PER_SESSION`(256;配额必须 ≤ 协议上限;D-API-54) |
| `SESSION_API_SNAPSHOT_BYTE_BUDGET` | 否 | 1048576 | 上限 67108864(单快照信封字节预算;D-API-54) |
| `SESSION_API_TENANT_STORAGE_QUOTA_BYTES` | 否 | 268435456 | 上限 1099511627776(租户存储配额;D-API-54) |
| `SESSION_API_TERMINAL_SESSION_RETENTION_DAYS` | 否 | 30 | 上限 3650(终态会话保留窗口;D-API-55) |

七键均过配置三道闸(未知保留键 / 取值天花板,fail-closed;D-API-9)。

### D-API-59 审计面边界:kind 集合不因 WP-6 接线扩张(阶段三 WP-6)

审计 kind 七值封闭集合(D-API-18)在 WP-6 保持不变:①断线保持到期回收复用 `session_force_closed`(回收即服务端强制终止语义),detail 携带 `{reason:"disconnect_keepalive_expiry"}`;②快照字节预算超限、action_log 落库失败等"非终止性配额 / 持久化事件"只进受控日志,不新增审计种类——审计面是安全事件账(强制终止、凭证链路、提交),不是运维事件账;新增种类的需求归阶段六审计面(完整审计覆盖与归档)统一论证。理由:kind 集合是审计消费方的封闭契约,实现期逐次扩张会使集合退化为事件日志,丧失"审计事件 = 需要不可抵赖账目的安全事实"的边界。

## 三·八、跨域载荷机检与 Compose 集成(阶段三 WP-7;D-API-60 ~ D-API-66)

### D-API-60 跨域载荷机检扫描器:src 纯模块形态与规则落点(阶段三 WP-7;ZR-B9 / B10 / B5 / B4 / B1 / B6 通道录制面)

任务分解"src 纯模块 + 测试消费 / tooling 脚本"二选一的择型:**`apps/session-api/src/scan/cross-domain-payload-scanner.ts` 纯模块(零依赖)**,不做 tooling 脚本。理由:同一套规则必须被三类消费者共享——rig 级审计测试(vitest 直接 import src)、Compose 拓扑集成套件(客户端侧捕获,与录制同进程消费)、红灯反例(规则精度锚);src 模块被 vitest 双形态(`test` / `test:compose`)天然双消费,CI(ts-gate 与 compose-integration)经 vitest 套件消费同一实现,零复制;tooling 脚本形态则需额外产物编译或规则复制品。机检规则与 `秘密零驻留CI检查项映射.md` §三逐字对应(只引用不改写):**ZR-B9 共现规则**(单 JSON 对象 ≥ 3 个 `VmState` 字段名键,字段表取 vm-core 冻结表序列化形态 registers / memory / callFrames / instructionPointer / privateEventLog / constraints / seedState / status)+ §三 ZR-B9 行的词边界模式(类型名 / 字段名 / crate 名)对键名与字符串值;**ZR-B10**(Internal / FileGranted / FileRead 私有事件 kind 值与 `privateEventLog` / `eventLog` 键的结构性缺席);**ZR-B5**(密文魔数 `SMEN` 与明文信封标记 `stackmaster-session-snapshot` 的通道缺席——密文与明文形态都不得上线);**ZR-B4**(私有题目包键名语料,与 `tooling/scan-public-artifacts.mjs` 同源);**ZR-B1 / B6 语料**复用 WP-3 `scanSecretCorpus`(D-API-26 预留复用点)。误报豁免面(登记,均非泄漏通道):服务端签发标识符键(sessionId / requestId / checkpointId / submissionId / embedSessionId / jti / idempotencyKey——冻结字符集随机串与 ZR-B6 语料同形)与公开十六进制载荷键(bytesHex / payloadHex / valueHex——I-10 值来源,零填充区域使 ≥32 hex 子串必然存在)。定位与 D-API-26 一致:**测试锚点而非运行时硬闸**(玩家回显是 I-9 / ZR-P8 sanctioned 通道)。

### D-API-61 机检捕获面与红灯反例(阶段三 WP-7;ZR-B9 共现接线 / ZR-B10 录制面收口)

捕获两层四源:①rig 级——服务端 `outboundFrameSink` 的 `OutboundFrameRecorder`(WSS 全量出站帧,先过冻结 `WssFrameSchema` 自检后录制)+ HTTP 响应体录制(签发端点 + 生命周期五命令全链路,`test/wp7/cross-domain-payload-audit.test.ts`);②Compose 级——客户端侧捕获(WSS 入站帧 + HTTP 响应体,`test/compose`),校验跨进程真实通道。机检对象 = **服务端发出的载荷面**;凭证交付头(Set-Cookie 的 JWT)是签名载体而非跨域载荷(卫生面归 D-API-12 / ZR-B7),客户端 → 服务端方向不设机检对象(浏览器不可信,注入面归 ZR-T 矩阵)。**红灯反例纪律**:每一违规类(VmState 共现 / 私有事件形态 / 快照魔数·信封标记 / 键名语料 / flag / seed)注入录制集必须检出,反例与零命中断言同套件运行——glob 写错或扫描器失效表现为红灯而非静默绿灯(映射文档 §五纪律)。

### D-API-62 客户端 clientSeq / baseRevision 的服务端锚定语义(阶段三 WP-7;ZR-T 重放条目的实现面澄清)

实现语义澄清(session-core 零改动):编排核心的 clientSeq / baseRevision 预检是**结构性预检**——`applyAction` 以内部水位与权威账本锚定构造请求(协议 §4.3 / D-W8-9"权威判定只在执行域"),载荷层携带的 clientSeq / baseRevision 是客户端声明值,不进入预检。后果:①旧 baseRevision 请求不产生 `stale_base_revision` 拒绝,而是被服务端以当前权威 revision 重新锚定后确定性执行(零状态腐化,同输入恒同响应 I-4);②重放防护由幂等承载:同键同负载 → 缓存同形响应(窗口内外同确定性);同键异负载 → `idempotency_conflict`;幂等窗口过期后重放仍确定性——窗口是效率设施,正确性由服务端锚定与串行保证(协议 §4.3)。`stale_base_revision` / `stale_client_seq` 冻结文案保留于预检模板(structural 防线 + clientSeq 预算路径,D-API-38)。篡改矩阵 `test/wp7/zr-tamper-matrix.test.ts`(ZR-T1 ~ T4 全绿)锁定该语义。

### D-API-63 编排器重启恢复的启动期接线(阶段三 WP-7;计划书 5.3"编排器重启不破坏会话一致性"的启动期兑现)

WP-3 的 `SessionRecoveryService` 此前仅测试路径消费;为兑现"docker restart → 会话恢复 → revision 自快照续算"的 Compose 级复验,做最小接线(任务书"outboundFrameSink 之外的最小接线"准许范围):①`SessionRepository` 端口最小扩展 `listActiveSessions()`(phase = 'active' 行;memory / PG 双实现同构)——**查询层租户过滤的唯一跨租户例外**,理由:这是服务进程生命周期操作(启动恢复)而非租户作用域数据访问,调用方仅限 runtime 装配与测试;②`LiveSessionManager.adoptRecovered`(恢复编排器纳入在途表;计量面按"进程内计数随旧进程消亡"重置:clientSeqUsed = 0,persistedActionCount = 0——恢复后账本自快照状态重启,动作日志增量自此起算,快照锚之前的条目已随重启前 submit 落库,append-only 不重复);③`runtime.recoverActiveSessions`:active 行 → `planRecovery` + `SessionOrchestrator.recover`(两步 load + import_snapshot,D-F8)→ `adoptRecovered`,在 HTTP 服务装配之前完成(接单即一致)。**fail-open 边界**:单会话恢复失败(版本行缺失 / 双包不可取回 / 无恢复点 / worker 装载拒绝)→ 会话行置 `crashed`(确定性终态,客户端恢复路径 = 重新 create_session)+ 受控日志,启动永不因单个不可恢复会话受阻;一致性由"不可恢复即终态"保证(不存在半恢复的在途会话)。不新增审计 kind(D-API-59 集合不变)。单测:`test/runtime/boot-recovery.test.ts`(内存同构栈);拓扑级:`test/compose` 重启用例。

### D-API-64 Compose 全拓扑与 session-api 镜像(阶段三 WP-7;质量门禁 7 阶段三子集)

新增 `apps/session-api/Dockerfile`(多阶段):Rust 阶段在容器内构建 **linux vm-worker**;Node 阶段构建 workspace TS 图(session-api 及其依赖);运行时镜像 = dist + migrations + `/app/bin/vm-worker`。**`WORKER_CARGO_PROFILE`:本地缺省 `debug`(控制本地 Rust 容器构建时长),CI 传 `release`**——以单一构建参数登记,不维护两份 Dockerfile。`vm-worker` 不是常驻服务(ADR-3 单会话单进程 spawn):拓扑第五元素 = **镜像内二进制 + 会话期子进程**;`compose/app.yaml` 的 `vm-worker` 服务为一次性冒烟(ready 帧写 stdout + stdio EOF 优雅退出,exit 0),由 `docker compose run --rm -T vm-worker` 显式触发,不参与 `up --wait` 的常驻收敛——把无状态 per-session 进程池映射为常驻容器反而违背进程模型。容器内 `ensureWorkerBinary` 解析:`STACKMASTER_WORKER_BIN=/app/bin/vm-worker`(解析序第一优先,不触发 cargo)。一键起停:`compose:app:up`(up -d --build --wait)/ `compose:app:down`(down -v)/ `test:compose`。

### D-API-65 test:compose 双拓扑形态与 CI 编排(阶段三 WP-7)

`test/compose/run.mjs` 按 `SESSION_API_TOPOLOGY` 选择形态:**container**(CI 形态,完整 linux 拓扑:build → `up -d --build --wait` → vm-worker linux 冒烟 → vitest `test/compose` → `down -v`)与 **host**(本机 Windows 降级形态:deps.yaml 依赖服务拓扑 + session-api 宿主进程 `node dist/index.js` + 本机 worker 二进制 `STACKMASTER_WORKER_BIN` 或 `vm-engine/target/{debug,release}` 产物;重启 = SIGTERM 优雅停机冲刷 → 重新拉起)。套件以 `SESSION_API_COMPOSE=1` 门控(`pnpm test` 恒跳过并输出原因)。CI `compose-integration` job:ubuntu-latest + `WORKER_CARGO_PROFILE=release`,**完整 linux 拓扑**跑机检 + 集成套件;与 ts-gate 并行(独立装依赖与构建,换取 job 独立性,不破坏既有 job)。本地 Windows 降级路径登记(任务分解 §六):vm-worker 需 linux 二进制(容器内构建);本机 Rust 容器构建过慢(> 20 分钟)时以 host 混合形态实跑并在验收记录中如实注明实跑形态,CI 始终为完整拓扑。

### D-API-66 13.3 API 侧条目落点与排除说明(阶段三 WP-7)

逐条落点:`test/wp7/api-acceptance-13-3.test.ts`——过期 revision(D-API-62 服务端锚定语义 + I-4 孪生对齐)、重复幂等键(缓存同形 + conflict)、跨租户 session(REST 凭证绑定 401 与 WSS 会话绑定错误帧双层)、断线重连与投影重同步(重连凭证重验 → sync-projection 对齐 → 新锚继续)、权限校验(过期 embed token / 已消费 jti 重放 / 绑定不符 / 未认证 / 过期会话凭证全部 401 统一形态)、限流(`rate:{tenant}:{user}` 触顶 429 冻结形态逐字节确定)、超时和资源限制(worker 看门狗 timeout 错误帧、请求体 413、clientSeq 预算触顶;帧超限 close 1009 由 `test/wss/channel.integration.test.ts` 承载)。**排除说明**:13.3 中 iframe 握手超时 / 自适应高度 / 主题与语言等嵌入面条目归阶段五(嵌入协议交付通道),不在本 API 侧清单。

## 三·九、可观测基线与部署收尾(阶段三 WP-8;D-API-70 ~ D-API-73)

### D-API-70 指标面最小集与 /metrics 端点形态(阶段三 WP-8;计划书 5.8 的 MVP 子集)

五个指标族(Prometheus 文本格式,`GET /metrics` 暴露;prom-client 已是依赖,零新增依赖):

| 指标 | 类型 | 标签 | 语义 |
|---|---|---|---|
| `session_api_action_rtt_seconds` | histogram | `action` / `outcome` | 动作 RTT(`manager.applyAction` 入口到响应 / 异常;p50 / p95 由分位数计算) |
| `session_api_live_sessions` | gauge | —— | 并发会话数(在途会话管理器持有量) |
| `session_api_action_queue_depth` | gauge | —— | 编排器动作队列深度(在途动作调用数) |
| `session_api_worker_processes` | gauge | —— | Worker 池占用(本编排器进程持有的 vm-worker 子进程数) |
| `session_api_projection_delta_bytes` | histogram | `action` | 投影增量字节数(已接受动作的 ProjectionDelta 序列化字节) |

端点与装配形态:`/metrics` 为**未认证的同端口运维路由**(与 `/healthz` / `/readyz` 同族),经 fastify 插件注入(`deps.metricsPlugin`),不触碰既有路由与错误面(未挂载时 `/metrics` 走 404 冻结形态,与既有兜底一致);**不新增任何配置键**(暴露面收敛——内网段 / 反向代理准入 / 独立端口——是部署面配置事项,不是端点语义变更);挂载在 runtime 全量装配(生产)与测试 rig(内存同构栈)两条路径一致。**Registry 不采集默认进程指标**:`/metrics` 上出现的指标名全部落白名单内("不泄露内部细节"的机检前提)。观测是纯增量面:指标调用不得改变既有行为(异常传播 / 响应面 / 编排语义零变化)。

### D-API-71 指标标签纪律:有界枚举域,标识符与秘密只进受控日志(阶段三 WP-8)

任务分解 §六"指标标签基数"决策点的回填。**进标签的维度**(基数恒定、与流量规模无关的有界域):

| 标签 | 值域 |
|---|---|
| `action` | 12 冻结动作类型(与会话动作协议判别字面量同源;未登记类型折叠为 `other`,基数防护兜底) |
| `outcome` | `accepted` / `rejected` / `error` 三值(拒绝单独分道;编排器域异常归 `error`) |

**不进标签、只进受控日志的维度**:sessionId(基数随会话数无界增长——基数爆炸防护,任务分解 WP-8 第 1 条)、tenantId / userId / challengeId / challengeVersion / checkpointId / requestId 等——这些维度的聚合观测走受控日志(Pino 白名单化字段,D-API-9)与审计,不进指标。**零秘密面**:指标载荷 = 聚合数值 + 有界枚举,零请求 / 响应体片段;`scanSecretCorpus`(ZR-B1 / B6 语料)对 `/metrics` 渲染输出零命中是测试锚点。**机检**:`assertMetricsTextDiscipline` 对渲染文本逐行扫描——指标名 ⊆ 白名单(`METRIC_FAMILIES`)、标签名 ⊆ 族级白名单(直方图 `le` 结构性放行)、秘密语料零命中、服务端签发标识符形态值零出现;四类违例各带红灯反例(映射文档 §五"必触发反例"纪律),与零命中断言同套件运行(`test/metrics/metrics.test.ts`)。端到端接线测试(`test/metrics/metrics-wiring.test.ts`)断言真实链路(创建 → 动作接受 / 拒绝 / 异常 → 关闭)产生的样本与真实会话 ID 零出现。

### D-API-72 队列深度与 Worker 占用的 T0 语义;OpenTelemetry span = T0 可选增量(阶段三 WP-8)

**Worker 池占用**(`session_api_worker_processes`):T0 每会话单进程模型(ADR-3)下,本编排器进程持有的 vm-worker 子进程数 = 在途会话数,与 `session_api_live_sessions` **同源同值**(创建 / 关闭 / 回收 / 收割 / 恢复纳管各同步点一致);这是构造性重合而非冗余——两个族对应 5.8 清单的两个观测意图,T1 容器化 Worker 池(进程池租约与会话解耦)引入后两者分道。**队列深度**(`session_api_action_queue_depth`)= manager 在途动作调用数(进入 / 离开执行段对称增减;单会话串行下逐会话在途 ≤ 1,总量 = 跨会话并发执行压力)。**OpenTelemetry 全链路 span**("动作请求 → 编排器 → Worker → 投影下发",5.8 追踪面)= **T0 可选增量,本阶段只登记决策、不实现、不设为退出条件**(阶段三任务分解 WP-8 第 1 条原文);触发判据:阶段四 / 五联调时跨服务排障需求实际出现,且指标面 + 受控日志不足以定位时,按本决策登记的观测缺口引入,接入点为 manager 动作入口与 WSS 通道流水线。

### D-API-73 k6 基线首采:场景形态、无阈值与归档位置(阶段三 WP-8;质量门禁 9)

场景三件(`apps/session-api/k6/scenarios/`,k6 WebSocket 模块承载 WSS):

1. `action-rtt-wss.js`——签发 → create_session(Set-Cookie 会话凭证)→ `GET /sessions/channel` 升级(Cookie 呈递)→ stop-and-wait 发送 `write_bytes` 动作帧,逐帧测量 RTT(custom Trend `wss_action_rtt_ms`)→ REST close 收尾;
2. `rest-lifecycle.js`——REST 五命令全生命周期(签发 → create → sync ×2 → list-checkpoints → close),周期时延按命令分道;
3. `concurrent-sessions.js`——ramping-vus 阶梯并发,每 VU 持有会话(周期动作维持)→ REST close;服务端并发数经 `GET /metrics` 采样(`session_api_live_sessions`,指标面的端到端观察)。

执行形态:**docker `grafana/k6` 官方镜像**(本机无 k6 二进制;`k6/run-baseline.mjs` 以 stdin 传脚本免卷挂载的 Windows 路径转换问题),对 **compose 全拓扑(容器形态)** 首采——`compose:app:up` 一键拓扑即被测系统,被测地址 `host.docker.internal:13000`(宿主侧探活 / 指标采样走 `127.0.0.1:13000`)。基线题目由 `k6/seed-challenge.mjs` 经持久化端口登记(与 compose 集成测试同一登记路径:双包 + Ed25519 登记签名,真实验签;版本不可变,重复运行复用既有版本)。**不设通过阈值**(10.3 / 13.6:性能数字经 benchmark 后再定,避免过早优化;本基线只作 T2 触发判据的数据源)——场景无 threshold 配置,采集数值不构成性能承诺。结果归档:`apps/session-api/k6/results/<UTC 时间戳>/`(逐场景原始 summary JSON + stderr 留档 + 采集前 / 后 `/metrics` 快照 + `summary.md` 人读摘要);首采记录 2026-09-10(容器拓扑;动作 RTT p50 6ms / p95 10ms,REST 生命周期整环 p50 61ms,服务端并发 gauge 峰值 6,与场景设计一致),位置 `k6/results/2026-09-09T223628898Z/`。基线负载数值纪律:限流与并发预算是生产行为(429 冻结形态),压测脚本以每迭代唯一用户规避 120 req/min 护栏的刻意削顶,**不得以调低护栏的方式做压测**;`SESSION_API_MAX_CONCURRENT_SESSIONS_PER_TENANT`(默认 8)是真实护栏,并发场景峰值压在预算内。

## 三·十、调试通道(阶段四 WP-40 / WP-41;ADR-DC1;D-API-74)

### D-API-74 独立调试通道:独立端点、独立版本锚定、帧族与共用限额(阶段四 WP-40 契约冻结 / WP-41 通道承载;ADR-DC1 条款 1~8)

调试通道是浏览器 ↔ 编排器的**第二通道**,承载调试模式档(ADR-DC1 调试克隆通道,2026-09-10 评审接受;阶段四范围扩展)。**既有 WSS 动作通道(D-API-1 / D-API-2 / D-API-40~49)行为零 diff**,本决策只登记新增面;协议语义与帧 Schema 的权威 = `packages/protocol/docs/调试通道协议语义.md`(v1 冻结)与 `@stackmaster/protocol`(`src/transport/debug-frame.ts`;变体镜像 server-only 契约 `src/debug/debug-variant-bundle.ts`),本文不重复其字段级论证。

- **独立端点**:调试通道登记为 **`GET /sessions/debug-channel`**(D-API-1 路由表的服务端面补充行;会话凭证 Cookie 交付同模型 D-API-12,升级即认证复用同一 `buildCredentialPreHandler`,401 失败响应字节级一致;GET 升级非变更方法不走 CSRF 闸,D-API-17 同纪律)。会话锚定 = 凭证 claims `sessionId`;帧绑定会话不符确定性拒绝;
- **独立协议版本与连接级锚定**:`DEBUG_CHANNEL_PROTOCOL_VERSION = 1`,受理集合锚点 `SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS`——**不随会话动作协议版本编号、不共享其常量**(D-API-2 的"传输帧随会话动作协议编号"边界不变:既有通道零触碰,调试通道自建同款锚定机制);首帧即本连接解释版本,漂移帧确定性拒绝(冻结 `PublicError` 错误帧);响应帧不携带新版本;心跳走 RFC 6455 协议层 ping/pong(D-API-6 同款);帧字节护栏沿用 `MAX_WSS_FRAME_BYTES`;
- **帧族一览**(12 值封闭判别联合,方向由类型唯一决定;语义详见协议语义文档 §三):客户端 → 服务端 5 帧(`debug_attach` / `debug_window` / `debug_step` / `debug_run_to_breakpoint` / `debug_search`);服务端 → 客户端 7 帧(`debug_attached` / `debug_window_data` / `debug_paused` / `debug_search_results` / `debug_instruction_stream` / `debug_function_table` / `error`);
- **错误帧形态 = 冻结 `PublicError`,16 错误码封闭枚举零扩展**(D-API-14 / D-API-41 / D-API-32 同族):请求侧校验失败复用 `invalid_input_format` 等,预算耗尽复用 `budget_exhausted`(与解题侧 429 冻结形态字节级一致);通道级失败(未认证 / 畸形帧 / 频率超限)同形态,零校验器细节透出;逐 code 能力矩阵(E-1–E-6 / I-8)原样适用;
- **限额共用(D-API-50~53 零新增限额类)**:调试帧经既有 `SessionActionRateLimiter` **同一每会话动作预算**(与每连接令牌桶叠加,同一实现实例);**不设第二类限额**(ADR-DC1 条款 6)。指令粒度调试步进与解题动作互相挤占预算的后果,以 `/metrics` 新增三指标族观察后调参:`session_api_debug_worker_processes`(调试 worker 占用)、`session_api_debug_frames_total{frame, outcome}`(调试帧计数;`frame` ∈ 5 值请求帧 + `other`)、`session_api_debug_budget_rejections_total`(挤占观察 = 调试帧被每会话预算拒绝计数);三指标族在指标白名单内,标签零秘密零标识符(过 `assertMetricsTextDiscipline`,D-API-71 同机检);
- **展示流推送模型**(协议语义文档 §九定案):协议 v1 的 C→S 帧族无拉取请求帧;`debug_function_table` 于 attach 完成后推恰一次,`debug_instruction_stream` 于每次暂停(`debug_paused`,含 attach 携带 paused)后紧跟暂停落点推一帧(`DEBUG_CONTEXT_INSTRUCTION_ITEMS = 16` 服务端常量);推送帧不带 `requestId`(唯一例外 = `debug_attach` 主帧携带时其伴生 `debug_function_table` 回显);推送失败 = 冻结 `error` 帧且连接不断;
- **编排面决策登记**(实现细节权威 = `docs/develop/会话编排语义规约.md` §七 D-W41-1~6 与 `docs/develop/引擎进程协议.md` §4.8):调试 worker 按需 spawn、attach 幂等复用、空闲回收复用断线保持窗口预算(不设第二类配置键);attach 重放对齐 = 权威动作日志确定性重放,**禁止真实 checkpoint 快照恢复进调试进程**;零装载(装载清单 = 变体镜像 + 公开描述包,判题面不构造、seed 不解析);调试交互不进权威日志;变体供给经 `DebugVariantProvider` 端口(WP-42 生产实现 = challenge-compiler `buildDebugVariantBundle` + 瞬态调试种子);
- **机检与跨语言消费**:调试帧与变体镜像契约进入 golden fixture 摘要清单与 contract-smoke(§1 Schema 编译 / §2 实例同判 / §3 摘要 / §4 serde + schemars 镜像);ZR-B12(帧语料 ⊆ 变体镜像包含性)/ ZR-B13(派生复算)机检见 `docs/develop/秘密零驻留CI检查项映射.md` v1.9;D-API-60 跨域载荷录制机检的既有 ZR 面零改动。



## 三·十一、嵌入交付通道与描述包下发(阶段五 WP-50;D-API-75 ~ D-API-77)

### D-API-75 embed token 浏览器交付通道:服务端注入引导配置为默认,MessageChannel port 下发为 opaque 备用(阶段五 WP-50;嵌入协议 §4.1 / §4.2 / §6.2 / V-13)

任务分解 §六 Q1 的定案。**两形态并存,默认 + 备用**:

- **默认通道 = 候选 (a):宿主服务端把 token 注入插件引导配置**(嵌入协议 §4.1 默认推荐)。token 永远走"服务端 → 服务端 → 引导配置"路径:宿主后端持 `SESSION_API_HOST_BACKEND_TOKEN` 调 `POST /auth/embed-tokens`(D-API-11,响应体 `{embedToken, expiresAt}`),把 token 组装进**插件引导配置**并经非 postMessage、非 URL 的通道交付给插件 Shell——具体载体为"插件以 iframe URL fragment 中的一次性 `embedSessionId` 经 **POST 请求体**向宿主后端的引导配置取回端点换取 `{embedToken, sessionApiOrigin, challengeId, challengeVersion, embedSessionId}`"(POST 体承载,禁入 URL query;esid 单次有效、重载即轮换,取回记录的 esid 一致性由宿主后端维护)。该取回端点属**宿主后端职责面**,不在 session-api 契约面内(session-api 只承诺签发端点 D-API-11 与消费端点 create-session);
- **备用通道 = 候选 (b):握手完成后经已绑定端点的 MessageChannel port 下发**。仅用于 opaque 部署形态(sandbox 无 `allow-same-origin`);**port 转移是该路径的必需前置**(嵌入协议 §4.2:凡经 postMessage 交付凭证 / 绑定值,必须先完成 port 转移并经 port 下发),禁止经 `targetOrigin: "*"` 的裸 postMessage 承载(V-13);
- **MVP 演示面走 (a)**。compose demo 拓扑下的可落地形态:宿主模拟页(归 WP-51,由 apps/plugin-dev 开发壳承载,`pnpm --filter @stackmaster/plugin-dev dev`,origin `http://localhost:5173` 已经 demo-override.yaml 登记进 `SESSION_API_ALLOWED_ORIGINS`)的"宿主后端"由 **vite dev server 的服务端代理层承担(开发态替身)**——代理持 `SESSION_API_HOST_BACKEND_TOKEN`(环境变量注入,不入库不入浏览器)向 session-api(`http://localhost:13000`)调 `POST /auth/embed-tokens`,页面以同源 fetch 取引导配置(含 token,仅存页面内存),插件 iframe(`src` 只带 `#esid=<embedSessionId>`,WP-52 产物)以 esid 经 POST 体取回引导配置完成 `create-session`。token 全程不进 URL query、不经 postMessage、不进日志、不超会话期留存(浏览器对 token 不透明:不解析、不校验;`EmbedTokenClaims` 解析器仅在 `@stackmaster/protocol/server-only`,既有导出纪律不变);
- **V-13 红灯反例可测锚点(本 WP 交付的文档 / 测试面;postMessage 运行时红灯归 WP-51 / WP-55)**:①引导配置取回必须 POST 体承载——路径 / query 形态的取回请求无实现面(端点契约即排除);②demo / E2E 走查链路中 token 值只出现在"签发端点响应体 → 宿主后端内存 → 引导配置响应体"三处,`test/routes/descriptor-routes.test.ts` 同款的响应面机检与 `req` 序列化器白名单(D-API-9 日志纪律)覆盖其不外溢;③运行时断言(iframe 消息序列化体不含 token 形态载荷)在 WP-51 的 V-1~V-13 逐规则红灯矩阵中落锚(嵌入协议 §八"阶段五实现评审对照");
- **TTL 运维参数定案:`SESSION_API_EMBED_TOKEN_TTL_SECONDS` 维持默认 3600 s、上限 `MAX_EMBED_TOKEN_TTL_SECONDS`(604800)不变**(D-API-19 登记表原样)。理由:嵌入协议 §6.3"建议分钟级"的意图是压缩**未消费 token 的滞留窗口**——本系统中 token 的防伪造 / 防重放锚点是 Ed25519 签名 + `jti` 单次原子消费 + `embedSessionId` 绑定(D-API-14),TTL 只影响"签发后未消费"的记录存活期,不放大越权面(jti 消费即作废,窃取窗口以一次为限);MVP 演示面(demo-override 人工走查、E2E)需要 token 在页面停留与走查讲解期间保持可用,分钟级会造成演示中断,3600 s = 一次走查会话的量级;生产部署可通过配置键下调(建议 300–900 s),外圈护栏 604800 仅覆盖未来"多日嵌入"场景,MVP 不配置到上限。`embedSessionId` 重载轮换使旧 token 自然失效(嵌入协议 §6.2),无需依赖短 TTL 补偿。

### D-API-76 公开描述包发布清单:复用 challenge_versions 双包摘要 + 端点动态校验;端点 `GET /descriptors/:challengeId/:version`(阶段五 WP-50;§8.3 / D-API-23 / D-API-32 / D-API-66)

任务分解 §六 Q2 的定案:**不立独立清单契约、不走 WP-1 §1.3 流程**,按任务分解倾向定案——发布清单(§8.3"发布清单应有内容哈希或签名")的语义由 **PG `challenge_versions` 行内双包 SHA-256 摘要 + 端点取回后动态复算比对**承载;摘要的真实性上游由登记签名担保(Ed25519 over `registrationSignatureBasis`,基线含双摘要,D-API-23),端点无需第二签名面。理由:MVP 契约面最小(零新 Schema、零 fixture 增量);摘要已受验签担保;独立清单契约引入"清单 ↔ 注册表行"的双真源同步问题,其收益(离线可验)在 MVP 拓扑无 CDN 的前提下不成立。

**端点校验语义(实现:`apps/session-api/src/routes/descriptor-routes.ts`;测试:`test/routes/descriptor-routes.test.ts`)**——服务序,每步确定性拒绝、响应面恒为冻结 `PublicError`:

1. **参数字符集校验**:challengeId 走冻结标识符字符集(`^[A-Za-z0-9_-]{1,128}$`)、version 走语义化版本字符集(与 embed token claims / 登记路径同一模式,显式禁路径穿越)→ 不合即 **404 + `invalid_input_format` / "resource not found"**(与未登记同形,防枚举)。配套:`routerOptions.maxParamLength` 放宽 100 → 256(≥ 参数上限 128),消除框架级 414 与同形纪律的冲突(超长参数改由字符集闸拒绝);
2. **注册表查版本行**:`ChallengeRegistry` 端口最小扩展 `findPublishedChallengeVersion(challengeId, version)`(memory / PG 双实现同构;**查询层租户过滤的第二处跨租户例外**,先例 D-API-63 `listActiveSessions`——公开描述包是公开内容,下发端点无租户上下文;`(challenge_id, content_version)` 为全局唯一主键,行内容即公开元数据;私有面 `findChallengeVersion` 租户强制过滤不变,本方法禁用于私有判题包路径)→ 未登记 **404 同形**(SSRF 纪律:只接受已登记派生获取路径,拒任意 URL);
3. **对象取回**:复用既有 `ChallengeBundleStore.getPublic`(`public-descriptors` 桶,零端口扩展)→ 行在而对象缺失 = 服务端一致性事故,**422 + `internal_error` / "challenge invalid"**(与 D-API-32 challenge_invalid 行"双包缺失"同形,防题目枚举);
4. **响应护栏**(数值过天花板纪律):响应体字节上限 `SESSION_API_MAX_DESCRIPTOR_BYTES`(解析前强制)→ SHA-256 复算与登记摘要比对(不符 **422 challenge invalid 同形**;红灯语料:摘要篡改)→ JSON 解析 → 结构巡检(嵌套深度取 `SESSION_API_MAX_JSON_DEPTH` / 数组 256 / 字符串 4096,与 D-API-31 请求护栏同值装配)→ 越限 **422 同形**(红灯语料:超限载荷);
5. **200 返回**:体 = 桶内原始字节(零重序列化,逐字节确定性,I-4);`Content-Type: application/json; charset=utf-8`;**`ETag` = 登记摘要**(实体标签形态,为 CDN 期条件请求与缓存复用铺路;本阶段不做 If-None-Match 协商);`Cache-Control: public, max-age=3600, immutable`(版本不可变语义)。

**认证姿态(定案)**:公开描述包是公开内容(设计上可 CDN 分发),**无凭证 GET**——零租户、零会话、零凭证面,不设 CSRF 闸(无 Cookie 呈递语义)、不设租户限流(`rate:{tenant}:{user}` 无身份锚可计量;滥用防线 = CDN 期边缘限流 + 本端点响应护栏)。**CORS 放行面**:沿用全局 `@fastify/cors` 精确来源白名单(`SESSION_API_ALLOWED_ORIGINS`,D-API-16 既有装配;GET 在既有方法集内)——浏览器面插件 iframe 跨源获取需要 ACAO,白名单命中即回显 `Access-Control-Allow-Origin`;**白名单缺省(空表)= 跨源面全拦**(fail-closed 默认不变),同源调用与非浏览器调用方不受影响。**ETag 跨源可读(2026-09-11 增补)**:CORS 装配 `exposeHeaders: ["ETag"]`——ETag = 登记摘要是描述包客户端加载器(WP-54)完整性校验的锚,跨源插件 iframe 的 fetch 不读到该头即无法做客户端侧哈希比对;断言锚 `test/routes/descriptor-routes.test.ts`(ACAO 回显用例增补 expose-headers 断言)。**零秘密面自证**:响应体只含公开 Schema 字段(形态合法性由登记管线上游担保;本端点担保完整性[摘要]与尺寸护栏;客户端侧 WP-54 另有"哈希校验 + 尺寸护栏"双闸,§8.3 双闸纪律)——机检锚点:响应体经跨域载荷扫描(`scanCrossDomainPayload`,ZR-B9/B10/B5/B4 同源规则)零命中 + FLAG 语料零出现,红灯反例同套件证明可检出(`test/routes/descriptor-routes.test.ts`);bytesHex 等公开十六进制载荷为 I-10 值来源,seed 语料模式对公开描述包不适用(D-API-60 豁免面同源)。

**签名 URL 路线的放弃理由**(§8.3"签名 URL 或端点二选一"):MVP 拓扑无 CDN,签名 URL 需要新增 MinIO presigned 生成面与公开桶匿名读策略,且响应纪律(冻结 `PublicError`、护栏、机检)无法施加于绕过编排器的直连取回;端点路线复用既有对象存储端口与响应纪律,契约面最小。CDN 期为部署面挂接:端点语义不变,ETag / Cache-Control 已铺路(边界裁决 4:CDN 不在本阶段)。

**配置键登记(过 D-API-9 三道闸)**:

| 键 | 必备 | 默认 | 约束 |
|---|---|---|---|
| `SESSION_API_MAX_DESCRIPTOR_BYTES` | 否 | 262144 | 上限 4194304(公开描述包响应体字节上限;解析前强制,超限 422 challenge invalid 同形) |

**红灯矩阵(完成标准逐项,全部冻结 `PublicError` 形态、响应体逐字节断言)**:

| 红灯 | 呈现 | 语料 |
|---|---|---|
| 未登记题目 ID / 版本 | 404 `invalid_input_format` / "resource not found" | 未登记 challengeId、未登记 version(确定性逐字节) |
| 参数字符集违规(含路径穿越) | 404 同形(防枚举) | `..`、`%2F`、非 semver、超长 ID(maxParamLength 放宽后仍同形) |
| 摘要篡改 | 422 `internal_error` / "challenge invalid" | 桶内对象被替换为与登记摘要不符的字节 |
| 响应体字节超限 | 422 同形 | 摘要相符但超 `SESSION_API_MAX_DESCRIPTOR_BYTES`(护栏独立可证) |
| 结构越限(深度 / 数组 / 字符串) | 422 同形 | 32 层嵌套数组(深度护栏 16),摘要相符 |
| 对象缺失(登记行在、桶内无对象) | 422 同形 | 手动登记版本行不放桶 |

真实 MinIO / PG 路径的端口同构性由容器门控集成测试覆盖(`test/persistence/descriptor-publish.integration.test.ts`,SESSION_API_IT 门控,缺环境跳过并注明)。

### D-API-77 嵌入面运维参数:T_handshake、消息字节 / 高度护栏与按类型频率上限(阶段五 WP-50;嵌入协议 V-2 / V-10 / §4.3 / §三)

浏览器侧 embed-runtime(WP-51)/ web-component(WP-52)的**构造参数面**定案——非 `SESSION_API_` 环境键(不进配置三道闸),配置载体 = **embed-runtime 工厂函数构造选项**(框架无关 core 暴露;react-wrapper 薄封装透传;插件侧常量内置于 web-component)。协议冻结常量(`MAX_EMBED_MESSAGE_BYTES` / `MAX_EMBED_HEIGHT_PX`,packages/protocol/src/common/limits.ts)**引用不重造**:实现直接 import,构造选项不提供放宽入口。后续波次(WP-51 / WP-52 / WP-54 / WP-55)直接引用本表:

| 参数 | 默认值 | 边界 | 配置载体 | 引用方 |
|---|---|---|---|---|
| `T_handshake`(握手超时) | 10000 ms | 允许范围 3000–30000 ms,越界取边界值(clamp) | 构造选项 `handshakeTimeoutMs` | WP-51 embed-runtime(宿主侧:iframe `load` 后未收 `hello` 即标记 embed 会话不可用,§4.5);WP-52 web-component(插件侧:`hello` 发出后未收 `ready` → 降级显示,§4.3) |
| `MAX_EMBED_MESSAGE_BYTES` | 65536(protocol 冻结常量) | 不可调 | 恒定引用 `@stackmaster/protocol` | WP-51(V-2:序列化字节超限,JSON 解析前丢弃 + 计数);WP-52(发送侧自检) |
| `MAX_EMBED_HEIGHT_PX` | 100000(protocol 冻结常量) | 宿主可收紧、不可放宽 | 构造选项 `maxHeightPx`(≤ 冻结常量,超上限拒绝装配) | WP-51 / WP-52(`height_changed` 载荷契约护栏 + 宿主布局收紧) |
| `height_changed` 频率(V-10) | 动画帧级合流(每 rAF 至多一帧,尾沿携带最新值)+ 每秒硬上限 30 | 构造选项 `heightChangedMaxPerSecond`(1–120) | WP-51 宿主侧节流器;WP-52 插件侧发送协同(内容变化驱动 + 同款合流) | V-10 超限丢弃 + 本地计数,零反馈(V-12) |
| `hello` 重试上限(§4.3) | 3 次(`T_handshake` 窗口内,`seq` 递增;耗尽即降级显示,不向宿主重试风暴) | 构造选项 `helloMaxRetries`(0–10) | WP-52 web-component;WP-51 宿主侧对重复 `hello`(握手完成后再收)按状态违规丢弃 + 计数 | 嵌入协议 §4.3 / §4.5 |
| `theme_changed` / `language_changed` 频率(V-10) | 每秒上限 10(低频控制消息;宿主 → 插件方向,宿主自控) | 构造选项 `controlMessageMaxPerSecond`(1–120) | WP-51 embed-runtime | 未授予能力时恒不发送(§4.4 降级矩阵,V-8) |

选值理由:`T_handshake` = 10 s 量级覆盖慢速网络下的 iframe 加载 + 握手往返,同时把不可用 embed 会话的僵尸窗口限制在用户可感知的秒级(§4.3 降级显示随即接管);`height_changed` 动画帧级合流使宿主布局更新频率 ≤ 渲染帧率(协议 §三"宿主可按实现期节流策略进一步收紧"的落地),每秒硬上限封堵非 rAF 环境的绕行;控制消息每秒 10 远高于人工切换主题 / 语言的合理速率,低于任何资源压力。全部超限处置统一"丢弃 + 本地计数,不回错误、不中断会话"(V-10 / V-12);计数面对 WP-51 的"超时降级路径事件计数面"条目可见。

## 三·十二、嵌入实现面(阶段五 WP-51 ~ WP-54;D-API-78 ~ D-API-82)

> 本节为 WP-51~54 实现期定案的**事后收编**(事实源 = 五决策草稿 `docs/develop/阶段五WP51~55决策草稿.md`;全部定案**零契约改动**——嵌入协议 v1(`EmbedMessage` 六字段五类型、V-1~V-13、handshake 五路径、能力枚举与主题三值)与公开描述包 Schema 16 字段均为冻结面,本节只登记实现语义)。WP-55 的 E2E 场景映射、axe 扫描口径与 13.4 矩阵口径为**测试基建口径**(随实现演进,非 API 语义),登记于其决策草稿,不入 D-API。

### D-API-78 embed-runtime 宿主侧 SDK:Q4 分层同源、构造参数解析形态、违规计数键与 port 凭证信封 wire 形态(阶段五 WP-51;嵌入协议 §四 / §五 / V-1~V-13;零契约改动)

**Q4(V 规则引擎落点)定案 = 分层同源**:消息契约层消费 `@stackmaster/protocol` 公开入口天然同源(零新决策);V 规则编排层中**无状态构件单实现双侧复用**——版本协商 `negotiateEmbedProtocolVersion`(max-wins 纯函数)、esid 生成 / 校验 `generateEmbedSessionId` / `validateEmbedSessionId`、按类型滑动窗口限速器 `TypeRateLimiter`(D-API-77 两频率参数同款语义)、违规计数键 `VIOLATION_COUNTER_KEYS`(键集以规则编号为前缀,双侧计数面同键名,E2E 同一断言词汇);**宿主独有编排**(来源 / source 三重绑定、esid 全等 + 窗口绑定、接收端高水位、能力授予 `granted ⊆ hello.capabilities`、T_handshake 超时、port 转移发送面)与**插件独有编排**(fragment 读取的发起方角色、插件侧高水位、能力降级三行、宿主 origin 钉住)各自持有——理由:协议解析器已同源,双侧真正同构的只有无状态构件,强行共享方向参数化引擎复杂度高于收益。

**实现定案**:

1. **构造参数解析单点化**:`createEmbedSession(options)` 内 `resolveEmbedSessionOptions` 统一解析——`handshakeTimeoutMs` clamp 3000–30000(默认 10000)、`heightChangedMaxPerSecond` clamp 1–120(默认 30)、`controlMessageMaxPerSecond` clamp 1–120(默认 10)、`helloMaxRetries` clamp 0–10(默认 3),非整数 / 负数装配拒绝(`EmbedInvalidOptionError`);`maxHeightPx` 默认 = 协议冻结常量、只可收紧、超上限**拒绝装配**(不 clamp,与 D-API-77 逐字一致);
2. **`helloMaxRetries` 宿主侧语义**:该参数是插件侧重试预算(§4.3),宿主不消费其值发起重试——握手完成后再收 hello 按状态违规丢弃 + 计数(§4.5);选项保留仅为参数面完整性(react-wrapper 透传、诊断面板 `getResolvedParameters()` 可读);
3. **supportedVersions fail-closed**:宿主声明支持的每个版本必须在版本 → Schema 注册表有对应版本 Schema(冻结期只有 v1),否则装配拒绝——宿主不得声明无法校验的版本(N-1 窗口开启时随 protocol 新 Schema 一起注册);
4. **违规计数键命名**:规则编号前缀(`v1-origin-mismatch` … `v10-rate-limit`)+ `state-hello-after-ready` + `unavailable-drop`;每次递增伴随 `violation-counters-changed` 事件、快照全键稳定(未命中补 0)——V-12"宿主本地面"的可读出形态,不向对端反馈任何内容;
5. **入站校验序**(未在契约冻结,实现定案):不可用后迟到消息 → V-1 / V-1'(含非 opaque 的窗口绑定复核,失败计 `v1p-source-mismatch`)→ V-2(字节上限在 JSON.parse 前)→ V-3 → V-4 → V-5 → V-6 → 状态机分发(V-7 → V-8 → V-10);
6. **宿主 API 误用 = 同步类型化错误**,不属于 V-12 反馈面:不可用后调控制面方法抛 `EmbedUnavailableError`、未授予能力抛 `EmbedCapabilityNotGrantedError`、握手未完成调 port 交付抛 `EmbedPortDeliveryError`;V-12 约束的是 postMessage 通道对端反馈,入站违规永远静默丢弃 + 计数;
7. **V-10 出站自限**:宿主自身发送(theme_changed / language_changed)受 `controlMessageMaxPerSecond` 约束,超限静默丢弃 + 计数并返回 false(seq 不消费;插件侧跳号可接受,V-7);
8. **重载语义(§4.5)**:`reload()` 生成新 esid、旧值立即作废、对端 seq 高水位与能力授予清零、port 关闭复位、状态回 idle;`embed-reload-initiated` 事件携带新 esid 与新 iframe src;重载后 token 重签由宿主自理(旧 token 因会话绑定不匹配自然失效);
9. **iframe URL fragment 纪律的机械执行**:`buildIframeSrc()` 是 fragment 唯一产生点(`#esid=<esid>`);构造选项 `pluginUrl` 携带 fragment 即装配拒绝;
10. **opaque 路径(V-1')**:opaque 模式完全忽略 `event.origin`,仅接受 `event.source === iframe.contentWindow`(经 `attachIframe` 实时读取,重载后新文档自动获得正确绑定);iframe 未挂接 = fail-closed 拒绝;非 opaque 模式除 origin 全等外复核 source 绑定;
11. **port 凭证信封 wire 形态**:port 转移消息 `data=null` 零载荷(不携带凭证与绑定值),port 在 `event.ports[0]`;凭证信封 `{kind: "stackmaster:embed-credential", credential}`(kind 常量 `EMBED_PORT_CREDENTIAL_KIND`);转移后宿主控制面消息改走 port(信封仍为 EmbedMessage 六字段);宿主 → 插件 EmbedMessage 以结构化对象 `postMessage` 到达(非 JSON 字符串),非 opaque 时 targetOrigin 恒为宿主声明 `pluginOrigin`、opaque 时 `"*"`(凭证永不走该面)。

测试锚:`packages/embed-runtime/test/`(62 用例:状态机 / V-1~V-13 逐规则红灯 / 计数键稳定性 / clamp 与装配拒绝矩阵 / port 信封 / 重载语义);react-wrapper 8 用例;E2E 伪造消息矩阵(`apps/plugin-dev/e2e/embed-protocol.spec.ts`)以同一计数键词汇断言。

### D-API-79 插件 Shell(`<pwn-memory-vm>`)装配形态与插件侧协议行为:Q3 workspace 依赖 + 自包含单产物、demo 双端口拓扑、插件侧校验序(阶段五 WP-52;嵌入协议 §4.1 / §4.4 / §4.5;零契约改动)

**Q3(web-component 与 vm-ui 装配形态)定案 = workspace 依赖 + vite 库模式自包含打包**(占位期"不得依赖 vm-ui"边界解除):依赖面 = `@stackmaster/vm-ui`(工作区装配)+ `@stackmaster/embed-runtime`(Q4 无状态构件复用)+ `@stackmaster/protocol`(公开入口;浏览器绝不解析 token);产物 = 单入口单产物 `dist/index.js`(lit / vm-ui / protocol / embed-runtime 全部内联,`codeSplitting: false`),机械断言 `test/artifact.test.ts`(零外部导入、零相对 chunk、组件注册面完整);插件文档页以**相对路径**引用产物(非根路径部署兼容)、零内联脚本(`script-src 'self'` 真实运行证明)。dependency-cruiser 放行边修订(随规则修订必带反例自检):新增 `web-component → embed-runtime`、`web-component → vm-ui` 两条放行,`→ web-component` / `→ react-wrapper` 方向仍全禁(装配叶子),`lint:deps:self-test` 同步 16 组边期望。

**demo 拓扑(独立来源双端口)**:宿主模拟页 `http://localhost:5173/host-mock/`(plugin-dev vite dev + 签发代理 `/host-api/embed-tokens` + 引导取回 `/host-api/embed-bootstrap`)× 插件文档页 `http://localhost:5174/`(plugin-site-server 零依赖静态服务器,`dev:plugin-site`);引导取回端点对 `PLUGIN_SITE_ORIGIN` 白名单(缺省 5174)回显精确 ACAO + OPTIONS 预检(fail-closed);`compose/demo-override.yaml` 增补 5174 进 `SESSION_API_ALLOWED_ORIGINS`(插件 iframe 内 SessionClient 直连 session-api 的 CORS / CSRF / WSS Origin 白名单;业务数据走插件 ↔ session-api 认证通道不经宿主转发)。签发代理 `/host-api/embed-tokens` 保持同源-only(宿主页面面),跨来源插件取回由 `/host-api/embed-bootstrap` 承担(D-API-75 默认形态的 dev 替身)。

**插件侧协议行为定案**(嵌入协议 §四 / §五插件角色):

1. **hello 窗口语义**:窗口内总发送次数 = 1 + `helloMaxRetries`(默认 3 → 至多 4 发),固定间隔 = `T_handshake / (helloMaxRetries + 1)`(默认 2500 ms);窗口到期未就绪 → 降级显示(静态文案,零反射面),不向宿主重试风暴;每次发送 seq 严格递增;`retry()` = 同会话重开窗口与预算、seq 不清零;
2. **降级态的迟到 ready**:通过全部校验的迟到 ready 仍完成握手并撤除降级 UI(降级显示是 UI 状态而非会话终结;宿主侧超时路径才是会话不可用的权威面);
3. **入站校验序**(与宿主侧登记序同构):port 转移识别 → V-1'(source === window.parent 恒核)→ V-1(钉住后核 origin)→ V-2(**结构化对象与字符串 JSON 双形态受理**)→ V-3(受理集 [1])→ V-4 → V-5(esid 全等)→ V-6 → 分发(ready:V-7 → 防御性 V-8 → 钉住 origin → 幂等重放;控制消息:V-7 → V-8 → 高水位 → V-10 入站外圈);
4. **V-10 插件侧双闸**:入站控制消息外圈(`TypeRateLimiter` 复用)+ 出站 height_changed 管道自限;本地计数键 `pwn-height-oversize`(内容高度超 `MAX_EMBED_HEIGHT_PX` 整条不发)/ `pwn-height-rate-limit`,与协议违规键合并经 `violationCounters` 可读;
5. **能力降级三行(§4.4)**:未授予 auto_resize → 固定高度不发 height_changed;未授予 theme / language → 内置默认(light / zh-CN);空数组 = 完全静态形态;违反方向的消息丢弃 + 计数不中断;
6. **装配时序**:esid 读取(fragment 一次性)→ hello 立即发出(握手不依赖 token)∥ 引导配置取回 → ready + 引导配置双就绪 → `SessionClient.createSession`(embedToken 随命令体、`embedSessionId = esid`、credentials: "include" 冻结契约)→ `connect()` → 挂载 `<sm-workspace>`;create_session 失败 → 静态文案降级(PublicError 细节不进 DOM);
7. **iframe 重载 = 新文档新实例**:全部状态从零(esid 重读、seq 自 1、外观回内置默认、零持久化写入);工作区 `new-session-request` → 宿主重载 iframe(§4.5 新 esid)归宿主 UI。

测试锚:`packages/web-component/test/`(76 用例:handshake 25 / 高度上报 7 / 能力降级矩阵 / 集成 4 / 描述包通道 8 / 产物机械断言);真实浏览器冒烟六步(`apps/plugin-dev/host-mock/smoke-embed.mjs`);E2E `embed-protocol.spec.ts` 全套。

### D-API-80 主题机制最小面:Q6 八变量功能对比度、`data-sm-theme` 锚注入、auto 由 CSS 承担(阶段五 WP-53;嵌入协议 §三 theme 三值;零契约改动)

**Q6(主题层最小面)定案 = 8 个 CSS 自定义属性功能对比度最小面**(视觉风格零重设计,light 值 = 现行硬编码值原样、像素级零变化;dark 值 = 功能对比度初值,以 axe 真机门禁为唯一口径——真机扫描零 violations,初值直通零校准):`--sm-border` / `--sm-border-button` / `--sm-border-strong` / `--sm-divider` / `--sm-divider-faint` / `--sm-badge-bg` / `--sm-badge-bg-soft` / `--sm-danger`。**系统颜色关键词不入变量面**(`canvas / canvastext / graytext / highlight / accentcolor / mark / field / linktext` 及 color-mix 组合随 `color-scheme` 自动适应明暗)——这是"最小面"收敛到 8 个的原因。

**注入机制**:变量经 `data-sm-theme` 属性锚(light|dark|auto 三值)+ 文档级样式表(`ensureSmThemeStyles()` 幂等注入)+ CSS 自定义属性继承穿透 shadow DOM 落地——各组件 `var(--sm-*, <light 值>)` 消费,嵌套组件零重复定义、组件零硬编码颜色(机械护栏测试);`auto` 的暗色规则置于 `@media (prefers-color-scheme: dark)` 内,vm-ui 零 JS 解析、零监听器泄漏。**边界登记**:嵌入形态的 `auto` 已由 WP-52 `EmbedAppearanceController` 按插件自身 `prefers-color-scheme` 解析为二值 `resolvedTheme` 落锚(matchMedia 注入缝可测),两条 auto 路径互不依赖;独立使用形态 `<sm-workspace theme="light|dark|auto">` 属性转写为自身锚(最近锚优先,确定性)。

测试锚:`packages/vm-ui/test/theming/theme.test.ts`(变量面 / 锚注入 / 机械护栏 / axe 双主题零 violations,`color-contrast` jsdom 豁免已由 WP-55 真机关闭);`packages/web-component/test/plugin/appearance.test.ts`(resolvedTheme / matchMedia);真机证据 `apps/plugin-dev/e2e/reports/axe/2026-09-11/`。

### D-API-81 语言机制:Q5 全量抽取 zh-CN + en、BCP-47 确定性降级、`data-sm-language` 锚消费与固化语义(阶段五 WP-53;嵌入协议 §三 language BCP-47;零契约改动)

**Q5(语言内置集与 i18n 抽取面)定案 = 全量用户可见字符串抽取(~420 键),MVP 语言集 {zh-CN(默认), en}**:zh-CN 目录值 = 现行文案原样(抽取是"键化"不是改写,既有 518 用例文案断言一字不差零回退);en 目录给出真实可读英文翻译;zh-CN 目录为键集事实源(`as const` → `SmMessageKey`),en 目录 `Record<SmMessageKey, string>` 类型强制同键集(缺键 / 多键 = 编译错误 + 完整性测试红灯),参数占位 `{name}` 双语同构;键命名 `<域>.<语义名>`。**不入目录面**:协议 / 状态机词原样呈现(连接态、投影 status、动作类型名等)与数据值(地址、寄存器名、错误 code、十六进制)——协议词汇翻译反而破坏与契约的同形性。

**降级与消费**:BCP-47 匹配降级确定性(`resolveLocale`:精确匹配(大小写 / 下划线归一)→ 主子标签前缀匹配(zh-TW → zh-CN、en-GB → en)→ 内置默认 zh-CN;未知 / 空 / 非法标签确定性落默认);响应式 locale = 模块级单例 store(`setLocale / getLocale / onLocaleChange`)+ Lit `LocaleController` 订阅(**全局单 locale 属 MVP 形态**,iframe 内单工作区);锚消费 = `consumeAnchoredLanguage()` 沿 composed 树找最近 `[data-sm-language]` + 共享 MutationObserver(运行中 `language_changed` 更新锚即生效;锚晚于组件连接出现不追溯——嵌入形态宿主元素 connectedCallback 即落锚,不发生)。

**固化语义(定态登记)**:状态字符串(payload 执行日志、状态行、时间线 / 编译步骤标签)按生成时刻 locale 固化;标签页标题在打开时刻求值;积木画布按 Blockly 注册时刻 locale 固化(`registerPayloadBlocks()` 取词;常量保持 zh-CN 快照 = 既有测试与公开 API 面不变;运行中切换不追溯,演进项见验收评审 §六)。

测试锚:`packages/vm-ui/test/i18n/i18n.test.ts`(目录完整性双向 / BCP-47 全矩阵 / 占位符集合一致)、`test/i18n/locale-anchor.test.ts`(锚消费与降级、无锚 = 默认,与 web-component 能力降级矩阵共用语义锚);E2E 语言切换双向 + 未知标签回退(`embed-protocol.spec.ts`)。

### D-API-82 公开描述包客户端加载器:双闸护栏、ETag 完整性闸、失败折叠缺席明示与装配时序(阶段五 WP-54;§8.3 / D-API-76 / D-API-31;零契约改动)

**落点 = `packages/vm-ui/src/descriptor/challenge-descriptor.ts`**(插件与 dev 壳共用;只依赖 protocol 公开入口与自身,零新契约)。**获取序**(每步确定性拒绝,折叠为布尔结果 + 原因码,不抛错):定位参数闸(origin 形态 / challengeId 冻结字符集 / version 路径卫生)→ `GET /descriptors/{challengeId}/{version}`(无凭证,D-API-76;网络失败至多一次显式重试)→ 非 200(404 → `not-found`,与未登记服务端同形,客户端不区分)→ **尺寸护栏第一闸**(Content-Length 显式超限不读体 / 响应体字节超限)→ **完整性闸**(`ETag` = 登记摘要,剥 `W/` 前缀与引号;缺失不可读 → `etag-missing`;WebCrypto SHA-256 复算不符 → `digest-mismatch`)→ JSON 解析 → **尺寸护栏第二闸**(深度 16 / 数组 256 / 字符串 4096,服务端 D-API-76 / D-API-31 同值的客户端镜像)→ 轻量结构校验(对齐锚 = 公开 Schema 16 字段:必需 / 未知顶层字段拒绝 / 枚举封闭集 / `after_n_failures ⇒ failureThreshold` 必填 / minItems 同值)→ 强类型 `ChallengeDescriptorView`(hintLadder / publicErrorMapping 直接复用 ed-types 结构类型;debugMode / aslrEnabled 归一化为布尔)。**客户端护栏数值**:`maxBodyBytes = 262144`(= 服务端 `SESSION_API_MAX_DESCRIPTOR_BYTES` 默认)/ 深度 16 / 数组 256 / 字符串 4096,可注入收紧。

**失败呈现纪律**:全部失败折叠进 `descriptorStatus = "absent"` → 工作区「题目描述未加载」静态明示面板;原因码属诊断面不进玩家可见 DOM;不中断会话、零重试风暴。**装配时序**:引导配置就绪即并行发起描述包获取(与 create_session 并行),晚到即注入(hintLadder / publicErrorMapping / 静态面 / debugModeAvailable 到达即补写)、缺席不中断会话(渐进增强,workspace 就绪只等待握手 + create_session)。**静态面落点**:`sm-workspace.challengeStatic`(title / summary / VM Profile 事实表 / encodingTable)+ `<details>` 折叠形态零视觉重设计,新文案走 D-API-81 i18n 双目录;缺席明示 ≠ 空数据(与"本题没有配置提示"语义分离)。**plugin-dev 双通道**:夹具通道缺省保留(开发态零依赖正式部署,形态自检测试继续生效)、`?descriptor=formal` 经 vite `/descriptors` 反代同源走正式端点(同源形态 ETag 可读);跨源直取依赖服务端 `exposedHeaders: ["ETag"]`(D-API-76 增补段,主控已登记)。夹具 ↔ 公开 Schema 形态一致性断言(`packages/challenge-schema/test/fixture-consistency.test.ts`)对齐锚 = 公开 Schema。

测试锚:`packages/vm-ui/test/descriptor/challenge-descriptor.test.ts`(获取序 / 红灯逐项 / 护栏 / 原因码)、`packages/vm-ui/test/workspace/sm-workspace-descriptor.test.ts`、`packages/web-component/test/descriptor-channel.test.ts`(装配管线,76 用例之一部)、`packages/challenge-schema/test/fixture-consistency.test.ts`;E2E `apps/plugin-dev/e2e/descriptor.spec.ts`(正式下发全链路 3 用例)。

## 三·十三、裁决呈现通道与异步裁决语义(阶段六 WP-60;D-API-83 ~ D-API-86)

> 本节为 WP-60「裁决呈现通道与异步裁决语义定案(前置,契约先行)」的定案记录,对应阶段六任务分解 §一边界裁决 2 的候选新契约面 (a) 与 §六决策点 Q2 / Q3。**契约先行纪律**:本节定案与 `@stackmaster/protocol` 契约增量(`VerdictQueryResponse`)、字段分类硬门槛论证(WP-1 清单 §6.10,v1.14)、golden fixture 与 contract-smoke 接入同步冻结;session-api 路由实现归 WP-63(呈现消费)、verifier 服务本体归 WP-61——**实现不得先于契约**(WP-60 完成标准,本 WP 不动 session-api / verifier 实现面与 vm-engine)。既有契约面零改动:submit 响应面 `{submissionId, revision}`、12 动作、16 错误码、嵌入协议 v1、调试通道协议、会话 WSS 通道全部原样(阶段六边界裁决 2)。

### D-API-83 裁决呈现通道定案(Q2):REST 查询面 `GET /verdicts/:submissionId`;呈现链路 = session-api 读裁决域;载荷上限面 = 11 值公开、其余 SERVER_ONLY(阶段六 WP-60)

任务分解 §六 Q2 的定案。三候选取舍:

- **定案 = 候选 (a) REST 查询面**:正式裁决是低频查询(一次提交至多数次重询),不是交互流;REST 面复用既有凭证 / 错误 / 限流 / 机检全套纪律,契约面最小;
- **排除候选 (b) 认证 WSS 通道帧扩展**:阶段六边界裁决 2 冻结「会话 WSS 通道零改动」,帧类型集合封闭(D-API-6:扩展消息类型 = 协议版本演进);裁决呈现新开帧族即触发既有通道版本面演进,违背「本阶段候选新契约面恰两处、通道零改动」基线;
- **排除候选 (c) 两者并存**:WSS 推送形态在 (a) 已可承接(客户端重询即推送的退化形态),双面冗余扩大探测面与实现面,零收益。

**呈现链路定案**:session-api(信任域 2)直接读裁决域 PG `verdicts` 表呈现;**verifier(信任域 4)不对外提供查询面**——信任域 4 是独立凭证与网络域(5.2 / 5.8),零浏览器可达路由面。裁决唯一出处 = verifier 对规范化动作日志的独立重放(硬门槛),呈现 = session-api 读库:写入方与呈现方经 PG 单向解耦,verifier 故障不拖垮呈现面(已落库裁决可查,未落库 = 确定性 pending,D-API-84);编排器、通道与浏览器任何位置不预判、不缓存、不改写裁决(硬门槛)。

**认证与归属校验(会话凭证同模型)**:裁决查询复用会话凭证(`authenticateSessionCredential` 同一入口,Cookie 呈递;GET 非变更方法不走 CSRF 闸,D-API-17 同纪律)。**Cookie Path 调宽登记**:D-API-12 的凭证 Cookie 为精确 `Path=/sessions`,裁决路由族在其覆盖之外——按 D-API-12 预留的装配参数路径调宽 cookie path 至根 `Path=/`(覆盖 `/sessions` 与 `/verdicts` 两族;`HttpOnly` / `Secure` / `SameSite=Strict` 属性零改动;签发端点 `/auth/embed-tokens` 与公开描述包 `/descriptors` 不读凭证,不受影响)。定位链:`verdicts` → `submissions`(同 `submission_id`)→ 会话归属(tenantId 与凭证 claims 全等 + sessionId 与凭证 claims 全等;查询层租户校验强制,D-API-20),任一环不符 = **404 + 冻结 `PublicError`**(`invalid_input_format` / "resource not found")——跨租户、跨会话与"不存在"同形态(防枚举,D-API-32 会话定位失败行同形)。

**载荷上限面与字段分类论证(硬门槛)**:载荷为五字段 strictObject 上限面 `{submissionId, revision, status: "pending" | "verdicted", verdict?: <冻结 11 值结果类型>, decidedAt?}`——**11 值结果类型公开,其余全部 SERVER_ONLY**。逐字段硬门槛论证见 WP-1 清单 §6.10(v1.14,走 §1.3 契约变更流程先行);要点:判定细节(`verdicts.detail` 列)、提交引用(`submissions.reference`,D-W8-9 完整形态)、隐藏测试内容、谓词 / 命中 / 测试索引、重放中间态在本载荷**无 sanctioned 表达位**(strictObject 即拒,红灯 fixture 登记);零部分匹配信息(D1 约束 1 / 3、I-7:无进度字段、无队列位置、无预计等待);载荷字段全部 `PUBLIC`(值来源 ⊆ 服务端签发标识符 / 玩家操作史 / 裁决落库状态 / 公开枚举契约 / 服务端时钟)。跨域载荷机检(ZR-B9 / ZR-B2 语料)对响应录制面的覆盖沿 D-API-61 既有捕获面延伸(归 WP-63 / WP-67 集成承接)。

**版本面**:`VERDICT_CHANNEL_PROTOCOL_VERSION = 1`(独立契约族,与调试通道同款独立编号先例——新契约面按 5.6 携带独立版本号,不搅动既有协议版本空间),受理集合锚点 `SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS`,JSON Schema $id 命名空间 `https://stackmaster.dev/schemas/verdict/v1`;**响应载荷不携带版本字段**(沿 `SessionCommandResponse` 先例,N-1 受理是路由级事实,回显版本判定细节即扩大探测面),契约版本由 $id 命名空间承载;N-1 窗口约定同 D-API-4 形态(破坏性变更递增版本常量,窗口期双版本路由受理)。

### D-API-84 异步裁决语义定案(Q3):pending → verdicted 单向状态机;重询限流 429 冻结形态;非成绩方向呈现与重试语义;裁决不可用 ≠ 判负(fail-closed 登记;阶段六 WP-60)

任务分解 §六 Q3 的定案。

- **状态机**:submit 受理(`submissions` 行登记)即 `pending`;verifier 裁决落库(`verdicts` 行写入)即 `verdicted`;**单向不可逆**——verdicted 无回退路径,"重新裁决"以新 submit → 新 submissionId → 新 pending 承载。**提交后未决期「已提交」态语义不变**:submit 响应面 `{submissionId, revision}` 零改动;交互会话生命周期(动作、投影、won / failed)与裁决链路相互独立(清单 D6),pending 期交互行为零影响;
- **pending 确定性形态**:未决期内任意次重询返回**恒定三字段形态**(无队列位置、无进度、无预计等待——I-7 无进度泄露在裁决域的延伸;同 submission 未决期内载荷随 `submissionId` 确定而字节确定,I-4 同族);UI 呈现「已提交」态,不得把 pending 误读为通过 / 失败(任务分解 §六风险表"裁决呈现与「已提交」态漂移"的定案锚,呈现面归 WP-63);
- **重询限流(429 冻结形态)**:裁决查询频率上限为**新增配置键** `SESSION_API_VERDICT_QUERIES_PER_MINUTE`(默认 30 / 分钟,天花板 100000,固定窗口 60 s;计量域 `rate:{tenant}:{user}:verdict` 维度子键,沿 D-API-50 提交频率闸同款载体与键域纪律),触顶 = **429 + 冻结 `PublicError`** `{code:"budget_exhausted", message:"rate limit exceeded"}`——与 D-API-50 频率类冻结形态**字节级一致**,同类别恒同三元组、零限流器状态透出;计数器故障 fail-closed(`store_unavailable` → 503,不降级不静默放行,D-API-24 分级)。契约级红灯锚已落:protocol 单测锁定该形态在冻结 `PublicErrorSchema` 下的合法性与零解释面(`budget_exhausted` 能力矩阵 addressHex / explanation 双 forbidden)。数值复核归 WP-65(Q6,k6 证据驱动;本 WP 定形态与默认值);
- **非成绩方向呈现与重试语义**:`engine_error` / `challenge_invalid` / `replay_mismatch` / `cancelled` 等非成绩方向是**已产生的裁决**(`verdicted` + 11 值冻结字面),不是"未决":呈现为非成绩结果(UI 文案明示"本次提交未产生成绩",走 i18n 双目录纪律);**不自动重试**(verifier 对已落库裁决零重试);客户端侧提供**重新提交入口**(显式新 submit → 新 submissionId → 新 pending;旧 submission 与旧裁决不动);非成绩方向成绩语义为零,不与交互 won / failed 混同(D6:交互独立于正式裁决,双向);
- **裁决不可用 ≠ 判负(fail-closed 方向登记)**:队列积压、verifier 实例故障、裁决域存储不可用时,呈现面保持确定性 `pending` 或 503 `store_unavailable` 同形(D-API-32 存储不可用行),**绝不**以 `timeout` / `wrong_answer` 类兜底判负——「无裁决」与「判负」在契约面结构性不可混淆(`status = "pending"` 无 `verdict` 字段,红灯 fixture 锁定);verifier run 失败不产生 verdicts 行,查询面恒为 pending(D-API-85);
- **侧信道登记**:异步队列使裁决时延与载荷解耦(阶段六 WP-67 侧信道审查的登记面);`decidedAt` 单值时刻不构成侧信道通道(清单 §6.10 论证:pending 态整体缺席,不存在"已等待多久"的公开读数);重询响应形态与秘密内容零相关——载荷只有 11 值字面,无部分匹配信息(D1 约束 1 兑现)。

### D-API-85 裁决队列触发形态定案:PG 轮询(FOR UPDATE SKIP LOCKED);`verifier_runs` 状态机与 `log_digest` 绑定面(阶段六 WP-60;边界裁决 4 约束)

- **触发形态定案 = PG 轮询**:verifier 以 `SELECT ... FOR UPDATE SKIP LOCKED` 批量认领待裁决行(轮询间隔与批量大小为实现期参数,归 WP-61;行锁认领即互斥,多 verifier 实例天然安全)。取舍理由(受阶段六边界裁决 4 路线纪律约束):**Redis Streams 不引入**(5.1 路线纪律禁止);**LISTEN/NOTIFY 不引入**——通知是触发优化而非正确性依赖,且把队列语义绑定到 PG 连接模型,MVP 单 verifier 实例规模下轮询足够;多实例 verifier 规模化触发时按 **T2 演进登记**复核(只登记,本阶段不实现)。队列以 PG 承载 = 004 迁移裁决域两表(`verdicts` / `verifier_runs`)预留结构启用写入(阶段三"零写入"承诺兑现,D-API-20);
- **入队语义**:submit 受理时 session-api 在写入 `submissions`(内部裁决引用完整形态,D-W8-9)的同时插入 `verifier_runs` 行(`status = 'pending'`,`log_digest` = `submissions.reference` 内规范化动作日志的 SHA-256 十六进制摘要)——入队与提交引用同锚;`pending` 行即队列本体,零新增队列设施;
- **`verifier_runs` 状态机**:`pending → running → completed / failed`(单向):verifier 认领 → `running` + `started_at`;重放 + 隐藏测试裁决完成 → `completed` + `finished_at`,同事务写 `verdicts` 行。**裁决幂等**:`verdicts.submission_id` 唯一,同 submission 重复裁决确定性同判、不重复写入(裁决可复现是阶段六退出条件 2 的实现前提);run 自身故障(进程崩溃 / 装载失败 / 六记录项缺项等**无法产生任何裁决**的形态)→ `failed` + `finished_at`(失败细节只进受控日志与审计,不进公开面)。**failed ≠ 非成绩裁决**:`replay_mismatch` / `engine_error` / `challenge_invalid` 是有效裁决(`completed` + verdicts 行,11 值内字面);`failed` 表示"本次 run 未产生裁决",不改写 `submissions` / `verdicts`,verifier 对其 submission 的重试以新 run 行承载(最大重试次数归 WP-61 实现期定案),重试耗尽仍 failed 的 submission 查询面恒为 pending(D-API-84 fail-closed 方向);
- **`log_digest` 绑定面(004 预留表消费语义定案)**:`log_digest`(CHAR(64),SHA-256 hex)是**可重放性的绑定锚**(004 迁移列注释兑现):verifier 取回 `submissions.reference` 后先复算其动作日志摘要与 `verifier_runs.log_digest` 比对——不一致 = 拒裁方向(run 置 failed,不落 verdicts,审计登记;篡改检测锚,与 WP-61 `replay_mismatch` 语义互补:digest 不符在重放之前即拒);verdicts 行经 `submission_id` 关联 run 行即可复核"该裁决判的是哪份日志",可机检回答。digest 只绑定日志内容,零 seed / 零私有包内容(004 迁移注释纪律;verifier 对 seed 零驻留,边界裁决 3)。

### D-API-86 契约增量与机检接入登记:VerdictQueryResponse(WP-1 §1.3 全流程)、contract-smoke 接入形态与 serde 镜像不设的理由、配置键登记(阶段六 WP-60)

- **契约增量(既有契约零改动)**:`VerdictQueryResponseSchema`(strictObject 五字段上限面 + superRefine 状态机耦合)冻结于 `@stackmaster/protocol` 新模块 `src/verdict/verdict-query-response.ts`,**公开入口导出**(浏览器可达——它是呈现通道的消费契约,与 `SessionCommandResponse` 同类);JSON Schema 落盘 `schema/verdict-query-response.schema.json`(`$id = …/schemas/verdict/v1/verdict-query-response.schema.json`,`x-sm-class: public`);分类清单 `schema/classification.json` 增登记条目(既有条目零改动);版本常量 `VERDICT_CHANNEL_PROTOCOL_VERSION` / `SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS` / `VERDICT_SCHEMA_BASE_ID` 入 `src/version.ts`;状态机耦合以等价 if/then 注入生成管线(`VERDICT_QUERY_STATUS_COUPLINGS`,先例 `ACTION_RESPONSE_REJECTED_COUPLING` / `DEBUG_VARIANT_ASLR_COUPLINGS`),superRefine 与落盘产物双侧锁定、schema-drift 测试断言注入形态;
- **WP-1 §1.3 流程回执**:清单 §6.10 逐字段硬门槛论证(v1.14)先行 → Zod Schema → JSON Schema 落盘 → classification 登记 → golden fixture(合法 6:pending / verdicted×{success, wrong_answer, engine_error, replay_mismatch, cancelled}——覆盖成绩方向与非成绩方向;反例 12:状态机耦合四向(pending 携带 verdict / pending 携带 decidedAt / verdicted 缺 verdict / verdicted 缺 decidedAt)、11 值外字面、部分匹配对象形态、SERVER_ONLY detail 注入、队列位置与预计等待进度字段、负 revision、标识符字符集违规、状态枚举外值、非整数时刻)→ contract-smoke 接入;
- **contract-smoke 接入形态**:§1 Schema 编译自动覆盖(全目录遍历,编译计数 19 → 20);§2 实例校验映射 `PROTOCOL_CONTRACTS` 扩入 `verdict-query-response`——Rust 侧有效接受 / 非法拒绝与 TS 同判,**if/then 耦合的跨语言机检由此承接**(有效样例 55 → 61,非法样例 115 → 127);§3 规范化摘要清单自动覆盖全部新 fixture(`fixtures:manifest` 重生成,比对 214 → 232 条)。**serde + schemars 镜像不设**(§4):理由沿 D-API-7——本契约消费面止于 TS 侧(浏览器 vm-ui / 插件消费呈现,session-api 产出),verifier 不消费该响应契约(verifier 面向 PG 裁决域与内部引用,不经呈现通道);未来 Rust 侧若需消费,按 WP-1 §1.3 流程扩 §4 镜像;
- **红灯语料边界(实现期红灯归属)**:本 WP 交付**契约级红灯**(fixture 反例矩阵 + protocol 单测:pending 确定性形态与进度类字段拒绝 / 状态机耦合 / 非成绩方向与成绩方向同构呈现 / 429 冻结形态在 `PublicErrorSchema` 下的合法性与零解释面 / 限流器状态零透出);**路由实现期红灯**(404 同形矩阵、401 统一形态、429 逐字节断言、Cookie Path 覆盖、跨租户与不存在同形、响应面机检扫描)归 WP-63 集成测试——不得先于本契约实现(WP-60 完成标准"契约先冻结后实现");
- **配置键登记(过 D-API-9 三道闸)**:

| 键 | 必备 | 默认 | 约束 |
|---|---|---|---|
| `SESSION_API_VERDICT_QUERIES_PER_MINUTE` | 否 | 30 | 上限 100000(裁决查询频率,窗口恒 60 s;`rate:{tenant}:{user}:verdict` 维度子键,D-API-84;数值复核归 WP-65 Q6) |

## 四、登记中的决策(后续 WP 回填;阶段三已全量回填)

以下决策点已在阶段三任务分解 §六登记,由对应 WP 交付时在此回填;WP-0 只冻结其契约前提:

| 决策点 | 承接 WP | 契约前提(WP-0 已冻结) |
|---|---|---|
| token 消费失败响应面细节、CORS / Cookie 卫生 | ~~WP-2~~ **已回填(2026-09-10):D-API-11~17 / D-API-19** | D-API-3 统一失败形态;`SessionCredentialClaims` 七字段 |
| 快照加密层级、Redis 分级降级、幂等缓存后端 | ~~WP-3~~ **已回填(2026-09-10):D-API-20~26** | D-API-4 幂等 TTL 配置键;快照 SERVER_ONLY blob 只存取不解析(D-W8-11) |
| HTTP 状态 ↔ 结果类型映射、请求护栏数值 | ~~WP-4~~ **已回填(2026-09-10):D-API-30~39** | D-API-1 路由表;错误响应 = 冻结 `PublicError` |
| 断线保持窗口、多连接策略、背压、WSS 频率限制 | ~~WP-5~~ **已回填(2026-09-10):D-API-40~49** | D-API-2 连接级版本锚定;D-API-6 心跳;帧载荷纯复用 |
| 限流默认值、checkpoint 配额数值 | ~~WP-6~~ **已回填(2026-09-10):D-API-50~59** | 协议外圈护栏 `MAX_CHECKPOINTS_PER_SESSION`(配额必须 ≤ 协议上限;默认 = 天花板 = 256,D-API-54) |
| 跨域载荷机检、Compose 全拓扑、重启恢复接线、13.3 API 侧条目 | ~~WP-7~~ **已回填(2026-09-10):D-API-60~66** | 通道出站帧先过冻结 `WssFrameSchema` 自检(WP-5 录制面前提);快照 SERVER_ONLY blob 只存取不解析(D-W8-11);幂等窗口 = 效率设施(协议 §4.3) |
| 指标标签纪律、k6 场景 | ~~WP-8~~ **已回填(2026-09-10):D-API-70~73**(指标面最小集与 /metrics 形态、标签纪律机检、队列深度 / Worker 占用 T0 语义与 OTel 可选增量登记、k6 三场景与归档) | 指标标签零秘密(ZR-B1 / B6 语料对 /metrics 输出零命中是测试锚点);k6 场景消费冻结契约(签发 / create_session / WSS 帧 / 五命令),零新增契约面 |
