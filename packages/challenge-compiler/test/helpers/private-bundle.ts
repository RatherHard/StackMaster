/**
 * 测试期私有判题包 builder 与双配对构造器。
 *
 * **私有包样例永不入 git**(CLAUDE.md 红线):全部私有样例由本 helper
 * 在测试进程内构造。基础判题包由公开描述包派生(身份字段、区域几何、
 * 非隐藏区域初始内容前缀、可见寄存器值与 FLAG 寄存器名镜像公开包),
 * 保证"公开值镜像私有初始态"按构造成立;隐藏面(秘密、判题条件、
 * 隐藏测试、IR / 入口、声明面)是私有包独有内容。
 *
 * 字节模式的代码区内容(token 流)属公开面(D2-CODE-PUBLIC:代码区
 * 非隐藏且进初始投影):配对构造器把程序字节写进公开包代码区
 * bytesHex 前缀与私有包 contentHex,双侧按构造一致。
 */

import type {
  EncodingTableEntry,
  PublicChallengeDescriptor,
} from "@stackmaster/challenge-schema";
import type {
  AuthorInterface,
  ConditionL1,
  CustomInstruction,
  IrInstruction,
  PrivateChallengeBundle,
  Stage,
} from "@stackmaster/challenge-schema/server-only";
import type { ChallengeLoadResult } from "../../src/index.js";
import { loadChallengePair } from "../../src/index.js";
import { CODE_START_HEX, REGION_BYTE_LENGTH, buildPublicDescriptor } from "./public-descriptor.js";

/** 红灯样例共用:深克隆双包 → 定向改字段 → 装载(类型断言绕过是受测形态)。 */
export type PairEdit = (clone: Record<string, unknown>) => void;

export function loadPairWithEdits(
  base: { publicDescriptor: unknown; privateBundle: unknown },
  editPublic?: PairEdit,
  editPrivate?: PairEdit,
): ChallengeLoadResult {
  const publicClone = JSON.parse(JSON.stringify(base.publicDescriptor)) as Record<string, unknown>;
  const privateClone = JSON.parse(JSON.stringify(base.privateBundle)) as Record<string, unknown>;
  editPublic?.(publicClone);
  editPrivate?.(privateClone);
  return loadChallengePair({ publicDescriptor: publicClone, privateBundle: privateClone });
}

/** 装载结果的 ruleId 集合(红灯断言用)。 */
export function violationRuleIds(result: ChallengeLoadResult): Set<string> {
  return new Set(
    result.ok ? [] : result.violations.map((item) => item.ruleId),
  );
}

const SECRET_FLAG_PLACEHOLDER = "FLAG{placeholder_do_not_ship}";
const SEED_HEX_FIXTURE = "00112233445566778899aabbccddeeff";

export interface IrProgramSpec {
  readonly instructions: readonly IrInstruction[];
  readonly labels?: readonly { readonly labelId: string; readonly instructionIndex: number }[];
  readonly entrypointIndex?: number;
}

export interface PairOptions {
  /** 目标模式(缺省按其余参数推断;buildBytePair 显式传 byte)。 */
  readonly mode?: "ir" | "byte";
  readonly archBits?: 32 | 64;
  /** IR 模式程序(缺省 = push RBP; mov RBP,RSP; ret,入口 0)。 */
  readonly irProgram?: IrProgramSpec;
  /** 字节模式程序字节(token 流,置于代码区入口偏移处)。 */
  readonly byteProgramHex?: string;
  /** 字节模式填充 token(缺省 NOP0 = 0x90)。 */
  readonly bytePadTokenHex?: string;
  /** 字节模式程序起始偏移(区域相对,缺省 0)。 */
  readonly byteEntryOffsetBytes?: number;
  /** 字节模式编码表(缺省 64 位默认表)。 */
  readonly byteEncodingTable?: readonly EncodingTableEntry[];
  readonly customInstructions?: readonly CustomInstruction[];
  readonly interfaces?: readonly AuthorInterface[];
  readonly stages?: readonly Stage[];
  readonly successCondition?: ConditionL1;
  /** 红灯样例:返回前对双包做定向破坏(mutate 收到本次构造的本地副本)。 */
  readonly mutate?: (
    pair: { publicDescriptor: PublicChallengeDescriptor; privateBundle: PrivateChallengeBundle },
  ) => void;
}

/** 缺省 IR 程序:完整栈帧闭环(push RBP / mov RBP,RSP / ret)。 */
function defaultIrProgram(): IrProgramSpec {
  return {
    entrypointIndex: 0,
    instructions: [
      { op: "push", operands: [{ kind: "register", name: "RBP" }] },
      {
        op: "mov",
        operands: [
          { kind: "register", name: "RBP" },
          { kind: "register", name: "RSP" },
        ],
      },
      { op: "ret", operands: [] },
    ],
    labels: [{ labelId: "entry", instructionIndex: 0 }],
  };
}

/** 缺省字节模式程序:push RBP; mov RBP,RSP; call 接口 0x100; leave; ret。 */
export function defaultByteProgramHex(): string {
  return "5589d4c9c3";
}

/** 缺省作者接口(0x100:授予虚拟文件)。 */
function defaultInterfaces(): AuthorInterface[] {
  return [
    {
      interfaceId: 0x100,
      displayText: "教学接口:授予解题笔记",
      effects: [{ effect: "grant_virtual_file", fileId: "win-notes" }],
    },
  ];
}

/** 缺省自定义指令(NOP0:全宽位掩蔽与 = 语义空操作;位宽随 archBits)。 */
function defaultCustomInstructions(archBits: 32 | 64): CustomInstruction[] {
  const fullMask = archBits === 32 ? "0xFFFFFFFF" : "0xFFFFFFFFFFFFFFFF";
  return [
    {
      mnemonic: "NOP0",
      displayText: "空操作(教学填充)",
      semantics: [
        { op: "bit_mask", dst: "RAX", src: "RAX", maskHex: fullMask, logic: "and" },
      ],
    },
  ];
}

function zeroHexBytes(byteCount: number): string {
  return "00".repeat(byteCount);
}

/**
 * 构造双包配对(IR / 字节双模式、32 / 64 位宽可参数化)。
 * 返回 unknown 形态(模拟跨包输入;红灯样例直接在回调内改字段)。
 */
export function buildChallengePair(options: PairOptions = {}): {
  publicDescriptor: unknown;
  privateBundle: unknown;
} {
  const mode = options.mode
    ?? (options.byteProgramHex !== undefined || options.byteEncodingTable !== undefined
      ? "byte"
      : "ir");
  const archBits = options.archBits ?? 64;

  const customInstructions = options.customInstructions ?? defaultCustomInstructions(archBits);
  const interfaces = options.interfaces ?? defaultInterfaces();

  let byteContentHex: string | undefined;
  let byteEntrypointHex: string | undefined;
  let byteEncodingTable: readonly EncodingTableEntry[] | undefined;

  if (mode === "byte") {
    byteEncodingTable = options.byteEncodingTable ?? undefined; // undefined ⇒ 公开包用默认表
    const programHex = options.byteProgramHex ?? defaultByteProgramHex();
    const padTokenRaw = (options.bytePadTokenHex ?? "0x90").toLowerCase();
    const padToken = padTokenRaw.startsWith("0x") ? padTokenRaw.slice(2) : padTokenRaw;
    const entryOffset = options.byteEntryOffsetBytes ?? 0;
    const programBytes = programHex.length / 2;
    const programEnd = entryOffset + programBytes;
    if (programEnd > REGION_BYTE_LENGTH) {
      throw new Error("测试程序字节越出代码区");
    }
    byteContentHex =
      zeroHexBytes(entryOffset) + programHex + padToken.repeat(REGION_BYTE_LENGTH - programEnd);
    byteEntrypointHex = `0x${(BigInt(CODE_START_HEX) + BigInt(entryOffset)).toString(16)}`;
  }

  const publicDescriptor = buildPublicDescriptor({
    mode,
    archBits,
    ...(byteEncodingTable !== undefined ? { encodingTable: byteEncodingTable } : {}),
    // 代码区内容属公开面:初始投影 bytesHex = 私有 contentHex 同长前缀(16 字节)。
    ...(byteContentHex !== undefined ? { codeRegionBytesHex: byteContentHex.slice(0, 32) } : {}),
  });

  const visibleRegionById = new Map(
    publicDescriptor.initialProjection.visibleRegions.map((region) => [region.regionId, region]),
  );

  const memoryRegions = publicDescriptor.memoryLayout.regions.map((region) => {
    const projected = visibleRegionById.get(region.regionId);
    const prefixBytes = projected !== undefined ? projected.bytesHex.length / 2 : 0;
    const content = region.regionId === "code" && byteContentHex !== undefined
      ? byteContentHex
      : (projected?.bytesHex ?? "") + zeroHexBytes(region.byteLength - prefixBytes);
    return {
      regionId: region.regionId,
      kind: region.kind,
      startAddressHex: region.startAddressHex,
      byteLength: region.byteLength,
      permissions: region.permissions,
      contentHex: content,
      isHidden: false,
    };
  });

  const registers: Record<string, string> = {};
  for (const register of publicDescriptor.initialProjection.visibleRegisters) {
    registers[register.name] = register.valueHex;
  }
  for (const flagName of publicDescriptor.vmProfile.flagRegisterNames ?? []) {
    registers[flagName] = "0x0";
  }

  const irProgram = options.irProgram ?? defaultIrProgram();

  const bundle: PrivateChallengeBundle = {
    schemaVersion: 1,
    challengeId: publicDescriptor.challengeId,
    challengeContentVersion: publicDescriptor.challengeContentVersion,
    vmProfileVersion: publicDescriptor.vmProfileVersion,
    dslSchemaVersion: 2,
    vmEngineVersion: "0.1.0",
    declaredSeedPublicPaths: [],
    seedPolicy: { strategy: "fixed", seedHex: SEED_HEX_FIXTURE },
    initialState: { registers, memoryRegions },
    secrets: {
      flag: SECRET_FLAG_PLACEHOLDER,
      virtualFiles: [
        { fileId: "win-notes", content: "ret2win 解题笔记(私有判题面,仅服务端可见)。" },
      ],
    },
    privateObjects: [
      {
        objectId: "input-buffer",
        kind: "buffer",
        addressHex: publicDescriptor.initialProjection.semanticHighlights?.[0]?.startAddressHex ?? "0x0",
        byteLength: publicDescriptor.initialProjection.semanticHighlights?.[0]?.byteLength ?? 16,
        visibility: "public",
        containsSecret: false,
      },
    ],
    judging: {
      successCondition: options.successCondition ?? {
        all: [
          {
            all: [
              {
                predicate: {
                  type: "ret_target_equals",
                  addressHex: "0x400200",
                },
              },
            ],
          },
        ],
      },
      hiddenTests: [
        {
          testId: "payload-short",
          kind: "reference_payload",
          payloadHex: "41".repeat(8),
          expectedResult: "wrong_answer",
        },
      ],
    },
    ...(options.stages !== undefined ? { stages: [...options.stages] } : {}),
    ...(mode === "byte"
      ? { entrypointAddressHex: byteEntrypointHex }
      : {
          compiledIr: {
            irFormatVersion: 2,
            entrypointIndex: irProgram.entrypointIndex ?? 0,
            instructions: [...irProgram.instructions],
            labels: [...(irProgram.labels ?? [])],
          },
        }),
    customInstructions: [...customInstructions],
    interfaces: [...interfaces],
    judgingConfig: {
      verdictRuleVersion: "1.0.0",
      maxPredicateEvalSteps: 10000,
      timeoutMsPerAction: 5000,
    },
  };

  const pair = { publicDescriptor, privateBundle: bundle };
  options.mutate?.(pair);
  return { publicDescriptor, privateBundle: bundle };
}

/** 便捷重载:IR 模式配对(类型面更直白)。 */
export function buildIrPair(options: Omit<PairOptions, "byteProgramHex" | "byteEncodingTable" | "bytePadTokenHex" | "byteEntryOffsetBytes" | "mode"> = {}): {
  publicDescriptor: unknown;
  privateBundle: unknown;
} {
  return buildChallengePair({ ...options, mode: "ir" });
}

/** 便捷重载:字节模式配对(缺省程序 / 编码表 / 填充 token)。 */
export function buildBytePair(options: Omit<PairOptions, "irProgram" | "mode"> = {}): {
  publicDescriptor: unknown;
  privateBundle: unknown;
} {
  return buildChallengePair({ ...options, mode: "byte" });
}
