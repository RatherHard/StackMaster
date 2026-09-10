/**
 * 持久化面错误类型(WP-3)。
 *
 * 纪律:错误消息只含操作语义与稳定错误码,绝不携带载荷原文、连接串、
 * 密钥或任何语料(与 config.ts / logger.ts 的错误面纪律同源;动作日志是
 * 玩家提交可见面 BOUNDARY,错误面同样不得成为秘密外泄通道)。
 */

/** 持久化面稳定错误码(编排器据此选择确定性处置路径)。 */
export type PersistenceErrorCode =
  | "store_unavailable" // 依赖不可用(fail-closed 分级:token / route 等)
  | "snapshot_ciphertext_malformed" // 密文信封形态非法(魔数 / 版本 / 长度)
  | "snapshot_auth_failed" // AES-GCM 认证失败(密钥不符或密文被篡改)
  | "snapshot_key_invalid" // 密钥缺失 / 非法(启动期即拦截,运行期兜底)
  | "no_snapshot_for_recovery" // 恢复路径要求至少一个快照恢复点
  | "session_not_found" // 会话不存在或租户不匹配(统一形态防枚举)
  | "challenge_version_conflict" // 题目版本已登记(版本不可变)
  | "registration_unverifiable" // 登记签名校验失败(fail-closed)
  | "invalid_identifier" // 标识符字符集越界(防对象存储路径注入)
  | "migration_failed"; // 迁移执行失败(fail-closed,启动拒绝)

/** 持久化面错误(消息只含稳定语义文案,零载荷细节)。 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
