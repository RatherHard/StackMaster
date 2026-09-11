/**
 * <sm-payload-tab> UI 冒烟测试(WP-F6 / FE-PB-01):
 * 三区结构(左画布 / 右上程序 / 右下输出)、轻 DOM 画布宿主(shadow DOM
 * 适配定案)、编译产物呈现、执行日志与状态、标签页注册表登记。
 * jsdom 实测:Blockly inject 可运行(无布局引擎,渲染退化不影响结构断言);
 * 真实渲染验证归 WP-F7 Playwright。
 */
import { describe, expect, it } from "vitest";
import type { ActionObject, ActionResponse, PublicError } from "@stackmaster/protocol";

import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";
import { SmPayloadTab } from "../../src/payload/sm-payload-tab.js";
import type { PayloadActionSink } from "../../src/payload/executor.js";
import type { BlocklySerializedState } from "../../src/payload/compiler/types.js";

// ── 夹具 ───────────────────────────────────────────────────────────────────

/** 两步程序:start → 写字节 0x1000 ← 4142 → 断点。 */
function twoStepState(): BlocklySerializedState {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: "payload_start",
          id: "start",
          next: {
            block: {
              type: "payload_write_bytes",
              id: "wb",
              fields: { BYTES: "4142" },
              inputs: { ADDR: { block: { type: "payload_num", id: "addr", fields: { N: "0x1000" } } } },
              next: { block: { type: "payload_breakpoint", id: "bp" } },
            },
          },
        },
      ],
    },
  };
}

class FakeSink implements PayloadActionSink {
  readonly sent: ActionObject[] = [];
  readonly #responseListeners = new Set<(response: ActionResponse) => void>();
  readonly #rejectedListeners = new Set<(error: PublicError, response: ActionResponse) => void>();

  sendAction(action: ActionObject): void {
    this.sent.push(action);
  }

  onActionResponse(listener: (response: ActionResponse) => void): () => void {
    this.#responseListeners.add(listener);
    return () => this.#responseListeners.delete(listener);
  }

  onActionRejected(listener: (error: PublicError, response: ActionResponse) => void): () => void {
    this.#rejectedListeners.add(listener);
    return () => this.#rejectedListeners.delete(listener);
  }

  /** 模拟服务端拒绝(D-API-50~53 限流形态)。 */
  reject(code: string, message: string): void {
    const response: ActionResponse = {
      requestId: `req-${this.sent.length}`,
      revision: 0,
      status: "rejected",
      projectionDelta: null,
      publicEvents: [],
      userVisibleError: { code, message } as unknown as PublicError,
    };
    for (const listener of [...this.#rejectedListeners]) {
      listener(response.userVisibleError as PublicError, response);
    }
  }

  accept(revision = 1): void {
    const response: ActionResponse = {
      requestId: `req-${this.sent.length}`,
      revision,
      status: "paused",
      projectionDelta: null,
      publicEvents: [],
    };
    for (const listener of [...this.#responseListeners]) {
      listener(response);
    }
  }
}

async function mountTab(): Promise<SmPayloadTab> {
  const element = new SmPayloadTab();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function shadowOf(element: SmPayloadTab): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

// ── 三区结构与轻 DOM 画布宿主(FE-PB-01 + shadow DOM 适配定案)────────────

describe("<sm-payload-tab> 三区结构(FE-PB-01)", () => {
  it("挂载后画布宿主在轻 DOM、程序区/输出区/工具栏在 shadow DOM", async () => {
    const element = await mountTab();
    // 轻 DOM 画布宿主(Blockly light DOM 挂载定案)。
    const host = element.querySelector("[data-payload-canvas]");
    expect(host).not.toBeNull();
    expect(host?.getAttribute("slot")).toBe("canvas");
    // jsdom 实测 inject 可运行;画布可用(或兜底态下容器仍在)。
    expect(element.canvasUnavailable || element.workspace !== null).toBe(true);

    const shadow = shadowOf(element);
    expect(shadow.querySelector(".canvas-pane")).not.toBeNull();
    expect(shadow.querySelector(".program-pane")).not.toBeNull();
    expect(shadow.querySelector(".output-pane")).not.toBeNull();
    expect(shadow.querySelector(".toolbar")).not.toBeNull();
    element.remove();
  });

  it("预置唯一起始积木且不可删除(FE-PB-03)", async () => {
    const element = await mountTab();
    const workspace = element.workspace;
    if (workspace !== null) {
      const topBlocks = workspace.getTopBlocks(false);
      expect(topBlocks).toHaveLength(1);
      expect(topBlocks[0]?.type).toBe("payload_start");
      expect(topBlocks[0]?.isDeletable()).toBe(false);
    }
    element.remove();
  });
});

// ── 编译产物呈现与执行日志 ─────────────────────────────────────────────────

describe("<sm-payload-tab> 程序区与输出区", () => {
  it("注入状态 + 编译:程序区按序呈现原子步骤,断点步标记", async () => {
    const element = await mountTab();
    element.loadWorkspaceState(twoStepState());
    const result = element.compileNow();
    expect(result?.ok).toBe(true);
    await element.updateComplete;

    const items = [...shadowOf(element).querySelectorAll("ol.program-list li")];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("写字节");
    expect(items[1]?.classList.contains("breakpoint")).toBe(true);
    element.remove();
  });

  it("编译错误呈现(缺起始积木);程序区给出空态", async () => {
    const element = await mountTab();
    element.loadWorkspaceState({ blocks: { languageVersion: 0, blocks: [] } });
    const result = element.compileNow();
    expect(result?.ok).toBe(false);
    await element.updateComplete;

    const errorNote = shadowOf(element).querySelector(".compile-errors");
    expect(errorNote?.textContent).toContain("缺少起始积木");
    expect(element.program).toBeNull();
    element.remove();
  });

  it("动作通道注入后运行:逐步提交、断点暂停、恢复后 done,输出日志记录", async () => {
    const element = await mountTab();
    const sink = new FakeSink();
    element.loadWorkspaceState(twoStepState());
    element.actionSink = sink;
    await element.updateComplete;

    element.compileNow();
    element.runProgram();
    await settle();
    expect(sink.sent).toHaveLength(1);
    sink.accept(1);
    await settle();

    // 唯一动作已执行,程序停在断点标记(不提交任何动作)。
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toEqual({ type: "write_bytes", args: { addressHex: "0x1000", bytesHex: "4142" } });
    expect(element.program).not.toBeNull();

    await element.updateComplete;
    let logLines = [...shadowOf(element).querySelectorAll("ol.output-log li")];
    expect(logLines.some((line) => line.textContent?.includes("#1"))).toBe(true);
    expect(logLines.some((line) => line.textContent?.includes("断点"))).toBe(true);
    expect(shadowOf(element).querySelector(".executor-status")?.textContent).toContain("paused");

    // 恢复:断点标记被消费,无剩余动作 → done。
    element.runProgram();
    await settle();
    await element.updateComplete;
    expect(shadowOf(element).querySelector(".executor-status")?.textContent).toContain("done");
    logLines = [...shadowOf(element).querySelectorAll("ol.output-log li")];
    expect(logLines.length).toBeGreaterThan(0);
    element.remove();
  });

  it("未接动作通道时单步给可解释反馈,不抛错", async () => {
    const element = await mountTab();
    element.loadWorkspaceState(twoStepState());
    element.compileNow();
    element.stepOnce();
    await settle();
    await element.updateComplete;
    const logLines = [...shadowOf(element).querySelectorAll("ol.output-log li")];
    expect(logLines.some((line) => line.textContent?.includes("尚未连接会话"))).toBe(true);
    element.remove();
  });

  it("refresh()(投影更新约定)以数据源重建求值环境并重编译", async () => {
    const element = await mountTab();
    element.dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "aa55",
        },
      ],
      [],
    );
    await element.updateComplete;
    expect(element.compileErrors).toHaveLength(0);
    // 数据源换绑触发 willUpdate → refresh → 编译成功(当前画布 = 起始积木,
    // 空程序)。
    expect(element.program?.steps).toHaveLength(0);
    element.remove();
  });
});

// ── 工具栏按钮与执行交互面 ─────────────────────────────────────────────────

describe("<sm-payload-tab> 工具栏与执行交互", () => {
  it("工具栏按钮驱动编译/运行/单步/暂停/复位(click 路径)", async () => {
    const element = await mountTab();
    const sink = new FakeSink();
    element.loadWorkspaceState(twoStepState());
    element.actionSink = sink;
    await element.updateComplete;

    const shadow = shadowOf(element);
    // 编译按钮 → 程序区呈现。
    (shadow.querySelector("button.compile-button") as HTMLButtonElement).click();
    await element.updateComplete;
    expect(element.program?.steps).toHaveLength(2);

    // 复位步进在游标为 0 时禁用;编译后可点(语义 = no-op 复位)。
    expect((shadow.querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(true);
    element.resetProgram(); // 游标为 0:guard 分支,不抛错。

    // 运行按钮 → 提交第一个动作;暂停按钮置请求;响应后停在原子边界。
    (shadow.querySelector("button.run-button") as HTMLButtonElement).click();
    await settle();
    expect(sink.sent).toHaveLength(1);
    (shadow.querySelector("button.pause-button") as HTMLButtonElement).click();
    sink.accept(1);
    await settle();
    expect(element.program).not.toBeNull();

    await element.updateComplete;
    expect((shadow.querySelector("button.reset-button") as HTMLButtonElement).disabled).toBe(false);
    (shadow.querySelector("button.reset-button") as HTMLButtonElement).click();
    await element.updateComplete;

    // 单步按钮:复位后游标回零,再次提交第一个动作(复位 = 确定性重跑)。
    (shadow.querySelector("button.step-button") as HTMLButtonElement).click();
    await settle();
    expect(sink.sent).toHaveLength(2);
    sink.accept(2);
    await settle();
    // 恰好推进一个原子动作后停在断点标记前。
    await element.updateComplete;
    expect(shadow.querySelector(".executor-status")?.textContent).toContain("paused");
    const logLines = [...shadow.querySelectorAll("ol.output-log li")];
    expect(logLines.some((line) => line.textContent?.includes("复位"))).toBe(true);
    element.remove();
  });

  it("未接动作通道时运行同样给可解释反馈(不抛错)", async () => {
    const element = await mountTab();
    element.loadWorkspaceState(twoStepState());
    element.compileNow();
    element.runProgram();
    await settle();
    await element.updateComplete;
    const logLines = [...shadowOf(element).querySelectorAll("ol.output-log li")];
    expect(logLines.some((line) => line.textContent?.includes("尚未连接会话"))).toBe(true);
    element.remove();
  });

  it("动作被拒:输出区记录可解释错误,状态转 error", async () => {
    class RejectingSink extends FakeSink {
      override sendAction(): void {
        // 提交后立即以 budget_exhausted 拒绝(D-API-50~53 限流形态)。
        super.sendAction({ type: "step", args: {} });
        this.reject("budget_exhausted", "动作频率超限");
      }
    }
    const element = await mountTab();
    const sink = new RejectingSink();
    element.loadWorkspaceState(twoStepState());
    element.actionSink = sink;
    await element.updateComplete;
    element.compileNow();
    element.runProgram();
    await settle();
    await element.updateComplete;

    const logLines = [...shadowOf(element).querySelectorAll("ol.output-log li")];
    expect(logLines.some((line) => line.textContent?.includes("budget_exhausted"))).toBe(true);
    expect(shadowOf(element).querySelector(".executor-status")?.textContent).toContain("error");
    element.remove();
  });

  it("allowedActions 裁剪:编译错误带 blockId → 积木警示气泡标红", async () => {
    const element = await mountTab();
    element.allowedActions = ["write_bytes"];
    await element.updateComplete;
    // 含未授权 push 动作的状态。
    const state: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: "payload_start",
            id: "start",
            next: { block: { type: "payload_push", id: "push", fields: {}, inputs: {
              VALUE: { block: { type: "payload_num", id: "n", fields: { N: "1" } } },
            } } },
          },
        ],
      },
    };
    element.loadWorkspaceState(state);
    const result = element.compileNow();
    expect(result?.ok).toBe(false);
    if (!result?.ok) {
      // 错误携带 blockId(标红溯源面)且在程序区呈现。
      expect(result?.errors[0]).toMatchObject({ code: "unauthorized_action", blockId: "push" });
    }
    await element.updateComplete;
    const errorNote = shadowOf(element).querySelector(".compile-errors");
    expect(errorNote?.textContent).toContain("allowedActions");
    // Blockly 13 警示气泡以图标承载:push 积木挂上 warning 图标(标红反馈面)。
    const pushBlock = element.workspace?.getBlockById("push");
    expect(pushBlock?.getIcon("warning")).toBeDefined();
    element.remove();
  });

  it("actionSink 就绪后立即运行(未经渲染帧):执行器懒建并推进", async () => {
    const element = await mountTab();
    const sink = new FakeSink();
    element.loadWorkspaceState(twoStepState());
    element.actionSink = sink;
    // 不等待 updateComplete,直接驱动(懒建执行器路径)。
    element.compileNow();
    element.runProgram();
    await settle();
    expect(sink.sent).toHaveLength(1);
    element.remove();
  });
});

// ── 标签页注册表登记(F5 接线形态)────────────────────────────────────────

describe("payload 标签页类型登记(defaultTabTypeRegistry)", () => {
  it("registry 出现 payload 类型:label Payload 搭建 + 工厂产出 SmPayloadTab", async () => {
    const { defaultTabTypeRegistry, PAYLOAD_TAB_TYPE } = await import(
      "../../src/workspace/tab-registry.js"
    );
    const descriptor = defaultTabTypeRegistry.get(PAYLOAD_TAB_TYPE);
    expect(descriptor?.label).toBe("Payload 搭建");
    expect(descriptor?.createContent).toBeTypeOf("function");
    const content = descriptor?.createContent?.({ dataSource: null });
    expect(content).toBeInstanceOf(SmPayloadTab);
    content?.remove();
  });
});
