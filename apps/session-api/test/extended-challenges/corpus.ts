/**
 * 扩展题目集语料(三道 pwn 教学题:ret2win / 最小 ROP / 整数截断)。
 *
 * # 制作管线(镜像 mvp-challenges/corpus.ts 的形态,独立构造器)
 *
 *   本模块(DSL 源,构造式)→ loadChallengePair(Schema + 字段分类检查器 +
 *   编译期校验,extended-challenge-set.test.ts 门禁)→ canonicalDigests
 *   (规范化 JSON 摘要)→ verdict-closed-loop.test.ts 经真实 vm-worker 做
 *   裁决闭环回归。
 *
 * 私有判题包内容**永不入 git**(CLAUDE.md 红线):全部私有语料由本模块在
 * 进程内构造;公开描述包与私有包由同一构造器按"公开值镜像私有初始态"
 * 成对产出(I2-PUB-MIRROR / XS-PROJ-VALUES 按构造成立)。
 *
 * # 三题梯度(扩展:从"返回地址"到"计算语义"的攻击面)
 *
 *   X-01 sm-x01-ret2win-ir        IR   leave;ret 组合:栈帧收尾即劫持点
 *   X-02 sm-x02-rop-minimal       字节 最小 ROP:gadget 链 + 参数 + win 块
 *   X-03 sm-x03-int-truncation-ir IR   整数截断(CWE-681):8 位检查 ≠ 64 位范围
 *
 * # 隐藏测试边界(v1,D-H2,与 MVP 同款)
 *
 * 每题隐藏测试 = 对 successCondition 的终态 predicate_probe(载荷空,
 * 无输入槽)。
 *
 * # D-J8 口径
 *
 * 全部题目 `aslrEnabled` 缺省(false):v1 真实实例维持固定基址。
 *
 * # 引擎语义锚点(实跑核实后钉住;见 verdict-closed-loop.test.ts)
 *
 *  - IR 模式执行起点 = 私有初始 RIP 寄存器(entrypointIndex 与之同值登记);
 *  - `syscall exit(I)` 程序终止(halted),会话状态保持 running——终态
 *    won / failed 只由判题检查点置位;
 *  - 会话动作 `ret` = 弹一次返回地址(不继续执行);`step` = 恰一条指令;
 *  - IR `leave` 在弹出 saved RBP 后即按 ret 同规则预校验返回地址槽
 *    (弹出值不可执行 → leave 处即 invalid_rip,早于其后的 ret)。
 */
import type { ActionObject } from "@stackmaster/protocol";
import { canonicalize } from "@stackmaster/protocol";
import { createHash } from "node:crypto";
import { loadChallengePair, type ChallengeLoadResult } from "@stackmaster/challenge-compiler";

/** 语料条目:一组可重放的会话动作脚本 + 预期交互终态与预期裁决(11 值)。 */
export interface ExtCorpusEntry {
  /** 行为命名(红灯可读;同时是裁决闭环用例名来源)。 */
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
  /** 首动作预期被拒(revision 不前进)。 */
  readonly expectedFirstRejected?: boolean;
  /** 末动作预期的公开错误码(userVisibleError.code;教学错误可解释面)。 */
  readonly expectedLastError?: string;
}

/** 题目元数据(教学面 + 十五章指标观察点)。 */
export interface ExtChallengeMeta {
  readonly challengeId: string;
  readonly title: string;
  /** 教学目标(十一章指标观察框架的一格)。 */
  readonly objective: string;
  /** 教学反馈指标观察点(十五章;T3 评估报告接口的输入)。 */
  readonly observationPoints: readonly string[];
  readonly mode: "ir" | "byte";
}

export interface ExtChallengePair {
  readonly publicDescriptor: unknown;
  readonly privateBundle: unknown;
}

export interface ExtChallenge {
  readonly meta: ExtChallengeMeta;
  /** 现场构造双包(每次全新对象;私有包内容零落盘)。 */
  readonly buildPair: () => ExtChallengePair;
  /** 参考解 + 边界语料矩阵。 */
  readonly corpora: readonly ExtCorpusEntry[];
}

/** 规范化 JSON 摘要(登记哈希输入面;SHA-256 hex 小写)。 */
export function canonicalDigests(pair: ExtChallengePair): {
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
export function loadExtChallenge(challenge: ExtChallenge): ChallengeLoadResult {
  return loadChallengePair(challenge.buildPair());
}

// ─────────────────────────────────────────────────────────────────────────
// 共享几何常量(64 位;页粒度 4096;照抄 MVP 先例)
// ─────────────────────────────────────────────────────────────────────────

const CODE_BASE = "0x400000";
const STACK_BASE = "0x7ffff000";
const CFG_BASE = "0x600000"; // EXT-3 全局配置区
const REGION_BYTES = 4096;
const PAGE_SIZE = 4096;
const ARCH_BITS = 64;

/** 标准帧布局(照抄 MVP FRAME;buffer 相邻 saved RBP 相邻返回地址槽)。 */
const FRAME = {
  buffer: "0x7ffff7f0", // 输入缓冲区 16 B
  savedRbp: "0x7ffff800", // saved RBP 槽(8 B)
  retSlot: "0x7ffff808", // 返回地址槽(8 B;RSP 初始指向此处)
  rsp: "0x7ffff808",
  rbp: "0x7ffff800",
} as const;

/** 字节模式入口地址(0x400010;区域头 16 B 留空,探测从入口起)。 */
const BYTE_ENTRY = "0x400010";
/** EXT-2 字节布局:win 块 / fail 块 / gadget(照抄 MVP 地址惯例)。 */
const BYTE_WIN = "0x400200";
const BYTE_FAIL = "0x400220";
const BYTE_GADGET = "0x400300";
/** EXT-2 ROP 参数(win 块的 cmp 只认这个 key)。 */
const ROP_KEY = "0xdeadbeef";

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

function zeroRegion(): string {
  return "00".repeat(REGION_BYTES);
}

const BYTE_ENTRY_OFFSET = 0x10;

/**
 * 字节模式代码区 contentHex:入口前零(不可达不判罚)+ 入口起的纯指令流
 * (0x90 = NOP0 填充 token)。补丁区支持任意长度的连续字节段(本题目
 * win / fail / gadget 块都是多字节连续段,不经偏移补丁机制,直接整区拼装)。
 */
function byteCodeContent(patches: readonly { readonly offset: number; readonly hex: string }[]): string {
  const bytes = Buffer.alloc(REGION_BYTES, 0x90);
  for (let index = 0; index < BYTE_ENTRY_OFFSET; index += 1) {
    bytes[index] = 0x00; // 入口前置零:探测自入口起,前置字节不判罚
  }
  for (const patch of patches) {
    Buffer.from(patch.hex, "hex").copy(bytes, patch.offset);
  }
  return bytes.toString("hex");
}

/** 占位 flag(合成语料;仓库无真实秘密)。 */
function flagFor(challengeId: string): string {
  return `FLAG{ext-${challengeId.slice(3, 6)}}`;
}

/** 每题独立固定种子(恰 16 字节;确定性,seed 策略 = fixed)。 */
function seedFor(challengeId: string): string {
  const serial = challengeId.slice(4, 6); // "01" ~ "03"
  if (!/^[0-9a-f]{2}$/.test(serial)) {
    throw new Error(`题目编号无法派生种子序列:${challengeId}`);
  }
  return `00112233445566778899aabbccdd${serial}ee`;
}

function writeAction(addressHex: string, bytesHex: string): ActionObject {
  return { type: "write_bytes", args: { addressHex, bytesHex } };
}

function stepAction(): ActionObject {
  return { type: "step", args: {} };
}

function steps(count: number): ActionObject[] {
  return Array.from({ length: count }, () => stepAction());
}

/** 公开投影寄存器值的十六进制形态(协议公开输出面要求大写)。 */
function pubHex(valueHex: string): string {
  return `0x${BigInt(valueHex).toString(16).toUpperCase()}`;
}

/** 连续 payload:填充 + saved RBP + 任意尾部(返回槽 / ROP 链)。 */
function overflowPayload(tailHex: string): string {
  return "41".repeat(16) + "42".repeat(8) + tailHex;
}

// ─────────────────────────────────────────────────────────────────────────
// 双包构造器(IR 模式 / 字节模式;镜像 buildPairFromSpec,可精简)
// ─────────────────────────────────────────────────────────────────────────

interface RegionSpec {
  readonly regionId: string;
  readonly kind: "code" | "stack" | "heap" | "key" | "global" | "custom";
  readonly startAddressHex: string;
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

/** 额外公开寄存器(同步进公开声明 / 公开投影 / 私有初始集;I-3:禁 FLAG 名)。 */
interface ExtraRegisterSpec {
  readonly name: string;
  readonly displayLabel: string;
  readonly valueHex: string;
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
  /** 栈区初始内容(原始返回值等)。 */
  readonly stackWrites: readonly { readonly offset: number; readonly hex: string }[];
  /** 公开布局 = code + stack + extraRegions(私有 contentHex 恒全零)。 */
  readonly extraRegions?: readonly RegionSpec[];
  /** 公开 / 私有同步的额外寄存器(RSP/RBP/RIP/RAX 之外)。 */
  readonly extraRegisters?: readonly ExtraRegisterSpec[];
  /** successCondition(L1)。 */
  readonly successCondition: Record<string, unknown>;
  /** 字节模式程序补丁(多字节连续段);缺省 = IR 模式程序。 */
  readonly bytePatches?: readonly { readonly offset: number; readonly hex: string }[];
  /** IR 模式程序(entrypointIndex 必填:与初始 RIP 同值)。 */
  readonly irProgram?: {
    readonly entrypointIndex: number;
    readonly instructions: readonly Record<string, unknown>[];
    readonly labels?: readonly { readonly labelId: string; readonly instructionIndex: number }[];
  };
  /** 字节模式编码表补项(ret / NOP0 恒在内)。 */
  readonly encodingExtras?: readonly Record<string, unknown>[];
  /** 自定义指令补项(NOP0 恒在内;EXT-2 追加 WINFLAG)。 */
  readonly customInstructionExtras?: readonly Record<string, unknown>[];
  /** 公开 semanticHighlights(I2-HIGHLIGHT:目标区域可见且跨度界内)。 */
  readonly semanticHighlights?: readonly Record<string, unknown>[];
  readonly hintLadder: readonly {
    readonly order: number;
    readonly revealPolicy: "on_request" | "after_n_failures";
    readonly failureThreshold?: number;
    readonly hintText: string;
  }[];
  readonly publicErrorMapping?: readonly { readonly errorCode: string; readonly teachingNote: string }[];
}

const WIN_PROBE_TEST_ID = "final-state-probe";

/** 按规格构造双包(公开值镜像私有初始态;私有面独有内容只进私有包)。 */
function buildPairFromSpec(spec: ChallengeSpec): ExtChallengePair {
  const visibleRegions: RegionSpec[] = [
    {
      regionId: "code",
      kind: "code",
      startAddressHex: CODE_BASE,
      permissions: "rx",
      publicLabel: "代码段",
    },
    {
      regionId: "stack",
      kind: "stack",
      startAddressHex: STACK_BASE,
      permissions: "rw",
      publicLabel: "栈",
    },
    ...(spec.extraRegions ?? []),
  ];
  const privateRegions = visibleRegions.map((region) => ({
    regionId: region.regionId,
    kind: region.kind,
    startAddressHex: region.startAddressHex,
    byteLength: REGION_BYTES,
    permissions: region.permissions,
    contentHex:
      region.regionId === "code" && spec.bytePatches !== undefined
        ? byteCodeContent(spec.bytePatches)
        : region.regionId === "stack"
          ? stackContent(spec.stackWrites)
          : zeroRegion(),
    isHidden: false,
  }));

  const ripInitial =
    spec.mode === "byte" ? BYTE_ENTRY : `0x${(spec.irProgram?.entrypointIndex ?? 0).toString(16)}`;
  const registers: Record<string, string> = {
    RSP: spec.frame.rsp,
    RBP: spec.frame.rbp,
    RIP: ripInitial,
    RAX: "0x0",
    FLAG0: "0x0",
    ...Object.fromEntries((spec.extraRegisters ?? []).map((register) => [register.name, register.valueHex])),
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
        ...(spec.extraRegisters ?? []).map((register) => ({
          name: register.name,
          displayLabel: register.displayLabel,
        })),
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
        byteLength: REGION_BYTES,
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
        byteLength: REGION_BYTES,
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
        ...(spec.extraRegisters ?? []).map((register) => ({
          name: register.name,
          valueHex: pubHex(register.valueHex),
        })),
      ],
      ...(spec.semanticHighlights !== undefined ? { semanticHighlights: spec.semanticHighlights.map((highlight) => ({ ...highlight })) } : {}),
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
      virtualFiles: [],
    },
    privateObjects,
    judging: {
      successCondition: spec.successCondition,
      hiddenTests: [
        { testId: WIN_PROBE_TEST_ID, kind: "predicate_probe", expectedResult: "success" },
      ],
    },
    ...(spec.mode === "byte"
      ? { entrypointAddressHex: BYTE_ENTRY }
      : {
          compiledIr: {
            irFormatVersion: 2,
            entrypointIndex: spec.irProgram?.entrypointIndex ?? 0,
            instructions: spec.irProgram?.instructions ?? [],
            labels: spec.irProgram?.labels ?? [],
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
      ...(spec.customInstructionExtras ?? []),
    ],
    judgingConfig: {
      verdictRuleVersion: "1.0.0",
      maxPredicateEvalSteps: 10000,
      timeoutMsPerAction: 5000,
    },
  };

  return { publicDescriptor, privateBundle };
}

// ─────────────────────────────────────────────────────────────────────────
// 语料本体(3 道;每题 = 双包 + 参考解/边界矩阵)
// ─────────────────────────────────────────────────────────────────────────

/** X-01 的 IR win 目标与 lose 目标(指令索引;程序布局见下)。 */
const X01_WIN = "0x6";
const X01_LOSE = "0x8";

/** X-03 的 IR win / lose 目标(指令索引)与配置窗口。 */
const X03_WIN = "0xc";
const X03_LOSE = "0xd";
const CFG_SIZE_SLOT = CFG_BASE; // [0x600000] = size
const CFG_NOTE_SLOT = "0x600008"; // [0x600008] = note(8 字节任意写载荷)

/** IR 模式教学条件:劫持后 RIP 落在 win 指令 ∧ canary 恒真(照 CH-04 形态)。 */
function irRipWinCondition(winIndexHex: string): Record<string, unknown> {
  return {
    all: [
      { all: [{ predicate: { type: "register_equals", register: "RIP", valueHex: winIndexHex } }] },
      { all: [{ predicate: { type: "stack_canary_intact" } }] },
    ],
  };
}

export const EXT_CHALLENGES: readonly ExtChallenge[] = [
  // ── X-01:leave;ret 组合 ret2win(IR)────────────────────────────────────
  {
    meta: {
      challengeId: "sm-x01-ret2win-ir",
      title: "幕间收尾:leave 与 ret 的回归劫持",
      objective:
        "理解栈帧收尾指令 leave(= mov rsp,rbp; pop rbp)与 ret 的组合语义:leave 拉回 RSP 并弹回 saved RBP,紧随的 ret 弹出的就是攻击者可覆写的返回地址槽。",
      observationPoints: [
        "首次成功时间(leave;ret 概念格)",
        "错误类型分布(槽位错写 / 端序错误)",
        "提示使用等级",
      ],
      mode: "ir",
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-x01-ret2win-ir",
        title: "幕间收尾:leave 与 ret 的回归劫持",
        summary:
          "函数序言(push RBP; mov RBP,RSP)早已执行完毕,此刻 RIP 停在收尾入口(指令索引 4)。" +
          "leave 会把 RSP 拉回 RBP、把 saved RBP 弹回 RBP;紧随其后的 ret 弹出的正是返回地址槽" +
          "(0x7ffff808)里的值——它的初始值指向 lose(索引 8)。从缓冲区 0x7ffff7f0 构造连续 " +
          "payload 漫过 saved RBP,把 win(指令索引 6)写进返回槽,单步两次看控制流改道。",
        learningObjectives: [
          "理解 leave = mov rsp,rbp; pop rbp 的栈帧收尾语义",
          "构造连续溢出 payload 经 leave;ret 完成返回地址劫持",
        ],
        teachingNotes: [
          "leave 处即按 ret 同规则预校验返回槽:弹出值不可执行会在 leave 报 invalid_rip,早于 ret",
        ],
        allowedActions: ["write_bytes", "step"],
        mode: "ir",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(X01_LOSE) }],
        irProgram: {
          entrypointIndex: 4,
          instructions: [
            // 0~3:已执行完的序言与入参守卫(RAX=0 → jne 不跳;CFG 死代码由
            // ret 动态目标的保守全图可达承担,XC-IR-REACH ✓)。
            { op: "push", operands: [{ kind: "register", name: "RBP" }] },
            {
              op: "mov",
              operands: [
                { kind: "register", name: "RBP" },
                { kind: "register", name: "RSP" },
              ],
            },
            { op: "cmp", operands: [{ kind: "register", name: "RAX" }, { kind: "immediate", valueHex: "0x0" }] },
            { op: "jne", operands: [{ kind: "immediate", valueHex: X01_LOSE }] },
            // 4:leave(执行起点;RSP←RBP、pop RBP、返回槽预校验)
            { op: "leave", operands: [] },
            // 5:ret(动态目标 → 弹攻击者值)
            { op: "ret", operands: [] },
            // [win] 6:置位胜利标志;7:exit(0)
            {
              op: "mov",
              operands: [
                { kind: "register", name: "FLAG0" },
                { kind: "immediate", valueHex: "0x1337" },
              ],
            },
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x0" }] },
            // [lose] 8:exit(1)
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x1" }] },
          ],
          labels: [
            { labelId: "entry", instructionIndex: 4 },
            { labelId: "win", instructionIndex: 6 },
            { labelId: "lose", instructionIndex: 8 },
          ],
        },
        successCondition: irRipWinCondition(X01_WIN),
        semanticHighlights: [
          {
            kind: "buffer_start",
            targetRegionId: "stack",
            startAddressHex: FRAME.buffer,
            byteLength: 16,
            label: "输入缓冲区",
          },
          {
            kind: "saved_rbp_slot",
            targetRegionId: "stack",
            startAddressHex: FRAME.savedRbp,
            byteLength: 8,
            label: "saved RBP 槽",
          },
          {
            kind: "return_address_slot",
            targetRegionId: "stack",
            startAddressHex: FRAME.retSlot,
            byteLength: 8,
            label: "返回地址槽",
          },
        ],
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "程序停在收尾入口(RIP = 4):leave 把 RSP 拉回 RBP 并弹回 saved RBP;再一步 ret 弹出返回槽 0x7ffff808 里的值。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "返回槽 = buffer + 24(16 缓冲区 + 8 saved RBP);它当前指向 lose(索引 8)——不写 payload 单步三次就会掉进 exit(1)。" },
          { order: 3, revealPolicy: "after_n_failures", failureThreshold: 4, hintText: "payload = 16 填充 + 8 saved RBP + 8 返回槽,共 32 字节,从 0x7ffff7f0 起一次写入;win = 指令索引 6,小端 8 字节 = 0600000000000000。" },
        ],
        publicErrorMapping: [
          { errorCode: "invalid_rip", teachingNote: "ret(或 leave 的返回槽预校验)弹出的值不是界内指令索引:检查写入的目标值与端序。" },
          { errorCode: "permission_denied", teachingNote: "代码段只读不可写(rx);数据要写进 rw 区域。" },
        ],
      }),
    corpora: [
      {
        name: "leave ret epilogue hijacks return to win",
        description:
          "参考解:32 字节连续 payload(16 填充 + 8 saved RBP + 8 小端 win 索引 6)→ " +
          "step(leave:RSP←RBP、pop RBP、返回槽预校验)→ step(ret:弹 6)→ RIP = 6 → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(FRAME.buffer, overflowPayload(le64(X01_WIN))),
          ...steps(2),
        ],
      },
      {
        name: "walking into lose exits with code one and fails",
        description:
          "边界(wrong_answer 方向):不写 payload 直接 step×3(leave、ret、lose 的 exit(1))。" +
          "程序终止(halted)但会话状态保持 running、win 条件不成立 → wrong_answer" +
          "(实跑核实:exit 不置 failed 终态,只停执行)。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: steps(3),
      },
      {
        name: "data value in return slot crashes at leave slot check",
        description:
          "边界(失败方向):把数据值 0xdead 写进返回槽 → leave 的返回槽预校验(与 ret 同规则)" +
          "即报 invalid_rip → failed → program_crash(教学:leave 比 ret 更早暴露坏目标)。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [writeAction(FRAME.retSlot, le64("0xdead")), stepAction()],
      },
      {
        name: "write into read only code region is rejected with explanation",
        description:
          "边界(教学失败方向):向 rx 代码区写入 → permission_denied(交互可解释;" +
          "status 非 rejected、revision 前进);裁决走非终态 wrong_answer。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        expectedLastError: "permission_denied",
        actions: [writeAction(CODE_BASE, "90")],
      },
    ],
  },

  // ── X-02:最小 ROP(字节模式)───────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-x02-rop-minimal",
      title: "借力打力:最小 ROP 链",
      objective:
        "在字节模式下构造最小 ROP 链:利用现成 gadget(pop RDI; ret)给 win 块喂参数,理解\"返回地址序列即程序\"的 ROP 核心思想,以及 win 块自带 cmp 门(参数错 → fail)的校验语义。",
      observationPoints: [
        "首次成功时间(gadget 链概念格)",
        "错误类型分布(链序 / 参数缺失)",
        "提示使用等级",
      ],
      mode: "byte",
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-x02-rop-minimal",
        title: "借力打力:最小 ROP 链",
        summary:
          "这一题没有\"把 win 地址写进返回槽\"这么简单:win 块入口自带校验(cmp RDI, 0xDEADBEEF;" +
          "不等就跳 fail → exit(1)),只有参数正确、径直走到胜利标记才计数通过。" +
          "好在代码段里有个工具函数的收尾 gadget(0x400300:pop RDI; ret)。返回槽之后栈上" +
          "依次放好\"参数\"和\"下一跳\",一条 ret 就能串起整条链:劫持 → 喂参 → 进 win。",
        learningObjectives: [
          "阅读公开编码表与代码段,定位可用 gadget",
          "构造\"gadget + 参数 + 目标\"的栈上 ROP 链",
        ],
        allowedActions: ["write_bytes", "step", "ret"],
        mode: "byte",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(BYTE_ENTRY) }],
        extraRegisters: [
          { name: "RDI", displayLabel: "参数寄存器(ROP 链第一传参)", valueHex: "0x0" },
        ],
        successCondition: {
          all: [
            {
              all: [
                {
                  predicate: {
                    type: "register_equals",
                    register: "FLAG0",
                    valueHex: "0x1337",
                  },
                },
              ],
            },
          ],
        },
        encodingExtras: [
          { tokenHex: "0x5f", op: "pop", operands: [{ kind: "register", name: "RDI" }] },
          {
            tokenHex: "0x81",
            op: "cmp",
            operands: [
              { kind: "register", name: "RDI" },
              { kind: "immediate", width: "arch" },
            ],
          },
          { tokenHex: "0x75", op: "jne", operands: [{ kind: "immediate", width: "arch" }] },
          { tokenHex: "0xcd", op: "syscall", operands: [{ kind: "immediate", width: "arch" }] },
          { tokenHex: "0xd0", op: "WINFLAG" },
        ],
        customInstructionExtras: [
          {
            mnemonic: "WINFLAG",
            displayText: "胜利标记:置位标志寄存器",
            semantics: [
              { op: "set_flag", flagRegister: "FLAG0", valueHex: "0x1337" },
            ],
          },
        ],
        bytePatches: [
          // 入口 0x400010:ret——"门开着,就等你来劫持"(正常返回 = 入口空转)。
          { offset: BYTE_ENTRY_OFFSET, hex: "c3" },
          // win 块 0x400200:cmp RDI,0xDEADBEEF; jne fail; WINFLAG; ret
          { offset: 0x200, hex: "81" + le64(ROP_KEY) },
          { offset: 0x209, hex: "75" + le64(BYTE_FAIL) },
          { offset: 0x212, hex: "d0" },
          { offset: 0x213, hex: "c3" },
          // fail 块 0x400220:syscall exit(1); ret
          { offset: 0x220, hex: "cd" + le64("0x1") },
          { offset: 0x229, hex: "c3" },
          // gadget 0x400300:pop RDI; ret(工具函数 load_arg 的收尾)
          { offset: 0x300, hex: "5fc3" },
        ],
        semanticHighlights: [
          {
            kind: "buffer_start",
            targetRegionId: "stack",
            startAddressHex: FRAME.buffer,
            byteLength: 16,
            label: "输入缓冲区",
          },
          {
            kind: "return_address_slot",
            targetRegionId: "stack",
            startAddressHex: FRAME.retSlot,
            byteLength: 8,
            label: "返回地址槽(ROP 链起点)",
          },
        ],
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "编码表就是 ISA:0xc3 = ret、0x5f = pop RDI、0xd0 = WINFLAG。gadget 在 0x400300(pop RDI; ret),win 块在 0x400200,fail 块在 0x400220。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "ROP 链就是栈上的返回地址序列:ret 槽填 gadget;gadget 的 pop RDI 会吃掉槽后第 1 个 8 字节作参数;它的 ret 再弹出第 2 个 8 字节作下一跳。" },
          { order: 3, revealPolicy: "after_n_failures", failureThreshold: 4, hintText: "完整链 = 0x400300 + 0xDEADBEEF + 0x400200(各 8 字节小端,payload 共 48 字节);参数错了 win 块的 jne 会把你送进 fail 的 exit(1)。" },
        ],
        publicErrorMapping: [
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值没有落在可执行字节上:检查链上每个 8 字节的端序与取值。" },
          { errorCode: "permission_denied", teachingNote: "代码段只读不可写(W^X);链要写在栈上。" },
        ],
      }),
    corpora: [
      {
        name: "rop chain feeds gadget argument and reaches winflag",
        description:
          "参考解:48 字节链(gadget 0x400300 + 参数 0xDEADBEEF + win 0x400200)→ ret(弹 gadget)" +
          "→ step(pop RDI 吃参数)→ step(ret 弹 win)→ step(cmp 相等)→ step(jne 不跳)" +
          "→ step(WINFLAG:FLAG0 = 0x1337)→ won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(
            FRAME.buffer,
            overflowPayload(le64(BYTE_GADGET) + le64(ROP_KEY) + le64(BYTE_WIN)),
          ),
          { type: "ret", args: {} },
          ...steps(5),
        ],
      },
      {
        name: "wrong argument trips win block guard into fail exit",
        description:
          "边界(wrong_answer 方向):链相同但参数错(0xDEADBEE0)→ win 块 cmp 不等 → " +
          "jne 跳 fail → exit(1)。程序终止(halted)、FLAG0 未置位 → running → wrong_answer。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [
          writeAction(
            FRAME.buffer,
            overflowPayload(le64(BYTE_GADGET) + le64("0xdeadbee0") + le64(BYTE_WIN)),
          ),
          { type: "ret", args: {} },
          ...steps(5),
        ],
      },
      {
        name: "reversed endian chain target crashes on gadget ret",
        description:
          "边界(失败方向):链尾(下一跳)端序写反 → gadget 的 ret 弹出后无法译码 → " +
          "invalid_rip → failed → program_crash。",
        expectedFinalStatus: "failed",
        expectedVerdict: "program_crash",
        actions: [
          writeAction(
            FRAME.buffer,
            overflowPayload(le64(BYTE_GADGET) + le64(ROP_KEY) + reversed(le64(BYTE_WIN))),
          ),
          { type: "ret", args: {} },
          ...steps(2),
        ],
      },
      {
        name: "padding only keeps original return target dormant",
        description:
          "边界(wrong_answer 变体):只填充缓冲区 → ret 弹出原入口 0x400010(入口即 ret,空转)" +
          "→ 未劫持 → 非终态 → wrong_answer。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [writeAction(FRAME.buffer, "41".repeat(16)), { type: "ret", args: {} }],
      },
    ],
  },

  // ── X-03:整数截断(IR)─────────────────────────────────────────────────
  {
    meta: {
      challengeId: "sm-x03-int-truncation-ir",
      title: "量过的尺子是断的:整数截断盲区",
      objective:
        "理解整数截断(CWE-681)类缺陷:下限检查只看数量的最低 1 字节(8 位检查 ≠ 64 位范围检查),而 length = size − 16 又没有上界——检查通过不代表地址安全,高位字节会把写入目标送到任意远处。",
      observationPoints: [
        "首次成功时间(截断盲区概念格)",
        "错误类型分布(memory_fault 与 wrong_answer 的比例)",
        "提示使用等级",
      ],
      mode: "ir",
    },
    buildPair: () =>
      buildPairFromSpec({
        challengeId: "sm-x03-int-truncation-ir",
        title: "量过的尺子是断的:整数截断盲区",
        summary:
          "服务从全局配置区(0x600000)读取输入长度 size,并做\"数量下限检查\":size 的最低 " +
          "1 字节必须 ≥ 0x10(至少 16 字节)。检查通过后 length = size − 16,程序把 8 字节备注" +
          "([0x600008])写到 buf + length——而 buf 是栈上的输入缓冲区 0x7ffff7f0。" +
          "检查只看低 1 字节,size 本身没有任何上界:高位字节会原样进入 length。" +
          "把 size 调到\"检查通过但 length 恰为 24\",备注值填 win 指令索引,8 字节备注就会" +
          "precise 地落在返回地址槽上。",
        learningObjectives: [
          "理解\"8 位检查 ≠ 64 位范围检查\"的截断盲区(CWE-681)",
          "利用无上界的偏移算术把任意写投递到返回地址槽",
        ],
        teachingNotes: [
          "add 溢出会被引擎安全终止(错误面);真正的 bug 是\"检查只看低字节 + 无上界\"",
        ],
        allowedActions: ["write_bytes", "step"],
        mode: "ir",
        frame: FRAME,
        stackWrites: [{ offset: offsetOf(FRAME.retSlot), hex: le64(X03_LOSE) }],
        extraRegions: [
          {
            regionId: "cfg",
            kind: "global",
            startAddressHex: CFG_BASE,
            permissions: "rw",
            publicLabel: "长度配置(全局区)",
          },
        ],
        extraRegisters: [
          { name: "RCFG", displayLabel: "配置区基址(0x600000)", valueHex: CFG_BASE },
          { name: "RBUF", displayLabel: "输入缓冲区基址", valueHex: FRAME.buffer },
          { name: "RSIZE", displayLabel: "输入长度 size", valueHex: "0x0" },
          { name: "RTMP", displayLabel: "截断检查临时寄存器", valueHex: "0x0" },
          { name: "RVAL", displayLabel: "待写入的 8 字节备注", valueHex: "0x0" },
          { name: "RDST", displayLabel: "写入目标 = buf + length", valueHex: "0x0" },
        ],
        successCondition: irRipWinCondition(X03_WIN),
        irProgram: {
          entrypointIndex: 0,
          instructions: [
            // 0:size = [RCFG]
            {
              op: "mov",
              operands: [
                { kind: "register", name: "RSIZE" },
                { kind: "memory", baseRegister: "RCFG", displacementHex: "0x0" },
              ],
            },
            // 1~3:RTMP = size 的最低 1 字节(shl 56 后 shr 56 = 8 位截断检查)
            {
              op: "mov",
              operands: [
                { kind: "register", name: "RTMP" },
                { kind: "register", name: "RSIZE" },
              ],
            },
            { op: "shl", operands: [{ kind: "register", name: "RTMP" }, { kind: "immediate", valueHex: "0x38" }] },
            { op: "shr", operands: [{ kind: "register", name: "RTMP" }, { kind: "immediate", valueHex: "0x38" }] },
            // 4~5:下限检查:低字节 < 0x10 → lose
            { op: "cmp", operands: [{ kind: "register", name: "RTMP" }, { kind: "immediate", valueHex: "0x10" }] },
            { op: "jb", operands: [{ kind: "immediate", valueHex: X03_LOSE }] },
            // 6:⚠ length = size − 16(无上界 = bug 本体)
            { op: "sub", operands: [{ kind: "register", name: "RSIZE" }, { kind: "immediate", valueHex: "0x10" }] },
            // 7~8:dst = buf + length
            {
              op: "mov",
              operands: [
                { kind: "register", name: "RDST" },
                { kind: "register", name: "RBUF" },
              ],
            },
            { op: "add", operands: [{ kind: "register", name: "RDST" }, { kind: "register", name: "RSIZE" }] },
            // 9:note = [RCFG+0x8]
            {
              op: "mov",
              operands: [
                { kind: "register", name: "RVAL" },
                { kind: "memory", baseRegister: "RCFG", displacementHex: "0x8" },
              ],
            },
            // 10:mov [RDST], RVAL —— 8 字节"任意写"(偏移攻击者可控)
            {
              op: "mov",
              operands: [
                { kind: "memory", baseRegister: "RDST", displacementHex: "0x0" },
                { kind: "register", name: "RVAL" },
              ],
            },
            // 11:ret(劫持点;动态目标 → XC-IR-REACH 保守全图可达,win 块合法)
            { op: "ret", operands: [] },
            // [win] 12:exit(0);[lose] 13:exit(1)
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x0" }] },
            { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x1" }] },
          ],
          labels: [
            { labelId: "entry", instructionIndex: 0 },
            { labelId: "win", instructionIndex: 12 },
            { labelId: "lose", instructionIndex: 13 },
          ],
        },
        semanticHighlights: [
          {
            kind: "buffer_start",
            targetRegionId: "stack",
            startAddressHex: FRAME.buffer,
            byteLength: 16,
            label: "输入缓冲区(RBUF)",
          },
          {
            kind: "return_address_slot",
            targetRegionId: "stack",
            startAddressHex: FRAME.retSlot,
            byteLength: 8,
            label: "返回地址槽(buf + 24)",
          },
          {
            kind: "custom",
            targetRegionId: "cfg",
            startAddressHex: CFG_SIZE_SLOT,
            byteLength: 16,
            label: "size 与 8 字节备注(截断检查的输入面)",
          },
        ],
        hintLadder: [
          { order: 1, revealPolicy: "on_request", hintText: "配置在 0x600000:size 是 [0x600000] 的 8 字节小端值;检查只看它最低 1 字节(程序里的 shl 0x38 / shr 0x38 就是 8 位截断)。" },
          { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "低字节 ≥ 0x10 即可通过检查;而 length = size − 16 没有任何上界——size 的高位字节会原样进入 buf + length(检查过了,地址照样飞)。" },
          { order: 3, revealPolicy: "after_n_failures", failureThreshold: 4, hintText: "要写中返回槽:buf + length = 0x7ffff808 → length = 24 → size = 40(0x28,低字节 0x28 ✓);备注写在 [0x600008],填 win 指令索引 12(0xc)。" },
        ],
        publicErrorMapping: [
          { errorCode: "inaccessible_address", teachingNote: "写入落在未映射地址:检查通过了,但 size 的高位让 length 失控——这正是截断检查的盲区。" },
          { errorCode: "invalid_rip", teachingNote: "ret 弹出的值不是界内指令索引:检查 [0x600008] 备注值的取值与小端端序。" },
          { errorCode: "permission_denied", teachingNote: "代码段只读不可写(rx);配置要写进 rw 的全局区。" },
        ],
      }),
    corpora: [
      {
        name: "truncation blind spot delivers note onto return slot",
        description:
          "参考解:size = 0x28(低字节 0x28 ≥ 0x10 ✓,length = 24)+ note = win 索引 0xc → " +
          "step×12:第 11 步把 note 写进 ret 槽,第 12 步 ret 弹出 0xc → RIP = 12 → won → success。",
        expectedFinalStatus: "won",
        expectedVerdict: "success",
        actions: [
          writeAction(CFG_SIZE_SLOT, le64("0x28")),
          writeAction(CFG_NOTE_SLOT, le64(X03_WIN)),
          ...steps(12),
        ],
      },
      {
        name: "note pointing at lose exits with code one",
        description:
          "边界(wrong_answer 方向):size = 0x28 但 note = lose 索引 0xd → 8 字节写进 ret 槽后 " +
          "ret 落进 lose → exit(1)。程序终止(halted)、会话保持 running → wrong_answer。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [
          writeAction(CFG_SIZE_SLOT, le64("0x28")),
          writeAction(CFG_NOTE_SLOT, le64(X03_LOSE)),
          ...steps(13),
        ],
      },
      {
        name: "high bytes sail past the check and fault on write",
        description:
          "边界(memory_fault 方向,截断盲区的直接教学):size = 0x100000028——低字节 0x28 通过" +
          "检查,但 length ≈ 4 GiB → buf + length 落在未映射地址 → 第 11 步写备注时 " +
          "memory_fault → failed。检查过了,地址飞了。",
        expectedFinalStatus: "failed",
        expectedVerdict: "memory_fault",
        actions: [
          writeAction(CFG_SIZE_SLOT, le64("0x100000028")),
          writeAction(CFG_NOTE_SLOT, le64(X03_WIN)),
          ...steps(11),
        ],
      },
      {
        name: "undersized low byte is rejected by the lower bound check",
        description:
          "边界(wrong_answer 方向,检查正常工作面):size = 0x8(低字节 0x8 < 0x10)→ jb 跳 lose " +
          "→ exit(1)。下限检查确实拦住了太小的数量;会话保持 running → wrong_answer。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [
          writeAction(CFG_SIZE_SLOT, le64("0x8")),
          writeAction(CFG_NOTE_SLOT, le64(X03_WIN)),
          ...steps(7),
        ],
      },
      {
        name: "zero note sends the return into the program entry",
        description:
          "边界(wrong_answer 变体):size = 0x28、note = 0 → ret 弹出 0——IR 索引 0 是合法执行位" +
          "置,程序从入口重新开始(非终态)。实跑核实:RIP = 0 不触发 invalid_rip(索引界内)。",
        expectedFinalStatus: "running",
        expectedVerdict: "wrong_answer",
        actions: [
          writeAction(CFG_SIZE_SLOT, le64("0x28")),
          writeAction(CFG_NOTE_SLOT, le64("0x0")),
          ...steps(12),
        ],
      },
    ],
  },
];

/** 题目集 ID 索引(测试断言用)。 */
export const EXT_CHALLENGE_IDS: readonly string[] = EXT_CHALLENGES.map(
  (challenge) => challenge.meta.challengeId,
);
