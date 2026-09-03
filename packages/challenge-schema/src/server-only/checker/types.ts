/**
 * 字段分类检查器公共类型(WP-1 §12.6 / 双包Schema语义.md §五)。
 *
 * 违规记录带规则 ID——扫描器与测试命名必须直接引用 WP-1 §12.6 左列规则 ID
 * (第九章自检纪律);每条规则落地时附带必触发红灯样例。
 */

/** 单条检查器违规:规则 ID + 可解释消息 + JSON 指针风格路径。 */
export interface CheckerViolation {
  readonly ruleId: string;
  readonly message: string;
  readonly path?: string;
}

/** 检查器结果:ok = 无任何违规。 */
export interface CheckerResult {
  readonly ok: boolean;
  readonly violations: readonly CheckerViolation[];
}

/**
 * 同一检查的双锚点别名(双包Schema语义.md §五):
 * XS-REG-SUBSET(寄存器白名单面)与 XS-PROJ-REG(投影面)是同一约束,
 * 实现只报一次,违规记投影面规则 ID;跨包一致性测试用本表对账。
 */
export const RULE_ID_ALIASES: Readonly<Record<string, string>> = {
  "XS-REG-SUBSET": "XS-PROJ-REG",
};
