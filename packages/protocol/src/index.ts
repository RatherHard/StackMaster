/**
 * @stackmaster/protocol —— 跨语言契约唯一来源(计划书 5.6、ADR-5)。
 *
 * 本包承载 Zod 契约 → JSON Schema 2020-12 产出管线:会话动作协议、启动票据
 * 契约族、宿主成绩同步、裁决呈现通道、调试通道、引擎进程协议与公开数据类型。
 * JSON Schema 是 TypeScript 与 Rust 的共同权威(Rust 以 serde + schemars 消费),
 * 生成产物提交在 schema/ 目录。
 *
 * 已冻结契约:
 * - WP-2 会话动作协议 v1:ActionRequest(12 种动作)、ActionResponse、11 种结果类型;
 *   语义见 docs/会话动作协议语义.md;
 * - WP-3 投影与错误契约:PublicStateProjection 及其子类型、ProjectionDelta /
 *   DirtyRange、PublicError(16 值错误码 + 逐 code 能力矩阵);
 *   语义见 docs/投影与错误契约语义.md;
 * - ~~WP-5 嵌入协议 v1~~:**已退役(2026-09-19 随 WP-96 物理删除)** ——
 *   `EmbedMessage`(postMessage 消息信封)、`EmbedTokenClaims`(embed token 绑定
 *   字段)、`EMBED_PROTOCOL_VERSION` / `EMBED_SCHEMA_BASE_ID` 与 `…/schemas/embed/v1`
 *   落盘产物同批移除(整体退役、不做版本演进,代替物 = 启动票据契约族 +
 *   启动授权凭证,见下);该面唯一被复用的**格式常量**
 *   `CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE` 已迁至 `src/common/`
 *   (正则源码逐字不变,双入口可达性照旧);
 * - 阶段三 WP-0:会话级命令 SessionCommandRequest / SessionCommandResponse
 *   (5 命令判别联合,语义文档 §5.1 生命周期命令集的 Schema 收口,§九)、
 *   WSS 传输帧 WssFrame(8.2 帧字段基线,载荷纯复用冻结契约);会话凭证
 *   绑定字段 SessionCredentialClaims 的**解析器**同样仅经 server-only 子路径
 *   导出(浏览器对凭证不解析,WP-1 清单 §6.6);
 * - 阶段四 WP-40:调试通道协议 v1——DebugFrame(独立 WSS 端点独立帧族,
 *   12 值封闭帧类型,连接级版本锚定自建同款;ADR-DC1 条款 1,分类论证
 *   WP-1 清单 §6.8);语义见 docs/调试通道协议语义.md。调试变体镜像
 *   DebugVariantBundle(编排器 ↔ 调试 worker 进程间契约)为 server-only
 *   契约,仅经 server-only 子路径导出(WP-1 清单 §6.9)。既有 WSS 通道
 *   与 D-API-2 零改动。
 * - 阶段六 WP-60:裁决呈现通道 v1——VerdictQueryResponse(`GET /verdicts/:submissionId`
 *   响应体,pending / verdicted 两态 × 冻结 11 值结果类型;独立版本命名空间
 *   `…/schemas/verdict/v1`,VERDICT_CHANNEL_PROTOCOL_VERSION;分类论证
 *   WP-1 清单 §6.10,决策登记 D-API-83 / D-API-86)。既有 submit 响应面
 *   `{submissionId, revision}` 零改动。
 * - 中期 M3 WP-78:宿主成绩同步只读接口 v1——HostScoresResponse
 *   (`GET /host/scores` 响应体,宿主后端凭证面批量拉取本租户成绩;
 *   载荷 = 七字段公开上限面 + keyset 游标,独立版本命名空间
 *   `…/schemas/host-scores/v1`,HOST_SCORES_PROTOCOL_VERSION;分类论证
 *   WP-1 清单 §6.11,决策登记 D-API-122 ~ D-API-126)。既有契约面零改动。
 * - 分发改版 WP-90:启动票据契约族 v1——LaunchTicketRequest
 *   (`POST /auth/launch-tickets` 请求体,恰两键挑战定位)与
 *   LaunchTicketResponse(签发响应体,恰两键 `launchUrl` / `expiresAt`,
 *   票据值只在地址内),两份载荷**均不携带版本字段**;独立版本命名空间
 *   `…/schemas/launch-ticket/v1`,LAUNCH_TICKET_PROTOCOL_VERSION;
 *   族内形态常量(签发路由 / 换票路径模板 / 查询参数名 / 令牌长度)同批导出,
 *   供 WP-91 / WP-92 单源引用;分类论证 WP-1 清单 §6.12,决策登记
 *   D-LT-1 ~ D-LT-3;语义与生命周期成文于 docs/contracts/启动票据协议.md。
 *   两份载荷**登记公开注册表**(跨边界形态,浏览器可达侧需可校验响应)。
 * - 分发改版 WP-90 / **D-LT-5**:会话动作协议 **v2** —— `create_session` 请求
 *   载荷收为**恰两键** `{challengeId, challengeVersion}`,`embedToken` /
 *   `embedSessionId` **退场**(授权来源 = 换票产出的「启动授权凭证」Cookie)。
 *   破坏性变更 ⇒ `SESSION_ACTION_PROTOCOL_VERSION = 2`。v2 生效时的 N-1 窗口
 *   受理集合 `[2, 1]` 与**两版各以其独立 Schema 校验**的形态是过渡态;
 *   **2026-09-19 窗口关闭(随 WP-96)**:受理集合回落为
 *   `[SESSION_ACTION_PROTOCOL_VERSION]`,v1 冻结面
 *   (`CreateSessionRequestPayloadV1Schema` / `SessionCommandRequestV1Schema` /
 *   `ActionRequestV1Schema` / `WssFrameV1Schema`)随
 *   `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION` **同批物理删除**,v1 请求现被拒。
 *   `…/schemas/session-action/v2/` 是会话动作协议族唯一命名空间;语义见
 *   packages/protocol/docs/会话动作协议语义.md §5.1 / §5.2 / §九。
 *   同批新增**启动授权凭证 claims**(`LaunchGrantClaims`,server-only 导出,
 *   恰六字段、**无 sessionId / embedSessionId**,D-LT-5 实施细化 5a;WP-1 清单
 *   §6.12.1)。
 *
 * 另:题目内容版本格式常量 `CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE` 从本
 * 入口导出(值 = `X.Y.Z` 冻结字面)——启动票据签发请求与宿主成绩同步的
 * `challengeVersion` 字段共用它;它是**格式常量**而非解析器,故不受下面
 * 「凭证解析器不给浏览器」的导出面纪律约束。该常量原居
 * `src/embed/embed-token-claims.ts`,2026-09-19 随 WP-96 迁至
 * `src/common/challenge-content-version.ts`(正则源码逐字不变;同模块的
 * `EmbedTokenClaimsSchema` 与嵌入协议面同批物理删除)。
 *
 * server-only 边界(WP-1 §五):ProjectionPolicy(载荷禁下发的 server-only 类型)
 * 与 SessionCredentialClaims / LaunchGrantClaims(凭证解析器)不从本入口导出,
 * 仅经子路径 @stackmaster/protocol/server-only 供后端包消费——浏览器可达包导入
 * 该子路径即违规(dependency-cruiser 强制);"Schema 存在不等于可下发"。
 *
 * 依赖纪律(5.5):本包是所有 TS 包唯一可依赖的跨域共享面,自身不得依赖任何
 * 工作区包或 vm-engine 产物(tooling/dependency-cruiser.cjs 强制)。
 * 注意:JSON Schema 生成器(src/schema/generate.ts)依赖 node:fs,
 * 刻意不从本入口导出——浏览器可达包只允许导入本入口。
 */
export * from "./version.js";
export * from "./common/limits.js";
export * from "./common/canonical-json.js";
export * from "./common/hex.js";
export * from "./common/identifiers.js";
export * from "./common/classification.js";
export * from "./common/public-text.js";
export * from "./common/register-name.js";
export * from "./session-action/action-args.js";
export * from "./session-action/action-object.js";
export * from "./session-action/action-request.js";
export * from "./session-action/action-response.js";
export * from "./session-action/verdict-result.js";
export * from "./projection/public-status.js";
export * from "./projection/visible-memory-region.js";
export * from "./projection/public-register.js";
export * from "./projection/public-call-frame.js";
export * from "./projection/public-control-flow.js";
export * from "./projection/semantic-highlight.js";
export * from "./projection/public-event.js";
export * from "./projection/public-state-projection.js";
export * from "./projection/projection-delta.js";
export * from "./error/public-error-code.js";
export * from "./error/public-error.js";
export * from "./session-command/session-command-request.js";
export * from "./session-command/session-command-response.js";
export * from "./transport/wss-frame.js";
export * from "./transport/debug-frame.js";
export * from "./verdict/verdict-query-response.js";
export * from "./host-scores/host-scores-response.js";
export * from "./launch-ticket/launch-ticket-contract.js";
export * from "./launch-ticket/launch-ticket-request.js";
export * from "./launch-ticket/launch-ticket-response.js";
/**
 * 题目内容版本格式常量的**具名**再导出(刻意不用 `export * `:同模块的其它
 * 导出面纪律由中立位置承担 —— 2026-09-19 随 WP-96 迁至
 * `src/common/challenge-content-version.ts`,同模块不再有「只给后端的凭证
 * 解析器」;保留具名再导出使可达面与迁移前逐字一致)。
 */
export { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "./common/challenge-content-version.js";
export * from "./schema/registry.js";
