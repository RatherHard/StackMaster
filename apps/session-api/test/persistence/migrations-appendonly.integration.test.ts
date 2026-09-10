/**
 * 容器门控集成测试:PostgreSQL 迁移可重放、action_log append-only 强制
 * (D-API-22 红灯反例)、查询层租户作用域(红灯)、快照密文静止断言
 * (D-W8-11;明文语料扫描零命中 + 红灯反例)。
 *
 * 门控:SESSION_API_IT=1 才运行(globalSetup 负责 compose up --wait / down);
 * 否则整组跳过并输出跳过原因。
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  PersistenceError,
  PostgresActionLogStore,
  PostgresChallengeRegistry,
  PostgresSessionRepository,
  PostgresSnapshotStore,
  SnapshotCipher,
  SnapshotPersistence,
  createActionLogPartition,
  createPostgresPool,
  loadMigrationsFromDir,
  runMigrations,
  scanSecretCorpus,
  sha256Hex,
} from "../../src/persistence/index.js";
import {
  IT_ENABLED,
  IT_CONFIG,
  MIGRATIONS_DIR,
  SKIP_REASON,
  createScratchDatabase,
  ensureMigrated,
  uniqueIds,
} from "./helpers/it.js";

const KEY = IT_CONFIG.snapshotEncryptionKey;

describe.skipIf(!IT_ENABLED)("PostgreSQL 迁移与 append-only 强制(容器门控)", () => {
  const ids = uniqueIds("mig");
  let pool: Pool;

  beforeAll(async () => {
    pool = await createPostgresPool(IT_CONFIG.postgresUrl, 5);
    await ensureMigrated(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("迁移脚本可重放:重复执行幂等(已应用全部跳过,零副作用)", async () => {
    const migrations = await loadMigrationsFromDir(MIGRATIONS_DIR);
    const expectedIds: string[] = migrations.map((m) => m.id).sort();
    const first = await runMigrations(pool, migrations);
    const second = await runMigrations(pool, migrations);
    // 首轮(相对本测试进程)可能应用或部分跳过(其他套件先行),关键是
    // 第二轮与首轮相比:不再有任何应用动作。
    expect(second.applied).toEqual([]);
    expect([...second.skipped].sort()).toEqual(expectedIds);
    expect(first.applied.length + first.skipped.length).toBe(migrations.length);
  });

  it("action_log UPDATE 被数据库层拒绝(append-only 红灯反例)", async () => {
    await pool.query(
      `INSERT INTO action_log (session_id, tenant_id, client_seq, revision_after, action)
       VALUES ($1, $2, 1, 1, $3::jsonb)`,
      [ids.sessionId, ids.tenantId, JSON.stringify({ type: "pause", args: {} })],
    );
    await expect(
      pool.query(
        `UPDATE action_log SET revision_after = 99 WHERE session_id = $1 AND tenant_id = $2`,
        [ids.sessionId, ids.tenantId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("action_log DELETE 被数据库层拒绝(append-only 红灯反例)", async () => {
    await expect(
      pool.query(`DELETE FROM action_log WHERE session_id = $1 AND tenant_id = $2`, [
        ids.sessionId,
        ids.tenantId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("action_log TRUNCATE 被数据库层拒绝(append-only 红灯反例)", async () => {
    await expect(pool.query(`TRUNCATE action_log`)).rejects.toThrow(/append-only/);
  });

  it("月度分区可预建(createActionLogPartition;DEFAULT 兜底不冲突)", async () => {
    // 远期月份:DEFAULT 分区无该范围数据,建分区必然成功。
    const future = new Date(Date.UTC(2099, 0, 1));
    await createActionLogPartition(pool, future);
    // 幂等:重复建同月分区不再抛错(IF NOT EXISTS)。
    await createActionLogPartition(pool, future);
  });

  it("查询层租户作用域:跨租户查询返回空(红灯:仅凭 sessionId 定位必须查不到)", async () => {
    const sessions = new PostgresSessionRepository(pool);
    await sessions.insertSession({
      sessionId: ids.sessionId,
      tenantId: ids.tenantId,
      userId: "user-1",
      challengeId: "ch-it",
      challengeVersion: "1.0.0",
      seedStrategy: "fixed",
    });
    expect(await sessions.findSession(ids.sessionId, `other-${ids.tenantId}`)).toBeNull();
    expect(await sessions.listSessionsByTenant(`other-${ids.tenantId}`)).toEqual([]);

    const actionLog = new PostgresActionLogStore(pool);
    await actionLog.append([
      {
        sessionId: ids.sessionId,
        tenantId: ids.tenantId,
        clientSeq: 1,
        revisionAfter: 1,
        action: { type: "pause", args: {} },
      },
    ]);
    // 红灯:跨租户动作日志查询 = 空集。
    expect(await actionLog.listBySession(ids.sessionId, `other-${ids.tenantId}`)).toEqual([]);
    expect(await actionLog.countBySession(ids.sessionId, `other-${ids.tenantId}`)).toBe(0);

    const snapshots = new PostgresSnapshotStore(pool);
    const cipher = SnapshotCipher.fromBase64Key(KEY);
    await snapshots.save({
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      origin: "explicit_checkpoint",
      revision: 1,
      ciphertext: cipher.encrypt(Buffer.from('{"revision":1}', "utf8")),
    });
    // 红灯:跨租户快照定位 = null。
    expect(await snapshots.latest(ids.sessionId, `other-${ids.tenantId}`)).toBeNull();
  });

  it("快照 blob 落库密文断言:明文语料扫描零命中;红灯反例(存明文)可检出", async () => {
    // 合成秘密语料(测试专用,样式与数据分类清单一致;永不复用真实值)。
    const seedCorpus = "00112233445566778899aabbccddeeff";
    const flagCorpus = "FLAG{it-cipher-assert}";
    const envelope = {
      snapshotFormatVersion: 1,
      revision: 4,
      payload: { seedState: { stateBytes: seedCorpus } },
      note: flagCorpus,
    };
    const persistence = new SnapshotPersistence({
      store: new PostgresSnapshotStore(pool),
      cipher: SnapshotCipher.fromBase64Key(KEY),
    });
    const record = await persistence.persist({
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      origin: "auto_periodic",
      revision: 4,
      envelope,
    });
    // 落库行读回原始字节:密文信封形态(SMEN 头)+ 语料零命中。
    const raw = await pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM checkpoints WHERE id = $1`,
      [record.id],
    );
    const stored = raw.rows[0]?.ciphertext;
    expect(stored).toBeDefined();
    expect(stored!.subarray(0, 4).toString("ascii")).toBe("SMEN");
    expect(stored!.toString("utf8")).not.toContain(seedCorpus);
    expect(stored!.toString("utf8")).not.toContain(flagCorpus);
    expect(scanSecretCorpus(stored!)).toEqual([]);
    // 解密往返还原(编排器侧只有密文,解密在消费点)。
    const loaded = await persistence.loadLatest(ids.sessionId, ids.tenantId);
    expect(loaded?.envelope).toEqual(envelope);

    // 红灯反例:故意把明文快照写进同一列(模拟未来回归)→ 扫描器检出。
    const bad = await pool.query<{ id: string }>(
      `INSERT INTO checkpoints (tenant_id, session_id, origin, revision, ciphertext, byte_size)
       VALUES ($1, $2, 'session_close', 5, $3, $4) RETURNING id`,
      [ids.tenantId, ids.sessionId, Buffer.from(JSON.stringify(envelope), "utf8"), 1],
    );
    const badRow = await pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM checkpoints WHERE id = $1`,
      [bad.rows[0]!.id],
    );
    expect(scanSecretCorpus(badRow.rows[0]!.ciphertext).length).toBeGreaterThanOrEqual(2);
    // 清理红灯反例行(该表允许按保留期/维护删除)。
    await pool.query(`DELETE FROM checkpoints WHERE id = $1`, [bad.rows[0]!.id]);
  });

  it("PG 版本不可变:同 (challengeId, contentVersion) 重复登记被拒", async () => {
    const registry = new PostgresChallengeRegistry(pool);
    await registry.upsertChallenge({ challengeId: `ch-${randomUUID().slice(0, 8)}`, tenantId: ids.tenantId });
    const challengeId = (await pool.query<{ challenge_id: string }>(
      `SELECT challenge_id FROM challenges WHERE tenant_id = $1 LIMIT 1`,
      [ids.tenantId],
    )).rows[0]!.challenge_id;
    const base = {
      challengeId,
      contentVersion: "9.9.9",
      tenantId: ids.tenantId,
      vmProfileVersion: "1.0.0",
      privateBundleSha256: sha256Hex(Buffer.from("p")),
      publicDescriptorSha256: sha256Hex(Buffer.from("u")),
      privateBundleObject: `${challengeId}/9.9.9/bundle.json`,
      publicDescriptorObject: `${challengeId}/9.9.9/descriptor.json`,
      signature: "sig",
      signerKeyId: "default",
    };
    await registry.insertChallengeVersion(base);
    await expect(registry.insertChallengeVersion(base)).rejects.toMatchObject({
      code: "challenge_version_conflict",
    });
  });

  it("内存实现与 PG 适配器同构冒烟(bundle store 内存态 + PG 会话行)", async () => {
    // 组合装配形态(WP-4 实际用法:按端口混装内存 / PG 实现)。
    const bundles = new MemoryChallengeBundleStore();
    const registry = new MemoryChallengeRegistry();
    await bundles.putPrivate("ch-mix", "1.0.0", Buffer.from("{}"));
    await registry.upsertChallenge({ challengeId: "ch-mix", tenantId: ids.tenantId });
    expect(await bundles.getPrivate("ch-mix", "1.0.0")).not.toBeNull();
    expect(await registry.findChallengeVersion("ch-mix", "1.0.0", ids.tenantId)).toBeNull();
    expect(PersistenceError).toBeDefined();
  });
});

// 迁移可重放的隔离数据库用例(独立 describe:scratch 库生命周期)。
describe.skipIf(!IT_ENABLED)("迁移在全新库上的应用与重放(容器门控,隔离 scratch 库)", () => {
  it("全新库:全部应用;重放:全部跳过;结束后删除 scratch 库", { timeout: 60_000 }, async () => {
    const scratch = await createScratchDatabase();
    try {
      const pool = await createPostgresPool(scratch.url, 2);
      try {
        const migrations = await loadMigrationsFromDir(MIGRATIONS_DIR);
        const expectedIds: string[] = migrations.map((m) => m.id).sort();
        const first = await runMigrations(pool, migrations);
        expect([...first.applied].sort()).toEqual(expectedIds);
        expect(first.skipped).toEqual([]);
        const second = await runMigrations(pool, migrations);
        expect(second.applied).toEqual([]);
        expect(second.skipped).toHaveLength(migrations.length);
      } finally {
        await pool.end();
      }
    } finally {
      await scratch.drop();
    }
  });
});

// 静态断言:跳过原因文案存在(未门控运行时输出可解释信息)。
describe.skipIf(IT_ENABLED)("容器门控未开启", () => {
  it(`集成测试整体跳过:${SKIP_REASON}`, () => {
    expect(IT_ENABLED).toBe(false);
    expect(KEY).toBeDefined();
    expect(IT_CONFIG.minioPort).toBeGreaterThan(0);
  });
});
