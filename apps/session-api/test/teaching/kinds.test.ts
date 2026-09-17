/**
 * 教学事件种类封闭集与采集可得性登记(单元测试;WP-82)。
 *
 * 断言面(三条硬纪律的机检落点):
 *  1. 教学事件种类与审计 kind **两账分离**:十值封闭集零新增、零交集
 *    (不重开 D-API-59 的账边界论证);
 *  2. v1 可采集 = 服务端可派生三值;「提示使用」登记为**暂不可采集**
 *    (原因 + 触发条件齐备,不产生占位数字);
 *  3. 客户端自报面 = 结构性空集(类型面 + 常量面双证)。
 */

import { describe, expect, it } from "vitest";
import { VerdictResultSchema } from "@stackmaster/protocol";

import { AUDIT_EVENT_KINDS } from "../../src/auth/ports.js";
import { KNOWN_ACTION_TYPES } from "../../src/metrics/metrics.js";
import {
  CLIENT_REPORTED_TEACHING_KINDS,
  COLLECTIBLE_TEACHING_EVENT_KINDS,
  PASSING_VERDICT,
  TEACHING_DERIVATION_VERSION,
  TEACHING_EVENT_COLLECTABILITY,
  TEACHING_EVENT_KINDS,
  TEACHING_EVENT_RETENTION_DAYS,
  UNDO_ACTION_TYPE,
  collectabilityOf,
  deriveTeachingEvents,
  isCollectibleTeachingEventKind,
} from "../../src/teaching/index.js";

describe("教学事件种类封闭集与两账分离", () => {
  it("语义集四值:三可采集 + 一暂不可采集,并集无重无漏", () => {
    expect([...TEACHING_EVENT_KINDS]).toEqual([
      "challenge_started",
      "passed",
      "undo",
      "hint_used",
    ]);
    expect([...COLLECTIBLE_TEACHING_EVENT_KINDS]).toEqual([
      "challenge_started",
      "passed",
      "undo",
    ]);
    // 语义集 = 可采集集 ∪ {hint_used};逐值可判定。
    for (const kind of COLLECTIBLE_TEACHING_EVENT_KINDS) {
      expect(isCollectibleTeachingEventKind(kind)).toBe(true);
    }
    expect(isCollectibleTeachingEventKind("hint_used")).toBe(false);
    expect(new Set(TEACHING_EVENT_KINDS).size).toBe(TEACHING_EVENT_KINDS.length);
  });

  it("审计 kind 仍是十值封闭集,且与教学事件种类逐值不相交(零新增审计 kind)", () => {
    expect(AUDIT_EVENT_KINDS).toHaveLength(10);
    expect(new Set(AUDIT_EVENT_KINDS).size).toBe(10);
    for (const kind of TEACHING_EVENT_KINDS) {
      expect(AUDIT_EVENT_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it("通过方向 = 冻结 11 值结果类型中的 success(零新增字面)", () => {
    expect(VerdictResultSchema.options).toContain(PASSING_VERDICT);
    expect(VerdictResultSchema.options).toHaveLength(11);
  });

  it("回退动作类型 = 12 冻结动作类型之一(指标白名单同源)", () => {
    expect(KNOWN_ACTION_TYPES.has(UNDO_ACTION_TYPE)).toBe(true);
    expect(KNOWN_ACTION_TYPES.size).toBe(12);
  });
});

describe("采集可得性登记(提示使用 = v1 暂不可采集)", () => {
  it("登记表键集恒等语义集(四值全覆盖、无重)", () => {
    expect(TEACHING_EVENT_COLLECTABILITY.map((entry) => entry.kind).sort()).toEqual(
      [...TEACHING_EVENT_KINDS].sort(),
    );
  });

  it("三值登记为可采集,且逐值给出服务端权威来源", () => {
    for (const kind of COLLECTIBLE_TEACHING_EVENT_KINDS) {
      const entry = TEACHING_EVENT_COLLECTABILITY.find((candidate) => candidate.kind === kind);
      expect(entry?.collectability).toBe("collectible");
      expect(entry?.source ?? "").not.toBe("");
      expect(collectabilityOf(kind)).toBe("collectible");
    }
  });

  it("提示使用登记为暂不可采集:零来源、原因与触发条件齐备(不伪造计数)", () => {
    const entry = TEACHING_EVENT_COLLECTABILITY.find((candidate) => candidate.kind === "hint_used");
    expect(entry?.collectability).toBe("not_collectible_v1");
    expect(entry?.reason ?? "").toContain("不得靠客户端自报");
    expect(entry?.reason ?? "").toContain("无 hint 使用记录面");
    expect(entry?.trigger ?? "").toContain("采集面扩展");
    expect(collectabilityOf("hint_used")).toBe("not_collectible_v1");
  });

  it("未知种类查表取最保守归类(不把未知当可采集)", () => {
    expect(collectabilityOf("made_up_kind" as never)).toBe("not_collectible_v1");
  });

  it("客户端自报种类集 = 空集(采集面唯一入口是服务端权威行)", () => {
    expect(CLIENT_REPORTED_TEACHING_KINDS).toHaveLength(0);
  });

  it("派生口径版本字面稳定(重放 / 复算锚)", () => {
    expect(TEACHING_DERIVATION_VERSION).toBe("teaching-derive-v1");
  });

  it("保留期默认值 = 180 天(一个教学学期 + 缓冲)", () => {
    expect(TEACHING_EVENT_RETENTION_DAYS).toBe(180);
    expect(Number.isInteger(TEACHING_EVENT_RETENTION_DAYS)).toBe(true);
    expect(TEACHING_EVENT_RETENTION_DAYS).toBeGreaterThan(0);
  });
});

describe("采集输入面结构性无自报位(编译期断言)", () => {
  it("派生入口只接受权威行集合,不接受事件载荷", () => {
    // 仅编译期断言:置于**不会调用**的闭包内(运行期零副作用)。
    const compileOnly = (): void => {
      // @ts-expect-error 采集 / 派生输入面形态 = {sessions, passedVerdicts, undos, truncated};事件数组无表达位
      deriveTeachingEvents("tenant-1", { events: [{ kind: "hint_used" }] });
    };
    expect(typeof compileOnly).toBe("function");
  });
});
