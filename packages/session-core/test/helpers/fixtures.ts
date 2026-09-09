/**
 * 测试夹具(WP-8):生命周期题目双包(与 vm-worker Rust 侧
 * `tests/session_lifecycle.rs` 同一题目的 TS 形态)。
 *
 * 私有样例测试期现场构造,**永不入 git**(秘密为合成占位字节,非真实
 * 题目内容;沿 WP-1 起的 fixture 纪律)。
 */

export const BUFFER_BASE = "0x20000000";

function zeroHex(bytes: number): string {
  return "00".repeat(bytes);
}

/** 生命周期题目:buffer(可见)与 secret(隐藏)相邻;成功条件 RAX == 0x41。 */
export function lifecycleBundle(): Record<string, unknown> {
  const codeContent = `${"c3"}${"00".repeat(4095)}`;
  return {
    schemaVersion: 1,
    challengeId: "wp8-lifecycle",
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    dslSchemaVersion: 2,
    vmEngineVersion: process.env.STACKMASTER_ENGINE_VERSION ?? "0.1.0",
    declaredSeedPublicPaths: [],
    seedPolicy: {
      strategy: "fixed",
      seedHex: "00112233445566778899aabbccddeeff",
    },
    initialState: {
      registers: {
        RSP: "0x7ffff008",
        RBP: "0x7ffff008",
        RIP: "0x0",
        RAX: "0x0",
      },
      memoryRegions: [
        { regionId: "code", kind: "code", startAddressHex: "0x401000", byteLength: 4096, permissions: "rx", contentHex: codeContent, isHidden: false },
        { regionId: "buffer", kind: "heap", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: false },
        { regionId: "secret", kind: "key", startAddressHex: "0x20001000", byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: true },
        { regionId: "stack", kind: "stack", startAddressHex: "0x7ffff000", byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: false },
      ],
    },
    secrets: { flag: "FLAG{lifecycle-demo}", virtualFiles: [] },
    privateObjects: [],
    judging: {
      successCondition: {
        all: [{ all: [{ predicate: { type: "register_equals", register: "RAX", valueHex: "0x41" } }] }],
      },
    },
    compiledIr: {
      irFormatVersion: 2,
      entrypointIndex: 0,
      instructions: [{ op: "ret", operands: [] }],
      labels: [],
    },
    judgingConfig: { verdictRuleVersion: "1.0.0", maxPredicateEvalSteps: 10000 },
  };
}

/** 公开描述包(布局 = 可见区域集合,声明序)。 */
export function lifecycleDescriptor(): Record<string, unknown> {
  const codeWindow = `${"c3"}${"00".repeat(255)}`;
  return {
    schemaVersion: 1,
    challengeId: "wp8-lifecycle",
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "生命周期教学题",
      summary: "写缓冲区、建立检查点、回退与重置的全链路演示。",
      learningObjectives: ["理解会话时间线"],
    },
    vmProfile: {
      registers: [{ name: "RSP" }, { name: "RBP" }, { name: "RIP" }, { name: "RAX" }],
      flagRegisterNames: ["FLAG_SYS"],
      endianness: "little",
      archBits: 32,
      pageSizeBytes: 4096,
      canary: { enabled: false },
    },
    memoryLayout: {
      regions: [
        { regionId: "code", kind: "code", startAddressHex: "0x401000", byteLength: 4096, permissions: "rx", publicLabel: "代码区" },
        { regionId: "buffer", kind: "heap", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", publicLabel: "缓冲区" },
        { regionId: "stack", kind: "stack", startAddressHex: "0x7ffff000", byteLength: 4096, permissions: "rw", publicLabel: "栈" },
      ],
    },
    allowedActions: [
      "write_bytes", "push", "pop", "call", "ret", "step", "run_to_event",
      "pause", "undo", "checkout_checkpoint", "reset", "create_checkpoint",
    ],
    resourceLimits: {},
    hintLadder: [],
    publicErrorMapping: [],
    initialProjection: {
      visibleRegions: [
        { regionId: "code", label: "代码区", startAddressHex: "0x401000", byteLength: 4096, permissions: "rx", bytesHex: codeWindow, truncated: true },
        { regionId: "buffer", label: "缓冲区", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", bytesHex: zeroHex(256), truncated: true },
        { regionId: "stack", label: "栈", startAddressHex: "0x7ffff000", byteLength: 4096, permissions: "rw", bytesHex: zeroHex(256), truncated: true },
      ],
      visibleRegisters: [
        { name: "RSP", valueHex: "0x7FFFF008" },
        { name: "RBP", valueHex: "0x7FFFF008" },
        { name: "RIP", valueHex: "0x0" },
        { name: "RAX", valueHex: "0x0" },
      ],
    },
  };
}
