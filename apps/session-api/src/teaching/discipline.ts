/**
 * 教学采集面纪律机检(WP-82;D-API-151)。
 *
 * 与 `/metrics` 面的 `assertMetricsTextDiscipline`(D-API-71)**同款纪律、
 * 独立实现**:教学事件**不经 `/metrics` 通道**(定案原文),但它同样是
 * 「标签 / 输出零秘密零标识符」面,故其输出需要一台等价的白名单机检。
 * 检查对象 = `renderTeachingAggregateReport` 的规范化渲染(或任何同形对象):
 *
 *  1. `malformed-aggregate-report`:顶层形态非法(非 `{aggregates: [...]}`);
 *  2. `unknown-aggregate-field`:聚合行出现冻结九键之外的字段(越面即违例,
 *     不静默忽略 —— I-1「未知字段即违规」在教学聚合面的同构);
 *  3. `missing-aggregate-field`:缺冻结字段(键恒在,不用"缺席"表达终态);
 *  4. `non-scalar-aggregate-value`:字段值非标量(对象 / 数组)——**行级载荷
 *     走私的结构性阻断**(采集行在这里没有表达位);
 *  5. `out-of-domain-value`:数值域违规(负数 / 非整数 / 非有限 / 完成率越界 /
 *     计数不自洽:`passed > started`、`firstPassSamples > passed`);
 *  6. `unbounded-enum-value`:题目标识 / 版本不落有界字符集(有界枚举纪律);
 *  7. `identifier-shaped-value`:输出含服务端签发标识符形态值(`sess-…` 等)、
 *     UUID 形态或 SHA-256 摘要形态(学习者关联面泄露);
 *  8. `secret-corpus-hit`:ZR-B1 / B6 秘密语料命中(`scanSecretCorpus`)。
 *
 * **扫描器自检纪律**(数据分类清单 §九):每条规则在本文件对应红灯反例
 * (见 `test/teaching/discipline.test.ts`),证明扫描器在真实违规样例上触发。
 */

import { scanSecretCorpus } from "../persistence/secret-scanner.js";
import { TEACHING_AGGREGATE_FIELDS } from "./aggregate.js";

export interface TeachingDisciplineViolation {
  readonly id:
    | "malformed-aggregate-report"
    | "unknown-aggregate-field"
    | "missing-aggregate-field"
    | "non-scalar-aggregate-value"
    | "out-of-domain-value"
    | "unbounded-enum-value"
    | "identifier-shaped-value"
    | "secret-corpus-hit";
  readonly detail: string;
}

/** 服务端签发标识符形态(与 `metrics.ts` 的 `IDENTIFIER_VALUE_PATTERN` 同源同义,D-API-71)。 */
const IDENTIFIER_VALUE_PATTERN = /\b(sess|req|cp|sub)-[A-Za-z0-9_-]{8,}\b/;

/** UUID 形态(`verdicts.id` / `submissions.id` 等服务端主键;出现即泄露)。 */
const UUID_VALUE_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

/** SHA-256 hex 形态(`subject_digest` / 摘要锚;出现即逐会话关联面泄露)。 */
const DIGEST_VALUE_PATTERN = /\b[0-9a-f]{64}\b/;

/** 题目标识有界字符集(与公开描述包 challengeId 形态一致)。 */
const CHALLENGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 题目版本有界图案(语义化三段;与 `CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE` 同义)。 */
const CHALLENGE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** 非负整数字段(计数面)。 */
const COUNT_FIELDS = [
  "startedSessions",
  "passedSessions",
  "undoneActions",
  "firstPassSamples",
] as const;

/** 可空非负整数字段(分位面;无样本 ⇒ null,不伪造 0)。 */
const NULLABLE_SECOND_FIELDS = ["firstPassSecondsP50", "firstPassSecondsP95"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 教学聚合输出机检(返回违例列表;空 = 合法)。
 * 输入类型是 `unknown`:检查器必须能在**未经类型收窄**的载荷上工作
 * (否则"越面字段"在编译期就被类型系统挡掉,机检失去意义)。
 */
export function assertTeachingAggregateDiscipline(report: unknown): TeachingDisciplineViolation[] {
  const violations: TeachingDisciplineViolation[] = [];
  const frozen = new Set<string>(TEACHING_AGGREGATE_FIELDS);

  if (!isPlainObject(report)) {
    violations.push({
      id: "malformed-aggregate-report",
      detail: "顶层形态非法:期望 { aggregates: [...] }",
    });
    return violations;
  }
  const aggregates = report["aggregates"];
  if (!Array.isArray(aggregates)) {
    violations.push({
      id: "malformed-aggregate-report",
      detail: "顶层形态非法:期望 { aggregates: [...] }",
    });
    return violations;
  }
  const rows: unknown[] = aggregates;
  // 顶层键面:除 aggregates 之外的键即越面(未知字段即违规,I-1 同构)。
  for (const key of Object.keys(report)) {
    if (key !== "aggregates") {
      violations.push({ id: "unknown-aggregate-field", detail: `顶层出现冻结面外字段 ${key}` });
    }
  }

  for (const row of rows) {
    if (!isPlainObject(row)) {
      violations.push({ id: "non-scalar-aggregate-value", detail: "聚合行非对象形态" });
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!frozen.has(key)) {
        violations.push({ id: "unknown-aggregate-field", detail: `聚合行出现冻结面外字段 ${key}` });
      }
    }
    for (const field of TEACHING_AGGREGATE_FIELDS) {
      if (!(field in row)) {
        violations.push({ id: "missing-aggregate-field", detail: `聚合行缺冻结字段 ${field}` });
      }
    }

    // ① 标量纪律:任何对象 / 数组值即违例(行级载荷无表达位)。
    for (const [key, value] of Object.entries(row)) {
      if (isPlainObject(value) || Array.isArray(value)) {
        violations.push({
          id: "non-scalar-aggregate-value",
          detail: `字段 ${key} 非标量(聚合面只承载数值与有界枚举)`,
        });
      }
    }

    // ② 有界枚举:题目标识 / 版本图案。
    const challengeId = row["challengeId"];
    if (typeof challengeId !== "string" || !CHALLENGE_ID_PATTERN.test(challengeId)) {
      violations.push({
        id: "unbounded-enum-value",
        detail: `challengeId 不落有界字符集:${typeof challengeId === "string" ? challengeId : typeof challengeId}`,
      });
    }
    const challengeVersion = row["challengeVersion"];
    if (typeof challengeVersion !== "string" || !CHALLENGE_VERSION_PATTERN.test(challengeVersion)) {
      violations.push({
        id: "unbounded-enum-value",
        detail: `challengeVersion 不落语义化版本图案:${
          typeof challengeVersion === "string" ? challengeVersion : typeof challengeVersion
        }`,
      });
    }

    // ③ 数值域 + 计数自洽(聚合面内部一致性也是纪律面:不可能的聚合 = 违规)。
    for (const field of COUNT_FIELDS) {
      if (!isCount(row[field])) {
        violations.push({
          id: "out-of-domain-value",
          detail: `字段 ${field} 非非负整数:${
            typeof row[field] === "number" ? String(row[field]) : typeof row[field]
          }`,
        });
      }
    }
    for (const field of NULLABLE_SECOND_FIELDS) {
      const value = row[field];
      if (value !== null && !isCount(value)) {
        violations.push({
          id: "out-of-domain-value",
          detail: `字段 ${field} 非 null 或非负整数:${
            typeof value === "number" ? String(value) : typeof value
          }`,
        });
      }
    }
    const completionRatio = row["completionRatio"];
    if (
      completionRatio !== null &&
      (typeof completionRatio !== "number" ||
        !Number.isFinite(completionRatio) ||
        completionRatio < 0 ||
        completionRatio > 1)
    ) {
      violations.push({
        id: "out-of-domain-value",
        detail: `completionRatio 越界(期望 null 或 [0,1]):${
          typeof completionRatio === "number" ? String(completionRatio) : typeof completionRatio
        }`,
      });
    }
    const started = row["startedSessions"];
    const passed = row["passedSessions"];
    const samples = row["firstPassSamples"];
    if (isCount(started) && isCount(passed) && passed > started) {
      violations.push({
        id: "out-of-domain-value",
        detail: `计数不自洽:passedSessions(${passed}) > startedSessions(${started})`,
      });
    }
    if (isCount(passed) && isCount(samples) && samples > passed) {
      violations.push({
        id: "out-of-domain-value",
        detail: `计数不自洽:firstPassSamples(${samples}) > passedSessions(${passed})`,
      });
    }
  }

  // ④ 标识符形态 / 秘密语料:对规范化文本扫描(与 /metrics 面同一武器)。
  const text = JSON.stringify(report);
  const identifierMatch = IDENTIFIER_VALUE_PATTERN.exec(text);
  if (identifierMatch !== null) {
    violations.push({
      id: "identifier-shaped-value",
      detail: `输出含服务端签发标识符形态值:${identifierMatch[0].slice(0, 12)}…`,
    });
  }
  const uuidMatch = UUID_VALUE_PATTERN.exec(text);
  if (uuidMatch !== null) {
    violations.push({
      id: "identifier-shaped-value",
      detail: `输出含 UUID 形态值:${uuidMatch[0].slice(0, 12)}…`,
    });
  }
  const digestMatch = DIGEST_VALUE_PATTERN.exec(text);
  if (digestMatch !== null) {
    violations.push({
      id: "identifier-shaped-value",
      detail: `输出含 SHA-256 摘要形态值(逐会话关联面):${digestMatch[0].slice(0, 12)}…`,
    });
  }
  for (const hit of scanSecretCorpus(text)) {
    violations.push({ id: "secret-corpus-hit", detail: `秘密语料命中 ${hit.id}` });
  }

  return violations;
}
