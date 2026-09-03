/**
 * 题目双包契约版本常量(计划书 5.6、7.4:每类契约携带独立版本号)。
 */

/**
 * 双包格式信封版本(public-descriptor / private-bundle Schema 的
 * `schemaVersion` 唯一合法值;两包实例侧锚点)。
 * 破坏性变更递增并保留 N-1 兼容窗口(双包Schema语义.md §七)。
 */
export const CHALLENGE_PACKAGE_SCHEMA_VERSION = 1;

/**
 * @stackmaster/challenge-schema 包版本(与 package.json / classification.json
 * 同步;非契约版本)。
 */
export const CHALLENGE_SCHEMA_PACKAGE_VERSION = "0.1.0";
