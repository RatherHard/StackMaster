/**
 * 协议冻结常量的本地引用面(WP-61)。
 *
 * `MAX_FRAME_BYTES`(16 MiB,D-F2)与 `ENGINE_PROCESS_PROTOCOL_VERSION`
 * 的权威登记在 `packages/protocol/src/version.ts`(会话动作协议版本常量
 * 同文件);本应用从 `@stackmaster/protocol` 消费版本常量,帧上限的
 * **天花板推导**在此登记为常量(协议常量本身不重复声明,单一来源不变)。
 */
export { ENGINE_PROCESS_PROTOCOL_VERSION } from "@stackmaster/protocol";

/** 单帧上限(协议 D-F2;与 `packages/session-core` 的同名常量同值同源)。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
