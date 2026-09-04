/**
 * 跨包一致性检查规则(WP-1 §12.6 左列规则 ID)——公开描述包 × 私有判题包:
 *  - XS-ID-CORR 共享身份字段(schemaVersion / challengeId / challengeContentVersion /
 *    vmProfileVersion)逐项同值;
 *  - I2-PUB-MIRROR 公开区域 ↔ 私有非隐藏区域按 regionId 双射,几何与权限逐项相等
 *    (标签相等是公开包内部一致性,归 XS-PROJ-GEOM);
 *  - I2-HIDDEN-NOT-PUBLIC 私有隐藏区域与公开区域交集为空;
 *  - I2-OBJ-NOT-PUBLIC hidden 私有对象与公开区域交集为空;
 *  - I3-VISIBLE-REG 可见寄存器与秘密汇寄存器(secretSinkRegisters ∪ FLAG 命名)不相交;
 *  - ZR-B8-CAP-SCAN 公开包全部字符串值不得携带 capability 前缀(如 `virtual_file:`);
 *  - XS-ID-NO-PRIVATE 公开字符串值不得等于私有引用 ID(objectId / fileId;regionId 豁免);
 *  - XS-PROJ-REG(= XS-REG-SUBSET,见 RULE_ID_ALIASES;G2/D3 重锚为声明集面)
 *    可见寄存器 ⊆ vmProfile.registers 声明集,私有初始寄存器 ⊆ 声明集 ∪ flagRegisterNames;
 *  - XS-REG-FLAG 公开 VM Profile 不得携带 FLAG 名;FLAG 名必须存在于私有初始寄存器集;
 *  - XS-PROJ-GEOM 初始投影区域 ↔ 公开布局双射,几何与标签逐项相等;
 *  - XS-PROJ-VALUES 公开 bytesHex 是私有 contentHex 的前缀、truncated 自洽、寄存器值同值;
 *  - XS-CANARY-CORR 启用 canary ⇒ 存在 hidden + containsSecret 的 canary 对象且与公开区域不相交;
 *  - XS-SEED-DECL declaredSeedPublicPaths 根必须是作者可声明投影面且可解析。
 *
 * 前置条件:两个输入均已通过各自 Schema 校验。
 */

import { FLAG_REGISTER_NAME_PATTERN } from "../../common/patterns.js";
import type { PublicChallengeDescriptor } from "../../common/public-types.js";
import type {
  MemoryRegionSeed,
  PrivateChallengeBundle,
} from "../private-types.js";
import {
  parseAddressHex,
  rangesOverlap,
  toAddressRange,
} from "./address-ranges.js";
import type { AddressRange } from "./address-ranges.js";
import { scanStringValues } from "./deep-scan.js";
import type { CheckerViolation } from "./types.js";

/**
 * ZR-B8:capability 名称禁入公开包。capability 引用只能走结构化字段
 * (如 grant_virtual_file 的 fileId);带前缀的 capability 字符串出现在
 * 公开值里即是越权通道(最小DSL范围.md F-4/F-5)。
 */
export const CAPABILITY_SCAN_PREFIXES: readonly string[] = ["virtual_file:"];

/** XS-ID-CORR:共享身份字段逐项同值。 */
export function checkIdentityCorrespondence(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const fields = [
    { name: "challengeId", public: publicDescriptor.challengeId, private: privateBundle.challengeId },
    {
      name: "challengeContentVersion",
      public: publicDescriptor.challengeContentVersion,
      private: privateBundle.challengeContentVersion,
    },
    {
      name: "vmProfileVersion",
      public: publicDescriptor.vmProfileVersion,
      private: privateBundle.vmProfileVersion,
    },
  ] as const;
  for (const field of fields) {
    if (field.public !== field.private) {
      violations.push({
        ruleId: "XS-ID-CORR",
        message: `共享身份字段 ${field.name} 两包不同值:公开 "${field.public}" / 私有 "${field.private}"`,
        path: `/${field.name}`,
      });
    }
  }
  return violations;
}

function publicRegionRange(region: {
  readonly startAddressHex: string;
  readonly byteLength: number;
}): AddressRange {
  return toAddressRange(region.startAddressHex, region.byteLength);
}

function privateRegionRange(region: MemoryRegionSeed): AddressRange {
  return toAddressRange(region.startAddressHex, region.byteLength);
}

/**
 * I2-PUB-MIRROR:公开区域 ↔ 私有非隐藏区域按 regionId 双射,
 * startAddressHex(BigInt 比较,大小写不敏感)/ byteLength / permissions 逐项相等。
 */
export function checkPublicPrivateRegionMirror(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const publicRegions = publicDescriptor.memoryLayout.regions;
  const privateNonHidden = privateBundle.initialState.memoryRegions.filter(
    (region) => !region.isHidden,
  );
  const privateById = new Map(privateNonHidden.map((region) => [region.regionId, region]));
  for (const region of publicRegions) {
    const mirrored = privateById.get(region.regionId);
    if (mirrored === undefined) {
      violations.push({
        ruleId: "I2-PUB-MIRROR",
        message: `公开区域 ${region.regionId} 在私有包非隐藏区域中没有对应项`,
        path: `/initialState/memoryRegions`,
      });
      continue;
    }
    if (parseAddressHex(region.startAddressHex) !== parseAddressHex(mirrored.startAddressHex)) {
      violations.push({
        ruleId: "I2-PUB-MIRROR",
        message: `区域 ${region.regionId} 起始地址两包不一致:公开 ${region.startAddressHex} / 私有 ${mirrored.startAddressHex}`,
        path: `/initialState/memoryRegions`,
      });
    }
    if (region.byteLength !== mirrored.byteLength) {
      violations.push({
        ruleId: "I2-PUB-MIRROR",
        message: `区域 ${region.regionId} byteLength 两包不一致:公开 ${region.byteLength} / 私有 ${mirrored.byteLength}`,
        path: `/initialState/memoryRegions`,
      });
    }
    if (region.permissions !== mirrored.permissions) {
      violations.push({
        ruleId: "I2-PUB-MIRROR",
        message: `区域 ${region.regionId} permissions 两包不一致:公开 "${region.permissions}" / 私有 "${mirrored.permissions}"`,
        path: `/initialState/memoryRegions`,
      });
    }
  }
  const publicIds = new Set(publicRegions.map((region) => region.regionId));
  for (const [index, region] of privateNonHidden.entries()) {
    if (!publicIds.has(region.regionId)) {
      violations.push({
        ruleId: "I2-PUB-MIRROR",
        message: `私有非隐藏区域 ${region.regionId} 在公开布局中没有对应项`,
        path: `/initialState/memoryRegions/${index}`,
      });
    }
  }
  return violations;
}

/** I2-HIDDEN-NOT-PUBLIC:私有隐藏区域与公开区域交集为空。 */
export function checkHiddenRegionsDisjointFromPublic(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const publicRanges = publicDescriptor.memoryLayout.regions.map((region) => ({
    regionId: region.regionId,
    range: publicRegionRange(region),
  }));
  privateBundle.initialState.memoryRegions.forEach((region, index) => {
    if (!region.isHidden) {
      return;
    }
    const hiddenRange = privateRegionRange(region);
    for (const publicRegion of publicRanges) {
      if (rangesOverlap(hiddenRange, publicRegion.range)) {
        violations.push({
          ruleId: "I2-HIDDEN-NOT-PUBLIC",
          message: `隐藏区域 ${region.regionId} 与公开区域 ${publicRegion.regionId} 地址区间相交`,
          path: `/initialState/memoryRegions/${index}`,
        });
      }
    }
  });
  return violations;
}

/** I2-OBJ-NOT-PUBLIC:hidden 私有对象与公开区域交集为空。 */
export function checkHiddenObjectsDisjointFromPublic(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const publicRanges = publicDescriptor.memoryLayout.regions.map((region) => ({
    regionId: region.regionId,
    range: publicRegionRange(region),
  }));
  privateBundle.privateObjects.forEach((object, index) => {
    if (object.visibility !== "hidden") {
      return;
    }
    const objectRange = toAddressRange(object.addressHex, object.byteLength);
    for (const publicRegion of publicRanges) {
      if (rangesOverlap(objectRange, publicRegion.range)) {
        violations.push({
          ruleId: "I2-OBJ-NOT-PUBLIC",
          message: `hidden 私有对象 ${object.objectId} 与公开区域 ${publicRegion.regionId} 地址区间相交`,
          path: `/privateObjects/${index}`,
        });
      }
    }
  });
  return violations;
}

/** I3-VISIBLE-REG:可见寄存器不得落在秘密汇(secretSinkRegisters ∪ FLAG 命名私有寄存器)。 */
export function checkVisibleRegistersNotSecretSinks(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const forbidden = new Set(privateBundle.secretSinkRegisters ?? []);
  for (const [name] of Object.entries(privateBundle.initialState.registers)) {
    if (FLAG_REGISTER_NAME_PATTERN.test(name)) {
      forbidden.add(name);
    }
  }
  publicDescriptor.initialProjection.visibleRegisters.forEach((register, index) => {
    if (forbidden.has(register.name)) {
      violations.push({
        ruleId: "I3-VISIBLE-REG",
        message: `可见寄存器 ${register.name} 是秘密汇寄存器(FLAG 命名或 secretSinkRegisters),值不得进入公开面`,
        path: `/initialProjection/visibleRegisters/${index}`,
      });
    }
  });
  return violations;
}

/** ZR-B8-CAP-SCAN:公开包全部字符串值深扫描 capability 前缀。 */
export function checkNoCapabilityStringsInPublic(
  publicDescriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  scanStringValues(publicDescriptor, (text, path) => {
    for (const prefix of CAPABILITY_SCAN_PREFIXES) {
      if (text.startsWith(prefix)) {
        violations.push({
          ruleId: "ZR-B8-CAP-SCAN",
          message: `公开包字符串携带 capability 前缀 "${prefix}";capability 引用只能走结构化字段`,
          path: path === "" ? "/" : path,
        });
      }
    }
  });
  return violations;
}

/** XS-ID-NO-PRIVATE:公开字符串值不得等于私有引用 ID(objectId / fileId)。 */
export function checkNoPrivateIdsInPublic(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const privateIds = new Set<string>([
    ...privateBundle.privateObjects.map((object) => object.objectId),
    ...privateBundle.secrets.virtualFiles.map((file) => file.fileId),
  ]);
  if (privateIds.size === 0) {
    return violations;
  }
  scanStringValues(publicDescriptor, (text, path) => {
    if (privateIds.has(text)) {
      violations.push({
        ruleId: "XS-ID-NO-PRIVATE",
        message: `公开包字符串值等于私有引用 ID "${text}"(禁止经引用 ID 从公开包推导私有面)`,
        path: path === "" ? "/" : path,
      });
    }
  });
  return violations;
}

/**
 * XS-PROJ-REG:可见寄存器 ⊆ vmProfile.registers 声明集(XS-REG-SUBSET 的投影面锚点)。
 * G2/D3 重锚:registers 是本题目寄存器集的定义性声明(WP-1 §12.5 v1.5),
 * "白名单"语义随之改为"声明集"。
 */
export function checkVisibleRegistersInDeclarationSet(
  publicDescriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const declarationSet = new Set(publicDescriptor.vmProfile.registers.map((register) => register.name));
  publicDescriptor.initialProjection.visibleRegisters.forEach((register, index) => {
    if (!declarationSet.has(register.name)) {
      violations.push({
        ruleId: "XS-PROJ-REG",
        message: `可见寄存器 ${register.name} 不在 VM Profile 寄存器声明集(声明集面规则 XS-REG-SUBSET 同锚)`,
        path: `/initialProjection/visibleRegisters/${index}`,
      });
    }
  });
  return violations;
}

/**
 * XS-PROJ-REG(XS-REG-SUBSET 重锚的初始面,G2/D3):私有初始寄存器 ⊆ 声明集 ∪ flagRegisterNames。
 * FLAG 名经 flagRegisterNames 豁免(WP-1 §12.5:不要求是 registers 子集);
 * 违规仍记投影面规则 ID(实现只报一次的别名纪律),路径落在初始面。
 */
export function checkPrivateRegistersInDeclarationSet(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const declarationSet = new Set(
    publicDescriptor.vmProfile.registers.map((register) => register.name),
  );
  for (const name of publicDescriptor.vmProfile.flagRegisterNames ?? []) {
    declarationSet.add(name);
  }
  for (const [name] of Object.entries(privateBundle.initialState.registers)) {
    if (!declarationSet.has(name)) {
      violations.push({
        ruleId: "XS-PROJ-REG",
        message: `私有初始寄存器 ${name} 不在 VM Profile 寄存器声明集(registers ∪ flagRegisterNames;XS-REG-SUBSET 重锚的初始面)`,
        path: `/initialState/registers/${name}`,
      });
    }
  }
  return violations;
}

/** XS-REG-FLAG:公开 VM Profile 无 FLAG 名;FLAG 名必须存在于私有初始寄存器集。 */
export function checkFlagRegisterPolicy(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  publicDescriptor.vmProfile.registers.forEach((register, index) => {
    if (FLAG_REGISTER_NAME_PATTERN.test(register.name)) {
      violations.push({
        ruleId: "XS-REG-FLAG",
        message: `公开 VM Profile 寄存器名 ${register.name} 命中 FLAG 模式(FLAG 名只能经 flagRegisterNames 声明)`,
        path: `/vmProfile/registers/${index}/name`,
      });
    }
  });
  const privateRegisterNames = new Set(Object.keys(privateBundle.initialState.registers));
  (publicDescriptor.vmProfile.flagRegisterNames ?? []).forEach((name, index) => {
    if (!privateRegisterNames.has(name)) {
      violations.push({
        ruleId: "XS-REG-FLAG",
        message: `FLAG 寄存器 ${name} 未在私有包初始寄存器集中声明`,
        path: `/vmProfile/flagRegisterNames/${index}`,
      });
    }
  });
  return violations;
}

/** XS-PROJ-GEOM:初始投影区域 ↔ 公开布局按 regionId 双射,几何与标签逐项相等。 */
export function checkProjectionGeometry(
  publicDescriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const layoutById = new Map(
    publicDescriptor.memoryLayout.regions.map((region) => [region.regionId, region]),
  );
  const projection = publicDescriptor.initialProjection;
  projection.visibleRegions.forEach((projected, index) => {
    const layout = layoutById.get(projected.regionId);
    if (layout === undefined) {
      violations.push({
        ruleId: "XS-PROJ-GEOM",
        message: `投影可见区域 ${projected.regionId} 不在公开内存布局中`,
        path: `/initialProjection/visibleRegions/${index}`,
      });
      return;
    }
    if (parseAddressHex(projected.startAddressHex) !== parseAddressHex(layout.startAddressHex) || projected.byteLength !== layout.byteLength) {
      violations.push({
        ruleId: "XS-PROJ-GEOM",
        message: `投影区域 ${projected.regionId} 几何与布局不一致:start(${projected.startAddressHex} / ${layout.startAddressHex}) length(${projected.byteLength} / ${layout.byteLength})`,
        path: `/initialProjection/visibleRegions/${index}`,
      });
    }
    if (projected.permissions !== layout.permissions) {
      violations.push({
        ruleId: "XS-PROJ-GEOM",
        message: `投影区域 ${projected.regionId} permissions "${projected.permissions}" 与布局 "${layout.permissions}" 不一致`,
        path: `/initialProjection/visibleRegions/${index}/permissions`,
      });
    }
    if (projected.label !== layout.publicLabel) {
      violations.push({
        ruleId: "XS-PROJ-GEOM",
        message: `投影区域 ${projected.regionId} 标签 "${projected.label}" 与布局 publicLabel "${layout.publicLabel}" 不一致`,
        path: `/initialProjection/visibleRegions/${index}/label`,
      });
    }
  });
  const projectedIds = new Set(projection.visibleRegions.map((region) => region.regionId));
  for (const [index, layout] of publicDescriptor.memoryLayout.regions.entries()) {
    if (!projectedIds.has(layout.regionId)) {
      violations.push({
        ruleId: "XS-PROJ-GEOM",
        message: `布局区域 ${layout.regionId} 未出现在初始投影可见区域中`,
        path: `/memoryLayout/regions/${index}`,
      });
    }
  }
  return violations;
}

function normalizeHexValue(valueHex: string): string {
  return valueHex.replace(/^0x/, "").toUpperCase();
}

/** XS-PROJ-VALUES:公开镜像值 = 私有初始值的可公开前缀。 */
export function checkProjectionValuesMirrored(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const privateRegionById = new Map(
    privateBundle.initialState.memoryRegions.map((region) => [region.regionId, region]),
  );
  publicDescriptor.initialProjection.visibleRegions.forEach((projected, index) => {
    const region = privateRegionById.get(projected.regionId);
    if (region === undefined) {
      violations.push({
        ruleId: "XS-PROJ-VALUES",
        message: `投影区域 ${projected.regionId} 在私有包中无对应区域,bytesHex 无权威来源`,
        path: `/initialProjection/visibleRegions/${index}/bytesHex`,
      });
      return;
    }
    const prefixBytes = projected.bytesHex.length / 2;
    if (!region.contentHex.toLowerCase().startsWith(projected.bytesHex.toLowerCase())) {
      violations.push({
        ruleId: "XS-PROJ-VALUES",
        message: `投影区域 ${projected.regionId} 的 bytesHex 不是私有 contentHex 的前缀(公开值必须镜像私有初始值)`,
        path: `/initialProjection/visibleRegions/${index}/bytesHex`,
      });
    }
    const shouldBeTruncated = prefixBytes < region.byteLength;
    if (projected.truncated !== shouldBeTruncated) {
      violations.push({
        ruleId: "XS-PROJ-VALUES",
        message: `投影区域 ${projected.regionId} truncated=${projected.truncated} 与实际不符(${prefixBytes} / ${region.byteLength} 字节)`,
        path: `/initialProjection/visibleRegions/${index}/truncated`,
      });
    }
  });
  const privateRegisters = privateBundle.initialState.registers;
  publicDescriptor.initialProjection.visibleRegisters.forEach((register, index) => {
    const privateValue = privateRegisters[register.name];
    if (privateValue === undefined) {
      violations.push({
        ruleId: "XS-PROJ-VALUES",
        message: `投影寄存器 ${register.name} 未在私有包初始寄存器中声明,公开值无权威来源`,
        path: `/initialProjection/visibleRegisters/${index}/valueHex`,
      });
      return;
    }
    if (normalizeHexValue(register.valueHex) !== normalizeHexValue(privateValue)) {
      violations.push({
        ruleId: "XS-PROJ-VALUES",
        message: `投影寄存器 ${register.name} 公开值 ${register.valueHex} 与私有初始值 ${privateValue} 不一致`,
        path: `/initialProjection/visibleRegisters/${index}/valueHex`,
      });
    }
  });
  return violations;
}

/** XS-CANARY-CORR:启用 canary ⇒ 存在 hidden + containsSecret 的 canary 对象且与公开区域不相交。 */
export function checkCanaryCorrespondence(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  if (!publicDescriptor.vmProfile.canary.enabled) {
    return [];
  }
  const publicRanges = publicDescriptor.memoryLayout.regions.map((region) => ({
    regionId: region.regionId,
    range: publicRegionRange(region),
  }));
  const compliant = privateBundle.privateObjects.some((object) => {
    if (object.kind !== "canary" || object.visibility !== "hidden" || !object.containsSecret) {
      return false;
    }
    const range = toAddressRange(object.addressHex, object.byteLength);
    return !publicRanges.some((entry) => rangesOverlap(range, entry.range));
  });
  if (!compliant) {
    return [
      {
        ruleId: "XS-CANARY-CORR",
        message:
          "公开包启用了 canary,但私有包缺少 hidden + containsSecret 的 canary 对象(或其区间与公开区域相交)",
        path: "/privateObjects",
      },
    ];
  }
  return [];
}

/** XS-SEED-DECL 允许的路径根与叶子:仅作者可声明的两个投影子形状。 */
const SEED_DECL_ROOTS: Readonly<Record<string, readonly string[]>> = {
  visibleRegions: ["bytesHex", "label", "startAddressHex", "byteLength", "permissions", "truncated"],
  visibleRegisters: ["valueHex"],
};

/** XS-SEED-DECL:seed 公开路径必须可解析到作者可声明的投影叶子。 */
export function checkSeedDeclarations(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const visibleRegionIds = new Set(
    publicDescriptor.initialProjection.visibleRegions.map((region) => region.regionId),
  );
  const visibleRegisterNames = new Set(
    publicDescriptor.initialProjection.visibleRegisters.map((register) => register.name),
  );
  privateBundle.declaredSeedPublicPaths.forEach((seedPath, index) => {
    const segments = seedPath.split(".");
    const root = segments[0];
    const allowedLeaves = root === undefined ? undefined : SEED_DECL_ROOTS[root];
    if (allowedLeaves === undefined) {
      violations.push({
        ruleId: "XS-SEED-DECL",
        message: `seed 公开路径 "${seedPath}" 的根 "${root ?? ""}" 不是作者可声明投影面(仅 visibleRegions / visibleRegisters)`,
        path: `/declaredSeedPublicPaths/${index}`,
      });
      return;
    }
    const leaf = segments[segments.length - 1];
    const midSegment = segments[1];
    if (leaf === undefined || midSegment === undefined || !allowedLeaves.includes(leaf)) {
      violations.push({
        ruleId: "XS-SEED-DECL",
        message: `seed 公开路径 "${seedPath}" 未解析到可声明叶子(${allowedLeaves.join(" / ")})`,
        path: `/declaredSeedPublicPaths/${index}`,
      });
      return;
    }
    const targetOk =
      root === "visibleRegions"
        ? visibleRegionIds.has(midSegment)
        : visibleRegisterNames.has(midSegment);
    if (!targetOk) {
      violations.push({
        ruleId: "XS-SEED-DECL",
        message: `seed 公开路径 "${seedPath}" 的目标 "${midSegment}" 不在初始投影中`,
        path: `/declaredSeedPublicPaths/${index}`,
      });
    }
  });
  return violations;
}
