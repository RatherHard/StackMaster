/**
 * 调试通道装配面(阶段四 WP-41;ADR-DC1;WP-40 契约消费)。
 *
 * 模块地图:
 * - [`debug-channel-constants`]:路由 / 关闭码 / 冻结错误帧载荷;
 * - [`debug-frame-contract`]:帧级契约校验(版本锚定同款自建);
 * - [`debug-variant-provider`]:调试变体镜像供给端口(测试实现 + 生产桩);
 * - [`debug-channel-orchestrator`]:调试实例编排(spawn / 重放对齐 / 回收);
 * - [`debug-channel`]:连接状态机(限额共用 / 背压 / 心跳空闲);
 * - [`debug-channel-plugin`]:`GET /sessions/debug-channel` 装配。
 */

export * from "./debug-channel-constants.js";
export { parseDebugChannelFrame } from "./debug-frame-contract.js";
export type { DebugFrameRejection, DebugFrameRejectionKind } from "./debug-frame-contract.js";
export {
  placeholderDebugVariantProvider,
  productionDebugVariantProvider,
} from "./debug-variant-provider.js";
export type { DebugVariantProvider, DebugVariantRequest } from "./debug-variant-provider.js";
export { DebugChannelOrchestrator, DebugChannelError } from "./debug-channel-orchestrator.js";
export type {
  DebugAttachOrigin,
  DebugChannelOrchestratorDeps,
  DebugHaltResult,
  DebugInstanceState,
  DebugSearchHit,
  DebugWindowResult,
} from "./debug-channel-orchestrator.js";
export { DebugChannelConnection } from "./debug-channel.js";
export type { DebugChannelConnectionOptions, DebugChannelSocket } from "./debug-channel.js";
export { buildDebugChannel } from "./debug-channel-plugin.js";
export type { DebugChannelDeps } from "./debug-channel-plugin.js";
