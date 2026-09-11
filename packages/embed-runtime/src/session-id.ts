/**
 * 嵌入会话标识(esid)生成与 base64url 编码。
 *
 * esid 兼任 opaque origin 场景的握手认证值(知识证明,V-5):宿主以 CSPRNG
 * 生成 ≥128 bit,base64url 编码恰 22 字符——与 protocol 包 EmbedSessionIdSchema
 * 的熵下限(minLength 22)对齐,短于下限的值在 Schema 校验即拒绝。
 * 编码为纯 JS 实现(零 btoa / Buffer 依赖,浏览器与测试环境一致)。
 */
import { EmbedSessionIdSchema } from "@stackmaster/protocol";
import { EmbedInvalidOptionError, EmbedRuntimeError } from "./errors.js";
import type { RandomBytesFn } from "./options.js";

/** base64url 字母表(RFC 4648 §5;`-_` 替代 `+/`,无填充)。 */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** esid 的随机字节数:128 bit CSPRNG → base64url 恰 22 字符。 */
export const EMBED_SESSION_ID_RANDOM_BYTES = 16;

/** 纯 JS base64url 编码(无填充;仅用于 esid 形态的任意字节序列)。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    if (b0 === undefined) break;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * 生成嵌入会话标识:注入随机源取 16 字节 → base64url(22 字符)→ 以协议
 * Schema 复验(熵下限与字符集冻结进契约层,生成侧不依赖自觉)。
 */
export function generateEmbedSessionId(randomBytes: RandomBytesFn): string {
  const sessionId = bytesToBase64Url(randomBytes(EMBED_SESSION_ID_RANDOM_BYTES));
  const parsed = EmbedSessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new EmbedRuntimeError(
      `生成的 esid 未通过协议 Schema 校验(环境随机源异常?):${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return sessionId;
}

/** 校验宿主显式指定的 esid(与生成值同一契约)。 */
export function validateEmbedSessionId(sessionId: string): string {
  const parsed = EmbedSessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new EmbedInvalidOptionError(
      `选项 sessionId 未通过协议 Schema 校验:${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return sessionId;
}
