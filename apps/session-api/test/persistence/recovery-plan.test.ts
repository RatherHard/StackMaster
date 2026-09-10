/**
 * 恢复计划与题目登记路径测试(内存实现端到端;WP-3,D-API-23)。
 * 容器级恢复全链路(recover 路径 + I-4)见 recovery.integration.test.ts。
 */

import { describe, expect, it } from "vitest";
import {
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  MemorySessionRepository,
  MemorySnapshotStore,
  MemorySubmissionStore,
  sha256Hex,
  SnapshotCipher,
  SessionRecoveryService,
} from "../../src/persistence/index.js";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x30 + i)).toString("base64");

const SNAPSHOT_ENVELOPE = {
  snapshotFormatVersion: 1,
  vmEngineVersion: "0.1.0",
  engineBuildId: "dev",
  revision: 5,
  payload: { seedState: { stateBytes: "00112233445566778899aabbccddeeff" } },
};

interface Fixture {
  readonly sessions: MemorySessionRepository;
  readonly registry: MemoryChallengeRegistry;
  readonly bundles: MemoryChallengeBundleStore;
  readonly snapshots: MemorySnapshotStore;
  readonly submissions: MemorySubmissionStore;
  readonly recovery: SessionRecoveryService;
}

async function seedFixture(
  seedStrategy = "fixed",
  recoverySeed?: () => string,
): Promise<Fixture> {
  const sessions = new MemorySessionRepository();
  const registry = new MemoryChallengeRegistry();
  const bundles = new MemoryChallengeBundleStore();
  const snapshots = new MemorySnapshotStore();
  const submissions = new MemorySubmissionStore();
  await registry.upsertChallenge({ challengeId: "ch-1", tenantId: "tenant-a" });
  await registry.insertChallengeVersion({
    challengeId: "ch-1",
    contentVersion: "1.0.0",
    tenantId: "tenant-a",
    vmProfileVersion: "1.0.0",
    privateBundleSha256: sha256Hex(Buffer.from("{}")),
    publicDescriptorSha256: sha256Hex(Buffer.from("{}")),
    privateBundleObject: "ch-1/1.0.0/bundle.json",
    publicDescriptorObject: "ch-1/1.0.0/descriptor.json",
    signature: "sig",
    signerKeyId: "default",
  });
  await bundles.putPrivate("ch-1", "1.0.0", Buffer.from(JSON.stringify({ seedPolicy: { strategy: seedStrategy } })));
  await bundles.putPublic("ch-1", "1.0.0", Buffer.from(JSON.stringify({ challengeId: "ch-1" })));
  await sessions.insertSession({
    sessionId: "sess-rec",
    tenantId: "tenant-a",
    userId: "user-1",
    challengeId: "ch-1",
    challengeVersion: "1.0.0",
    seedStrategy,
  });
  const cipher = SnapshotCipher.fromBase64Key(KEY);
  return {
    sessions,
    registry,
    bundles,
    snapshots,
    submissions,
    recovery: new SessionRecoveryService({ sessions, registry, bundles, snapshots, cipher, recoverySeed }),
  };
}

describe("SessionRecoveryService(两步恢复输入产出)", () => {
  it("sessions 行 + 最近快照 → RecoverOptions 同构形态(load + snapshot 两步)", async () => {
    const fixture = await seedFixture();
    const cipher = SnapshotCipher.fromBase64Key(KEY);
    const stored = await fixture.snapshots.save({
      tenantId: "tenant-a",
      sessionId: "sess-rec",
      origin: "explicit_checkpoint",
      revision: 5,
      ciphertext: cipher.encrypt(Buffer.from(JSON.stringify(SNAPSHOT_ENVELOPE), "utf8")),
    });
    await fixture.sessions.updateSessionSnapshotAnchor("sess-rec", "tenant-a", stored.id, 5);

    const plan = await fixture.recovery.planRecovery("sess-rec", "tenant-a");
    expect(plan.sessionId).toBe("sess-rec");
    expect(plan.challenge).toEqual({ challengeId: "ch-1", challengeVersion: "1.0.0" });
    // 两步之一:load 参数(调用方重新提供私有包——核心不留存)。
    expect(plan.load.privateBundle).toEqual({ seedPolicy: { strategy: "fixed" } });
    expect(plan.load.publicDescriptor).toEqual({ challengeId: "ch-1" });
    expect(plan.load.sessionSeedHex).toBeUndefined(); // fixed 策略种子在包内
    // 两步之二:import_snapshot 载荷 = 解密后的快照信封。
    expect(plan.snapshot).toEqual(SNAPSHOT_ENVELOPE);
    expect(plan.snapshotRevision).toBe(5);
  });

  it("无快照恢复点 → 拒绝恢复(no_snapshot_for_recovery)", async () => {
    const fixture = await seedFixture();
    await expect(fixture.recovery.planRecovery("sess-rec", "tenant-a")).rejects.toMatchObject({
      code: "no_snapshot_for_recovery",
    });
  });

  it("跨租户恢复 = 会话不存在(统一形态防枚举)", async () => {
    const fixture = await seedFixture();
    await expect(fixture.recovery.planRecovery("sess-rec", "tenant-b")).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("已关闭会话拒绝恢复(终态不可复活)", async () => {
    const fixture = await seedFixture();
    await fixture.sessions.updateSessionPhase("sess-rec", "tenant-a", "closed");
    await expect(fixture.recovery.planRecovery("sess-rec", "tenant-a")).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("seed 零驻留:sessions 行只有策略元数据;server_random 恢复用一次性现场种子(不持久化)", async () => {
    const generatedSeeds: string[] = [];
    const fixture = await seedFixture("server_random_per_session", () => {
      // 现场一次性 CSPRNG 形态(测试注入确定性值;不落任何存储)。
      const seed = "ffeeddccbbaa99887766554433221100";
      generatedSeeds.push(seed);
      return seed;
    });
    // 快照落库(内含 seedState——seed 的唯一合法持久化落点,密文静止)。
    const cipher = SnapshotCipher.fromBase64Key(KEY);
    await fixture.snapshots.save({
      tenantId: "tenant-a",
      sessionId: "sess-rec",
      origin: "session_close",
      revision: 2,
      ciphertext: cipher.encrypt(Buffer.from(JSON.stringify(SNAPSHOT_ENVELOPE), "utf8")),
    });
    // 行内无 seed 值:seedStrategy 是策略元数据;不存在任何 seed 值字段。
    const row = await fixture.sessions.findSession("sess-rec", "tenant-a");
    expect(row?.seedStrategy).toBe("server_random_per_session");
    expect(Object.keys(row ?? {})).not.toContain("seed");
    expect(Object.keys(row ?? {})).not.toContain("sessionSeedHex");
    expect(Object.keys(row ?? {})).not.toContain("seedHex");

    const plan = await fixture.recovery.planRecovery("sess-rec", "tenant-a");
    // 一次性种子只出现在 load 输入(瞬时,消费方用于 load 帧构造),信封原样。
    expect(plan.load.sessionSeedHex).toBe(generatedSeeds[0]);
    expect(plan.snapshot).toEqual(SNAPSHOT_ENVELOPE);
    // fixed 策略对照:load 输入不携带 sessionSeedHex。
    const fixedFixture = await seedFixture();
    await fixedFixture.snapshots.save({
      tenantId: "tenant-a",
      sessionId: "sess-rec",
      origin: "session_close",
      revision: 2,
      ciphertext: cipher.encrypt(Buffer.from(JSON.stringify(SNAPSHOT_ENVELOPE), "utf8")),
    });
    const fixedPlan = await fixedFixture.recovery.planRecovery("sess-rec", "tenant-a");
    expect(fixedPlan.load.sessionSeedHex).toBeUndefined();
  });

  it("server_random 策略且未提供一次性种子生成器 → 恢复拒绝(fail-closed)", async () => {
    const fixture = await seedFixture("server_random_per_session");
    const cipher = SnapshotCipher.fromBase64Key(KEY);
    await fixture.snapshots.save({
      tenantId: "tenant-a",
      sessionId: "sess-rec",
      origin: "session_close",
      revision: 2,
      ciphertext: cipher.encrypt(Buffer.from(JSON.stringify(SNAPSHOT_ENVELOPE), "utf8")),
    });
    await expect(fixture.recovery.planRecovery("sess-rec", "tenant-a")).rejects.toMatchObject({
      code: "no_snapshot_for_recovery",
    });
  });
});
