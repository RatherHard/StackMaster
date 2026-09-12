/**
 * 提交引用(`stackmaster-session-submit/1`)与重放材料的受理面(WP-61)。
 *
 * verifier 对 `submissions.reference` 只做**结构受理**:六记录项完备性
 * (版本策略 §三:缺项的裁决不可审计,视同无效 → `challenge_invalid`
 * 方向,D-API-87)+ 形态域(64 hex 摘要 / archBits / seed 策略封闭枚举)。
 * 零题目语义解析:私有包 / 公开描述包 / 动作日志的权威校验在引擎侧
 * verify 命令面(与 load 共用同一装配实现)。
 *
 * 秘密零驻留:引用整体 SERVER_ONLY(session-api 服务端面,非玩家通道);
 * 本服务不落任何引用内容到日志(受控日志只含 run 标识与确定性原因标签)。
 */
import { z } from "zod";
import { SEED_STRATEGIES } from "@stackmaster/challenge-schema";

/** 64 位十六进制(SHA-256 摘要形态域;版本策略 §三 #1/#2/#6)。 */
const HEX_64 = /^[0-9a-f]{64}$/;

/** seed 派生路径声明(**不含 seed 值**;版本策略 §三 #5)。 */
const DerivationSchema = z.strictObject({
  algorithmId: z.string().min(1),
  draws: z.number().int().min(0),
});

/**
 * 六记录项上下文(引擎 `ReplayContext` 的导出形态):#1 题目包哈希、
 * #2 VM Profile 哈希、#3 引擎构建 ID、#4 判题规则版本、#5 seed 策略、
 * 加架构位宽与题目 / 版本身份。任一缺项 = 裁决无效(strictObject 即拒)。
 */
export const ReplayContextSchema = z.strictObject({
  challengeId: z.string().min(1).max(128),
  challengeContentVersion: z.string().min(1).max(128),
  vmProfileVersion: z.string().min(1).max(128),
  vmEngineVersion: z.string().min(1).max(128),
  engineBuildId: z.string().min(1).max(128),
  verdictRuleVersion: z.string().min(1).max(128),
  challengeBundleHash: z.string().regex(HEX_64),
  vmProfileHash: z.string().regex(HEX_64),
  archBits: z.union([z.literal(32), z.literal(64)]),
  seedPolicy: z.strictObject({
    strategy: z.enum(SEED_STRATEGIES),
    derivation: DerivationSchema.nullable(),
  }),
});

/** 重放材料(`export_action_log` 引擎响应的随行形态,SERVER_ONLY)。 */
export const ReplayMaterialSchema = z.strictObject({
  replayContext: ReplayContextSchema,
  actionLog: z.string().min(1),
});

/** submit 内部裁决引用(编排器落库形态;`replay` 为 WP-61 必备增补)。 */
export const SubmitReferenceSchema = z.strictObject({
  form: z.literal("stackmaster-session-submit/1"),
  sessionId: z.string().min(1).max(128),
  challenge: z.strictObject({
    challengeId: z.string().min(1).max(128),
    challengeContentVersion: z.string().min(1).max(128),
    vmProfileVersion: z.string().min(1).max(128),
  }),
  engine: z.strictObject({
    vmEngineVersion: z.string().min(1).max(128),
    engineBuildId: z.string().min(1).max(128),
  }),
  seedPolicy: z.strictObject({ strategy: z.string().min(1) }),
  revision: z.number().int().min(0),
  publicStatus: z.string().min(1),
  actionLog: z.array(
    z.strictObject({
      clientSeq: z.number().int().min(0),
      revisionAfter: z.number().int().min(0),
      action: z.unknown(),
    }),
  ),
  replay: ReplayMaterialSchema,
});

export type ReplayContext = z.infer<typeof ReplayContextSchema>;
export type ReplayMaterial = z.infer<typeof ReplayMaterialSchema>;
export type SubmitReference = z.infer<typeof SubmitReferenceSchema>;

/** 引用受理(结构 + 六记录项完备性;失败 = challenge_invalid 方向)。 */
export function parseSubmitReference(value: unknown): SubmitReference | null {
  const parsed = SubmitReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
