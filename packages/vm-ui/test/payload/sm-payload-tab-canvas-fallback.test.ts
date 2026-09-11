/**
 * <sm-payload-tab> 画布不可用兜底测试(WP-F6):Blockly inject 失败(极端
 * 嵌入环境)时,画布容器保留、呈兜底文案,编译面经宿主注入的序列化状态
 * 继续工作(loadWorkspaceState / #manualState 路径)。
 */
import { describe, expect, it, vi } from "vitest";

import { SmPayloadTab } from "../../src/payload/sm-payload-tab.js";
import type { BlocklySerializedState } from "../../src/payload/compiler/types.js";

// 仅使 inject 失败:编译器的无头 Blockly 路径(Workspace / serialization)保持真实。
vi.mock("blockly", async (importOriginal) => {
  const actual = await importOriginal<typeof import("blockly")>();
  return {
    ...actual,
    inject: () => {
      throw new Error("当前环境不支持 Blockly 画布");
    },
  };
});

describe("<sm-payload-tab> 画布不可用兜底(shadow DOM 适配的容错面)", () => {
  it("inject 失败:画布宿主保留并呈兜底文案,组件不崩溃", async () => {
    const element = new SmPayloadTab();
    document.body.append(element);
    await element.updateComplete;

    expect(element.canvasUnavailable).toBe(true);
    expect(element.workspace).toBeNull();
    const host = element.querySelector("[data-payload-canvas]");
    expect(host).not.toBeNull();
    expect(host?.textContent).toContain("画布在当前环境不可用");
    expect(element.shadowRoot?.querySelector(".canvas-pane")).not.toBeNull();
    element.remove();
  });

  it("无画布且无注入状态时编译给可解释反馈(不抛错)", async () => {
    const element = new SmPayloadTab();
    document.body.append(element);
    await element.updateComplete;

    const result = element.compileNow();
    expect(result).toBeNull();
    await element.updateComplete;
    const logLines = [...(element.shadowRoot?.querySelectorAll("ol.output-log li") ?? [])];
    expect(logLines.some((line) => line.textContent?.includes("画布不可用"))).toBe(true);
    element.remove();
  });

  it("宿主注入序列化状态后编译照常工作(无画布路径)", async () => {
    const element = new SmPayloadTab();
    document.body.append(element);
    await element.updateComplete;

    const state: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: "payload_start",
            id: "start",
            next: { block: { type: "payload_breakpoint", id: "bp" } },
          },
        ],
      },
    };
    element.loadWorkspaceState(state);
    const result = element.compileNow();
    expect(result?.ok).toBe(true);
    expect(element.program?.steps.map((step) => step.kind)).toEqual(["breakpoint"]);
    element.remove();
  });
});
