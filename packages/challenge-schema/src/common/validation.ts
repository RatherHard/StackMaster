/**
 * 校验结果类型:双包 Schema 校验器与解析器的统一返回面。
 * 错误反馈必须可解释(path 定位 + 原始约束消息),不只返回状态码。
 */

/** 单条 Schema 违规:path 为 JSON Pointer 形态实例路径("" = 根)。 */
export interface SchemaViolation {
  readonly path: string;
  readonly message: string;
}

/** 校验结果判别联合:ok 为真携带强类型值,否则携带违规清单。 */
export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly SchemaViolation[] };
