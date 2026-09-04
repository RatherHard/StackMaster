/**
 * 字段分类检查器聚合入口(双包Schema语义.md §五冻结契约):
 *
 *   checkChallengePair(public, private): { ok, violations }
 *   Violation = { ruleId, message, path? }
 *
 * 前置条件:两输入均已通过各自 Schema 校验(validatePublicDescriptor /
 * validatePrivateBundle);检查器做 Schema 无法表达的跨字段与跨包一致性,
 * 并对少数 Schema 可拒形态做纵深防御。规则 ID 直接引用 WP-1 §12.6 左列;
 * 每条规则的必触发红灯样例见 test/checker.test.ts(扫描器自检纪律)。
 * XS-DUP-KEY 的落点在 json-strict-parse(严格 JSON 扫描器),其红灯样例
 * 见 test/json-strict-parse.test.ts。
 *
 * SERVER_ONLY:本模块仅经 @stackmaster/challenge-schema/server-only 导出,
 * 只允许后端包消费;检查器输入含私有判题包完整状态,永不跨域。
 *
 * 错误两层模型(R7):
 *  - **内部诊断层**(本模块输出的 CheckerViolation):消息与路径面向服务端
 *    审查日志、开发测试与管理后台(信任域 4,作者修复自身题目包)反馈,
 *    允许保留私有上下文;永不进入玩家可达的任何载荷(投影、错误、回放、日志)。
 *  - **公开错误层**:玩家可达错误只允许稳定的 PublicError code;题目包
 *    校验失败对玩家一律表现为 internal_error(PUBLIC_FACING_ERROR_CODE),
 *    由会话服务层(session-api,阶段二)执行映射——禁止透传 violation 的
 *    message / path。侧信道约束(长度 / 分类 / 时序)在服务层落地时复核。
 */

import type { PublicChallengeDescriptor } from "../../common/public-types.js";
import type { PrivateChallengeBundle } from "../private-types.js";
import { checkArchWidth } from "./arch-rules.js";
import {
  checkCodeRegionWritability,
  checkEncodingProbe,
  checkEncodingTable,
  checkProgramMode,
} from "./encoding-rules.js";
import { checkPrivateBundleRules } from "./private-rules.js";
import {
  checkCanaryCorrespondence,
  checkFlagRegisterPolicy,
  checkHiddenObjectsDisjointFromPublic,
  checkHiddenRegionsDisjointFromPublic,
  checkIdentityCorrespondence,
  checkNoCapabilityStringsInPublic,
  checkNoPrivateIdsInPublic,
  checkProjectionGeometry,
  checkProjectionValuesMirrored,
  checkPublicPrivateRegionMirror,
  checkSeedDeclarations,
  checkPrivateRegistersInDeclarationSet,
  checkVisibleRegistersInDeclarationSet,
  checkVisibleRegistersNotSecretSinks,
} from "./pair-rules.js";
import { checkPublicDescriptorRules } from "./public-rules.js";
import type { CheckerResult, CheckerViolation } from "./types.js";

export type { CheckerResult, CheckerViolation } from "./types.js";
export { RULE_ID_ALIASES } from "./types.js";
export { CAPABILITY_SCAN_PREFIXES } from "./pair-rules.js";
export { checkSchemaMeta } from "./schema-meta.js";

/**
 * 违规对应的玩家可达 PublicError code(R7 错误分层;与
 * @stackmaster/protocol PUBLIC_ERROR_CODES 第 16 值一致的字符串字面量——
 * 本包是叶子包,不依赖 protocol,由严格性测试对照词汇表防漂移)。
 *
 * 裁决:全部检查器违规统一映射 internal_error——违规题目包在装载期被拒,
 * 不存在"带病服务"的会话,玩家侧永远收不到任何违规细节;逐规则细分
 * 只保留在内部诊断层与管理后台(信任域 4)。会话服务层禁止透传
 * CheckerViolation 的 message / path。
 */
export const PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS = "internal_error";

/**
 * R1/R2 裁决记录:公开 ISA 引用面。
 *
 * 公开包 `vmProfile.encodingTable[].op` 的自定义助记符与
 * `operands[].interfaceId` 定义为**公开 ISA 引用面**(sanctioned public
 * references):玩家可学习"存在哪些指令 / 接口及其公开标识"——这是字节
 * 模式 ISA 公开立场的必然推论(代码区恒公开、谜题在 gadget 构造不在解码)。
 * 私有声明面(customInstructions 的微算子语义与 displayText、interfaces 的
 * 效果序列)整体 SERVER_ONLY,公开引用的存在性检查由 XS-ENC-TOKEN 承接:
 * 未声明助记符 / 未声明接口号的公开条目即拒——隐藏声明不产生存在性信号。
 * 该裁决的扫描测试见 test/isa-reference-face.test.ts(公开包不含微算子
 * 语义、效果细节、displayText、fileId、FLAG 名等私有派生信息)。
 */

/** 跨包一致性规则(公开 × 私有)。 */
export function checkPairRules(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerViolation[] {
  return [
    ...checkIdentityCorrespondence(publicDescriptor, privateBundle),
    ...checkPublicPrivateRegionMirror(publicDescriptor, privateBundle),
    ...checkHiddenRegionsDisjointFromPublic(publicDescriptor, privateBundle),
    ...checkHiddenObjectsDisjointFromPublic(publicDescriptor, privateBundle),
    ...checkVisibleRegistersNotSecretSinks(publicDescriptor, privateBundle),
    ...checkNoCapabilityStringsInPublic(publicDescriptor),
    ...checkNoPrivateIdsInPublic(publicDescriptor, privateBundle),
    ...checkVisibleRegistersInDeclarationSet(publicDescriptor),
    ...checkPrivateRegistersInDeclarationSet(publicDescriptor, privateBundle),
    ...checkFlagRegisterPolicy(publicDescriptor, privateBundle),
    ...checkProjectionGeometry(publicDescriptor),
    ...checkProjectionValuesMirrored(publicDescriptor, privateBundle),
    ...checkCanaryCorrespondence(publicDescriptor, privateBundle),
    ...checkSeedDeclarations(publicDescriptor, privateBundle),
    ...checkArchWidth(publicDescriptor, privateBundle),
    ...checkProgramMode(publicDescriptor, privateBundle),
    ...checkCodeRegionWritability(publicDescriptor, privateBundle),
    ...checkEncodingTable(publicDescriptor, privateBundle),
    ...checkEncodingProbe(publicDescriptor, privateBundle),
  ];
}

/**
 * 双包联合检查:公开单侧 + 私有单侧 + 跨包一致性。
 * ok = 无任何违规;违规按规则聚合,顺序即上述聚合顺序。
 */
export function checkChallengePair(
  publicDescriptor: PublicChallengeDescriptor,
  privateBundle: PrivateChallengeBundle,
): CheckerResult {
  const violations: CheckerViolation[] = [
    ...checkPublicDescriptorRules(publicDescriptor),
    ...checkPrivateBundleRules(privateBundle),
    ...checkPairRules(publicDescriptor, privateBundle),
  ];
  return { ok: violations.length === 0, violations };
}
