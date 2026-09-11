/**
 * <sm-instruction-view> 指令视图测试(WP-F8 / FE-IN-01~08):
 * 三段渲染(缺席语义)/ rip 锚点 / jumpTarget 点击 / 函数表 / 检索双入口 /
 * 断点切换事件 / 地址跳转 prefetch 管线 / 暂停原因文案。
 *
 * 数据源 = FakeDebugSource(镜像 DebugDataSource 的 duck-typing 消费面:
 * instructionStream / instructions / prefetchWindow / onChange / 断点管理),
 * 组件测试不经任何 client / 传输。
 */
import { describe, expect, it } from "vitest";

import type { DebugInstructionEntry, DebugMemorySearchHit } from "../../../src/datasource/debug-data-source.js";
import type { AddrRange, Instr, MemoryDataSource } from "../../../src/datasource/types.js";
import { pausedReasonText, SmInstructionView } from "../../../src/views/instruction/sm-instruction-view.js";
import { mount, queryAllShadow, queryShadow, setInputValue } from "../ed/helpers.js";

// ── 测试替身:调试档数据源(duck-typing 面)────────────────────────────────

class FakeDebugSource implements MemoryDataSource {
  readonly rows: DebugInstructionEntry[] = [];
  readonly functions: { readonly label: string; readonly startAddressHex: string }[] = [];
  breakpoints: string[] = [];
  paused: { reason: string; addressHex: string } | null = null;
  pausedAddressHex: string | null = "0x401004";
  readonly prefetchRequests: { addressHex: string; byteLength?: number }[] = [];
  readonly searchRequests: { patternHex: string; maxHits?: number }[] = [];
  /** 预设下一次 prefetch 是否成功(false = 通道失败)。 */
  prefetchSucceeds = true;
  readonly listeners: (() => void)[] = [];
  /** byte search 结果(测试注入)。 */
  searchHits: DebugMemorySearchHit[] = [];

  constructor(entries: DebugInstructionEntry[] = []) {
    this.rows.push(...entries);
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  async prefetchWindow(addressHex: string, byteLength?: number): Promise<unknown> {
    this.prefetchRequests.push({ addressHex, byteLength });
    if (!this.prefetchSucceeds) {
      throw new Error("channel unavailable (fake)");
    }
    return { addressHex, bytesHex: "00" };
  }

  async searchAllMemory(patternHex: string, maxHits?: number): Promise<{ hits: DebugMemorySearchHit[]; truncated: boolean }> {
    this.searchRequests.push({ patternHex, maxHits });
    return { hits: this.searchHits, truncated: false };
  }

  toggleBreakpoint(addressHex: string): void {
    if (this.breakpoints.includes(addressHex)) {
      this.removeBreakpoint(addressHex);
    } else {
      this.addBreakpoint(addressHex);
    }
  }

  addBreakpoint(addressHex: string): void {
    if (!this.breakpoints.includes(addressHex)) {
      this.breakpoints = [...this.breakpoints, addressHex];
      this.emit(); // 镜像真实 DebugDataSource:断点变化经 onChange 回流刷新视图。
    }
  }

  removeBreakpoint(addressHex: string): void {
    if (this.breakpoints.includes(addressHex)) {
      this.breakpoints = this.breakpoints.filter((entry) => entry !== addressHex);
      this.emit();
    }
  }

  isBreakpoint(addressHex: string): boolean {
    return this.breakpoints.includes(addressHex);
  }

  get breakpointCount(): number {
    return this.breakpoints.length;
  }

  instructions(): readonly DebugInstructionEntry[] {
    return [...this.rows];
  }

  instructionAt(addressHex: string): DebugInstructionEntry | null {
    return this.rows.find((entry) => entry.addressHex === addressHex) ?? null;
  }

  instructionStream(range: AddrRange): Instr[] {
    return this.rows
      .filter((entry) => BigInt(entry.addressHex) >= BigInt(range.startAddressHex) && BigInt(entry.addressHex) < BigInt(range.endAddressHex))
      .map((entry) => ({ addressHex: entry.addressHex, text: entry.text }));
  }

  functions_list(): readonly { readonly label: string; readonly startAddressHex: string }[] {
    return this.functions;
  }

  regions() {
    return [];
  }

  registers() {
    return [{ name: "RIP", valueHex: "0x401004" }];
  }

  bytesRows(): never[] {
    return [];
  }

  search(): never[] {
    return [];
  }
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const ENTRIES: DebugInstructionEntry[] = [
  { addressHex: "0x401000", bytesHex: "55", text: "push rbp", jumpTargetHex: "0x401010" },
  { addressHex: "0x401004", text: "mov rbp, rsp" }, // bytesHex 缺席(可选字段)。
  { addressHex: "0x401010", bytesHex: "c3", text: "ret" },
];

async function mountView(source: MemoryDataSource | null): Promise<SmInstructionView> {
  const element = await mount<SmInstructionView>("sm-instruction-view");
  element.dataSource = source;
  await element.updateComplete;
  await settleFrames(4);
  return element;
}

/** 冲刷渲染帧(lit-virtualizer 首屏可见范围计算收敛,与字节视图测试同法)。 */
async function settleFrames(frames: number): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await Promise.resolve();
  }
}

function rowsOf(view: SmInstructionView): HTMLElement[] {
  return queryAllShadow(view, "sm-window-list .instruction-row:not(.header-row)");
}

// ── 套件 ─────────────────────────────────────────────────────────────────────

describe("FE-IN-01/02:默认形态与三段布局(缺席语义)", () => {
  it("非调试数据源(null / 公开档无 instructionStream)呈现调试模式引导,不伪造指令流", async () => {
    const view = await mountView(null);
    expect(queryShadow(view, ".guide")?.textContent).toContain("切换到调试模式");
    expect(rowsOf(view)).toHaveLength(0);
  });

  it("调试数据源:一行一条指令,地址升序;三段布局齐备", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    const rows = rowsOf(view);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector(".row-address")?.textContent).toContain("0x00401000");
    expect(rows[0]?.querySelector(".row-bytes")?.textContent?.trim()).toBe("55");
    expect(rows[0]?.querySelector(".row-text")?.textContent).toContain("push rbp");
    // 地址升序(低地址在上):末行 = 最高地址。
    expect(rows[2]?.querySelector(".row-address")?.textContent).toContain("0x00401010");
  });

  it("bytesHex 缺席(推送条目可选字段)呈现 '—',不以 null/空串占位", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    const row = rowsOf(view)[1];
    expect(row?.querySelector(".row-bytes .bytes-absent")?.textContent).toBe("—");
  });

  it("指令流为空:明示推送覆盖面空态(attach 后单步 / 运行到断点引导)", async () => {
    const view = await mountView(new FakeDebugSource([]));
    expect(queryShadow(view, ".empty")?.textContent).toContain("指令流暂无推送覆盖");
  });
});

describe("FE-IN-03:jumpTargetHex 延展显示 + 点击跳转", () => {
  it("控制转移条目延展目标地址芯片;点击覆盖面内直接滚动", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    const chip = queryShadow(view, ".jump-target");
    expect(chip?.textContent).toContain("0x00401010");

    chip?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await view.updateComplete;
    await settleFrames(3);
    expect(queryShadow(view, ".status-line")?.textContent).toContain("已跳转到 0x00401010");
    expect(source.prefetchRequests).toHaveLength(0); // 覆盖面内:零 prefetch。
  });

  it("jumpTarget 覆盖面外:自动 prefetchWindow 后重试一次,仍不可达给覆盖面外反馈", async () => {
    const source = new FakeDebugSource([
      { addressHex: "0x401000", text: "push rbp", jumpTargetHex: "0x500000" },
    ]);
    const view = await mountView(source);
    queryShadow(view, ".jump-target")?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;

    expect(source.prefetchRequests).toEqual([{ addressHex: "0x500000", byteLength: 64 }]);
    // prefetch 成功但目标仍无指令条目 → 明示"覆盖面之外"(协议 v1 无拉取帧)。
    expect(queryShadow(view, ".status-line")?.textContent).toContain("覆盖面之外");
  });
});

describe("FE-IN-05:rip 锚点(最新暂停地址高亮 + 回锚)", () => {
  it("paused 地址行高亮;锚点芯片 + 回锚按钮", async () => {
    const source = new FakeDebugSource(ENTRIES);
    source.pausedAddressHex = "0x401004";
    const view = await mountView(source);
    const pausedRow = rowsOf(view)[1];
    expect(pausedRow?.classList.contains("paused-row")).toBe(true);
    expect(queryShadow(view, ".anchor-value")?.textContent).toContain("rip = 0x00401004");

    queryShadow(view, ".anchor-rewind")?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(queryShadow(view, ".status-line")?.textContent).toContain("已跳转到 0x00401004");
  });

  it("数据源 onChange 推送 → 视图自刷新(暂停态呈现各自文案)", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    source.paused = { reason: "breakpoint", addressHex: "0x401010" };
    source.pausedAddressHex = "0x401010";
    source.emit();
    await view.updateComplete;
    await settleFrames(3);

    expect(queryShadow(view, ".paused-line")?.textContent).toContain("命中断点,已暂停");
    expect(rowsOf(view)[2]?.classList.contains("paused-row")).toBe(true);
  });
});

describe("FE-IN-04:函数表面板(点击跳转)", () => {
  it("函数表按注入序呈现;点击走 FE-IN-06 跳转管线", async () => {
    const source = new FakeDebugSource(ENTRIES);
    source.functions.push({ label: "main", startAddressHex: "0x401000" });
    const view = await mountView(source);

    const summary = queryShadow(view, ".function-panel summary");
    summary?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await view.updateComplete;
    await settleFrames(3);
    const item = queryShadow(view, ".function-jump");
    expect(item?.textContent).toContain("main");

    item?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(queryShadow(view, ".status-line")?.textContent).toContain("已跳转到 0x00401000");
  });
});

describe("FE-IN-06:地址跳转(prefetch 管线)", () => {
  it("覆盖面内地址直接滚动;非法输入给反馈不报错", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);

    setInputValue(view, ".jump-input", "0x401010");
    queryShadow(view, ".jump-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await view.updateComplete;
    expect(queryShadow(view, ".status-line")?.textContent).toContain("已跳转到 0x00401010");

    setInputValue(view, ".jump-input", "not-an-address");
    queryShadow(view, ".jump-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await view.updateComplete;
    expect(queryShadow(view, ".status-line")?.textContent).toContain("无法识别的地址");
  });

  it("覆盖面外地址:prefetch → 重试 → 仍不可达给覆盖面外反馈(窗口字节已入缓存提示)", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    setInputValue(view, ".jump-input", "0x500000");
    queryShadow(view, ".jump-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;

    expect(source.prefetchRequests).toEqual([{ addressHex: "0x500000", byteLength: 64 }]);
    expect(queryShadow(view, ".status-line")?.textContent).toContain("覆盖面之外");
    expect(queryShadow(view, ".status-line")?.textContent).toContain("字节视图");
  });

  it("prefetch 失败(通道不可达)给降级明示文案", async () => {
    const source = new FakeDebugSource(ENTRIES);
    source.prefetchSucceeds = false;
    const view = await mountView(source);
    setInputValue(view, ".jump-input", "0x500000");
    queryShadow(view, ".jump-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    expect(queryShadow(view, ".status-line")?.textContent).toContain("窗口请求失败");
  });
});

describe("FE-IN-07:检索双入口(字节全内存 / 指令文本缓存过滤)", () => {
  it("字节检索走 debug_search(异步);命中列表点击跳转", async () => {
    const source = new FakeDebugSource(ENTRIES);
    source.searchHits = [{ addressHex: "0x401000", matchedHex: "55", regionId: "code" }];
    const view = await mountView(source);

    setInputValue(view, ".byte-search-input", "55");
    queryShadow(view, ".byte-search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;

    expect(source.searchRequests).toEqual([{ patternHex: "55", maxHits: undefined }]);
    const hit = queryShadow(view, ".search-hit");
    expect(hit?.textContent).toContain("0x00401000");
    hit?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(queryShadow(view, ".status-line")?.textContent).toContain("已跳转到 0x00401000");
  });

  it("字节检索非法模式给行内反馈;无命中明示", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    setInputValue(view, ".byte-search-input", "5"); // 奇数长度。
    queryShadow(view, ".byte-search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await view.updateComplete;
    expect(queryShadow(view, ".status-line")?.textContent).toContain("偶数长度");

    source.searchHits = [];
    setInputValue(view, ".byte-search-input", "55");
    queryShadow(view, ".byte-search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    expect(queryShadow(view, ".status-line")?.textContent).toContain("全内存无命中");
  });

  it("指令文本检索 = 缓存指令流过滤,命中点击滚动", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);

    setInputValue(view, ".text-search-input", "PUSH"); // 大小写不敏感。
    queryShadow(view, ".text-search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await view.updateComplete;

    const hits = queryAllShadow(view, ".search-hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.textContent).toContain("push rbp");
    hits[0]?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(queryShadow(view, ".status-line")?.textContent).toContain("已跳转到 0x00401000");

    setInputValue(view, ".text-search-input", "nomatch");
    queryShadow(view, ".text-search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await view.updateComplete;
    expect(queryShadow(view, ".status-line")?.textContent).toContain("无命中");
  });
});

describe("FE-IN-08:行断点切换(调试档集合 UI 状态)", () => {
  it("断点按钮切换 aria-pressed;breakpoints-changed 事件携带集合", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    const events: { detail: { breakpoints: readonly string[] } }[] = [];
    view.addEventListener("breakpoints-changed", (event) => {
      events.push((event as CustomEvent<{ breakpoints: readonly string[] }>).detail as never);
    });

    const toggle = queryShadow(view, ".breakpoint-toggle");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    toggle?.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
    await view.updateComplete;
    await settleFrames(3);

    expect(source.breakpoints).toEqual(["0x401000"]);
    expect(events).toEqual([{ breakpoints: ["0x401000"] }]);
    expect(queryShadow(view, ".breakpoint-toggle")?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("暂停原因文案(debug_paused 封闭四值)", () => {
  it("reason → 呈现文案各自映射", () => {
    expect(pausedReasonText("step")).toContain("单步");
    expect(pausedReasonText("breakpoint")).toContain("断点");
    expect(pausedReasonText("program_halt")).toContain("停机");
    expect(pausedReasonText("budget")).toContain("预算耗尽");
  });

  it("尚未 attach 呈现未对齐状态行", async () => {
    const source = new FakeDebugSource(ENTRIES);
    const view = await mountView(source);
    expect(queryShadow(view, ".paused-line")?.textContent).toContain("尚未 attach");
  });
});

