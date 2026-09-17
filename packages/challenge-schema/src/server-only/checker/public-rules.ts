/**
 * 公开描述包单侧检查规则(WP-1 §12.6 左列规则 ID):
 *  - I2-PUB-PAIRWISE 公开内存区域两两不相交(BigInt 区间);
 *  - I2-HIGHLIGHT 语义高亮目标必须在可见区域且区间完全落在其中;
 *  - D2-CODE-PUBLIC 代码区域恒公开:kind=code 区域至多一个且必须出现在初始投影;
 *  - XS-ID-UNIQUE 公开面引用 ID 唯一(区域 / 寄存器 / FLAG / 提示阶 / 错误码);
 *  - XS-REG-CORE vmProfile.registers 声明集必含核心寄存器 RSP/RBP/RIP
 *    (G2/D3:会话动作 push/pop/call/ret 与栈语义建立在其上,WP-1 §12.5 v1.5);
 *  - XS-MEM-PAGE-ALIGN pageSizeBytes 与区域 byteLength 均为 4KB 的倍数
 *    (G3/D2;Schema multipleOf 之外的纵深防御,见 arch-rules.ts);
 *  - XS-ASLR-NOTICE aslrEnabled = true ⇒ randomizationNotice 必须存在
 *    (WP-43 / ADR-DC1 决议 2:随机化声明与 ASLR 开关联动的语义自洽)。
 *
 * 前置条件:输入已通过 public-descriptor.schema.json 校验;
 * 本模块是纵深防御与跨字段一致性检查,不重复 Schema 已冻结的单字段形态。
 * debugMode / aslrEnabled(WP-43 新增顶层可选布尔)的**类型面**(非布尔即拒)
 * 由 Schema `type: boolean` + `coerceTypes: false` 冻结,不设重复 checker 规则;
 * 红灯样例见 test/public-descriptor.test.ts(Schema 结构面)。
 */

import type { PublicChallengeDescriptor } from "../../common/public-types.js";
import {
  AUTHOR_BLOCK_ACTION_ARGS,
  AUTHOR_BLOCK_SLOT_KINDS,
} from "../../common/author-blocks.js";
import { MAX_AUTHOR_BLOCK_SLOTS } from "../../common/limits.js";
import { CORE_REGISTER_NAMES } from "../../common/patterns.js";
import { SESSION_ACTION_TYPES, type SessionActionType } from "../../common/vocabulary.js";
import { checkPublicPageAlignment } from "./arch-rules.js";
import { toAddressRange, rangesOverlap, rangeContains, rangeExceedsAddressSpace } from "./address-ranges.js";
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
 * XS-ADDR-SPACE 公开侧(R4 统一化):公开区域起始地址 + byteLength 不得越出
 * 64 位地址空间(半开区间,末字节 0xFFFFFFFFFFFFFFFF 合法,越过 2^64 拒绝;
 * BigInt 不回绕,统一经 address-ranges 的常量与谓词判定)。
 */
export function checkPublicAddressSpaceBounds(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  descriptor.memoryLayout.regions.forEach((region, index) => {
    if (rangeExceedsAddressSpace(regionRange(region))) {
      violations.push({
        ruleId: "XS-ADDR-SPACE",
        message: `公开区域 ${region.regionId} 地址区间 [${region.startAddressHex}, +${region.byteLength} 字节)越出 64 位地址空间(结束地址必须 ≤ 2^64,R4 半开区间统一约定)`,
        path: `/memoryLayout/regions/${index}`,
      });
    }
  });
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

/**
 * XS-ASLR-NOTICE(WP-43 / ADR-DC1 决议 2):aslrEnabled = true ⇒ randomizationNotice
 * 必须存在。开启基址随机化(布局转结构描述、真实基址由会话种子派生)却无
 * 随机化存在性文案 = 矛盾陈述——randomizationNotice 是公开面声明随机化
 * 存在性的唯一 sanctioned 位(WP-1 §3.2 seedState 行)。aslrEnabled 缺省 /
 * false 时不要求本字段(opt-in 联动,不误伤既有包)。
 */
export function checkAslrRandomizationNotice(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  if (descriptor.aslrEnabled === true && descriptor.randomizationNotice === undefined) {
    return [
      {
        ruleId: "XS-ASLR-NOTICE",
        message:
          "aslrEnabled = true 时必须携带 randomizationNotice(基址随机化声明与 ASLR 开关联动;布局在此形态下为结构描述,真实基址由种子派生)",
        path: "/randomizationNotice",
      },
    ];
  }
  return [];
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
  // M10/WP-80:出题者积木模板标识唯一(公开面引用 ID 一族)。
  pushPublicDuplicates(
    violations,
    (descriptor.authorBlocks ?? []).map((block) => block.id),
    (index) => `/authorBlocks/${index}/id`,
    (value) => `积木模板 id "${value}" `,
  );
  return violations;
}

/**
 * XS-BLOCK-SLOT-FORM(M10/WP-80):出题者积木声明面的**槽位形态与参数位取值形态**。
 *
 * 逐条:
 *  - 槽位键唯一(同一模板内不同槽位不得同名——否则 `{slot}` 引用歧义);
 *  - 槽位数量 ≤ `MAX_AUTHOR_BLOCK_SLOTS`(Schema maxItems 之外的纵深防御);
 *  - 槽位 `kind` ∈ `AUTHOR_BLOCK_SLOT_KINDS`(类型断言绕过 Schema 时的第二道防线);
 *  - 动作参数位的 `{slot}` 引用必须解析到**本模板已声明**的槽位(未声明即拒);
 *  - 动作引用的槽位必须是**被引用过的**声明槽位(悬空槽位 = 声明面自相矛盾);
 *  - 参数位取值形态:`{slot}` 与字面量二选一(第三种形态即拒),字面量必须非空串。
 *
 * 前置条件:输入已通过公开 Schema 校验;本规则是纵深防御与跨字段一致性检查。
 */
export function checkAuthorBlockSlotForm(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  (descriptor.authorBlocks ?? []).forEach((block, blockIndex) => {
    const base = `/authorBlocks/${blockIndex}`;
    const slots = block.slots ?? [];
    if (slots.length > MAX_AUTHOR_BLOCK_SLOTS) {
      violations.push({
        ruleId: "XS-BLOCK-SLOT-FORM",
        message: `积木模板 ${block.id} 的槽位数 ${slots.length} 超过上限 ${MAX_AUTHOR_BLOCK_SLOTS}(D-MP-6 定案)`,
        path: `${base}/slots`,
      });
    }
    const declared = new Set<string>();
    slots.forEach((slot, slotIndex) => {
      if (declared.has(slot.key)) {
        violations.push({
          ruleId: "XS-BLOCK-SLOT-FORM",
          message: `积木模板 ${block.id} 的槽位键 "${slot.key}" 重复(引用歧义)`,
          path: `${base}/slots/${slotIndex}/key`,
        });
      }
      declared.add(slot.key);
      if (!(AUTHOR_BLOCK_SLOT_KINDS as readonly string[]).includes(slot.kind)) {
        violations.push({
          ruleId: "XS-BLOCK-SLOT-FORM",
          message: `积木模板 ${block.id} 的槽位 "${slot.key}" 形态 "${String(slot.kind)}" 不在封闭枚举 address/immediate/length 内`,
          path: `${base}/slots/${slotIndex}/kind`,
        });
      }
    });

    const referenced = new Set<string>();
    (block.actions ?? []).forEach((action, actionIndex) => {
      const argsPath = `${base}/actions/${actionIndex}/args`;
      for (const [argName, value] of Object.entries(action.args ?? {})) {
        const argPath = `${argsPath}/${argName}`;
        if (typeof value === "string") {
          if (value.length === 0) {
            violations.push({
              ruleId: "XS-BLOCK-SLOT-FORM",
              message: `积木模板 ${block.id} 的动作参数位 ${argName} 字面量为空串`,
              path: argPath,
            });
          }
          continue;
        }
        if (value === null || typeof value !== "object" || typeof value.slot !== "string") {
          violations.push({
            ruleId: "XS-BLOCK-SLOT-FORM",
            message: `积木模板 ${block.id} 的动作参数位 ${argName} 既非字面量也非 { slot } 槽位引用`,
            path: argPath,
          });
          continue;
        }
        referenced.add(value.slot);
        if (!declared.has(value.slot)) {
          violations.push({
            ruleId: "XS-BLOCK-SLOT-FORM",
            message: `积木模板 ${block.id} 的动作参数位 ${argName} 引用的槽位 "${value.slot}" 未在 slots 中声明`,
            path: argPath,
          });
        }
      }
    });
    slots.forEach((slot, slotIndex) => {
      if (!referenced.has(slot.key)) {
        violations.push({
          ruleId: "XS-BLOCK-SLOT-FORM",
          message: `积木模板 ${block.id} 声明的槽位 "${slot.key}" 未被任何动作引用(悬空声明)`,
          path: `${base}/slots/${slotIndex}/key`,
        });
      }
    });
  });
  return violations;
}

/**
 * XS-BLOCK-ARG-ALLOW(M10/WP-80):动作序列是 **12 公开动作的子集**、且参数位不越出
 * 该动作的公开参数面。
 *
 * 逐条:
 *  - `type` ∈ `SESSION_ACTION_TYPES`(Schema 封闭枚举之外的纵深防御:类型断言
 *    绕过 Schema 时的子集闸——"动作序列面必须是 12 个公开动作的子集"是硬约束);
 *  - `args` 键 ⊆ 该动作的允许参数位(`AUTHOR_BLOCK_ACTION_ARGS`;协议
 *    `ActionObjectSchema` 的公开镜像);
 *  - 必填参数位在场(缺参动作在编译期必然失败,声明期即拒可给出可解释反馈)。
 */
export function checkAuthorBlockActionArgs(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const knownActions = new Set<string>(SESSION_ACTION_TYPES);
  (descriptor.authorBlocks ?? []).forEach((block, blockIndex) => {
    (block.actions ?? []).forEach((action, actionIndex) => {
      const base = `/authorBlocks/${blockIndex}/actions/${actionIndex}`;
      const actionType = String(action.type);
      if (!knownActions.has(actionType)) {
        violations.push({
          ruleId: "XS-BLOCK-ARG-ALLOW",
          message: `积木模板 ${block.id} 的动作 ${actionType} 不在 12 个公开动作内(动作序列面必须是公开动作子集)`,
          path: `${base}/type`,
        });
        return;
      }
      const spec = AUTHOR_BLOCK_ACTION_ARGS[actionType as SessionActionType];
      const argNames = Object.keys(action.args ?? {});
      for (const argName of argNames) {
        if (!spec.allowed.includes(argName)) {
          violations.push({
            ruleId: "XS-BLOCK-ARG-ALLOW",
            message: `积木模板 ${block.id} 的动作 ${actionType} 携带越界参数位 "${argName}"(该动作公开参数面:${spec.allowed.length === 0 ? "无" : spec.allowed.join(" / ")})`,
            path: `${base}/args/${argName}`,
          });
        }
      }
      for (const required of spec.required) {
        if (!argNames.includes(required)) {
          violations.push({
            ruleId: "XS-BLOCK-ARG-ALLOW",
            message: `积木模板 ${block.id} 的动作 ${actionType} 缺少必填参数位 "${required}"`,
            path: `${base}/args`,
          });
        }
      }
    });
  });
  return violations;
}

/**
 * XS-BLOCK-NO-EFFECT(M10/WP-80)是**跨包**规则(需要私有包的隐藏面哨兵),
 * 落点为 `pair-rules.ts#checkAuthorBlocksNoEffectSemantics` —— 本文件只承载
 * 公开单侧可判定的声明面形态规则(XS-BLOCK-SLOT-FORM / XS-BLOCK-ARG-ALLOW)。
 */

/** 公开侧单规则聚合(供 checkChallengePair 复用,亦可单测)。 */
export function checkPublicDescriptorRules(
  descriptor: PublicChallengeDescriptor,
): CheckerViolation[] {
  return [
    ...checkPublicRegionsPairwiseDisjoint(descriptor),
    ...checkPublicHighlights(descriptor),
    ...checkPublicCodeRegionPolicy(descriptor),
    ...checkPublicAddressSpaceBounds(descriptor),
    ...checkPublicReferenceUniqueness(descriptor),
    ...checkRegisterCoreSet(descriptor),
    ...checkAslrRandomizationNotice(descriptor),
    ...checkPublicPageAlignment(descriptor),
    ...checkAuthorBlockSlotForm(descriptor),
    ...checkAuthorBlockActionArgs(descriptor),
  ];
}
