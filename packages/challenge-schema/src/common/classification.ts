/**
 * 字段分类清单(schema/classification.json 的常量形态,两者严格一致,
 * 严格性测试强制)与公开包禁用属性集。
 *
 * 分类唯一依据:docs/数据分类与秘密零驻留清单.md 第十二章;
 * 公开描述包整体 PUBLIC、私有判题包整体 SERVER_ONLY,无逐字段灰地带。
 */

import { CHALLENGE_PACKAGE_SCHEMA_VERSION, CHALLENGE_SCHEMA_PACKAGE_VERSION } from "../version.js";

/** 字段分类标签(双包只有两档;不存在 BOUNDARY——双包都不是玩家输入回传)。 */
export type FieldClass = "public" | "server-only";

/** 单个 Schema 的分类条目。 */
export interface SchemaClassificationEntry {
  readonly file: string;
  readonly title: string;
  readonly rootClass: FieldClass;
  readonly fieldClasses: Readonly<Record<string, FieldClass>>;
}

/** 分类清单清单根(≡ schema/classification.json)。 */
export interface ClassificationManifest {
  readonly packageVersion: string;
  readonly challengePackageSchemaVersion: number;
  readonly note: string;
  readonly schemas: Readonly<Record<string, SchemaClassificationEntry>>;
}

/** 公开描述包 14 个顶层字段(与 Schema properties 键严格一致)。 */
export const PUBLIC_DESCRIPTOR_FIELDS = [
  "schemaVersion",
  "challengeId",
  "challengeContentVersion",
  "vmProfileVersion",
  "locale",
  "briefing",
  "vmProfile",
  "memoryLayout",
  "allowedActions",
  "resourceLimits",
  "hintLadder",
  "publicErrorMapping",
  "randomizationNotice",
  "initialProjection",
] as const;

/** 私有判题包 19 个顶层字段(整体 SERVER_ONLY;与 Schema properties 键严格一致;customInstructions / interfaces 为 G4/D4 新增声明面)。 */
export const PRIVATE_BUNDLE_FIELDS = [
  "schemaVersion",
  "challengeId",
  "challengeContentVersion",
  "vmProfileVersion",
  "dslSchemaVersion",
  "vmEngineVersion",
  "engineBuildId",
  "declaredSeedPublicPaths",
  "seedPolicy",
  "initialState",
  "secretSinkRegisters",
  "secrets",
  "privateObjects",
  "judging",
  "stages",
  "compiledIr",
  "customInstructions",
  "interfaces",
  "judgingConfig",
] as const;

/** 双包共享身份字段(4 个;XS-ID-CORR 校验两包取值相等)。 */
export const SHARED_IDENTITY_FIELDS = [
  "schemaVersion",
  "challengeId",
  "challengeContentVersion",
  "vmProfileVersion",
] as const;

/**
 * 禁止以任何形态出现在公开 Schema / 公开包实例的私有顶层属性名
 * (XS-1 元检查 = 私有顶层 − 4 共享身份字段)。
 */
export const FORBIDDEN_PUBLIC_PROPERTIES: readonly string[] = PRIVATE_BUNDLE_FIELDS.filter(
  (name) => !(SHARED_IDENTITY_FIELDS as readonly string[]).includes(name),
);

function toFieldClasses(
  names: readonly string[],
  fieldClass: FieldClass,
): Record<string, FieldClass> {
  return Object.fromEntries(names.map((name) => [name, fieldClass]));
}

const NOTE =
  "字段分类唯一依据 docs/数据分类与秘密零驻留清单.md 第十二章;机检消费见 WP-1 §12.6(ZR-B8 / I-1 / I-2 / I-3 / D2)。Schema 存在不等于可下发:server-only 类型仅供后端包(challenge-compiler、session-api、verifier)跨语言校验消费,永不进入浏览器构建图。";

/** 分类清单常量(与 schema/classification.json 严格一致;测试强制)。 */
export const CHALLENGE_CLASSIFICATIONS: ClassificationManifest = {
  packageVersion: CHALLENGE_SCHEMA_PACKAGE_VERSION,
  challengePackageSchemaVersion: CHALLENGE_PACKAGE_SCHEMA_VERSION,
  note: NOTE,
  schemas: {
    "public-descriptor": {
      file: "public-descriptor.schema.json",
      title: "PublicChallengeDescriptor",
      rootClass: "public",
      fieldClasses: toFieldClasses(PUBLIC_DESCRIPTOR_FIELDS, "public"),
    },
    "private-bundle": {
      file: "private-bundle.schema.json",
      title: "PrivateChallengeBundle",
      rootClass: "server-only",
      fieldClasses: toFieldClasses(PRIVATE_BUNDLE_FIELDS, "server-only"),
    },
  },
};
