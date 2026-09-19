/**
 * SessionCommandRequest —— 浏览器 → 编排器的会话级命令请求(阶段三 WP-0 冻结;
 * v2 由分发改版 WP-90 / D-LT-5 增补;**N-1 窗口于 2026-09-19 随 WP-96 关闭**)。
 *
 * 协议语义文档 §5.1 冻结的生命周期命令集在本 Schema 收口请求面(语义文档 §九;
 * 字段分类与硬门槛论证:docs/contracts/数据分类与秘密零驻留清单.md §6.5)。
 * 命令经 REST 路由承载(HTTP 路由表为实现面文档登记,不作 JSON Schema 契约,
 * D-API-1);本 Schema 是传输无关的请求体契约。
 *
 * **身份零承载(硬门槛)**:请求体不存在任何身份字段 —— `create_session` 只携带
 * **导航信息**(题目身份对),租户 / 用户身份只从「授权凭证的签名 claims ×
 * 签发存储记录」派生(6.2 第 1 条"不接受请求体自报身份"的契约层结构表达;
 * 红灯 fixture 登记自报形态,strictObject 即拒)。
 *
 * **v2 破坏性变更(D-LT-5 第 2 条,2026-09-18)**:`create_session` 载荷由四键
 * 收为**恰两键** `{challengeId, challengeVersion}`:
 *  - `embedToken` **退场** —— 授权来源改为**换票产出的「启动授权凭证」Cookie**
 *    (服务端从凭证签名 claims × 签发存储记录派生身份与题目绑定);
 *  - `embedSessionId` **退场** —— 本形态**没有嵌入会话**,留着会让绑定面出现
 *    一个无法解释的字段(D-LT-5 第 3 条);
 *  - 服务端身份派生路径不变:payload 只提供**导航信息**,且必须与凭证绑定
 *    **逐字一致**(不一致 = 冻结错误码,不得降级为「以 payload 为准」)。
 *
 * **N-1 兼容窗口的历史与关闭(D-LT-5 第 2 条)**:v2 生效时窗口期内 v1 请求曾照旧
 * 受理,契约包同批产出两版判别联合(`SessionCommandRequestSchema`(v2,当前)与
 * `SessionCommandRequestV1Schema`(v1 冻结面,`create_session` 载荷仍是那四键)),
 * 由服务端「版本 → Schema」注册表按版本独立校验。**2026-09-19 窗口关闭(随 WP-96)**:
 * `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION`、`CreateSessionRequestPayloadV1Schema`
 * 与 `SessionCommandRequestV1Schema` **同一批物理删除**,`SUPPORTED_*` 受理集合回落
 * 单元素;`v1` 请求现在被**拒**("不在受理集合的版本 = 确定性拒绝"),
 * 由 `test/session-action-version-window.test.ts` 的回归机检钉住。
 * **本版仍只接受本版本字面量** —— 受理是服务端「版本 → Schema」注册表的职责,
 * 而不是把两个形状合成一个宽松 Schema(后者会让 v2 请求携带 `embedToken` 也被
 * 接受 —— 那正是本次要关掉的门)。
 *
 * `command` 为封闭枚举:未知命令契约层拒绝,扩展走协议版本演进,不靠枚举外
 * 预留(与 12 动作 `type` 同纪律;连字符记法 ↔ snake_case 枚举的同义映射记
 * D-API-8)。
 */
import { z } from "zod";
import { CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE } from "../common/challenge-content-version.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import { SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";

/** 全部会话级命令(语义文档 §5.1 冻结,WP-0 冻结 wire 记法)。 */
export const SESSION_COMMANDS = [
  "create_session",
  "sync_projection",
  "list_checkpoints",
  "submit",
  "close_session",
] as const;

export type SessionCommand = (typeof SESSION_COMMANDS)[number];

/**
 * 会话命令请求统一信封字段(每个分支同形,drift 机检按分支键集断言)。
 * 按版本字面量参数化:Schema 只接受**本版本**(受理集合现为单元素;合成宽松
 * 字面量会让版本判定形同虚设)。
 */
function sessionCommandRequestEnvelope(version: number) {
  return { protocolVersion: z.literal(version) } as const;
}

/** 题目身份对(公开导航信息)。 */
const ChallengeIdentityFields = {
  challengeId: OpaqueIdSchema,
  challengeVersion: z
    .string()
    .regex(
      new RegExp(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE),
      "题目内容版本必须为 X.Y.Z 形式的语义化版本",
    ),
} as const;

/**
 * `create_session` 载荷(**恰两键**):公开导航信息。
 *
 * **无 `embedToken` / `embedSessionId`** —— 前者由「启动授权凭证」Cookie 取代
 * (授权来源 = 服务端签发的凭证,不是客户端提交的 token),后者所绑定的嵌入会话
 * 在本形态不存在。**授权不在这份载荷里,也不由它证明**:载荷只说明「打开哪一题」,
 * 「以谁的身份、被授予了哪一题」全部来自凭证 claims × 签发存储记录,且必须与
 * 本载荷逐字一致(D-LT-5 第 2 条)。
 */
export const CreateSessionRequestPayloadSchema = z.strictObject({
  ...ChallengeIdentityFields,
});

export type CreateSessionRequestPayload = z.infer<typeof CreateSessionRequestPayloadSchema>;

/** 除 create_session 外,命令以服务端签发的 sessionId 定位会话。 */
const SessionIdPayloadSchema = z.strictObject({ sessionId: OpaqueIdSchema });

/**
 * 按版本产出会话命令请求判别联合:统一信封 + 按 `command` 判别的 strictObject
 * 载荷,type ↔ payload 耦合由结构表达,TS 与 Rust 校验结论一致(与 WssFrame
 * 同形)。
 *
 * **类型参数缺口修法(D-LT-5 四·补.3 第 3 条;2026-09-19 随 WP-96 一并修)**:
 * 本函数此前把 `createSessionPayload` 标注为 `z.ZodType`(无类型参数 ⇒
 * `ZodType<unknown>`),导致判别联合解析出的 `payload` 在 TS 层退化为 `unknown`
 * —— 消费点(见 `apps/session-api/src/routes/session-routes.ts` 的 create_session
 * 分支)因此被迫对同一份 body 再做一次 `safeParse` 只为拿回类型。
 *
 * 修法是**保留推断的泛型** `<T extends z.ZodTypeAny>`(而不是把参数放宽成
 * `z.ZodType`):`T` 的 output 原样流入 `z.strictObject({ payload: T })`,故
 * `SessionCommandRequest["payload"]` 在 `command === "create_session"` 分支是
 * **具体对象类型**而非 `unknown`。返回类型由 TS 从函数体精确推断(显式标注整条
 * 判别联合反而会退回宽形态),其精确性由
 * `test/session-command.test.ts` 的**类型层断言**钉住:若推断退化,断言编译失败,
 * `pnpm --filter @stackmaster/protocol typecheck` 转红。
 *
 * ⚠ **类型不再是 `unknown` 不等于放松运行时校验**:入站闸仍是契约 Schema 本身
 * (REST 侧 `parseSessionCommandRequest` / WSS 侧 `parseWssChannelFrame` 的
 * `schema.safeParse`),类型只影响编译期可读性。
 */
function sessionCommandRequestSchemaForVersion<T extends z.ZodTypeAny>(
  version: number,
  createSessionPayload: T,
) {
  const envelope = sessionCommandRequestEnvelope(version);
  return z.discriminatedUnion("command", [
    z.strictObject({
      ...envelope,
      command: z.literal("create_session"),
      payload: createSessionPayload,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("sync_projection"),
      payload: SessionIdPayloadSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("list_checkpoints"),
      payload: SessionIdPayloadSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("submit"),
      payload: SessionIdPayloadSchema,
    }),
    z.strictObject({
      ...envelope,
      command: z.literal("close_session"),
      payload: SessionIdPayloadSchema,
    }),
  ]);
}

/** 当前版本(v2)的会话命令请求(受理集合的唯一成员)。 */
export const SessionCommandRequestSchema = sessionCommandRequestSchemaForVersion(
  SESSION_ACTION_PROTOCOL_VERSION,
  CreateSessionRequestPayloadSchema,
);

export type SessionCommandRequest = z.infer<typeof SessionCommandRequestSchema>;

/**
 * `command === "create_session"` 分支的载荷类型(消费点的可读形状)。
 * 由判别联合精确提取 —— 若 `payload` 退化为 `unknown`,本别名随之退化,
 * 类型层断言即转红。
 */
export type CreateSessionCommandPayload = Extract<
  SessionCommandRequest,
  { readonly command: "create_session" }
>["payload"];
