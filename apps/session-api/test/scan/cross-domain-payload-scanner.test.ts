/**
 * 跨域载荷机检扫描器单测(WP-7;规则精度 + 必触发红灯反例)。
 *
 * 纪律(映射文档 §五):每条已接线规则必须有红灯反例——反例证明扫描器可
 * 检出,零命中不是静默绿灯。反例载荷全部为合成语料(真实题目内容不入 git)。
 */

import { describe, expect, it } from "vitest";

import {
  PRIVATE_EVENT_KINDS,
  SNAPSHOT_CIPHER_MAGIC,
  SNAPSHOT_ENVELOPE_MARKER,
  ZR_B9_CO_OCCURRENCE_THRESHOLD,
  formatCrossDomainHits,
  scanCrossDomainPayload,
  scanCrossDomainPayloads,
} from "../../src/scan/cross-domain-payload-scanner.js";

/** 合成 VmState 明文形态(红灯反例语料;非真实状态)。 */
function syntheticVmStateObject(): Record<string, unknown> {
  return {
    registers: { RAX: "0x0" },
    memory: { pages: [] },
    callFrames: [],
    instructionPointer: "0x401000",
    privateEventLog: [],
    constraints: { maxSteps: 1000 },
    seedState: { strategy: "fixed" },
    status: "running",
  };
}

describe("ZR-B9 共现规则(单 JSON 对象 ≥ 3 个 VmState 字段名键)", () => {
  it("公开契约形态(投影 / ActionResponse / PublicError)零命中", () => {
    const projection = {
      revision: 3,
      visibleRegions: [
        {
          regionId: "code",
          label: "代码区",
          startAddressHex: "0x401000",
          byteLength: 2,
          permissions: "rx",
          bytesHex: `${"ab".repeat(64)}00`, // ≥32 hex 的合法公开载荷(bytesHex 豁免)
          truncated: true,
        },
      ],
      visibleRegisters: [{ name: "RAX", valueHex: "0x1" }],
      callStackSummary: [],
      controlFlow: { currentInstruction: { addressHex: "0x401000", text: "ret" }, pausedOn: null },
      semanticHighlights: [],
      status: "running",
    };
    const actionResponse = {
      requestId: "req-0f4d9a2bc7e64d1f9c31ab20de55f801",
      revision: 3,
      status: "running",
      projectionDelta: null,
      publicEvents: [{ seq: 0, kind: "write" }],
    };
    expect(scanCrossDomainPayload(projection)).toEqual([]);
    expect(scanCrossDomainPayload(actionResponse)).toEqual([]);
  });

  it(`恰 ${ZR_B9_CO_OCCURRENCE_THRESHOLD} 个 VmState 字段名键 → 命中(阈值精度;字段名键同时触发词边界模式)`, () => {
    const hits = scanCrossDomainPayload({
      revision: 1,
      registers: {},
      memory: {},
      seedState: {},
    });
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B9-cooccurrence", "ZR-B9-identifier"]);
    expect(hits[0]?.token.split(",").sort()).toEqual(["memory", "registers", "seedState"]);
  });

  it("两个 VmState 字段名键 → 不命中(低于共现阈值)", () => {
    expect(scanCrossDomainPayload({ registers: {}, memory: {} })).toEqual([]);
  });

  it("完整合成 VmState(8 字段)→ 恰一次共现命中", () => {
    const hits = scanCrossDomainPayload(syntheticVmStateObject());
    expect(hits.filter((hit) => hit.id === "ZR-B9-cooccurrence")).toHaveLength(1);
  });

  it("嵌套对象分别计量:顶层公开对象不因子对象字段而误计共现;子对象字段名键仍触发词边界模式", () => {
    const hits = scanCrossDomainPayload({
      projection: { revision: 0, status: "running" },
      nested: { instructionPointer: "0x0", callFrames: [] },
    });
    // 子对象仅 2 键:低于共现阈值;顶层不累计子树;instructionPointer 键名
    // 属 ZR-B9 词边界字段名模式(公开契约无此键,命中即越界)。
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B9-identifier"]);
    expect(hits[0]?.path).toBe("$/nested/instructionPointer");
  });
});

describe("ZR-B9 词边界模式(类型名 / 字段名 / crate 名)", () => {
  it.each([
    ["VmState", { VmState: "leaked" }],
    ["RuntimeConstraints", { note: "RuntimeConstraints dump" }],
    ["SeedState", { trace: "SeedState{..}" }],
    ["VirtualMemory", { VirtualMemory: [] }],
    ["VmEvent", { VmEvent: {} }],
    ["privateEventLog", { privateEventLog: [] }],
    ["seedState", { seedState: {} }],
    ["instructionPointer", { instructionPointer: "0x0" }],
    ["vm-engine", { crate: "vm-engine" }],
    ["vm-worker", { binary: "/app/bin/vm-worker" }],
    ["vm-core", { crate: "vm-core" }],
    ["vm-runtime", { crate: "vm-runtime" }],
    ["challenge-compiler", { crate: "challenge-compiler" }],
  ])("键名或字符串值携带 %s → ZR-B9-identifier 命中", (_token, payload) => {
    const hits = scanCrossDomainPayload(payload);
    expect(hits.map((hit) => hit.id)).toContain("ZR-B9-identifier");
  });

  it("词边界精度:包含性子串不误报(如 myVmStateX / seedStateful)", () => {
    expect(scanCrossDomainPayload({ note: "myVmStateX" })).toEqual([]);
    expect(scanCrossDomainPayload({ seedStateful: "ok" })).toEqual([]);
  });
});

describe("ZR-B10 完整事件日志形态(私有事件类别结构性无映射路径)", () => {
  it.each(PRIVATE_EVENT_KINDS)("私有事件类别 %s 经 kind 值出现 → 命中", (kind) => {
    const hits = scanCrossDomainPayload({ events: [{ seq: 0, kind }] });
    expect(hits.map((hit) => hit.id)).toContain("ZR-B10-private-event-form");
  });

  it("privateEventLog / eventLog 键出现 → 命中(完整事件日志形态)", () => {
    expect(scanCrossDomainPayload({ privateEventLog: [] }).map((hit) => hit.id)).toContain(
      "ZR-B10-private-event-form",
    );
    expect(scanCrossDomainPayload({ eventLog: [] }).map((hit) => hit.id)).toContain(
      "ZR-B10-private-event-form",
    );
  });

  it("公开事件六类(kind 小写)零命中", () => {
    const publicEvents = ["read", "write", "call", "ret", "syscall", "exception"].map((kind, seq) => ({
      seq,
      kind,
    }));
    expect(scanCrossDomainPayload({ publicEvents })).toEqual([]);
  });
});

describe("ZR-B5 快照魔数 / 版本头(密文与明文形态都不得上线)", () => {
  it(`密文魔数 ${SNAPSHOT_CIPHER_MAGIC} 出现 → 命中`, () => {
    const hits = scanCrossDomainPayload({ blob: `${SNAPSHOT_CIPHER_MAGIC}\u0001nonce...` });
    expect(hits.map((hit) => hit.id)).toContain("ZR-B5-snapshot-envelope");
  });

  it(`明文信封标记 ${SNAPSHOT_ENVELOPE_MARKER} 出现 → 命中`, () => {
    const hits = scanCrossDomainPayload({ snapshot: { form: `${SNAPSHOT_ENVELOPE_MARKER}/1` } });
    expect(hits.map((hit) => hit.id)).toContain("ZR-B5-snapshot-envelope");
  });

  it("普通字符串含 'SMEN' 子串之外的形态不受影响(词边界外的子串按越界处理)", () => {
    // SMEN 为四字节魔数,子串检测是刻意的(魔数不是冻结标识符字符集的合法片段)。
    expect(scanCrossDomainPayload({ form: "stackmaster-canonical-json/1" })).toEqual([]);
  });
});

describe("ZR-B4 私有题目包键名语料", () => {
  it.each([
    ["private-bundle", { "private-bundle": {} }],
    ["privateBundle", { privateBundle: { seedPolicy: {} } }],
    ["secretSinkRegisters", { secretSinkRegisters: [] }],
    ["declaredSeedPublicPaths", { declaredSeedPublicPaths: [] }],
    ["seedHex", { seedHex: "00" }],
    ["hiddenTests", { hiddenTests: [] }],
    ["judgingConfig", { judgingConfig: {} }],
    ["compiledIr", { compiledIr: {} }],
    ["entrypointAddressHex", { entrypointAddressHex: "0x0" }],
  ])("键名 %s → ZR-B4-bundle-key 命中", (_token, payload) => {
    expect(scanCrossDomainPayload(payload).map((hit) => hit.id)).toContain("ZR-B4-bundle-key");
  });

  it("公开契约合法键(label / visibleRegions / registers)零误报", () => {
    expect(scanCrossDomainPayload({ label: "寄存器", registers: [{ name: "RAX" }] })).toEqual([]);
  });
});

describe("ZR-B1 / ZR-B6 语料(复用 WP-3 scanSecretCorpus 模式,D-API-26)", () => {
  it("flag 语料 → ZR-B1 命中", () => {
    const hits = scanCrossDomainPayload({ message: "FLAG{synthetic_corpus}" });
    expect(hits.map((hit) => hit.id)).toContain("ZR-B1-flag-corpus");
  });

  it("seed 语料(32+ hex)→ ZR-B6 命中", () => {
    const hits = scanCrossDomainPayload({ seed: "00112233445566778899aabbccddeeff" });
    expect(hits.map((hit) => hit.id)).toContain("ZR-B6-seed-corpus");
  });

  it("服务端签发标识符键豁免:sessionId / requestId / checkpointId / jti 的 32-hex 形态不误报", () => {
    const hex = "0f4d9a2bc7e64d1f9c31ab20de55f801";
    expect(scanCrossDomainPayload({ sessionId: `sess-${hex}` })).toEqual([]);
    expect(scanCrossDomainPayload({ requestId: `req-${hex}` })).toEqual([]);
    expect(scanCrossDomainPayload({ checkpointId: hex })).toEqual([]);
    expect(scanCrossDomainPayload({ jti: hex })).toEqual([]);
  });

  it("公开十六进制载荷键豁免(bytesHex / payloadHex / valueHex);同值在非豁免键仍命中", () => {
    const hex = "00112233445566778899aabbccddeeff";
    expect(scanCrossDomainPayload({ bytesHex: hex })).toEqual([]);
    expect(scanCrossDomainPayload({ payloadHex: hex })).toEqual([]);
    expect(scanCrossDomainPayload({ valueHex: hex })).toEqual([]);
    expect(scanCrossDomainPayload({ seedEcho: hex }).map((hit) => hit.id)).toContain("ZR-B6-seed-corpus");
  });
});

describe("批量扫描与报告形态", () => {
  it("scanCrossDomainPayloads:批量录制集的命中携带 $<index> 路径前缀", () => {
    const hits = scanCrossDomainPayloads([{ ok: true }, { hiddenTests: [] }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("ZR-B4-bundle-key");
    expect(hits[0]?.path).toBe("$1/hiddenTests");
  });

  it("formatCrossDomainHits:报告行携带上游条目 ID(映射文档 §九扫描器纪律)", () => {
    const lines = formatCrossDomainHits(scanCrossDomainPayload({ hiddenTests: [] }));
    expect(lines).toEqual(["[ZR-B4-bundle-key] $/hiddenTests: \\bhiddenTests\\b"]);
  });
});
