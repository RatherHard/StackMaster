/**
 * 题目登记公开契约校验测试(WP-79;`challenge-schema` 契约复用的事实依据)。
 *
 * 断言面:
 *  1. **零副本**:本模块的模式源与 `@stackmaster/challenge-schema` 的导出
 *     **逐字相同**(若上游契约演进,这里跟着变——不存在第二份题目标识规则);
 *  2. 合法登记值放行(题目标识 / 内容版本 / VM Profile 版本);
 *  3. 越界值逐条红线(大小写 / 长度 / 首尾字符 / 版本形态);
 *  4. 失败类型继承 `AdminStoreError` ⇒ 走既有 **503 冻结路径**(读面
 *     fail-closed),且错误文案只含**字段路径**、不回显越界值(注入面自伤防护)。
 */
import {
  CHALLENGE_ID_PATTERN_SOURCE,
  SEMVER_PATTERN_SOURCE,
} from "@stackmaster/challenge-schema";
import { describe, expect, it } from "vitest";

import {
  ADMIN_CHALLENGE_ID_PATTERN_SOURCE,
  ADMIN_CONTENT_VERSION_PATTERN_SOURCE,
  AdminRegistryContractViolationError,
  assertPublicRegistryEntries,
} from "../src/challenges/registry-contract.js";
import { AdminStoreError, type ChallengeRegistryEntry } from "../src/persistence/ports.js";

function entry(
  challengeId: string,
  versions: readonly { contentVersion: string; vmProfileVersion: string }[] = [
    { contentVersion: "1.0.0", vmProfileVersion: "1.0.0" },
  ],
): ChallengeRegistryEntry {
  return {
    challengeId,
    title: "IT 题目",
    versions: versions.map((version) => ({
      ...version,
      registeredAtEpochSeconds: 1_700_000_000,
    })),
  };
}

describe("公开契约复用(零副本)", () => {
  it("模式源逐字等于 challenge-schema 的导出(上游演进而非本地复制)", () => {
    expect(ADMIN_CHALLENGE_ID_PATTERN_SOURCE).toBe(CHALLENGE_ID_PATTERN_SOURCE);
    expect(ADMIN_CONTENT_VERSION_PATTERN_SOURCE).toBe(SEMVER_PATTERN_SOURCE);
  });

  it("模式源与公开契约同形(锚定 / 字符集 / 长度)", () => {
    const idPattern = new RegExp(CHALLENGE_ID_PATTERN_SOURCE);
    const versionPattern = new RegExp(SEMVER_PATTERN_SOURCE);
    for (const valid of ["chal-1", "chal-tenant-a", "a0b", "x".repeat(64)]) {
      expect(idPattern.test(valid), valid).toBe(true);
    }
    for (const invalid of ["a", "a0", "A-lower", "-lead", "trail-", "x".repeat(65), "with space"]) {
      expect(idPattern.test(invalid), invalid).toBe(false);
    }
    for (const valid of ["0.0.0", "1.2.3", "10.20.30"]) {
      expect(versionPattern.test(valid), valid).toBe(true);
    }
    for (const invalid of ["1.0", "v1.0.0", "1.0.0-rc.1", "", "01.0.0.0"]) {
      expect(versionPattern.test(invalid), invalid).toBe(false);
    }
  });
});

describe("assertPublicRegistryEntries", () => {
  it("合法条目(含空版本链)放行", () => {
    expect(() =>
      assertPublicRegistryEntries([entry("chal-1"), entry("chal-tenant-a")]),
    ).not.toThrow();
    expect(() => assertPublicRegistryEntries([])).not.toThrow();
    expect(() => assertPublicRegistryEntries([entry("chal-empty-chain", [])])).not.toThrow();
  });

  it("越界题目标识 ⇒ 抛出(逐类)", () => {
    for (const invalid of ["Chal-1", "a", "-lead-", "x".repeat(65)]) {
      expect(() => assertPublicRegistryEntries([entry(invalid)]), invalid).toThrow(
        AdminRegistryContractViolationError,
      );
    }
  });

  it("越界内容版本 / VM Profile 版本 ⇒ 抛出", () => {
    expect(() =>
      assertPublicRegistryEntries([entry("chal-1", [{ contentVersion: "1.0", vmProfileVersion: "1.0.0" }])]),
    ).toThrow(AdminRegistryContractViolationError);
    expect(() =>
      assertPublicRegistryEntries([
        entry("chal-1", [{ contentVersion: "1.0.0", vmProfileVersion: "latest" }]),
      ]),
    ).toThrow(AdminRegistryContractViolationError);
  });

  it("失败类型走既有 503 路径(继承 AdminStoreError)且文案只含字段路径", () => {
    try {
      assertPublicRegistryEntries([
        entry("chal-1", [{ contentVersion: "1.0.0", vmProfileVersion: "not-a-version" }]),
      ]);
      throw new Error("应当抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminStoreError);
      const violation = error as AdminRegistryContractViolationError;
      expect(violation.detail).toBe("entries[0].versions[0].vmProfileVersion");
      // 不回显越界值(注入面自伤防护)。
      expect(violation.message).not.toContain("not-a-version");
      expect(violation.message).toContain("entries[0].versions[0].vmProfileVersion");
    }
  });
});
