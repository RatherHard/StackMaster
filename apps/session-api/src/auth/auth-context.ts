/**
 * AuthContext 真实实现(WP-2;session-core 接口的结构等价装配)。
 *
 * `@stackmaster/session-core` 的 `AuthContext` / `SessionPrincipal` 接口
 * (packages/session-core/src/auth.ts)逐字段镜像于此:WP-2 交付期内
 * session-api 的 package.json 未声明该工作区依赖且依赖安装面被冻结(任务
 * 纪律:不动 package.json、不跑 pnpm install),TS 的结构类型保证本文件
 * 工厂返回值可原样赋给 session-core 侧接口。WP-4 装配编排器时建议将本文件
 * 切换为对 `@stackmaster/session-core` 的真类型导入——届时任何接口漂移都会
 * 在装配期类型报错(装配即校验),不会静默偏离。
 *
 * 语义(基线 6.2 第 1 / 2 条):
 *  - principal():身份完全来自已通过校验的凭证 claims——请求体不存在身份
 *    字段(会话动作协议 §七 #1 的编排侧实现锚);
 *  - assertSessionAllowed():会话绑定校验——凭证只对签发它的会话有效,
 *    跨会话呈递即确定性拒绝(§七 #2;红灯矩阵"凭证跨会话使用")。
 */

import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";

/** 镜像:session-core SessionPrincipal(认证派生身份)。 */
export interface SessionPrincipal {
  readonly userId: string;
  readonly tenantId: string;
}

/** 镜像:session-core AuthContext(可注入认证上下文)。 */
export interface AuthContext {
  /** 派生当前主体(基线 #1:身份只来自认证上下文)。 */
  principal(): SessionPrincipal;
  /** 校验会话对主体的允许性(基线 #2:会话 token 绑定校验)。 */
  assertSessionAllowed(session: { readonly sessionId: string }): void;
}

/** 绑定不匹配(确定性拒绝;调用方只允许以统一 401 形态响应,D-API-14)。 */
export class SessionBindingError extends Error {
  constructor(expectedSessionId: string) {
    super(`session binding mismatch: credential bound to ${expectedSessionId}`);
    this.name = "SessionBindingError";
  }
}

/**
 * 从已通过校验的会话凭证 claims 构造 AuthContext。
 * 输入取 claims 的绑定三元组(sessionId / tenantId / userId)——直接传完整
 * `SessionCredentialClaims` 亦可(结构兼容)。
 */
export function createSessionAuthContext(
  claims: Pick<SessionCredentialClaims, "sessionId" | "tenantId" | "userId">,
): AuthContext {
  return {
    principal: () => ({ userId: claims.userId, tenantId: claims.tenantId }),
    assertSessionAllowed: (session) => {
      if (session.sessionId !== claims.sessionId) {
        throw new SessionBindingError(claims.sessionId);
      }
    },
  };
}
