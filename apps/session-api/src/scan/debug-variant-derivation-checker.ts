/**
 * 调试变体派生复算检查器(阶段四 WP-44;ZR-B13,ADR-DC1 §四前置项 5)。
 *
 * 断言语义(上游条目:`docs/contracts/数据分类与秘密零驻留清单.md` §9.1
 * ZR-B13 行):以 TS `SeedDeriver`(`splitmix64-stream-v1`,与 vm-core seed.rs
 * 黄金向量锁死的 TS 侧移植)按 WP-40 调试通道协议语义 §七.2 **规范槽序**复算
 * 变体派生字节,与变体声明面逐项比对:
 *
 *   1. 基址槽(仅 `aslrEnabled = true`,恰 1 次 draw):`deriveAslrBaseAddress`
 *      复算调试基址 ⇒ 与 `min(memoryRegions.startAddressHex)` 及
 *      `derivation.baseAddresses` 逐区域比对;
 *   2. 区域秘密槽(按 `memoryRegions` 数组序):每个 `isHidden = true` 的区域
 *      消耗 `ceil(byteLength / 8)` 次 draw,整区域内容重写 ⇒ 与变体
 *      `contentHex` 逐字节比对;
 *   3. canary 槽(按 `canarySlots` 数组序):每槽消耗 `ceil(byteLength / 8)`
 *      次 draw,写入所属区域偏移 `(addressHex − startAddressHex)` 处 ⇒ 叠加后
 *      与变体 `contentHex` 逐字节比对;
 *   4. `derivation.draws` = 上述消费总数(如实登记复核)。
 *
 * 价值(ADR-DC1 条款 9):同种子的调试视图 = 谓词期望值答案册——答案册的
 * 可信度依赖"变体确由声明的 `algorithmId` / 槽序 / 调试种子派生";派生复算
 * 使该依赖可机检,与 ZR-B12(通道输出 ⊆ 变体)构成两个可机检方向(变体 ⊆
 * 声明派生)。复算方与产出方(buildDebugVariantBundle)共用同一派生原语、
 * 独立实现槽序消费,与确定性属性测试(同种子同序列)互补。
 *
 * 依赖纪律:仅依赖 `@stackmaster/challenge-compiler` 的派生原语(SeedDeriver /
 * deriveAslrBaseAddress / 算法标识;session-api 生产 Provider 同源依赖,无新增
 * 依赖边),零 IO、零运行时/会话依赖;单测进常规 CI。变体视图取结构形态,与
 * WP-40 `DebugVariantBundle` 冻结 Schema 解析产物结构兼容。
 */
import {
  SEED_ALGORITHM_ID,
  SeedDeriver,
  deriveAslrBaseAddress,
} from "@stackmaster/challenge-compiler";

/** 复算命中(条目 ID 携带上游清单编号;path 为变体内 JSON 指针风格路径)。 */
export interface ZrB13Violation {
  readonly id:
    | "ZR-B13-algorithm-id"
    | "ZR-B13-draws-mismatch"
    | "ZR-B13-base-address-mismatch"
    | "ZR-B13-hidden-region-content-mismatch"
    | "ZR-B13-canary-content-mismatch"
    | "ZR-B13-canary-unmapped"
    | "ZR-B13-region-content-length";
  readonly path: string;
  /** 命中证据(声明值 / 复算值前缀;非真实种子、非完整秘密字节)。 */
  readonly token: string;
  readonly detail: string;
}

/** 派生元数据视图(WP-40 `derivation` 同构子集)。 */
export interface DebugVariantDerivationView {
  readonly algorithmId: string;
  readonly draws: number;
  readonly baseAddresses?: readonly {
    readonly regionId: string;
    readonly addressHex: string;
  }[];
}

/** 内存区域视图(WP-40 `memoryRegions` 同构子集)。 */
export interface DebugVariantRegionDerivationView {
  readonly regionId: string;
  readonly startAddressHex: string;
  readonly byteLength: number;
  readonly contentHex: string;
  readonly isHidden: boolean;
}

/** canary 槽视图(WP-40 `canarySlots` 同构子集;槽对象不携带值)。 */
export interface DebugVariantCanarySlotView {
  readonly objectId: string;
  readonly addressHex: string;
  readonly byteLength: number;
}

/** 复算输入(变体视图 + 声称的调试种子 + 位宽 / 页粒度)。 */
export interface DebugVariantDerivationCheckInput {
  readonly variant: {
    readonly aslrEnabled: boolean;
    readonly derivation: DebugVariantDerivationView;
    readonly memoryRegions: readonly DebugVariantRegionDerivationView[];
    readonly canarySlots?: readonly DebugVariantCanarySlotView[];
  };
  /** 声称的调试种子(偶长 hex,8–32 字节;值不进任何命中证据)。 */
  readonly debugSeedHex: string;
  /** 位宽声明(公开包 vmProfile.archBits;ASLR 基址映射算法入参)。 */
  readonly archBits: 32 | 64;
  /** 页粒度(公开包 vmProfile.pageSizeBytes;基址页对齐)。 */
  readonly pageSizeBytes: number;
}

function parseAddressHex(hex: string): bigint | null {
  return /^0x[0-9a-fA-F]{1,16}$/.test(hex) ? BigInt(hex) : null;
}

/** 偶长 hex → 字节(变体契约形态已由 Schema 保证;防御性容忍返回 null)。 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    return null;
  }
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
 * 字节化形态与 challenge-compiler `u64ToLittleEndianBytes` 同构(该原语未出
 * 包入口,此处按同一冻结形态本地实现;黄金向量锁定跨语言一致性)。
 */
function deriveBytes(deriver: SeedDeriver, byteCount: number): Uint8Array {
  const bytes = new Uint8Array(byteCount);
  let filled = 0;
  while (filled < byteCount) {
    const value = deriver.nextU64() & 0xffff_ffff_ffff_ffffn;
    const take = Math.min(8, byteCount - filled);
    for (let index = 0; index < take; index += 1) {
      bytes[filled + index] = Number((value >> BigInt(8 * index)) & 0xffn);
    }
    filled += take;
  }
  return bytes;
}

/**
 * 复算变体派生面(纯函数;零命中 = 变体与声明的种子 / 槽序 / 计数一致)。
 * 槽序消费与比对分两阶段:阶段 A = 基址 + 隐藏区域内容;阶段 B = canary
 * 叠加后的最终内容——使命中可归因到派生面(隐藏区域 / canary)。
 */
export function checkDebugVariantDerivation(
  input: DebugVariantDerivationCheckInput,
): ZrB13Violation[] {
  const violations: ZrB13Violation[] = [];
  const { variant } = input;
  const regions = variant.memoryRegions;

  // ── 算法标识(封闭字面量;与 vm-core SeedDeriver 同一算法标识)──
  if (variant.derivation.algorithmId !== SEED_ALGORITHM_ID) {
    violations.push({
      id: "ZR-B13-algorithm-id",
      path: "$/derivation/algorithmId",
      token: variant.derivation.algorithmId,
      detail: `派生算法标识非封闭字面量 ${SEED_ALGORITHM_ID}`,
    });
  }

  // ── 区域内容长度一致性(contentHex 与 byteLength 必须同长;不一致时该
  // 区域的逐字节复算无意义,先行登记)──
  const contentBytes: (Uint8Array | null)[] = regions.map((region) => {
    if (region.contentHex.length !== region.byteLength * 2) {
      violations.push({
        id: "ZR-B13-region-content-length",
        path: `$/memoryRegions/${regions.indexOf(region)}/contentHex`,
        token: `${region.contentHex.length / 2}B ≠ byteLength ${region.byteLength}`,
        detail: "区域 contentHex 字节长度与 byteLength 不一致(变体契约违反)",
      });
    }
    return hexToBytes(region.contentHex);
  });

  const deriver = SeedDeriver.fromHex(input.debugSeedHex);

  // ── 槽 1:基址(仅 ASLR 开;恰 1 次 draw)──
  if (variant.aslrEnabled) {
    const starts = regions.map((region) => parseAddressHex(region.startAddressHex));
    if (starts.some((start) => start === null) || regions.length === 0) {
      violations.push({
        id: "ZR-B13-base-address-mismatch",
        path: "$/memoryRegions",
        token: "unparsable-start",
        detail: "区域起始地址形态非法,基址复算不可进行",
      });
    } else {
      const startValues = starts.map((start) => start as bigint);
      const minStart = startValues.reduce((acc, value) => (value < acc ? value : acc));
      const maxEnd = regions.reduce((acc, region, index) => {
        // regions 非空已在上分支保证;starts 与 regions 同长(index 必在界内)。
        const start = startValues[index];
        if (start === undefined) {
          return acc;
        }
        const end = start + BigInt(region.byteLength);
        return end > acc ? end : acc;
      }, 0n);
      const base = deriveAslrBaseAddress({
        firstDraw: deriver.nextU64(),
        archBits: input.archBits,
        pageSizeBytes: input.pageSizeBytes,
        structuralSpanBytes: maxEnd - minStart,
      });
      if (base !== minStart) {
        violations.push({
          id: "ZR-B13-base-address-mismatch",
          path: "$/derivation/baseAddresses",
          token: `min(start)=${minStart.toString(16)}`,
          detail: `首个 draw 复算基址 0x${base.toString(16)} 与变体最低区域起始不一致`,
        });
      }
      // baseAddresses 逐区域登记与区域表逐项一致(同序同 id 同地址)。
      const declared = variant.derivation.baseAddresses;
      if (
        declared === undefined ||
        declared.length !== regions.length ||
        declared.some((entry, index) => {
          const region = regions[index];
          return (
            region === undefined ||
            entry.regionId !== region.regionId ||
            parseAddressHex(entry.addressHex) !== startValues[index]
          );
        })
      ) {
        violations.push({
          id: "ZR-B13-base-address-mismatch",
          path: "$/derivation/baseAddresses",
          token: declared === undefined ? "absent" : `${declared.length} entries`,
          detail: "baseAddresses 逐区域登记与 memoryRegions 不一致(ASLR 开 = 必须逐区域对应)",
        });
      }
    }
  } else if (variant.derivation.baseAddresses !== undefined) {
    violations.push({
      id: "ZR-B13-base-address-mismatch",
      path: "$/derivation/baseAddresses",
      token: "present",
      detail: "ASLR 关 ⇒ derivation.baseAddresses 必须缺席(基址与真实镜像一致)",
    });
  }

  // ── 槽 2:区域秘密槽(数组序;isHidden 区域内容整体派生重写)──
  // expected = 复算内容(隐藏区域)/ 变体声明内容透传(可见区域)。
  // 槽序消费与内容合法性解耦:即使某区域 contentHex 形态非法(已另行登记),
  // 派生消费照常推进,保证 draws 复算与槽序记账确定性。
  const expectedStageA: (Uint8Array | null)[] = regions.map((region, index) => {
    if (region.isHidden) {
      return deriveBytes(deriver, region.byteLength);
    }
    return contentBytes[index] ?? null;
  });
  regions.forEach((region, index) => {
    const actual = contentBytes[index];
    const expected = expectedStageA[index];
    if (region.isHidden && actual !== null && actual !== undefined && expected !== null && expected !== undefined) {
      if (bytesToHex(actual) !== bytesToHex(expected)) {
        violations.push({
          id: "ZR-B13-hidden-region-content-mismatch",
          path: `$/memoryRegions/${index}/contentHex`,
          token: `${region.regionId}:actual=${bytesToHex(actual.subarray(0, 4))}…`,
          detail: "隐藏区域内容与声称种子按规范槽序的复算不一致",
        });
      }
    }
  });

  // ── 槽 3:canary 槽(数组序;期望字节写入所属区域偏移处)──
  const expectedStageB = expectedStageA.map((content) =>
    content === null || content === undefined ? null : Uint8Array.from(content),
  );
  for (const slot of variant.canarySlots ?? []) {
    // 派生消费先行(槽序记账确定性,与槽位定位结果解耦)。
    const derived = deriveBytes(deriver, slot.byteLength);
    const address = parseAddressHex(slot.addressHex);
    if (address === null) {
      violations.push({
        id: "ZR-B13-canary-unmapped",
        path: "$/canarySlots",
        token: slot.objectId,
        detail: "canary 槽地址形态非法",
      });
      continue;
    }
    const ownerIndex = regions.findIndex((region) => {
      const start = parseAddressHex(region.startAddressHex);
      return (
        start !== null &&
        address >= start &&
        address < start + BigInt(region.byteLength)
      );
    });
    const owner = ownerIndex >= 0 ? regions[ownerIndex] : undefined;
    const ownerContent = expectedStageB[ownerIndex];
    if (owner === undefined || ownerContent === null || ownerContent === undefined) {
      violations.push({
        id: "ZR-B13-canary-unmapped",
        path: "$/canarySlots",
        token: slot.objectId,
        detail: "canary 槽位不落在任何内存区域内(区间无处写入)",
      });
      continue;
    }
    const start = parseAddressHex(owner.startAddressHex) as bigint;
    const offset = Number(address - start);
    ownerContent.set(derived, offset);
  }
  regions.forEach((region, index) => {
    const actual = contentBytes[index];
    const stageA = expectedStageA[index];
    const stageB = expectedStageB[index];
    if (
      actual === null ||
      actual === undefined ||
      stageB === null ||
      stageB === undefined ||
      stageA === null ||
      stageA === undefined
    ) {
      return;
    }
    const actualHex = bytesToHex(actual);
    const stageBHex = bytesToHex(stageB);
    if (actualHex === stageBHex) {
      return;
    }
    if (region.isHidden && actualHex !== bytesToHex(stageA)) {
      // 阶段 A 已归因隐藏区域内容不一致(避免同一区域双重报告)。
      return;
    }
    violations.push({
      id: "ZR-B13-canary-content-mismatch",
      path: `$/memoryRegions/${index}/contentHex`,
      token: `${region.regionId}:actual=${actualHex.slice(0, 8)}…`,
      detail: "区域内容与 canary 槽叠加后的复算不一致(canary 派生面与变体声明不符)",
    });
  });

  // ── 槽序消费总数复核(derivation.draws = 变体构造时 next_u64 调用总数)──
  if (deriver.draws() !== variant.derivation.draws) {
    violations.push({
      id: "ZR-B13-draws-mismatch",
      path: "$/derivation/draws",
      token: `declared=${variant.derivation.draws}, recomputed=${deriver.draws()}`,
      detail: "draws 声明值与规范槽序复算的派生次数不一致",
    });
  }

  return violations;
}
