/**
 * 不透明标识符 Schema。
 *
 * 标识符对客户端无内部结构语义;sessionId / checkpointId 的有效性由服务端
 * 会话表与 token 绑定校验,requestId 由服务端生成(WP-1 §6)。
 *
 * 字符集约束(语义文档 §2.1):服务端以字符串拼接组合键(如 `idem:{sessionId}:{key}`),
 * 受限字符集使组合键单射性无需转义约定,并消除控制字符的审计日志注入面;
 * 服务端签发 ULID/UUID 与客户端 UUID v4 均天然满足。
 */
import { z } from "zod";
import { OPAQUE_ID_MAX_LENGTH } from "./limits.js";

/** 标识符 / 幂等键的冻结字符集(语义文档 §2.1)。 */
export const IDENTIFIER_CHARSET_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 服务端签发的不透明标识符(sessionId、requestId、checkpointId)。 */
export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(OPAQUE_ID_MAX_LENGTH, `标识符超过最大长度 ${OPAQUE_ID_MAX_LENGTH}`)
  .regex(IDENTIFIER_CHARSET_PATTERN, "标识符只允许 A-Z a-z 0-9 下划线与连字符");

/**
 * 客户端生成的幂等键(WP-1 §6.1:服务端生成映射,键值本身不承担安全性)。
 * 推荐 UUID v4;语义见 packages/protocol/docs/会话动作协议语义.md §4.3。
 */
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(OPAQUE_ID_MAX_LENGTH, `幂等键超过最大长度 ${OPAQUE_ID_MAX_LENGTH}`)
  .regex(IDENTIFIER_CHARSET_PATTERN, "幂等键只允许 A-Z a-z 0-9 下划线与连字符");
