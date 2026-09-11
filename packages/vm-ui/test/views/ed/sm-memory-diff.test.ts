/**
 * <sm-memory-diff> 组件测试(FE-ED-03):前后值对照表、前值不可知明示、
 * 空变化空态、truncated 明示(ProjectionDelta 整体替换语义下组件只重算
 * 最新 delta)。
 */
import { describe, expect, it } from "vitest";

import type { ProjectionDelta, VisibleMemoryRegion } from "@stackmaster/protocol";

import { DIFF_TRUNCATED_TEXT, DIFF_UNKNOWN_BEFORE_TEXT, SmMemoryDiff } from "../../../src/views/ed/sm-memory-diff.js";

import "../../../src/views/ed/sm-memory-diff.js";
import { queryAllShadow, queryShadow } from "./helpers.js";

function beforeRegions(): VisibleMemoryRegion[] {
  return [
    {
      regionId: "region-stack",
      label: "stack",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      bytesHex: "0001020304050607",
      truncated: false,
    },
  ];
}

function delta(overrides: Partial<ProjectionDelta>): ProjectionDelta {
  return {
    revision: 1,
    dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff0102" }],
    changedRegisters: [],
    ...overrides,
  };
}

async function mounted(before: readonly VisibleMemoryRegion[] | undefined, deltaValue: ProjectionDelta | null): Promise<SmMemoryDiff> {
  const element = document.createElement("sm-memory-diff") as SmMemoryDiff;
  document.body.append(element);
  element.beforeRegions = before;
  element.delta = deltaValue;
  await element.updateComplete;
  return element;
}

describe("SmMemoryDiff 对照表(FE-ED-03)", () => {
  it("渲染 区域/地址/前值→后值 对照行(变化的字节;写回原值不进表)", async () => {
    const element = await mounted(
      beforeRegions(),
      delta({ dirtyRanges: [{ regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff0103" }] }),
    );
    const rows = queryAllShadow(element, "tbody tr");
    // byte0 00→ff、byte2 02→03 变化;byte1 写回原值 01 → 不是可观察变化。
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent?.replace(/\s+/g, " ")).toContain("0x1000");
    expect(rows[0]?.textContent?.replace(/\s+/g, " ")).toContain("00 → ff");
    expect(rows[1]?.textContent?.replace(/\s+/g, " ")).toContain("0x1002");
    expect(rows[1]?.textContent?.replace(/\s+/g, " ")).toContain("02 → 03");
    element.remove();
  });

  it("前值不可知(窗口外 / 未知区域)→ 行内明示,不伪造前值", async () => {
    const element = await mounted(
      beforeRegions(),
      delta({
        dirtyRanges: [
          { regionId: "region-stack", startAddressHex: "0x1008", bytesHex: "aa" },
          { regionId: "region-heap", startAddressHex: "0x9000", bytesHex: "bb" },
        ],
      }),
    );
    const rows = queryAllShadow(element, "tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".unknown")?.textContent?.trim()).toBe(DIFF_UNKNOWN_BEFORE_TEXT);
    expect(rows[1]?.querySelector(".unknown")?.textContent?.trim()).toBe(DIFF_UNKNOWN_BEFORE_TEXT);
    element.remove();
  });

  it("dirtyRange 带 truncated 标记 → 截断明示(sync-projection 重对齐)", async () => {
    const element = await mounted(
      beforeRegions(),
      delta({
        dirtyRanges: [
          { regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff", truncated: true },
        ],
      }),
    );
    expect(queryShadow(element, ".truncated-note")?.textContent?.trim()).toBe(DIFF_TRUNCATED_TEXT);
    element.remove();
  });

  it("无变化(delta null / 空 dirtyRanges / 全部写回原值)→ 空态", async () => {
    const nullElement = await mounted(beforeRegions(), null);
    expect(queryShadow(nullElement, "table")).toBeNull();
    expect(queryShadow(nullElement, "[role='status']")?.textContent).toContain("无可见字节变化");
    nullElement.remove();

    const emptyElement = await mounted(beforeRegions(), delta({ dirtyRanges: [] }));
    expect(queryShadow(emptyElement, "table")).toBeNull();
    emptyElement.remove();

    const sameElement = await mounted(beforeRegions(), delta({ dirtyRanges: [
      { regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "0001020304050607" },
    ] }));
    expect(queryShadow(sameElement, "[role='status']")).not.toBeNull();
    sameElement.remove();
  });

  it("before 快照缺省 → 全部前值不可知(首个动作前无先前快照)", async () => {
    const element = await mounted(undefined, delta({}));
    const rows = queryAllShadow(element, "tbody tr");
    // 无前快照 → 每个写入字节都无前值可比,全部进表并标"前值不可知"。
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector(".unknown")).not.toBeNull();
    expect(rows[2]?.querySelector(".unknown")).not.toBeNull();
    element.remove();
  });

  it("整体替换语义:替换 delta 属性即整体重算(不跨 delta 累积)", async () => {
    const element = await mounted(beforeRegions(), delta({}));
    expect(queryAllShadow(element, "tbody tr")).toHaveLength(1);
    element.delta = delta({ dirtyRanges: [
      { regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ee" },
    ] });
    await element.updateComplete;
    expect(queryAllShadow(element, "tbody tr")).toHaveLength(1);
    element.remove();
  });
});
