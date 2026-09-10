/**
 * 调试通道帧级契约校验(阶段四 WP-41;WP-40 冻结契约的消费面)。
 *
 * 与既有 WSS 通道 frame-contract.ts 同构的版本路由形态,**零改动既有通道**
 * (D-API-2 锚定实现零触碰,调试通道内自建同款):
 *  - 受理集合锚点 = `SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS`(冻结期恒
 *    [1];N-1 窗口约定见调试通道协议语义 §四);
 *  - 连接级版本锚定:首帧(受理集合内的)版本即本连接解释版本,此后任何帧
 *    携带其他版本一律确定性拒绝;
 *  - 结构护栏(深度 / 数组 / 字符串)先于 Schema 校验触发(与 REST 同一面,
 *    8.3 纪律);
 *  - 校验失败零校验器细节:issue 路径与计数只进受控日志,响应面恒为冻结
 *    PublicError(基线 #8 通道面)。
 */
import {
  DEBUG_CHANNEL_PROTOCOL_VERSION,
  DebugFrameSchema,
  SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS,
  type DebugFrame,
} from "@stackmaster/protocol";
import type { z } from "zod";

import { assertRequestWithinLimits, GuardViolation, type RequestGuardLimits } from "../routes/request-guards.js";

/** 版本 → 帧冻结 Schema 注册表(扩展 N-1 时在此登记)。 */
const DEBUG_FRAME_SCHEMAS_BY_VERSION = new Map<number, z.ZodType<DebugFrame>>([
  [DEBUG_CHANNEL_PROTOCOL_VERSION, DebugFrameSchema],
]);

// 装配期自检:受理集合中的每个版本必须有已注册帧 Schema(缺实现即模块
// 加载失败,与既有通道同纪律)。
for (const version of SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS) {
  if (!DEBUG_FRAME_SCHEMAS_BY_VERSION.has(version)) {
    throw new Error(
      `调试通道帧受理集合中的协议版本 ${version} 缺少已注册帧 Schema(N-1 受理实现不完整)`,
    );
  }
}

/** 帧校验失败类别(响应面映射归通道错误帧常量;细节只进受控日志)。 */
export type DebugFrameRejectionKind =
  | "malformed_json"
  | "unsupported_version"
  | "version_anchor_violation"
  | "malformed_frame"
  | "guard_violation"
  | "direction_violation"
  | "session_mismatch";

export interface DebugFrameRejection {
  readonly kind: DebugFrameRejectionKind;
  /** 受控日志用:Zod issue 字段路径与计数(零 message,防输入片段回显)。 */
  readonly issuePaths?: readonly string[];
  readonly issueCount?: number;
  readonly dimension?: GuardViolation["dimension"];
}

export type DebugFrameParseResult =
  | { readonly ok: true; readonly frame: DebugFrame }
  | { readonly ok: false; readonly rejection: DebugFrameRejection };

/**
 * 校验一帧(已 JSON.parse 的对象):
 *  1. 结构护栏(深度 / 数组 / 字符串);
 *  2. 版本受理判定(不在 SUPPORTED 集合 → unsupported_version);
 *  3. 连接锚定(anchoredVersion 非空且与本帧版本不符 → version_anchor_violation);
 *  4. 该版本的冻结帧 Schema 重新校验(strictObject,多余字段即拒)。
 * 方向检查与会话绑定由通道状态机执行(需凭证上下文,不在本函数)。
 */
export function parseDebugChannelFrame(
  value: unknown,
  anchoredVersion: number | null,
  limits: RequestGuardLimits,
): DebugFrameParseResult {
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
  if (
    typeof version !== "number" ||
    !SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS.includes(version)
  ) {
    return { ok: false, rejection: { kind: "unsupported_version" } };
  }
  if (anchoredVersion !== null && version !== anchoredVersion) {
    return { ok: false, rejection: { kind: "version_anchor_violation" } };
  }
  const schema = DEBUG_FRAME_SCHEMAS_BY_VERSION.get(version);
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
