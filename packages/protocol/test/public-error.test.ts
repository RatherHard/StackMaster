/**
 * PublicError 契约测试(WP-3;错误格式 WP-1 §4.4 v1.2 冻结)。
 *
 * 重点断言:16 个 code 覆盖计划书 §4.4 九类;ERROR_CODE_CAPABILITIES 逐 code
 * 能力矩阵(addressHex 四种模式 + 解释字段白名单);E-4(objective_not_met
 * 恒为零解释字段)、I-9(inaccessible_address 只允许 null 占位)、
 * protocol 级拒绝类 code 不带地址与解释字段。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERROR_MESSAGE_MAX_LENGTH,
  MAX_ERROR_HINTS,
  PUBLIC_ERROR_CODES,
  PublicErrorSchema,
} from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "public-error");

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

function coarseError(): Record<string, unknown> {
  return { code: "invalid_input_format", message: "动作格式无法解析" };
}

describe("PublicError 契约(WP-3)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = PublicErrorSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = PublicErrorSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("code 枚举覆盖计划书 §4.4 的九类错误形态(16 个 code)", () => {
    expect(PUBLIC_ERROR_CODES).toHaveLength(16);
    // 计划书 §4.4 九类:输入格式、payload 长度、地址偏移越界、端序不符、
    // 权限不足、rip 非法、金丝雀破坏、调用参数非法、目标未达成 —— 由
    // 前 9 个教学动作类 code 覆盖;其余为协议级拒绝与内部错误。
    expect([
      "invalid_input_format",
      "invalid_payload_length",
      "offset_out_of_range",
      "endianness_mismatch",
      "permission_denied",
      "invalid_rip",
      "canary_violation",
      "invalid_call_argument",
      "objective_not_met",
      "inaccessible_address",
      "budget_exhausted",
      "stale_base_revision",
      "stale_client_seq",
      "idempotency_conflict",
      "session_terminal",
      "internal_error",
    ]).toEqual([...PUBLIC_ERROR_CODES]);
  });

  it("coarse 级最小错误合法:仅 code + message,无地址无解释", () => {
    const result = PublicErrorSchema.safeParse(coarseError());
    expect(result.success).toBe(true);
  });

  it("unknown code 拒绝(契约外字符串不进入浏览器)", () => {
    const result = PublicErrorSchema.safeParse({ code: "flag_leaked", message: "x" });
    expect(result.success).toBe(false);
  });

  it.each([
    "permission_denied",
    "canary_violation",
  ] as const)("教学类 code %s 的 addressHex 必须为真实地址(required-real)", (code) => {
    const without = PublicErrorSchema.safeParse({ code, message: "x" });
    expect(without.success).toBe(false);
    const nullAddress = PublicErrorSchema.safeParse({ code, message: "x", addressHex: null });
    expect(nullAddress.success).toBe(false);
    const real = PublicErrorSchema.safeParse({
      code,
      message: "x",
      addressHex: "0x7FFF00F8",
    });
    expect(real.success).toBe(true);
  });

  it("inaccessible_address 的 addressHex 只允许 null 占位(I-9:隐藏映射 ≡ 未映射)", () => {
    const result = PublicErrorSchema.safeParse({
      code: "inaccessible_address",
      message: "地址不可访问",
      addressHex: null,
    });
    expect(result.success).toBe(true);
    const real = PublicErrorSchema.safeParse({
      code: "inaccessible_address",
      message: "地址不可访问",
      addressHex: "0x7FFE1234",
    });
    expect(real.success).toBe(false);
    const absent = PublicErrorSchema.safeParse({
      code: "inaccessible_address",
      message: "地址不可访问",
    });
    expect(absent.success).toBe(false);
  });

  it("objective_not_met 恒为零解释字段(E-4:不泄露目标匹配进度)", () => {
    const result = PublicErrorSchema.safeParse({
      code: "objective_not_met",
      message: "目标尚未达成",
      explanation: { hints: ["继续观察返回地址附近的内存"] },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "budget_exhausted",
    "stale_base_revision",
    "stale_client_seq",
    "idempotency_conflict",
    "session_terminal",
    "internal_error",
  ] as const)("协议级 code %s 不允许地址与任何解释字段", (code) => {
    const result = PublicErrorSchema.safeParse({
      code,
      message: "x",
      explanation: { hints: ["hint"] },
    });
    expect(result.success).toBe(false);
    const withAddress = PublicErrorSchema.safeParse({
      code,
      message: "x",
      addressHex: "0x1000",
    });
    expect(withAddress.success).toBe(false);
  });

  it("解释字段超出该 code 白名单即拒绝(逐 code 能力矩阵)", () => {
    // invalid_input_format 只允许 hints;valueHex 不在白名单。
    const result = PublicErrorSchema.safeParse({
      code: "invalid_input_format",
      message: "x",
      explanation: { valueHex: "0x41" },
    });
    expect(result.success).toBe(false);
  });

  it(`hints 数量受上限(${MAX_ERROR_HINTS})约束,单条文本受展示文本上限约束`, () => {
    const hints = Array.from({ length: MAX_ERROR_HINTS }, (_, i) => `提示 ${i}`);
    const ok = PublicErrorSchema.safeParse({
      code: "invalid_input_format",
      message: "x",
      explanation: { hints },
    });
    expect(ok.success).toBe(true);
    const over = PublicErrorSchema.safeParse({
      code: "invalid_input_format",
      message: "x",
      explanation: { hints: [...hints, "再多一条"] },
    });
    expect(over.success).toBe(false);
    const tooLong = PublicErrorSchema.safeParse({
      code: "invalid_input_format",
      message: "x",
      explanation: { hints: ["h".repeat(257)] },
    });
    expect(tooLong.success).toBe(false);
  });

  it(`message 超过展示上限(${ERROR_MESSAGE_MAX_LENGTH})拒绝,不留解释旁路`, () => {
    const result = PublicErrorSchema.safeParse({
      code: "invalid_input_format",
      message: "E".repeat(ERROR_MESSAGE_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("alignmentBytes 只接受 1/2/4/8 字面量(对齐粒度不泄露更大信息)", () => {
    const build = (alignmentBytes: unknown): unknown => ({
      code: "invalid_rip",
      message: "x",
      addressHex: "0x401000",
      explanation: { alignmentBytes },
    });
    expect(PublicErrorSchema.safeParse(build(8)).success).toBe(true);
    expect(PublicErrorSchema.safeParse(build(3)).success).toBe(false);
    expect(PublicErrorSchema.safeParse(build(16)).success).toBe(false);
  });

  it("coarse 与 educational 共用同一 Schema:粒度差异只在服务端策略,不在契约形态", () => {
    // errorDetailLevel 属于 ProjectionPolicy(服务端策略),不进入 PublicError
    // 契约 —— 两种粒度产出的都是同一条 PublicError,靠字段取舍表达粗细。
    const coarse = PublicErrorSchema.safeParse({
      code: "permission_denied",
      message: "x",
      addressHex: "0x1000",
    });
    const educational = PublicErrorSchema.safeParse({
      code: "permission_denied",
      message: "x",
      addressHex: "0x1000",
      explanation: { regionId: "stack-main", permissions: "rw", hints: ["栈不可执行"] },
    });
    expect(coarse.success).toBe(true);
    expect(educational.success).toBe(true);
  });
});
