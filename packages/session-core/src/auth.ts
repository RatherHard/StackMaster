/**
 * 认证上下文替身(WP-8;服务端校验基线 #1/#2 的编排侧落点)。
 *
 * 阶段三交付真实认证(嵌入 token 校验、租户 / 题目版本绑定,WP-5 契约面);
 * 阶段二以可注入接口替身存在:编排核心的一切动作入口先经
 * [`AuthContext.assertActionAllowed`]——基线 #1"不接受请求体自报身份"由
 * 接口形态结构性表达:身份完全来自本上下文,`ActionRequest` 无身份字段。
 */

/** 认证派生身份(阶段二替身形态;真实 claims 归阶段三)。 */
export interface SessionPrincipal {
  readonly userId: string;
  readonly tenantId: string;
}

/** 可注入认证上下文接口(真实实现归阶段三)。 */
export interface AuthContext {
  /** 派生当前主体(基线 #1:身份只来自认证上下文)。 */
  principal(): SessionPrincipal;
  /** 校验会话对主体的允许性(基线 #2:token 绑定校验替身)。 */
  assertSessionAllowed(session: { readonly sessionId: string }): void;
}

/** 阶段二替身:固定主体,恒通过(红灯路径由测试注入拒绝型替身)。 */
export const stubAuthContext: AuthContext = {
  principal: () => ({ userId: "stub-user", tenantId: "stub-tenant" }),
  assertSessionAllowed: () => undefined,
};
