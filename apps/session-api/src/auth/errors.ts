/**
 * 认证域的确定性异常类型(WP-2;完成标准"verify 失败以确定性异常类型表达")。
 *
 * kind 三值封闭:
 *  - "expired":签名合法但已过过期时刻(JWT exp 断言失败);
 *  - "signature_invalid":签名验证失败(伪造 / 篡改 / 密钥不符);
 *  - "malformed":载体形态非法(非 JWT 结构、claims 缺失 / 多余 / 类型不符、
 *    超出载体长度护栏)。
 *
 * kind 与携带技术细节的 message 只进受控日志与审计,永不进响应面:
 * D-API-14 规定一切凭证拒绝 = 统一 401 + 冻结 `invalid_input_format` 单一
 * 错误码 + 静态文案,kind 之间响应面零差异(防枚举;嵌入协议 §六失败面)。
 */

/** 凭证校验失败的封闭原因集(日志 / 审计判别用,非秘密)。 */
export type CredentialFailureKind = "expired" | "signature_invalid" | "malformed";

/** 凭证种类(日志 / 审计判别用,非秘密)。 */
export type CredentialKind = "embed_token" | "session_credential" | "launch_grant";

/*
 * ⚠ `"embed_token"` 成员**现无写入方**(2026-09-19,分发改版 WP-96):embed token
 * 的 verify 路径(`verifyEmbedTokenClaims`)已随嵌入协议面物理删除。成员**保留**
 * 而不是收窄的理由与审计 kind 十值封闭集同款 —— 它是**受控日志 / 审计的历史
 * 判别面**,既往日志行里的该 kind 必须仍可解释;收窄会让"读旧日志"变成一个
 * 需要另建映射表的动作。本批按"只删写入方、不收窄判别面"处置。
 */

/**
 * 凭证校验失败(当前由会话凭证 / 启动授权凭证的 verify 侧抛出;确定性异常)。
 * message 携带技术细节(错误子类名、issue 计数等)——调用方只允许将其送入
 * 受控日志,绝不回显到任何响应面。
 */
export class CredentialVerificationError extends Error {
  readonly kind: CredentialFailureKind;
  readonly credential: CredentialKind;

  constructor(credential: CredentialKind, kind: CredentialFailureKind, detail: string) {
    super(`credential verification failed (${credential}/${kind}): ${detail}`);
    this.name = "CredentialVerificationError";
    this.credential = credential;
    this.kind = kind;
  }
}
