/**
 * buildTimeline / summarizeActionObject 纯函数测试(FE-ED-04):
 * 动作流摘要、checkpoint 混合(create_checkpoint 去重 / 未刷新兜底)、submit
 * 合并、revision 升序与同 revision 稳定序、终态与 rejected 状态承载、seq 稠密。
 */
import { describe, expect, it } from "vitest";

import type { ActionObject, ActionResponse, CheckpointRef } from "@stackmaster/protocol";

import {
  buildTimeline,
  summarizeActionObject,
  type ActionTimelineRecord,
} from "../../src/ed/timeline.js";

/** 最小 ActionResponse(只填契约必填面;增量与事件对时间线无语义)。 */
function actionResponse(revision: number, status: ActionResponse["status"] = "running"): ActionResponse {
  return {
    requestId: "req-1",
    revision,
    status,
    projectionDelta: null,
    publicEvents: [],
    ...(status === "rejected" ? { userVisibleError: { code: "invalid_input_format" as const, message: "拒绝" } } : {}),
  };
}

function record(action: ActionObject, response: ActionResponse, at?: number): ActionTimelineRecord {
  return { action, response, ...(at === undefined ? {} : { at }) };
}

function checkpointRef(overrides: Partial<CheckpointRef>): CheckpointRef {
  return { checkpointId: "cp-1", revision: 3, ...overrides };
}

describe("summarizeActionObject 动作摘要(type + 关键参数)", () => {
  it("带参动作:地址 0x 小写、字节长度、暂停事件、标签、checkpointId", () => {
    expect(summarizeActionObject({ type: "write_bytes", args: { addressHex: "0x1000", bytesHex: "aabb" } })).toBe(
      "write_bytes 0x1000(2 字节)",
    );
    expect(summarizeActionObject({ type: "push", args: { valueHex: "0xAB" } })).toBe("push 0xAB");
    expect(summarizeActionObject({ type: "call", args: { targetHex: "0x40" } })).toBe("call 0x40");
    expect(summarizeActionObject({ type: "run_to_event", args: { pauseOn: "write" } })).toBe(
      "run_to_event(write)",
    );
    expect(summarizeActionObject({ type: "create_checkpoint", args: { label: "存档" } })).toBe(
      'create_checkpoint "存档"',
    );
    expect(summarizeActionObject({ type: "create_checkpoint", args: {} })).toBe("create_checkpoint");
    expect(summarizeActionObject({ type: "checkout_checkpoint", args: { checkpointId: "cp-9" } })).toBe(
      "checkout_checkpoint cp-9",
    );
  });

  it("无参动作:只呈现类型名", () => {
    for (const type of ["pop", "ret", "step", "pause", "undo", "reset"] as const) {
      expect(summarizeActionObject({ type, args: {} })).toBe(type);
    }
  });
});

describe("buildTimeline 动作流", () => {
  it("动作按响应流转条目:seq 稠密、revision 与 status 承载、at 透传", () => {
    const entries = buildTimeline(
      [
        record({ type: "step", args: {} }, actionResponse(1), 1000),
        record({ type: "step", args: {} }, actionResponse(2), 2000),
        record(
          { type: "write_bytes", args: { addressHex: "0x1000", bytesHex: "aa" } },
          actionResponse(3, "paused"),
          3000,
        ),
      ],
      [],
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ seq: 1, kind: "action", label: "step", revision: 1, at: 1000, status: "running" });
    expect(entries[1]).toMatchObject({ seq: 2, kind: "action", label: "step", revision: 2 });
    expect(entries[2]).toMatchObject({
      seq: 3,
      kind: "action",
      label: "write_bytes 0x1000(1 字节)",
      revision: 3,
      status: "paused",
    });
  });

  it("rejected 动作:revision 不前进也成条目,rejected 状态明示", () => {
    const entries = buildTimeline(
      [record({ type: "undo", args: {} }, actionResponse(2, "rejected"), 500)],
      [],
    );
    expect(entries).toEqual([
      { seq: 1, kind: "action", label: "undo", revision: 2, at: 500, status: "rejected" },
    ]);
  });
});

describe("buildTimeline checkpoint 混合", () => {
  it("create_checkpoint 响应与列表同 revision → 去重,只保留 checkpoint 条目(label/id)", () => {
    const entries = buildTimeline(
      [
        record({ type: "step", args: {} }, actionResponse(1)),
        record({ type: "create_checkpoint", args: { label: "存档一" } }, actionResponse(3)),
      ],
      [checkpointRef({ checkpointId: "cp-a", label: "存档一", revision: 3 })],
    );
    expect(entries).toEqual([
      { seq: 1, kind: "action", label: "step", revision: 1, status: "running" },
      { seq: 2, kind: "checkpoint", label: 'checkpoint "存档一"', revision: 3, checkpointId: "cp-a" },
    ]);
  });

  it("列表未刷新(无同 revision 条目)→ create_checkpoint 按普通动作呈现", () => {
    const entries = buildTimeline(
      [record({ type: "create_checkpoint", args: {} }, actionResponse(3))],
      [],
    );
    expect(entries).toEqual([
      { seq: 1, kind: "action", label: "create_checkpoint", revision: 3, status: "running" },
    ]);
  });

  it("无标签 checkpoint 条目以 checkpointId 呈现", () => {
    const entries = buildTimeline([], [checkpointRef({ checkpointId: "cp-b", revision: 5, label: undefined })]);
    expect(entries).toEqual([
      { seq: 1, kind: "checkpoint", label: "checkpoint(cp-b)", revision: 5, checkpointId: "cp-b" },
    ]);
  });
});

describe("buildTimeline 排序与 submit 合并", () => {
  it("乱序输入按 revision 升序重排;同 revision 按动作 → checkpoint → submit 稳定", () => {
    const entries = buildTimeline(
      [
        record({ type: "step", args: {} }, actionResponse(5)),
        record({ type: "step", args: {} }, actionResponse(1)),
      ],
      [checkpointRef({ checkpointId: "cp-x", revision: 5 })],
      [{ submissionId: "sub-1", revision: 5 }],
    );
    expect(entries.map((entry) => [entry.kind, entry.revision])).toEqual([
      ["action", 1],
      ["action", 5],
      ["checkpoint", 5],
      ["submit", 5],
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("空输入 → 空时间线", () => {
    expect(buildTimeline([], [], [])).toEqual([]);
  });
});
