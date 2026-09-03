/**
 * server-only 子路径入口(@stackmaster/protocol/server-only)。
 *
 * 本入口承载"Schema 可存在、载荷禁下发"的后端专用契约(当前:ProjectionPolicy,
 * WP-1 第五章)。仅后端包(challenge-compiler、session-api、verifier)可导入;
 * 浏览器可达包导入即违规,由 tooling/dependency-cruiser.cjs 的
 * `protocol-server-only-backend-consumers-only` 规则强制(WP-1 §五 / ZR-P1)。
 *
 * 包入口(index.ts)刻意不 re-export 本目录:TS 构建图中凡是只从包入口导入的
 * 浏览器包天然不可达本子路径。
 */
export * from "./projection-policy.js";
