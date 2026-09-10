/**
 * 编排器重启恢复的启动期接线单测(WP-7,D-API-63;内存同构栈,fake worker)。
 *
 * 覆盖:active 会话行 → recoverActiveSessions → 纳入新管理器在途表 →
 * revision 自快照续算 + 同输入恒同响应(I-4,跨重启对齐);fail-open 边界
 * (不可恢复会话 → crashed,启动不受阻);closed 会话不恢复。
 * 容器拓扑级复验见 test/compose(真实 PG / Redis / MinIO / worker)。
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalize, type ActionObject } from "@stackmaster/protocol";
import { SessionOrchestrator } from "@stackmaster/session-core";
import { buildIrPair } from "../../../../packages/challenge-compiler/test/helpers/private-bundle.js";

import { createLogCapture } from "../helpers/log-capture.js";
import { createLogger } from "../../src/logger.js";
import {
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  MemorySessionRepository,
  MemorySnapshotStore,
  SnapshotCipher,
  SnapshotPersistence,
  SessionRecoveryService,
} from "../../src/persistence/index.js";
import { LiveSessionManager } from "../../src/sessions/session-manager.js";
import { recoverActiveSessions } from "../../src/runtime/runtime.js";
import { loadSessionApiConfig } from "../../src/config.js";
import { REQUIRED_ENV_FIXTURE } from "../helpers/required-env.js";

const FAKE_WORKER = join(fileURLToPath(new URL("../persistence/helpers/", import.meta.url)), "fake-worker.mjs");
// 恢复路径要求假 worker 支持 import_snapshot / export_snapshot——复用
// test/persistence/helpers 的假 worker(recovery.integration 同源)。
const fakeWorkerCommand = () => ({ command: process.execPath, args: [FAKE_WORKER] });

const KEY = REQUIRED_ENV_FIXTURE["SESSION_API_SNAPSHOT_ENCRYPTION_KEY"] ?? "";
const TENANT = "tenant-recovery";
const USER = "user-recovery";
const CHALLENGE = "chal-recovery";

/** 可重启的内存同构栈:存储与注册表跨"进程"存活,manager / 编排器可整体替换。 */
interface Stack {
  readonly registry: MemoryChallengeRegistry;
  readonly bundles: MemoryChallengeBundleStore;
  readonly sessions: MemorySessionRepository;
  readonly snapshots: MemorySnapshotStore;
  readonly capture: ReturnType<typeof createLogCapture>;
  buildManager(): Promise<LiveSessionManager>;
}

async function buildStack(): Promise<Stack> {
  const registry = new MemoryChallengeRegistry();
  const bundles = new MemoryChallengeBundleStore();
  const sessions = new MemorySessionRepository();
  const snapshots = new MemorySnapshotStore();
  const capture = createLogCapture();
  const config = loadSessionApiConfig({
    NODE_ENV: "test",
    SESSION_API_PORT: "0",
    ...REQUIRED_ENV_FIXTURE,
  });
  const logger = createLogger(config, capture.stream);
  const cipher = SnapshotCipher.fromBase64Key(KEY);

  // 注册最小合法题目双包(装载管线真实校验;构造器纪律沿 challenge-compiler
  // 测试 helper——合成语料,非真实题目内容)。
  const pair = buildIrPair({
    mutate: (mutable) => {
      const descriptor = mutable.publicDescriptor as { challengeId: string; challengeContentVersion: string };
      descriptor.challengeId = CHALLENGE;
      descriptor.challengeContentVersion = "1.0.0";
      const bundle = mutable.privateBundle as { challengeId: string; challengeContentVersion: string };
      bundle.challengeId = CHALLENGE;
      bundle.challengeContentVersion = "1.0.0";
    },
  });
  await registry.upsertChallenge({ challengeId: CHALLENGE, tenantId: TENANT });
  await registry.insertChallengeVersion({
    challengeId: CHALLENGE,
    contentVersion: "1.0.0",
    tenantId: TENANT,
    vmProfileVersion: "1.0.0",
    privateBundleSha256: "0".repeat(64),
    publicDescriptorSha256: "0".repeat(64),
    privateBundleObject: "bundle.json",
    publicDescriptorObject: "descriptor.json",
    signature: "sig",
    signerKeyId: "k",
  });
  await bundles.putPrivate(CHALLENGE, "1.0.0", Buffer.from(JSON.stringify(pair.privateBundle)));
  await bundles.putPublic(CHALLENGE, "1.0.0", Buffer.from(JSON.stringify(pair.publicDescriptor)));

  return {
    registry,
    bundles,
    sessions,
    snapshots,
    capture,
    buildManager: async () =>
      new LiveSessionManager({
        registry,
        bundles,
        sessions,
        submissions: { record: async () => { throw new Error("unused"); }, findBySession: async () => [] },
        snapshotPersistence: new SnapshotPersistence({ store: snapshots, cipher }),
        audit: { append: async () => undefined },
        logger,
        clientSeqLimit: 65536,
        actionLog: { append: async () => undefined, listBySession: async () => [], countBySession: async () => 0 },
        snapshots,
        quotaLimits: {
          maxCheckpointsPerSession: 256,
          snapshotByteBudget: 1048576,
          tenantStorageQuotaBytes: 268435456,
        },
        maxConcurrentSessionsPerTenant: 8,
        workerCommand: fakeWorkerCommand(),
      }),
  };
}

const OPENED: SessionOrchestrator[] = [];

afterAll(async () => {
  for (const orchestrator of OPENED.splice(0)) {
    await orchestrator.kill().catch(() => undefined);
  }
});

describe("recoverActiveSessions:启动期两步恢复(D-API-63)", () => {
  it("active 会话重启 → 自快照续算 revision;同输入恒同响应(I-4 跨重启)", async () => {
    const stack = await buildStack();

    // 模拟一次旧进程生命周期:create_session → 动作 → checkpoint(恢复点落库)
    // → 快照后动作(超快照尾部)→ 停机冲刷。
    const identity = {
      tenantId: TENANT,
      userId: USER,
      challengeId: CHALLENGE,
      challengeVersion: "1.0.0",
      embedTokenJti: "jti-recovery-1",
    };
    const firstManager = await stack.buildManager();
    const outcome = await firstManager.createSession(identity);
    expect(outcome.revision).toBe(0);
    const sessionId = outcome.sessionId;

    const write: ActionObject = { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "aa" } };
    const checkpoint: ActionObject = { type: "create_checkpoint", args: {} };
    await firstManager.applyAction(sessionId, TENANT, write, { idempotencyKey: "r1" });
    await firstManager.applyAction(sessionId, TENANT, checkpoint, { idempotencyKey: "r2" });
    // 快照锚在 checkpoint(revision 2);此后再执行一个动作(超快照尾部)。
    const preRestartTail = await firstManager.applyAction(sessionId, TENANT, write, { idempotencyKey: "r3" });
    expect(preRestartTail.revision).toBe(3);
    // 收敛恢复点:停机冲刷语义(flushAll 补落未落库恢复点,dedupe)。
    await firstManager.flushAll();

    // 旧进程整体丢弃(编排器实例与内存账本随作用域终结);新进程启动恢复。
    const nextManager = await stack.buildManager();
    expect(nextManager.liveCount).toBe(0);

    const recoveredCount = await recoverActiveSessions({
      sessions: stack.sessions,
      recovery: new SessionRecoveryService({
        sessions: stack.sessions,
        registry: stack.registry,
        bundles: stack.bundles,
        snapshots: stack.snapshots,
        cipher: SnapshotCipher.fromBase64Key(KEY),
        recoverySeed: () => "00112233445566778899aabbccddeeff",
      }),
      manager: nextManager,
      logger: createLogger(loadSessionApiConfig({ NODE_ENV: "test", SESSION_API_PORT: "0", ...REQUIRED_ENV_FIXTURE }), stack.capture.stream),
      workerCommand: fakeWorkerCommand(),
    });
    expect(recoveredCount).toBe(1);
    expect(nextManager.liveCount).toBe(1);

    // revision 自快照续算 + 同输入恒同响应:恢复后同输入动作与重启前在
    // 同一状态(快照 revision 2)上的执行结果同形(剥离服务端瞬态标识)。
    const postRestart = await nextManager.syncProjection(sessionId, TENANT);
    expect(postRestart.revision).toBe(2);
    const postRestartTail = await nextManager.applyAction(sessionId, TENANT, write, { idempotencyKey: "r4" });
    expect(postRestartTail.revision).toBe(3);
    const strip = (response: unknown) => {
      const clone = structuredClone(response) as Record<string, unknown>;
      delete clone["requestId"];
      return canonicalize(clone);
    };
    expect(strip(postRestartTail)).toBe(strip(preRestartTail));
  });

  it("fail-open:不可恢复会话(题目双包缺失)→ crashed + 启动不受阻", async () => {
    const stack = await buildStack();
    // 直接落一行"孤儿"active 会话(无注册表 / 双包 / 快照)。
    await stack.sessions.insertSession({
      sessionId: "sess-orphan-1",
      tenantId: TENANT,
      userId: USER,
      challengeId: "chal-missing",
      challengeVersion: "9.9.9",
      seedStrategy: "fixed",
    });
    const manager = await stack.buildManager();
    const recovered = await recoverActiveSessions({
      sessions: stack.sessions,
      recovery: new SessionRecoveryService({
        sessions: stack.sessions,
        registry: stack.registry,
        bundles: stack.bundles,
        snapshots: stack.snapshots,
        cipher: SnapshotCipher.fromBase64Key(KEY),
      }),
      manager,
      logger: createLogger(loadSessionApiConfig({ NODE_ENV: "test", SESSION_API_PORT: "0", ...REQUIRED_ENV_FIXTURE }), stack.capture.stream),
    });
    expect(recovered).toBe(0);
    expect(manager.liveCount).toBe(0);
    // 会话行置确定性终态(客户端恢复路径 = 重新 create_session)。
    const row = await stack.sessions.findSession("sess-orphan-1", TENANT);
    expect(row?.phase).toBe("crashed");
    // 受控日志携带失败事实(零敏感载荷)。
    const warn = stack.capture.entries().find((entry) => entry.msg === "session recovery failed at startup; session marked crashed");
    expect(warn).toBeDefined();
  });

  it("closed 会话不恢复(终态不可复活);正常冷启动零恢复", async () => {
    const stack = await buildStack();
    const manager = await stack.buildManager();
    const outcome = await manager.createSession({
      tenantId: TENANT,
      userId: USER,
      challengeId: CHALLENGE,
      challengeVersion: "1.0.0",
      embedTokenJti: "jti-recovery-2",
    });
    await manager.applyAction(outcome.sessionId, TENANT, { type: "create_checkpoint", args: {} }, { idempotencyKey: "c1" });
    await manager.closeSession(outcome.sessionId, TENANT);
    expect(manager.liveCount).toBe(0);

    const nextManager = await stack.buildManager();
    const recovered = await recoverActiveSessions({
      sessions: stack.sessions,
      recovery: new SessionRecoveryService({
        sessions: stack.sessions,
        registry: stack.registry,
        bundles: stack.bundles,
        snapshots: stack.snapshots,
        cipher: SnapshotCipher.fromBase64Key(KEY),
      }),
      manager: nextManager,
      logger: createLogger(loadSessionApiConfig({ NODE_ENV: "test", SESSION_API_PORT: "0", ...REQUIRED_ENV_FIXTURE }), stack.capture.stream),
    });
    expect(recovered).toBe(0);
    expect(nextManager.liveCount).toBe(0);
  });
});
