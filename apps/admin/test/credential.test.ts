/**
 * 管理面凭证测试(D-MP-5 分支 A;独立凭证硬约束,D-API-134)。
 *
 * 两组断言:
 *  1. 行为面:缺失 / 畸形 / 空值 / 错误值全拒,正确值放行;跨长度错误值
 *     与同长度错误值同样失败(摘要比较,长度侧信道零透出);
 *  2. 结构面(源码机检):`apps/admin/src/**` 的**代码文本**(注释已剥离)
 *     里不出现 `SESSION_API_` / `VERIFIER_` 前缀的环境读取,也不出现会话
 *     凭证 / 宿主令牌键名——凭证独立性不是约定,是机检事实。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AdminCredentialVerifier } from "../src/auth/credential.js";
import { FOREIGN_CREDENTIALS, TEST_CREDENTIAL } from "./helpers/rig.js";
import { findInAdminCode } from "./helpers/source-scan.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("AdminCredentialVerifier(摘要比对)", () => {
  const verifier = new AdminCredentialVerifier(sha256(TEST_CREDENTIAL));

  it("缺失 / 非 Bearer / 空凭证 → 拒绝", () => {
    expect(verifier.verify(undefined)).toBe(false);
    expect(verifier.verify(null)).toBe(false);
    expect(verifier.verify(123)).toBe(false);
    expect(verifier.verify(TEST_CREDENTIAL)).toBe(false);
    expect(verifier.verify(`Basic ${TEST_CREDENTIAL}`)).toBe(false);
    expect(verifier.verify("Bearer ")).toBe(false);
  });

  it("错误凭证(同长度 / 跨长度)一律拒绝;正确凭证放行", () => {
    const wrongSameLength = `X${TEST_CREDENTIAL.slice(1)}`;
    expect(verifier.verify(`Bearer ${wrongSameLength}`)).toBe(false);
    expect(verifier.verify("Bearer x")).toBe(false);
    expect(verifier.verify(`Bearer ${TEST_CREDENTIAL}`)).toBe(true);
  });

  it("会话凭证 / 宿主后端令牌 / verifier 凭证样本一律拒绝(零交集)", () => {
    for (const foreign of FOREIGN_CREDENTIALS) {
      expect(verifier.verify(`Bearer ${foreign}`)).toBe(false);
    }
  });
});

describe("凭证独立性(源码机检)", () => {
  it("管理面源码不读取任何非 ADMIN_ 前缀的环境变量", async () => {
    const hits = await findInAdminCode(/(process\.env|env)\s*(\[|\.)\s*["']?(SESSION_API_|VERIFIER_)/);
    expect(hits).toEqual([]);
  });

  it("管理面源码不引用宿主后端令牌 / 会话凭证键名", async () => {
    const hits = await findInAdminCode(/HOST_BACKEND_TOKEN|SIGNING_KEY|SESSION_CREDENTIAL/);
    expect(hits).toEqual([]);
  });
});
