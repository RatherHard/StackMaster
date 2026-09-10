/**
 * ProjectionStore 测试(WP-F2):dirtyRange 合并应用、整体替换语义、
 * revision 对齐、semanticHighlights 不被缺省增量清除(除非 sync 全量)、
 * 写时复制与订阅 API。
 */
import { describe, expect, it, vi } from "vitest";

import {
  ProjectionStore,
  type ProjectionChange,
} from "../../src/client/projection-store.js";
import type { ProjectionDelta, PublicStateProjection } from "@stackmaster/protocol";

/** 基准投影:region-stack @0x1000(窗口 8 字节)+ RSP/RBP + buffer_start 高亮。 */
function baseProjection(overrides: Partial<PublicStateProjection> = {}): PublicStateProjection {
  return {
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-stack",
        label: "stack",
        startAddressHex: "0x1000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "0102030405060708",
        truncated: false,
      },
      {
        regionId: "region-data",
        label: "data",
        startAddressHex: "0x8000",
        byteLength: 4096,
        permissions: "rw",
        bytesHex: "a1a2a3a4a5a6a7a8",
        truncated: false,
      },
    ],
    visibleRegisters: [
      { name: "RSP", valueHex: "0xB000" },
      { name: "RBP", valueHex: "0xB008" },
    ],
    callStackSummary: [],
    controlFlow: {
      currentInstruction: { addressHex: "0x0040", text: "push rbp" },
      pausedOn: null,
    },
    semanticHighlights: [
      {
        kind: "buffer_start",
        targetRegionId: "region-stack",
        startAddressHex: "0x1000",
        byteLength: 4,
        label: "buffer",
      },
    ],
    status: "paused",
    ...overrides,
  };
}

function delta(overrides: Partial<ProjectionDelta>): ProjectionDelta {
  return { revision: 1, dirtyRanges: [], changedRegisters: [], ...overrides };
}

function stackBytes(store: ProjectionStore): string {
  const snapshot = store.snapshot;
  if (snapshot === null) {
    throw new Error("无投影");
  }
  return snapshot.visibleRegions[0]?.bytesHex ?? "";
}

describe("ProjectionStore 全量替换", () => {
  it("replaceProjection 整体替换(初始投影 / sync 全量是 semanticHighlights 的来源)", () => {
    const store = new ProjectionStore();
    const changes: ProjectionChange[] = [];
    store.subscribe((change) => changes.push(change));

    store.replaceProjection(baseProjection());
    expect(store.snapshot?.revision).toBe(0);
    expect(store.revision).toBe(0);
    expect(store.snapshot?.semanticHighlights).toHaveLength(1);

    const synced = baseProjection({
      revision: 4,
      semanticHighlights: [],
    });
    store.replaceProjection(synced);
    expect(store.revision).toBe(4);
    expect(store.snapshot?.semanticHighlights).toHaveLength(0);
    expect(changes.map((change) => change.kind)).toEqual(["replace", "replace"]);
    expect(changes[1]).toMatchObject({ kind: "replace", revision: 4, delta: null });
  });

  it("无投影时 revision 与 snapshot 为 null", () => {
    const store = new ProjectionStore();
    expect(store.snapshot).toBeNull();
    expect(store.revision).toBeNull();
  });
});

describe("ProjectionStore 增量应用", () => {
  it("dirtyRange 按区域/偏移拼入锚定窗口字节,跨区域写入只触碰引用区域", () => {
    const store = new ProjectionStore();
    store.replaceProjection(baseProjection());

    const applied = store.applyDelta(
      delta({
        dirtyRanges: [
          { regionId: "region-stack", startAddressHex: "0x1002", bytesHex: "aabb" },
          { regionId: "region-data", startAddressHex: "0x8000", bytesHex: "ff" },
        ],
      }),
    );

    expect(applied).toBe(true);
    expect(stackBytes(store)).toBe("0102aabb05060708");
    const dataBytes = store.snapshot?.visibleRegions[1]?.bytesHex;
    expect(dataBytes).toBe("ffa2a3a4a5a6a7a8");
  });

  it("窗口外写入被裁剪(D3:窗口只展示区域起点前缀,不扩展窗口)", () => {
    const store = new ProjectionStore();
    store.replaceProjection(baseProjection());

    // 部分出界:窗口 8 字节,从偏移 6 写 4 字节 → 只前 2 字节生效。
    store.applyDelta(
      delta({
        dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1006", bytesHex: "aabbccdd" }],
      }),
    );
    expect(stackBytes(store)).toBe("010203040506aabb");

    // 完全出界:从窗口尾之后写 → 无可见变化。
    store.applyDelta(
      delta({
        revision: 2,
        dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1100", bytesHex: "99" }],
      }),
    );
    expect(stackBytes(store)).toBe("010203040506aabb");
    expect(store.revision).toBe(2);

    // 防御面:起点落在区域坐标之外(区域起点之前)→ 跳过,不误拼。
    store.applyDelta(
      delta({
        revision: 3,
        dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x0ff0", bytesHex: "99" }],
      }),
    );
    expect(stackBytes(store)).toBe("010203040506aabb");
  });

  it("revision 错位(超前/滞后)不应用并返回 false,不做本地推导", () => {
    const store = new ProjectionStore();
    store.replaceProjection(baseProjection());

    expect(store.applyDelta(delta({ revision: 2 }))).toBe(false);
    store.applyDelta(delta({ revision: 1 }));
    expect(store.applyDelta(delta({ revision: 1 }))).toBe(false);
    expect(store.revision).toBe(1);
  });

  it("changedRegisters 按名替换且保持投影顺序,未知寄存器防御性忽略", () => {
    const store = new ProjectionStore();
    store.replaceProjection(baseProjection());

    store.applyDelta(
      delta({
        changedRegisters: [{ name: "RBP", valueHex: "0xBFF0" }],
      }),
    );
    expect(store.snapshot?.visibleRegisters.map((register) => register.valueHex)).toEqual([
      "0xB000",
      "0xBFF0",
    ]);
  });

  it("可选字段存在即整体替换、缺省保持(I-4 存在性确定性)", () => {
    const store = new ProjectionStore();
    store.replaceProjection(baseProjection());

    // 全缺省:一切保持。
    store.applyDelta(delta({ revision: 1 }));
    const afterBare = store.snapshot;
    expect(afterBare?.controlFlow.currentInstruction.text).toBe("push rbp");
    expect(afterBare?.status).toBe("paused");
    expect(afterBare?.callStackSummary).toHaveLength(0);

    // 携带即整体替换。
    store.applyDelta(
      delta({
        revision: 2,
        controlFlow: {
          currentInstruction: { addressHex: "0x0042", text: "mov rbp, rsp" },
          pausedOn: "call",
        },
        status: "running",
        callStackSummary: [{ index: 0, functionLabel: "main", returnAddressHex: "0x0045" }],
      }),
    );
    const afterFull = store.snapshot;
    expect(afterFull?.controlFlow.currentInstruction.text).toBe("mov rbp, rsp");
    expect(afterFull?.status).toBe("running");
    expect(afterFull?.callStackSummary[0]?.functionLabel).toBe("main");
  });

  it("semanticHighlights 不被缺省增量清除;增量携带时整体替换", () => {
    const store = new ProjectionStore();
    store.replaceProjection(baseProjection());

    // 缺省:高亮保持(不被 delta 清除)。
    store.applyDelta(delta({ revision: 1 }));
    expect(store.snapshot?.semanticHighlights).toHaveLength(1);

    // 携带:整体替换(协议 I-4)。
    store.applyDelta(
      delta({
        revision: 2,
        semanticHighlights: [
          {
            kind: "canary_slot",
            targetRegionId: "region-stack",
            startAddressHex: "0x1008",
            byteLength: 8,
            label: "canary",
          },
        ],
      }),
    );
    const highlights = store.snapshot?.semanticHighlights;
    expect(highlights).toHaveLength(1);
    expect(highlights?.[0]?.kind).toBe("canary_slot");

    // sync 全量(replaceProjection)是清空的唯一路径。
    store.replaceProjection(baseProjection({ revision: 3, semanticHighlights: [] }));
    expect(store.snapshot?.semanticHighlights).toHaveLength(0);
  });

  it("写时复制:应用增量不改写已发出的快照引用", () => {
    const store = new ProjectionStore();
    const initial = baseProjection();
    store.replaceProjection(initial);

    const before = store.snapshot;
    store.applyDelta(
      delta({
        dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff" }],
      }),
    );

    expect(before?.visibleRegions[0]?.bytesHex).toBe("0102030405060708");
    expect(initial.visibleRegions[0]?.bytesHex).toBe("0102030405060708");
    expect(stackBytes(store)).toBe("ff02030405060708");
  });
});

describe("ProjectionStore revision 前进与订阅", () => {
  it("advanceRevision 前进无 delta 的已执行动作 revision;落后/相等/无投影为 no-op", () => {
    const store = new ProjectionStore();
    expect(store.advanceRevision(1)).toBe(false); // 无投影。

    store.replaceProjection(baseProjection());
    expect(store.advanceRevision(1)).toBe(true);
    expect(store.revision).toBe(1);
    expect(stackBytes(store)).toBe("0102030405060708"); // 内容不动。
    expect(store.advanceRevision(1)).toBe(false);
    expect(store.advanceRevision(0)).toBe(false);
  });

  it("subscribe 逐次分发变更,退订后不再接收", () => {
    const store = new ProjectionStore();
    const listener = vi.fn((change: ProjectionChange) => change);
    const unsubscribe = store.subscribe(listener);

    store.replaceProjection(baseProjection());
    store.applyDelta(delta({ revision: 1 }));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.applyDelta(delta({ revision: 1 }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("无投影时 applyDelta 返回 false", () => {
    const store = new ProjectionStore();
    expect(store.applyDelta(delta({ revision: 0 }))).toBe(false);
  });
});
