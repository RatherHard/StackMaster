/**
 * AuthContext 真实实现测试(auth-context.ts;任务分解 WP-2 第 3 条):
 * 真实实现替换 stubAuthContext 的语义差 ——stub 恒通过,真实实现按凭证绑定
 * 确定性拒绝;session-core 接口(结构镜像)不变。
 */

import { describe, expect, it } from "vitest";

import { SessionBindingError, createSessionAuthContext, type AuthContext } from "../../src/auth/index.js";
import { TEST_TENANT_ID, TEST_USER_ID } from "../helpers/auth-rig.js";

/**
 * session-core 阶段二替身的结构副本(packages/session-core/src/auth.ts 的
 * stubAuthContext;session-api 尚未声明该工作区依赖,以副本表达语义对照)。
 */
const stubReplica: AuthContext = {
  principal: () => ({ userId: "stub-user", tenantId: "stub-tenant" }),
  assertSessionAllowed: () => undefined,
};

describe("createSessionAuthContext(真实实现;session-core 接口语义)", () => {
  const claims = {
    sessionId: "sess-abc-1",
    tenantId: TEST_TENANT_ID,
    userId: TEST_USER_ID,
  };

  it("principal() 派生自凭证 claims(身份只来自认证上下文)", () => {
    const context: AuthContext = createSessionAuthContext(claims);
    expect(context.principal()).toEqual({ tenantId: TEST_TENANT_ID, userId: TEST_USER_ID });
  });

  it("assertSessionAllowed:绑定会话通过;跨会话确定性拒绝(SessionBindingError)", () => {
    const context: AuthContext = createSessionAuthContext(claims);
    expect(() => context.assertSessionAllowed({ sessionId: "sess-abc-1" })).not.toThrow();
    expect(() => context.assertSessionAllowed({ sessionId: "sess-other-2" })).toThrow(
      SessionBindingError,
    );
  });

  it("与替身语义对照:替身恒通过(阶段二替身形态),真实实现不恒通过", () => {
    expect(() => stubReplica.assertSessionAllowed({ sessionId: "anything" })).not.toThrow();
    expect(() =>
      createSessionAuthContext(claims).assertSessionAllowed({ sessionId: "anything" }),
    ).toThrow();
    expect(stubReplica.principal()).not.toEqual({
      tenantId: TEST_TENANT_ID,
      userId: TEST_USER_ID,
    });
  });
});
