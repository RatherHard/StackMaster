/**
 * WSS 通道层导出 barrel(阶段三 WP-5)。
 *
 * 装配面:buildWssChannel(deps) → { plugin, registry };
 * 行为面:ActionChannelConnection(连接状态机)、SessionConnectionRegistry
 * (多连接踢旧 + 断线保持计时器)、BoundedSendBuffer(背压)、
 * MessageRateLimiter(频率闸,WP-6 每会话动作频率同源钩子)。
 */
export * from "./channel-constants.js";
export * from "./bounded-send-buffer.js";
export * from "./connection-registry.js";
export * from "./frame-contract.js";
export * from "./message-rate-limiter.js";
export * from "./wss-channel.js";
export * from "./wss-plugin.js";
