/**
 * 启动票据令牌的生成 / 形态 / 键派生(WP-91;D-LT-2「熵 / 编码」行)。
 *
 * 本文件钉死的是**契约常量与实现参数之间的一致性** —— 这类"两处各写一个数"
 * 的漂移正是本仓库反复踩过的缺陷族:契约说 22 字符、实现按 17 字节取熵
 * (→23 字符)也"看起来没问题",直到有人按 22 去切字符串。故这里既有
 * **正向断言**(生成物恰好 22),也有**结构性断言**(熵字节数 × 8 ≥ 128 且
 * 编码长度 = 契约常量)。
 */

import { describe, expect, it } from "vitest";
import { LAUNCH_TICKET_TOKEN_LENGTH } from "@stackmaster/protocol";
import {
  LAUNCH_TICKET_ENTROPY_BYTES,
  LAUNCH_TICKET_KEY_PREFIX,
  LAUNCH_TICKET_TOKEN_MAX_LENGTH,
  generateLaunchTicketToken,
  isLaunchTicketTokenShape,
  launchTicketKey,
} from "../../src/launch/ticket-token.js";

describe("启动票据令牌生成(D-LT-2:≥128 bit CSPRNG,base64url 22 字符)", () => {
  it("生成物长度**恰好**等于契约常量 LAUNCH_TICKET_TOKEN_LENGTH(不是「≤」也不是「近似」)", () => {
    // 多次采样:长度是确定性不变量,不随熵取值漂移。
    for (let i = 0; i < 200; i += 1) {
      expect(generateLaunchTicketToken()).toHaveLength(LAUNCH_TICKET_TOKEN_LENGTH);
    }
    expect(LAUNCH_TICKET_TOKEN_LENGTH).toBe(22);
  });

  it("熵下限是**结构性**满足的:熵字节数 × 8 ≥ 128,且编码长度与契约常量逐字相等", () => {
    // 两条断言合起来才是完整推导:只断言"≥128 bit"会放过 17 字节(23 字符)
    // 这种"熵够但长度漂移"的形态;只断言长度会放过 11 字节(15 字符,88 bit)。
    expect(LAUNCH_TICKET_ENTROPY_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(Math.ceil((4 * LAUNCH_TICKET_ENTROPY_BYTES) / 3)).toBe(LAUNCH_TICKET_TOKEN_LENGTH);
  });

  it("输出为 base64url 字符集且**无填充**(`=` 不出现)", () => {
    for (let i = 0; i < 200; i += 1) {
      const token = generateLaunchTicketToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token).not.toContain("=");
      // 标准 base64 的 `+` / `/` 不得出现(否则 URL 承载会歧义)。
      expect(token).not.toContain("+");
      expect(token).not.toContain("/");
    }
  });

  it("每次调用独立取熵:大批量采样子串零重复(不引入可复现 seed)", () => {
    const seen = new Set<string>();
    const sampleSize = 2000;
    for (let i = 0; i < sampleSize; i += 1) {
      seen.add(generateLaunchTicketToken());
    }
    // 128 bit 空间下 2000 次采样碰撞概率 ≈ 2000²/2^129 ≈ 0 ⇒ 零重复是硬期望。
    expect(seen.size).toBe(sampleSize);
  });
});

describe("入站令牌形态校验(D-LT-2:消费面粗筛,不触碰存储)", () => {
  it("接受真实生成物", () => {
    expect(isLaunchTicketTokenShape(generateLaunchTicketToken())).toBe(true);
  });

  it("拒绝非字符串 / 空串 / 超粗闸上限 / 非 base64url 字符", () => {
    expect(isLaunchTicketTokenShape(undefined)).toBe(false);
    expect(isLaunchTicketTokenShape(null)).toBe(false);
    expect(isLaunchTicketTokenShape(12345)).toBe(false);
    expect(isLaunchTicketTokenShape("")).toBe(false);
    expect(isLaunchTicketTokenShape("a".repeat(LAUNCH_TICKET_TOKEN_MAX_LENGTH + 1))).toBe(false);
    // 键分隔符 / 空白 / 百分号编码 / SQL-ish 注入形态——都不是我们签发的字符集。
    expect(isLaunchTicketTokenShape("abc:def")).toBe(false);
    expect(isLaunchTicketTokenShape("abc def")).toBe(false);
    expect(isLaunchTicketTokenShape("abc%3Adef")).toBe(false);
    expect(isLaunchTicketTokenShape("abc.def")).toBe(false);
    expect(isLaunchTicketTokenShape("abc=def")).toBe(false);
  });

  it("粗闸上限本身是**形态闸**而非「合法长度」:长度 ≠ 22 的一律不由生成器产出", () => {
    // 22 字符(生成面不变量)通过;上限边界值也通过形态闸(形态闸只管
    // "像不像","签发过没有"由原子消费面回答 ⇒ 不在此处制造第二个裁决点)。
    expect(isLaunchTicketTokenShape("a".repeat(22))).toBe(true);
    expect(isLaunchTicketTokenShape("a".repeat(LAUNCH_TICKET_TOKEN_MAX_LENGTH))).toBe(true);
  });
});

describe("键派生(launch:{jti})", () => {
  it("前缀为 launch: 且令牌分量原样保留(base64url 字符集下编码恒等)", () => {
    const token = generateLaunchTicketToken();
    const key = launchTicketKey(token);
    expect(key).toBe(`${LAUNCH_TICKET_KEY_PREFIX}${token}`);
    expect(LAUNCH_TICKET_KEY_PREFIX).toBe("launch:");
  });

  it("键分隔符注入被 encodeURIComponent 折叠(即使入参含 `:`)", () => {
    // 防御性:形态闸拒了它,但键派生本身也不得让它跨越键域。
    expect(launchTicketKey("a:b")).toBe("launch:a%3Ab");
  });
});
