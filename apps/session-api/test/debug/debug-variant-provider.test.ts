/**
 * productionDebugVariantProvider 单元测试(阶段四 WP-42;ADR-DC1 条款 2 /
 * §六 R2、WP-40 契约 §七.3)。
 *
 * 覆盖面:双包 → 装载管线 → buildDebugVariantBundle 的生产路径(内存双包
 * 存储;真实 challenge-compiler 装载管线,不走占位 Provider)、同种子确定性、
 * attach 级种子新鲜度(缺省随机生成器,秘密槽差分可观察)、ASLR 开关镜像、
 * 失败面确定性(双包缺失 / 非 JSON / IR 模式拒绝)。调试种子不落存储不入
 * 日志:产物无种子值字段(strictObject 结构性排除面)由 Schema 保证。
 */
import { describe, expect, it } from "vitest";
import { DebugVariantBundleSchema } from "@stackmaster/protocol/server-only";
import { RULE_ID_DEBUG_IR_MODE } from "@stackmaster/challenge-compiler";
// 测试语料构造器走 challenge-schema 测试助手惯例的源路径(session-rig 同款;
// dist 入口不导出测试 helper)。
import {
  buildBytePair,
  buildIrPair,
} from "../../../../packages/challenge-compiler/test/helpers/private-bundle.js";
import { MemoryChallengeBundleStore } from "../../src/persistence/index.js";
import { productionDebugVariantProvider } from "../../src/debug/debug-variant-provider.js";

const CHALLENGE_ID = "chal-stack-escape";
const CHALLENGE_VERSION = "1.2.3";
/** 固定测试种子(占位语料,16 字节;生产缺省 = 随机 16 字节)。 */
const FIXED_DEBUG_SEED_HEX = "2a4f6b8e0d1c3e5f708192a3b4c5d6e7";

/** canary 对象语料的本地最小视图(session-api 不直依赖 challenge-schema)。 */
interface CanaryObjectView {
  objectId: string;
  kind: "canary";
  addressHex: string;
  byteLength: number;
  visibility: "public" | "hidden";
  containsSecret: boolean;
}

interface BundleView {
  initialState: { registers: Record<string, string>; memoryRegions: { regionId: string; startAddressHex: string; byteLength: number; kind: string; permissions: string; contentHex: string; isHidden: boolean }[] };
  privateObjects: CanaryObjectView[];
}

/** 字节模式配对登记进内存双包存储(身份字段与 rig 同款改写;可增补语料)。 */
async function registerByteChallenge(
  bundles: MemoryChallengeBundleStore,
  options: { aslrEnabled?: boolean; withSecrets?: boolean } = {},
): Promise<void> {
  const pair = buildBytePair({
    mutate: (mutable) => {
      const descriptor = mutable.publicDescriptor as unknown as Record<string, unknown>;
      descriptor.challengeId = CHALLENGE_ID;
      descriptor.challengeContentVersion = CHALLENGE_VERSION;
      if (options.aslrEnabled === true) {
        // WP-43:aslrEnabled = true ⇒ randomizationNotice 必须存在(XS-ASLR-NOTICE)。
        descriptor.aslrEnabled = true;
        descriptor.randomizationNotice = "占位随机化声明(测试语料,非真实文案)";
      }
      const bundle = mutable.privateBundle as unknown as BundleView & Record<string, unknown>;
      bundle.challengeId = CHALLENGE_ID;
      bundle.challengeContentVersion = CHALLENGE_VERSION;
      if (options.withSecrets === true) {
        // 隐藏区域 + canary(与公开区域不相交;内容占位全零,派生值可差分)。
        bundle.initialState.memoryRegions.push({
          regionId: "debug-vault",
          kind: "key",
          startAddressHex: "0x405000",
          byteLength: 4096,
          permissions: "rw",
          contentHex: "00".repeat(4096),
          isHidden: true,
        });
        bundle.privateObjects.push({
          objectId: "vault-canary",
          kind: "canary",
          addressHex: "0x4057f8",
          byteLength: 8,
          visibility: "hidden",
          containsSecret: true,
        });
      }
    },
  });
  await bundles.putPrivate(
    CHALLENGE_ID,
    CHALLENGE_VERSION,
    Buffer.from(JSON.stringify(pair.privateBundle), "utf8"),
  );
  await bundles.putPublic(
    CHALLENGE_ID,
    CHALLENGE_VERSION,
    Buffer.from(JSON.stringify(pair.publicDescriptor), "utf8"),
  );
}

const REQUEST = {
  sessionId: "sess-test",
  tenantId: "tenant-alpha",
  challengeId: CHALLENGE_ID,
  challengeContentVersion: CHALLENGE_VERSION,
};

function providerWith(bundles: MemoryChallengeBundleStore, generateDebugSeedHex?: () => string) {
  return productionDebugVariantProvider({
    bundles,
    ...(generateDebugSeedHex === undefined ? {} : { generateDebugSeedHex }),
  });
}

describe("productionDebugVariantProvider(WP-42 生产路径)", () => {
  it("真实编译变体:装载管线 → 变体出口过冻结 Schema;无占位语料合成面", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerByteChallenge(bundles);
    const variant = await providerWith(bundles, () => FIXED_DEBUG_SEED_HEX).forSession(REQUEST);

    expect(() => DebugVariantBundleSchema.parse(variant)).not.toThrow();
    expect(variant).toMatchObject({
      challengeId: CHALLENGE_ID,
      challengeContentVersion: CHALLENGE_VERSION,
      aslrEnabled: false,
    });
    // 生产变体 = 真实镜像同构(字节模式题目:code + stack 两区域;无占位合成区域)。
    const regions = variant.memoryRegions as { regionId: string; isHidden: boolean }[];
    expect(regions.map((region) => region.regionId)).toEqual(["code", "stack"]);
    expect(regions.every((region) => !region.isHidden)).toBe(true);
    expect(regions.map((region) => region.regionId)).not.toContain("debug-vault");
    // derivation 无种子值字段(strictObject 结构性排除;只登记算法与计数)。
    expect(variant.derivation).toMatchObject({ algorithmId: "splitmix64-stream-v1", draws: 0 });
    expect(variant).not.toHaveProperty("seed");
    expect(variant).not.toHaveProperty("seedHex");
    expect(variant).not.toHaveProperty("seedPolicy");
  });

  it("同种子确定性:两次供给 canonical JSON 逐字节相同(含秘密槽)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerByteChallenge(bundles, { withSecrets: true });
    const provider = providerWith(bundles, () => FIXED_DEBUG_SEED_HEX);
    const first = await provider.forSession(REQUEST);
    const second = await provider.forSession(REQUEST);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("缺省生成器:每次供给现场随机调试种子(秘密槽差分可观察)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerByteChallenge(bundles, { withSecrets: true });
    const provider = providerWith(bundles);
    const first = await provider.forSession(REQUEST);
    const second = await provider.forSession(REQUEST);
    const vaultOf = (variant: Record<string, unknown>) =>
      (variant.memoryRegions as { regionId: string; contentHex: string }[]).find(
        (region) => region.regionId === "debug-vault",
      )?.contentHex;
    // 两次供给 = 两次独立 attach 种子;隐藏区域派生内容互异(2^-2048 碰撞面)。
    expect(vaultOf(first)).toBeDefined();
    expect(vaultOf(second)).not.toBe(vaultOf(first));
  });

  it("ASLR 开关镜像:公开描述包 aslrEnabled = true ⇒ 变体携带逐区域派生基址", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerByteChallenge(bundles, { aslrEnabled: true });
    const variant = await providerWith(bundles, () => FIXED_DEBUG_SEED_HEX).forSession(REQUEST);
    expect(variant.aslrEnabled).toBe(true);
    const baseAddresses = (variant.derivation as { baseAddresses?: { regionId: string; addressHex: string }[] }).baseAddresses;
    const regions = variant.memoryRegions as { regionId: string; startAddressHex: string; byteLength: number }[];
    expect(baseAddresses).toHaveLength(regions.length);
    // 基址页对齐且区域起点落位宽地址空间(0 < start + len ≤ 2^64)。
    for (const [index, entry] of baseAddresses?.entries() ?? []) {
      const start = BigInt(entry.addressHex);
      expect(start % 4096n).toBe(0n);
      expect(entry.regionId).toBe(regions[index]?.regionId);
      expect(BigInt(regions[index]?.startAddressHex ?? "0x0")).toBe(start);
      expect(start + BigInt(regions[index]?.byteLength ?? 0) <= 1n << 64n).toBe(true);
    }
  });

  it("双包缺失 → 确定性失败(编排器映射 internal_error 错误帧)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await expect(providerWith(bundles).forSession(REQUEST)).rejects.toThrow(/bundle missing/);
  });

  it("私有包非 JSON → 确定性失败", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerByteChallenge(bundles);
    await bundles.putPrivate(CHALLENGE_ID, CHALLENGE_VERSION, Buffer.from("{not-json", "utf8"));
    await expect(providerWith(bundles).forSession(REQUEST)).rejects.toThrow(/not valid JSON/);
  });

  it("IR 模式题目 → 装载管线放行、变体产出面确定性拒绝(XC-DEBUG-MODE-IR)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    const pair = buildIrPair({
      mutate: (mutable) => {
        const descriptor = mutable.publicDescriptor as unknown as Record<string, unknown>;
        descriptor.challengeId = CHALLENGE_ID;
        descriptor.challengeContentVersion = CHALLENGE_VERSION;
        const bundle = mutable.privateBundle as unknown as Record<string, unknown>;
        bundle.challengeId = CHALLENGE_ID;
        bundle.challengeContentVersion = CHALLENGE_VERSION;
      },
    });
    await bundles.putPrivate(
      CHALLENGE_ID,
      CHALLENGE_VERSION,
      Buffer.from(JSON.stringify(pair.privateBundle), "utf8"),
    );
    await bundles.putPublic(
      CHALLENGE_ID,
      CHALLENGE_VERSION,
      Buffer.from(JSON.stringify(pair.publicDescriptor), "utf8"),
    );
    await expect(providerWith(bundles, () => FIXED_DEBUG_SEED_HEX).forSession(REQUEST)).rejects.toThrow(
      /debug variant build rejected/,
    );
    try {
      await providerWith(bundles, () => FIXED_DEBUG_SEED_HEX).forSession(REQUEST);
      expect.unreachable("IR 模式必须确定性拒绝");
    } catch (error) {
      // 结构断言(不依赖跨实例 instanceof;违规面 = XC- 规则 ID)。
      expect((error as { violations?: { ruleId: string }[] }).violations?.[0]?.ruleId).toBe(
        RULE_ID_DEBUG_IR_MODE,
      );
    }
  });
});
