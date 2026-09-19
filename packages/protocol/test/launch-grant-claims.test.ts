/**
 * LaunchGrantClaims 契约测试(分发改版 WP-90 / D-LT-5 实施细化 5a)。
 *
 * 启动授权凭证 = 换票产物(证明「该浏览器被授予 (tenant, challengeId, version)
 * 的入场权」)。本套件锁:
 *
 * - **恰六字段**:`tenantId` / `userId` / `challengeId` / `challengeVersion` /
 *   `jti` / `expiresAt`;
 * - **无 `sessionId`、无 `embedSessionId`** —— 这是「授权凭证 ≠ 会话凭证」的
 *   **结构性表达**(会话凭证在会话已建立后签发并绑定 `sessionId`;本凭证在会话
 *   尚未建立时下发),两族**各自独立**,不做 shape 复用;
 * - **解析器不从包入口导出**(server-only 子路径纪律,与 EmbedTokenClaims /
 *   SessionCredentialClaims 同机制);
 * - `$id` 归**会话动作协议族**(与 `create_session` 同族演进);
 * - golden fixture 双向(valid / invalid)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionCredentialClaimsSchema } from "../src/credential/session-credential-claims.js";
// 解析器仅经 server-only 子路径导出(浏览器对凭证不解析;导出面本身即被测纪律)。
import { LaunchGrantClaimsSchema } from "../src/server-only/index.js";
import { SESSION_ACTION_SCHEMA_BASE_ID } from "../src/version.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "launch-grant-claims");

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

describe("LaunchGrantClaims 契约(分发改版 WP-90 / D-LT-5 实施细化 5a)", () => {
  it.each(loadFixtures("valid"))("接受合法样例 $name", ({ payload }) => {
    expect(LaunchGrantClaimsSchema.safeParse(payload).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(LaunchGrantClaimsSchema.safeParse(payload).success).toBe(false);
  });

  it("恰六字段(冻结集合,不得增删)", () => {
    expect(Object.keys(LaunchGrantClaimsSchema.shape).sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "expiresAt",
      "jti",
      "tenantId",
      "userId",
    ]);
  });

  it("无 sessionId / 无 embedSessionId(授权凭证 ≠ 会话凭证的结构性表达)", () => {
    for (const absent of ["sessionId", "embedSessionId"]) {
      expect(Object.keys(LaunchGrantClaimsSchema.shape)).not.toContain(absent);
    }
    const fixture = loadFixtures("valid")[0]?.payload as Record<string, unknown>;
    for (const [field, value] of [
      ["sessionId", "s-01J9KE7EXAMPLE0002"],
      ["embedSessionId", "3xK9mQ7pL2vN8wRtY5uB1a"],
    ] as const) {
      expect(
        LaunchGrantClaimsSchema.safeParse({ ...fixture, [field]: value }).success,
      ).toBe(false);
    }
  });

  it("与会话凭证是两份独立契约:字段集不同,且形状对象不复用", () => {
    const grantFields = Object.keys(LaunchGrantClaimsSchema.shape).sort();
    const sessionFields = Object.keys(SessionCredentialClaimsSchema.shape).sort();
    expect(grantFields).not.toEqual(sessionFields);
    expect(sessionFields).toContain("sessionId");
    expect(grantFields).not.toContain("sessionId");
    // 两族不做 `.shape` 复用:形状对象是各自独立的对象(同名字段共享
    // OpaqueIdSchema **基元**是正确的单一来源,不构成"契约复用")。
    expect(LaunchGrantClaimsSchema).not.toBe(SessionCredentialClaimsSchema);
    expect(LaunchGrantClaimsSchema.shape).not.toBe(SessionCredentialClaimsSchema.shape);
  });

  it("expiresAt 为非负整数(epoch 秒)", () => {
    const fixture = loadFixtures("valid")[0]?.payload as Record<string, unknown>;
    expect(LaunchGrantClaimsSchema.safeParse({ ...fixture, expiresAt: 0 }).success).toBe(true);
    for (const illegal of [-1, 1.5, "1799000300", null]) {
      expect(LaunchGrantClaimsSchema.safeParse({ ...fixture, expiresAt: illegal }).success).toBe(
        false,
      );
    }
  });

  it("解析器不从包入口导出(浏览器对凭证不解析;server-only 导出面纪律)", async () => {
    const publicEntry = await import("../src/index.js");
    expect("LaunchGrantClaimsSchema" in publicEntry).toBe(false);
  });

  it("$id 归会话动作协议族(与 create_session 同族演进,5a 裁定)", () => {
    expect(SESSION_ACTION_SCHEMA_BASE_ID).toBe(
      "https://stackmaster.dev/schemas/session-action/v2",
    );
  });
});
