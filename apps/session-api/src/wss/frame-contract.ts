/**
 * WSS 帧级契约校验(任务分解 WP-5 第 2 条;D-API-46)。
 *
 * 与 REST 侧 routes/session-contract.ts 同构的版本路由形态:
 *  - 受理集合锚点 = `SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS`(D-API-4;
 *    冻结期恒 [1]);版本 → 帧冻结 Schema 注册表,各版本独立校验;
 *  - 连接级版本锚定(D-API-2)在通道状态机执行:首帧(受理集合内的)版本即
 *    本连接解释版本,此后任何帧携带其他版本一律确定性拒绝;
 *  - 结构护栏(深度 / 数组 / 字符串)先于 Schema 校验触发(与 REST 同一面,
 *    防 Schema 校验前的资源消耗;8.3 纪律);
 *  - 校验失败零校验器细节:issue 的字段路径与计数只进受控日志,message 一律
 *    不入日志(Zod message 可能回显输入片段),响应面恒为冻结 PublicError。
 */
import {
  SESSION_ACTION_PROTOCOL_VERSION,
  SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS,
  WssFrameSchema,
  type WssFrame,
} from "@stackmaster/protocol";
import type { z } from "zod";

import { assertRequestWithinLimits, GuardViolation, type RequestGuardLimits } from "../routes/request-guards.js";

/** 版本 → 帧冻结 Schema 注册表(扩展 N-1 时在此登记)。 */
const FRAME_SCHEMAS_BY_VERSION = new Map<number, z.ZodType<WssFrame>>([
  [SESSION_ACTION_PROTOCOL_VERSION, WssFrameSchema],
]);

// 装配期自检:受理集合中的每个版本必须有已注册帧 Schema(缺实现即模块加载
// 失败,与 session-contract.ts 同纪律)。
for (const version of SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS) {
  if (!FRAME_SCHEMAS_BY_VERSION.has(version)) {
    throw new Error(
      `WSS 帧受理集合中的协议版本 ${version} 缺少已注册帧 Schema(N-1 受理实现不完整)`,
    );
  }
}

/** 帧校验失败类别(响应面映射归通道错误帧常量;细节只进受控日志)。 */
export type WssFrameRejectionKind =
  | "malformed_json"
  | "unsupported_version"
  | "version_anchor_violation"
  | "malformed_frame"
  | "guard_violation";

export interface WssFrameRejection {
  readonly kind: WssFrameRejectionKind;
  /** 受控日志用:Zod issue 字段路径与计数(零 message,防输入片段回显)。 */
  readonly issuePaths?: readonly string[];
  readonly issueCount?: number;
  readonly dimension?: GuardViolation["dimension"];
}

export type WssFrameParseResult =
  | { readonly ok: true; readonly frame: WssFrame }
  | { readonly ok: false; readonly rejection: WssFrameRejection };

/**
 * 校验一帧(已 JSON.parse 的对象):
 *  1. 结构护栏(深度 / 数组 / 字符串);
 *  2. 版本受理判定(不在 SUPPORTED 集合 → unsupported_version);
 *  3. 连接锚定(anchoredVersion 非空且与本帧版本不符 → version_anchor_violation);
 *  4. 该版本的冻结帧 Schema 重新校验(strictObject,多余字段即拒)。
 */
export function parseWssChannelFrame(
  value: unknown,
  anchoredVersion: number | null,
  limits: RequestGuardLimits,
): WssFrameParseResult {
  try {
    assertRequestWithinLimits(value, limits);
  } catch (error) {
    if (error instanceof GuardViolation) {
      return { ok: false, rejection: { kind: "guard_violation", dimension: error.dimension } };
    }
    throw error;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, rejection: { kind: "malformed_frame" } };
  }
  const version = (value as { protocolVersion?: unknown }).protocolVersion;
  if (typeof version !== "number" || !SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS.includes(version)) {
    return { ok: false, rejection: { kind: "unsupported_version" } };
  }
  if (anchoredVersion !== null && version !== anchoredVersion) {
    return { ok: false, rejection: { kind: "version_anchor_violation" } };
  }
  const schema = FRAME_SCHEMAS_BY_VERSION.get(version);
  if (schema === undefined) {
    // 装配期自检已兜住;此处防御性收口。
    return { ok: false, rejection: { kind: "unsupported_version" } };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: {
        kind: "malformed_frame",
        issueCount: parsed.error.issues.length,
        issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
    };
  }
  return { ok: true, frame: parsed.data };
}
