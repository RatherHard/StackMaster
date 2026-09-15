/**
 * 我的第一道题:在栈上留下记号(出题人文档 T1 的配套语料)。
 *
 * 教学目标:选手用 write_bytes 把 4 字节标记 "STAC"(53544143)写进栈缓冲区,
 * memory_equals 谓词命中即判胜。程序只有一条 ret——全部重点在"读内存、写内存、
 * 看投影、读错误解释"这条最小闭环上。
 *
 * 本文件 = 一道题的全部"源代码":
 *   buildPair() 现场构造 公开描述包 + 私有判题包(私有内容只在内存,永不入 git)
 *   corpora[]   参考解 + 边界语料矩阵(success / wrong_answer / 教学失败 / crash)
 *
 * 装载与裁决链路:loadChallengePair(门禁)→ canonicalDigests(登记摘要)
 * → verdict-closed-loop.test.ts(真实 vm-worker 重放裁决)。
 */
import type { ActionObject } from "@stackmaster/protocol";
import { canonicalize } from "@stackmaster/protocol";
import { createHash } from "node:crypto";
import { loadChallengePair, type ChallengeLoadResult } from "@stackmaster/challenge-compiler";

// ── 类型(三个导出接口 = 语料模块对测试暴露的全部面)────────────────────

/** 语料条目:一段可重放的动作脚本 + 预期交互终态 + 预期正式裁决。 */
export interface MyCorpusEntry {
  /** 行为命名(红灯可读;同时是裁决闭环的用例名)。 */
  readonly name: string;
  readonly description: string;
  /** 预期交互终态(exit(1) 等程序自停不会置 failed,见 T1 步骤 3 的说明)。 */
  readonly expectedFinalStatus: "running" | "won" | "failed";
  /** 预期正式裁决(verifier 独立重放 + 隐藏测试汇总)。 */
  readonly expectedVerdict:
    | "success"
    | "wrong_answer"
    | "invalid_action"
    | "program_crash"
    | "memory_fault"
    | "resource_limit"
    | "timeout";
  readonly actions: readonly ActionObject[];
  /** 末动作预期的公开错误码(可选;教学失败语料用)。 */
  readonly expectedLastError?: string;
}

export interface MyChallengePair {
  readonly publicDescriptor: unknown;
  readonly privateBundle: unknown;
}

export interface MyChallenge {
  readonly meta: {
    readonly challengeId: string;
    readonly title: string;
    readonly mode: "ir" | "byte";
  };
  /** 现场构造双包(每次全新对象)。 */
  readonly buildPair: () => MyChallengePair;
  readonly corpora: readonly MyCorpusEntry[];
}

/** 规范化 JSON 摘要(登记哈希输入;SHA-256 hex 小写)。 */
export function canonicalDigests(pair: MyChallengePair): {
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

/** 装载入口(门禁与裁决闭环共用;失败 = {ok:false, violations[]})。 */
export function loadMyChallenge(challenge: MyChallenge): ChallengeLoadResult {
  return loadChallengePair(challenge.buildPair());
}

// ── 几何常量(64 位;4KB 页;照抄 MVP 先例的栈帧布局)──────────────────

const CODE_BASE = "0x400000";
const STACK_BASE = "0x7ffff000";
const REGION_BYTES = 4096;
const PAGE_SIZE = 4096;
const ARCH_BITS = 64;

const FRAME = {
  buffer: "0x7ffff7f0", // 输入缓冲区 16 B(栈区偏移 0)
  savedRbp: "0x7ffff800", // saved RBP 槽 8 B(偏移 16)
  retSlot: "0x7ffff808", // 返回地址槽 8 B(偏移 24)
  rsp: "0x7ffff800", // RSP 初始 = saved RBP 槽(单 ret 程序:从这里弹)
  rbp: "0x7ffff800",
} as const;

/** 胜利标记:"STAC" 的十六进制字节。 */
const MARKER_BYTES = "53544143";

/** 栈区 contentHex:全零骨架 + 指定偏移写入字节(内存稠密定义)。 */
function stackContent(writes: readonly { readonly offset: number; readonly hex: string }[]): string {
  const bytes = Buffer.alloc(REGION_BYTES, 0);
  for (const write of writes) {
    Buffer.from(write.hex, "hex").copy(bytes, write.offset);
  }
  return bytes.toString("hex");
}

/** IR 模式代码区内容:全零即可(内存字节只是数据,不参与执行)。 */
function zeroRegion(): string {
  return "00".repeat(REGION_BYTES);
}

/** 占位 flag(合成值;真实发布换正式格式并递增内容版本)。 */
function flagFor(challengeId: string): string {
  return `FLAG{my-${challengeId.slice(4, 6)}}`;
}

/** 每题独立固定种子(恰 16 字节 hex;fixed 策略 → 重放逐字节可复现)。 */
function seedFor(challengeId: string): string {
  const serial = challengeId.slice(4, 6); // "sm-t01-write-marker" → "01"
  if (!/^[0-9a-f]{2}$/.test(serial)) {
    throw new Error(`题目编号无法派生种子序列:${challengeId}`);
  }
  return `00112233445566778899aabbccdd${serial}ee`;
}

/** 构造一条 write_bytes 动作。 */
function writeAction(addressHex: string, bytesHex: string): ActionObject {
  return { type: "write_bytes", args: { addressHex, bytesHex } };
}

/** 构造 n 条 step 动作。 */
function steps(count: number): ActionObject[] {
  return Array.from({ length: count }, () => ({ type: "step", args: {} }) as ActionObject);
}

/** 公开投影寄存器值的大写十六进制形态(协议公开输出面要求大写)。 */
function pubHex(valueHex: string): string {
  return `0x${BigInt(valueHex).toString(16).toUpperCase()}`;
}

// ── 题目本体(双包线性构造:每个字段都看得见)────────────────────────

export const MY_CHALLENGE: MyChallenge = {
  meta: {
    challengeId: "sm-t01-write-marker",
    title: "热身:在栈上留下记号",
    mode: "ir",
  },
  buildPair: () => {
    // ── 可见区域(公开布局):代码段 + 栈 ──────────────────────────────
    const visibleRegions = [
      { regionId: "code", kind: "code", startAddressHex: CODE_BASE, permissions: "rx", publicLabel: "代码段" },
      { regionId: "stack", kind: "stack", startAddressHex: STACK_BASE, permissions: "rw", publicLabel: "栈" },
    ];
    // 私有区域 = 可见区域的镜像(几何逐项相等)+ 各自的内容(IR 模式代码区全零)
    const privateRegions = visibleRegions.map((region) => ({
      regionId: region.regionId,
      kind: region.kind,
      startAddressHex: region.startAddressHex,
      byteLength: REGION_BYTES,
      permissions: region.permissions,
      contentHex: region.regionId === "stack" ? stackContent([]) : zeroRegion(),
      isHidden: false,
    }));

    // 初始寄存器(私有);RIP = 程序入口下标 0
    const registers: Record<string, string> = {
      RSP: FRAME.rsp,
      RBP: FRAME.rbp,
      RIP: "0x0",
      RAX: "0x0",
      FLAG0: "0x0",
    };

    // ── 公开描述包 ──────────────────────────────────────────────────
    const publicDescriptor = {
      schemaVersion: 1,
      challengeId: "sm-t01-write-marker",
      challengeContentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
      locale: "zh-CN",
      briefing: {
        title: "热身:在栈上留下记号",
        summary:
          "栈区开头(0x7ffff000)是你在本实验室的第一块画布:用 write_bytes 把四字节标记" +
          "「STAC」写进栈区开头。写对了,判题条件立即成立;写错了,读一读错误解释——" +
          "每一条错误都是设计好的教学反馈。",
        learningObjectives: [
          "看懂字节视图:地址、十六进制字节与可见窗口",
          "完成第一次 write_bytes,理解权限与偏移错误",
        ],
        teachingNotes: [
          "本题程序只有一条 ret;判胜只看栈区前 4 字节的内容,与程序执行无关。",
        ],
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
      },
      memoryLayout: {
        regions: visibleRegions.map((region) => ({
          regionId: region.regionId,
          kind: region.kind,
          startAddressHex: region.startAddressHex,
          byteLength: REGION_BYTES,
          permissions: region.permissions,
          publicLabel: region.publicLabel,
        })),
      },
      allowedActions: ["write_bytes", "step", "ret"],
      resourceLimits: {
        predicateEvalBudgetPerSession: 10000,
        rollbackBudgetPerSession: 200,
        maxWriteBytesPerAction: 64,
      },
      hintLadder: [
        { order: 1, revealPolicy: "on_request", hintText: "判胜条件检查的是栈区(0x7ffff000)开头的前 4 字节——memory_equals 的偏移从区域起点算起。" },
        { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "「STAC」的十六进制是 5354 4143——write_bytes 的内容字段填偶数长度 hex:53544143,目标地址 0x7ffff000。" },
        { order: 3, revealPolicy: "after_n_failures", failureThreshold: 4, hintText: "向代码段(0x400000)写会得到 permission_denied:rx 区域只读。数据要写进 rw 的栈区。" },
      ],
      publicErrorMapping: [
        { errorCode: "permission_denied", teachingNote: "目标区域不可写:代码段是 rx。把数据写进 rw 区域(栈/全局)。" },
        { errorCode: "offset_out_of_range", teachingNote: "写入跨度越出了目标区域:核对地址与字节长度。" },
      ],
      initialProjection: {
        visibleRegions: visibleRegions.map((region) => ({
          regionId: region.regionId,
          label: region.publicLabel,
          startAddressHex: region.startAddressHex,
          byteLength: REGION_BYTES,
          permissions: region.permissions,
          // 镜像原则:公开字节 = 私有 contentHex 的同长前缀切片(全零 → 全零)
          bytesHex: region.regionId === "stack" ? stackContent([]).slice(0, 64) : zeroRegion().slice(0, 96),
          truncated: true,
        })),
        visibleRegisters: [
          { name: "RSP", valueHex: pubHex(FRAME.rsp) },
          { name: "RBP", valueHex: pubHex(FRAME.rbp) },
          { name: "RIP", valueHex: pubHex("0x0") },
          { name: "RAX", valueHex: "0x0" },
        ],
        semanticHighlights: [
          { kind: "buffer_start", targetRegionId: "stack", startAddressHex: FRAME.buffer, byteLength: 16, label: "输入缓冲区" },
          { kind: "return_address_slot", targetRegionId: "stack", startAddressHex: FRAME.retSlot, byteLength: 8, label: "返回地址槽" },
        ],
      },
    };

    // ── 私有判题包 ──────────────────────────────────────────────────
    const privateBundle = {
      schemaVersion: 1,
      challengeId: "sm-t01-write-marker",
      challengeContentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
      dslSchemaVersion: 2,
      vmEngineVersion: "0.1.0",
      declaredSeedPublicPaths: [],
      seedPolicy: { strategy: "fixed", seedHex: seedFor("sm-t01-write-marker") },
      initialState: { registers, memoryRegions: privateRegions },
      secrets: { flag: flagFor("sm-t01-write-marker"), virtualFiles: [] },
      privateObjects: [
        { objectId: "input-buffer", kind: "buffer", addressHex: FRAME.buffer, byteLength: 16, visibility: "public", containsSecret: false },
        { objectId: "saved-rbp-slot", kind: "saved_rbp", addressHex: FRAME.savedRbp, byteLength: 8, visibility: "public", containsSecret: false },
        { objectId: "return-address-slot", kind: "return_address", addressHex: FRAME.retSlot, byteLength: 8, visibility: "public", containsSecret: false },
      ],
      judging: {
        successCondition: {
          all: [
            // memory_equals 的偏移相对区域起点(0x7ffff000 + 0 = 栈区开头)
            { all: [{ predicate: { type: "memory_equals", regionId: "stack", offsetBytes: 0, bytesHex: MARKER_BYTES } }] },
          ],
        },
        hiddenTests: [
          { testId: "final-state-probe", kind: "predicate_probe", expectedResult: "success" },
        ],
      },
      compiledIr: {
        irFormatVersion: 2,
        entrypointIndex: 0,
        instructions: [{ op: "ret", operands: [] }],
        labels: [{ labelId: "entry", instructionIndex: 0 }],
      },
      customInstructions: [],
      judgingConfig: {
        verdictRuleVersion: "1.0.0",
        maxPredicateEvalSteps: 10000,
        timeoutMsPerAction: 5000,
      },
    };

    return { publicDescriptor, privateBundle };
  },
  // ── 语料矩阵:参考解 + 三个边界方向 ────────────────────────────────
  corpora: [
    {
      name: "writes marker into stack buffer and wins",
      description: "参考解:向栈区起点(0x7ffff000)写 4 字节标记 → memory_equals 命中 → won → success。",
      expectedFinalStatus: "won",
      expectedVerdict: "success",
      actions: [writeAction(STACK_BASE, MARKER_BYTES)],
    },
    {
      name: "near miss marker does not satisfy the condition",
      description: "边界(wrong_answer 方向):写「STAS」(一字节之差)→ 条件不成立、程序未终止 → running/wrong_answer。",
      expectedFinalStatus: "running",
      expectedVerdict: "wrong_answer",
      actions: [writeAction(STACK_BASE, "53544153")],
    },
    {
      name: "data value on stack top crashes when program returns",
      description: "边界(失败方向):向 RSP 指向的槽写数据值 9 → step 执行 ret → 弹出 9 作执行位置 → invalid_rip → failed/program_crash。",
      expectedFinalStatus: "failed",
      expectedVerdict: "program_crash",
      actions: [writeAction(FRAME.savedRbp, "0900000000000000"), ...steps(1)],
    },
    {
      name: "write into read only code region is rejected with explanation",
      description: "边界(教学失败方向):向 rx 代码区写 → permission_denied(status 非 rejected、revision 前进)→ 裁决 wrong_answer。",
      expectedFinalStatus: "running",
      expectedVerdict: "wrong_answer",
      expectedLastError: "permission_denied",
      actions: [writeAction(CODE_BASE, "90")],
    },
  ],
};

export const MY_CHALLENGE_IDS: readonly string[] = [MY_CHALLENGE.meta.challengeId];
