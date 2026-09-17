/**
 * 演示 / E2E 题目(生命周期教学题)双包夹具 —— **合成夹具,仅供测试**。
 *
 * ⚠ 本文件是测试夹具:含 `FLAG{lifecycle}` **合成占位**(引擎测试同款占位,
 * **非真实秘密**,零真实隐藏 flag、零真实私有对象),按本仓纪律「私有包样例
 * 一律由 helper 在测试进程内构造、永不入库成品样本」放在 `test/` 下,
 * 不得被生产源码 import,也不随镜像发布。
 *
 * # 为什么需要它(中期 WP-76 缺陷 2)
 *
 * 调试档在真机失败的根因不在调试通道实现,而在**演示 / E2E 拓扑所登记题目的
 * 形态**:该题原为 IR 模式,而调试变体契约不携带程序 IR / 入口声明面
 * (ADR-DC1 条款 2:调试实例恒字节模式装配;`vm-engine/vm-worker/src/session/
 * variant.rs` 模块文档「程序形态边界」)⇒ challenge-compiler
 * `buildDebugVariantBundle` **确定性拒绝**(`XC-DEBUG-MODE-IR`),`debug_attach`
 * 在真机恒失败,而全部 Node 测试全绿(既有用例要么走占位变体供给,要么把 IR
 * 拒绝当作**期望**行为)。
 *
 * 本夹具是「演示题应当具备的形态」的可执行声明面,配合同目录回归用例
 * `test/debug/demo-challenge-debug-capability.test.ts` 在生产变体供给路径上
 * 锚定两个必要条件;生产侧的落地面 = `k6/seed-challenge.mjs`(该文件同时被
 * 用例的**防漂移机检面**约束,见用例文件头)。
 *
 * # 程序形态:字节模式(必要条件一)
 *
 * 编码表覆盖代码区**全部字节**(0x00 填充 = mov RAX,RAX;入口 0xc3 = ret),
 * 程序以 `entrypointAddressHex` 声明(XS-PROG-MODE 双形态恰一;无 `compiledIr`)。
 *
 * # 初始 RIP 必须落在可执行区域(必要条件二,真机实测)
 *
 * 调试实例的指令指针 = 变体 `registers.RIP`(`variant.rs`:入口 = 初始 RIP),
 * 而指令流只在**暂停时**按暂停落点下发(调试通道协议语义 §九)。RIP = 0x0
 * 的镜像不落在任何区域 ⇒ 暂停落点无覆盖、指令视图恒空。故公开可见寄存器与
 * 私有初始寄存器的 RIP **同时**对齐到代码区入口(XS-PROJ-VALUES 要求两者
 * 一致),与 `test/routes/helpers/session-rig.ts:registerByteChallenge` 的
 * 「初始 RIP 对齐字节程序入口」同款纪律。
 *
 * # 为什么不复用 `test/compose/helpers/lifecycle-challenge.ts`
 *
 * 两条**硬理由**:
 *  ①该份是 **IR 模式**(`compiledIr` + 入口**索引** 0)形态,与调试变体契约
 *    不兼容 —— 它服务 compose 集成测试的 **IR 装载路径**覆盖面,刻意保持 IR,
 *    不能改成字节模式(改了 = 丢掉 IR 装载路径的真机覆盖面);
 *  ②该份的私有 `RIP` 是对指令**索引**语义(`0x0`),而地址型运行时要求的是
 *    **代码区地址**;直接把 IR 那份的 RIP 抄成地址会同时破坏索引语义 ⇒ 两份
 *    不可互换。
 * 差异仅限程序形态与初始 RIP:区域几何、寄存器值、判题条件、秘密占位逐字段
 * 与 `k6/seed-challenge.mjs` 登记面一致(IR `[ret]` ⇔ 字节 `c3` = ret,语义等价)。
 */

/** 内容版本(与既有登记面同值;版本不可变 ⇒ 改内容须换版本或清卷重登记)。 */
export const LIFECYCLE_CHALLENGE_CONTENT_VERSION = "1.0.0";

/** 代码区起点(入口地址;E2E 断点 / 跳转链锚点常量同值)。 */
export const LIFECYCLE_CHALLENGE_CODE_BASE = "0x401000";
/** 缓冲区起点(公开可写区)。 */
export const LIFECYCLE_CHALLENGE_BUFFER_BASE = "0x20000000";
/** 隐藏秘密区起点(私有包 isHidden;调试变体由调试种子派生内容)。 */
export const LIFECYCLE_CHALLENGE_SECRET_BASE = "0x20001000";
/** 栈区起点(E2E 栈顶常量同值)。 */
export const LIFECYCLE_CHALLENGE_STACK_BASE = "0x7ffff000";
/** 区域字节长度(页对齐;公开 / 私有同值)。 */
export const LIFECYCLE_CHALLENGE_REGION_BYTES = 4096;

function zeroHex(bytes: number): string {
  return "00".repeat(bytes);
}

/** 代码区内容:入口 0xc3(ret)+ 0x00 填充(编码表须覆盖全部字节)。 */
function codeContentHex(): string {
  return "c3" + zeroHex(LIFECYCLE_CHALLENGE_REGION_BYTES - 1);
}

/**
 * 私有判题包(owner:server-only;内容全为合成占位,零真实秘密)。
 *
 * @param challengeId 题目 ID(每用例唯一;E2E 隔离纪律)。
 */
export function buildLifecyclePrivateBundle(challengeId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    challengeId,
    challengeContentVersion: LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    vmProfileVersion: "1.0.0",
    dslSchemaVersion: 2,
    vmEngineVersion: "0.1.0",
    declaredSeedPublicPaths: [],
    seedPolicy: { strategy: "fixed", seedHex: "00112233445566778899aabbccddeeff" },
    initialState: {
      registers: {
        RSP: "0x7ffff008",
        RBP: "0x7ffff008",
        // 字节模式:指令指针 = 代码区入口(见模块文档)。
        RIP: LIFECYCLE_CHALLENGE_CODE_BASE,
        RAX: "0x0",
        FLAG_SYS: "0x0",
      },
      memoryRegions: [
        {
          regionId: "code",
          kind: "code",
          startAddressHex: LIFECYCLE_CHALLENGE_CODE_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rx",
          contentHex: codeContentHex(),
          isHidden: false,
        },
        {
          regionId: "buffer",
          kind: "heap",
          startAddressHex: LIFECYCLE_CHALLENGE_BUFFER_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          contentHex: zeroHex(LIFECYCLE_CHALLENGE_REGION_BYTES),
          isHidden: false,
        },
        {
          regionId: "secret",
          kind: "key",
          startAddressHex: LIFECYCLE_CHALLENGE_SECRET_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          contentHex: zeroHex(LIFECYCLE_CHALLENGE_REGION_BYTES),
          isHidden: true,
        },
        {
          regionId: "stack",
          kind: "stack",
          startAddressHex: LIFECYCLE_CHALLENGE_STACK_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          contentHex: zeroHex(LIFECYCLE_CHALLENGE_REGION_BYTES),
          isHidden: false,
        },
      ],
    },
    secrets: { flag: "FLAG{lifecycle}", virtualFiles: [] },
    privateObjects: [],
    judging: {
      successCondition: {
        all: [{ all: [{ predicate: { type: "register_equals", register: "RAX", valueHex: "0x41" } }] }],
      },
    },
    // 字节模式:以入口地址声明程序形态(XS-PROG-MODE 双形态恰一;无 compiledIr)。
    entrypointAddressHex: LIFECYCLE_CHALLENGE_CODE_BASE,
    judgingConfig: { verdictRuleVersion: "1.0.0", maxPredicateEvalSteps: 10000 },
  };
}

/**
 * 公开描述包(WP-54 正式下发形态的最小面;内容占位零秘密)。
 *
 * @param challengeId 题目 ID(与私有包同值)。
 */
export function buildLifecyclePublicDescriptor(challengeId: string): Record<string, unknown> {
  const codeWindow = "c3" + zeroHex(255);
  return {
    schemaVersion: 1,
    challengeId,
    challengeContentVersion: LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "k6 基线压测题",
      summary: "可观测基线首采的负载题目(生命周期教学题同源形态)。",
      learningObjectives: ["理解会话时间线"],
    },
    vmProfile: {
      registers: [{ name: "RSP" }, { name: "RBP" }, { name: "RIP" }, { name: "RAX" }],
      flagRegisterNames: ["FLAG_SYS"],
      endianness: "little",
      archBits: 32,
      pageSizeBytes: 4096,
      canary: { enabled: false },
      // XS-PROG-MODE 判据:encodingTable 在场 ⇒ 字节模式。覆盖代码区全部字节
      // (0x00 填充 + 入口 0xc3),否则装载期探测译码 XS-ENC-PROBE 拒绝。
      encodingTable: [
        {
          tokenHex: "0x00",
          op: "mov",
          operands: [
            { kind: "register", name: "RAX" },
            { kind: "register", name: "RAX" },
          ],
        },
        { tokenHex: "0xc3", op: "ret" },
      ],
    },
    memoryLayout: {
      regions: [
        {
          regionId: "code",
          kind: "code",
          startAddressHex: LIFECYCLE_CHALLENGE_CODE_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rx",
          publicLabel: "代码区",
        },
        {
          regionId: "buffer",
          kind: "heap",
          startAddressHex: LIFECYCLE_CHALLENGE_BUFFER_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          publicLabel: "缓冲区",
        },
        {
          regionId: "stack",
          kind: "stack",
          startAddressHex: LIFECYCLE_CHALLENGE_STACK_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          publicLabel: "栈",
        },
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
        {
          regionId: "code",
          label: "代码区",
          startAddressHex: LIFECYCLE_CHALLENGE_CODE_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rx",
          bytesHex: codeWindow,
          truncated: true,
        },
        {
          regionId: "buffer",
          label: "缓冲区",
          startAddressHex: LIFECYCLE_CHALLENGE_BUFFER_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          bytesHex: zeroHex(256),
          truncated: true,
        },
        {
          regionId: "stack",
          label: "栈",
          startAddressHex: LIFECYCLE_CHALLENGE_STACK_BASE,
          byteLength: LIFECYCLE_CHALLENGE_REGION_BYTES,
          permissions: "rw",
          bytesHex: zeroHex(256),
          truncated: true,
        },
      ],
      // XS-PROJ-VALUES:公开可见值必须镜像私有初始值 ⇒ RIP 与私有包同址。
      visibleRegisters: [
        { name: "RSP", valueHex: "0x7FFFF008" },
        { name: "RBP", valueHex: "0x7FFFF008" },
        { name: "RIP", valueHex: "0x401000" },
        { name: "RAX", valueHex: "0x0" },
      ],
    },
  };
}

/** 双包配对便捷入口(seed 与回归测试共用;两次构造互不共享可变状态)。 */
export function buildLifecycleChallengePair(challengeId: string): {
  readonly privateBundle: Record<string, unknown>;
  readonly publicDescriptor: Record<string, unknown>;
} {
  return {
    privateBundle: buildLifecyclePrivateBundle(challengeId),
    publicDescriptor: buildLifecyclePublicDescriptor(challengeId),
  };
}
