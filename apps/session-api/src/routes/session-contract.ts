/**
 * 路由级契约校验(任务分解 WP-4 第 2 条;计划书 5.6"一切入站按冻结契约
 * 重新校验,不信任客户端类型标注";N-1 双版本受理,协议 §5.2 / D-API-4)。
 *
 *  - 受理集合锚点 = `SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS`(冻结期
 *    恒 [1];窗口期追加 N-1 后,各版本以其独立 Schema 校验——版本 → Schema
 *    注册表即路由点,当前版本映射冻结 `SessionCommandRequestSchema`);
 *  - 不在受理集合的版本 = 确定性拒绝(冻结 `PublicError`,单一静态文案);
 *  - 校验失败响应面零校验器细节(基线 #8):Zod 原始 issue 的字段路径与
 *    issue code 只进受控日志(调用方持 logger),message 一律不入日志
 *    (Zod message 可能回显输入片段);
 *  - 装配期自检:受理集合中的每个版本必须有已注册 Schema,缺失即模块
 *    加载失败(契约漂移/漏实现即拒绝启动,与 server.ts 自检同纪律)。
 */
import {
  SESSION_ACTION_PROTOCOL_VERSION,
  SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS,
  SessionCommandRequestSchema,
  SessionCommandResponseSchema,
  type PublicError,
  type SessionCommandRequest,
} from "@stackmaster/protocol";
import type { z } from "zod";

import { assertRequestWithinLimits, GuardViolation, type RequestGuardLimits } from "./request-guards.js";

/** 版本 → 请求 Schema 注册表(各版本独立校验的落点;扩展 N-1 时在此登记)。 */
const REQUEST_SCHEMAS_BY_VERSION = new Map<number, z.ZodType<SessionCommandRequest>>([
  [SESSION_ACTION_PROTOCOL_VERSION, SessionCommandRequestSchema],
]);

// 装配期自检:受理集合中的每个版本必须有已注册 Schema(缺实现即拒绝启动)。
for (const version of SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS) {
  if (!REQUEST_SCHEMAS_BY_VERSION.has(version)) {
    throw new Error(
      `会话命令受理集合中的协议版本 ${version} 缺少已注册请求 Schema(N-1 受理实现不完整)`,
    );
  }
}

/** 校验失败类别(响应面映射:结构越界 → 400 校验族;版本不受支持 → 400 版本族)。 */
export type CommandValidationFailureKind = "malformed_body" | "unsupported_version" | "guard_violation";

export interface CommandValidationFailure {
  readonly kind: CommandValidationFailureKind;
  /** 受控日志用:Zod issue 的字段路径与 code(零 message,防输入片段回显)。 */
  readonly issuePaths?: readonly string[];
  readonly issueCount?: number;
  readonly dimension?: GuardViolation["dimension"];
}

export type CommandParseResult =
  | { readonly ok: true; readonly request: SessionCommandRequest }
  | { readonly ok: false; readonly failure: CommandValidationFailure };

/**
 * 解析并校验会话命令请求体:
 *  1. 结构护栏(深度 / 数组 / 字符串;字节上限在 bodyLimit 解析层);
 *  2. 版本受理判定(不在 SUPPORTED 集合 → unsupported_version);
 *  3. 按该版本的冻结 Schema 重新校验(strictObject,多余字段即拒)。
 */
export function parseSessionCommandRequest(
  body: unknown,
  limits: RequestGuardLimits,
): CommandParseResult {
  try {
    assertRequestWithinLimits(body, limits);
  } catch (error) {
    if (error instanceof GuardViolation) {
      return { ok: false, failure: { kind: "guard_violation", dimension: error.dimension } };
    }
    throw error;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, failure: { kind: "malformed_body" } };
  }
  const version = (body as { protocolVersion?: unknown }).protocolVersion;
  if (
    typeof version !== "number" ||
    !SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS.includes(version)
  ) {
    return { ok: false, failure: { kind: "unsupported_version" } };
  }
  const schema = REQUEST_SCHEMAS_BY_VERSION.get(version);
  if (schema === undefined) {
    // 装配期自检已兜住;此处防御性收口(不可达路径按 malformed 处理)。
    return { ok: false, failure: { kind: "unsupported_version" } };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        kind: "malformed_body",
        issueCount: parsed.error.issues.length,
        issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
    };
  }
  return { ok: true, request: parsed.data };
}

/**
 * 响应面构建前的冻结 Schema 自检:一切生命周期命令响应必须通过冻结
 * `SessionCommandResponseSchema`,漂移即抛错(实现事故走 500 兜底,
 * 绝不带病下发)。superRefine 的跨字段耦合(投影 revision === 载荷
 * revision)由此逐响应复验。
 */
export function assertValidSessionCommandResponse(body: unknown): unknown {
  return SessionCommandResponseSchema.parse(body);
}

/** 类型面再导出(z.ZodType 引用收口,避免调用方直接依赖 zod)。 */
export type SessionCommandRequestZodType = z.ZodType<SessionCommandRequest>;
export type { PublicError };
