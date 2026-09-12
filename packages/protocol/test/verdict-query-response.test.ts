/**
 * VerdictQueryResponse 契约测试(阶段六 WP-60:裁决呈现通道,D-API-83 / D-API-86)。
 *
 * 本套件是 WP-60 的红灯语料(契约先行,契约级红灯在本包可测;路由实现期
 * 红灯——404 同形 / 401 / 429 逐字节——归 WP-63 集成测试):
 * - pending 未决形态:确定性两字段形态,携带 verdict / decidedAt / 队列位置
 *   即契约层拒绝(I-7 无进度泄露在裁决域的延伸);
 * - verdicted 形态:11 值结果类型 + decidedAt 必在,跨字段耦合双侧锁定
 *   (superRefine + JSON Schema if/then 注入);
 * - 非成绩方向(engine_error / challenge_invalid / replay_mismatch / cancelled
 *   等):是 11 值内的合法裁决字面,呈现为非成绩结果、非"未决"
 *   (裁决不可用 ≠ 判负的载荷面结构表达,D-API-84);
 * - 限流 429 冻结形态(D-API-50 / D-API-84):重询触顶呈现 = 冻结 PublicError
 *   `{code:"budget_exhausted", message:"rate limit exceeded"}`,本套件锁定
 *   该形态在冻结 PublicError 契约下的合法性与其零解释面(addressHex /
 *   explanation 禁止,能力矩阵机检)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PublicErrorSchema,
  SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS,
  VERDICT_CHANNEL_PROTOCOL_VERSION,
  VerdictResultSchema,
  VerdictQueryResponseSchema,
  VerdictQueryStatusSchema,
} from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "verdict-query-response");

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

describe("VerdictQueryResponse 契约(裁决呈现通道,阶段六 WP-60)", () => {
  it("版本面:独立契约族版本常量为 1 且受理集合恒含当前版本(5.6 每类契约独立版本号)", () => {
    expect(VERDICT_CHANNEL_PROTOCOL_VERSION).toBe(1);
    expect(SUPPORTED_VERDICT_CHANNEL_PROTOCOL_VERSIONS).toEqual([
      VERDICT_CHANNEL_PROTOCOL_VERSION,
    ]);
  });

  it("载荷上限面恰为五字段:submissionId / revision / status / verdict / decidedAt", () => {
    expect(Object.keys(VerdictQueryResponseSchema.shape).sort()).toEqual([
      "decidedAt",
      "revision",
      "status",
      "verdict",
      "submissionId",
    ].sort());
  });

  it("状态机两态封闭:pending / verdicted(无第三态)", () => {
    expect(VerdictQueryStatusSchema.options).toEqual(["pending", "verdicted"]);
  });

  it.each(loadFixtures("valid"))("接受合法样例 $name", ({ payload }) => {
    const result = VerdictQueryResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(VerdictQueryResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe("pending 未决形态(红灯语料;D-API-84)", () => {
  const PENDING_BASE = {
    submissionId: "sub-01J9KD5EXAMPLE003",
    revision: 43,
    status: "pending",
  } as const;

  it("未决期确定性形态:恰三字段,零 verdict、零 decidedAt", () => {
    const parsed = VerdictQueryResponseSchema.parse(PENDING_BASE);
    expect(parsed).toEqual(PENDING_BASE);
  });

  it("携带 verdict 即拒绝(裁决尚未产生)", () => {
    expect(
      VerdictQueryResponseSchema.safeParse({ ...PENDING_BASE, verdict: "success" })
        .success,
    ).toBe(false);
  });

  it("携带 decidedAt 即拒绝(裁决落库时刻尚未存在)", () => {
    expect(
      VerdictQueryResponseSchema.safeParse({ ...PENDING_BASE, decidedAt: 1789200000 })
        .success,
    ).toBe(false);
  });

  it.each([
    ["queuePosition", 3],
    ["estimatedWaitSeconds", 120],
    ["progress", 0.5],
  ])("携带进度类字段 %s 即拒绝(I-7 无进度泄露;strictObject)", (field, value) => {
    expect(
      VerdictQueryResponseSchema.safeParse({ ...PENDING_BASE, [field]: value }).success,
    ).toBe(false);
  });
});

describe("verdicted 形态与 11 值结果类型(红灯语料;D1 约束 4 / D6)", () => {
  it.each(VerdictResultSchema.options)(
    "verdicted 态接受 11 值结果类型 %s(含非成绩方向:冻结枚举零新增零删除)",
    (verdict) => {
      const parsed = VerdictQueryResponseSchema.parse({
        submissionId: "sub-01J9KD5EXAMPLE003",
        revision: 43,
        status: "verdicted",
        verdict,
        decidedAt: 1789200000,
      });
      expect(parsed.verdict).toBe(verdict);
    },
  );

  it.each(["success", "wrong_answer"])(
    "已裁决态不得回退为 pending(单向状态机:verdict=%s 与 status=pending 组合拒绝)",
    (verdict) => {
      expect(
        VerdictQueryResponseSchema.safeParse({
          submissionId: "sub-01J9KD5EXAMPLE003",
          revision: 43,
          status: "pending",
          verdict,
        }).success,
      ).toBe(false);
    },
  );

  it("非成绩方向与成绩方向同构呈现:都是 verdicted + 11 值字面,零成绩语义附加字段", () => {
    const score = VerdictQueryResponseSchema.parse({
      submissionId: "sub-A",
      revision: 1,
      status: "verdicted",
      verdict: "success",
      decidedAt: 1789200000,
    });
    const nonScore = VerdictQueryResponseSchema.parse({
      submissionId: "sub-B",
      revision: 1,
      status: "verdicted",
      verdict: "engine_error",
      decidedAt: 1789200000,
    });
    expect(Object.keys(score).sort()).toEqual(Object.keys(nonScore).sort());
  });
});

describe("重询限流 429 冻结形态(红灯语料;D-API-50 / D-API-84)", () => {
  const RATE_LIMIT_429_BODY = {
    code: "budget_exhausted",
    message: "rate limit exceeded",
  } as const;

  it("429 响应体在冻结 PublicError 契约下合法,且形态恰为两字段(逐字节确定性的契约前提)", () => {
    const parsed = PublicErrorSchema.parse(RATE_LIMIT_429_BODY);
    expect(parsed).toEqual(RATE_LIMIT_429_BODY);
    expect(Object.keys(parsed).sort()).toEqual(["code", "message"]);
  });

  it("budget_exhausted 零解释面:携带 addressHex 或 explanation 即被能力矩阵拒绝", () => {
    expect(
      PublicErrorSchema.safeParse({ ...RATE_LIMIT_429_BODY, addressHex: null }).success,
    ).toBe(false);
    expect(
      PublicErrorSchema.safeParse({
        ...RATE_LIMIT_429_BODY,
        explanation: { hints: ["稍后重询"] },
      }).success,
    ).toBe(false);
  });

  it("限流器状态零透出:携带计数 / 窗口锚等额外字段即拒绝(strictObject)", () => {
    expect(
      PublicErrorSchema.safeParse({ ...RATE_LIMIT_429_BODY, remaining: 0 }).success,
    ).toBe(false);
    expect(
      PublicErrorSchema.safeParse({ ...RATE_LIMIT_429_BODY, windowResetAt: 1789200060 })
        .success,
    ).toBe(false);
  });
});
