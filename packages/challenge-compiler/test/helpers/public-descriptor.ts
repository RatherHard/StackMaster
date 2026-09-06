/**
 * 测试期公开描述包 builder(挑战编译器测试矩阵)。
 *
 * 公开描述包可入 git(公开面),但测试全部由 builder 现场构造,以便
 * 参数化 32 / 64 位宽与 IR / 字节双模式;红灯样例通过对返回对象做
 * 定向破坏(直接改字段后传给装载管线,类型断言绕过是红灯样例的
 * 预期形态——检查器纵深防御的受测面)。
 */

import type {
  EncodingTableEntry,
  EncodingOperandShape,
  PublicChallengeDescriptor,
} from "@stackmaster/challenge-schema";

/** 默认代码区起始地址(两模式一致)。 */
export const CODE_START_HEX = "0x400000";
/** 默认栈区起始地址(64 位形态)。 */
export const STACK_START_HEX_64 = "0x7ffff000";
/** 默认栈区起始地址(32 位形态)。 */
export const STACK_START_HEX_32 = "0x7fff000";
export const REGION_BYTE_LENGTH = 4096;

const WIN_TARGET_ADDRESS_HEX = "0x400200";

/** 64 位字节模式默认编码表(token ↔ 指令字典;ISA 公开面)。 */
export function defaultByteEncodingTable(): EncodingTableEntry[] {
  const operands = (shapes: EncodingOperandShape[]) => shapes;
  return [
    { tokenHex: "0x55", op: "push", operands: operands([{ kind: "register", name: "RBP" }]) },
    { tokenHex: "0x58", op: "pop", operands: operands([{ kind: "register", name: "RBP" }]) },
    {
      tokenHex: "0x89",
      op: "mov",
      operands: operands([
        { kind: "register", name: "RBP" },
        { kind: "register", name: "RSP" },
      ]),
    },
    {
      tokenHex: "0xb8",
      op: "mov",
      operands: operands([
        { kind: "register", name: "RAX" },
        { kind: "immediate", width: "arch" },
      ]),
    },
    { tokenHex: "0xc9", op: "leave" },
    { tokenHex: "0xc3", op: "ret" },
    { tokenHex: "0x74", op: "je", operands: operands([{ kind: "immediate", width: "arch" }]) },
    {
      tokenHex: "0x83",
      op: "cmp",
      operands: operands([
        { kind: "register", name: "RAX" },
        { kind: "immediate", width: "arch" },
      ]),
    },
    { tokenHex: "0xe8", op: "call", operands: operands([{ kind: "immediate", width: "arch" }]) },
    { tokenHex: "0xe9", op: "jmp", operands: operands([{ kind: "immediate", width: "arch" }]) },
    {
      tokenHex: "0xd4",
      op: "call",
      operands: operands([{ kind: "interface", interfaceId: 0x100 }]),
    },
    { tokenHex: "0xcd", op: "syscall", operands: operands([{ kind: "immediate", width: "arch" }]) },
    { tokenHex: "0x90", op: "NOP0" },
  ];
}

export interface PublicDescriptorOptions {
  readonly mode: "ir" | "byte";
  readonly archBits?: 32 | 64;
  /** 字节模式编码表(缺省 = 64 位默认表)。 */
  readonly encodingTable?: readonly EncodingTableEntry[];
  readonly challengeId?: string;
  /** 代码区初始投影前缀 bytesHex(字节模式 = token 流前缀;缺省全零前缀)。 */
  readonly codeRegionBytesHex?: string;
}

/**
 * 构造合法公开描述包(IR / 字节双模式;32 / 64 位宽可参数化)。
 * canary 默认关闭(canary 相关红灯样例不属本包受测面)。
 */
export function buildPublicDescriptor(options: PublicDescriptorOptions): PublicChallengeDescriptor {
  const archBits = options.archBits ?? 64;
  const stackStart = archBits === 32 ? STACK_START_HEX_32 : STACK_START_HEX_64;
  const regions = [
    {
      regionId: "code",
      kind: "code" as const,
      startAddressHex: CODE_START_HEX,
      byteLength: REGION_BYTE_LENGTH,
      permissions: options.mode === "byte" ? "rx" : "rx",
      publicLabel: "代码段",
    },
    {
      regionId: "stack",
      kind: "stack" as const,
      startAddressHex: stackStart,
      byteLength: REGION_BYTE_LENGTH,
      permissions: "rw",
      publicLabel: "栈",
    },
  ];
  const visibleRegions = regions.map((region) => ({
    regionId: region.regionId,
    label: region.publicLabel,
    startAddressHex: region.startAddressHex,
    byteLength: region.byteLength,
    permissions: region.permissions,
    // 初始投影只带前缀(非空、偶长、≤ 512 hex);truncated 语义一致。
    bytesHex: region.kind === "code" && options.codeRegionBytesHex !== undefined
      ? options.codeRegionBytesHex
      : "00".repeat(16),
    truncated: true,
  }));

  return {
    schemaVersion: 1,
    challengeId: options.challengeId ?? "ret-basics",
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "返回地址覆写入门(编译器测试)",
      summary: "编译器测试用的最小双包:栈帧闭环与控制流劫持因果链。",
      learningObjectives: ["理解栈帧布局", "理解返回地址被覆写的后果"],
    },
    vmProfile: {
      registers: [
        { name: "RAX", displayLabel: "通用累加器" },
        { name: "RSP", displayLabel: "栈顶指针" },
        { name: "RBP", displayLabel: "栈帧基址" },
        { name: "RIP", displayLabel: "指令指针" },
      ],
      flagRegisterNames: ["FLAG0"],
      endianness: "little",
      pageSizeBytes: 4096,
      archBits,
      canary: { enabled: false },
      ...(options.mode === "byte"
        ? { encodingTable: [...(options.encodingTable ?? defaultByteEncodingTable())] }
        : {}),
    },
    memoryLayout: { regions },
    allowedActions: ["write_bytes", "push", "pop", "ret", "step", "call", "run_to_event"],
    resourceLimits: {
      predicateEvalBudgetPerSession: 10000,
      rollbackBudgetPerSession: 200,
      maxWriteBytesPerAction: 64,
    },
    hintLadder: [
      {
        order: 1,
        revealPolicy: "on_request" as const,
        hintText: "观察 canary 槽与返回地址槽在栈帧中的相对位置。",
      },
    ],
    publicErrorMapping: [
      {
        errorCode: "offset_out_of_range" as const,
        teachingNote: "写入越过区域边界:检查偏移与字节长度。",
      },
    ],
    initialProjection: {
      visibleRegions,
      visibleRegisters: [
        { name: "RSP", valueHex: archBits === 32 ? "0x7FFFEFF8" : "0x7FFFFFF8" },
        { name: "RBP", valueHex: archBits === 32 ? "0x7FFFEFF8" : "0x7FFFFFF8" },
        { name: "RIP", valueHex: "0x400100" },
        { name: "RAX", valueHex: "0x0" },
      ],
      semanticHighlights: [
        {
          kind: "buffer_start" as const,
          targetRegionId: "stack",
          startAddressHex: stackStart,
          byteLength: 16,
          label: "输入缓冲区",
        },
      ],
    },
  };
}

/** 谓词/隐藏测试共用的 win 目标地址(ret_target_equals;无区域绑定检查)。 */
export function winTargetAddressHex(): string {
  return WIN_TARGET_ADDRESS_HEX;
}
