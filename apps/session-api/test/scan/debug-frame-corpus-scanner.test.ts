/**
 * 调试通道帧语料包含性扫描器单测(阶段四 WP-44;ZR-B12;映射文档 §五纪律:
 * 零命中与必触发红灯反例同套件运行,反例证明扫描器可检出,零命中不是静默
 * 绿灯)。反例语料全部为仓库占位惯例(SECRET_FLAG_PLACEHOLDER /
 * SEED_HEX_FIXTURE 字节与合成随机字节),真实种子 / flag 不进任何文件。
 *
 * 帧样例以 `@stackmaster/protocol` 冻结 DebugFrameSchema 现场解析后喂给扫描
 * 器,证明扫描器输入与 WP-40 契约解析产物结构兼容。
 */

import { describe, expect, it } from "vitest";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";

import {
  DEBUG_FRAME_MEMORY_BYTE_POSITIONS,
  DEFAULT_DEBUG_TEXT_ALLOWLIST,
  ZR_B12_NUMERIC_RENDERING_MAX_LENGTH,
  ZR_B12_TEXT_HEX_RUN_MIN_LENGTH,
  formatZrB12Violations,
  scanDebugFrameCorpora,
  scanDebugFrameCorpus,
  type DebugVariantRegionView,
} from "../../src/scan/debug-frame-corpus-scanner.js";

/** 占位秘密语料(仓库惯例常量;非真实秘密,仅作红灯注入面)。 */
const SECRET_FLAG_PLACEHOLDER = "FLAG{placeholder_do_not_ship}";
const SEED_HEX_FIXTURE = "00112233445566778899aabbccddeeff";

/** 变体外合成随机字节(全仓语料中不存在;红灯反例 ②)。 */
const FOREIGN_BYTES_HEX = "7f3a9c5e1d8b04f26b92c40758e3a619";

/** 代码区内容(字节程序 + NOP0 填充;与集成 fixture 同形)。 */
const CODE_CONTENT_HEX = "5589cd0100000000000000" + "90".repeat(52);
const STACK_CONTENT_HEX = "00".repeat(32);
/** 玩家输入回显语料(权威动作日志 write_bytes 的 bytesHex)。 */
const PLAYER_INPUT_HEX = ["41414141"];

const REGIONS: readonly DebugVariantRegionView[] = [
  { regionId: "code", startAddressHex: "0x400000", contentHex: CODE_CONTENT_HEX },
  { regionId: "stack", startAddressHex: "0x7ffff000", contentHex: STACK_CONTENT_HEX },
];

/** 构造契约合法的调试帧(信封六字段;经冻结 Schema 现场解析自证)。 */
function frame(type: DebugFrame["type"], payload: Record<string, unknown>): DebugFrame {
  return DebugFrameSchema.parse({
    protocolVersion: 1,
    type,
    sessionId: "s-01J9KA7EXAMPLE0000",
    seq: 1,
    payload,
  });
}

function scan(frameValue: DebugFrame, playerInputBytesHex: readonly string[] = PLAYER_INPUT_HEX) {
  return scanDebugFrameCorpus({ frame: frameValue, variantRegions: REGIONS, playerInputBytesHex });
}

describe("ZR-B12 包含性断言:合法出站帧零命中", () => {
  it("debug_window_data:窗口字节 ⊆ 所定位区域变体语料(code 前缀)→ 零命中", () => {
    const windowData = frame("debug_window_data", {
      addressHex: "0x400000",
      bytesHex: CODE_CONTENT_HEX.slice(0, 32),
    });
    expect(scan(windowData)).toEqual([]);
  });

  it("debug_window_data:窗口字节 = 玩家输入回显(重放写入)→ 零命中(封闭集第三源)", () => {
    const windowData = frame("debug_window_data", {
      addressHex: "0x7ffff000",
      bytesHex: "41414141",
    });
    expect(scan(windowData)).toEqual([]);
  });

  it("debug_search_results:逐命中独立定位(变体语料命中 + 玩家输入命中)→ 零命中", () => {
    const searchResults = frame("debug_search_results", {
      hits: [
        { addressHex: "0x7ffff010", bytesHex: "0000000000000000" },
        { addressHex: "0x7ffff000", bytesHex: "41414141" },
      ],
      truncated: true,
    });
    expect(scan(searchResults)).toEqual([]);
  });

  it("debug_instruction_stream:items[].bytesHex ⊆ 代码区 + 展示文本(含地址渲染)→ 零命中", () => {
    const stream = frame("debug_instruction_stream", {
      instructions: [
        { addressHex: "0x400000", bytesHex: "55", text: "push rbp" },
        { addressHex: "0x400002", bytesHex: "cd01000000000000", text: "syscall 0x1" },
        { addressHex: "0x40000b", text: "nop" },
      ],
    });
    expect(scan(stream)).toEqual([]);
  });

  it("debug_function_table:label 展示文本(region 标签 / 派生符号)→ 零命中", () => {
    const table = frame("debug_function_table", {
      functions: [
        { label: "main", startAddressHex: "0x400000", byteLength: 11 },
        { label: "sub_400000", startAddressHex: "0x400000", byteLength: 16 },
      ],
    });
    expect(scan(table)).toEqual([]);
  });

  it("错误帧 / 控制帧 / C→S 请求帧:无内存字节载荷天然通过(含语料外 patternHex)", () => {
    expect(
      scan(frame("error", { code: "budget_exhausted", message: "动作预算耗尽" })),
    ).toEqual([]);
    expect(
      scan(frame("debug_attached", { revision: 2, status: "running" })),
    ).toEqual([]);
    expect(
      scan(frame("debug_paused", { reason: "breakpoint", addressHex: "0x400002" })),
    ).toEqual([]);
    // C→S 请求帧是玩家输入回传(断言对象之外):patternHex 不在语料仍零命中。
    expect(
      scan(frame("debug_search", { patternHex: FOREIGN_BYTES_HEX })),
    ).toEqual([]);
    expect(
      scan(frame("debug_window", { addressHex: "0x400000", byteLength: 16 })),
    ).toEqual([]);
  });
});

describe("ZR-B12 红灯反例(必触发;与零命中同套件)", () => {
  it("红灯 ①:窗口字节 = SECRET_FLAG_PLACEHOLDER 字节 → ZR-B12-bytes-not-in-variant-corpus", () => {
    const injected = frame("debug_window_data", {
      addressHex: "0x400000",
      bytesHex: Buffer.from(SECRET_FLAG_PLACEHOLDER, "utf8").toString("hex"),
    });
    const hits = scan(injected, []);
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B12-bytes-not-in-variant-corpus"]);
    expect(hits[0]?.path).toBe("$/payload/bytesHex");
  });

  it("红灯 ①':窗口字节 = SEED_HEX_FIXTURE 字节(变体与玩家输入语料外)→ 必命中", () => {
    const injected = frame("debug_window_data", {
      addressHex: "0x7ffff000",
      bytesHex: SEED_HEX_FIXTURE,
    });
    expect(scan(injected, []).map((hit) => hit.id)).toEqual(["ZR-B12-bytes-not-in-variant-corpus"]);
  });

  it("红灯 ②:窗口字节 = 变体中不存在的合成随机字节 → 必命中", () => {
    const injected = frame("debug_window_data", {
      addressHex: "0x400000",
      bytesHex: FOREIGN_BYTES_HEX,
    });
    expect(scan(injected, []).map((hit) => hit.id)).toEqual(["ZR-B12-bytes-not-in-variant-corpus"]);
  });

  it("红灯 ③:窗口地址不落在变体任何映射区域 → ZR-B12-address-outside-variant", () => {
    const injected = frame("debug_window_data", {
      addressHex: "0x999999000",
      bytesHex: "00000000",
    });
    expect(scan(injected).map((hit) => hit.id)).toEqual(["ZR-B12-address-outside-variant"]);
  });

  it("检索命中 / 指令流字节越语料:逐值断言逐位命中(定位到具体元素路径)", () => {
    const searchResults = frame("debug_search_results", {
      hits: [
        { addressHex: "0x400000", bytesHex: "5589cd" },
        { addressHex: "0x400010", bytesHex: FOREIGN_BYTES_HEX },
      ],
    });
    const searchHits = scan(searchResults, []);
    expect(searchHits).toHaveLength(1);
    expect(searchHits[0]?.id).toBe("ZR-B12-bytes-not-in-variant-corpus");
    expect(searchHits[0]?.path).toBe("$/payload/hits[1]/bytesHex");

    const stream = frame("debug_instruction_stream", {
      instructions: [
        { addressHex: "0x400000", bytesHex: Buffer.from(SECRET_FLAG_PLACEHOLDER, "utf8").toString("hex"), text: "push rbp" },
      ],
    });
    const streamHits = scan(stream, []);
    expect(streamHits.map((hit) => hit.id)).toEqual(["ZR-B12-bytes-not-in-variant-corpus"]);
    expect(streamHits[0]?.path).toBe("$/payload/instructions[0]/bytesHex");
  });
});

describe("ZR-B12 字段位置白名单:放行与拒绝边界", () => {
  it(`放行边界:文本十六进制串 ≤ ${ZR_B12_NUMERIC_RENDERING_MAX_LENGTH} 字符按数值渲染放行(变体外)`, () => {
    const stream = frame("debug_instruction_stream", {
      instructions: [
        // 16 个十六进制字符 = u64 数值渲染上限(如 mov RAX, 0x…),放行。
        { addressHex: "0x400000", bytesHex: "55", text: "mov rax, 0xdeadbeefcafebabe" },
      ],
    });
    expect(scan(stream, [])).toEqual([]);
  });

  it(`拒绝边界:文本夹带 > ${ZR_B12_NUMERIC_RENDERING_MAX_LENGTH} 字符的语料外十六进制串 → ZR-B12-text-smuggled-bytes`, () => {
    const stream = frame("debug_instruction_stream", {
      instructions: [
        { addressHex: "0x400000", bytesHex: "55", text: "kdf:9f8e7d6c5b4a39281705f3e2d1c0b8a79" },
      ],
    });
    const hits = scan(stream, []);
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B12-text-smuggled-bytes"]);
    expect(hits[0]?.path).toBe("instructions[0].text");
  });

  it(`拒绝边界不误伤:语料内超长十六进制串(${ZR_B12_TEXT_HEX_RUN_MIN_LENGTH}+ 字符且 ∈ 变体语料)零命中`, () => {
    const inCorpusRun = CODE_CONTENT_HEX.slice(0, 24); // 12 字节,∈ code contentHex
    const stream = frame("debug_instruction_stream", {
      instructions: [{ addressHex: "0x400000", bytesHex: "55", text: `bytes ${inCorpusRun}` }],
    });
    expect(scan(stream, [])).toEqual([]);
  });

  it("白名单是输入面:清空白名单位置后,同帧展示文本即越界命中(unallowlisted)", () => {
    const stream = frame("debug_instruction_stream", {
      instructions: [{ addressHex: "0x400000", bytesHex: "55", text: "push rbp" }],
    });
    const hits = scanDebugFrameCorpus({
      frame: stream,
      variantRegions: REGIONS,
      playerInputBytesHex: [],
      allowlist: { textPositions: [] },
    });
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B12-text-smuggled-bytes"]);
    expect(hits[0]?.path).toContain("(unallowlisted)");
    // 缺省白名单覆盖 v1 帧族全部文本位置。
    expect(DEFAULT_DEBUG_TEXT_ALLOWLIST.textPositions).toEqual([
      "instructions[].text",
      "functions[].label",
    ]);
  });
});

describe("ZR-B12 批量扫描与断言面登记", () => {
  it("scanDebugFrameCorpora:批量录制集命中携带 $<index> 帧定位;报告行携带条目 ID", () => {
    const inputs = [
      {
        frame: frame("debug_window_data", { addressHex: "0x400000", bytesHex: "5589cd" }),
        variantRegions: REGIONS,
        playerInputBytesHex: [],
      },
      {
        frame: frame("debug_window_data", { addressHex: "0x7ffff000", bytesHex: FOREIGN_BYTES_HEX }),
        variantRegions: REGIONS,
        playerInputBytesHex: [],
      },
    ];
    const hits = scanDebugFrameCorpora(inputs);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("$1$/payload/bytesHex");
    expect(formatZrB12Violations(hits)).toEqual([
      "[ZR-B12-bytes-not-in-variant-corpus] $1$/payload/bytesHex: 7f3a9c5e1d8b04f26b92c40758e3a619",
    ]);
  });

  it("断言面封闭枚举登记:三个 S→C 帧族的内存字节字段位置(映射文档登记用)", () => {
    expect(DEBUG_FRAME_MEMORY_BYTE_POSITIONS).toEqual([
      "debug_window_data/payload/bytesHex",
      "debug_search_results/payload/hits[].bytesHex",
      "debug_instruction_stream/payload/instructions[].bytesHex",
    ]);
  });
});
