/**
 * 教学采集面的**静态形态纪律**(单元测试;WP-82;无需容器)。
 *
 * 本文件把下列不可用行为测试承载的面变成机检:
 *  1. 迁移 008 的表结构 / 封闭集 / RLS 政策 / 保留期 / append-only 形态
 *    (与 007 逐条对照面);
 *  2. 采集面**不经 `/metrics` 通道**(零 metrics 依赖)、**不触碰审计账**
 *    (零 audit_log 与审计 kind 字面,零新增审计 kind);
 *  3. 口径字面单源(`success` / `undo` / kind 字面只来自 `kinds.ts`,SQL 内
 *    以绑定参数注入);
 *  4. 零学习者标识面:迁移与模块内均无 `user_id` / `userId` 表达位;
 *  5. 零 HTTP / 契约面:模块不引入路由 / Fastify / zod(不在公开契约新增面)。
 *
 * 说明:模块扫描统一在**去注释后的代码文本**上进行(`codeOnly`)——文档注释
 * 里为解释纪律会引用 `/metrics`、`'undo'`、审计 kind 等字面,若连同注释一起
 * 扫描会产生假阳性;纪律机检的对象是**代码面**。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AUDIT_EVENT_KINDS } from "../../src/auth/ports.js";
import {
  COLLECTIBLE_TEACHING_EVENT_KINDS,
  TEACHING_EVENT_KINDS,
} from "../../src/teaching/index.js";

const MIGRATION_008 = fileURLToPath(
  new URL("../../migrations/008_teaching_events.sql", import.meta.url),
);
const TEACHING_DIR = fileURLToPath(new URL("../../src/teaching/", import.meta.url));

/** 去注释(块注释 + 行注释);扫描纪律只针对代码面。 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** 去注释(SQL 面:`--` 行注释与块注释)。 */
function sqlCodeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

async function migrationSql(): Promise<string> {
  return readFile(MIGRATION_008, "utf8");
}

/** 教学模块源文件(递归;含 pg 子目录)。 */
async function teachingSources(): Promise<{ readonly relative: string; readonly text: string }[]> {
  const names = (await readdir(TEACHING_DIR, { recursive: true })) as string[];
  const files = names.filter((name) => name.endsWith(".ts")).sort();
  return Promise.all(
    files.map(async (relative) => ({
      relative,
      text: await readFile(join(TEACHING_DIR, relative), "utf8"),
    })),
  );
}

/** 建表语句块(列清单断言的扫描域)。 */
function createTableBlock(sql: string): string {
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS teaching_events");
  const end = sql.indexOf(");", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("迁移 008:采集载体重建(与 007 形态对照)", () => {
  it("表存在;列清单零学习者标识(无 user_id / 无原始 session_id)", async () => {
    const block = createTableBlock(await migrationSql());
    expect(block).toMatch(/tenant_id\s+TEXT NOT NULL/);
    expect(block).toMatch(/subject_digest\s+CHAR\(64\) NOT NULL/);
    expect(block).toMatch(/source_ref\s+TEXT NOT NULL/);
    expect(block).toMatch(/event_count\s+INTEGER NOT NULL DEFAULT 1 CHECK \(event_count >= 1\)/);
    expect(block).toMatch(/derivation\s+TEXT NOT NULL/);
    expect(block).not.toContain("user_id");
    expect(block).not.toContain("session_id");
  });

  it("kind 三值封闭集 CHECK;「提示使用」不在集合内(结构性不可写入)", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("teaching_events_kind_closed_set");
    for (const kind of COLLECTIBLE_TEACHING_EVENT_KINDS) {
      expect(sql).toContain(`'${kind}'`);
    }
    const checkBlock = sql.slice(sql.indexOf("teaching_events_kind_closed_set CHECK"));
    expect(checkBlock.slice(0, checkBlock.indexOf(");"))).not.toContain("'hint_used'");
  });

  it("RLS 启用 + FORCE(表属主同受约束;无 BYPASSRLS 旁路)", async () => {
    const code = sqlCodeOnly(await migrationSql());
    expect(code).toContain("ALTER TABLE teaching_events ENABLE ROW LEVEL SECURITY;");
    expect(code).toContain("ALTER TABLE teaching_events FORCE ROW LEVEL SECURITY;");
    expect(code).not.toContain("BYPASSRLS");
  });

  it("租户绑定政策逐字同 007(fail-closed:is_missing 形态)", async () => {
    const sql = await migrationSql();
    expect(sql).toContain(
      "CREATE POLICY teaching_events_tenant_isolation ON teaching_events TO session_app",
    );
    const code = sqlCodeOnly(sql);
    const occurrences = code.split("tenant_id = current_setting('app.tenant_id', true)").length - 1;
    expect(occurrences).toBe(2); // USING + WITH CHECK 双侧
  });

  it("保留期例外 = 两段式第一段(仅 SELECT 放行租户枚举读)", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("teaching_events_retention_tenant_scan");
    expect(sql).toContain("FOR SELECT TO session_app");
    expect(sql).toContain("current_setting('app.retention_purge', true) = 'on'");
    // 零跨租户全放行 / 零 DELETE 政策行(007:窄面 DELETE 例外会连带打开读面)。
    expect(sql).not.toContain("USING (true)");
    expect(sql).not.toContain("FOR DELETE");
  });

  it("append-only:UPDATE / TRUNCATE 触发器在场;DELETE 留给保留期", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("teaching_events_append_only");
    expect(sql).toContain("BEFORE UPDATE ON teaching_events");
    expect(sql).toContain("teaching_events_no_truncate");
    expect(sql).toContain("BEFORE TRUNCATE ON teaching_events");
    expect(sql).not.toContain("BEFORE UPDATE OR DELETE");
  });

  it("幂等锚唯一索引(tenant_id, kind, source_ref)+ 保留期 / 聚合扫描索引", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_teaching_events_source");
    expect(sql).toContain("ON teaching_events (tenant_id, kind, source_ref)");
    expect(sql).toContain("idx_teaching_events_occurred");
    expect(sql).toContain("ON teaching_events (occurred_at)");
    expect(sql).toContain("idx_teaching_events_tenant_challenge");
  });

  it("授权面与本表同批单源:SELECT / INSERT / DELETE + 序列 USAGE", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("GRANT SELECT, INSERT, DELETE ON teaching_events TO session_app;");
    expect(sql).toContain("GRANT USAGE, SELECT ON SEQUENCE teaching_events_id_seq TO session_app;");
    expect(sql).toContain("REVOKE UPDATE, TRUNCATE ON teaching_events FROM PUBLIC;");
  });

  it("幂等可重放形态(IF NOT EXISTS / DROP ... IF EXISTS / 约束存在性检查)", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS teaching_events");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION teaching_events_forbid_mutation");
    expect(sql).toContain("DROP TRIGGER IF EXISTS teaching_events_append_only");
    expect(sql).toContain("DROP POLICY IF EXISTS teaching_events_tenant_isolation");
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teaching_events_kind_closed_set')",
    );
  });

  it("零新增审计 kind:语句面不出现 audit_log,全文不出现任何审计 kind 字面", async () => {
    const sql = await migrationSql();
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toContain("audit_log");
    for (const kind of AUDIT_EVENT_KINDS) {
      expect(sql).not.toContain(`'${kind}'`);
    }
  });
});

describe("教学模块静态纪律(不经 /metrics、不触审计、字面单源、零标识、零 HTTP)", () => {
  it("零 metrics 依赖:教学事件不经 /metrics 通道(登记表只引用族名,不依赖指标面)", async () => {
    for (const { relative, text } of await teachingSources()) {
      const code = codeOnly(text);
      expect(code, relative).not.toContain("prom-client");
      // 零 metrics 模块依赖(导入面)+ 零指标文本机检调用 + 零指标插件装配。
      expect(code, relative).not.toMatch(/from "[^"]*metrics[^"]*"/);
      expect(code, relative).not.toContain("assertMetricsTextDiscipline");
      expect(code, relative).not.toContain("metricsPlugin");
      expect(code, relative).not.toContain("MetricsRegistry");
    }
  });

  it("零审计面触碰:不 import 审计端口、不出现审计 kind 字面", async () => {
    for (const { relative, text } of await teachingSources()) {
      const code = codeOnly(text);
      expect(code, relative).not.toContain("audit_log");
      expect(code, relative).not.toContain("AuditSink");
      for (const kind of AUDIT_EVENT_KINDS) {
        expect(code, relative).not.toContain(`"${kind}"`);
      }
    }
  });

  it("零 HTTP / 契约面:不引入路由 / Fastify / zod(不在公开契约新增面)", async () => {
    for (const { relative, text } of await teachingSources()) {
      const code = codeOnly(text);
      expect(code, relative).not.toContain("fastify");
      expect(code, relative).not.toContain("routes/");
      expect(code, relative).not.toContain("zod");
    }
  });

  it("零学习者标识表达位:代码面不出现 user_id / userId / userID", async () => {
    for (const { relative, text } of await teachingSources()) {
      const code = codeOnly(text);
      expect(code, relative).not.toContain("user_id");
      expect(code, relative).not.toContain("userId");
      expect(code, relative).not.toContain("userID");
    }
  });

  it("口径字面单源:PG 适配器以绑定参数注入,SQL 内无 success / undo / kind 字面", async () => {
    const pgFiles = (await teachingSources()).filter((source) =>
      /^pg[\\/]/.test(source.relative),
    );
    expect(pgFiles).toHaveLength(2);
    for (const { relative, text } of pgFiles) {
      const code = codeOnly(text);
      expect(code, relative).not.toContain("'success'");
      expect(code, relative).not.toContain('"success"');
      expect(code, relative).not.toContain("'undo'");
      expect(code, relative).not.toContain('"undo"');
      for (const kind of TEACHING_EVENT_KINDS) {
        expect(code, relative).not.toContain(`'${kind}'`);
      }
    }
  });

  it("「提示使用」零采集路径:kinds 登记表之外的模块不含 hint_used", async () => {
    for (const { relative, text } of await teachingSources()) {
      if (relative.startsWith("kinds")) {
        continue; // 可得性登记成文处(kinds.ts)
      }
      expect(codeOnly(text), relative).not.toContain("hint_used");
    }
  });

  it("非 PG 层零直接 SQL:数据访问只经端口实现(pg 子目录)", async () => {
    for (const { relative, text } of await teachingSources()) {
      if (/^pg[\\/]/.test(relative)) {
        continue;
      }
      expect(codeOnly(text), relative).not.toMatch(/\b(SELECT|INSERT INTO|DELETE FROM|UPDATE)\b/);
    }
  });
});
