/**
 * 编译器诊断与装载结果类型(WP-2 装载管线统一反馈面)。
 *
 * 错误两层模型(challenge-schema 检查器 R7 同纪律):
 *  - 本包产出的 CompilerViolation 是**内部诊断层**——面向题目发布管线、
 *    开发测试与管理后台(信任域 4)的作者反馈,允许私有上下文,
 *    永不进入玩家可达载荷;
 *  - 玩家可达错误只允许稳定 PublicError code;题目装载失败对玩家
 *    一律表现为 internal_error(复用 challenge-schema 的
 *    PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS,禁止透传 message / path)。
 *
 * 会话结果方向:装载失败的结果类型方向恒为 challenge_invalid
 * (阶段二任务分解 WP-2:"装载失败方向 = challenge_invalid,不近似执行")
 * ——引擎不会拿到半装载的题目,不存在带病会话。
 */

import { PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS } from "@stackmaster/challenge-schema/server-only";

/** 编译器违规(内部诊断层;ruleId 取值见各模块头注释与包内语义文档)。 */
export interface CompilerViolation {
  readonly ruleId: string;
  readonly message: string;
  /** JSON Pointer 形态实例路径("" = 根)。 */
  readonly path: string;
}

/** 装载失败的方向常量(会话结果类型 challenge_invalid 的编译层锚点)。 */
export const LOAD_FAILURE_RESULT_DIRECTION = "challenge_invalid" as const;

/** 装载失败方向(恒为 challenge_invalid;类型层面封死其他取值)。 */
export type LoadFailureDirection = typeof LOAD_FAILURE_RESULT_DIRECTION;

/** Ajv / 严格 JSON 解析层违规的 ruleId(WP-4 Schema 面不做二次编号)。 */
export const RULE_ID_SCHEMA = "SCHEMA-VIOLATION";
export const RULE_ID_JSON_PARSE = "JSON-PARSE";

/** 编译器自有规则 ID 前缀(XC-*):与 WP-1 §12.6 冻结的 XS-* 检查器注册表互不侵占。 */
export const COMPILER_RULE_PREFIX = "XC-";

function violation(ruleId: string, message: string, path: string): CompilerViolation {
  return { ruleId, message, path };
}

export function schemaViolation(message: string, path: string): CompilerViolation {
  return violation(RULE_ID_SCHEMA, message, path);
}

export function compilerViolation(
  ruleId: string,
  message: string,
  path: string,
): CompilerViolation {
  return violation(ruleId, message, path);
}

/** 装载 / 迁移失败:方向恒为 challenge_invalid,附内部诊断清单。 */
export interface LoadFailure {
  readonly ok: false;
  readonly direction: LoadFailureDirection;
  readonly violations: readonly CompilerViolation[];
}

/** 玩家可达错误码映射(不在此执行映射——会话服务层职责;本常量供其消费)。 */
export const PLAYER_FACING_ERROR_FOR_LOAD_FAILURE = PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS;
