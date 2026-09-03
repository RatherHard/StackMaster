/**
 * 公开描述包校验入口(公开面):JSON 文本 / 已解析对象 → 强类型描述包。
 */

import type { PublicChallengeDescriptor } from "../common/public-types.js";
import type { SchemaViolation, Validated } from "../common/validation.js";
import { parseJsonStrict } from "./json-strict-parse.js";
import { getPublicDescriptorValidator, toSchemaViolations } from "./schema-loader.js";

/** 校验已解析的公开描述包(不信任任何客户端类型标注)。 */
export function validatePublicDescriptor(input: unknown): Validated<PublicChallengeDescriptor> {
  const validate = getPublicDescriptorValidator();
  if (!validate(input)) {
    return { ok: false, violations: toSchemaViolations(validate.errors ?? []) };
  }
  return { ok: true, value: input as PublicChallengeDescriptor };
}

/** 解析公开描述包 JSON 文本(重复键拒绝,XS-DUP-KEY)后校验。 */
export function parsePublicDescriptorText(text: string): Validated<PublicChallengeDescriptor> {
  let parsed: unknown;
  try {
    parsed = parseJsonStrict(text);
  } catch (error: unknown) {
    return { ok: false, violations: [toParseViolation(error)] };
  }
  return validatePublicDescriptor(parsed);
}

function toParseViolation(error: unknown): SchemaViolation {
  return {
    path: "",
    message: error instanceof Error ? error.message : "JSON 解析失败",
  };
}
