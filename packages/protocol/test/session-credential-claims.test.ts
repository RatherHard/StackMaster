/**
 * SessionCredentialClaims 契约测试(阶段三 WP-0:会话凭证绑定字段冻结的可测面;
 * WP-1 清单 §6.6,嵌入协议 §六"随即由 session-api 另行签发会话凭证"的兑现)。
 *
 * 红灯样例覆盖:未声明字段(role 提权形态,I-1)、题目版本非语义化版本、
 * 缺失会话绑定、expiresAt 非整数、jti 为空、租户 ID 字符集违规。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// 解析器仅经 server-only 子路径导出(浏览器对凭证不解析;导出面本身即被测纪律)。
import { SessionCredentialClaimsSchema } from "../src/server-only/index.js";
import { MAX_SESSION_CREDENTIAL_TTL_SECONDS } from "../src/common/limits.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "session-credential-claims");

interface FixtureCase {
  readonly name: string;
  readonly payload: unknown;
}

function loadFixtures(kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_DIR, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as unknown,
    }));
}

describe("SessionCredentialClaims 契约(阶段三 WP-0)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    expect(SessionCredentialClaimsSchema.safeParse(payload).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(SessionCredentialClaimsSchema.safeParse(payload).success).toBe(false);
  });

  it("绑定字段恰好七项:会话 + 五要素延续(租户 / 用户 / 题目身份对 / 过期)+ jti(冻结集合)", () => {
    expect(Object.keys(SessionCredentialClaimsSchema.shape).sort()).toEqual(
      [
        "challengeId",
        "challengeVersion",
        "expiresAt",
        "jti",
        "sessionId",
        "tenantId",
        "userId",
      ].sort(),
    );
  });

  it("解析器不从包入口导出(浏览器对凭证不解析;server-only 导出面纪律)", async () => {
    const publicEntry = await import("../src/index.js");
    expect("SessionCredentialClaimsSchema" in publicEntry).toBe(false);
  });

  it("TTL 上限为外圈护栏(签发 TTL 属实现期运维参数,D-API-4,必须 ≤ 本值)", () => {
    expect(MAX_SESSION_CREDENTIAL_TTL_SECONDS).toBe(86400);
  });
});
