// 双包版本迁移工具测试(WP-2;阶段一移交项:dslSchemaVersion / 信封版本演进)。
import { describe, expect, it } from "vitest";

import { CHALLENGE_PACKAGE_SCHEMA_VERSION } from "@stackmaster/challenge-schema";
import {
  CURRENT_DSL_SCHEMA_VERSION,
  migrateChallengePair,
  loadChallengePair,
} from "../src/index.js";
import { buildIrPair, violationRuleIds, type PairEdit } from "./helpers/private-bundle.js";

describe("migrateChallengePair:结构性迁移", () => {
  it("dslSchemaVersion 1 → 2:合法 v1 实例迁移后可装载(组合纪律)", () => {
    const base = buildIrPair();
    const migrated = migrateChallengePair({
      publicDescriptor: base.publicDescriptor,
      privateBundle: base.privateBundle,
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) {
      return;
    }
    // v1 实例构造:版本字段回退为 1(其余形态在 v2 下仍合法——v2 为增量演进)。
    const v1Bundle = migrated.privateBundle as Record<string, unknown>;
    v1Bundle["dslSchemaVersion"] = 1;
    const result = migrateChallengePair({
      publicDescriptor: migrated.publicDescriptor,
      privateBundle: v1Bundle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.appliedMigrations).toEqual(["dsl-schema-1-to-2"]);
    expect((result.privateBundle as Record<string, unknown>)["dslSchemaVersion"]).toBe(
      CURRENT_DSL_SCHEMA_VERSION,
    );
    // 迁移产物过装载管线(migrate → load 组合)。
    const loaded = loadChallengePair(result);
    expect(loaded.ok).toBe(true);
  });

  it("dslSchemaVersion 1 → 2:含被移除 opcode 的实例 fail-closed", () => {
    const editPrivate: PairEdit = (privateClone) => {
      privateClone["dslSchemaVersion"] = 1;
      const ir = privateClone["compiledIr"] as { instructions: unknown[] };
      ir.instructions = [
        { op: "read", operands: [{ kind: "register", name: "RAX" }] },
        { op: "ret", operands: [] },
      ];
    };
    const pair = buildIrPair({ mutate: (p) => editPrivate(p.privateBundle as unknown as Record<string, unknown>) });
    const result = migrateChallengePair(pair);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-MIGRATE-REMOVED-OPCODE");
      const violation = result.violations.find(
        (item) => item.ruleId === "XC-MIGRATE-REMOVED-OPCODE",
      );
      expect(violation?.message).toContain("read");
    }
  });

  it("write 指令同样 fail-closed(G4 教学 IO 收敛)", () => {
    const base = buildIrPair({
      mutate: (pair) => {
        const privateClone = pair.privateBundle as unknown as Record<string, unknown>;
        privateClone["dslSchemaVersion"] = 1;
        const ir = privateClone["compiledIr"] as { instructions: unknown[] };
        ir.instructions = [
          { op: "write", operands: [{ kind: "register", name: "RAX" }] },
          { op: "ret", operands: [] },
        ];
      },
    });
    const result = migrateChallengePair(base);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-MIGRATE-REMOVED-OPCODE");
    }
  });

  it("未知 dslSchemaVersion 无迁移路径(不做投机迁移)", () => {
    const pair = buildIrPair({
      mutate: (pair) => {
        (pair.privateBundle as unknown as Record<string, unknown>)["dslSchemaVersion"] = 3;
      },
    });
    const result = migrateChallengePair(pair);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-MIGRATE-VERSION");
    }
  });

  it("信封版本非当前值即拒(当前无历史版本,注册表为空)", () => {
    const pair = buildIrPair();
    const result = migrateChallengePair({
      publicDescriptor: {
        ...(pair.publicDescriptor as Record<string, unknown>),
        schemaVersion: CHALLENGE_PACKAGE_SCHEMA_VERSION + 1,
      },
      privateBundle: pair.privateBundle,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-MIGRATE-VERSION");
    }
  });

  it("当前版本双包零迁移直通(applied 为空)", () => {
    const pair = buildIrPair();
    const result = migrateChallengePair(pair);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.appliedMigrations).toEqual([]);
    }
  });

  it("非对象输入 fail-closed", () => {
    const result = migrateChallengePair({
      publicDescriptor: "not-an-object",
      privateBundle: buildIrPair().privateBundle,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(violationRuleIds(result)).toContain("XC-MIGRATE-VERSION");
    }
  });

  it("迁移不突变输入对象(浅拷贝语义)", () => {
    const pair = buildIrPair({
      mutate: (pair) => {
        (pair.privateBundle as unknown as Record<string, unknown>)["dslSchemaVersion"] = 1;
      },
    });
    const before = (pair.privateBundle as unknown as Record<string, unknown>)["dslSchemaVersion"];
    const result = migrateChallengePair(pair);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.privateBundle as Record<string, unknown>)["dslSchemaVersion"]).toBe(2);
      expect((pair.privateBundle as unknown as Record<string, unknown>)["dslSchemaVersion"]).toBe(before);
    }
  });
});
