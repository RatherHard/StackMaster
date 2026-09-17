/**
 * 调试克隆「对齐源」解析单测(中期 M3 遗留移交清单第 6 项;D-API-145)。
 *
 * 本文件固定 `src/sessions/debug-alignment.ts` 的**精确对齐语义**(纯函数,
 * 零 IO / 零时钟 / 零随机):
 *  - 在途账本(未提交会话)是首要对齐源 ⇒ 未提交会话不再退化为种子态;
 *  - 已落库日志只补**在途账本基线之前**的前缀(重启恢复);
 *  - 缺口 / 超出权威 revision / 基线高于已落库前缀 ⇒ `aligned = false`
 *    (调用方以确定性失败呈现,**禁止静默降级**到缺口前的态或种子态);
 *  - 同一输入逐字节同一输出(确定性可断言)。
 *
 * 真机侧的行为证据(真实 vm-worker 二进制,M2 期证据形态)在
 * `debug-clone-alignment.integration.test.ts`;通道侧在
 * `debug-clone-alignment.test.ts`。
 */
import { describe, expect, it } from "vitest";

import {
  inFlightLedgerBase,
  resolveDebugAlignment,
  type DebugAlignmentEntry,
} from "../../src/sessions/debug-alignment.js";

/** 权威动作日志条目(仅已接受动作;action 值对本模块无语义,只做搬运)。 */
function entry(revisionAfter: number): DebugAlignmentEntry {
  return { clientSeq: revisionAfter, revisionAfter, action: { type: "step", args: {} } };
}

function entries(...revisions: number[]): DebugAlignmentEntry[] {
  return revisions.map(entry);
}

describe("对齐源解析:在途账本优先(未提交会话不再退化为种子态)", () => {
  it("未提交会话(已落库 0 条)按在途账本精确对齐 —— 旧对齐源的缺陷面", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 2,
      inFlight: entries(1, 2),
      inFlightBase: 0,
      persisted: [],
    });
    expect(resolution.aligned).toBe(true);
    expect(resolution.availableMax).toBe(2);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1, 2]);
  });

  it("在途账本覆盖已落库区间:已落库条目零重复计入(前缀窗口为空)", () => {
    const inFlight = entries(1, 2, 3);
    const resolution = resolveDebugAlignment({
      targetRevision: 3,
      inFlight,
      inFlightBase: 0,
      persisted: entries(1, 2),
    });
    expect(resolution.aligned).toBe(true);
    expect(resolution.entries).toHaveLength(3);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1, 2, 3]);
    // 条目身份取自**在途**账本(前缀窗口按 revisionAfter ≤ 基线过滤,基线 0 无前缀)。
    expect(resolution.entries[0]).toBe(inFlight[0]);
  });

  it("target 精确截断:只重放到请求的 revision,不多不少", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 1,
      inFlight: entries(1, 2, 3),
      inFlightBase: 0,
      persisted: [],
    });
    expect(resolution.aligned).toBe(true);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1]);
    expect(resolution.availableMax).toBe(3); // 覆盖上界如实登记(= 会话权威 revision)
  });

  it("target = 0(种子态起点):空重放序且判定为可精确对齐", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 0,
      inFlight: [],
      inFlightBase: 0,
      persisted: [],
    });
    expect(resolution).toEqual({ entries: [], availableMax: 0, aligned: true });
  });
});

describe("对齐源解析:重启恢复的在途基线(已落库前缀补齐)", () => {
  it("恢复会话(在途账本空、基线 = 快照 revision)用已落库前缀精确对齐", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 3,
      inFlight: [],
      inFlightBase: 3,
      persisted: entries(1, 2, 3),
    });
    expect(resolution.aligned).toBe(true);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1, 2, 3]);
  });

  it("恢复会话 + 在途续段:前缀与在途段拼接连续", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 3,
      inFlight: entries(2, 3),
      inFlightBase: 1,
      persisted: entries(1),
    });
    expect(resolution.aligned).toBe(true);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1, 2, 3]);
  });

  it("基线之前的已落库缺口 ⇒ 该 revision 在途不可得(不静默降级)", () => {
    // 恢复基线 3,但已落库只覆盖到 2(缺 3):revision 3 的状态只存在于快照里
    // (快照禁止入调试进程,ADR-DC1 条款 3)⇒ 只有 ≤ 2 可精确对齐。
    const unavailable = resolveDebugAlignment({
      targetRevision: 3,
      inFlight: [],
      inFlightBase: 3,
      persisted: entries(1, 2),
    });
    expect(unavailable.aligned).toBe(false);
    expect(unavailable.availableMax).toBe(2);
    expect(unavailable.entries.map((item) => item.revisionAfter)).toEqual([1, 2]);

    const reachable = resolveDebugAlignment({
      targetRevision: 2,
      inFlight: [],
      inFlightBase: 3,
      persisted: entries(1, 2),
    });
    expect(reachable.aligned).toBe(true);
    expect(reachable.entries.map((item) => item.revisionAfter)).toEqual([1, 2]);
  });

  it("已落库条目超出在途基线(基线下移)被丢弃:不把未来态混入克隆", () => {
    // 恢复基线 3 而已落库含 1..5(恢复点之后的 submit 已落库):3 之后的条目
    // 不属于恢复态的权威序,必须丢弃(否则会重放出超出克隆基线的动作)。
    const resolution = resolveDebugAlignment({
      targetRevision: 4,
      inFlight: [],
      inFlightBase: 3,
      persisted: entries(1, 2, 3, 4, 5),
    });
    expect(resolution.aligned).toBe(false);
    expect(resolution.availableMax).toBe(3);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1, 2, 3]);
  });

  it("缺口之后不静默续接:日志中段断链 ⇒ 断点之后一律不可得", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 3,
      inFlight: entries(1, 3),
      inFlightBase: 0,
      persisted: [],
    });
    expect(resolution.aligned).toBe(false);
    expect(resolution.availableMax).toBe(1);
    expect(resolution.entries.map((item) => item.revisionAfter)).toEqual([1]);
  });

  it("首条不是 revision 1(序列前置缺失)⇒ 仅种子态可达", () => {
    const resolution = resolveDebugAlignment({
      targetRevision: 1,
      inFlight: [],
      inFlightBase: 2,
      persisted: entries(2),
    });
    expect(resolution.aligned).toBe(false);
    expect(resolution.availableMax).toBe(0);
    expect(resolution.entries).toEqual([]);
  });
});

describe("对齐源解析:在途账本基线口径与确定性", () => {
  it("inFlightLedgerBase:空账本 = 当前权威 revision(恢复态);非空 = 首条前一 revision", () => {
    expect(inFlightLedgerBase(0, [])).toBe(0);
    expect(inFlightLedgerBase(5, [])).toBe(5);
    expect(inFlightLedgerBase(5, entries(4, 5))).toBe(3);
    expect(inFlightLedgerBase(5, entries(1))).toBe(0);
  });

  it("确定性:同一输入两次解析结果逐字节一致(同一 revision 重复 attach 的前提)", () => {
    const input = {
      targetRevision: 2,
      inFlight: entries(1, 2, 3),
      inFlightBase: 0,
      persisted: entries(1),
    } as const;
    const first = resolveDebugAlignment(input);
    const second = resolveDebugAlignment(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("解析不修改输入(对齐源快照冻结)", () => {
    const inFlight = entries(1, 2);
    const persisted = entries(1);
    resolveDebugAlignment({ targetRevision: 2, inFlight, inFlightBase: 0, persisted });
    expect(inFlight.map((item) => item.revisionAfter)).toEqual([1, 2]);
    expect(persisted.map((item) => item.revisionAfter)).toEqual([1]);
  });
});
