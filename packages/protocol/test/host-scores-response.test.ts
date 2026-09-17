/**
 * HostScoresResponse 契约测试(中期 M3 WP-78:宿主成绩同步只读接口,
 * D-API-122 ~ D-API-126)。
 *
 * 本套件是 WP-78 的契约级红灯语料(契约先行,契约级红灯在本包可测;路由
 * 实现期红灯——401 / 404 同形 / 400 批量上限 / 429 逐字节——归 session-api
 * 的宿主面集成测试):
 * - 字段数锁定:信封恰两键(`items` / `nextCursor`),记录恰七键
 *   (`id` / `submissionId` / `sessionId` / `challengeId` / `challengeVersion`
 *   / `verdict` / `decidedAt`)——任何私有面字段(detail / reference / 隐藏
 *   测试命中 / 内部堆栈 / verifierRunId)与任何租户回显在契约层不可表达;
 * - 游标语义:keyset 游标 = 末行 `id`(不透明标识符);终态 = `nextCursor`
 *   恒为 `null`(键恒在、值恒 null,不省略);
 * - 终态确定性(跨字段耦合双侧锁定:superRefine + JSON Schema if/then):
 *   空批 ⇒ `nextCursor` 必为 `null`(空页 + 非空游标 = 无限翻页回路);
 * - 11 值结果类型:与非成绩方向(engine_error / replay_mismatch /
 *   cancelled 等)同构呈现,零成绩语义附加字段;
 * - 版本面:独立契约族版本常量为 1 且受理集合恒含当前版本(5.6)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_SCORES_PROTOCOL_VERSION,
  HostScoreRecordSchema,
  HostScoresResponseSchema,
  SUPPORTED_HOST_SCORES_PROTOCOL_VERSIONS,
  VerdictResultSchema,
} from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "host-scores-response");

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

const RECORD = {
  id: "3f2a91c4-5b7e-4d10-8a63-0c1d2e3f4a5b",
  submissionId: "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f",
  sessionId: "sess-01J9KD5EXAMPLE003",
  challengeId: "chal-stack-escape",
  challengeVersion: "1.2.3",
  verdict: "success",
  decidedAt: 1789200000,
} as const;

describe("HostScoresResponse 契约(宿主成绩同步只读接口,中期 M3 WP-78)", () => {
  it("版本面:独立契约族版本常量为 1 且受理集合恒含当前版本(5.6 每类契约独立版本号)", () => {
    expect(HOST_SCORES_PROTOCOL_VERSION).toBe(1);
    expect(SUPPORTED_HOST_SCORES_PROTOCOL_VERSIONS).toEqual([
      HOST_SCORES_PROTOCOL_VERSION,
    ]);
  });

  it("信封字段数锁定:恰两键 items / nextCursor(私有面与租户回显无表达位)", () => {
    expect(Object.keys(HostScoresResponseSchema.shape).sort()).toEqual([
      "items",
      "nextCursor",
    ]);
  });

  it("记录字段数锁定:恰七键(公开上限面,新增字段必须同步分类与 fixture)", () => {
    expect(Object.keys(HostScoreRecordSchema.shape).sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "decidedAt",
      "id",
      "sessionId",
      "submissionId",
      "verdict",
    ]);
  });

  it("nextCursor 形态恒定:键恒存在,取值 = 不透明标识符或 null", () => {
    const empty = HostScoresResponseSchema.parse({ items: [], nextCursor: null });
    expect("nextCursor" in empty).toBe(true);
    expect(empty.nextCursor).toBeNull();
    const more = HostScoresResponseSchema.parse({
      items: [RECORD],
      nextCursor: RECORD.id,
    });
    expect(more.nextCursor).toBe(RECORD.id);
  });

  it.each(loadFixtures("valid"))("接受合法样例 $name", ({ payload }) => {
    expect(HostScoresResponseSchema.safeParse(payload).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(HostScoresResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe("终态与游标确定性(红灯语料;D-API-123)", () => {
  it("空批是合法终态:items 空 + nextCursor null 解析通过且逐字节确定", () => {
    const terminal = { items: [], nextCursor: null };
    expect(HostScoresResponseSchema.parse(terminal)).toEqual(terminal);
    expect(JSON.stringify(HostScoresResponseSchema.parse(terminal))).toBe(
      JSON.stringify(terminal),
    );
  });

  it("空批携带非空游标即拒绝(空页 + 非空游标会构成无限翻页回路)", () => {
    expect(
      HostScoresResponseSchema.safeParse({ items: [], nextCursor: RECORD.id }).success,
    ).toBe(false);
  });

  it.each([
    ["total", 128],
    ["hasMore", true],
    ["tenantId", "tenant-alpha"],
    ["generatedAt", 1789200000],
  ])("信封携带未冻结字段 %s 即拒绝(strictObject)", (field, value) => {
    expect(
      HostScoresResponseSchema.safeParse({
        items: [RECORD],
        nextCursor: null,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["detail", { failedTestIndex: 2, predicate: "FLAG == memory[0x7FFF0100]" }],
    ["hiddenTestHits", [{ testId: "hidden-canary-01", hit: true }]],
    ["reference", { form: "stackmaster-session-submit/1" }],
    ["verifierRunId", "7d8e9f0a-1b2c-4d3e-8f90-a1b2c3d4e5f6"],
    ["internalStack", "at redact (/srv/apps/session-api/dist/projection.js:42:11)"],
    ["tenantId", "tenant-alpha"],
  ])("记录携带私有面 / 租户面字段 %s 即拒绝(零 detail 零隐藏命中零租户回显)", (field, value) => {
    expect(
      HostScoresResponseSchema.safeParse({
        items: [{ ...RECORD, [field]: value }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe("11 值结果类型与批量形态(红灯语料;D1 约束 4 / D6)", () => {
  it.each(VerdictResultSchema.options)(
    "接受 11 值结果类型 %s(冻结枚举零新增零删除)",
    (verdict) => {
      const parsed = HostScoresResponseSchema.parse({
        items: [{ ...RECORD, verdict }],
        nextCursor: null,
      });
      expect(parsed.items[0]?.verdict).toBe(verdict);
    },
  );

  it("非成绩方向与成绩方向同构呈现:同键集、零成绩语义附加字段", () => {
    const score = HostScoreRecordSchema.parse({ ...RECORD, verdict: "success" });
    const nonScore = HostScoreRecordSchema.parse({ ...RECORD, verdict: "engine_error" });
    expect(Object.keys(score).sort()).toEqual(Object.keys(nonScore).sort());
  });

  it("记录间同构:同一批内不同裁决方向的记录键集恒等(批量面零方向分支)", () => {
    const parsed = HostScoresResponseSchema.parse({
      items: [
        { ...RECORD, verdict: "success" },
        { ...RECORD, id: "4e55f66a-7b88-4c99-8daa-bbccddeeff00", verdict: "cancelled" },
      ],
      nextCursor: null,
    });
    expect(Object.keys(parsed.items[0]!).sort()).toEqual(Object.keys(parsed.items[1]!).sort());
  });

  it("多记录按 id 升序承载(keyset 序即载荷序;游标取末行)", () => {
    const first = "0a11b22c-3d44-4e55-8f66-778899aabbcc";
    const second = "2c33d44e-5f66-4a77-8b88-99aabbccddee";
    const parsed = HostScoresResponseSchema.parse({
      items: [
        { ...RECORD, id: first },
        { ...RECORD, id: second },
      ],
      nextCursor: second,
    });
    expect(parsed.items.map((item) => item.id)).toEqual([first, second]);
    expect(parsed.nextCursor).toBe(parsed.items.at(-1)!.id);
  });
});
