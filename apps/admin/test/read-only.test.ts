/**
 * 只读面零写测试(D-MP-5 分支 A;WP-79 第 6 条「只读面零写」)。
 *
 * **证明方式(三重,彼此独立)**:
 *  1. **端口面(运行时结构性)**:`AdminReadStore` 的两个实现实例,其原型
 *     自有属性集合精确等于只读方法集合(`constructor` + 读方法 + 内存夹具的
 *     `seed*`)。写方法不在类型上、也不在运行时面——不是"没有被调用",是
 *     "不存在"。服务级用例另断言三条路由三查之后的调用轨迹只含读方法名。
 *  2. **语句面(本文件)**:`assertReadOnlySql` 对每类写 / DDL / 授权语句
 *     真实红灯(逐条反例);且**管理面源码文本**(剥注释后)不出现任何
 *     写语句形态(INSERT INTO / UPDATE … SET / DELETE FROM / ALTER TABLE /
 *     CREATE TABLE / DROP … / GRANT … ON / TRUNCATE / COPY … FROM)。
 *  3. **授权面(容器门控)**:`test/compose-topology.test.ts` 以 `admin_ro`
 *     角色直连 PG 断言五个只读表 SELECT 授权在场、INSERT / UPDATE / DELETE
 *     授权**全假**,`audit_log` 写面零授权,且 RLS 启用 + 强制 + 政策在场。
 *
 * 三重各自独立:任一层失效,另两层仍把写面折叠为"不可达"。
 */
import { describe, expect, it } from "vitest";

import { MemoryAdminReadStore } from "../src/persistence/memory-read-store.js";
import { PostgresAdminReadStore } from "../src/persistence/pg-read-store.js";
import { ReadOnlyViolationError, assertReadOnlySql } from "../src/persistence/read-only-guard.js";
import { findInAdminCode } from "./helpers/source-scan.js";

const READ_ONLY_STATEMENTS = [
  "SELECT 1",
  "select v.id from verdicts v where v.tenant_id = $1",
  "WITH page AS (SELECT 1) SELECT * FROM page",
  "  SELECT\n    c.challenge_id\n  FROM challenges c",
];

const WRITE_STATEMENTS = [
  "INSERT INTO verdicts (id) VALUES ('x')",
  "UPDATE verdicts SET verdict = 'success'",
  "DELETE FROM verdicts WHERE tenant_id = $1",
  "TRUNCATE TABLE verdicts",
  "ALTER TABLE verdicts DISABLE ROW LEVEL SECURITY",
  "CREATE TABLE admin_notes (id int)",
  "DROP TABLE verdicts",
  "GRANT SELECT ON verdicts TO admin_ro",
  "REVOKE SELECT ON verdicts FROM admin_ro",
  "COPY verdicts TO '/tmp/dump.csv'",
  "DO $$ BEGIN NULL; END $$",
  "VACUUM FULL verdicts",
  "SET ROLE session_app",
  "SELECT 1; DELETE FROM verdicts",
  "",
];

describe("assertReadOnlySql(语句护栏)", () => {
  it("只读语句放行,且返回的归一化语句就是被执行的那一份(无 TOCTOU)", () => {
    for (const sql of READ_ONLY_STATEMENTS) {
      const guarded = assertReadOnlySql(sql);
      expect(guarded.length).toBeGreaterThan(0);
      expect(guarded).not.toMatch(/\n/);
    }
    expect(assertReadOnlySql("SELECT  1   -- comment\n")).toBe("SELECT 1");
  });

  it("写 / DDL / 授权 / 会话态语句逐条红灯", () => {
    for (const sql of WRITE_STATEMENTS) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(ReadOnlyViolationError);
    }
  });

  it("整词匹配不误伤含关键子串的列名(updated_at / created_at / signer_key_id)", () => {
    expect(() =>
      assertReadOnlySql(
        "SELECT v.id, v.created_at, c.updated_at, c.signer_key_id FROM challenges c JOIN verdicts v ON true",
      ),
    ).not.toThrow();
  });

  it("PG 只读适配器的每条语句都经过护栏(源码机检:无未过闸的语句)", async () => {
    // 允许的未过护栏语句 = 事务控制与连接探针(不含任何数据语句):
    //   BEGIN / COMMIT / ROLLBACK / SELECT set_config(...) / SELECT 1
    // 其余任何 client.query / pool.query 都必须以**护栏返回值**为语句。
    const allowed =
      /(client\.query\(\s*"(BEGIN|COMMIT|ROLLBACK)"\s*\))|(client\.query\(\s*`SELECT set_config)|(client\.query<Row>\(\s*guarded)|((client|pool)\.query\(\s*"SELECT 1"\s*\))/;
    const hits = await findInAdminCode(/client\.query|pool\.query/);
    expect(hits.length).toBeGreaterThan(0);
    const unguarded = hits.filter((hit) => !allowed.test(hit.text));
    expect(
      unguarded.map((hit) => `${hit.path}:${hit.line} ${hit.text}`),
    ).toEqual([]);
    const guardUse = await findInAdminCode(/assertReadOnlySql\(/);
    expect(guardUse.length).toBeGreaterThan(0);
  });
});

describe("只读面零写(端口面 + 源码面)", () => {
  it("内存实现的原型面精确等于只读面 + 测试夹具", () => {
    expect(Object.getOwnPropertyNames(MemoryAdminReadStore.prototype).sort()).toEqual([
      "constructor",
      "listChallenges",
      "queryVerdicts",
      "readScoresPage",
      "seedChallenge",
      "seedSubmission",
    ]);
  });

  it("PG 实现的原型面精确等于只读面 + 探针(零写方法)", () => {
    expect(Object.getOwnPropertyNames(PostgresAdminReadStore.prototype).sort()).toEqual([
      "constructor",
      "listChallenges",
      "ping",
      "queryVerdicts",
      "readScoresPage",
    ]);
  });

  it("管理面源码不出现任何写语句形态(剥注释后的代码文本)", async () => {
    const patterns: readonly (readonly [string, RegExp])[] = [
      ["INSERT INTO", /\bINSERT\s+INTO\b/i],
      ["UPDATE … SET", /\bUPDATE\s+[A-Za-z_][A-Za-z0-9_."]*\s+SET\b/i],
      ["DELETE FROM", /\bDELETE\s+FROM\b/i],
      ["TRUNCATE", /\bTRUNCATE\s+(TABLE\s+)?[A-Za-z_]/i],
      ["ALTER TABLE", /\bALTER\s+TABLE\b/i],
      ["CREATE TABLE/ROLE/INDEX/POLICY", /\bCREATE\s+(TABLE|ROLE|INDEX|POLICY|SCHEMA)\b/i],
      ["DROP TABLE/ROLE/POLICY", /\bDROP\s+(TABLE|ROLE|POLICY|INDEX|SCHEMA)\b/i],
      ["GRANT … ON", /\bGRANT\s+[A-Za-z_]+\s+ON\b/i],
      ["REVOKE … ON", /\bREVOKE\s+[A-Za-z_]+\s+ON\b/i],
      ["COPY … FROM/TO", /\bCOPY\s+[A-Za-z_][A-Za-z0-9_]*\s*(\(|FROM|TO)\b/i],
      ["audit_log 写入", /\bINSERT\s+INTO\s+audit_log\b/i],
    ];
    for (const [label, pattern] of patterns) {
      const hits = await findInAdminCode(pattern);
      expect(hits, `${label} 命中:${hits.map((hit) => `${hit.path}:${hit.line}`).join(", ")}`).toEqual(
        [],
      );
    }
  });
});
