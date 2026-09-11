/**
 * <sm-timeline> 组件测试(FE-ED-04):条目渲染(seq/kind 徽标/摘要/revision/
 * 状态/时刻)、当前 revision 指示、空态。
 */
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../../src/ed/timeline.js";

import { SmTimeline } from "../../../src/views/ed/sm-timeline.js";

import "../../../src/views/ed/sm-timeline.js";
import { queryAllShadow, queryShadow } from "./helpers.js";

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return { seq: 1, kind: "action", label: "step", revision: 1, ...overrides };
}

async function mounted(
  entries: readonly TimelineEntry[],
  currentRevision: number | null = null,
): Promise<SmTimeline> {
  const element = document.createElement("sm-timeline") as SmTimeline;
  document.body.append(element);
  element.entries = entries;
  element.currentRevision = currentRevision;
  await element.updateComplete;
  return element;
}

describe("SmTimeline 条目渲染(FE-ED-04)", () => {
  it("渲染 kind 徽标 / 摘要 / revision / 状态徽标 / 有序列表语义", async () => {
    const element = await mounted([
      entry({ seq: 1, kind: "action", label: "step", revision: 1, status: "running" }),
      entry({ seq: 2, kind: "checkpoint", label: 'checkpoint "存档"', revision: 2, checkpointId: "cp-a" }),
      entry({ seq: 3, kind: "action", label: "undo", revision: 3, status: "rejected" }),
      entry({ seq: 4, kind: "submit", label: "submit(sub-1)", revision: 4, submissionId: "sub-1" }),
    ]);
    const items = queryAllShadow(element, "ol li");
    expect(items).toHaveLength(4);
    const first = items[0]!;
    expect(first.querySelector(".kind-badge")?.textContent?.trim()).toBe("动作");
    expect(first.querySelector(".label")?.textContent?.trim()).toBe("step");
    expect(first.querySelector(".meta")?.textContent).toContain("r1");
    expect(first.querySelector(".status-badge")?.textContent?.trim()).toBe("running");
    expect(items[1]!.querySelector(".kind-badge")?.textContent?.trim()).toBe("checkpoint");
    expect(items[2]!.querySelector(".status-badge")?.textContent?.trim()).toBe("rejected");
    expect(items[3]!.querySelector(".kind-badge")?.textContent?.trim()).toBe("提交");
    element.remove();
  });

  it("at 时刻以文本承载(宿主未提供则不渲染)", async () => {
    const withAt = await mounted([entry({ at: Date.UTC(2026, 0, 1, 12, 30, 10) })]);
    const meta = queryShadow(withAt, "li .meta")?.textContent ?? "";
    expect(meta).toContain("·");
    withAt.remove();

    const withoutAt = await mounted([entry({})]);
    expect(queryShadow(withoutAt, "li .meta")?.textContent).not.toContain("·");
    withoutAt.remove();
  });

  it("currentRevision 命中条目标注'当前 revision';未命中不标注", async () => {
    const element = await mounted([entry({ revision: 1 }), entry({ seq: 2, revision: 2 })], 2);
    const items = queryAllShadow(element, "ol li");
    expect(items[0]?.querySelector(".current-badge")).toBeNull();
    expect(items[1]?.querySelector(".current-badge")?.textContent?.trim()).toBe("当前 revision");
    element.remove();

    const nullElement = await mounted([entry({})], null);
    expect(queryShadow(nullElement, ".current-badge")).toBeNull();
    nullElement.remove();
  });

  it("空条目 → 空态说明", async () => {
    const element = await mounted([]);
    expect(queryShadow(element, "ol")).toBeNull();
    expect(queryShadow(element, "[role='status']")?.textContent).toContain("暂无历史记录");
    element.remove();
  });
});
