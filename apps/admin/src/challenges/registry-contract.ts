/**
 * 管理面「题目登记列表」的**公开契约校验**(契约复用,WP-79 / D-API-135)。
 *
 * ── 为什么管理面依赖 `@stackmaster/challenge-schema` ────────────────────
 * 管理面展示的题目登记列表是**公开登记值**(题目标识 / 标题 / 版本链摘要)。
 * 这些值的形态由**公开包契约**冻结:`challenges.challenge_id` 与
 * `challenge_versions.content_version` / `vm_profile_version` 的合法形态 =
 * 公开题目包 JSON Schema 的 `pattern`。本模块直接复用该契约的**模式源字符串**
 * (`CHALLENGE_ID_PATTERN_SOURCE` / `SEMVER_PATTERN_SOURCE`),**零副本**:
 * 契约若演进,管理面的校验随之演进(不存在"管理面自己一套题目标识规则")。
 *
 * 这正是 admin 进入 `challenge-schema-dependents-restricted` 白名单的**事实依据**
 * (dependency-cruiser 规则与 `tools/dependency-boundary-self-test.mjs` 同批演进):
 * 管理面与 verifier 同款——按公开包 Schema 的语义消费题目登记元数据。
 *
 * ── 校验落点与失败形态 ────────────────────────────────────────────────
 * 校验发生在**读面出口之前**(路由层,唯一 choke point)而非库内:库是权威
 * 事实源,读数与公开契约不符意味着**数据面漂移**(历史直写 / 迁移缺口 /
 * 归因错误),此时**不得**把不符契约的登记值原样下发给运维——运维面看到
 * 一个越界题目标识会据此做错决策(例如照抄进配置)。故失败形态 =
 * `AdminRegistryContractViolationError`(继承 `AdminStoreError` ⇒ 走既有
 * **503 存储不可用**冻结路径,零数据下发)。
 *
 * 与成绩导出的"逐字过 `HostScoresResponseSchema.parse`"是**同一纪律的两种
 * 表达**:出口要么是契约形态,要么是冻结错误,**没有第三种**(不下发"大致
 * 正确"的数据)。
 */
import {
  CHALLENGE_ID_PATTERN_SOURCE,
  SEMVER_PATTERN_SOURCE,
} from "@stackmaster/challenge-schema";

import { AdminStoreError, type ChallengeRegistryEntry } from "../persistence/ports.js";

/** 题目标识模式(公开包契约模式源,逐字复用)。 */
export const ADMIN_CHALLENGE_ID_PATTERN_SOURCE = CHALLENGE_ID_PATTERN_SOURCE;
/** 内容版本 / VM Profile 版本模式(公开包契约模式源,逐字复用)。 */
export const ADMIN_CONTENT_VERSION_PATTERN_SOURCE = SEMVER_PATTERN_SOURCE;

// 契约模式源自带 ^ $ 锚(与 JSON Schema `pattern` 同一份字符串)。
const CHALLENGE_ID_PATTERN = new RegExp(CHALLENGE_ID_PATTERN_SOURCE);
const CONTENT_VERSION_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE);

/** 题目登记值越过公开包契约(⇒ 数据面漂移,读面 fail-closed)。 */
export class AdminRegistryContractViolationError extends AdminStoreError {
  constructor(readonly detail: string) {
    super(`题目登记值不符合公开包契约:${detail}`);
    this.name = "AdminRegistryContractViolationError";
  }
}

/**
 * 逐条校验登记条目(题目标识 + 版本链的每个版本)。
 * 抛出即表示"这一批数据不能以公开契约形态下发"。
 * `detail` 只含**字段名与位置**(不回显越界值本身——越界值可能含控制字符 /
 * 超长内容,回显到日志与错误链是自伤的注入面)。
 */
export function assertPublicRegistryEntries(
  entries: readonly ChallengeRegistryEntry[],
): void {
  for (const [index, entry] of entries.entries()) {
    if (!CHALLENGE_ID_PATTERN.test(entry.challengeId)) {
      throw new AdminRegistryContractViolationError(`entries[${index}].challengeId`);
    }
    for (const [versionIndex, version] of entry.versions.entries()) {
      if (!CONTENT_VERSION_PATTERN.test(version.contentVersion)) {
        throw new AdminRegistryContractViolationError(
          `entries[${index}].versions[${versionIndex}].contentVersion`,
        );
      }
      if (!CONTENT_VERSION_PATTERN.test(version.vmProfileVersion)) {
        throw new AdminRegistryContractViolationError(
          `entries[${index}].versions[${versionIndex}].vmProfileVersion`,
        );
      }
    }
  }
}
