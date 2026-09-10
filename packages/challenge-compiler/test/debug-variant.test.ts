/**
 * 调试变体镜像产出测试(WP-42 完成标准;ADR-DC1 条款 2 / §六 R2)。
 *
 * 覆盖面:
 *  - 同构断言:变体与真实镜像 region 集合 / 大小 / 权限 / kind / 顺序 / 可见
 *    区域 contentHex 逐字段相同,registers 剔 FLAG 后同构;
 *  - 差分断言:秘密槽值(isHidden 区域 + canary 字节)≠ 真实值;
 *  - draws 规范槽序精确对应:槽数与 draws 计数一致,按 WP-40 §七.2 槽序
 *    (基址槽 → 区域秘密槽数组序 → canary 槽数组序)手算期望字节;
 *  - ASLR on/off 双形态冻结 Schema 校验;基址映射对黄金向量样例组一致;
 *  - 非法输入确定性拒绝(种子长度越界 / IR 模式 / canary 无所属区域);
 *  - fast-check 属性:同种子两次产出 canonical JSON 逐字节相同;不同种子
 *    → 全部秘密槽值必不同(用例数 60,防拖慢)。
 *
 * 测试语料全部占位(照 SEED_HEX_FIXTURE / SECRET_FLAG_PLACEHOLDER 惯例),
 * 真实种子 / flag 不进任何文件。
 */
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DebugVariantBundleSchema } from "@stackmaster/protocol/server-only";
import type { MemoryRegionSeed, PrivateObjectRecord } from "@stackmaster/challenge-schema/server-only";
import {
  buildDebugVariantBundle,
  DebugVariantBuildError,
  deriveAslrBaseAddress,
  loadChallengePair,
  RULE_ID_DEBUG_ASLR_SPACE,
  RULE_ID_DEBUG_CANARY_UNMAPPED,
  RULE_ID_DEBUG_IR_MODE,
  RULE_ID_DEBUG_SEED_HEX,
  SeedDeriver,
  type DebugVariantBuildOptions,
  type LoadedChallenge,
} from "../src/index.js";
import { buildBytePair, buildIrPair } from "./helpers/private-bundle.js";

/** 可变私有包视图(mutate 语料;类型断言绕过是测试语料构造的预期形态)。 */
interface MutableBundleView {
  initialState: { registers: Record<string, string>; memoryRegions: MemoryRegionSeed[] };
  privateObjects: PrivateObjectRecord[];
}

/** 测试种子(占位语料;16 字节,与私有包夹具 SEED_HEX_FIXTURE 同值域)。 */
const DEBUG_SEED_HEX = "00112233445566778899aabbccddeeff";

/** 隐藏区域(与公开区域不相交;零装载使隐藏区域在调试实例公开)。 */
const VAULT_REGION: MemoryRegionSeed = {
  regionId: "debug-vault",
  kind: "key",
  startAddressHex: "0x405000",
  byteLength: 4096,
  permissions: "rw",
  contentHex: "00".repeat(4096),
  isHidden: true,
};

/** canary 槽(隐藏区域内,偏移 0x7f8;真实值全零,派生值必不同)。 */
const VAULT_CANARY: PrivateObjectRecord = {
  objectId: "vault-canary",
  kind: "canary",
  addressHex: "0x4057f8",
  byteLength: 8,
  visibility: "hidden",
  containsSecret: true,
};

/** 字节模式配对 + 增补语料(隐藏区域 / canary)。 */
function bytePairWithSecrets(options: {
  extraHiddenRegion?: MemoryRegionSeed;
  canary?: PrivateObjectRecord;
} = {}): { publicDescriptor: unknown; privateBundle: unknown } {
  const base = buildBytePair();
  const bundle = structuredClone(base.privateBundle) as unknown as MutableBundleView & Record<string, unknown>;
  bundle.initialState.memoryRegions.push(VAULT_REGION);
  if (options.extraHiddenRegion !== undefined) {
    bundle.initialState.memoryRegions.push(options.extraHiddenRegion);
  }
  if (options.canary !== undefined) {
    bundle.privateObjects.push(options.canary);
  }
  return { publicDescriptor: structuredClone(base.publicDescriptor), privateBundle: bundle };
}

function loadOk(pair: { publicDescriptor: unknown; privateBundle: unknown }): LoadedChallenge {
  const loaded = loadChallengePair(pair);
  if (!loaded.ok) {
    throw new Error(`测试配对装载失败:${loaded.violations.map((item) => item.ruleId).join(",")}`);
  }
  return loaded.challenge;
}

function build(pair: { publicDescriptor: unknown; privateBundle: unknown }, options: DebugVariantBuildOptions) {
  return buildDebugVariantBundle(loadOk(pair), options);
}

interface GoldenVectorFile {
  readonly baseAddressVectors: readonly {
    readonly name: string;
    readonly seedHex: string;
    readonly archBits: number;
    readonly pageSizeBytes: number;
    readonly structuralSpanBytes: number;
    readonly firstDrawU64Hex: string;
    readonly expectedBaseAddressHex: string;
  }[];
}

const GOLDEN = JSON.parse(
  readFileSync(new URL("./golden/seed-derivation-vectors.json", import.meta.url), "utf8"),
) as GoldenVectorFile;

function regionOf(
  variant: { memoryRegions: { regionId: string; contentHex: string; startAddressHex: string; byteLength: number; kind: string; permissions: string; isHidden: boolean }[] },
  regionId: string,
) {
  const region = variant.memoryRegions.find((entry) => entry.regionId === regionId);
  if (region === undefined) {
    throw new Error(`区域 ${regionId} 不在变体内`);
  }
  return region;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 手算面:连续 draw 的块字节化(小端取前 8 字节、尾块低位;WP-40 §七.2)。 */
function deriveBlocks(deriver: SeedDeriver, byteCount: number): Uint8Array {
  const bytes = new Uint8Array(byteCount);
  let filled = 0;
  while (filled < byteCount) {
    const block = deriver.nextU64();
    const take = Math.min(8, byteCount - filled);
    for (let lane = 0; lane < take; lane += 1) {
      bytes[filled + lane] = Number((block >> BigInt(8 * lane)) & 0xffn);
    }
    filled += take;
  }
  return bytes;
}

describe("调试变体产出:布局同构断言(ASLR 关)", () => {
  const pair = bytePairWithSecrets({ canary: VAULT_CANARY });
  const variant = build(pair, { debugSeedHex: DEBUG_SEED_HEX, aslrEnabled: false });
  const privateRegions = (pair.privateBundle as unknown as MutableBundleView).initialState.memoryRegions;

  it("冻结 Schema 校验通过(出口自证;aslrEnabled = false 无 baseAddresses)", () => {
    expect(() => DebugVariantBundleSchema.parse(variant)).not.toThrow();
    expect(variant.aslrEnabled).toBe(false);
    expect(variant.derivation.baseAddresses).toBeUndefined();
    expect(variant.derivation.algorithmId).toBe("splitmix64-stream-v1");
  });

  it("region 集合 / 大小 / 权限 / kind / 顺序与真实镜像逐字段相同", () => {
    expect(variant.memoryRegions.map((region) => region.regionId)).toEqual(
      privateRegions.map((region) => region.regionId),
    );
    for (const [index, source] of privateRegions.entries()) {
      const target = variant.memoryRegions[index];
      expect(target?.kind).toBe(source.kind);
      expect(target?.startAddressHex).toBe(source.startAddressHex);
      expect(target?.byteLength).toBe(source.byteLength);
      expect(target?.permissions).toBe(source.permissions);
      expect(target?.isHidden).toBe(source.isHidden);
    }
  });

  it("可见区域 contentHex 字节照抄真实镜像;contentHex 长度 = 2 × byteLength", () => {
    for (const [index, source] of privateRegions.entries()) {
      const target = variant.memoryRegions[index];
      expect(target?.contentHex.length).toBe(source.byteLength * 2);
      if (!source.isHidden) {
        expect(hexToBytes(target?.contentHex ?? "")).toEqual(hexToBytes(source.contentHex));
      }
    }
  });

  it("registers 同构(FLAG 保留名结构性排除;值按位值比对,hex 大小写规范化)", () => {
    const privateRegisters = (pair.privateBundle as unknown as MutableBundleView).initialState.registers;
    const names = variant.registers.map((register) => register.name);
    expect(names).toContain("RSP");
    expect(names).toContain("RBP");
    expect(names).toContain("RIP");
    expect(names).toContain("RAX");
    expect(names).not.toContain("FLAG0");
    for (const register of variant.registers) {
      expect(BigInt(register.valueHex)).toBe(BigInt(privateRegisters[register.name] ?? "0x0"));
    }
  });

  it("canarySlots 照私有包对象同款(槽不携带值)", () => {
    expect(variant.canarySlots).toHaveLength(1);
    const slot = variant.canarySlots?.[0];
    expect(slot).toMatchObject({
      objectId: "vault-canary",
      kind: "canary",
      addressHex: "0x4057f8",
      byteLength: 8,
      visibility: "hidden",
      containsSecret: true,
    });
    expect(Object.keys(slot ?? {})).not.toContain("valueHex");
    expect(Object.keys(slot ?? {})).not.toContain("bytesHex");
  });

  it("身份三元组照私有包(与会话锁定题目身份同源)", () => {
    expect(variant.challengeId).toBe("ret-basics");
    expect(variant.challengeContentVersion).toBe("1.0.0");
    expect(variant.vmProfileVersion).toBe("1.0.0");
    expect(variant.engineProcessProtocolVersion).toBe(1);
    expect(variant.schemaVersion).toBe(1);
  });

  it("秘密槽值 ≠ 真实值(隐藏区域 + canary 字节;双种子差分面)", () => {
    const vault = regionOf(variant, "debug-vault");
    expect(vault.contentHex).not.toBe(VAULT_REGION.contentHex);
    const canaryBytes = hexToBytes(vault.contentHex).slice(0x7f8, 0x800);
    expect(bytesToHex(canaryBytes)).not.toBe("00".repeat(8));
  });

  it("draws 槽序精确对应:512(隐藏区域)+ 1(canary)= 513,字节按槽序手算一致", () => {
    expect(variant.derivation.draws).toBe(513);
    // 手算:区域秘密槽(数组序,isHidden)→ canary 槽;每 draw 产 u64 小端前 8 字节。
    const deriver = SeedDeriver.fromHex(DEBUG_SEED_HEX);
    const expectedVault = deriveBlocks(deriver, 4096);
    const expectedCanaryBytes = deriveBlocks(deriver, 8);
    // canary 期望字节写入所属区域偏移 0x7f8(槽序在区域派生之后)。
    const expectedPatched = expectedVault.slice();
    expectedPatched.set(expectedCanaryBytes, 0x7f8);
    const vault = regionOf(variant, "debug-vault");
    expect(hexToBytes(vault.contentHex)).toEqual(expectedPatched);
    expect(hexToBytes(vault.contentHex).slice(0x7f8, 0x800)).toEqual(expectedCanaryBytes);
  });
});

describe("调试变体产出:多秘密槽槽序(两隐藏区域 + canary 属第二区域)", () => {
  const secondVault: MemoryRegionSeed = {
    regionId: "debug-vault-2",
    kind: "key",
    startAddressHex: "0x407000",
    byteLength: 8192,
    permissions: "rw",
    contentHex: "00".repeat(8192),
    isHidden: true,
  };
  const secondCanary: PrivateObjectRecord = {
    objectId: "vault-canary-2",
    kind: "canary",
    // 落第二隐藏区域(偏移 0x10)。
    addressHex: "0x407010",
    byteLength: 3,
    visibility: "hidden",
    containsSecret: true,
  };
  const variant = build(
    bytePairWithSecrets({ extraHiddenRegion: secondVault, canary: secondCanary }),
    { debugSeedHex: DEBUG_SEED_HEX, aslrEnabled: false },
  );

  it("draws = 512 + 1024 + 1(3 字节尾块仍消耗整次 draw)= 1537", () => {
    expect(variant.derivation.draws).toBe(1537);
  });

  it("区域内容按数组序连续消费(区域一 → 区域二 → canary),尾块取低位有效字节", () => {
    const deriver = SeedDeriver.fromHex(DEBUG_SEED_HEX);
    const expectedFirst = deriveBlocks(deriver, 4096);
    const expectedSecond = deriveBlocks(deriver, 8192);
    const expectedCanary = deriveBlocks(deriver, 3);
    // canary 期望字节写入第二区域偏移 0x10(槽序在全部区域派生之后)。
    const expectedSecondPatched = expectedSecond.slice();
    expectedSecondPatched.set(expectedCanary, 0x10);
    expect(hexToBytes(regionOf(variant, "debug-vault").contentHex)).toEqual(expectedFirst);
    const second = regionOf(variant, "debug-vault-2");
    expect(hexToBytes(second.contentHex)).toEqual(expectedSecondPatched);
    expect(hexToBytes(second.contentHex).slice(0x10, 0x13)).toEqual(expectedCanary);
    // 消费恰尽:canary 之后无剩余 draw(计数闭合)。
    expect(deriver.draws()).toBe(1537);
  });
});

describe("调试变体产出:ASLR 基址派生(首个应用面;D-J8/D-J10)", () => {
  const pair = bytePairWithSecrets({ canary: VAULT_CANARY });
  const variant = build(pair, { debugSeedHex: DEBUG_SEED_HEX, aslrEnabled: true });
  const privateRegions = (pair.privateBundle as unknown as MutableBundleView).initialState.memoryRegions;
  const minStart = 0x400000n;
  const maxEnd = 0x80000000n;
  const span = maxEnd - minStart;
  const firstDraw = SeedDeriver.fromHex(DEBUG_SEED_HEX).nextU64();
  const expectedBase = deriveAslrBaseAddress({
    firstDraw,
    archBits: 64,
    pageSizeBytes: 4096,
    structuralSpanBytes: span,
  });

  it("冻结 Schema 校验通过(aslrEnabled = true 携带 baseAddresses,draws ≥ 1)", () => {
    expect(() => DebugVariantBundleSchema.parse(variant)).not.toThrow();
    expect(variant.aslrEnabled).toBe(true);
    expect(variant.derivation.baseAddresses).toHaveLength(variant.memoryRegions.length);
    expect(variant.derivation.draws).toBeGreaterThanOrEqual(1);
  });

  it("基址 = D-J10 映射(首个 draw);页对齐且结构整体落在地址空间内", () => {
    expect(variant.derivation.draws).toBe(1 + 512 + 1);
    expect(expectedBase % 4096n).toBe(0n);
    expect(expectedBase + span <= 1n << 64n).toBe(true);
    for (const entry of variant.derivation.baseAddresses ?? []) {
      expect(BigInt(entry.addressHex)).toBe(
        BigInt(regionOf(variant, entry.regionId).startAddressHex),
      );
    }
  });

  it("所有区域 startAddressHex = 同一基址 + 结构相对偏移(结构不变)", () => {
    for (const [index, source] of privateRegions.entries()) {
      const target = variant.memoryRegions[index];
      const expected = BigInt(source.startAddressHex) - minStart + expectedBase;
      expect(BigInt(target?.startAddressHex ?? "0x0")).toBe(expected);
    }
  });

  it("结构地址窗内寄存器与 canary 地址按同一位移重写;窗口外常量不动", () => {
    const registerOf = (name: string) =>
      variant.registers.find((register) => register.name === name)?.valueHex ?? "";
    const delta = expectedBase - minStart;
    expect(BigInt(registerOf("RIP"))).toBe(0x400100n + delta);
    expect(BigInt(registerOf("RSP"))).toBe(0x7ffffff8n + delta);
    expect(BigInt(registerOf("RBP"))).toBe(0x7ffffff8n + delta);
    expect(registerOf("RAX")).toBe("0x0");
    expect(variant.canarySlots?.[0]?.addressHex).toBe(`0x${(0x4057f8n + delta).toString(16)}`);
  });

  it("ASLR 开时秘密槽差分保持(基址槽在先使区域派生序后移一位,内容随之正确平移)", () => {
    const aslrOff = build(pair, { debugSeedHex: DEBUG_SEED_HEX, aslrEnabled: false });
    expect(regionOf(variant, "debug-vault").startAddressHex)
      .not.toBe(regionOf(aslrOff, "debug-vault").startAddressHex);
    // 槽序:ASLR 开 = 基址槽(draw 1)→ 区域秘密槽(draw 2..513)→ canary(draw 514)。
    const deriver = SeedDeriver.fromHex(DEBUG_SEED_HEX);
    deriver.nextU64(); // 基址槽
    const expectedVault = deriveBlocks(deriver, 4096);
    const expectedCanary = deriveBlocks(deriver, 8);
    const expectedPatched = expectedVault.slice();
    expectedPatched.set(expectedCanary, 0x7f8);
    expect(hexToBytes(regionOf(variant, "debug-vault").contentHex)).toEqual(expectedPatched);
  });

  it("基址映射对黄金向量样例组一致(与 vm-worker/TS 双侧复算锚)", () => {
    for (const vector of GOLDEN.baseAddressVectors) {
      const base = deriveAslrBaseAddress({
        firstDraw: BigInt(vector.firstDrawU64Hex),
        archBits: vector.archBits as 32 | 64,
        pageSizeBytes: vector.pageSizeBytes,
        structuralSpanBytes: BigInt(vector.structuralSpanBytes),
      });
      expect(`0x${base.toString(16)}`).toBe(vector.expectedBaseAddressHex);
    }
  });
});

describe("调试变体产出:确定性拒绝(XC- 规则)", () => {
  it("IR 模式配对 → XC-DEBUG-MODE-IR(调试实例恒字节模式)", () => {
    const loaded = loadOk(buildIrPair());
    expect(() =>
      buildDebugVariantBundle(loaded, { debugSeedHex: DEBUG_SEED_HEX, aslrEnabled: false }),
    ).toThrow(DebugVariantBuildError);
    try {
      buildDebugVariantBundle(loaded, { debugSeedHex: DEBUG_SEED_HEX, aslrEnabled: false });
    } catch (error) {
      expect((error as DebugVariantBuildError).violations[0]?.ruleId).toBe(RULE_ID_DEBUG_IR_MODE);
    }
  });

  it.each([
    ["7 字节越下界", "00112233445566"],
    ["33 字节越上界", "00".repeat(33)],
    ["奇数长度 hex", "001122334455667"],
    ["非 hex 字符", "001122334455667z".slice(0, 16)],
  ])("非法调试种子(%s)→ XC-DEBUG-SEED-HEX", (_name, seedHex) => {
    try {
      build(bytePairWithSecrets(), { debugSeedHex: seedHex, aslrEnabled: false });
      expect.unreachable("非法种子必须确定性拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(DebugVariantBuildError);
      expect((error as DebugVariantBuildError).violations[0]?.ruleId).toBe(RULE_ID_DEBUG_SEED_HEX);
    }
  });

  it("canary 槽位不落任何区域 → XC-DEBUG-CANARY-UNMAPPED", () => {
    const unmapped: PrivateObjectRecord = {
      objectId: "orphan-canary",
      kind: "canary",
      addressHex: "0x999999999",
      byteLength: 8,
      visibility: "hidden",
      containsSecret: true,
    };
    try {
      build(bytePairWithSecrets({ canary: unmapped }), {
        debugSeedHex: DEBUG_SEED_HEX,
        aslrEnabled: false,
      });
      expect.unreachable("无所属区域的 canary 必须确定性拒绝");
    } catch (error) {
      expect((error as DebugVariantBuildError).violations[0]?.ruleId).toBe(RULE_ID_DEBUG_CANARY_UNMAPPED);
    }
  });

  it("结构总跨度超出地址空间 → XC-DEBUG-ASLR-SPACE(防御性兜底)", () => {
    try {
      deriveAslrBaseAddress({
        firstDraw: 1n,
        archBits: 32,
        pageSizeBytes: 4096,
        structuralSpanBytes: 1n << 32n,
      });
      expect.unreachable("跨度越界必须确定性拒绝");
    } catch (error) {
      expect((error as DebugVariantBuildError).violations[0]?.ruleId).toBe(RULE_ID_DEBUG_ASLR_SPACE);
    }
  });
});

describe("调试变体产出:fast-check 属性(≤ 200 用例)", () => {
  const seedBytesArb = fc.uint8Array({ minLength: 8, maxLength: 32 });
  const seedHexArb = seedBytesArb.map((bytes) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  const pair = bytePairWithSecrets({ canary: VAULT_CANARY });
  const challenge = loadOk(pair);

  it("属性:同种子两次产出 canonical JSON 逐字节相同(60 用例)", () => {
    fc.assert(
      fc.property(seedHexArb, (seedHex) => {
        const first = buildDebugVariantBundle(challenge, { debugSeedHex: seedHex, aslrEnabled: false });
        const second = buildDebugVariantBundle(challenge, { debugSeedHex: seedHex, aslrEnabled: false });
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      }),
      { numRuns: 60 },
    );
  });

  it("属性:不同种子 → 全部秘密槽值必不同(60 用例)", () => {
    fc.assert(
      fc.property(seedHexArb, seedHexArb, (seedA, seedB) => {
        fc.pre(seedA !== seedB);
        const variantA = buildDebugVariantBundle(challenge, { debugSeedHex: seedA, aslrEnabled: false });
        const variantB = buildDebugVariantBundle(challenge, { debugSeedHex: seedB, aslrEnabled: false });
        for (const region of variantA.memoryRegions) {
          if (!region.isHidden) {
            continue;
          }
          expect(regionOf(variantB, region.regionId).contentHex).not.toBe(region.contentHex);
        }
        // canary 差异面:槽字节(从所属区域切片)必不同。
        const slot = variantA.canarySlots?.[0];
        const sliceOf = (variant: typeof variantA) => {
          const owner = variant.memoryRegions.find((region) => {
            const start = BigInt(region.startAddressHex);
            const address = BigInt(slot?.addressHex ?? "0x0");
            return address >= start && address + BigInt(slot?.byteLength ?? 0) <= start + BigInt(region.byteLength);
          });
          const offset = Number(BigInt(slot?.addressHex ?? "0x0") - BigInt(owner?.startAddressHex ?? "0x0"));
          return bytesToHex(hexToBytes(owner?.contentHex ?? "").slice(offset, offset + (slot?.byteLength ?? 0)));
        };
        expect(sliceOf(variantB)).not.toBe(sliceOf(variantA));
      }),
      { numRuns: 60 },
    );
  });

  it("属性:draws 计数与槽数精确耦合(60 用例;aslr 关 513 / 开 514)", () => {
    fc.assert(
      fc.property(seedHexArb, fc.boolean(), (seedHex, aslrEnabled) => {
        const variant = buildDebugVariantBundle(challenge, { debugSeedHex: seedHex, aslrEnabled });
        const expected = (aslrEnabled ? 1 : 0) + 512 + 1;
        expect(variant.derivation.draws).toBe(expected);
      }),
      { numRuns: 60 },
    );
  });
});
