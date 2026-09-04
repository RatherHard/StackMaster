/**
 * 私有判题包测试 builder。
 *
 * **私有包样例永不入 git**(CLAUDE.md 红线):全部私有样例由本 helper
 * 在测试进程内构造。基础判题包由公开描述包**派生**:身份字段、区域几何、
 * 非隐藏区域初始内容前缀(bytesHex)、可见寄存器值与 FLAG 寄存器名都从
 * 公开包镜像而来,保证"公开值镜像私有初始态"按构造成立;隐藏面
 * (canary 保槽 vault、秘密、判题条件、IR)是私有包独有内容。
 */

import type { PublicChallengeDescriptor } from "../../src/index.js";
import type {
  ConditionL1,
  MemoryRegionSeed,
  PrivateChallengeBundle,
  PrivateObjectRecord,
} from "../../src/server-only/index.js";

/** 与公开 fixture code 区域 bytesHex 一致的代码前缀(16 字节)。 */
const WIN_TARGET_ADDRESS_HEX = "0x400200";
const CANARY_VALUE_HEX = "0a0b0c0d0e0f1011";
const CANARY_VAULT_START_HEX = "0x90000000";
// G3/D2 后区域大小必须为 4KB 的倍数(VMA 页对齐),vault 同受约束。
const CANARY_VAULT_BYTE_LENGTH = 4096;
const FLAG_REGISTER_PLACEHOLDER_VALUE_HEX = "0x0";
const SECRET_FLAG_PLACEHOLDER = "FLAG{placeholder_do_not_ship}";
const SEED_HEX_FIXTURE = "00112233445566778899aabbccddeeff";

function zeroHexBytes(byteCount: number): string {
  return "00".repeat(byteCount);
}

/**
 * 构造与公开描述包配对的基础私有判题包;`mutate` 在返回前对**本次构造的
 * 本地副本**做定向破坏(红灯样例),不影响调用方持有的对象。
 */
export function buildPrivateBundle(
  publicDescriptor: PublicChallengeDescriptor,
  mutate?: (bundle: PrivateChallengeBundle) => void,
): PrivateChallengeBundle {
  const bundle = buildBaseBundle(publicDescriptor);
  mutate?.(bundle);
  return bundle;
}

function buildBaseBundle(publicDescriptor: PublicChallengeDescriptor): PrivateChallengeBundle {
  const visibleRegionById = new Map(
    publicDescriptor.initialProjection.visibleRegions.map((region) => [region.regionId, region]),
  );

  const memoryRegions: MemoryRegionSeed[] = publicDescriptor.memoryLayout.regions.map((region) => {
    const projected = visibleRegionById.get(region.regionId);
    const prefixBytes = projected !== undefined ? projected.bytesHex.length / 2 : 0;
    return {
      regionId: region.regionId,
      kind: region.kind,
      startAddressHex: region.startAddressHex,
      byteLength: region.byteLength,
      permissions: region.permissions,
      contentHex:
        (projected?.bytesHex ?? "") + zeroHexBytes(region.byteLength - prefixBytes),
      isHidden: false,
    };
  });

  // 隐藏 canary 保槽:权威 canary 值只存在于隐藏 key 区域(I-2 区域级:
  // 隐藏对象 / 秘密与公开区域不相交);可见栈上的 canary_slot 高亮只是教学标注。
  const canarySizeBytes = publicDescriptor.vmProfile.canary.enabled
    ? (publicDescriptor.vmProfile.canary.sizeBytes ?? 8)
    : 0;
  if (publicDescriptor.vmProfile.canary.enabled && canarySizeBytes > 0) {
    memoryRegions.push({
      regionId: "canary-vault",
      kind: "key",
      startAddressHex: CANARY_VAULT_START_HEX,
      byteLength: CANARY_VAULT_BYTE_LENGTH,
      permissions: "rw",
      contentHex:
        CANARY_VALUE_HEX.slice(0, canarySizeBytes * 2).padEnd(canarySizeBytes * 2, "0") +
        zeroHexBytes(CANARY_VAULT_BYTE_LENGTH - canarySizeBytes),
      isHidden: true,
    });
  }

  const registers: Record<string, string> = {};
  for (const register of publicDescriptor.initialProjection.visibleRegisters) {
    registers[register.name] = register.valueHex;
  }
  for (const flagName of publicDescriptor.vmProfile.flagRegisterNames ?? []) {
    registers[flagName] = FLAG_REGISTER_PLACEHOLDER_VALUE_HEX;
  }

  const privateObjects: PrivateObjectRecord[] = [];
  for (const highlight of publicDescriptor.initialProjection.semanticHighlights ?? []) {
    if (highlight.kind === "buffer_start") {
      privateObjects.push({
        objectId: "input-buffer",
        kind: "buffer",
        addressHex: highlight.startAddressHex,
        byteLength: highlight.byteLength,
        visibility: "public",
        containsSecret: false,
      });
    } else if (highlight.kind === "return_address_slot") {
      privateObjects.push({
        objectId: "ret-slot",
        kind: "return_address",
        addressHex: highlight.startAddressHex,
        byteLength: highlight.byteLength,
        visibility: "public",
        containsSecret: false,
      });
    }
    // canary_slot / saved_rbp_slot / custom 高亮只是教学标注,不登记私有对象;
    // 权威 canary 对象登记在隐藏 vault 上(见下)。
  }
  if (publicDescriptor.vmProfile.canary.enabled && canarySizeBytes > 0) {
    privateObjects.push({
      objectId: "canary-value",
      kind: "canary",
      addressHex: CANARY_VAULT_START_HEX,
      byteLength: canarySizeBytes,
      visibility: "hidden",
      containsSecret: true,
    });
  }

  // 失败条件:canary 被破坏(教学反馈),恒真记法 {"all": []} 之外的演示形态。
  const failureConditions: ConditionL1[] | undefined = publicDescriptor.vmProfile.canary.enabled
    ? [{ not: { all: [{ predicate: { type: "stack_canary_intact" } }] } }]
    : undefined;

  return {
    schemaVersion: publicDescriptor.schemaVersion,
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
    privateObjects,
    judging: {
      successCondition: {
        all: [{ all: [{ predicate: { type: "ret_target_equals", addressHex: WIN_TARGET_ADDRESS_HEX } }] }],
      },
      failureConditions,
      hiddenTests: [
        {
          testId: "payload-72",
          kind: "reference_payload",
          payloadHex: "41".repeat(72),
          expectedResult: "success",
        },
        {
          testId: "payload-short",
          kind: "reference_payload",
          payloadHex: "41".repeat(8),
          expectedResult: "wrong_answer",
        },
      ],
    },
    compiledIr: {
      irFormatVersion: 2,
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
    },
    judgingConfig: {
      verdictRuleVersion: "1.0.0",
      maxPredicateEvalSteps: 10000,
      timeoutMsPerAction: 5000,
    },
  };
}
