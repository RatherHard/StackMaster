/**
 * WSS 通道常量:路由、关闭码与错误帧载荷(阶段三 WP-5;D-API-40 ~ D-API-48)。
 *
 * 错误帧纪律(任务分解 WP-5"错误帧纪律"):一切通道级失败 = `WssFrame.error`
 * 分支,载荷 = 冻结 `PublicError` 形态——code ∈ 16 冻结码、message 恒为静态
 * 模板,零校验器细节、零内部细节;畸形帧细节只进受控日志(基线 #8)。
 * 载荷常量在模块加载期过冻结 Schema 自检,契约漂移即抛错(拒绝启动,与
 * server.ts / error-mapping.ts 装配期自检同源)。
 *
 * 选码纪律:与 D-API-14 同族——`invalid_input_format` 是唯一 coarse 级、
 * 无地址、可无解释的协议级拒绝码(认证 / 畸形 / 版本 / 绑定类拒绝);
 * `budget_exhausted` 承载资源预算类通道失败(频率超限 / 背压 / 空闲超限,
 * 能力矩阵 addressHex = forbidden、explanation = forbidden,零解释面)。
 */
import { PublicErrorSchema, type PublicError } from "@stackmaster/protocol";

/**
 * WSS 动作通道路由(任务分解 WP-5 第 1 条):必须位于会话凭证 Cookie 的
 * Path=/sessions 前缀覆盖之下(D-API-12),否则升级握手读不到凭证。
 */
export const WSS_CHANNEL_ROUTE = "/sessions/channel";

// ── RFC 6455 关闭码(服务端主动关闭的确定性登记,D-API-48)────────────────

/** 空闲超时断开(pong / 入站消息静默超过 idle timeout;走断线恢复路径)。 */
export const WSS_CLOSE_IDLE_TIMEOUT = 1000;
/** 同会话新连接踢旧(多连接策略 = 踢旧,错误帧说明后关闭,D-API-40)。 */
export const WSS_CLOSE_REPLACED = 1008;
/** 服务端优雅停机(close-wss-channels 停机步骤,发送缓冲冲刷后关闭)。 */
export const WSS_CLOSE_SHUTDOWN = 1001;
/** 发送缓冲超限(背压断开,走断线恢复路径,D-API-44)。 */
export const WSS_CLOSE_SEND_BUFFER_OVERFLOW = 1013;
/** 出站帧契约自检失败(实现事故:细节只进受控日志,立即策略关闭)。 */
export const WSS_CLOSE_INTERNAL_DRIFT = 1011;
/** 升级后未认证防御面(preHandler 已保证不可达;防御性策略关闭)。 */
export const WSS_CLOSE_UNAUTHENTICATED = 1008;

// ── 通道级错误帧载荷(全部 = 冻结 PublicError 静态常量)───────────────────

/** 畸形帧(JSON 不可解析 / 非对象 / 方向违规 / 契约校验失败;细节只进日志)。 */
export const WSS_MALFORMED_FRAME_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "malformed frame",
});

/** 版本不受支持(不在受理集合,或违背连接级锚定;D-API-2)。 */
export const WSS_UNSUPPORTED_VERSION_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "unsupported protocol version",
});

/** 会话绑定不匹配(帧 sessionId 或载荷 sessionId 与凭证绑定会话不符)。 */
export const WSS_SESSION_MISMATCH_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "session mismatch",
});

/** 同会话第二连接踢旧(多连接策略的错误帧说明,D-API-40)。 */
export const WSS_CONNECTION_REPLACED_ERROR: PublicError = PublicErrorSchema.parse({
  code: "invalid_input_format",
  message: "connection replaced",
});

/** 通道消息频率超限(每连接令牌桶触顶;逐帧确定性拒绝,连接保持,D-API-43)。 */
export const WSS_RATE_LIMIT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "message rate limit exceeded",
});

/**
 * 每会话动作频率超限(WP-6 每会话闸触顶;与每连接令牌桶叠加,同源实现,
 * D-API-53;逐帧确定性拒绝,连接保持)。
 */
export const WSS_ACTION_RATE_LIMIT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "action rate limit exceeded",
});

/** 发送缓冲超限(背压断开前的最后错误帧,D-API-44)。 */
export const WSS_SEND_BUFFER_OVERFLOW_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "send buffer limit exceeded",
});

/** 心跳空闲超限(pong / 入站消息静默超时,D-API-42)。 */
export const WSS_IDLE_TIMEOUT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "budget_exhausted",
  message: "connection idle timeout",
});

/** 幂等键冲突(同键异负载;文案与编排核心预检静态模板一致,§4.3)。 */
export const WSS_IDEMPOTENCY_CONFLICT_ERROR: PublicError = PublicErrorSchema.parse({
  code: "idempotency_conflict",
  message: "idempotency key conflict",
});
