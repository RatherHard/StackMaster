/**
 * 双包版本迁移工具(WP-2;阶段一验收评审 §三移交项:7.4 版本演进时的
 * 实例迁移)。
 *
 * 版本面与迁移语义(docs/contracts/版本策略.md §二;双包Schema语义.md §七):
 *  - 信封版本 `schemaVersion`(CHALLENGE_PACKAGE_SCHEMA_VERSION,当前 1):
 *    破坏性变更递增并保留 N-1 兼容窗口;当前没有历史版本,迁移注册表
 *    为空——任何非当前版本的输入 fail-closed 拒绝,不做投机迁移;
 *  - DSL 版本 `dslSchemaVersion`(私有包,当前 2):v1 → v2 是 G4 重定基
 *    (移除教学 IO `read` / `write`,新增 `leave` 与作者声明面)。语义
 *    变更不存在自动等价改写——迁移为**结构性**迁移:登记版本字段并对
 *    被移除 opcode fail-closed(XC-MIGRATE-REMOVED-OPCODE,须作者改写);
 *    其余 v1 形态在 v2 下合法(v2 为增量演进:interface 槽、
 *    customInstructions、interfaces 均为新增可选声明面)。
 *
 * 迁移不改写判题语义、不改写任何内容字段;产物必须再经 `loadChallengePair`
 * 全量校验(测试按 migrate → load 组合消费)。输入不合法(缺版本字段、
 * 非对象)时按 fail-closed 返回违规,方向与其他装载失败一致。
 */

import { CHALLENGE_PACKAGE_SCHEMA_VERSION } from "@stackmaster/challenge-schema";
import { compilerViolation, LOAD_FAILURE_RESULT_DIRECTION, type CompilerViolation } from "../common/diagnostics.js";

/** 单条已登记迁移步骤的描述(审计面;当前注册表为空,信封无历史版本)。 */
export interface RegisteredMigration {
  readonly id: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly target: "envelope" | "dsl";
}

/**
 * 迁移步骤注册表(7.4 N-1 兼容窗口的机检锚点)。
 * 信封当前版本 1 且无历史发布版本 ⇒ 空;递增信封版本时在此登记步骤。
 */
export const REGISTERED_MIGRATIONS: readonly RegisteredMigration[] = [];

/** dslSchemaVersion 的当前冻结值(G4/P3 定基)。 */
export const CURRENT_DSL_SCHEMA_VERSION = 2;

/** v1 → v2 迁移中被移除的基线 opcode(G4:教学 IO 收敛;无自动等价改写)。 */
const REMOVED_V1_OPCODES: readonly string[] = ["read", "write"];

export type MigrationResult =
  | {
      readonly ok: true;
      readonly publicDescriptor: unknown;
      readonly privateBundle: unknown;
      readonly appliedMigrations: readonly string[];
    }
  | {
      readonly ok: false;
      readonly direction: typeof LOAD_FAILURE_RESULT_DIRECTION;
      readonly violations: readonly CompilerViolation[];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** dslSchemaVersion 1 → 2 结构性迁移(G4 重定基)。 */
function migrateDslV1ToV2(bundle: Record<string, unknown>): {
  value: Record<string, unknown>;
  applied: string[];
  violations: CompilerViolation[];
} {
  const violations: CompilerViolation[] = [];
  const compiledIr = bundle.compiledIr;
  if (isPlainObject(compiledIr) && Array.isArray(compiledIr.instructions)) {
    compiledIr.instructions.forEach((instruction, index) => {
      if (
        isPlainObject(instruction) &&
        typeof instruction.op === "string" &&
        REMOVED_V1_OPCODES.includes(instruction.op)
      ) {
        violations.push(compilerViolation(
          "XC-MIGRATE-REMOVED-OPCODE",
          `dslSchemaVersion 2 已移除基线 opcode "${instruction.op}"(G4 教学 IO 收敛):` +
            `指令 ${index} 无自动等价改写,须作者按 v2 词汇改写 ` +
            `(内存读写走 mov R,M / M,R 与会话动作 write_bytes,虚拟文件读取走作者接口)`,
          `/compiledIr/instructions/${index}/op`,
        ));
      }
    });
  }
  if (violations.length > 0) {
    return { value: bundle, applied: [], violations };
  }
  return {
    value: { ...bundle, dslSchemaVersion: CURRENT_DSL_SCHEMA_VERSION },
    applied: ["dsl-schema-1-to-2"],
    violations: [],
  };
}

/**
 * 双包版本迁移:按实例自报版本对齐到当前冻结版本。
 * 版本不可识别或无已登记迁移路径时 fail-closed(不做投机迁移)。
 */
export function migrateChallengePair(input: {
  readonly publicDescriptor: unknown;
  readonly privateBundle: unknown;
}): MigrationResult {
  const violations: CompilerViolation[] = [];
  const applied: string[] = [];

  const publicInput = input.publicDescriptor;
  const privateInput = input.privateBundle;
  if (!isPlainObject(publicInput) || !isPlainObject(privateInput)) {
    return {
      ok: false,
      direction: LOAD_FAILURE_RESULT_DIRECTION,
      violations: [compilerViolation(
        "XC-MIGRATE-VERSION",
        "迁移输入必须是公开描述包与私有判题包两个 JSON 对象",
        "",
      )],
    };
  }

  // 信封版本:当前无历史版本 ⇒ 仅接受当前版本(非当前即无迁移路径)。
  const envelopeVersion = publicInput.schemaVersion;
  if (envelopeVersion !== CHALLENGE_PACKAGE_SCHEMA_VERSION) {
    violations.push(compilerViolation(
      "XC-MIGRATE-VERSION",
      `信封版本 ${String(envelopeVersion)} 无已登记迁移路径(当前 ` +
        `${CHALLENGE_PACKAGE_SCHEMA_VERSION};N-1 兼容窗口步骤登记于 REGISTERED_MIGRATIONS)`,
      "/schemaVersion",
    ));
  }

  // DSL 版本(私有包):2 = 当前;1 = 登记的结构性迁移;其余 fail-closed。
  let privateBundle = privateInput;
  const dslVersion = privateInput.dslSchemaVersion;
  if (dslVersion === CURRENT_DSL_SCHEMA_VERSION) {
    // 已是当前版本。
  } else if (dslVersion === 1) {
    const migrated = migrateDslV1ToV2(privateInput);
    privateBundle = migrated.value;
    applied.push(...migrated.applied);
    violations.push(...migrated.violations);
  } else {
    violations.push(compilerViolation(
      "XC-MIGRATE-VERSION",
      `dslSchemaVersion ${String(dslVersion)} 无已登记迁移路径(当前 ${CURRENT_DSL_SCHEMA_VERSION})`,
      "/dslSchemaVersion",
    ));
  }

  if (violations.length > 0) {
    return { ok: false, direction: LOAD_FAILURE_RESULT_DIRECTION, violations };
  }
  return {
    ok: true,
    publicDescriptor: publicInput,
    privateBundle,
    appliedMigrations: applied,
  };
}
