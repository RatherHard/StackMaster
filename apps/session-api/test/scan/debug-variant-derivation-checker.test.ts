/**
 * 调试变体派生复算检查器单测(阶段四 WP-44;ZR-B13;映射文档 §五纪律:
 * 零命中与必触发红灯反例同套件运行)。
 *
 * 受测面 = 复算方(`checkDebugVariantDerivation`)与产出方
 * (`buildDebugVariantBundle`)的独立槽序消费是否同判:
 *  - 同种子复算 → 零命中(ASLR 开 / 关双形态;draws 记账一致);
 *  - 错误种子复算 → 基址 / 隐藏区域 / canary 内容必命中(证明"变体确由
 *    声明的种子 / 槽序派生"可被机检复核);
 *  - 变体单字节篡改 → 必命中(检查器不是同义反复:篡改可检出)。
 *
 * 测试种子与语料全部为占位惯例(合成 hex;真实种子不进任何文件)。
 */

import { describe, expect, it } from "vitest";
import {
  buildDebugVariantBundle,
  type LoadedChallenge,
} from "@stackmaster/challenge-compiler";

import {
  checkDebugVariantDerivation,
  type DebugVariantDerivationCheckInput,
} from "../../src/scan/debug-variant-derivation-checker.js";

/** 固定测试调试种子(占位语料,16 字节;与 WP-42 集成测试同惯例)。 */
const DEBUG_SEED_HEX = "2a4f6b8e0d1c3e5f708192a3b4c5d6e7";
/** 错误种子(占位语料;仅作红灯复算输入)。 */
const WRONG_SEED_HEX = "000102030405060708090a0b0c0d0e0f";

const REGION_SIZE = 4096;
const CODE_CONTENT_HEX = "5589cd0100000000000000" + "90".repeat(REGION_SIZE - 11);
const ZEROS_HEX = "00".repeat(REGION_SIZE);
/** canary 槽字节长度(引擎 CanarySlotSpec 同域 1–8)。 */
const CANARY_BYTES = 4;

/**
 * 最小装载产物(手写最小面:buildDebugVariantBundle 只消费本面字段;
 * 类型断言绕过与 challenge-compiler 测试 helper 同一受测形态)。
 * 布局:code(可见)0x400000 / vault(隐藏)0x500000 / stack(可见)0x7ffff000;
 * canary 槽 4 字节 @ 0x7ffff008(stack 区域内,偏移 8)。
 */
function buildChallenge(): LoadedChallenge {
  return {
    publicDescriptor: { vmProfile: { archBits: 64, pageSizeBytes: 4096 } },
    privateBundle: {
      challengeId: "chal-zr-b13",
      challengeContentVersion: "1.0.0",
      vmProfileVersion: "1.0.0",
      initialState: {
        registers: { RIP: "0x400000", RSP: "0x7ffffff8" },
        memoryRegions: [
          {
            regionId: "code",
            kind: "code",
            startAddressHex: "0x400000",
            byteLength: REGION_SIZE,
            permissions: "rx",
            contentHex: CODE_CONTENT_HEX,
            isHidden: false,
          },
          {
            regionId: "vault",
            kind: "key",
            startAddressHex: "0x500000",
            byteLength: REGION_SIZE,
            permissions: "rw",
            contentHex: ZEROS_HEX,
            isHidden: true,
          },
          {
            regionId: "stack",
            kind: "stack",
            startAddressHex: "0x7ffff000",
            byteLength: REGION_SIZE,
            permissions: "rw",
            contentHex: ZEROS_HEX,
            isHidden: false,
          },
        ],
      },
      privateObjects: [
        {
          objectId: "canary-1",
          kind: "canary",
          addressHex: "0x7ffff008",
          byteLength: CANARY_BYTES,
          visibility: "hidden",
          containsSecret: true,
        },
      ],
    },
    program: { mode: "byte" },
  } as unknown as LoadedChallenge;
}

function checkWith(
  variant: Record<string, unknown>,
  debugSeedHex: string,
): ZrB13ViolationLike[] {
  const input: DebugVariantDerivationCheckInput = {
    variant: variant as DebugVariantDerivationCheckInput["variant"],
    debugSeedHex,
    archBits: 64,
    pageSizeBytes: 4096,
  };
  return checkDebugVariantDerivation(input);
}

type ZrB13ViolationLike = ReturnType<typeof checkDebugVariantDerivation>[number];

describe("ZR-B13 派生复算:同种子零命中(产出方 × 复算方同判)", () => {
  it("ASLR 开(基址槽 + 隐藏区域槽 + canary 槽):同种子复算零命中,draws 记账一致", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: true,
    });
    // 规范槽序记账:基址 1 + 隐藏区域 ceil(4096/8)=512 + canary ceil(4/8)=1。
    expect(variant.derivation.draws).toBe(514);
    expect(variant.aslrEnabled).toBe(true);
    expect(variant.derivation.baseAddresses).toHaveLength(3);
    expect(checkWith(variant, DEBUG_SEED_HEX)).toEqual([]);
  });

  it("ASLR 关(无基址槽):同种子复算零命中,baseAddresses 缺席", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    });
    expect(variant.derivation.draws).toBe(513);
    expect(variant.derivation.baseAddresses).toBeUndefined();
    expect(checkWith(variant, DEBUG_SEED_HEX)).toEqual([]);
  });
});

describe("ZR-B13 红灯反例(必触发;与零命中同套件)", () => {
  it("红灯 ③:错误种子复算 → 基址 / 隐藏区域 / canary 内容必命中(证明派生可复核)", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: true,
    });
    const hits = checkWith(variant, WRONG_SEED_HEX);
    const ids = hits.map((hit) => hit.id);
    expect(ids).toContain("ZR-B13-base-address-mismatch");
    expect(ids).toContain("ZR-B13-hidden-region-content-mismatch");
    expect(ids).toContain("ZR-B13-canary-content-mismatch");
    // draws 是槽序结构量(种子无关):错误种子不触发 draws-mismatch。
    expect(ids).not.toContain("ZR-B13-draws-mismatch");
  });

  it("变体单字节篡改(隐藏区域)→ ZR-B13-hidden-region-content-mismatch(同种子)", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    }) as unknown as { memoryRegions: { regionId: string; contentHex: string; isHidden: boolean }[] };
    const vault = variant.memoryRegions.find((region) => region.regionId === "vault");
    if (vault === undefined) {
      throw new Error("vault region missing");
    }
    vault.contentHex = `be${vault.contentHex.slice(2)}`;
    const hits = checkWith(variant, DEBUG_SEED_HEX);
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B13-hidden-region-content-mismatch"]);
    expect(hits[0]?.path).toBe("$/memoryRegions/1/contentHex");
  });

  it("变体 canary 槽字节篡改 → ZR-B13-canary-content-mismatch(差异归因 canary 面)", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    }) as unknown as { memoryRegions: { regionId: string; startAddressHex: string; contentHex: string; isHidden: boolean }[] };
    // canary @ 0x7ffff008(stack 起址偏移 8):仅改 stack 区域 canary 偏移处字节。
    const stack = variant.memoryRegions.find((region) => region.regionId === "stack");
    if (stack === undefined) {
      throw new Error("stack region missing");
    }
    const offset = 8;
    stack.contentHex =
      stack.contentHex.slice(0, offset * 2) + "be" + stack.contentHex.slice(offset * 2 + 2);
    const hits = checkWith(variant, DEBUG_SEED_HEX);
    expect(hits.map((hit) => hit.id)).toEqual(["ZR-B13-canary-content-mismatch"]);
    expect(hits[0]?.path).toBe("$/memoryRegions/2/contentHex");
  });

  it("派生算法标识被改 → ZR-B13-algorithm-id;ASLR 关携带 baseAddresses → ZR-B13-base-address-mismatch", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    }) as unknown as Record<string, unknown> & {
      derivation: { algorithmId: string; draws: number; baseAddresses?: unknown };
    };
    variant.derivation.algorithmId = "splitmix64-stream-v0";
    variant.derivation.baseAddresses = [{ regionId: "code", addressHex: "0x400000" }];
    const ids = checkWith(variant, DEBUG_SEED_HEX).map((hit) => hit.id);
    expect(ids).toContain("ZR-B13-algorithm-id");
    expect(ids).toContain("ZR-B13-base-address-mismatch");
  });

  it("canary 槽地址越出所有区域 → ZR-B13-canary-unmapped(区间无处写入)", () => {
    const variant = buildDebugVariantBundle(buildChallenge(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    }) as unknown as { canarySlots: { objectId: string; addressHex: string; byteLength: number }[] };
    const canarySlot = variant.canarySlots[0];
    if (canarySlot === undefined) {
      throw new Error("fixture must carry a canary slot");
    }
    canarySlot.addressHex = "0x100000";
    const hits = checkWith(variant, DEBUG_SEED_HEX);
    expect(hits.map((hit) => hit.id)).toContain("ZR-B13-canary-unmapped");
    // 槽序记账确定性:越界槽仍消费 draws(声明 513 与复算一致,不级联 draws-mismatch)。
    expect(hits.map((hit) => hit.id)).not.toContain("ZR-B13-draws-mismatch");
  });
});
