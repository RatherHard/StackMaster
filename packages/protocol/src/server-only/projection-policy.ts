/**
 * ProjectionPolicy —— 投影白名单策略(WP-1 第五章,WP-3 冻结;整体 SERVER_ONLY)。
 *
 * **Schema 存在不等于可下发**(WP-1 §五):本 Schema 冻结策略的字段集合,
 * 供后端各包(challenge-compiler、session-api、verifier)跨语言一致性校验
 * 消费;策略对象本身永不出现在任何跨域载荷——浏览器只接收它产生的脱敏
 * 效果(公开投影),永不接收策略本身。
 *
 * 驻留:域 3(权威执行域);由公开描述包的可见布局与私有判题包的隐藏对象
 * 排除集组装而成。下发完整名单等于宣告"其余区域皆为隐藏",给出隐藏区域 /
 * 隐藏对象 / 秘密汇寄存器的存在性与命名空间(WP-1 §五逐字段论证)。
 *
 * 消费纪律:本模块仅通过子路径 `@stackmaster/protocol/server-only` 导出;
 * 包入口(index.ts)不导出本模块。dependency-cruiser 规则
 * `protocol-server-only-backend-consumers-only` 禁止浏览器可达包
 * (vm-ui、web-component、embed-runtime、react-wrapper 等)导入本子路径,
 * 防止 server-only 类型进入浏览器构建图诱发误序列化(WP-1 §五 / ZR-P1)。
 */
import { z } from "zod";
import { OpaqueIdSchema } from "../common/identifiers.js";
import {
  MAX_BYTES_PER_RANGE_MAX,
  MAX_VISIBLE_OBJECTS,
  MAX_VISIBLE_REGISTERS,
  MAX_VISIBLE_REGIONS,
} from "../common/limits.js";
import { RegisterNameSchema } from "../common/register-name.js";

/**
 * 错误精度级别(WP-1 10.1):coarse = 正式判题与 verifier 语境及策略要求的场合;
 * educational = 交互会话默认,是教学价值核心。级别效果体现在错误载荷的解释
 * 字段裁剪(同一 PublicError Schema 下 coarse 只填 code + message),不在
 * 响应 Schema 形态。
 */
export const ErrorDetailLevelSchema = z.enum(["coarse", "educational"]);
export type ErrorDetailLevel = z.infer<typeof ErrorDetailLevelSchema>;

export const ProjectionPolicySchema = z.strictObject({
  /** 可见区域标识白名单;名单补集即隐藏区域清单(存在性与命名空间不外泄的唯一保证是不下发)。 */
  visibleRegions: z.array(OpaqueIdSchema).max(MAX_VISIBLE_REGIONS),
  /** 可见对象标识白名单;补集即隐藏对象清单(I-2 排除集语义)。 */
  visibleObjects: z.array(OpaqueIdSchema).max(MAX_VISIBLE_OBJECTS),
  /** 可见寄存器白名单;秘密汇寄存器不得进入由 I-3 编译期污点推导强制。 */
  visibleRegisters: z.array(RegisterNameSchema).max(MAX_VISIBLE_REGISTERS),
  /**
   * 单区域字节窗口上限(D3 数值冻结):默认 MAX_BYTES_PER_RANGE_DEFAULT(256),
   * 题目可按需收紧或放宽至协议上限 MAX_BYTES_PER_RANGE_MAX(4096)。
   */
  maxBytesPerRange: z.number().int().min(1).max(MAX_BYTES_PER_RANGE_MAX),
  errorDetailLevel: ErrorDetailLevelSchema,
});
export type ProjectionPolicy = z.infer<typeof ProjectionPolicySchema>;
