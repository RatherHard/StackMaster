/**
 * 协议版本常量(计划书 5.6:每类契约携带独立版本号)。
 *
 * SESSION_ACTION_PROTOCOL_VERSION 是会话动作协议(ActionRequest / ActionResponse、
 * 12 种动作 args、结果类型)的版本;破坏性变更递增版本并保留 N-1 兼容窗口(5.6)。
 * 该协议的 **N-1 窗口已于 2026-09-19 随 WP-96 关闭**(受理集合回落单元素,v1 冻结面
 * 物理删除)—— 保留此句作为决策留档,窗口期形态见下方
 * SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS 的历史说明。
 * 嵌入协议(postMessage 信封与 handshake,WP-5)的版本常量 `EMBED_PROTOCOL_VERSION`
 * 与 `$id` 命名空间 `EMBED_SCHEMA_BASE_ID` **已于 2026-09-19 随 WP-96 物理删除**
 * (该面随插件形态整体退役、不做版本演进;D-API-153 第 5 项 / D-LT-1)。
 * 题目包 Schema(WP-4)与引擎进程协议各自独立版本。
 */

/**
 * 会话动作协议当前版本(ActionRequest.protocolVersion 的唯一合法值)。
 *
 * **v2(2026-09-18,分发改版 WP-90 / D-LT-5)**:破坏性变更 —— `create_session`
 * 请求载荷由四键收为**恰两键** `{challengeId, challengeVersion}`:
 * `embedToken` 与 `embedSessionId` **退场**(新链的授权来源 = 换票产出的
 * 「启动授权凭证」Cookie,由服务端从凭证签名 claims × 签发存储派生身份与题目
 * 绑定;本形态**没有嵌入会话**,故 `embedSessionId` 无绑定对象)。
 * **零身份字段的硬门槛不变**:载荷仍无 `tenantId` / `userId` 位,任何自报身份
 * 字段照旧被 `strictObject` 拒绝。
 */
export const SESSION_ACTION_PROTOCOL_VERSION = 2;

/**
 * 当前受理的会话动作协议版本集合(5.6 / 语义文档 §5.2)。
 *
 * **本项目的历史事实(决策留档,2026-09-19 更新)**:协议递增为 v2 时
 * (D-LT-5 第 2 条)曾开启 N-1 兼容窗口,窗口期形态 = `[2, 1]` —— 服务端按路由
 * 对各版本以其**独立 Schema** 双版本受理(REST 命令体用
 * `SessionCommandRequestSchema`(v2)与 `SessionCommandRequestV1Schema`,WSS 帧用
 * `WssFrameSchema`(v2)与 `WssFrameV1Schema`,动作载荷用 `ActionRequestSchema`(v2)
 * 与 `ActionRequestV1Schema`);两个服务端注册表(session-contract.ts /
 * frame-contract.ts)在装配期断言「受理集合中每个版本都有已注册 Schema」,故本集合
 * 一旦含某版本,契约包就必须提供该版本的冻结 Schema(缺一即拒绝启动)。
 * **2026-09-19 窗口关闭(随 WP-96)**:受理集合回落为单元素,三处 v1 冻结面与
 * `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION` 同批**物理删除**;装配期断言保留在场
 * (现为对单元素集合的恒真断言,仍锁住「注册表与受理集合同步」这一不变量)。
 *
 * WSS 传输帧与 REST 命令体共用本集合(传输帧随会话动作协议同一版本编号演进,
 * D-API-2)。
 */
export const SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS: readonly number[] = [
  SESSION_ACTION_PROTOCOL_VERSION,
];

/**
 * 引擎进程协议当前版本(5.6 第 4 类契约;阶段二 WP-1 登记,版本策略 §二)。
 *
 * 覆盖编排器 / verifier ↔ vm-worker 的进程帧格式与命令信封(语义权威:
 * docs/develop/引擎进程协议.md);投影 / 错误 / 动作 Schema 面仍随
 * SESSION_ACTION_PROTOCOL_VERSION 演进,两者不共用编号空间。worker 启动经
 * ready 帧自报本版本,编排器比对不一致即拒绝建会话(fail-closed)。
 * Rust 侧镜像常量:vm-engine/vm-worker(`protocol::version`),双侧一致性由
 * contract-smoke 机检。
 */
export const ENGINE_PROCESS_PROTOCOL_VERSION = 1;

/**
 * 会话动作协议 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从协议版本常量派生:破坏性变更递增版本时,$id 目录随之切换。
 */
export const SESSION_ACTION_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/session-action/v${SESSION_ACTION_PROTOCOL_VERSION}`;

/* ------------------------------------------------------------------ */
/* 裁决呈现通道(阶段六 WP-60;权威 API 语义规约 D-API-83 / D-API-86)      */
/* ------------------------------------------------------------------ */

/**
 * 裁决呈现通道当前版本(阶段六边界裁决 2 候选新契约面 (a) 的版本常量)。
 *
 * 裁决呈现通道是 REST 查询面(`GET /verdicts/:submissionId`,D-API-83)的
 * 响应体契约族:独立于会话动作协议版本演进(与调试通道同款独立编号先例,
 * DEBUG_CHANNEL_PROTOCOL_VERSION)——新契约面按 5.6 携带独立版本号,
 * 破坏性变更递增本常量并保留 N-1 兼容窗口,既有契约面零触碰。
 */
export const VERDICT_CHANNEL_PROTOCOL_VERSION = 1;

/**
 * 当前受理的裁决呈现通道版本集合(N-1 兼容窗口的实现约定锚点)。
 *
 * 约定与 SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS 同款:冻结期恒为
 * `[VERDICT_CHANNEL_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期在此
 * 追加 N-1,窗口期结束移除旧值。
 */
export const SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS: readonly number[] = [
  VERDICT_CHANNEL_PROTOCOL_VERSION,
];

/**
 * 裁决呈现通道 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从裁决呈现通道版本常量派生;响应载荷本身不携带版本字段
 * (沿 SessionCommandResponse 先例:N-1 受理是路由级事实,回显版本判定
 * 细节即扩大探测面;契约版本由本命名空间承载,清单 §6.10)。
 */
export const VERDICT_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/verdict/v${VERDICT_CHANNEL_PROTOCOL_VERSION}`;

/*
 * 嵌入协议 JSON Schema 的 `$id` 命名空间常量 `EMBED_SCHEMA_BASE_ID`
 * (`https://stackmaster.dev/schemas/embed/v1`)**已于 2026-09-19 随 WP-96 物理删除**
 * ——嵌入协议面不适用 N-1 演进窗口,与退役面同批硬切(D-API-153 第 5 项 / D-LT-1)。
 * 该命名空间下的落盘产物(`schema/embed-message.schema.json` /
 * `schema/embed-token-claims.schema.json`)同批移除。
 */

/* ------------------------------------------------------------------ */
/* 调试通道协议(阶段四 WP-40;ADR-DC1 条款 1 / 决议 3 / §六 R3)          */
/* ------------------------------------------------------------------ */

/**
 * 调试通道协议当前版本(DebugFrame.protocolVersion 的唯一合法值)。
 *
 * 调试通道是独立 WSS 端点上的独立协议(ADR-DC1 决议 3 / R3):独立协议版本、
 * 独立帧族,**不随会话动作协议演进**——既有通道的连接级版本锚定(D-API-2,
 * "传输帧随会话动作协议同一版本编号演进、不另设版本常量")只针对既有通道,
 * 其冻结面零改动;调试协议快速迭代不应反复搅动已冻结面,故独立编号。
 * 连接级锚定机制在调试通道内自建同款:首帧版本即本连接的解释版本,此后任何
 * 帧携带其他版本一律拒绝(语义见 docs/调试通道协议语义.md)。
 */
export const DEBUG_CHANNEL_PROTOCOL_VERSION = 1;

/**
 * 当前受理的调试通道协议版本集合(N-1 兼容窗口的实现约定锚点)。
 *
 * 约定与 SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS 同款:冻结期恒为
 * `[DEBUG_CHANNEL_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期在此追加
 * N-1(如 `[2, 1]`),窗口期结束移除旧值。
 */
export const SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS: readonly number[] = [
  DEBUG_CHANNEL_PROTOCOL_VERSION,
];

/**
 * 调试通道协议 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从调试通道协议版本常量派生;调试通道帧与调试变体镜像
 * (server-only 注册,编排器 ↔ 调试 worker 进程间契约)同属本命名空间。
 */
export const DEBUG_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/debug/v${DEBUG_CHANNEL_PROTOCOL_VERSION}`;

/* ------------------------------------------------------------------ */
/* 宿主成绩同步只读接口(中期 M3 WP-78;D-API-122 ~ D-API-126)           */
/* ------------------------------------------------------------------ */

/**
 * 宿主成绩同步只读接口当前版本(中期 M3 WP-78 契约族的版本常量)。
 *
 * 宿主成绩同步是**宿主后端**(平台服务端,持 `SESSION_API_HOST_BACKEND_TOKEN`)
 * 拉取本租户成绩的 REST 只读查询面(`GET /host/scores`,D-API-122):独立于
 * 会话动作协议、嵌入协议、裁决呈现通道与调试通道演进(与
 * VERDICT_CHANNEL_PROTOCOL_VERSION / DEBUG_CHANNEL_PROTOCOL_VERSION 同款
 * 独立编号先例)——新契约面按 5.6 携带独立版本号,破坏性变更递增本常量并
 * 保留 N-1 兼容窗口,既有契约面零触碰。
 */
export const HOST_SCORES_PROTOCOL_VERSION = 1;

/**
 * 当前受理的宿主成绩同步版本集合(N-1 兼容窗口的实现约定锚点)。
 *
 * 约定与 SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS 同款:冻结期恒为
 * `[HOST_SCORES_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期在此追加
 * N-1,窗口期结束移除旧值。
 */
export const SUPPORTED_HOST_SCORES_PROTOCOL_VERSIONS: readonly number[] = [
  HOST_SCORES_PROTOCOL_VERSION,
];

/**
 * 宿主成绩同步 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从宿主成绩同步版本常量派生;响应载荷本身不携带版本字段(沿
 * VerdictQueryResponse 先例:N-1 受理是路由级事实,回显版本判定细节即扩大
 * 探测面;契约版本由本命名空间承载)。
 */
export const HOST_SCORES_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/host-scores/v${HOST_SCORES_PROTOCOL_VERSION}`;

/* ------------------------------------------------------------------ */
/* 启动票据契约族(分发改版 WP-90;D-LT-1 ~ D-LT-3)                       */
/* ------------------------------------------------------------------ */

/**
 * 启动票据契约族当前版本(分发改版 WP-90 契约族的版本常量)。
 *
 * 启动票据是「平台后端换一次性启动地址 → 学习者打开地址 → 页面服务端用票据换
 * 会话凭证」这条链的契约面(`POST /auth/launch-tickets` 的请求体 / 响应体两份
 * 载荷,D-LT-1):独立于会话动作协议、嵌入协议、裁决呈现通道、调试通道与宿主
 * 成绩同步演进(与 VERDICT_CHANNEL_PROTOCOL_VERSION /
 * HOST_SCORES_PROTOCOL_VERSION 同款独立编号先例)——新契约面按 5.6 携带独立
 * 版本号,破坏性变更递增本常量并保留 N-1 兼容窗口,既有契约面零触碰。
 *
 * **与嵌入协议退役的关系(D-LT-1)**:嵌入协议面(`EMBED_PROTOCOL_VERSION`,
 * 已于 2026-09-19 随 WP-96 物理删除)随插件形态**整体退役、不做版本演进**;
 * 本族是它的**新契约面替代物**,因此照常适用 N-1 演进窗口(两者是两件事,
 * 不得混为一谈)。
 */
export const LAUNCH_TICKET_PROTOCOL_VERSION = 1;

/**
 * 当前受理的启动票据契约族版本集合(N-1 兼容窗口的实现约定锚点)。
 *
 * 约定与 SUPPORTED_HOST_SCORES_PROTOCOL_VERSIONS 同款:冻结期恒为
 * `[LAUNCH_TICKET_PROTOCOL_VERSION]`;破坏性变更递增版本后,窗口期在此追加
 * N-1,窗口期结束移除旧值。窗口时长为实现期运维参数,不属契约面。
 */
export const SUPPORTED_LAUNCH_TICKET_PROTOCOL_VERSIONS: readonly number[] = [
  LAUNCH_TICKET_PROTOCOL_VERSION,
];

/**
 * 启动票据契约族 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从本族版本常量派生;两份载荷**均不携带版本字段**(沿
 * HostScoresResponse / VerdictQueryResponse 先例:N-1 受理是路由级事实,
 * 回显版本判定细节即扩大探测面;契约版本由本命名空间承载,清单 §6.12)。
 */
export const LAUNCH_TICKET_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/launch-ticket/v${LAUNCH_TICKET_PROTOCOL_VERSION}`;

/** @stackmaster/protocol 包版本(与 package.json 同步;非协议版本)。 */
export const PROTOCOL_PACKAGE_VERSION = "0.1.0";
