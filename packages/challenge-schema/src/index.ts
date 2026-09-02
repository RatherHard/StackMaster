/**
 * @stackmaster/challenge-schema —— 公开/私有题目包 JSON Schema 与字段分类校验器
 * (计划书 7.1 双包模型、5.6)。
 *
 * 本包承载:公开描述包 / 私有判题包 JSON Schema 2020-12(Ajv 校验)、
 * public/private 字段分类检查器(公开/私有禁止混装;公开包不得通过默认值、
 * 引用 ID 或 Schema 元数据推导私有字段)。
 *
 * WP-0 基线占位:双包 Schema 与分类检查器由 WP-4 填入;分类规则依据
 * docs/数据分类与秘密零驻留清单.md(I-2 可见/隐藏不重叠、I-3 秘密汇不可见、
 * `declaredSeedPublicPaths` 字段)。
 *
 * 依赖纪律(5.5):仅可被 challenge-compiler、session-api、verifier 依赖;
 * 本包不依赖任何工作区包或 vm-engine 产物(tooling/dependency-cruiser.cjs 强制)。
 */
export const CHALLENGE_SCHEMA_PACKAGE_VERSION = "0.1.0";
