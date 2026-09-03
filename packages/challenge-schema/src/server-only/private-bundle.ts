/**
 * 私有判题包校验入口(server-only 面):JSON 文本 / 已解析对象 → 强类型判题包。
 *
 * SERVER_ONLY:仅后端包(challenge-compiler、session-api、verifier)可导入;
 * 校验通过的判题包只存在于执行域进程内,任何字段不得进入跨域载荷。
 */

import type { PrivateChallengeBundle } from "./private-types.js";
import type { SchemaViolation, Validated } from "../common/validation.js";
import { parseJsonStrict } from "../internal/json-strict-parse.js";
import { getPrivateBundleValidator, toSchemaViolations } from "../internal/schema-loader.js";

/** 校验已解析的私有判题包。 */
export function validatePrivateBundle(input: unknown): Validated<PrivateChallengeBundle> {
  const validate = getPrivateBundleValidator();
  if (!validate(input)) {
    return { ok: false, violations: toSchemaViolations(validate.errors ?? []) };
  }
  return { ok: true, value: input as PrivateChallengeBundle };
}

/** 解析私有判题包 JSON 文本(重复键拒绝,XS-DUP-KEY)后校验。 */
export function parsePrivateBundleText(text: string): Validated<PrivateChallengeBundle> {
  let parsed: unknown;
  try {
    parsed = parseJsonStrict(text);
  } catch (error: unknown) {
    return { ok: false, violations: [toParseViolation(error)] };
  }
  return validatePrivateBundle(parsed);
}

function toParseViolation(error: unknown): SchemaViolation {
  return {
    path: "",
    message: error instanceof Error ? error.message : "JSON 解析失败",
  };
}
