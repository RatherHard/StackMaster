/**
 * TenantScope 单元测试(WP-65,D-API-101;连接层租户上下文注入形态)。
 *
 * 形态契约(零 IO;fake Pool 承载):
 *  - 租户作用域查询 = 显式事务(BEGIN → set_config('app.tenant_id', tenant,
 *    is_local=true) → 语句 → COMMIT),注入先于数据语句(行级政策谓词读取
 *    时机保证);SET LOCAL 语义 = 事务内生效,COMMIT 后连接零租户态残留
 *    (连接复用 fail-closed:下一借用者不见前任租户);
 *  - 多语句事务面(D-API-85 入队同锚形态):run 回调持同一 client,异常 =
 *    ROLLBACK + 原样上抛(存储层稳定语义翻译在其外层);
 *  - 生命周期作用域 = 专用 GUC(app.boot_recovery / app.retention_purge /
 *    app.audit_archive)以 'on' 注入,app.tenant_id 保持缺失(进程生命周期
 *    操作非租户作用域数据访问,D-API-63 定性);
 *  - client 恒释放(finally);注入常量字面冻结(D-API-101 GUC 命名)。
 */

import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import {
  AUDIT_ARCHIVE_GUC,
  BOOT_RECOVERY_GUC,
  RETENTION_PURGE_GUC,
  TENANT_CONTEXT_GUC,
  TenantScope,
} from "../../src/persistence/pg/connection.js";
import type { LifecycleGuc } from "../../src/persistence/pg/connection.js";

interface RecordedCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeClient {
  readonly calls: RecordedCall[];
  released: boolean;
  failOn?: string;
}

function makeFakePool(options: { failOn?: string } = {}): {
  pool: Pool;
  client: FakeClient;
} {
  const client: FakeClient = { calls: [], released: false, failOn: options.failOn };
  const fakeClient = {
    query: async (text: string, values?: unknown[]): Promise<QueryResult> => {
      if (client.failOn !== undefined && text.includes(client.failOn)) {
        throw new Error(`boom: ${text}`);
      }
      client.calls.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as QueryResult;
    },
    release: () => {
      client.released = true;
    },
  };
  const pool = {
    connect: async () => fakeClient as unknown as PoolClient,
  } as unknown as Pool;
  return { pool, client };
}

describe("TenantScope:连接层租户上下文注入(D-API-101)", () => {
  it("GUC 常量字面冻结(政策谓词与注入面的命名锚)", () => {
    expect(TENANT_CONTEXT_GUC).toBe("app.tenant_id");
    expect(BOOT_RECOVERY_GUC).toBe("app.boot_recovery");
    expect(RETENTION_PURGE_GUC).toBe("app.retention_purge");
    expect(AUDIT_ARCHIVE_GUC).toBe("app.audit_archive");
  });

  it("租户作用域查询 = 事务包装:注入先于语句,COMMIT 收尾(SET LOCAL 语义)", async () => {
    const { pool, client } = makeFakePool();
    const scope = new TenantScope(pool);
    await scope.query("tenant-a", "SELECT * FROM sessions WHERE tenant_id = $1", ["tenant-a"]);
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT * FROM sessions WHERE tenant_id = $1",
      "COMMIT",
    ]);
    // 注入语句:租户上下文 is_local = true(仅事务内生效)。
    expect(client.calls[1]!.values).toEqual(["tenant-a"]);
    // 数据语句路由到同一 client(注入与查询同事务)。
    expect(client.calls[2]!.values).toEqual(["tenant-a"]);
    expect(client.released).toBe(true);
  });

  it("多语句事务面:run 回调持同一 client;异常 = ROLLBACK + 原样上抛", async () => {
    const { pool, client } = makeFakePool();
    const scope = new TenantScope(pool);
    const marker = { released: false };
    const result = await scope.transaction("tenant-b", async (tx) => {
      await tx.query("INSERT INTO submissions (tenant_id) VALUES ($1)", ["tenant-b"]);
      await tx.query("INSERT INTO verifier_runs (tenant_id) VALUES ($1)", ["tenant-b"]);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "INSERT INTO submissions (tenant_id) VALUES ($1)",
      "INSERT INTO verifier_runs (tenant_id) VALUES ($1)",
      "COMMIT",
    ]);
    void marker;

    // 异常路径:run 抛错 → ROLLBACK(错误原样上抛,翻译归存储层)。
    const failing = makeFakePool();
    const scope2 = new TenantScope(failing.pool);
    const boom = new Error("domain failure");
    await expect(
      scope2.transaction("tenant-c", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const texts = failing.client.calls.map((call) => call.text);
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect(failing.client.released).toBe(true);
  });

  it("生命周期作用域:专用 GUC 以 'on' 注入(is_local),app.tenant_id 不注入", async () => {
    const lifecycleGucs: LifecycleGuc[] = [BOOT_RECOVERY_GUC, RETENTION_PURGE_GUC, AUDIT_ARCHIVE_GUC];
    for (const guc of lifecycleGucs) {
      const { pool, client } = makeFakePool();
      const scope = new TenantScope(pool);
      await scope.lifecycleQuery(guc, "SELECT * FROM sessions WHERE phase = 'active'");
      expect(client.calls.map((call) => call.text)).toEqual([
        "BEGIN",
        "SELECT set_config($1, 'on', true)",
        "SELECT * FROM sessions WHERE phase = 'active'",
        "COMMIT",
      ]);
      expect(client.calls[1]!.values).toEqual([guc]);
    }
  });

  it("注入语句失败 = ROLLBACK 且 client 释放(fail-closed 收口,零连接泄漏)", async () => {
    const { pool, client } = makeFakePool({ failOn: "set_config" });
    const scope = new TenantScope(pool);
    await expect(
      scope.query("tenant-d", "SELECT 1"),
    ).rejects.toThrow(/boom/);
    const texts = client.calls.map((call) => call.text);
    // 失败的注入语句不入 fake 录制(仅成功查询记录);断言锚 = ROLLBACK 执行
    // 且 client 释放(零半开事务归还连接池)。
    expect(texts).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });
});
