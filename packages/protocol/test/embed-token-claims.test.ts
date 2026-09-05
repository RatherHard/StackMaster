/**
 * EmbedTokenClaims 契约测试(WP-5:embed token 绑定字段冻结的可测面)。
 *
 * 样例来自 test/fixtures/embed-token-claims/;非法样例覆盖:未声明字段
 * (role 提权形态,I-1)、题目版本非语义化版本、缺失 iframe 会话绑定、
 * expiresAt 非整数、jti 为空、租户 ID 字符集违规。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// 解析器仅经 server-only 子路径导出(浏览器对 token 不解析;导出面本身即被测纪律)。
import {
  CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE,
  EmbedTokenClaimsSchema,
} from "../src/server-only/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "embed-token-claims");

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

describe("EmbedTokenClaims 契约(WP-5)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = EmbedTokenClaimsSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = EmbedTokenClaimsSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("题目内容版本格式与 challenge-schema 的冻结字面量一致(X.Y.Z)", () => {
    expect(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE).toBe("^[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  it("绑定字段恰好七项:五要素 + challengeId + jti(冻结集合,不得增删)", () => {
    expect(Object.keys(EmbedTokenClaimsSchema.shape).sort()).toEqual(
      [
        "challengeId",
        "challengeVersion",
        "embedSessionId",
        "expiresAt",
        "jti",
        "tenantId",
        "userId",
      ].sort(),
    );
  });
});
