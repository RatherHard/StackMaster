/**
 * 生命周期教学题目 fixture(Compose 全拓扑集成专用;WP-7,D-API-64)。
 *
 * 形态与 vm-engine/vm-worker/tests/session_lifecycle.rs 的 `lifecycle_bundle` /
 * `lifecycle_descriptor` 同一常量面(32 位 IR 模式;RIP = 0,IR 指令索引语义;
 * buffer(可见)与 secret(隐藏)相邻;成功条件 RAX == 0x41——本链路不触发)。
 * 内容全部为合成占位(FLAG{lifecycle} 为引擎测试同款占位,非真实秘密);
 * 选择它是因为真实 vm-worker 的装配器 / 判题装配器会按冻结契约拒绝
 * challenge-compiler 测试 helper 的最小 IR 对(IR 入口索引与地址语义冲突),
 * 而本 fixture 是引擎侧已验证的合法装载形态。
 */

const A32_REGION = 4096;
const CODE_BASE = "0x401000";
const BUFFER_BASE = "0x20000000";
const SECRET_BASE = "0x20001000";
const STACK_BASE = "0x7ffff000";

const zeroHex = (bytes: number): string => "00".repeat(bytes);
const codeContent = "c3" + "00".repeat(A32_REGION - 1); // ret 占位;IR 模式不译码

/** 私有判题包(整体 SERVER_ONLY;合成占位内容)。 */
export function lifecycleBundle(challengeId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    challengeId,
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    dslSchemaVersion: 2,
    vmEngineVersion: "0.1.0",
    declaredSeedPublicPaths: [],
    seedPolicy: { strategy: "fixed", seedHex: "00112233445566778899aabbccddeeff" },
    initialState: {
      // FLAG_SYS 是公开 flagRegisterNames 声明的 FLAG 寄存器,必须同时存在
      // 于私有初始寄存器集(XS-REG-FLAG;challenge-compiler 装载管线强制)。
      registers: { RSP: "0x7ffff008", RBP: "0x7ffff008", RIP: "0x0", RAX: "0x0", FLAG_SYS: "0x0" },
      memoryRegions: [
        { regionId: "code", kind: "code", startAddressHex: CODE_BASE, byteLength: 4096, permissions: "rx", contentHex: codeContent, isHidden: false },
        { regionId: "buffer", kind: "heap", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: false },
        { regionId: "secret", kind: "key", startAddressHex: SECRET_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: true },
        { regionId: "stack", kind: "stack", startAddressHex: STACK_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: false },
      ],
    },
    secrets: { flag: "FLAG{lifecycle}", virtualFiles: [] },
    privateObjects: [],
    judging: {
      successCondition: {
        all: [{ all: [{ predicate: { type: "register_equals", register: "RAX", valueHex: "0x41" } }] }],
      },
    },
    compiledIr: { irFormatVersion: 2, entrypointIndex: 0, instructions: [{ op: "ret", operands: [] }], labels: [] },
    judgingConfig: { verdictRuleVersion: "1.0.0", maxPredicateEvalSteps: 10000 },
  };
}

/** 公开描述包(同一题目;布局 = 可见区域集合,声明序)。 */
export function lifecycleDescriptor(challengeId: string): Record<string, unknown> {
  const codeWindow = "c3" + "00".repeat(255);
  return {
    schemaVersion: 1,
    challengeId,
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
        { regionId: "code", kind: "code", startAddressHex: CODE_BASE, byteLength: 4096, permissions: "rx", publicLabel: "代码区" },
        { regionId: "buffer", kind: "heap", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", publicLabel: "缓冲区" },
        { regionId: "stack", kind: "stack", startAddressHex: STACK_BASE, byteLength: 4096, permissions: "rw", publicLabel: "栈" },
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
        { regionId: "code", label: "代码区", startAddressHex: CODE_BASE, byteLength: 4096, permissions: "rx", bytesHex: codeWindow, truncated: true },
        { regionId: "buffer", label: "缓冲区", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", bytesHex: zeroHex(256), truncated: true },
        { regionId: "stack", label: "栈", startAddressHex: STACK_BASE, byteLength: 4096, permissions: "rw", bytesHex: zeroHex(256), truncated: true },
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

/** 可写教学地址(栈区起点;32 位档)。 */
export const LIFECYCLE_STACK_ADDRESS = STACK_BASE;
