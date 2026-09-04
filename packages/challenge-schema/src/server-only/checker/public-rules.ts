/**
 * 公开描述包单侧检查规则(WP-1 §12.6 左列规则 ID):
 *  - I2-PUB-PAIRWISE 公开内存区域两两不相交(BigInt 区间);
 *  - I2-HIGHLIGHT 语义高亮目标必须在可见区域且区间完全落在其中;
 *  - D2-CODE-PUBLIC 代码区域恒公开:kind=code 区域至多一个且必须出现在初始投影;
 *  - XS-ID-UNIQUE 公开面引用 ID 唯一(区域 / 寄存器 / FLAG / 提示阶 / 错误码);
 *  - XS-REG-CORE vmProfile.registers 声明集必含核心寄存器 RSP/RBP/RIP
 *    (G2/D3:会话动作 push/pop/call/ret 与栈语义建立在其上,WP-1 §12.5 v1.5);
 *  - XS-MEM-PAGE-ALIGN pageSizeBytes 与区域 byteLength 均为 4KB 的倍数
 *    (G3/D2;Schema multipleOf 之外的纵深防御,见 arch-rules.ts)。
 *
 * 前置条件:输入已通过 public-descriptor.schema.json 校验;
 * 本模块是纵深防御与跨字段一致性检查,不重复 Schema 已冻结的单字段形态。
 */

import type { PublicChallengeDescriptor } from "../../common/public-types.js";
import { CORE_REGISTER_NAMES } from "../../common/patterns.js";
import { checkPublicPageAlignment } from "./arch-rules.js";
import { toAddressRange, rangesOverlap, rangeContains } from "./address-ranges.js";
import type { AddressRange } from "./address-ranges.js";
import { pushDuplicateViolations } from "./duplicates.js";
import type { CheckerViolation } from "./types.js";

/** 公开区域区间;入参畸形(前置条件外)由 parseAddressHex 快速失败。 */
function regionRange(region: {
  readonly startAddressHex: string;
  readonly byteLength: number;
}): AddressRange {
  return toAddressRange(region.startAddressHex, region.byteLength);
}

/** I2-PUB-PAIRWISE:公开内存区域两两不相交。 */
export function checkPublicRegionsPairwiseDisjoint(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const regions = descriptor.memoryLayout.regions;
  for (let i = 0; i < regions.length; i += 1) {
    const left = regions[i];
    if (left === undefined) {
      continue;
    }
    for (let j = i + 1; j < regions.length; j += 1) {
      const right = regions[j];
      if (right === undefined) {
        continue;
      }
      if (rangesOverlap(regionRange(left), regionRange(right))) {
        violations.push({
          ruleId: "I2-PUB-PAIRWISE",
          message: `公开内存区域 ${left.regionId} 与 ${right.regionId} 地址区间相交`,
          path: `/memoryLayout/regions/${j}`,
        });
      }
    }
  }
  return violations;
}

/** I2-HIGHLIGHT:高亮目标必须是可见区域,且高亮区间完全落在该区域内。 */
export function checkPublicHighlights(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const highlights = descriptor.initialProjection.semanticHighlights ?? [];
  highlights.forEach((highlight, index) => {
    const path = `/initialProjection/semanticHighlights/${index}`;
    const region = descriptor.initialProjection.visibleRegions.find(
      (candidate) => candidate.regionId === highlight.targetRegionId,
    );
    if (region === undefined) {
      violations.push({
        ruleId: "I2-HIGHLIGHT",
        message: `语义高亮(${highlight.kind})引用的目标区域 ${highlight.targetRegionId} 不在初始投影可见区域中`,
        path,
      });
      return;
    }
    const outer = regionRange(region);
    const inner = toAddressRange(highlight.startAddressHex, highlight.byteLength);
    if (!rangeContains(outer, inner)) {
      violations.push({
        ruleId: "I2-HIGHLIGHT",
        message: `语义高亮(${highlight.kind})的地址区间未完全落在目标区域 ${region.regionId} 内`,
        path,
      });
    }
  });
  return violations;
}

/** D2-CODE-PUBLIC:代码区域至多一个,且必须出现在初始投影(代码区恒公开)。 */
export function checkPublicCodeRegionPolicy(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const codeRegions = descriptor.memoryLayout.regions.filter(
    (region) => region.kind === "code",
  );
  if (codeRegions.length > 1) {
    violations.push({
      ruleId: "D2-CODE-PUBLIC",
      message: `代码区域(kind=code)最多允许 1 个,实际 ${codeRegions.length} 个`,
      path: "/memoryLayout/regions",
    });
  }
  const projectedRegionIds = new Set(
    descriptor.initialProjection.visibleRegions.map((region) => region.regionId),
  );
  for (const region of descriptor.memoryLayout.regions) {
    if (region.kind === "code" && !projectedRegionIds.has(region.regionId)) {
      violations.push({
        ruleId: "D2-CODE-PUBLIC",
        message: `代码区域 ${region.regionId} 必须出现在初始投影可见区域中(代码区不允许隐藏)`,
        path: `/initialProjection/visibleRegions`,
      });
    }
  }
  if (descriptor.initialProjection.visibleRegions.length < 1) {
    violations.push({
      ruleId: "D2-CODE-PUBLIC",
      message: "初始投影至少要有一个可见内存区域",
      path: "/initialProjection/visibleRegions",
    });
  }
  return violations;
}

/**
 * XS-REG-CORE:vmProfile.registers 声明集必含核心寄存器 RSP/RBP/RIP(G2/D3,WP-1 §12.5 v1.5)。
 * 寄存器集是定义性声明,但会话动作(push/pop/call/ret)、栈操作码与 MVP 栈帧闭环
 * 一律建立在核心三寄存器上,故保留为必选;缺失即拒绝。
 */
export function checkRegisterCoreSet(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const declared = new Set(descriptor.vmProfile.registers.map((register) => register.name));
  for (const coreName of CORE_REGISTER_NAMES) {
    if (!declared.has(coreName)) {
      violations.push({
        ruleId: "XS-REG-CORE",
        message: `vmProfile.registers 缺少必选核心寄存器 ${coreName}(会话动作与栈语义建立其上)`,
        path: "/vmProfile/registers",
      });
    }
  }
  return violations;
}

function pushPublicDuplicates(
  violations: CheckerViolation[],
  values: readonly string[],
  buildPath: (index: number) => string,
  describe: (value: string) => string,
): void {
  pushDuplicateViolations(violations, values, buildPath, describe);
}

/** XS-ID-UNIQUE:公开面全部引用 ID 与序号唯一。 */
export function checkPublicReferenceUniqueness(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const layout = descriptor.memoryLayout;
  pushPublicDuplicates(
    violations,
    layout.regions.map((region) => region.regionId),
    (index) => `/memoryLayout/regions/${index}/regionId`,
    (value) => `公开内存区域 regionId "${value}" `,
  );
  pushPublicDuplicates(
    violations,
    descriptor.vmProfile.registers.map((register) => register.name),
    (index) => `/vmProfile/registers/${index}/name`,
    (value) => `VM Profile 寄存器名 "${value}" `,
  );
  pushPublicDuplicates(
    violations,
    descriptor.vmProfile.flagRegisterNames ?? [],
    (index) => `/vmProfile/flagRegisterNames/${index}`,
    (value) => `FLAG 寄存器名 "${value}" `,
  );
  const projection = descriptor.initialProjection;
  pushPublicDuplicates(
    violations,
    projection.visibleRegions.map((region) => region.regionId),
    (index) => `/initialProjection/visibleRegions/${index}/regionId`,
    (value) => `投影可见区域 regionId "${value}" `,
  );
  pushPublicDuplicates(
    violations,
    projection.visibleRegisters.map((register) => register.name),
    (index) => `/initialProjection/visibleRegisters/${index}/name`,
    (value) => `投影寄存器名 "${value}" `,
  );
  pushPublicDuplicates(
    violations,
    descriptor.hintLadder.map((hint) => String(hint.order)),
    (index) => `/hintLadder/${index}/order`,
    (value) => `提示阶 order ${value} `,
  );
  pushPublicDuplicates(
    violations,
    descriptor.publicErrorMapping.map((mapping) => mapping.errorCode),
    (index) => `/publicErrorMapping/${index}/errorCode`,
    (value) => `公开错误映射 errorCode "${value}" `,
  );
  return violations;
}

/** 公开侧单规则聚合(供 checkChallengePair 复用,亦可单测)。 */
export function checkPublicDescriptorRules(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  return [
    ...checkPublicRegionsPairwiseDisjoint(descriptor),
    ...checkPublicHighlights(descriptor),
    ...checkPublicCodeRegionPolicy(descriptor),
    ...checkPublicReferenceUniqueness(descriptor),
    ...checkRegisterCoreSet(descriptor),
    ...checkPublicPageAlignment(descriptor),
  ];
}
