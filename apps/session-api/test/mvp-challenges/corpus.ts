/**
 * MVP 题目集语料(WP-68;6~10 道渐进式题目的制作源,主控定案 = 8 道)。
 *
 * # 制作管线(沿既有语料先例,零第二目录体系)
 *
 *   本模块(DSL 源,构造式)→ loadChallengePair(Schema + 字段分类检查器 +
 *   编译期校验,mvp-challenge-set.test.ts 门禁)→ canonicalDigests(规范化
 *   JSON 摘要,D-API-23 登记哈希输入)→ compose 套件经 ChallengeRegistrar
 *   真实登记 + 发布演示(Ed25519 签发链路)。
 *
 * 私有判题包内容**永不入 git**(CLAUDE.md 红线):全部私有语料由本模块在
 * 进程内构造(沿 `test/compose/helpers/lifecycle-challenge.ts` 与
 * challenge-compiler test helpers 的既有形态);公开描述包与私有包由同一
 * 构造器按"公开值镜像私有初始态"成对产出,保证 I2-PUB-MIRROR /
 * XS-PROJ-VALUES 按构造成立。
 *
 * # 渐进式梯度(11.1:栈帧 / buffer / return address 闭环)
 *
 *   CH-01 write-basics     IR   可见内存与 write_bytes(权限与错误可解释)
 *   CH-02 little-endian    IR   小端序观察(push)与"值 ≠ 地址"
 *   CH-03 frame-layout     IR   栈帧布局算术:saved RBP 与返回地址槽位
 *   CH-04 buffer-overflow  IR   连续溢出覆写返回地址(payload 构造)
 *   CH-05 canary-guard     IR   栈保护(金丝雀)语义:精准绕过 vs 连续溢出
 *   CH-06 ret2win-byte     字节  字节模式:真实地址语义下的 ret2win
 *   CH-07 hidden-vault     字节  隐藏区域 + 虚拟文件 flag(作者接口)+ ZR-B13 派生面
 *   CH-08 full-chain       字节  两阶段状态机 + 全要素组合闭环
 *
 * # 隐藏测试边界(v1,D-H2)
 *
 * 当前 v1 隐藏测试 = predicate_probe(载荷空,无输入槽):每题的隐藏测试 =
 * 对 successCondition 的终态探针(判题语义规约 §七,答案册语义)。
 *
 * # canary 契约现状(制作期发现,D-API-109 如实登记)
 *
 * XS-CANARY-CORR(检查器:启用 canary ⇒ hidden + containsSecret 的 canary
 * 对象且与公开区域不相交)与引擎装配(build_canary_slots:canary 对象必须
 * visibility = public)在冻结契约下结构性不相容 ⇒ **交互可玩题不能启用
 * canary**。处置:①CH-05 以"守护标记 + memory_equals 谓词"承担金丝雀教学;
 * ②CH-07 派生面(`zrB13FixturePair`,不做交互装载)携带隐藏区域 + canary
 * 槽,承载 ZR-B13 非平凡复算 fixture(阶段四移交 §六.8);契约收口归
 * WP-1 §1.3(本包不改契约)。
 *
 * # D-J8 口径(主控裁决,D-API-108)
 *
 * 全部题目 `aslrEnabled` 缺省(false):v1 真实实例维持固定基址,ASLR 仅
 * 调试实例兄弟形态。
 */
import type { ActionObject } from "@stackmaster/protocol";
import { canonicalize } from "@stackmaster/protocol";
import { createHash } from "node:crypto";
import { loadChallengePair, type ChallengeLoadResult } from "@stackmaster/challenge-compiler";

/** 语料条目:一组可重放的会话动作脚本 + 预期交互终态与预期裁决(11 值)。 */
export interface MvpCorpusEntry {
  /** 行为命名(红灯可读;同时是 IT / compose 用例名来源)。 */
  readonly name: string;
  readonly description: string;
  /** 交互终态(= submit 引用的 publicStatus / 末动作权威状态)。 */
  readonly expectedFinalStatus: "running" | "won" | "failed";
  /** 正式裁决预期(verifier 独立重放 + 隐藏测试汇总,ADR-9 §四)。 */
  readonly expectedVerdict:
    | "success"
    | "wrong_answer"
    | "invalid_action"
    | "program_crash"
    | "memory_fault"
    | "resource_limit"
    | "timeout";
  readonly actions: readonly ActionObject[];
  /** 首动作预期被拒(阶段闸门 / 权限预检;revision 不前进)。 */
  readonly expectedFirstRejected?: boolean;
  /** 末动作预期的公开错误码(userVisibleError.code;教学错误可解释面)。 */
  readonly expectedLastError?: string;
}

/** 题目元数据(教学面 + 十五章指标观察点,T3 评估报告接口的输入)。 */
export interface MvpChallengeMeta {
  readonly challengeId: string;
  readonly title: string;
  /** 教学目标(十一章指标观察框架的一格)。 */
  readonly objective: string;
  /** 教学反馈指标观察点(十五章;进 T3 评估报告接口,WP-68b 消费)。 */
  readonly observationPoints: readonly string[];
  readonly mode: "ir" | "byte";
  /** ZR-B13 非平凡复算 fixture 承载题(阶段四移交 §六.8)。 */
  readonly zrB13Fixture: boolean;
}

export interface MvpChallengePair {
  readonly publicDescriptor: unknown;
  readonly privateBundle: unknown;
}

/** 秘密变体(T-SC1 逐题必过,清单 §10.2:长度 8/16/32/64 + 同长异值)。 */
export interface MvpSecretVariant {
  readonly label: string;
  /** 就地改写双包中的声明秘密(其余:布局 / 代码 / 动作脚本完全相同)。 */
  readonly mutate: (pair: MvpChallengePair) => void;
}

export interface MvpChallenge {
  readonly meta: MvpChallengeMeta;
  /** 现场构造双包(每次全新对象;私有包内容零落盘)。 */
  readonly buildPair: () => MvpChallengePair;
  /** 参考解 + 边界语料矩阵(13.2 发布前义务)。 */
  readonly corpora: readonly MvpCorpusEntry[];
  /**
   * T-SC1 裁定脚本(参考解 + 探针变体:隐藏映射 / 未映射地址的写入,
   * 同步验证 I-9 统一拒绝形态)。缺省 = 参考解前置两条探针写。
   */
  readonly tsc1Script?: readonly ActionObject[];
  /** 声明秘密的变体集(缺省 = flag 长度 / 异值五变体)。 */
  readonly secretVariants?: readonly MvpSecretVariant[];
}

/** 规范化 JSON 摘要(登记哈希输入面;SHA-256 hex 小写)。 */
export function canonicalDigests(pair: MvpChallengePair): {
  readonly publicDescriptorSha256: string;
  readonly privateBundleSha256: string;
} {
  return {
    publicDescriptorSha256: createHash("sha256")
      .update(canonicalize(pair.publicDescriptor), "utf8")
      .digest("hex"),
    privateBundleSha256: createHash("sha256")
      .update(canonicalize(pair.privateBundle), "utf8")
      .digest("hex"),
  };
}

/** 装载单题(门禁与裁决闭环共用的唯一装载入口)。 */
export function loadMvpChallenge(challenge: MvpChallenge): ChallengeLoadResult {
  return loadChallengePair(challenge.buildPair());
}

// ─────────────────────────────────────────────────────────────────────────
// 共享几何常量(64 位;页粒度 4096)
// ─────────────────────────────────────────────────────────────────────────

const CODE_BASE = "0x400000";
const STACK_BASE = "0x7ffff000";
const VAULT_BASE = "0x20000000";
const UNMAPPED_PROBE = "0x12340000";
const REGION_BYTES = 4096;
const PAGE_SIZE = 4096;
const ARCH_BITS = 64;

/** 标准帧布局(CH-03 ~ CH-08;buffer 相邻 saved RBP 相邻返回地址槽)。 */
const FRAME = {
  buffer: "0x7ffff7f0", // 输入缓冲区 16 B(0x7ffff7f0..0x7ffff7ff)
  savedRbp: "0x7ffff800", // saved RBP 槽(8 B)
  retSlot: "0x7ffff808", // 返回地址槽(8 B;RSP 初始指向此处)
  rsp: "0x7ffff808",
  rbp: "0x7ffff800",
} as const;

/** CH-05 守护标记布局:buffer 与 saved RBP 之间插入 8 B 金丝雀标记。 */
const GUARD_FRAME = {
  buffer: FRAME.buffer,
  guard: "0x7ffff800", // 守护标记 8 B(0x7ffff800..0x7ffff807)
  savedRbp: "0x7ffff808",
  retSlot: "0x7ffff810",
  rsp: "0x7ffff810",
  rbp: "0x7ffff808",
} as const;

const GUARD_BYTES = "c0ffc0dec0ffee00";
const VAULT_MARKER = "5eca5cab1e00";

/** IR 模式 win 目标(帧教学题:指令索引 1 = syscall exit 正常退出)。 */
const IR_WIN = "0x1";
/** 帧教学题的原始返回槽值(指向 0 号 ret;普通返回不劫持 → 非终态)。 */
const IR_ORIGINAL_RETURN = "0x0";
/** 崩溃语料目标:数据地址被当作指令索引(≥ 程序长度 → invalid_rip)。 */
const IR_CRASH_TARGET = "0x7ffff800";
/** 字节模式 win gadget 地址(0x400200;CH-07/08 = call interface + exit)。 */
const BYTE_WIN = "0x400200";
/** 字节模式入口地址(0x400010;区域头 16 B 留空,探测从入口起)。 */
const BYTE_ENTRY = "0x400010";

/** 小端编码:架构值 → 定宽 8 字节小端 hex。 */
function le64(valueHex: string): string {
  const raw = BigInt(valueHex);
  const bytes: string[] = [];
  let value = raw;
  for (let index = 0; index < 8; index += 1) {
    bytes.push((value & 0xffn).toString(16).padStart(2, "0"));
    value >>= 8n;
  }
  return bytes.join("");
}

/** 小端字节串反序(端序错误教学语料:同字节异序)。 */
function reversed(hex: string): string {
  return (hex.match(/../g) ?? []).reverse().join("");
}

function offsetOf(address: string): number {
  return Number(BigInt(address) - BigInt(STACK_BASE));
}

/** 栈区 contentHex:全零骨架 + 指定偏移写入字节。 */
function stackContent(writes: readonly { readonly offset: number; readonly hex: string }[]): string {
  const bytes = Buffer.alloc(REGION_BYTES, 0);
  for (const write of writes) {
    Buffer.from(write.hex, "hex").copy(bytes, write.offset);
  }
  return bytes.toString("hex");
}

/** 字节模式代码区 contentHex:入口前零(不可达不判罚)+ 入口起的纯指令流。 */
function byteCodeContent(patches: readonly { readonly offset: number; readonly hex: string }[]): string {
  const bytes = Buffer.alloc(REGION_BYTES, 0x90); // 0x90 = NOP0(填充 token,纯指令流约定)
  for (let index = 0; index < BYTE_ENTRY_OFFSET; index += 1) {
    bytes[index] = 0x00; // 入口前置零:探测自入口起,前置字节不判罚
  }
  for (const patch of patches) {
    Buffer.from(patch.hex, "hex").copy(bytes, patch.offset);
  }
  return bytes.toString("hex");
}

const BYTE_ENTRY_OFFSET = 0x10;

/** 占位 flag(合成语料;仓库无真实秘密)。 */
function flagFor(challengeId: string): string {
  return `FLAG{mvp-${challengeId.slice(6, 10)}}`;
}

/** 每题独立固定种子(恰 16 字节;确定性,seed 策略 = fixed)。 */
function seedFor(challengeId: string): string {
  const serial = challengeId.slice(5, 7); // "01" ~ "08"
  return `00112233445566778899aabbccdd${serial}ee`;
}

function writeAction(addressHex: string, bytesHex: string): ActionObject {
  return { type: "write_bytes", args: { addressHex, bytesHex } };
}

/** 公开投影寄存器值的十六进制形态(协议公开输出面要求大写)。 */
function pubHex(valueHex: string): string {
  return `0x${BigInt(valueHex).toString(16).toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 双包构造器(IR 模式 / 字节模式)
// ─────────────────────────────────────────────────────────────────────────

interface PublicRegion {
  readonly regionId: string;
  readonly kind: "code" | "stack" | "heap" | "key" | "global" | "custom";
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly permissions: string;
  readonly publicLabel: string;
}

interface FrameSpec {
  readonly buffer: string;
  readonly savedRbp: string;
  readonly retSlot: string;
  readonly rsp: string;
  readonly rbp: string;
}

interface ChallengeSpec {
  readonly challengeId: string;
  readonly title: string;
  readonly summary: string;
  readonly learningObjectives: readonly string[];
  readonly teachingNotes?: readonly string[];
  readonly allowedActions: readonly string[];
  readonly mode: "ir" | "byte";
  readonly frame: FrameSpec;
  /** 栈区初始内容(守护标记 / 原始返回值等)。 */
  readonly stackWrites: readonly { readonly offset: number; readonly hex: string }[];
  /** 初始 RSP/RBP 之外的寄存器覆写(如字节模式 RIP)。 */
  readonly registerOverrides?: Readonly<Record<string, string>>;
  /** successCondition(L1)。 */
  readonly successCondition: Record<string, unknown>;
  /** 字节模式程序补丁(入口 ret / win gadget);缺省 = IR 模式程序。 */
  readonly bytePatches?: readonly { readonly offset: number; readonly hex: string }[];
  /**
   * IR 模式程序覆写(缺省 = 四指令栈帧程序)。
   * 帧教学题(CH-03~05)用两指令 epilogue 抽象:[ret, syscall exit]——
   * 入口即"即将返回",RSP 所指返回槽就是 ret 弹出的值;CH-01/02 用单
   * ret 程序承载"值 ≠ 地址"的引擎终态课。
   */
  readonly irProgram?: {
    readonly instructions: readonly Record<string, unknown>[];
    readonly labels?: readonly { readonly labelId: string; readonly instructionIndex: number }[];
  };
  /** 字节模式编码表补项(syscall / call interface;ret / NOP0 恒在内)。 */
  readonly encodingExtras?: readonly Record<string, unknown>[];
  readonly interfaces?: readonly Record<string, unknown>[];
  readonly virtualFiles?: readonly { readonly fileId: string; readonly content: string }[];
  readonly stages?: readonly Record<string, unknown>[];
  readonly hiddenVault?: boolean;
  readonly hintLadder: readonly { readonly order: number; readonly revealPolicy: "on_request" | "after_n_failures"; readonly failureThreshold?: number; readonly hintText: string }[];
  readonly publicErrorMapping?: readonly { readonly errorCode: string; readonly teachingNote: string }[];
}

const WIN_PROBE_TEST_ID = "final-state-probe";

/** 按规格构造双包(公开值镜像私有初始态;私有面独有内容只进私有包)。 */
function buildPairFromSpec(spec: ChallengeSpec): MvpChallengePair {
  const visibleRegions: PublicRegion[] = [
    {
      regionId: "code",
      kind: "code",
      startAddressHex: CODE_BASE,
      byteLength: REGION_BYTES,
      permissions: spec.mode === "byte" ? "rx" : "rx",
      publicLabel: "代码段",
    },
    {
      regionId: "stack",
      kind: "stack",
      startAddressHex: STACK_BASE,
      byteLength: REGION_BYTES,
      permissions: "rw",
      publicLabel: "栈",
    },
  ];
  const privateRegions = visibleRegions.map((region) => ({
    regionId: region.regionId,
    kind: region.kind,
    startAddressHex: region.startAddressHex,
    byteLength: region.byteLength,
    permissions: region.permissions,
    contentHex:
      region.regionId === "code" && spec.bytePatches !== undefined
        ? byteCodeContent(spec.bytePatches)
        : region.regionId === "stack"
          ? stackContent(spec.stackWrites)
          : zeroRegion(),
    isHidden: false,
  }));
  if (spec.hiddenVault === true) {
    const vault = Buffer.alloc(REGION_BYTES, 0);
    Buffer.from(VAULT_MARKER, "hex").copy(vault, 0);
    privateRegions.push({
      regionId: "vault",
      kind: "key",
      startAddressHex: VAULT_BASE,
      byteLength: REGION_BYTES,
      permissions: "rw",
      contentHex: vault.toString("hex"),
      isHidden: true,
    });
  }

  const ripInitial = spec.mode === "byte" ? BYTE_ENTRY : "0x0";
  const registers: Record<string, string> = {
    RSP: spec.frame.rsp,
    RBP: spec.frame.rbp,
    RIP: ripInitial,
    RAX: "0x0",
    FLAG0: "0x0",
    ...(spec.registerOverrides ?? {}),
  };

  const privateObjects = [
    {
      objectId: "input-buffer",
      kind: "buffer",
      addressHex: spec.frame.buffer,
      byteLength: 16,
      visibility: "public",
      containsSecret: false,
    },
    {
      objectId: "saved-rbp-slot",
      kind: "saved_rbp",
      addressHex: spec.frame.savedRbp,
      byteLength: 8,
      visibility: "public",
      containsSecret: false,
    },
    {
      objectId: "return-address-slot",
      kind: "return_address",
      addressHex: spec.frame.retSlot,
      byteLength: 8,
      visibility: "public",
      containsSecret: false,
    },
  ];

  const encodingTable =
    spec.mode === "byte"
      ? [
          { tokenHex: "0xc3", op: "ret" },
          { tokenHex: "0x90", op: "NOP0" },
          ...(spec.encodingExtras ?? []),
        ]
      : undefined;

  const publicDescriptor = {
    schemaVersion: 1,
    challengeId: spec.challengeId,
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: spec.title,
      summary: spec.summary,
      learningObjectives: [...spec.learningObjectives],
      ...(spec.teachingNotes !== undefined ? { teachingNotes: [...spec.teachingNotes] } : {}),
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
      pageSizeBytes: PAGE_SIZE,
      archBits: ARCH_BITS,
      canary: { enabled: false },
      ...(encodingTable !== undefined ? { encodingTable } : {}),
    },
    memoryLayout: {
      regions: visibleRegions.map((region) => ({
        regionId: region.regionId,
        kind: region.kind,
        startAddressHex: region.startAddressHex,
        byteLength: region.byteLength,
        permissions: region.permissions,
        publicLabel: region.publicLabel,
      })),
    },
    allowedActions: [...spec.allowedActions],
    resourceLimits: {
      predicateEvalBudgetPerSession: 10000,
      rollbackBudgetPerSession: 200,
      maxWriteBytesPerAction: 64,
    },
    hintLadder: spec.hintLadder.map((hint) => ({ ...hint })),
    publicErrorMapping: (spec.publicErrorMapping ?? []).map((entry) => ({ ...entry })),
    initialProjection: {
      visibleRegions: visibleRegions.map((region) => ({
        regionId: region.regionId,
        label: region.publicLabel,
        startAddressHex: region.startAddressHex,
        byteLength: region.byteLength,
        permissions: region.permissions,
        bytesHex:
          region.regionId === "code" && spec.bytePatches !== undefined
            ? byteCodeContent(spec.bytePatches).slice(0, 96)
            : region.regionId === "stack"
              ? stackContent(spec.stackWrites).slice(0, 64)
              : "00".repeat(16),
        truncated: true,
      })),
      visibleRegisters: [
        { name: "RSP", valueHex: pubHex(spec.frame.rsp) },
        { name: "RBP", valueHex: pubHex(spec.frame.rbp) },
        { name: "RIP", valueHex: pubHex(ripInitial) },
        { name: "RAX", valueHex: "0x0" },
      ],
      semanticHighlights: [
        {
          kind: "buffer_start",
          targetRegionId: "stack",
          startAddressHex: spec.frame.buffer,
          byteLength: 16,
          label: "输入缓冲区",
        },
      ],
    },
  };

  const privateBundle: Record<string, unknown> = {
    schemaVersion: 1,
    challengeId: spec.challengeId,
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    dslSchemaVersion: 2,
    vmEngineVersion: "0.1.0",
    declaredSeedPublicPaths: [],
    seedPolicy: { strategy: "fixed", seedHex: seedFor(spec.challengeId) },
    initialState: { registers, memoryRegions: privateRegions },
    secrets: {
      flag: flagFor(spec.challengeId),
      virtualFiles: spec.virtualFiles ?? [],
    },
    privateObjects,
    judging: {
      successCondition: spec.successCondition,
      hiddenTests: [
        { testId: WIN_PROBE_TEST_ID, kind: "predicate_probe", expectedResult: "success" },
      ],
    },
    ...(spec.stages !== undefined ? { stages: spec.stages } : {}),
    ...(spec.mode === "byte"
      ? { entrypointAddressHex: BYTE_ENTRY }
      : {
          compiledIr: {
            irFormatVersion: 2,
            entrypointIndex: 0,
            instructions: spec.irProgram?.instructions ?? [
              { op: "push", operands: [{ kind: "register", name: "RBP" }] },
              {
                op: "mov",
                operands: [
                  { kind: "register", name: "RBP" },
                  { kind: "register", name: "RSP" },
                ],
              },
              { op: "ret", operands: [] },
              { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x0" }] },
            ],
            labels: spec.irProgram?.labels ?? [
              { labelId: "entry", instructionIndex: 0 },
              { labelId: "win", instructionIndex: 3 },
            ],
          },
        }),
    customInstructions: [
      {
        mnemonic: "NOP0",
        displayText: "空操作(教学填充)",
        semantics: [
          {
            op: "bit_mask",
            dst: "RAX",
            src: "RAX",
            maskHex: "0xFFFFFFFFFFFFFFFF",
            logic: "and",
          },
        ],
      },
    ],
    ...(spec.interfaces !== undefined ? { interfaces: spec.interfaces } : {}),
    judgingConfig: {
      verdictRuleVersion: "1.0.0",
      maxPredicateEvalSteps: 10000,
      timeoutMsPerAction: 5000,
    },
  };

  return { publicDescriptor, privateBundle };
}

function zeroRegion(): string {
  return "00".repeat(REGION_BYTES);
}

/** 就地改写私有栈区指定偏移的字节(T-SC1 秘密变体面)。 */
function patchStackBytes(pair: MvpChallengePair, offset: number, hex: string): void {
  const bundle = pair.privateBundle as {
    initialState: { memoryRegions: { regionId: string; contentHex: string }[] };
  };
  const stack = bundle.initialState.memoryRegions.find((region) => region.regionId === "stack");
  if (stack === undefined) {
    throw new Error("栈区缺失(变体构造缺陷)");
  }
  const bytes = Buffer.from(stack.contentHex, "hex");
  Buffer.from(hex, "hex").copy(bytes, offset);
  stack.contentHex = bytes.toString("hex");
}

/** flag 长度 / 异值变体(清单 §10.2 的声明秘密变体基集)。 */
function flagVariants(): MvpSecretVariant[] {
  const values: readonly { readonly label: string; readonly flag: string }[] = [
    { label: "flag-len-8", flag: "FLAG{m8}" },
    { label: "flag-len-16", flag: "FLAG{len16abcd}" },
    { label: "flag-len-32", flag: "FLAG{len32_0123456789abcdef}" },
    { label: "flag-len-64", flag: `FLAG{${"a".repeat(56)}}` },
    { label: "flag-len-16-alt", flag: "FLAG{zzzz16yx}" },
  ];
  return values.map((entry) => ({
    label: entry.label,
    mutate: (pair) => {
      (pair.privateBundle as { secrets: { flag: string } }).secrets.flag = entry.flag;
    },
  }));
}

/** 探针写(隐藏映射 / 未映射地址统一拒绝,I-9;T-SC1 脚本前置)。 */
function probeWrites(hiddenAddresses: readonly string[]): ActionObject[] {
  return [...hiddenAddresses, UNMAPPED_PROBE].map((address) => writeAction(address, "41"));
}

/** 参考解脚本 + T-SC1 探针(缺省裁定脚本形态)。 */
function withProbes(
  reference: readonly ActionObject[],
  hiddenAddresses: readonly string[] = [],
): ActionObject[] {
  return [...probeWrites(hiddenAddresses), ...reference];
}

// ─────────────────────────────────────────────────────────────────────────
// 语料本体(8 道;每题 = 双包 + 参考解/边界矩阵 + T-SC1 面)
// ─────────────────────────────────────────────────────────────────────────

/** CH-03 ~ CH-05 共用的 IR 栈帧教学条件:劫持后 RIP 落在 win 指令。 */
function irRipWinCondition(guard?: { readonly offset: number; readonly bytesHex: string }): Record<string, unknown> {
  const all: unknown[] = [
    { all: [{ predicate: { type: "register_equals", register: "RIP", valueHex: IR_WIN } }] },
  ];
  if (guard !== undefined) {
    all.push({
      all: [
        {
          predicate: {
            type: "memory_equals",
            regionId: "stack",
            offsetBytes: guard.offset,
            bytesHex: guard.bytesHex,
          },
        },
      ],
    });
  }
  // stack_canary_intact 在无 canary 槽题目上恒真(谓词词汇覆盖;教学面见 CH-05)。
  all.push({ all: [{ predicate: { type: "stack_canary_intact" } }] });
  return { all };
}

const BYTE_WIN_LE = le64(BYTE_WIN);

export const MVP_CHALLENGES: readonly MvpChallenge[] = [
  // ── CH-01:可见内存与 write_bytes ────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch01-write-basics",
      title: "第一字节:向内存写入标记",
      objective: "认识可见内存区域与 write_bytes 动作;理解区域权限与可解释错误(十一章观察框架:首次成功时间格)。",
      observationPoints: [
        "首次成功时间(十五章:打开题目到首次成功)",
        "错误类型分布(permission_denied 重复率)",
        "提示使用等级",
      ],
      mode: "ir",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch01-write-basics",
        title: "第一字节:向内存写入标记",
        summary:
          "把标记字节 \"STAC\" 写进栈区起点的输入缓冲区。观察 write_bytes 的投影增量与脏范围;" +
          "再试试向只读代码区写入,读懂数据为什么被拒绝。",
        learningObjectives: ["使用 write_bytes 向可见区域写入字节", "理解区域权限(rw / rx)与可解释错误"],
        teachingNotes: ["写入被拒不是惩罚:错误解释会指出权限与对齐事实(4.4 脱敏教学)"],
        allowedActions: ["write_bytes", "call", "step", "ret", "run_to_event"],
        mode: "ir",
        frame: { buffer: STACK_BASE, savedRbp: "0x7ffff800", retSlot: "0x7ffff808", rsp: "0x7ffff800", rbp: "0x7ffff800" },
        stackWrites: [],
        irProgram: {
          instructions: [{ op: "ret", operands: [] }],
          labels: [{ labelId: "entry", instructionIndex: 0 }],
        },
        successCondition: {
          all: [
            {
              all: [
                {
                  predicate: {
                    type: "memory_equals",
                    regionId: "stack",
                    offsetBytes: 0,
                    bytesHex: "53544143",
                  },
                },
              ],
            },
          ],
        },
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "输入缓冲区从栈区起点 0x7ffff000 开始;write_bytes 的地址参数就是它。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "\"STAC\" 的十六进制是 53 54 41 43;写入长度 4 字节。" },
        ],
        publicErrorMapping: [
          { errorCode: "permission_denied", teachingNote: "代码段只读不可写(rx);数据要写进 rw 区域。" },
          { errorCode: "offset_out_of_range", teachingNote: "写入越过区域边界:检查偏移与字节长度。" },
        ],
      }),
    corpora: [
      {
        name: "writes marker into stack buffer and wins",
        description: "参考解:向缓冲区写入 STAC → memory_equals 命中 → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [writeAction(STACK_BASE, "53544143")],
      },
      {
        name: "wrong marker content does not satisfy objective",
        description: "边界(wrong_answer 方向):写入错误内容 → 目标不命中。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [writeAction(STACK_BASE, "43415453")],
      },
      {
        name: "write into read-only code region is rejected with explanation",
        description: "边界(教学失败方向):向 rx 代码区写入 → permission_denied(交互可解释);裁决仍走非终态 wrong_answer。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        expectedLastError: "permission_denied",
        actions: [writeAction(CODE_BASE, "90")],
      },
      {
        name: "data value on stack top crashes when program returns",
        description:
          "边界(失败方向):把数据值写到栈顶,程序自身的 ret 指令把它当地址弹出 → " +
          "invalid_rip → program_crash(会话动作 ret 的同类错误是教学性失败,不终局;" +
          "引擎终态崩溃只发生在程序执行面)。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [writeAction("0x7ffff800", le64("0x9")), { type: "step", args: {} }],
      },
    ],
    tsc1Script: withProbes([writeAction(STACK_BASE, "53544143")]),
    secretVariants: flagVariants(),
  },

  // ── CH-02:小端序与"值 ≠ 地址" ──────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch02-little-endian",
      title: "字节倒放:小端序观察",
      objective: "通过 push 观察架构值在栈上的小端字节序;理解\"值 ≠ 地址\"(值被当作返回目标即崩)。",
      observationPoints: [
        "完成率与放弃率(首次接触端序概念的一格)",
        "重复错误比例(端序方向写反的复现率)",
        "提示使用等级",
      ],
      mode: "ir",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch02-little-endian",
        title: "字节倒放:小端序观察",
        summary:
          "用 push 把值 0x400200 压上栈,观察字节视图里 00 02 40 00… 的排列——这是小端序。" +
          "然后思考:如果把这个\"值\"当作返回地址弹出,会发生什么?",
        learningObjectives: ["理解 little-endian 的字节排列", "区分\"值\"与\"地址\"两种语义"],
        allowedActions: ["write_bytes", "push", "pop", "call", "step", "ret", "run_to_event"],
        mode: "ir",
        frame: { buffer: "0x7ffff7f8", savedRbp: "0x7ffff800", retSlot: "0x7ffff808", rsp: "0x7ffff800", rbp: "0x7ffff800" },
        stackWrites: [],
        irProgram: {
          instructions: [{ op: "ret", operands: [] }],
          labels: [{ labelId: "entry", instructionIndex: 0 }],
        },
        successCondition: {
          all: [
            {
              all: [
                {
                  predicate: {
                    type: "memory_contains",
                    regionId: "stack",
                    bytesHex: "0002400000000000",
                  },
                },
              ],
            },
          ],
        },
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "push 的参数是值(valueHex),不是地址;压栈后 RSP 下移 8。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "0x400200 小端排列 = 00 02 40 00 00 00 00 00。" },
        ],
        publicErrorMapping: [
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值必须落在可执行位置;数据值当地址会崩。" },
        ],
      }),
    corpora: [
      {
        name: "pushes win value and little endian bytes appear on stack",
        description: "参考解:push 0x400200 → memory_contains 命中小端字节 → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [{ type: "push", args: { valueHex: "0x400200" } }],
      },
      {
        name: "wrong value does not satisfy objective",
        description: "边界(wrong_answer 方向):压入错误值 → 字节序列不匹配。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [{ type: "push", args: { valueHex: "0x400201" } }],
      },
      {
        name: "ret treats pushed value as return target and crashes",
        description:
          "边界(失败方向):错误值驻栈顶后,程序自身的 ret 指令把它当地址弹出 → " +
          "invalid_rip → program_crash(值 ≠ 地址的引擎终态课)。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          { type: "push", args: { valueHex: "0x400201" } },
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes([{ type: "push", args: { valueHex: "0x400200" } }]),
    secretVariants: flagVariants(),
  },

  // ── CH-03:栈帧布局算术 ─────────────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch03-frame-layout",
      title: "栈帧地图:找到返回地址槽",
      objective: "依据缓冲区 → saved RBP → 返回地址槽的帧布局计算偏移,精准写入返回槽并劫持 RIP。",
      observationPoints: [
        "首次成功时间(帧布局概念格)",
        "错误类型分布(槽位错写率)",
        "回退次数(undo 使用)",
      ],
      mode: "ir",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch03-frame-layout",
        title: "栈帧地图:找到返回地址槽",
        summary:
          "输入缓冲区在 0x7ffff7f0,它上方 8 字节是 saved RBP(0x7ffff800),再上方 8 字节就是" +
          "返回地址槽(0x7ffff808,RSP 正指于此)。程序入口就是一条 ret:它弹出的正是返回槽的值。" +
          "把 win 目标(指令索引 1)写进返回槽,单步执行——RIP 会落在 win。",
        learningObjectives: ["画出栈帧布局(buffer / saved RBP / return address)", "用单步观察控制流劫持"],
        allowedActions: ["write_bytes", "push", "pop", "call", "step", "ret", "run_to_event"],
        mode: "ir",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(IR_ORIGINAL_RETURN) }],
        irProgram: {
          instructions: [
            { op: "ret", operands: [] },
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x0" }] },
          ],
          labels: [
            { labelId: "entry", instructionIndex: 0 },
            { labelId: "win", instructionIndex: 1 },
          ],
        },
        successCondition: irRipWinCondition(),
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "返回槽地址 = 缓冲区 + 16 + 8;RSP 初始就指向它。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "win = 指令索引 1;8 字节小端 = 0100000000000000。" },
        ],
        publicErrorMapping: [
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值不在程序索引界内:检查写入的目标值与位置。" },
        ],
      }),
    corpora: [
      {
        name: "precise return slot overwrite hijacks rip to win",
        description: "参考解:精准写返回槽 = win 索引 → step(ret 指令)→ RIP = win → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [writeAction(FRAME.retSlot, le64(IR_WIN)), { type: "step", args: {} }],
      },
      {
        name: "writing the neighbour slot misses the hijack",
        description: "边界(wrong_answer 方向):写到 saved RBP 槽(相邻错位)→ ret 弹出原值 0 → 非终态。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [writeAction(FRAME.savedRbp, le64(IR_WIN)), { type: "step", args: {} }],
      },
      {
        name: "data address as index crashes on program return",
        description: "边界(失败方向):把数据地址 0x7ffff800 当目标写进返回槽 → ret 弹出越界索引 → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(FRAME.retSlot, le64(IR_CRASH_TARGET)),
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes([writeAction(FRAME.retSlot, le64(IR_WIN)), { type: "step", args: {} }]),
    secretVariants: flagVariants(),
  },

  // ── CH-04:缓冲区溢出 ──────────────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch04-buffer-overflow",
      title: "漫过堤坝:缓冲区溢出覆写返回地址",
      objective: "从缓冲区起点构造连续 payload(填充 + saved RBP + 小端目标),一次写入完成返回地址覆写。",
      observationPoints: [
        "首次成功时间(溢出因果链格)",
        "错误类型分布(端序 / 填充长度错误)",
        "学习前后端序概念理解变化(前测题)",
      ],
      mode: "ir",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch04-buffer-overflow",
        title: "漫过堤坝:缓冲区溢出覆写返回地址",
        summary:
          "从缓冲区 0x7ffff7f0 起连续写入:16 字节填充漫过缓冲区,8 字节覆盖 saved RBP," +
          "最后 8 字节以小端写入 win 目标(指令索引 1)——一次 write_bytes 完成整条溢出链," +
          "再单步执行 ret 验证。",
        learningObjectives: ["构造连续溢出 payload(填充 + 覆写)", "在 payload 中以小端编码目标地址"],
        allowedActions: ["write_bytes", "push", "pop", "call", "step", "ret", "run_to_event"],
        mode: "ir",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(IR_ORIGINAL_RETURN) }],
        irProgram: {
          instructions: [
            { op: "ret", operands: [] },
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x0" }] },
          ],
          labels: [
            { labelId: "entry", instructionIndex: 0 },
            { labelId: "win", instructionIndex: 1 },
          ],
        },
        successCondition: irRipWinCondition(),
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "payload 总长 32 字节:16 填充 + 8 saved RBP + 8 返回槽。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "最后 8 字节必须是 0100000000000000(小端),不是 0000000000000001。" },
        ],
        publicErrorMapping: [
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值不在程序索引界内:检查 payload 末 8 字节的端序。" },
        ],
      }),
    corpora: [
      {
        name: "contiguous overflow payload hijacks return address",
        description: "参考解:32 字节连续 payload → step(ret 指令)→ RIP = win → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(FRAME.buffer, "41".repeat(16) + "42".repeat(8) + le64(IR_WIN)),
          { type: "step", args: {} },
        ],
      },
      {
        name: "padding only payload leaves return slot intact",
        description: "边界(wrong_answer 方向):只填充 16 字节 → 返回槽未被覆写 → ret 弹出原值 → 非终态。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [writeAction(FRAME.buffer, "41".repeat(16)), { type: "step", args: {} }],
      },
      {
        name: "data address as index crashes on program return",
        description: "边界(失败方向):把数据地址 0x7ffff800 当目标写进返回槽 → ret 弹出越界索引 → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(FRAME.buffer, "41".repeat(16) + "42".repeat(8) + le64(IR_CRASH_TARGET)),
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes([
      writeAction(FRAME.buffer, "41".repeat(16) + "42".repeat(8) + le64(IR_WIN)),
      { type: "step", args: {} },
    ]),
    secretVariants: flagVariants(),
  },

  // ── CH-05:栈保护(金丝雀)语义 ─────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch05-canary-guard",
      title: "金丝雀哨兵:守护标记与精准绕过",
      objective: "理解栈保护(金丝雀)的防护语义:连续溢出会踩碎标记使目标条件失效;已知槽位的精准写入可绕过——以及这一局限的教学含义。",
      observationPoints: [
        "错误类型分布(溢出越界长度)",
        "概念理解变化(防护机制前测 / 后测)",
        "回退次数",
      ],
      mode: "ir",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch05-canary-guard",
        title: "金丝雀哨兵:守护标记与精准绕过",
        summary:
          "缓冲区上方多了一个 8 字节守护标记(金丝雀,c0 ff c0 de c0 ff ee 00)。成功条件要求" +
          "标记完好:从缓冲区一路漫过的写法会踩碎它;而已经知道返回槽地址的你,可以只写那 8 字节。" +
          "这就是 canary 防什么、不防什么的直观课。",
        learningObjectives: ["理解 canary 标记的检测语义", "理解\"精准绕过\"的局限与含义"],
        allowedActions: ["write_bytes", "push", "pop", "call", "step", "ret", "run_to_event"],
        mode: "ir",
        frame: GUARD_FRAME,
        stackWrites: [
          { offset: offsetOf(GUARD_FRAME.guard), hex: GUARD_BYTES },
          { offset: offsetOf(GUARD_FRAME.retSlot), hex: le64(IR_ORIGINAL_RETURN) },
        ],
        irProgram: {
          instructions: [
            { op: "ret", operands: [] },
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x0" }] },
          ],
          labels: [
            { labelId: "entry", instructionIndex: 0 },
            { labelId: "win", instructionIndex: 1 },
          ],
        },
        successCondition: irRipWinCondition({
          offset: offsetOf(GUARD_FRAME.guard),
          bytesHex: GUARD_BYTES,
        }),
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "标记在缓冲区上方 0x7ffff800;返回槽在 0x7ffff810。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "漫过标记的写法即使劫持成功也不计通过:成功条件包含标记完好。" },
        ],
        publicErrorMapping: [
          { errorCode: "offset_out_of_range", teachingNote: "写入越过区域边界:检查偏移与字节长度。" },
        ],
      }),
    corpora: [
      {
        name: "precise write bypasses guard marker and hijacks rip",
        description: "参考解:绕过标记的精准写(8 字节)→ step(ret 指令)→ RIP = win ∧ 标记完好 → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [writeAction(GUARD_FRAME.retSlot, le64(IR_WIN)), { type: "step", args: {} }],
      },
      {
        name: "overflow smashing the guard marker fails the objective",
        description: "边界(wrong_answer 方向):连续溢出踩碎金丝雀标记 → 即使 RIP 劫持成功,目标条件不成立 → 非终态。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [
          writeAction(GUARD_FRAME.buffer, "41".repeat(16) + "43".repeat(8)),
          writeAction(GUARD_FRAME.retSlot, le64(IR_WIN)),
          { type: "step", args: {} },
        ],
      },
      {
        name: "data address as index crashes on program return",
        description: "边界(失败方向):把数据地址 0x7ffff800 当目标写进返回槽 → ret 弹出越界索引 → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(GUARD_FRAME.retSlot, le64(IR_CRASH_TARGET)),
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes([writeAction(GUARD_FRAME.retSlot, le64(IR_WIN)), { type: "step", args: {} }]),
    secretVariants: [
      ...flagVariants(),
      {
        label: "guard-value-alt",
        mutate: (pair) => {
          const alternative = "0102030405060708";
          patchStackBytes(pair, offsetOf(GUARD_FRAME.guard), alternative);
          const judging = (pair.privateBundle as {
            judging: { successCondition: { all: unknown[] } };
          }).judging;
          const guardPredicate = {
            all: [
              {
                predicate: {
                  type: "memory_equals",
                  regionId: "stack",
                  offsetBytes: offsetOf(GUARD_FRAME.guard),
                  bytesHex: alternative,
                },
              },
            ],
          };
          // 成功条件与标记值同源替换(答案册随秘密等值变化;其余面不动)。
          judging.successCondition.all = [
            ...(judging.successCondition.all ?? []).slice(0, 1),
            guardPredicate,
            ...(judging.successCondition.all ?? []).slice(2),
          ];
        },
      },
    ],
  },

  // ── CH-06:字节模式 ret2win ─────────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch06-ret2win-byte",
      title: "真地址世界:字节模式 ret2win",
      objective: "进入字节模式:代码区是真实字节流、win 是真实地址 0x400200;完成真实地址语义下的溢出劫持。",
      observationPoints: [
        "首次成功时间(字节模式过渡格)",
        "提示使用等级",
        "投影传输量(字节视图交互增量)",
      ],
      mode: "byte",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch06-ret2win-byte",
        title: "真地址世界:字节模式 ret2win",
        summary:
          "这一题的代码段是真正的字节流(编码表公开:0xc3 = ret)。win gadget 在地址 0x400200。" +
          "像 CH-04 一样从缓冲区漫出,但这次写进返回槽的是真实地址的小端编码。",
        learningObjectives: ["在字节模式下阅读编码表与代码区", "以小端构造真实地址 payload"],
        allowedActions: ["write_bytes", "step", "ret"],
        mode: "byte",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(BYTE_ENTRY) }],
        registerOverrides: {},
        successCondition: {
          all: [
            { all: [{ predicate: { type: "register_equals", register: "RIP", valueHex: BYTE_WIN } }] },
          ],
        },
        bytePatches: [
          { offset: BYTE_ENTRY_OFFSET, hex: "c3" },
          { offset: 0x200, hex: "c3" },
        ],
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "win 地址 0x400200 的小端 8 字节 = 0002400000000000。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "payload = 16 填充 + 8 saved RBP + 8 返回槽;槽址 0x7ffff808。" },
        ],
        publicErrorMapping: [
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值没有落在可执行字节上:检查端序与目标地址。" },
        ],
      }),
    corpora: [
      {
        name: "byte mode overflow ret2win succeeds",
        description: "参考解:32 字节 payload(小端 0x400200)→ ret → RIP = 0x400200 → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(FRAME.buffer, "41".repeat(16) + "42".repeat(8) + BYTE_WIN_LE),
          { type: "ret", args: {} },
        ],
      },
      {
        name: "padding only keeps original return target",
        description: "边界(wrong_answer 方向):只填充 → ret 弹出原入口地址 → 非终态。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [writeAction(FRAME.buffer, "41".repeat(16)), { type: "ret", args: {} }],
      },
      {
        name: "reversed endian address decodes nowhere and crashes",
        description:
          "边界(失败方向):端序写反的返回槽 → 程序自身的 ret 指令弹出后无法译码 → " +
          "invalid_rip → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(FRAME.buffer, "41".repeat(16) + "42".repeat(8) + reversed(BYTE_WIN_LE)),
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes([
      writeAction(FRAME.buffer, "41".repeat(16) + "42".repeat(8) + BYTE_WIN_LE),
      { type: "ret", args: {} },
    ]),
    secretVariants: flagVariants(),
  },

  // ── CH-07:隐藏区域 + 虚拟文件 flag(ZR-B13 派生面承载题)────────────────
  {
    meta: {
      challengeId: "sm-ch07-hidden-vault",
      title: "看不见的宝库:隐藏区域与 flag 能力",
      objective: "理解隐藏区域存在性不可探测(I-9 统一拒绝)与虚拟文件 capability:劫持返回地址落入 win gadget,经作者接口授予并读取 flag 笔记。",
      observationPoints: [
        "完成率(隐藏区域概念格)",
        "探针尝试与统一拒绝的观察面(不可探测性)",
        "错误类型分布(inaccessible_address)",
      ],
      mode: "byte",
      zrB13Fixture: true,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch07-hidden-vault",
        title: "看不见的宝库:隐藏区域与 flag 能力",
        summary:
          "题目里有一个你看不见的隐藏区域,flag 藏在其中。win gadget 在 0x400200:劫持返回地址" +
          "落到它,再单步执行——作者接口会替你开启宝库并读取笔记。看不见的区域探不到:" +
          "任何对不可见地址的访问都会得到同一种拒绝。",
        learningObjectives: ["理解隐藏区域与 I-9 统一拒绝(不可探测)", "理解虚拟文件 capability 与作者接口"],
        teachingNotes: ["flag 只经服务端判题面读取;浏览器投影永远不含 flag 内容(I-3)"],
        allowedActions: ["write_bytes", "step", "ret"],
        mode: "byte",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(BYTE_ENTRY) }],
        hiddenVault: true,
        successCondition: {
          all: [
            {
              all: [
                { predicate: { type: "virtual_file_read", fileId: "vault-notes" } },
              ],
            },
          ],
        },
        virtualFiles: [
          { fileId: "vault-notes", content: "宝库笔记(私有判题面,仅服务端可见)。" },
        ],
        interfaces: [
          {
            interfaceId: 0x100,
            displayText: "教学接口:开启宝库并读取笔记",
            effects: [
              { effect: "grant_virtual_file", fileId: "vault-notes" },
              { effect: "virtual_file_read", fileId: "vault-notes" },
            ],
          },
        ],
        encodingExtras: [
          { tokenHex: "0xcd", op: "syscall", operands: [{ kind: "immediate", width: "arch" }] },
          { tokenHex: "0xd4", op: "call", operands: [{ kind: "interface", interfaceId: 0x100 }] },
        ],
        bytePatches: [
          { offset: BYTE_ENTRY_OFFSET, hex: "c3" },
          { offset: 0x200, hex: "d4" },
          { offset: 0x201, hex: "cd" + "00".repeat(8) },
        ],
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "返回槽 0x7ffff808;win gadget = 0x400200 的小端 0002400000000000。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "ret 落到 gadget 后还要 step 两次:第一次执行接口调用(拿 flag),第二次 exit 收尾。" },
        ],
        publicErrorMapping: [
          { errorCode: "inaccessible_address", teachingNote: "不可见地址与未映射地址同一种拒绝:探测绘不出隐藏区域的边界。" },
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值没有落在可执行字节上:检查端序与目标地址。" },
        ],
      }),
    corpora: [
      {
        name: "ret hijack into win gadget reads vault file",
        description: "参考解:精准写返回槽 = 0x400200 → ret → step(接口授予 + 读取)→ won → step(exit)→ success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(FRAME.retSlot, BYTE_WIN_LE),
          { type: "ret", args: {} },
          { type: "step", args: {} },
          { type: "step", args: {} },
        ],
      },
      {
        name: "landing one byte before the gadget stays dormant",
        description: "边界(wrong_answer 方向):落到 gadget 前一字节(NOP0 填充)→ 程序可执行但未读 flag → 非终态。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [
          writeAction(FRAME.retSlot, le64("0x4001ff")),
          { type: "ret", args: {} },
          { type: "step", args: {} },
        ],
      },
      {
        name: "reversed endian gadget address crashes on program return",
        description: "边界(失败方向):端序写反的返回槽 → 程序自身的 ret 指令弹出后无法译码 → invalid_rip → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(FRAME.retSlot, reversed(BYTE_WIN_LE)),
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes(
      [writeAction(FRAME.retSlot, BYTE_WIN_LE), { type: "ret", args: {} }, { type: "step", args: {} }],
      [VAULT_BASE],
    ),
    secretVariants: [
      ...flagVariants(),
      {
        label: "vault-marker-alt",
        mutate: (pair) => {
          patchVaultMarker(pair, "0a0b0c0d0e0f");
        },
      },
      {
        label: "vault-file-content-alt",
        mutate: (pair) => {
          (pair.privateBundle as {
            secrets: { virtualFiles: { fileId: string; content: string }[] };
          }).secrets.virtualFiles = [
            { fileId: "vault-notes", content: "宝库笔记(变体占位,仅服务端可见)。" },
          ];
        },
      },
    ],
  },

  // ── CH-08:两阶段状态机 + 全要素组合 ────────────────────────────────────
  {
    meta: {
      challengeId: "sm-ch08-full-chain",
      title: "全链路合练:侦察 → 打击",
      objective: "组合前七题全部要素:阶段状态机(recon → strike)、阶段动作闸门、隐藏区域 + 虚拟文件、字节模式溢出劫持,一次通关。",
      observationPoints: [
        "各题完成率(收官格)",
        "阶段闸门拒绝后的重试行为(编排理解)",
        "动作请求 p50 / p95(教学规模基线)",
      ],
      mode: "byte",
      zrB13Fixture: false,
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-ch08-full-chain",
        title: "全链路合练:侦察 → 打击",
        summary:
          "两阶段作战:recon 阶段只许 write_bytes / step——把作战标记 cafe 写进缓冲区才会切换到" +
          "strike;strike 阶段解锁 ret。宝库与接口都在:完成标记、劫持 0x400200、单步读取 flag。" +
          "在错误的阶段做错误的动作会被闸门拦下。",
        learningObjectives: ["理解多阶段题目的状态机与动作闸门", "组合运用溢出劫持 + 接口读取全链路"],
        allowedActions: ["write_bytes", "step", "ret"],
        mode: "byte",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(BYTE_ENTRY) }],
        hiddenVault: true,
        successCondition: {
          all: [
            {
              all: [
                { predicate: { type: "virtual_file_read", fileId: "vault-notes" } },
              ],
            },
          ],
        },
        virtualFiles: [
          { fileId: "vault-notes", content: "宝库笔记(私有判题面,仅服务端可见)。" },
        ],
        interfaces: [
          {
            interfaceId: 0x100,
            displayText: "教学接口:开启宝库并读取笔记",
            effects: [
              { effect: "grant_virtual_file", fileId: "vault-notes" },
              { effect: "virtual_file_read", fileId: "vault-notes" },
            ],
          },
        ],
        encodingExtras: [
          { tokenHex: "0xcd", op: "syscall", operands: [{ kind: "immediate", width: "arch" }] },
          { tokenHex: "0xd4", op: "call", operands: [{ kind: "interface", interfaceId: 0x100 }] },
        ],
        bytePatches: [
          { offset: BYTE_ENTRY_OFFSET, hex: "c3" },
          { offset: 0x200, hex: "d4" },
          { offset: 0x201, hex: "cd" + "00".repeat(8) },
        ],
        stages: [
          {
            stageId: "recon",
            allowedActions: ["write_bytes", "step"],
            preconditions: { all: [] },
            transitions: [
              {
                toStageId: "strike",
                onCondition: {
                  all: [
                    {
                      all: [
                        {
                          predicate: {
                            type: "memory_equals",
                            regionId: "stack",
                            offsetBytes: offsetOf(FRAME.buffer),
                            bytesHex: "cafe",
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
            sideEffects: [],
            failureConditions: [],
            resourceBudget: { maxInstructionSteps: 10000, maxActions: 8 },
          },
          {
            stageId: "strike",
            allowedActions: ["write_bytes", "ret", "step"],
            preconditions: { all: [] },
            transitions: [],
            sideEffects: [],
            failureConditions: [],
            resourceBudget: { maxInstructionSteps: 10000, maxActions: 8 },
          },
        ],
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "先在 recon 写 cafe 到缓冲区(0x7ffff7f0)完成阶段迁移;ret 在 strike 才可用。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "strike 阶段:写 0x7ffff808 = 0002400000000000 → ret → step ×2。" },
        ],
        publicErrorMapping: [
          { errorCode: "inaccessible_address", teachingNote: "不可见地址与未映射地址同一种拒绝:探测绘不出隐藏区域的边界。" },
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值没有落在可执行字节上:检查端序与目标地址。" },
        ],
      }),
    corpora: [
      {
        name: "two stage full chain ends in vault flag",
        description: "参考解:recon 写 cafe(迁移)→ strike 写返回槽 → ret → step(读 flag)→ won → step(exit)→ success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(FRAME.buffer, "cafe"),
          writeAction(FRAME.retSlot, BYTE_WIN_LE),
          { type: "ret", args: {} },
          { type: "step", args: {} },
          { type: "step", args: {} },
        ],
      },
      {
        name: "ret in recon stage is gated and script fizzles",
        description: "边界(wrong_answer 方向):recon 阶段 ret 被阶段闸门拒绝(revision 不前进);后续仅完成迁移,未劫持 → 非终态。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        expectedFirstRejected: true,
        actions: [
          { type: "ret", args: {} },
          writeAction(FRAME.buffer, "cafe"),
        ],
      },
      {
        name: "reversed endian strike crashes after migration",
        description: "边界(失败方向):完成迁移后端序写反 → 程序自身的 ret 指令弹出后无法译码 → invalid_rip → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(FRAME.buffer, "cafe"),
          writeAction(FRAME.retSlot, reversed(BYTE_WIN_LE)),
          { type: "step", args: {} },
        ],
      },
    ],
    tsc1Script: withProbes(
      [
        writeAction(FRAME.buffer, "cafe"),
        writeAction(FRAME.retSlot, BYTE_WIN_LE),
        { type: "ret", args: {} },
        { type: "step", args: {} },
      ],
      [VAULT_BASE],
    ),
    secretVariants: [
      ...flagVariants(),
      {
        label: "vault-marker-alt",
        mutate: (pair) => {
          patchVaultMarker(pair, "0a0b0c0d0e0f");
        },
      },
      {
        label: "vault-file-content-alt",
        mutate: (pair) => {
          (pair.privateBundle as {
            secrets: { virtualFiles: { fileId: string; content: string }[] };
          }).secrets.virtualFiles = [
            { fileId: "vault-notes", content: "宝库笔记(变体占位,仅服务端可见)。" },
          ];
        },
      },
    ],
  },
];

/** 就地改写私有隐藏区域标记字节(T-SC1 秘密变体面)。 */
function patchVaultMarker(pair: MvpChallengePair, hex: string): void {
  const bundle = pair.privateBundle as {
    initialState: { memoryRegions: { regionId: string; contentHex: string }[] };
  };
  const vault = bundle.initialState.memoryRegions.find((region) => region.regionId === "vault");
  if (vault === undefined) {
    throw new Error("隐藏区域缺失(变体构造缺陷)");
  }
  const bytes = Buffer.from(vault.contentHex, "hex");
  Buffer.from(hex, "hex").copy(bytes, 0);
  vault.contentHex = bytes.toString("hex");
}

/**
 * CH-07 的 ZR-B13 非平凡复算 fixture(阶段四移交 §六.8 的接入面)。
 *
 * 在 CH-07(字节模式 + 隐藏区域)之上追加 canary 槽声明:公开包 canary
 * 启用 + 私有包 hidden + containsSecret 的 canary 对象(落在隐藏区域内,
 * 与公开区域不相交,XS-CANARY-CORR ✓)。**本 fixture 只进调试变体派生
 * 链路**(buildDebugVariantBundle → checkDebugVariantDerivation),不做
 * 交互装载——交互面与 canary 槽的契约冲突见本文件头与 D-API-109。
 */
export function zrB13FixturePair(): MvpChallengePair {
  const challenge = MVP_CHALLENGES.find(
    (entry) => entry.meta.challengeId === "sm-ch07-hidden-vault",
  );
  if (challenge === undefined) {
    throw new Error("ZR-B13 承载题 sm-ch07-hidden-vault 缺失");
  }
  const pair = challenge.buildPair();
  const descriptor = pair.publicDescriptor as {
    vmProfile: { canary: { enabled: boolean; sizeBytes?: number } };
  };
  descriptor.vmProfile.canary = { enabled: true, sizeBytes: 8 };
  const bundle = pair.privateBundle as {
    initialState: { memoryRegions: { regionId: string; contentHex: string }[] };
    privateObjects: {
      objectId: string;
      kind: string;
      addressHex: string;
      byteLength: number;
      visibility: string;
      containsSecret: boolean;
    }[];
  };
  const vault = bundle.initialState.memoryRegions.find((region) => region.regionId === "vault");
  if (vault === undefined) {
    throw new Error("隐藏区域缺失(fixture 构造缺陷)");
  }
  // canary 期望字节(真实镜像:引擎"期望值从初始内存截取"的同构声明面;
  // 调试变体中该槽字节由调试种子派生重写)。
  const vaultBytes = Buffer.from(vault.contentHex, "hex");
  Buffer.from(GUARD_BYTES, "hex").copy(vaultBytes, 0);
  vault.contentHex = vaultBytes.toString("hex");
  bundle.privateObjects.push({
    objectId: "vault-canary",
    kind: "canary",
    addressHex: VAULT_BASE,
    byteLength: 8,
    visibility: "hidden",
    containsSecret: true,
  });
  return pair;
}

/** 题目集 ID 索引(测试与 compose 断言用;即发布登记的 challengeId 全集)。 */
export const MVP_CHALLENGE_IDS: readonly string[] = MVP_CHALLENGES.map(
  (challenge) => challenge.meta.challengeId,
);
