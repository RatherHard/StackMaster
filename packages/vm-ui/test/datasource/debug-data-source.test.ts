/**
 * DebugDataSource 行为测试(WP-F8):推送 + 显式拉取的本地缓存模型——
 * 缓存窗口命中 / 窗口外、prefetch 归并与 regions 映射、search(缓存)与
 * searchAllMemory(全内存)、instructionStream 缓存边界、函数表、断点集合、
 * step / runToBreakpoint 帧发送(fake transport)。
 *
 * 传输 = FakeWebSocket 手工驱动(与 session-client 测试同一基建);夹具投影
 * 经公开投影 Schema 自检(漂移即红灯)。数据源 = 调试通道唯一消费面,
 * 零旁路真实私有包内容(缓存只来自 debug_window_data / 推送帧)。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DEBUG_CHANNEL_PROTOCOL_VERSION, PublicStateProjectionSchema } from "@stackmaster/protocol";

import { DebugChannelClient } from "../../src/client/debug-channel-client.js";
import {
  createDebugDataSource,
  DebugDataSource,
} from "../../src/datasource/debug-data-source.js";
import { FakeWebSocket, fakeWebSocketFactory, settle } from "../helpers/fixtures.js";

const SESSION_ID = "session-debug-0001";

/** 夹具公开投影:stack 区域 @0x1000(4096B)+ code 区域 @0x400000(4096B)。 */
const projection = PublicStateProjectionSchema.parse({
  revision: 3,
  visibleRegions: [
    {
      regionId: "stack",
      label: "栈",
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      bytesHex: "00",
      truncated: true,
    },
    {
      regionId: "code",
      label: "代码段",
      startAddressHex: "0x400000",
      byteLength: 4096,
      permissions: "rx",
      bytesHex: "00",
      truncated: true,
    },
  ],
  visibleRegisters: [
    { name: "RSP", valueHex: "0xB000" },
    { name: "RIP", valueHex: "0x401000" },
  ],
  callStackSummary: [],
  controlFlow: { currentInstruction: { addressHex: "0x401000", text: "push rbp" }, pausedOn: null },
  semanticHighlights: [],
  status: "paused",
});

interface Harness {
  readonly source: DebugDataSource;
  readonly socket: FakeWebSocket;
  readonly events: string[];
}

/** 服务端 S→C 帧封装(客户端按冻结 Schema 重新校验,漂移即兜底错误)。 */
function serverFrame(type: string, payload: unknown, seq: number, requestId?: string): unknown {
  return {
    protocolVersion: DEBUG_CHANNEL_PROTOCOL_VERSION,
    type,
    sessionId: SESSION_ID,
    seq,
    ...(requestId === undefined ? {} : { requestId }),
    payload,
  };
}

/** 挂载:假传输 + 确定性 requestId + 夹具投影;connect + attach 已完成。 */
function mount(): Harness {
  FakeWebSocket.reset();
  let requestSeq = 0;
  const client = new DebugChannelClient({
    sessionId: SESSION_ID,
    origin: { kind: "revision", revision: 3 },
    webSocketFactory: fakeWebSocketFactory,
    generateRequestId: () => `req-${(requestSeq += 1)}`,
  });
  const source = new DebugDataSource(client, { projectionProvider: () => projection });
  const events: string[] = [];
  source.onChange((event) => {
    events.push(event.kind);
  });
  client.connect();
  const socket = FakeWebSocket.last;
  socket.serverAccepts();
  // attach 回执(paused @ 0x401000,对齐后暂停态)。
  socket.serverSends(
    serverFrame("debug_attached", { revision: 3, status: "paused", paused: { addressHex: "0x401000" } }, 1),
  );
  return { source, socket, events };
}

/** 读取第 N 帧的 requestId(客户端确定性生成器:req-1 = attach)。 */
function requestIdOf(frame: unknown): string {
  return (frame as Record<string, unknown>).requestId as string;
}

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("regions / registers:公开投影结构同构映射", () => {
  it("regions():区域列表同构映射;零缓存时 windowByteLength = 0", () => {
    const { source } = mount();
    const regions = source.regions();
    expect(regions.map((entry) => entry.regionId)).toEqual(["stack", "code"]);
    expect(regions[0]).toMatchObject({
      startAddressHex: "0x1000",
      byteLength: 4096,
      permissions: "rw",
      windowByteLength: 0,
      truncated: true,
    });
  });

  it("registers():公开投影寄存器面(valueHex 大写归一化)", () => {
    const { source } = mount();
    expect(source.registers()).toEqual([
      { name: "RSP", valueHex: "0xB000" },
      { name: "RIP", valueHex: "0x401000" },
    ]);
  });

  it("无投影提供者:regions / registers 为空(装配缺省安全)", () => {
    FakeWebSocket.reset();
    let requestSeq = 0;
    const source = new DebugDataSource(
      new DebugChannelClient({
        sessionId: SESSION_ID,
        origin: { kind: "revision", revision: 0 },
        webSocketFactory: fakeWebSocketFactory,
        generateRequestId: () => `req-${(requestSeq += 1)}`,
      }),
    );
    source.attach();
    expect(source.regions()).toEqual([]);
    expect(source.registers()).toEqual([]);
    source.dispose();
  });
});

describe("缓存窗口:命中 / 窗口外 / 归并", () => {
  it("prefetchWindow:发出 debug_window 帧 → 回执入缓存 → bytesRows 命中", async () => {
    const { source, socket } = mount();
    const pending = source.prefetchWindow("0x1000", 8);
    await settle();
    // 请求帧形态:seq 2(1 = attach),payload 地址归一化。
    const frame = socket.sent[1] as Record<string, unknown>;
    expect(frame.protocolVersion).toBe(DEBUG_CHANNEL_PROTOCOL_VERSION);
    expect(frame.type).toBe("debug_window");
    expect(frame.payload).toEqual({ addressHex: "0x1000", byteLength: 8 });

    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x1000", bytesHex: "0102030405060708" }, 100, requestIdOf(frame)),
    );
    await pending;

    const rows = source.bytesRows({ startAddressHex: "0x1000", endAddressHex: "0x1008" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells.map((cell) => cell.byteHex)).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08",
    ]);
    expect(rows[0]?.cells.every((cell) => cell.regionId === "stack")).toBe(true);
  });

  it("缓存外地址 = 窗口外 cell(null,与公开档同形,不报错)", async () => {
    const { source, socket } = mount();
    const pending = source.prefetchWindow("0x1000", 4);
    await settle();
    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x1000", bytesHex: "0102" }, 100, requestIdOf(socket.sent[1])),
    );
    await pending;

    const rows = source.bytesRows({ startAddressHex: "0x1000", endAddressHex: "0x1010" });
    const cells = rows.flatMap((row) => row.cells);
    expect(cells[0]?.byteHex).toBe("01");
    expect(cells[2]?.byteHex).toBeNull(); // 0x1002:缓存外(区域归属保留)。
    expect(cells[2]?.regionId).toBe("stack");
    expect(cells[2]?.offset).toBeNull();
  });

  it("未映射地址:regionId / offset / byte 全 null", () => {
    const { source } = mount();
    const rows = source.bytesRows({ startAddressHex: "0x900000", endAddressHex: "0x900004" });
    expect(rows[0]?.cells.every((cell) => cell.regionId === null && cell.byte === null)).toBe(true);
  });

  it("相邻窗口归并:两段 prefetch 合并为连续覆盖;regions 覆盖面随动", async () => {
    const { source, socket } = mount();
    const first = source.prefetchWindow("0x1000", 8);
    await settle();
    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x1000", bytesHex: "0102030405060708" }, 100, requestIdOf(socket.sent[1])),
    );
    await first;

    const second = source.prefetchWindow("0x1008", 8);
    await settle();
    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x1008", bytesHex: "1112131415161718" }, 101, requestIdOf(socket.sent[2])),
    );
    await second;

    const regions = source.regions();
    expect(regions[0]?.windowByteLength).toBe(16);
    expect(regions[0]?.truncated).toBe(true);
    expect(source.search({ patternHex: "1112" })).toEqual([
      { regionId: "stack", addressHex: "0x1008", matchedHex: "1112" },
    ]);
  });

  it("中段 prefetch:regions 覆盖最大面,空洞以窗口外 cell 显式呈现", async () => {
    const { source, socket } = mount();
    const pending = source.prefetchWindow("0x1010", 4);
    await settle();
    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x1010", bytesHex: "aabb" }, 100, requestIdOf(socket.sent[1])),
    );
    await pending;

    // 覆盖面 = 0x12(最远缓存末尾 - 区域起点);空洞 0x1000..0x1010 = 窗口外。
    expect(source.regions()[0]?.windowByteLength).toBe(0x12);
    const cells = source
      .bytesRows({ startAddressHex: "0x1000", endAddressHex: "0x1014" })
      .flatMap((row) => row.cells);
    expect(cells[0]?.byteHex).toBeNull();
    expect(cells[0x10]?.byteHex).toBe("aa");
  });

  it("byteLength 夹取到协议上限(1..4096)", async () => {
    const { source, socket } = mount();
    void source.prefetchWindow("0x1000", 999999);
    await settle();
    expect((socket.sent[1] as Record<string, unknown>).payload).toMatchObject({ byteLength: 4096 });
  });
});

describe("search(缓存)与 searchAllMemory(全内存)", () => {
  it("search:仅缓存窗口字节内命中(缓存外不可见)", async () => {
    const { source, socket } = mount();
    const pending = source.prefetchWindow("0x1000", 8);
    await settle();
    socket.serverSends(
      serverFrame("debug_window_data", { addressHex: "0x1000", bytesHex: "deadbeefdeadbeef" }, 100, requestIdOf(socket.sent[1])),
    );
    await pending;

    expect(source.search({ patternHex: "dead" }).map((hit) => hit.addressHex)).toEqual([
      "0x1000",
      "0x1004",
    ]);
    expect(source.search({ patternHex: "cafe" })).toEqual([]);
    expect(source.search({ patternHex: "" })).toEqual([]);
  });

  it("searchAllMemory:发出 debug_search 帧;回执带区域归属与截断标记", async () => {
    const { source, socket } = mount();
    const pending = source.searchAllMemory("BEEF", 64);
    await settle();
    const frame = socket.sent[1] as Record<string, unknown>;
    expect(frame.type).toBe("debug_search");
    expect(frame.payload).toEqual({ patternHex: "beef", maxHits: 64 });

    socket.serverSends(
      serverFrame(
        "debug_search_results",
        { hits: [{ addressHex: "0x1004", bytesHex: "BEEF" }], truncated: true },
        200,
        requestIdOf(frame),
      ),
    );
    const result = await pending;
    expect(result.hits).toEqual([
      { addressHex: "0x1004", matchedHex: "beef", regionId: "stack" },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("searchAllMemory 失败 reject(未连接)", async () => {
    const { source } = mount();
    source.dispose();
    await expect(source.searchAllMemory("beef")).rejects.toThrow();
  });
});

describe("指令流:推送缓存与覆盖面边界", () => {
  function pushInstructions(socket: FakeWebSocket, seq: number): void {
    socket.serverSends(
      serverFrame(
        "debug_instruction_stream",
        {
          instructions: [
            { addressHex: "0x401000", bytesHex: "55", text: "push rbp", jumpTargetHex: "0x401010" },
            { addressHex: "0x401004", text: "call 0x401020" },
            { addressHex: "0x401010", bytesHex: "c3", text: "ret" },
          ],
        },
        seq,
      ),
    );
  }

  it("推送帧并入缓存:instructions() 按地址升序,含 bytesHex / jumpTargetHex", () => {
    const { source, socket, events } = mount();
    pushInstructions(socket, 2);
    const instructions = source.instructions();
    expect(instructions.map((entry) => entry.addressHex)).toEqual([
      "0x401000",
      "0x401004",
      "0x401010",
    ]);
    expect(instructions[0]?.bytesHex).toBe("55");
    expect(instructions[0]?.jumpTargetHex).toBe("0x401010");
    expect(instructions[1]?.bytesHex).toBeUndefined(); // 缺席语义(非 null 占位)。
    expect(events).toContain("cache");
  });

  it("instructionStream(range):覆盖面内过滤返回;超出覆盖面 = 空数组", () => {
    const { source, socket } = mount();
    pushInstructions(socket, 2);
    expect(
      source.instructionStream({ startAddressHex: "0x401000", endAddressHex: "0x401008" }),
    ).toEqual([
      { addressHex: "0x401000", text: "push rbp" },
      { addressHex: "0x401004", text: "call 0x401020" },
    ]);
    // 协议 v1 无 C→S 拉取帧:推送覆盖面之外恒空(不伪造)。
    expect(
      source.instructionStream({ startAddressHex: "0x500000", endAddressHex: "0x500008" }),
    ).toEqual([]);
  });

  it("instructionAt:命中条目;未命中 null", () => {
    const { source, socket } = mount();
    pushInstructions(socket, 2);
    expect(source.instructionAt("0x401010")?.text).toBe("ret");
    expect(source.instructionAt("0x402000")).toBeNull();
  });

  it("attach 携带 paused:pausedAddressHex 更新(rip 锚点来源)", () => {
    const { source } = mount();
    expect(source.pausedAddressHex).toBe("0x401000");
    expect(source.paused).toBeNull(); // attach 对齐暂停不算 debug_paused(理由文案不适用)。
    expect(source.attached?.status).toBe("paused");
  });
});

describe("函数表(attach 推送)", () => {
  it("推送即缓存,按起始地址升序;change 事件分发", () => {
    const { source, socket, events } = mount();
    socket.serverSends(
      serverFrame(
        "debug_function_table",
        {
          functions: [
            { label: "main", startAddressHex: "0x401000", byteLength: 32 },
            { label: "win", startAddressHex: "0x401020", byteLength: 16 },
          ],
        },
        2,
      ),
    );
    expect(source.functions.map((entry) => entry.label)).toEqual(["main", "win"]);
    expect(events).toContain("cache");
  });
});

describe("step / runToBreakpoint(帧发送,fake transport)", () => {
  it("step:debug_step 空载荷;debug_paused 回执更新暂停态 + 事件", async () => {
    const { source, socket, events } = mount();
    const pending = source.step();
    await settle();
    expect((socket.sent[1] as Record<string, unknown>).type).toBe("debug_step");
    expect((socket.sent[1] as Record<string, unknown>).payload).toEqual({});

    socket.serverSends(
      serverFrame("debug_paused", { reason: "step", addressHex: "0x401004" }, 300, requestIdOf(socket.sent[1])),
    );
    await pending;
    expect(source.paused).toEqual({ reason: "step", addressHex: "0x401004" });
    expect(source.pausedAddressHex).toBe("0x401004");
    expect(events).toContain("paused");
  });

  it("runToBreakpoint:缺省用当前断点集合", async () => {
    const { source, socket } = mount();
    source.addBreakpoint("0x401010");
    source.addBreakpoint("0x401008");
    expect(source.breakpoints).toEqual(["0x401008", "0x401010"]); // 地址升序。

    const pending = source.runToBreakpoint();
    await settle();
    expect((socket.sent[1] as Record<string, unknown>).type).toBe("debug_run_to_breakpoint");
    expect((socket.sent[1] as Record<string, unknown>).payload).toEqual({
      breakpoints: ["0x401008", "0x401010"],
    });
    socket.serverSends(
      serverFrame("debug_paused", { reason: "breakpoint", addressHex: "0x401008" }, 301, requestIdOf(socket.sent[1])),
    );
    const paused = await pending;
    expect(paused.reason).toBe("breakpoint");
  });

  it("runToBreakpoint:空集合确定性抛错且不发帧", async () => {
    const { source, socket } = mount();
    await expect(source.runToBreakpoint()).rejects.toThrow("断点集合为空");
    expect(socket.sent).toHaveLength(1); // 仅 attach 一帧。
  });
});

describe("断点集合管理(FE-IN-08 调试档 UI 状态)", () => {
  it("add / remove / toggle / isBreakpoint;change 事件携带地址升序集合", () => {
    const { source, events } = mount();
    source.addBreakpoint("0x401010");
    source.toggleBreakpoint("0x401008");
    expect(source.breakpoints).toEqual(["0x401008", "0x401010"]);
    expect(source.isBreakpoint("0x401008")).toBe(true);
    expect(source.breakpointCount).toBe(2);

    source.toggleBreakpoint("0x401008"); // 再切 = 移除。
    expect(source.isBreakpoint("0x401008")).toBe(false);

    expect(events.at(-1)).toBe("breakpoints");

    source.removeBreakpoint("0x401010");
    expect(source.breakpoints).toEqual([]);
  });

  it("重复添加为 no-op(地址归一化:大小写 / 前导零同键)", () => {
    const { source } = mount();
    source.addBreakpoint("0x401010");
    source.addBreakpoint("0X00401010");
    expect(source.breakpointCount).toBe(1);
    expect(source.breakpoints).toEqual(["0x401010"]);
  });
});

describe("组合根装配(createDebugDataSource)", () => {
  it("按会话 revision 起点装配;会话未创建返回 null", () => {
    expect(createDebugDataSource({ sessionId: null, store: { revision: null } })).toBeNull();
    FakeWebSocket.reset();
    let requestSeq = 0;
    const source = createDebugDataSource(
      { sessionId: SESSION_ID, store: { revision: 7 } },
      { webSocketFactory: fakeWebSocketFactory, generateRequestId: () => `req-${(requestSeq += 1)}` },
    );
    expect(source).toBeInstanceOf(DebugDataSource);
    source?.attach();
    FakeWebSocket.last.serverAccepts(); // onopen 即发送 attach。
    const attach = FakeWebSocket.last.sent[0] as Record<string, unknown>;
    expect(attach.payload).toEqual({ origin: { kind: "revision", revision: 7 } });
    source?.dispose();
  });
});
