/**
 * 管理面只读端口(D-MP-5 分支 A;D-API-135)。
 *
 * ── 为什么是"直连 PG 只读角色"而不是 import session-api ────────────────
 * 复用服务的方式 = **契约复用**,不是代码 import:
 *  - 契约复用:`HostScoresResponseSchema`(WP-78)/ `VerdictQueryResponseSchema`
 *    (D-API-83)/ `PublicErrorSchema`(D-API-14)全部来自 `@stackmaster/protocol`
 *    单一来源,管理面**不写第二套契约**;
 *  - 数据面:本包自有连接层(自建 `TenantScope` + 只读语句护栏)+ 库层最小
 *    授权角色 `admin_ro`。app→app 依赖会把信任域 4 与信任域 2 的构建图耦合,
 *    使"独立部署"退化为"同一次构建、同一个发布单元",与 verifier 先例
 *    (零查询面独立进程)相悖。
 *
 * ── 端口面即零写面 ────────────────────────────────────────────────────
 * 本接口**只有读取方法**:没有 create / update / delete / append 的任何
 * 表达位。管理面零写不是"实现约定",而是类型面事实(写方法不存在);
 * 加之语句护栏与库层最小授权构成的三重保证,见 `read-only-guard.ts`。
 *
 * ── 字段面 = 公开面上限 ───────────────────────────────────────────────
 * 所有字段都取自公开登记值 / 公开裁决面:`verdicts.detail`、
 * `submissions.reference`(完整动作日志与原始引用)在本端口**无读取位**
 * (SQL 结构性不选该列,SERVER_ONLY 面零下发)。
 */
import type { VerdictResult } from "@stackmaster/protocol";

/** 题目版本摘要(公开登记值:内容版本 / VM Profile 版本 / 登记时刻)。 */
export interface ChallengeVersionSummary {
  readonly contentVersion: string;
  readonly vmProfileVersion: string;
  /** 登记时刻(Unix epoch 秒,UTC;与裁决 / 成绩面同口径)。 */
  readonly registeredAtEpochSeconds: number;
}

/** 题目登记条目(`challenges` + `challenge_versions` 语义)。 */
export interface ChallengeRegistryEntry {
  readonly challengeId: string;
  /** 题目标题(注册表读面 = 全局公开登记值,D-API-76 同源)。 */
  readonly title: string | null;
  readonly versions: readonly ChallengeVersionSummary[];
}

/** 裁决查询过滤(租户必填;由凭证据点派生,绝不来自请求体)。 */
export interface VerdictPageQuery {
  readonly tenantId: string;
  /** 精确提交定位(可与题目 / 时间窗组合;缺省 = 全租户窗口)。 */
  readonly submissionId?: string;
  /** 题目过滤(经 sessions 关联;公开定位符 D-API-76 同源)。 */
  readonly challengeId?: string;
  /** 起始时刻闭区间(Unix epoch 秒)。 */
  readonly sinceEpochSeconds?: number;
  /** 结束时刻闭区间(Unix epoch 秒)。 */
  readonly untilEpochSeconds?: number;
  /** 单页上限(调用方传天花板内值;命中上限即 `truncated = true`)。 */
  readonly limit: number;
}

/** 裁决行(载荷面 = `VerdictQueryResponseSchema` 的五字段上限面)。 */
export interface VerdictPageRow {
  readonly submissionId: string;
  readonly revision: number;
  readonly status: "pending" | "verdicted";
  /** 未决 = null(不落库即未决;绝不以兜底值伪造裁决)。 */
  readonly verdict: VerdictResult | null;
  /** 未决 = null(裁决落库时刻,Unix epoch 秒)。 */
  readonly decidedAtEpochSeconds: number | null;
}

/** 成绩分页查询(仅已裁决行;keyset 游标 = `verdicts.id`)。 */
export interface ScoresPageQuery {
  readonly tenantId: string;
  /** 上一页末行 `id`(`id > afterId` 升序 keyset;D-API-123 口径)。 */
  readonly afterId?: string;
  /** 单页上限(存储层返回至多 `limit` 行)。 */
  readonly limit: number;
}

/**
 * 单条成绩原始行(装配后即 `HostScoreRecordSchema` 的七字段;
 * 装配 + `parse` 是唯一的出口,见 `scores/export.ts`)。
 */
export interface ScoresPageRow {
  readonly id: string;
  readonly submissionId: string;
  readonly sessionId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly verdict: VerdictResult;
  readonly decidedAtEpochSeconds: number;
}

/** 管理面只读存储端口(三个只读面各一方法;零写方法)。 */
export interface AdminReadStore {
  /** 实现标识(受控日志 / 指标用;不含任何数据面内容)。 */
  readonly implementation: "postgres" | "memory";
  /** 题目登记列表(租户作用域;按 challengeId 升序)。 */
  listChallenges(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<readonly ChallengeRegistryEntry[]>;
  /** 裁决查询(租户作用域;时间窗有界;返回至多 `limit` 行)。 */
  queryVerdicts(input: VerdictPageQuery): Promise<readonly VerdictPageRow[]>;
  /** 成绩页(租户作用域;返回至多 `limit` 行;调用方多取一行探测游标)。 */
  readScoresPage(input: ScoresPageQuery): Promise<readonly ScoresPageRow[]>;
}

/** 存储不可用(确定性错误码;细节只进受控日志,fail-closed 不静默放行)。 */
export class AdminStoreError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
    this.name = "AdminStoreError";
  }
}
