/**
 * PublicError —— 脱敏后的用户可见错误(WP-1 §4.4 / §6.3 E-1–E-6,WP-3 冻结)。
 *
 * 可解释性是本项目教学价值核心(计划书 4.4):educational 级错误在 teaching
 * 闭环中向玩家解释"这个值被如何解释、为什么被拒绝"。但解释字段全部由
 * 可见状态参数化(10.1 矩阵 / I-10),逐 code 的允许面由 ERROR_CODE_CAPABILITIES
 * 能力矩阵冻结,并在本 Schema 的 superRefine 中机检——矩阵之外的组合在
 * 契约层即拒绝,杜绝"解释字段夹带私有信息"的实现事故。
 *
 * coarse / educational 的区别不在 Schema 形态,而在生成端:同一 Schema 下,
 * coarse 级载荷只填 code + message(解释字段整体缺席,WP-1 10.1),
 * 由生成端纪律与 ZR-P6 机检承接。
 */
import { z } from "zod";
import { AddressHexSchema, ValueHex64Schema } from "../common/hex.js";
import { OpaqueIdSchema } from "../common/identifiers.js";
import {
  ERROR_HINT_MAX_LENGTH,
  ERROR_MESSAGE_MAX_LENGTH,
  MAX_ERROR_HINTS,
} from "../common/limits.js";
import { PublicTextSchema } from "../common/public-text.js";
import { PermissionsSchema } from "../projection/visible-memory-region.js";
import { PublicErrorCodeSchema, type PublicErrorCode } from "./public-error-code.js";

/** 值解释方式:位宽 × 端序(由题目 VM Profile 公开元数据决定,WP-1 §4.4)。 */
export const InterpretedAsSchema = z.enum([
  "little_endian_qword",
  "little_endian_dword",
  "big_endian_qword",
  "big_endian_dword",
]);
export type InterpretedAs = z.infer<typeof InterpretedAsSchema>;

/** 解释字段白名单键(能力矩阵 explanationFields 的取值域)。 */
const EXPLANATION_FIELDS = [
  "regionId",
  "permissions",
  "valueHex",
  "interpretedAs",
  "alignmentBytes",
  "expectedBytesLength",
  "actualBytesLength",
  "hints",
] as const;
type ExplanationField = (typeof EXPLANATION_FIELDS)[number];

/**
 * addressHex 的逐 code 允许形态(WP-1 E-2 / I-8 / I-9):
 * - "forbidden":字段必须整体缺席(协议级拒绝类无内存语境;显式 null 也不允许,
 *   缺席即"无地址"的确定性形态);
 * - "null-only":恒为 null 统一占位(I-9:不可见地址不区分隐藏映射与未映射,
 *   M-3 抉择选 JSON null 而非伪 hex 常量——伪 hex 会被客户端当真实地址渲染);
 * - "free":真实地址 | null | 缺席,由 (code, 可见状态, errorDetailLevel) 确定性选择
 *   (真实地址要求落在可见区域,E-2);
 * - "required-real":必须携带真实可见地址(权限 / canary 教学解释的地址锚点)。
 */
export type AddressHexMode = "forbidden" | "null-only" | "free" | "required-real";

/** explanation 是否允许携带;"forbidden" = 整体缺席(E-4 的零解释形态)。 */
export type ExplanationMode = "forbidden" | "optional";

export interface ErrorCodeCapability {
  readonly addressHex: AddressHexMode;
  readonly explanation: ExplanationMode;
  /** explanation 为 optional 时允许出现的字段白名单;forbidden 时为空(静态保证)。 */
  readonly explanationFields: readonly ExplanationField[];
}

/**
 * 逐 code 能力矩阵(WP-1 §4.4 收尾段冻结的确定性函数):
 *
 * - 协议级拒绝类(stale_base_revision / stale_client_seq / idempotency_conflict /
 *   session_terminal / internal_error / budget_exhausted)与 objective_not_met
 *   不带地址与解释字段(E-4 / I-7:零谓词信息);
 * - inaccessible_address 的 addressHex 恒为 null(I-9 统一形态),目标值经
 *   explanation.valueHex 回显(玩家自供内容);
 * - permission_denied / canary_violation 必须携带真实可见地址(教学解释锚点);
 * - 数值解释字段(expected / actualBytesLength、alignmentBytes)的值来源 ⊆
 *   {协议级公开上限, 公开描述包预算, 可见区域边界, 对齐常量}(E-3);
 * - hints 为服务端静态模板教学提示(10.1 educational 列),禁止谓词信息与 E-6 禁项。
 */
export const ERROR_CODE_CAPABILITIES = {
  invalid_input_format: {
    addressHex: "forbidden",
    explanation: "optional",
    explanationFields: ["hints"],
  },
  invalid_payload_length: {
    addressHex: "free",
    explanation: "optional",
    explanationFields: ["regionId", "expectedBytesLength", "actualBytesLength", "hints"],
  },
  offset_out_of_range: {
    addressHex: "free",
    explanation: "optional",
    explanationFields: ["regionId", "expectedBytesLength", "actualBytesLength", "hints"],
  },
  endianness_mismatch: {
    addressHex: "forbidden",
    explanation: "optional",
    explanationFields: ["valueHex", "interpretedAs", "hints"],
  },
  permission_denied: {
    addressHex: "required-real",
    explanation: "optional",
    explanationFields: ["regionId", "permissions", "hints"],
  },
  invalid_rip: {
    addressHex: "free",
    explanation: "optional",
    explanationFields: [
      "regionId",
      "permissions",
      "valueHex",
      "interpretedAs",
      "alignmentBytes",
      "hints",
    ],
  },
  canary_violation: {
    addressHex: "required-real",
    explanation: "optional",
    explanationFields: ["regionId", "valueHex", "hints"],
  },
  invalid_call_argument: {
    addressHex: "forbidden",
    explanation: "optional",
    explanationFields: ["valueHex", "hints"],
  },
  objective_not_met: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
  inaccessible_address: {
    addressHex: "null-only",
    explanation: "optional",
    explanationFields: ["valueHex", "hints"],
  },
  budget_exhausted: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
  stale_base_revision: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
  stale_client_seq: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
  idempotency_conflict: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
  session_terminal: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
  internal_error: {
    addressHex: "forbidden",
    explanation: "forbidden",
    explanationFields: [],
  },
} as const satisfies Readonly<Record<PublicErrorCode, ErrorCodeCapability>>;

const PublicErrorExplanationSchema = z.strictObject({
  /** 教学解释涉及的可见区域;必须引用白名单可见区域(I-2)。 */
  regionId: OpaqueIdSchema.optional(),
  /** 该可见区域的权限事实(r/w/x)——"为什么不在可执行 / 可写区域"的载体(10.1)。 */
  permissions: PermissionsSchema.optional(),
  /** 被解释的值(如被当作返回地址弹出的 qword);玩家输入或可见内容的回显(E-3 / I-10)。 */
  valueHex: ValueHex64Schema.optional(),
  /** 该值被如何解释(位宽 × 端序);由题目 VM Profile 公开元数据决定。 */
  interpretedAs: InterpretedAsSchema.optional(),
  /** 对齐要求(字节);来源 ⊆ 对齐常量(E-3)。 */
  alignmentBytes: z
    .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
    .optional(),
  /** 期望长度;来源 ⊆ {协议级公开上限, 公开描述包预算, 可见区域边界}(E-3)。 */
  expectedBytesLength: z.number().int().min(0).optional(),
  /** 玩家输入的实际长度(玩家自供内容)。 */
  actualBytesLength: z.number().int().min(0).optional(),
  /** 服务端静态模板教学提示(检查 padding、little-endian、RSP 位置,10.1)。 */
  hints: z
    .array(PublicTextSchema(ERROR_HINT_MAX_LENGTH))
    .max(MAX_ERROR_HINTS)
    .optional(),
});

const PublicErrorBaseSchema = z.strictObject({
  code: PublicErrorCodeSchema,
  /**
   * 按 (code, 可见状态) 参数化的静态最小文案(E-5);禁止内部堆栈、文件路径、
   * capability 名称、隐藏区域名、seed 信息(E-6,由 ZR-B7 语料扫描承接值级违规——
   * Schema 宽度与值级扫描分工,WP-2 移交事项)。
   */
  message: z.string().min(1).max(ERROR_MESSAGE_MAX_LENGTH),
  /** 允许形态见 ERROR_CODE_CAPABILITIES(由下方 superRefine 机检)。 */
  addressHex: AddressHexSchema.nullable().optional(),
  explanation: PublicErrorExplanationSchema.optional(),
});

/**
 * 能力矩阵机检:addressHex 形态与 explanation 字段白名单逐 code 强制。
 * 注:superRefine 对 z.toJSONSchema 透明,该矩阵不进落盘 JSON Schema——
 * Rust 侧一致性由 golden fixture 承接(每种违规形态至少一个反例),
 * 见语义文档 §六。
 */
export const PublicErrorSchema = PublicErrorBaseSchema.superRefine((error, ctx) => {
  const capability = ERROR_CODE_CAPABILITIES[error.code];

  switch (capability.addressHex) {
    case "forbidden":
      if (error.addressHex !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["addressHex"],
          message: `code ${error.code} 不允许携带 addressHex(含 null,WP-1 §4.4)`,
        });
      }
      break;
    case "null-only":
      if (error.addressHex !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["addressHex"],
          message: `code ${error.code} 的 addressHex 恒为 null(I-9:不可见地址统一占位形态)`,
        });
      }
      break;
    case "required-real":
      if (error.addressHex === undefined || error.addressHex === null) {
        ctx.addIssue({
          code: "custom",
          path: ["addressHex"],
          message: `code ${error.code} 必须携带真实可见地址(教学解释锚点,E-2)`,
        });
      }
      break;
    case "free":
      break;
  }

  if (capability.explanation === "forbidden") {
    if (error.explanation !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["explanation"],
        message: `code ${error.code} 不允许携带 explanation(E-4 / I-7:零解释字段)`,
      });
    }
  } else if (error.explanation !== undefined) {
    const allowedFields = capability.explanationFields as readonly ExplanationField[];
    for (const field of EXPLANATION_FIELDS) {
      if (!allowedFields.includes(field) && error.explanation[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["explanation", field],
          message: `解释字段 ${field} 不在 code ${error.code} 的允许面内(WP-1 §4.4 能力矩阵)`,
        });
      }
    }
  }
});
export type PublicError = z.infer<typeof PublicErrorSchema>;
