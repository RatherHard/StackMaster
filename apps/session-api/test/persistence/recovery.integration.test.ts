/**
 * 容器门控集成测试:编排器重启恢复(计划书 5.3 / WP-3 完成标准)。
 *
 * 承载方式说明(任务书要求):本测试以 **fake worker** 承载引擎进程,
 * 沿用 session-core 测试的 workerCommand 注入模式
 * (packages/session-core/test/orchestrator.test.ts:SessionOrchestrator 的
 * workerCommand 注入点传 `process.execPath + helpers/fake-worker.mjs`;
 * 本目录 helpers/fake-worker.mjs 为同模式本地副本)——不依赖 Rust 二进制,
 * 聚合验证的是 WP-3 的持久化与恢复装配面,引擎面恢复语义已在
 * vm-engine/vm-worker/tests/session_lifecycle.rs 覆盖。
 *
 * 场景:写会话 → 动作落库 → checkpoint 快照密文落库 → 模拟进程终止
 * (worker SIGKILL + 丢弃编排器实例与全部内存账本)→ 新实例从 sessions 行
 * + 最近密文快照重建恢复计划 → SessionOrchestrator.recover(两步
 * load + import_snapshot)→ revision 自快照续算 + 同输入恒同响应(I-4)。
 */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SessionOrchestrator, type ActionObject } from "@stackmaster/session-core";
import { canonicalize } from "@stackmaster/protocol";
import {
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  PostgresActionLogStore,
  PostgresSessionRepository,
  PostgresSnapshotStore,
  SnapshotCipher,
  SnapshotPersistence,
  SessionRecoveryService,
  createPostgresPool,
  scanSecretCorpus,
  type RecoveryPlan,
} from "../../src/persistence/index.js";
import { IT_ENABLED, IT_CONFIG, ensureMigrated, uniqueIds } from "./helpers/it.js";

const FAKE_WORKER = join(fileURLToPath(new URL("./helpers/", import.meta.url)), "fake-worker.mjs");
/** 与 session-core 测试相同的 workerCommand 注入形态。 */
const fakeWorkerCommand = () => ({ command: process.execPath, args: [FAKE_WORKER] });

const KEY = IT_CONFIG.snapshotEncryptionKey;
const SEED_CORPUS = "00112233445566778899aabbccddeeff"; // 测试语料(合成)

interface Stack {
  readonly pool: Pool;
  readonly sessions: PostgresSessionRepository;
  readonly actionLog: PostgresActionLogStore;
  readonly snapshots: PostgresSnapshotStore;
  readonly bundles: MemoryChallengeBundleStore;
  readonly registry: MemoryChallengeRegistry;
  readonly cipher: SnapshotCipher;
  readonly recovery: SessionRecoveryService;
  readonly persistence: SnapshotPersistence;
}

async function buildStack(): Promise<Stack> {
  const pool = await createPostgresPool(IT_CONFIG.postgresUrl, 5);
  await ensureMigrated(pool);
  const sessions = new PostgresSessionRepository(pool);
  const actionLog = new PostgresActionLogStore(pool);
  const snapshots = new PostgresSnapshotStore(pool);
  const bundles = new MemoryChallengeBundleStore();
  const registry = new MemoryChallengeRegistry();
  const cipher = SnapshotCipher.fromBase64Key(KEY);
  const recovery = new SessionRecoveryService({
    sessions,
    registry,
    bundles,
    snapshots,
    cipher,
    recoverySeed: () => SEED_CORPUS, // 现场一次性种子(仅 load 瞬时作用域)
  });
  return { pool, sessions, actionLog, snapshots, bundles, registry, cipher, recovery, persistence: new SnapshotPersistence({ store: snapshots, cipher }) };
}

/** 去除 requestId 后的规范化响应(I-4 比较:服务端瞬态标识不在比较面)。 */
function normalize(response: unknown): string {
  const clone = structuredClone(response) as Record<string, unknown>;
  delete clone["requestId"];
  return canonicalize(clone);
}

describe.skipIf(!IT_ENABLED)("编排器重启恢复(容器门控;fake worker 承载)", () => {
  const ids = uniqueIds("rec");
  let stack: Stack;
  let session: SessionOrchestrator;
  let challengeIdRef: string;
  const opened: SessionOrchestrator[] = [];

  beforeAll(async () => {
    stack = await buildStack();
    // 每次运行唯一 challengeId(版本不可变约束对跨运行残留免疫)。
    const challengeId = `fake-${ids.sessionId.slice(-10)}`;
    await stack.registry.upsertChallenge({ challengeId, tenantId: ids.tenantId });
    await stack.registry.insertChallengeVersion({
      challengeId,
      contentVersion: "1.0.0",
      tenantId: ids.tenantId,
      vmProfileVersion: "1.0.0",
      privateBundleSha256: "0".repeat(64),
      publicDescriptorSha256: "0".repeat(64),
      privateBundleObject: `${challengeId}/1.0.0/bundle.json`,
      publicDescriptorObject: `${challengeId}/1.0.0/descriptor.json`,
      signature: "sig",
      signerKeyId: "default",
    });
    await stack.bundles.putPrivate(challengeId, "1.0.0", Buffer.from(JSON.stringify({ seedPolicy: { strategy: "fixed" } })));
    await stack.bundles.putPublic(challengeId, "1.0.0", Buffer.from(JSON.stringify({})));
    challengeIdRef = challengeId;
  });

  afterAll(async () => {
    for (const orchestrator of opened.splice(0)) {
      await orchestrator.kill().catch(() => undefined);
    }
    await stack.pool.end();
  });

  it("写会话:创建编排器、执行动作、快照密文落库、动作日志落库", async () => {
    session = await SessionOrchestrator.create({
      sessionId: ids.sessionId,
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    opened.push(session);
    expect(session.revision).toBe(0);

    // 两个已接受动作(拒绝不入账语义由 session-core 保证;此处只落已接受)。
    const write: ActionObject = { type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "aa" } };
    const checkpoint: ActionObject = { type: "create_checkpoint", args: { label: "before-death" } };
    const writeResponse = await session.applyAction(write, { idempotencyKey: `${ids.sessionId}-w1` });
    const checkpointResponse = await session.applyAction(checkpoint, { idempotencyKey: `${ids.sessionId}-cp1` });
    expect(writeResponse.revision).toBe(1);
    expect(checkpointResponse.revision).toBe(2);

    // 编排器账本 → PG 动作日志(仅已接受动作;与 submit 引用同锚形态)。
    await stack.actionLog.append([
      { sessionId: ids.sessionId, tenantId: ids.tenantId, clientSeq: 1, revisionAfter: 1, action: write },
      { sessionId: ids.sessionId, tenantId: ids.tenantId, clientSeq: 2, revisionAfter: 2, action: checkpoint },
    ]);
    expect(await stack.actionLog.countBySession(ids.sessionId, ids.tenantId)).toBe(2);

    // checkpoint 回执快照 → 密文落库 + 会话快照锚推进(显式 checkpoint 触发点)。
    const receipt = session.listCheckpoints()[0]!;
    const record = await stack.persistence.persist({
      tenantId: ids.tenantId,
      sessionId: ids.sessionId,
      origin: "explicit_checkpoint",
      revision: receipt.revision,
      checkpointId: receipt.checkpointId,
      envelope: receipt.snapshot,
    });
    await stack.sessions.insertSession({
      sessionId: ids.sessionId,
      tenantId: ids.tenantId,
      userId: "user-rec",
      challengeId: challengeIdRef,
      challengeVersion: "1.0.0",
      seedStrategy: "fixed",
    });
    await stack.sessions.updateSessionSnapshotAnchor(ids.sessionId, ids.tenantId, record.id, receipt.revision);
    expect(record.byteSize).toBeGreaterThan(0);
  });

  it("模拟进程终止:worker SIGKILL + 丢弃实例;密文落库行不含明文语料", async () => {
    // 语料守卫:落库密文不携带测试种子语料(真快照的 seedState 在密文内)。
    const raw = await stack.pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM checkpoints WHERE session_id = $1 AND tenant_id = $2`,
      [ids.sessionId, ids.tenantId],
    );
    expect(raw.rows.length).toBeGreaterThan(0);
    for (const row of raw.rows) {
      expect(scanSecretCorpus(row.ciphertext)).toEqual([]);
    }
    // 进程终止:worker 强杀(与编排器进程崩溃等价的实例丢弃形态)。
    const exit = await session.kill();
    expect(exit.kind).toBe("forced");
    // 实例与全部内存账本就此丢弃(作用域外不再可及)。
    session = undefined as unknown as SessionOrchestrator;
  });

  it("新实例恢复:两步 load + import_snapshot;revision 自快照续算;动作日志延续", async () => {
    const plan: RecoveryPlan = await stack.recovery.planRecovery(ids.sessionId, ids.tenantId);
    expect(plan.snapshotRevision).toBe(2);
    // 恢复输入不含 seed 值面(fixed 策略;种子只在密文内)。
    expect(plan.load.sessionSeedHex).toBeUndefined();

    const recovered = await SessionOrchestrator.recover({
      sessionId: plan.sessionId,
      privateBundle: plan.load.privateBundle,
      publicDescriptor: plan.load.publicDescriptor,
      ...(plan.load.sessionSeedHex === undefined ? {} : { sessionSeedHex: plan.load.sessionSeedHex }),
      snapshot: plan.snapshot,
      workerCommand: fakeWorkerCommand(),
    });
    opened.push(recovered);
    // revision 自快照续算(快照信封 revision = 2)。
    expect(recovered.revision).toBe(2);

    // 同输入恒同响应(I-4):恢复后同一动作输入 → 确定性响应面(剥离服务端
    // 瞬态 requestId 后规范化逐字节一致);revision 自快照续算 +1。
    const action: ActionObject = { type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "aa" } };
    const first = await recovered.applyAction(action, { idempotencyKey: `post-1` });
    expect(first.revision).toBe(3);

    // 第二条独立恢复路径:同一快照恢复出的会话对同输入产生字节相同响应。
    const plan2 = await stack.recovery.planRecovery(ids.sessionId, ids.tenantId);
    const twin = await SessionOrchestrator.recover({
      sessionId: plan2.sessionId,
      privateBundle: plan2.load.privateBundle,
      publicDescriptor: plan2.load.publicDescriptor,
      snapshot: plan2.snapshot,
      workerCommand: fakeWorkerCommand(),
    });
    opened.push(twin);
    expect(twin.revision).toBe(2);
    const twinResponse = await twin.applyAction(action, { idempotencyKey: `post-1` });
    expect(normalize(twinResponse)).toBe(normalize(first));

    // 恢复后的已接受动作继续入账(append-only 账本与编排器同源)。
    await stack.actionLog.append([
      { sessionId: ids.sessionId, tenantId: ids.tenantId, clientSeq: 1, revisionAfter: 3, action },
    ]);
    const rows = await stack.actionLog.listBySession(ids.sessionId, ids.tenantId);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.revisionAfter).toBe(3);

    await recovered.closeSession();
    await twin.closeSession();
  });
});
