/**
 * 调试变体初始镜像产出(WP-42;ADR-DC1 条款 2 / §六 R2、判题语义规约 §六
 * D-J7–D-J10、WP-40 契约 §七.2 draws 规范槽序)。
 *
 * 输入 = `loadChallengePair` 装载产物(`LoadedChallenge`,三层管线全绿)+ 调试
 * 种子 hex + ASLR 开关;输出 = WP-40 `DebugVariantBundle` 契约形态(出口即过
 * 冻结 Zod Schema,自证;编排器与 worker 侧的复验是纵深防御,非首次校验)。
 *
 * # 布局同构义务(WP-42"结构逐字节同构断言"的产出面)
 *
 *  - `memoryRegions` 与私有包 `initialState.memoryRegions` **逐字段同构、保序**
 *    (regionId / kind / startAddressHex / byteLength / permissions / contentHex /
 *    isHidden);可见区域 contentHex 照抄真实镜像(公开条件集),隐藏区域由
 *    调试种子派生重写;
 *  - `registers` = 私有初始寄存器剔除 FLAG 保留名(变体契约 RegisterNameSchema
 *    结构性排除 FLAG;FLAG 值永不进入任何公开/调试面,I-3 同构);
 *  - `canarySlots` = 私有包 `privateObjects` 中 `kind: "canary"` 的对象同款
 *    (槽对象不携带值);期望字节由调试种子派生后写入**所属区域 contentHex**
 *    (与真实 canary"期望值引擎初始化时从初始内存截取"同构)。
 *
 * # draws 规范槽序(WP-40 §七.2 冻结;派生消费序,双方照此复算)
 *
 *  1. 基址槽:仅 `aslrEnabled = true`,恰 1 次 draw(D-J10 映射算法定案);
 *  2. 区域秘密槽:按 `memoryRegions` 数组序,每个 `isHidden = true` 的区域
 *     消耗 `ceil(byteLength / 8)` 次 draw;每次 draw 产 64 位,小端字节序取
 *     前 8 字节,尾块取低位有效字节;
 *  3. canary 槽:按 `canarySlots` 数组序,每槽消耗 `ceil(byteLength / 8)` 次
 *     draw,取字节序同上,写入所属区域偏移 `(address − regionStart)` 处。
 *
 * `derivation.draws` = 上述消费总数(如实登记;不含种子值)。
 *
 * # ASLR 基址派生(D-J8 首个应用面 / D-J10 映射算法定案)
 *
 * `aslrEnabled = false`(缺省):startAddressHex 照抄真实镜像、无
 * `baseAddresses`、draws 自区域秘密槽起算。
 * `aslrEnabled = true`:**首个 draw 派生基址**,所有区域按同一基址 + 结构相对
 * 偏移重写(`relOffset = start − minStart`,锚定最低区域为基准——与 WP-43
 * 公开包"结构描述"语义同锚),落点为页对齐;落在原结构地址窗
 * `[minStart, maxEnd]` 内的初始寄存器值与 canary 槽地址按同一位移重写
 * (寄存器如 RIP/RSP 携带地址语义,不重写则变体不可执行;窗口外常量值不动),
 * `derivation.baseAddresses` 逐区域登记。
 *
 * # 调试种子纪律
 *
 * 本函数只收种子 hex(8–32 字节,与 seed.rs MIN/MAX_SEED_BYTES 同界);
 * session-api 侧调试种子 = attach 时 `node:crypto` 随机 16 字节、仅在调试编排
 * 器内存存活、不落存储不入日志。真实私有判题包与真实种子零进入本产出面
 * (派生输入只有调试种子)。
 *
 * # IR 模式边界(WP-41 定案)
 *
 * 调试实例恒字节模式装配(vm-worker `assemble_variant`"程序形态边界");
 * IR 模式题目(`program.mode === "ir"`)产出变体即确定性拒绝
 * (`XC-DEBUG-MODE-IR`)——变体契约不携带程序 IR/入口声明面,装载即确定性拒绝。
 */
import {
  ENGINE_PROCESS_PROTOCOL_VERSION,
} from "@stackmaster/protocol";
import {
  DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION,
  DEBUG_VARIANT_SEED_ALGORITHM_ID,
  DebugVariantBundleSchema,
  type DebugVariantBundle,
} from "@stackmaster/protocol/server-only";
import type { CompilerViolation } from "../common/diagnostics.js";
import { COMPILER_RULE_PREFIX, compilerViolation } from "../common/diagnostics.js";
import type { LoadedChallenge } from "../load/pipeline.js";
import {
  MAX_SEED_BYTES,
  MIN_SEED_BYTES,
  SeedDeriver,
  u64ToLittleEndianBytes,
} from "../seed/seed-deriver.js";

/**
 * IR 模式题目不可产出调试变体(调试实例恒字节模式;WP-41 定案的确定性拒绝)。
 */
export const RULE_ID_DEBUG_IR_MODE = `${COMPILER_RULE_PREFIX}DEBUG-MODE-IR`;

/** 调试种子 hex 形态/长度非法(偶长 hex、8–32 字节;seed.rs 同界)。 */
export const RULE_ID_DEBUG_SEED_HEX = `${COMPILER_RULE_PREFIX}DEBUG-SEED-HEX`;

/** ASLR 结构跨度不可映射(结构总跨度超出位宽地址空间或可用页窗口为空)。 */
export const RULE_ID_DEBUG_ASLR_SPACE = `${COMPILER_RULE_PREFIX}DEBUG-ASLR-SPACE`;

/** canary 槽位不落在任何内存区域内(区间无处写入,装配义务不可满足)。 */
export const RULE_ID_DEBUG_CANARY_UNMAPPED = `${COMPILER_RULE_PREFIX}DEBUG-CANARY-UNMAPPED`;

/**
 * FLAG 保留名模式(challenge-schema 双命名空间保留模型同款字面量:
 * `^FLAG[A-Z0-9_]*$`;变体契约 RegisterNameSchema 负向前瞻结构性排除)。
 */
const FLAG_REGISTER_NAME_PATTERN = /^FLAG[A-Z0-9_]*$/;

/** 变体产出失败(确定性拒绝;方向与装载失败同题 = challenge_invalid)。 */
export class DebugVariantBuildError extends Error {
  constructor(
    readonly violations: readonly CompilerViolation[],
    detail: string,
  ) {
    super(`debug variant build rejected: ${detail}`);
    this.name = "DebugVariantBuildError";
  }
}

/** 变体产出选项(调试种子 hex + ASLR 开关;种子值不进任何产物字段)。 */
export interface DebugVariantBuildOptions {
  /** 调试种子(偶长 hex,8–32 字节;session-api 侧 = attach 时随机 16 字节)。 */
  readonly debugSeedHex: string;
  /** ASLR 开关(WP-43 公开描述包声明面镜像;true = 首个 draw 派生基址)。 */
  readonly aslrEnabled: boolean;
}

/** 位宽掩蔽域(archBits 位宽的地址空间字节数)。 */
function addressSpaceBytes(archBits: 32 | 64): bigint {
  return 1n << BigInt(archBits);
}

/** `0x` 前缀 hex → BigInt(Schema 已保证 `^0x[0-9a-fA-F]{1,16}$` 形态)。 */
function parseAddressHex(hex: string): bigint {
  return BigInt(hex);
}

/** BigInt → `0x` 前缀小写 hex(AddressHex 契约形态,1–16 位数字)。 */
function formatAddressHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** 偶长 hex → 字节(Schema 已保证偶长形态)。 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** 字节 → 小写偶长 hex(contentHex 契约形态)。 */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 一次派生 → 内容字节(小端取前 8 字节、尾块取低位有效字节;WP-40 §七.2)。
 * 恰好消耗 `ceil(byteCount / 8)` 次 draw。
 */
function deriveBytes(deriver: SeedDeriver, byteCount: number): Uint8Array {
  const bytes = new Uint8Array(byteCount);
  let filled = 0;
  while (filled < byteCount) {
    const block = u64ToLittleEndianBytes(deriver.nextU64());
    const take = Math.min(8, byteCount - filled);
    bytes.set(block.subarray(0, take), filled);
    filled += take;
  }
  return bytes;
}

export interface AslrBaseDerivationInput {
  /** 首个 draw 的 64 位派生值(基址槽)。 */
  readonly firstDraw: bigint;
  /** 位宽声明(公开包 vmProfile.archBits)。 */
  readonly archBits: 32 | 64;
  /** 页粒度(公开包 vmProfile.pageSizeBytes;基址页对齐)。 */
  readonly pageSizeBytes: number;
  /** 结构总跨度 = max(relOffset + byteLength)(字节;D-J10 定义)。 */
  readonly structuralSpanBytes: bigint;
}

/**
 * ASLR 基址映射算法定案(D-J10;与黄金向量 `baseAddressVectors` 一致):
 *
 * ```text
 * spaceBytes  = 2^archBits
 * masked      = firstDraw & (spaceBytes − 1)        // 位宽掩蔽
 * alignedPage = masked div pageSize                 // 向下页对齐(整除)
 * windowPages = (spaceBytes − span) div pageSize    // 可用页窗口
 * base        = (alignedPage mod windowPages) × pageSize
 * ```
 *
 * 性质:base 页对齐;base + span ≤ 2^archBits(全部区域落在位宽地址空间内);
 * 结果仅由 (firstDraw, archBits, pageSize, span) 决定(确定性,可复算)。
 * span > spaceBytes 或 windowPages = 0 ⇒ 确定性拒绝(XC-DEBUG-ASLR-SPACE;
 * 区域 ≤ 16 MiB × 64 的 Schema 界内实际不可达,防御性兜底)。
 */
export function deriveAslrBaseAddress(input: AslrBaseDerivationInput): bigint {
  const spaceBytes = addressSpaceBytes(input.archBits);
  const pageSize = BigInt(input.pageSizeBytes);
  const span = input.structuralSpanBytes;
  if (span > spaceBytes) {
    throw new DebugVariantBuildError(
      [compilerViolation(
        RULE_ID_DEBUG_ASLR_SPACE,
        `结构总跨度 ${span} 字节超出 ${input.archBits} 位地址空间,ASLR 基址不可映射`,
        "/memoryLayout",
      )],
      "structural span exceeds address space",
    );
  }
  const windowPages = (spaceBytes - span) / pageSize;
  if (windowPages < 1n) {
    throw new DebugVariantBuildError(
      [compilerViolation(
        RULE_ID_DEBUG_ASLR_SPACE,
        `可用页窗口为空(结构总跨度 ${span} 字节 + 页粒度 ${input.pageSizeBytes} 超出地址空间)`,
        "/memoryLayout",
      )],
      "empty page window for aslr base",
    );
  }
  const masked = input.firstDraw & (spaceBytes - 1n);
  const alignedPage = masked / pageSize;
  return (alignedPage % windowPages) * pageSize;
}

/**
 * 产出调试变体初始镜像(纯函数;同种子同输入 ⇒ canonical JSON 逐字节相同)。
 * 失败 = 确定性拒绝(DebugVariantBuildError,违规带 XC- 规则 ID),不产出
 * 部分镜像。
 */
export function buildDebugVariantBundle(
  challenge: LoadedChallenge,
  options: DebugVariantBuildOptions,
): DebugVariantBundle {
  const violations: CompilerViolation[] = [];

  // ── IR 模式确定性拒绝(调试实例恒字节模式;WP-41 定案)──
  if (challenge.program.mode !== "byte") {
    violations.push(compilerViolation(
      RULE_ID_DEBUG_IR_MODE,
      "调试变体镜像仅支持字节模式题目(变体契约不携带程序 IR/入口声明面,调试实例恒字节模式装配)",
      "/program/mode",
    ));
    throw new DebugVariantBuildError(violations, "ir-mode challenge cannot produce a debug variant");
  }

  // ── 调试种子形态校验(偶长 hex、8–32 字节;seed.rs 同界镜像)──
  const seedHex = options.debugSeedHex;
  const seedByteLength = seedHex.length / 2;
  if (
    !Number.isInteger(seedByteLength) ||
    seedHex.length % 2 !== 0 ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(seedHex) ||
    seedByteLength < MIN_SEED_BYTES ||
    seedByteLength > MAX_SEED_BYTES
  ) {
    violations.push(compilerViolation(
      RULE_ID_DEBUG_SEED_HEX,
      `调试种子须为偶长 hex 且长度在 ${MIN_SEED_BYTES}–${MAX_SEED_BYTES} 字节界内`,
      "/options/debugSeedHex",
    ));
    throw new DebugVariantBuildError(violations, "debug seed hex rejected");
  }

  const { publicDescriptor, privateBundle } = challenge;
  const archBits = publicDescriptor.vmProfile.archBits;
  const pageSizeBytes = publicDescriptor.vmProfile.pageSizeBytes;
  const deriver = SeedDeriver.fromHex(seedHex);

  // ── 内存区域(与私有包 initialState.memoryRegions 保序同构)──
  const sourceRegions = privateBundle.initialState.memoryRegions;
  const regionEntries = sourceRegions.map((region) => ({
    region,
    start: parseAddressHex(region.startAddressHex),
  }));
  const minStart = regionEntries.reduce(
    (acc, entry) => (entry.start < acc ? entry.start : acc),
    // Schema minItems: 1 保证非空;`?? 0n` 仅为 noUncheckedIndexedAccess 兜底。
    regionEntries[0]?.start ?? 0n,
  );
  const maxEnd = regionEntries.reduce(
    (acc, entry) => {
      const end = entry.start + BigInt(entry.region.byteLength);
      return end > acc ? end : acc;
    },
    0n,
  );

  // ── 基址槽(仅 ASLR 开,恰 1 次 draw;D-J10 映射)──
  let baseAddress: bigint | null = null;
  if (options.aslrEnabled) {
    const structuralSpanBytes = maxEnd - minStart;
    baseAddress = deriveAslrBaseAddress({
      firstDraw: deriver.nextU64(),
      archBits,
      pageSizeBytes,
      structuralSpanBytes,
    });
  }
  // 区域位移(ASLR 关 = 0n;所有区域同一位移,结构相对布局不变)。
  const regionDelta = baseAddress === null ? 0n : baseAddress - minStart;

  // ── 区域秘密槽(数组序;isHidden 区域内容整体派生重写)──
  const contents = regionEntries.map((entry) => {
    if (entry.region.isHidden) {
      return deriveBytes(deriver, entry.region.byteLength);
    }
    // 可见区域:字节照抄真实镜像(公开条件集)。
    return hexToBytes(entry.region.contentHex);
  });

  // ── canary 槽(数组序;期望字节写入所属区域 contentHex,槽对象不携带值)──
  const canaryObjects = privateBundle.privateObjects.filter(
    (object) => object.kind === "canary",
  );
  const canarySlots = canaryObjects.map((object) => {
    const address = parseAddressHex(object.addressHex);
    const byteLength = BigInt(object.byteLength);
    const owner = regionEntries.find(
      (entry) =>
        address >= entry.start &&
        address + byteLength <= entry.start + BigInt(entry.region.byteLength),
    );
    if (owner === undefined) {
      violations.push(compilerViolation(
        RULE_ID_DEBUG_CANARY_UNMAPPED,
        `canary 槽位 ${object.objectId}(${object.addressHex})不落在任何内存区域内`,
        `/privateObjects/objectId/${object.objectId}`,
      ));
      throw new DebugVariantBuildError(violations, "canary slot outside every region");
    }
    const ownerIndex = regionEntries.indexOf(owner);
    const ownerContent = contents[ownerIndex];
    if (ownerContent === undefined) {
      throw new DebugVariantBuildError(violations, "region content missing (unreachable)");
    }
    const offset = address - owner.start;
    ownerContent.set(deriveBytes(deriver, object.byteLength), Number(offset));
    return {
      objectId: object.objectId,
      kind: "canary" as const,
      addressHex: formatAddressHex(address + regionDelta),
      byteLength: object.byteLength,
      visibility: object.visibility,
      containsSecret: object.containsSecret,
    };
  });

  // ── 初始寄存器(剔除 FLAG 保留名;ASLR 开时结构地址窗内值按同位移重写)──
  const registers = Object.entries(privateBundle.initialState.registers)
    .filter(([name]) => !FLAG_REGISTER_NAME_PATTERN.test(name))
    .map(([name, valueHex]) => {
      const value = parseAddressHex(valueHex);
      const rebased = baseAddress !== null && value >= minStart && value <= maxEnd
        ? value + regionDelta
        : value;
      return { name, valueHex: formatAddressHex(rebased) };
    });

  const memoryRegions = regionEntries.map((entry, index) => ({
    regionId: entry.region.regionId,
    kind: entry.region.kind,
    startAddressHex: formatAddressHex(entry.start + regionDelta),
    byteLength: entry.region.byteLength,
    permissions: entry.region.permissions,
    contentHex: bytesToHex(contents[index] ?? new Uint8Array(0)),
    isHidden: entry.region.isHidden,
  }));

  const variant: DebugVariantBundle = DebugVariantBundleSchema.parse({
    schemaVersion: DEBUG_VARIANT_BUNDLE_SCHEMA_VERSION,
    engineProcessProtocolVersion: ENGINE_PROCESS_PROTOCOL_VERSION,
    challengeId: privateBundle.challengeId,
    challengeContentVersion: privateBundle.challengeContentVersion,
    vmProfileVersion: privateBundle.vmProfileVersion,
    aslrEnabled: options.aslrEnabled,
    derivation: {
      algorithmId: DEBUG_VARIANT_SEED_ALGORITHM_ID,
      draws: deriver.draws(),
      ...(baseAddress === null
        ? {}
        : {
            baseAddresses: regionEntries.map((entry) => ({
              regionId: entry.region.regionId,
              addressHex: formatAddressHex(entry.start + regionDelta),
            })),
          }),
    },
    memoryRegions,
    registers,
    ...(canarySlots.length === 0 ? {} : { canarySlots }),
  });
  return variant;
}
