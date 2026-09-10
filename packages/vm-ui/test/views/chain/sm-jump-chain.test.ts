/**
 * <sm-jump-chain> 组件测试(WP-F4 / FE-ST-07/09/10 窗口内部分):
 * 横向 ≤3 段渲染、循环回环箭头、超限展开/收起(竖向)、链上点击 → 视角跳转
 * 事件(窗口内 / 窗口外)、链末可见字符延伸、空 / 非法输入静默。
 */
import { describe, expect, it } from "vitest";

import { ProjectionStore } from "../../../src/client/projection-store.js";
import { ProjectionDataSource } from "../../../src/datasource/projection-data-source.js";
import type { MemoryDataSource } from "../../../src/datasource/types.js";
import type { PublicStateProjection } from "@stackmaster/protocol";
import type { ViewportJumpDetail } from "../../../src/views/chain/sm-jump-chain.js";
import { SmJumpChain } from "../../../src/views/chain/sm-jump-chain.js";
import "../../../src/views/chain/sm-jump-chain.js";

/** 字节偏移 → 值的小端字节序列(低字节在前,超出值宽度补 00)。 */
function littleEndianHex(value: number, byteLength = 8): string {
  let out = "";
  let remaining = value;
  for (let index = 0; index < byteLength; index += 1) {
    out += (remaining & 0xff).toString(16).padStart(2, "0");
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/** 稀疏字节布局 → 区域窗口 bytesHex(未指定偏移补 00)。 */
function windowHexFrom(spans: Array<[offset: number, hex: string]>, windowBytes: number): string {
  const bytes = new Uint8Array(windowBytes);
  for (const [offset, hex] of spans) {
    for (let index = 0; index < hex.length / 2; index += 1) {
      bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dataSourceWith(region: {
  byteLength: number;
  bytesHex: string;
}): MemoryDataSource {
  const projection: PublicStateProjection = {
    revision: 0,
    visibleRegions: [
      {
        regionId: "region-chain",
        label: "chain",
        startAddressHex: "0x1000",
        byteLength: region.byteLength,
        permissions: "rw",
        bytesHex: region.bytesHex,
        truncated: region.bytesHex.length / 2 < region.byteLength,
      },
    ],
    visibleRegisters: [],
    callStackSummary: [],
    controlFlow: {
      currentInstruction: { addressHex: "0x0040", text: "push rbp" },
      pausedOn: null,
    },
    semanticHighlights: [],
    status: "paused",
  };
  const store = new ProjectionStore();
  store.replaceProjection(projection);
  return new ProjectionDataSource(store);
}

async function mountedElement(
  startAddressHex: string,
  dataSource: MemoryDataSource | null,
): Promise<SmJumpChain> {
  const element = document.createElement("sm-jump-chain") as SmJumpChain;
  document.body.append(element);
  element.startAddressHex = startAddressHex;
  element.dataSource = dataSource;
  await element.updateComplete;
  return element;
}

function chips(element: SmJumpChain): HTMLButtonElement[] {
  return Array.from(
    element.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.chain-address") ?? [],
  );
}

describe("SmJumpChain 横向渲染(FE-ST-07 默认 ≤3 段)", () => {
  it("横向渲染链段地址芯片,段间箭头连接", async () => {
    const dataSource = dataSourceWith({
      byteLength: 4096,
      bytesHex: windowHexFrom(
        [
          [0, littleEndianHex(0x1008)],
          [8, littleEndianHex(0x9999)],
        ],
        16,
      ),
    });
    const element = await mountedElement("0x1000", dataSource);

    const rendered = chips(element).map((chip) => chip.textContent?.trim());
    expect(rendered).toEqual(["0x1000", "0x1008"]); // 末段值 0x9999 落空 → 终止,无尾随目标
    expect(element.shadowRoot?.querySelectorAll(".chain-arrow").length).toBe(1);

    element.remove();
  });

  it("无数据源 / 空起始地址 / 非法地址 → 静默空渲染(不抛错)", async () => {
    const dataSource = dataSourceWith({
      byteLength: 16,
      bytesHex: "0000000000000000",
    });

    for (const [start, ds] of [
      ["", dataSource],
      ["0x1000", null],
      ["nothex", dataSource],
    ] as const) {
      const element = await mountedElement(start, ds);
      expect(element.shadowRoot?.querySelector(".chain")).toBeNull();
      element.remove();
    }
  });
});

describe("SmJumpChain 循环回环(FE-ST-07 箭头打回)", () => {
  it("回环段渲染 SVG 回环标记(aria 可感知),不追加重复芯片", async () => {
    const dataSource = dataSourceWith({
      byteLength: 4096,
      bytesHex: windowHexFrom(
        [
          [0, littleEndianHex(0x1008)],
          [8, littleEndianHex(0x1000)],
        ],
        16,
      ),
    });
    const element = await mountedElement("0x1000", dataSource);

    const loopMark = element.shadowRoot?.querySelector(".chain-loop");
    expect(loopMark).not.toBeNull();
    expect(loopMark?.getAttribute("aria-label")).toContain("0x1000");
    expect(loopMark?.querySelector("svg")).not.toBeNull();
    expect(chips(element)).toHaveLength(2);

    element.remove();
  });
});

describe("SmJumpChain 视角跳转事件(FE-ST-09,组件只发事件)", () => {
  it("点击链上地址 → viewport-jump 事件携带地址与窗口内标记", async () => {
    const dataSource = dataSourceWith({
      byteLength: 4096,
      bytesHex: windowHexFrom(
        [
          [0, littleEndianHex(0x1008)],
          [8, littleEndianHex(0x9999)],
        ],
        16,
      ),
    });
    const element = await mountedElement("0x1000", dataSource);
    const events: CustomEvent<ViewportJumpDetail>[] = [];
    element.addEventListener("viewport-jump", (event) => {
      events.push(event as CustomEvent<ViewportJumpDetail>);
    });

    const allChips = chips(element);
    allChips[0]?.click();
    allChips[1]?.click();

    expect(events).toHaveLength(2);
    expect(events[0]?.detail).toEqual({ addressHex: "0x1000", withinWindow: true });
    expect(events[1]?.detail).toEqual({ addressHex: "0x1008", withinWindow: true });
    expect(events[0]?.bubbles).toBe(true);
    expect(events[0]?.composed).toBe(true);

    element.remove();
  });

  it("窗口外段(区域范围但字节未下发)→ withinWindow = false(宿主给'窗口外'反馈)", async () => {
    const dataSource = dataSourceWith({
      byteLength: 4096,
      bytesHex: littleEndianHex(0x1100),
    });
    const element = await mountedElement("0x1000", dataSource);
    const events: CustomEvent<ViewportJumpDetail>[] = [];
    element.addEventListener("viewport-jump", (event) => {
      events.push(event as CustomEvent<ViewportJumpDetail>);
    });

    const allChips = chips(element);
    expect(allChips.map((chip) => chip.textContent?.trim())).toEqual(["0x1000", "0x1100"]);
    allChips[1]?.click();

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({ addressHex: "0x1100", withinWindow: false });

    element.remove();
  });
});

describe("SmJumpChain 超限展开(竖向完整链)", () => {
  function fiveChainDataSource(): MemoryDataSource {
    const spans: Array<[number, string]> = [];
    for (let index = 0; index < 5; index += 1) {
      spans.push([index * 8, littleEndianHex(0x1000 + (index + 1) * 8)]);
    }
    return dataSourceWith({
      byteLength: 4096,
      bytesHex: windowHexFrom(spans, 40),
    });
  }

  it("链超过 3 段:横向截断 3 段 + 尾随目标芯片 + '展开完整链'入口", async () => {
    const element = await mountedElement("0x1000", fiveChainDataSource());

    expect(chips(element).map((chip) => chip.textContent?.trim())).toEqual([
      "0x1000",
      "0x1008",
      "0x1010",
      "0x1018", // 尾随目标芯片(第 4 段地址,未在横向上解引用展示)
    ]);
    const toggle = element.shadowRoot?.querySelector("button.chain-expand");
    expect(toggle?.textContent?.trim()).toBe("展开完整链");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(element.shadowRoot?.querySelector(".chain-vertical")).toBeNull();

    element.remove();
  });

  it("点击展开 → 下方竖向完整链(含值与窗口外标记);收起即撤销", async () => {
    const element = await mountedElement("0x1000", fiveChainDataSource());

    const toggle = element.shadowRoot?.querySelector("button.chain-expand") as HTMLButtonElement;
    toggle.click();
    await element.updateComplete;

    const items = Array.from(
      element.shadowRoot?.querySelectorAll(".chain-vertical li") ?? [],
    );
    expect(items).toHaveLength(6); // 5 个可解引用段 + 1 个窗口外截断段
    expect(items[5]?.textContent).toContain("0x1028");
    expect(items[5]?.textContent).toContain("窗口外");
    expect(items[1]?.textContent).toContain("值 0x1010");
    expect(
      element.shadowRoot?.querySelector("button.chain-expand")?.getAttribute("aria-expanded"),
    ).toBe("true");

    // 收起:竖向链撤销,回到横向 ≤3 段形态。
    (element.shadowRoot?.querySelector("button.chain-expand") as HTMLButtonElement).click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".chain-vertical")).toBeNull();

    element.remove();
  });

  it("链自然终止(≤3 段)→ 无展开入口", async () => {
    const dataSource = dataSourceWith({
      byteLength: 4096,
      bytesHex: windowHexFrom([[0, littleEndianHex(0x1008)]], 16),
    });
    const element = await mountedElement("0x1000", dataSource);
    expect(element.shadowRoot?.querySelector("button.chain-expand")).toBeNull();

    element.remove();
  });
});

describe("SmJumpChain 链末可见字符延伸(FE-ST-10)", () => {
  it("链末地址内容为可见字符时追加引号字符显示", async () => {
    // 0x1000 → 0x1041(窗口内);0x1041 处内容 "Hello\0" → 值非指针,链终止。
    const dataSource = dataSourceWith({
      byteLength: 0x2000,
      bytesHex: windowHexFrom(
        [
          [0, littleEndianHex(0x1041)],
          [0x41, "48656c6c6f000000"],
        ],
        0x49,
      ),
    });
    const element = await mountedElement("0x1000", dataSource);

    const run = element.shadowRoot?.querySelector(".visible-run");
    expect(run?.textContent).toBe('"Hello"');

    element.remove();
  });

  it("链末内容不可见(指针字节)→ 无可见字符延伸", async () => {
    const dataSource = dataSourceWith({
      byteLength: 4096,
      bytesHex: windowHexFrom([[0, littleEndianHex(0x1008)]], 16),
    });
    const element = await mountedElement("0x1000", dataSource);
    expect(element.shadowRoot?.querySelector(".visible-run")).toBeNull();

    element.remove();
  });
});
