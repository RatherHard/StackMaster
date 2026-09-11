/**
 * 调试通道常量(阶段四 WP-41;ADR-DC1 条款 1 / 决议 3 / §六 R3)。
 *
 * 独立调试通道的路由、RFC 6455 关闭码与错误帧载荷。纪律与既有 WSS 通道
 * (src/wss/channel-constants.ts)同构同源,但**零共享实现、零改动既有
 * 通道**(D-API-2 锚定面零触碰):调试通道是独立端点 + 独立协议版本
 * (DEBUG_CHANNEL_PROTOCOL_VERSION),错误帧载荷 = 冻结 PublicError 静态
 * 常量,限额 429 形态与解题侧**字节级一致**(budget_exhausted / 同文案,
 * ADR-DC1 条款 6)。载荷常量在模块加载期过冻结 Schema 自检,契约漂移即
 * 抛错(拒绝启动,与 server.ts / channel-constants.ts 装配期自检同源)。
 */
import { DebugFrameSchema, PublicErrorSchema, type PublicError } from "@stackmaster/protocol";

/**
 * 调试通道路由(ADR-DC1 §四前置项 1 的端点形态):必须位于会话凭证 Cookie
 * 的 Path=/sessions 前缀覆盖之下(D-API-12,与既有 WSS 通道同模型)。
 */
export const DEBUG_CHANNEL_ROUTE = "/sessions/debug-channel";

/**
 * run_to_breakpoint 服务端单帧步数上限(防长占的服务端常量;worker 侧另有
 * 硬帽钳制;触顶 = 确定性暂停 reason=budget,不产生部分推进的假象)。
 */
export const DEBUG_RUN_TO_BREAKPOINT_MAX_STEPS = 10_000;

/**
 * 每暂停推送的指令上下文条数(服务端常量):推送模型下每次 `debug_paused`
 * 之后由服务端主动推 `debug_instruction_stream` 的 maxItems 取值,远低于
 * 协议 caps `DEBUG_INSTRUCTION_STREAM_MAX_ITEMS` = 256(单帧批量上限);
 * 协议 v1 无 C→S 拉取帧(WP-40 §三.1 五帧封闭),推送是唯一触发面。
 */
export const DEBUG_CONTEXT_INSTRUCTION_ITEMS = 16;

// ── RFC 6455 关闭码(与既有通道同值;服务端主动关闭的确定性登记)────────

/** 空闲超时断开(pong / 入站消息静默超时;走断线恢复路径)。 */
export const DEBUG_CLOSE_IDLE_TIMEOUT = 1000;
/** 服务端优雅停机(发送缓冲冲刷后关闭)。 */
export const DEBUG_CLOSE_SHUTDOWN = 1001;
/** 发送缓冲超限(背压断开)。 */
export const DEBUG_CLOSE_SEND_BUFFER_OVERFLOW = 1013;
/** 出站帧契约自检失败(实现事故:细节只进受控日志,立即策略关闭)。 */
export const DEBUG_CLOSE_INTERNAL_DRIFT = 1011;
/** 升级后未认证防御面(preHandler 已保证不可达;防御性策略关闭)。 */
export const DEBUG_CLOSE_UNAUTHENTICATED = 1008;

// ── 通道级错误帧载荷(全部 = 冻结 PublicError 静态常量)───────────────────

/** 畸形帧(JSON 不可解析 / 方向违规 / 契约校验失败;细节只进日志)。 */
export const DEBUG_MALFORMED_FRAME_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "malformed frame",
});

/** 版本不受支持(不在受理集合,或违背连接级锚定;调试通道内自建同款)。 */
export const DEBUG_UNSUPPORTED_VERSION_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "unsupported protocol version",
});

/** 会话绑定不匹配(帧 sessionId 与凭证绑定会话不符)。 */
export const DEBUG_SESSION_MISMATCH_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "session mismatch",
});

/**
 * 每连接消息频率超限(令牌桶触顶;**文案与解题侧字节级一致**,ADR-DC1
 * 条款 6 的 429 冻结形态两边一致)。
 */
export const DEBUG_RATE_LIMIT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "message rate limit exceeded",
});

/**
 * 每会话动作预算超限(调试帧与解题动作共用同一 SessionActionRateLimiter
 * 桶,不设第二类限额;**文案与 WSS_ACTION_RATE_LIMIT_ERROR 字节级一致**,
 * ADR-DC1 条款 6)。
 */
export const DEBUG_ACTION_RATE_LIMIT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "action rate limit exceeded",
});

/** 发送缓冲超限(背压断开前的最后错误帧)。 */
export const DEBUG_SEND_BUFFER_OVERFLOW_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "send buffer limit exceeded",
});

/** 心跳空闲超限(pong / 入站消息静默超时)。 */
export const DEBUG_IDLE_TIMEOUT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "connection idle timeout",
});

/** 未编排失败兜底(细节只进受控日志;与 server.ts 500 兜底同形)。 */
export const DEBUG_INTERNAL_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "internal error",
});

// 装配期自检:错误帧载荷必须能作为调试通道 error 帧过冻结 Schema
// (契约漂移即模块加载失败,拒绝启动)。
for (const payload of [
  DEBUG_MALFORMED_FRAME_ERROR,
  DEBUG_UNSUPPORTED_VERSION_ERROR,
  DEBUG_SESSION_MISMATCH_ERROR,
  DEBUG_RATE_LIMIT_ERROR,
  DEBUG_ACTION_RATE_LIMIT_ERROR,
  DEBUG_SEND_BUFFER_OVERFLOW_ERROR,
  DEBUG_IDLE_TIMEOUT_ERROR,
  DEBUG_INTERNAL_ERROR,
]) {
  DebugFrameSchema.parse({
    protocolVersion: 1,
    type: "error",
    sessionId: "s-selfcheck",
    seq: 1,
    payload,
  });
}
