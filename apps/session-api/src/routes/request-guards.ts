/**
 * 请求护栏(任务分解 WP-4 第 3 条;计划书 8.3 请求护栏纪律;D-API-31)。
 *
 * 四个维度:
 *  - 请求体字节上限:由 fastify `bodyLimit` 在解析层强制(config
 *    maxRequestBodyBytes;超限是框架级 413,server.ts 错误兜底映射为冻结形态);
 *  - 嵌套深度 / 数组长度 / 字符串长度:本模块对**已解析**的请求体做结构
 *    巡检(确定性、深度优先),任一越界即拒绝——不依赖契约 Schema 的
 *    逐字段上限(那是对"已知字段"的第二道闸;本护栏兜住未知嵌套结构,
 *    防 zip-bomb 式深嵌套与巨型数组在 Schema 校验前的资源消耗)。
 *
 * 纪律:
 *  - 拒绝是确定性的:同一请求体恒得到同一结论(I-4),与隐藏状态无关;
 *  - 越界细节(深度值、数组长度、字段路径)只进受控日志,响应面恒为
 *    冻结 `PublicError` 形态、零校验器细节(基线 #8)。
 */

/** 结构护栏上限(非配置面:与冻结契约的字段级上限同量级的通用外圈)。 */
export const GUARD_MAX_ARRAY_LENGTH = 256;
export const GUARD_MAX_STRING_LENGTH = 4096;

export interface RequestGuardLimits {
  /** JSON 嵌套深度上限(config.maxJsonDepth)。 */
  readonly maxJsonDepth: number;
  /** 数组长度上限(GUARD_MAX_ARRAY_LENGTH;契约字段级上限由 Schema 另行强制)。 */
  readonly maxArrayLength: number;
  /** 字符串长度上限(GUARD_MAX_STRING_LENGTH;≥ EMBED_TOKEN_MAX_LENGTH,不与契约冲突)。 */
  readonly maxStringLength: number;
}

/** 结构护栏违规(越界维度只进受控日志;调用方以冻结形态响应)。 */
export class GuardViolation extends Error {
  readonly dimension: "json_depth" | "array_length" | "string_length";

  constructor(dimension: "json_depth" | "array_length" | "string_length", detail: string) {
    super(`request guard violated (${dimension}): ${detail}`);
    this.name = "GuardViolation";
    this.dimension = dimension;
  }
}

/**
 * 对已解析的请求体做结构巡检(深度优先;越界即抛 GuardViolation)。
 * 原始 JSON 文本的字节上限在解析层(bodyLimit)已先行强制。
 */
export function assertRequestWithinLimits(
  value: unknown,
  limits: RequestGuardLimits,
  depth = 0,
): void {
  if (depth > limits.maxJsonDepth) {
    throw new GuardViolation("json_depth", `嵌套深度超过上限 ${limits.maxJsonDepth}`);
  }
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      throw new GuardViolation("string_length", `字符串长度超过上限 ${limits.maxStringLength}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new GuardViolation("array_length", `数组长度超过上限 ${limits.maxArrayLength}`);
    }
    for (const item of value) {
      assertRequestWithinLimits(item, limits, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertRequestWithinLimits(item, limits, depth + 1);
    }
  }
}
