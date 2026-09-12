/**
 * ZR-B13 非平凡复算 fixture 接入(WP-68;阶段四验收评审 §六.8 移交项:
 * "含隐藏区域 / canary 槽的题目 fixture 进入批量制作期(MVP 期)时接入
 * 非平凡复算")。
 *
 * 承载题 = CH-07(sm-ch07-hidden-vault,字节模式 + 隐藏区域)的**派生面
 * fixture**(`zrB13FixturePair`:CH-07 + canary 槽声明——公开包 canary
 * 启用 + 私有包 hidden + containsSecret 的 canary 对象,落隐藏区域内,
 * XS-CANARY-CORR ✓;该 fixture 只进调试变体派生链路,不做交互装载,
 * 契约冲突登记见 D-API-109)。
 *
 * 断言面:
 *  - 零命中:以 TS `SeedDeriver` 按规范槽序复算基址 / 隐藏区域 / canary
 *    字节,与变体 `contentHex` / `baseAddresses` / `draws` 逐项一致
 *    (checkDebugVariantDerivation 零违规);
 *  - **非平凡**:draws = 1(基址槽)+ 512(隐藏区域 4096 B)+ 1(canary
 *    槽)= 514 > 0——阶段四集成层 draws = 0 的"平凡一致性"自本 fixture 起闭合;
 *  - ASLR 开/关双形态(开 = 基址槽 + baseAddresses;关 = 基址与真实镜像一致,
 *    draws = 513——D-J8 口径下调试实例兄弟形态的复算面);
 *  - 红灯反例(与零命中同套件,证明机检有效):错误种子复算必命中;
 *    变体派生槽单字节篡改必命中。
 */
import { describe, expect, it } from "vitest";
import { loadChallengePair, buildDebugVariantBundle } from "@stackmaster/challenge-compiler";
import {
  checkDebugVariantDerivation,
  type DebugVariantDerivationCheckInput,
} from "../../src/scan/debug-variant-derivation-checker.js";

import { zrB13FixturePair } from "./corpus.js";

/** 固定测试调试种子(16 字节占位语料;与 WP-41/42 集成测试同惯例)。 */
const DEBUG_SEED_HEX = "2a4f6b8e0d1c3e5f708192a3b4c5d6e7";
const WRONG_SEED_HEX = "3b5a7c9d1e0f2a4b6c8d0e1f2a3b4c5d";

function loadFixture() {
  const pair = zrB13FixturePair();
  const loaded = loadChallengePair(pair);
  if (!loaded.ok) {
    throw new Error(
      `ZR-B13 fixture 装载失败:${loaded.violations.map((item) => item.ruleId).join(",")}`,
    );
  }
  return loaded.challenge;
}

function checkerInput(
  variant: ReturnType<typeof buildDebugVariantBundle>,
  debugSeedHex: string,
): DebugVariantDerivationCheckInput {
  return {
    variant: {
      aslrEnabled: variant.aslrEnabled,
      derivation: variant.derivation,
      memoryRegions: variant.memoryRegions,
      ...(variant.canarySlots !== undefined ? { canarySlots: variant.canarySlots } : {}),
    },
    debugSeedHex,
    archBits: 64,
    pageSizeBytes: 4096,
  };
}

describe("ZR-B13 非平凡复算(CH-07 派生面 fixture;阶段四 §六.8 移交接入)", () => {
  it("fixture 装载全绿:字节模式 + 隐藏区域 + canary 槽声明过全量管线", () => {
    const challenge = loadFixture();
    expect(challenge.program.mode).toBe("byte");
    const hidden = challenge.privateBundle.initialState.memoryRegions.filter(
      (region) => region.isHidden,
    );
    expect(hidden.map((region) => region.regionId)).toEqual(["vault"]);
    const canaryObjects = challenge.privateBundle.privateObjects.filter(
      (object) => object.kind === "canary",
    );
    expect(canaryObjects).toHaveLength(1);
    expect(canaryObjects[0]).toMatchObject({
      objectId: "vault-canary",
      visibility: "hidden",
      containsSecret: true,
    });
  });

  it("ASLR 开:零命中 + draws = 514(基址 1 + 隐藏区域 512 + canary 1)非平凡复算", () => {
    const variant = buildDebugVariantBundle(loadFixture(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: true,
    });
    expect(variant.aslrEnabled).toBe(true);
    expect(variant.derivation.draws).toBe(514);
    expect(variant.derivation.baseAddresses).toHaveLength(3);
    expect(variant.canarySlots).toHaveLength(1);
    expect(variant.canarySlots?.[0]?.objectId).toBe("vault-canary");

    const violations = checkDebugVariantDerivation(checkerInput(variant, DEBUG_SEED_HEX));
    expect(
      violations.map((item) => `${item.id}:${item.path}`).join("\n"),
    ).toBe("");
  });

  it("ASLR 关(D-J8 口径):零基址槽,draws = 513,复算零命中", () => {
    const variant = buildDebugVariantBundle(loadFixture(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    });
    expect(variant.aslrEnabled).toBe(false);
    expect(variant.derivation.baseAddresses).toBeUndefined();
    expect(variant.derivation.draws).toBe(513);
    const violations = checkDebugVariantDerivation(checkerInput(variant, DEBUG_SEED_HEX));
    expect(violations.map((item) => `${item.id}:${item.path}`).join("\n")).toBe("");
  });

  it("红灯:错误种子复算必命中(基址 + 派生槽内容;canary 属主区域按阶段 B 归因)", () => {
    const variant = buildDebugVariantBundle(loadFixture(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: true,
    });
    const violations = checkDebugVariantDerivation(checkerInput(variant, WRONG_SEED_HEX));
    const ids = new Set(violations.map((item) => item.id));
    expect(ids.has("ZR-B13-base-address-mismatch")).toBe(true);
    // vault 既是隐藏区域又持有 canary 槽:错误种子使叠加后内容不符,
    // 按规范槽序在阶段 B 归因(canary-content-mismatch)。
    expect(ids.has("ZR-B13-canary-content-mismatch")).toBe(true);
    expect(violations.some((item) => item.path.includes("memoryRegions/2"))).toBe(true);
  });

  it("红灯:变体派生槽单字节篡改必命中", () => {
    const variant = buildDebugVariantBundle(loadFixture(), {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: true,
    });
    // 篡改隐藏区域 canary 槽首字节。
    const tampered = structuredClone(variant);
    const vault = tampered.memoryRegions.find((region) => region.regionId === "vault");
    expect(vault).toBeDefined();
    const flipped = (BigInt(`0x0${vault!.contentHex.slice(0, 1)}`) ^ 0xffn)
      .toString(16)
      .slice(-1);
    vault!.contentHex = flipped + vault!.contentHex.slice(1);
    const violations = checkDebugVariantDerivation(checkerInput(tampered, DEBUG_SEED_HEX));
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((item) => item.path.includes("memoryRegions/2"))).toBe(true);
  });

  it("红灯:纯隐藏区域(无 canary 属主)内容篡改按阶段 A 归因", () => {
    // 组合第二个隐藏区域(无 canary 槽),验证阶段 A 归因路径保持有效。
    const pair = zrB13FixturePair();
    const bundle = pair.privateBundle as {
      initialState: {
        memoryRegions: {
          regionId: string;
          kind: string;
          startAddressHex: string;
          byteLength: number;
          permissions: string;
          contentHex: string;
          isHidden: boolean;
        }[];
      };
    };
    bundle.initialState.memoryRegions.push({
      regionId: "vault-annex",
      kind: "key",
      startAddressHex: "0x20001000",
      byteLength: 4096,
      permissions: "rw",
      contentHex: "00".repeat(4096),
      isHidden: true,
    });
    const loaded = loadChallengePair(pair);
    if (!loaded.ok) {
      throw new Error(`扩充 fixture 装载失败:${loaded.violations.map((v) => v.ruleId).join(",")}`);
    }
    const variant = buildDebugVariantBundle(loaded.challenge, {
      debugSeedHex: DEBUG_SEED_HEX,
      aslrEnabled: false,
    });
    expect(variant.derivation.draws).toBe(513 + 512);
    const annex = variant.memoryRegions.find((region) => region.regionId === "vault-annex");
    expect(annex).toBeDefined();
    const flipped = (BigInt(`0x0${annex!.contentHex.slice(0, 1)}`) ^ 0xffn)
      .toString(16)
      .slice(-1);
    annex!.contentHex = flipped + annex!.contentHex.slice(1);
    const violations = checkDebugVariantDerivation(checkerInput(variant, DEBUG_SEED_HEX));
    expect(violations.map((item) => item.id)).toContain("ZR-B13-hidden-region-content-mismatch");
  });
});
