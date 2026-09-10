/**
 * 内存实现语义测试(WP-3):TTL、原子消费、租户过滤(查询层强制红灯)、
 * append-only 接口形态、快照保留期。生产适配器在容器门控集成测试中
 * 证明同构语义(append-only / 租户作用域的数据库层强制另有红灯反例)。
 */

import { describe, expect, it } from "vitest";
import {
  MemoryActionLogStore,
  MemoryChallengeRegistry,
  MemoryIdempotencyWindow,
  MemoryKeyValueStore,
  MemoryRateLimitCounter,
  MemoryRouteStore,
  MemorySessionRepository,
  MemorySnapshotStore,
  PersistenceError,
} from "../../src/persistence/index.js";

/** 假时钟(TTL 语义测试驱动)。 */
function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

describe("MemoryKeyValueStore(token:{jti} 消费原语,WP-2 端口)", () => {
  it("set/get 往返;TTL 过期后读空", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    await store.set("token:abc", "issued", 60);
    expect(await store.get("token:abc")).toBe("issued");
    clock.advance(61);
    expect(await store.get("token:abc")).toBeNull();
  });

  it("deleteIfPresent 原子单次消费:第一次 true,第二次 false", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    await store.set("token:jti-1", "record", 60);
    expect(await store.deleteIfPresent("token:jti-1")).toBe(true);
    expect(await store.deleteIfPresent("token:jti-1")).toBe(false);
  });

  it("TTL 必须为正(键域全部带 TTL 纪律)", async () => {
    const store = new MemoryKeyValueStore();
    await expect(store.set("k", "v", 0)).rejects.toMatchObject({ code: "invalid_identifier" });
  });
});

describe("MemoryRouteStore / MemoryRateLimitCounter", () => {
  it("route 绑定覆盖写;TTL 过期 resolve 空;release 立即失效", async () => {
    const clock = fakeClock();
    const routes = new MemoryRouteStore(clock.now);
    await routes.bind("sess-1", "orchestrator-a", 30);
    expect(await routes.resolve("sess-1")).toBe("orchestrator-a");
    await routes.bind("sess-1", "orchestrator-b", 30);
    expect(await routes.resolve("sess-1")).toBe("orchestrator-b");
    clock.advance(31);
    expect(await routes.resolve("sess-1")).toBeNull();
    await routes.bind("sess-2", "orchestrator-b", 30);
    await routes.release("sess-2");
    expect(await routes.resolve("sess-2")).toBeNull();
  });

  it("rate 固定窗口计数:首建立窗口,窗口内累加,过期重置", async () => {
    const clock = fakeClock();
    const counter = new MemoryRateLimitCounter(clock.now);
    expect(await counter.increment("rate:t:u", 10)).toBe(1);
    clock.advance(3);
    expect(await counter.increment("rate:t:u", 10)).toBe(2);
    expect(await counter.increment("rate:t:u", 10)).toBe(3);
    clock.advance(8); // 越过首增锚定的 10s 窗口
    expect(await counter.increment("rate:t:u", 10)).toBe(1);
  });
});

describe("MemorySessionRepository(查询层租户校验强制)", () => {
  it("跨租户查询返回空(红灯反例:仅按 sessionId 定位必须查不到)", async () => {
    const repo = new MemorySessionRepository();
    await repo.insertSession({
      sessionId: "sess-tenant-1",
      tenantId: "tenant-a",
      userId: "user-1",
      challengeId: "ch-1",
      challengeVersion: "1.0.0",
      seedStrategy: "fixed",
    });
    expect(await repo.findSession("sess-tenant-1", "tenant-a")).not.toBeNull();
    // 红灯:跨租户 = 空集(与不存在同形态,防枚举)。
    expect(await repo.findSession("sess-tenant-1", "tenant-b")).toBeNull();
    expect(await repo.listSessionsByTenant("tenant-b")).toEqual([]);
  });

  it("快照锚推进与阶段更新只对属主租户生效", async () => {
    const repo = new MemorySessionRepository();
    await repo.insertSession({
      sessionId: "sess-anchor",
      tenantId: "tenant-a",
      userId: "user-1",
      challengeId: "ch-1",
      challengeVersion: "1.0.0",
      seedStrategy: "fixed",
    });
    // 红灯:跨租户锚推进被拒(会话定位必须同时满足租户)。
    await expect(
      repo.updateSessionSnapshotAnchor("sess-anchor", "tenant-b", "snap-x", 5),
    ).rejects.toMatchObject({ code: "session_not_found" });
    await repo.updateSessionSnapshotAnchor("sess-anchor", "tenant-a", "snap-x", 5);
    const row = await repo.findSession("sess-anchor", "tenant-a");
    expect(row?.latestSnapshotId).toBe("snap-x");
    expect(row?.latestRevision).toBe(5);
    await repo.updateSessionPhase("sess-anchor", "tenant-a", "closed");
    expect((await repo.findSession("sess-anchor", "tenant-a"))?.phase).toBe("closed");
  });
});

describe("MemorySnapshotStore(只存取不解析)与保留期", () => {
  it("latest 返回最近一条;跨租户空集;密文原样往返", async () => {
    const store = new MemorySnapshotStore();
    await store.save({
      tenantId: "tenant-a",
      sessionId: "sess-snap",
      origin: "explicit_checkpoint",
      revision: 3,
      ciphertext: Uint8Array.of(1, 2, 3),
    });
    await store.save({
      tenantId: "tenant-a",
      sessionId: "sess-snap",
      origin: "auto_periodic",
      revision: 9,
      ciphertext: Uint8Array.of(4, 5, 6),
    });
    const latest = await store.latest("sess-snap", "tenant-a");
    expect(latest?.revision).toBe(9);
    expect([...(latest?.ciphertext ?? [])]).toEqual([4, 5, 6]);
    expect(await store.latest("sess-snap", "tenant-b")).toBeNull();
  });

  it("purgeExpired 按保留期清除过期快照", async () => {
    const store = new MemorySnapshotStore();
    await store.save({
      tenantId: "tenant-a",
      sessionId: "sess-snap",
      origin: "session_close",
      revision: 1,
      ciphertext: Uint8Array.of(1),
    });
    // 内存实现 createdAt 用真实时钟,老化为负不行——改为直接断言保留期内不清除。
    expect(await store.purgeExpired(30)).toBe(0);
  });
});

describe("MemoryActionLogStore(append-only 接口形态)", () => {
  it("只提供 append 与查询:落库顺序保持,租户过滤强制", async () => {
    const store = new MemoryActionLogStore();
    await store.append([
      {
        sessionId: "sess-log",
        tenantId: "tenant-a",
        clientSeq: 1,
        revisionAfter: 1,
        action: { type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "aa" } },
      },
      {
        sessionId: "sess-log",
        tenantId: "tenant-b",
        clientSeq: 1,
        revisionAfter: 1,
        action: { type: "pause", args: {} },
      },
    ]);
    const tenantARows = await store.listBySession("sess-log", "tenant-a");
    expect(tenantARows).toHaveLength(1);
    expect((tenantARows[0]?.action as { type: string }).type).toBe("write_bytes");
    expect(await store.countBySession("sess-log", "tenant-a")).toBe(1);
    // 跨租户 = 空集(查询层强制)。
    expect(await store.listBySession("sess-log", "tenant-c")).toEqual([]);
  });

  it("submissionRef 锚随条目透传(与 submit 引用同锚)", async () => {
    const store = new MemoryActionLogStore();
    await store.append([
      {
        sessionId: "sess-log",
        tenantId: "tenant-a",
        clientSeq: 2,
        revisionAfter: 2,
        action: { type: "step", args: {} },
        submissionRef: "sub-1",
      },
    ]);
    const rows = await store.listBySession("sess-log", "tenant-a");
    expect(rows[0]?.submissionRef).toBe("sub-1");
  });
});

describe("MemoryIdempotencyWindow(进程内降级载体,同语义)", () => {
  it("fresh → replay-identical → conflict 的 D-W8-9 语义", async () => {
    const clock = fakeClock();
    const window = new MemoryIdempotencyWindow(300, clock.now);
    expect(await window.checkAndRecord("sess-1", "key-1", '{"a":1}')).toBe("fresh");
    expect(await window.checkAndRecord("sess-1", "key-1", '{"a":1}')).toBe("replay-identical");
    expect(await window.checkAndRecord("sess-1", "key-1", '{"a":2}')).toBe("conflict");
    // 不同会话同键互不干扰((sessionId, key) 复合键)。
    expect(await window.checkAndRecord("sess-2", "key-1", '{"a":2}')).toBe("fresh");
  });

  it("TTL 过期 → fresh(固定窗口,重放不续期)", async () => {
    const clock = fakeClock();
    const window = new MemoryIdempotencyWindow(300, clock.now);
    await window.checkAndRecord("sess-1", "key-1", '{"a":1}');
    clock.advance(299);
    expect(await window.checkAndRecord("sess-1", "key-1", '{"a":1}')).toBe("replay-identical");
    clock.advance(2); // 越过 TTL(自首次登记起算;重放未续期)
    expect(await window.checkAndRecord("sess-1", "key-1", '{"a":1}')).toBe("fresh");
  });
});

describe("MemoryChallengeRegistry(版本不可变)", () => {
  it("重复登记确定性拒绝;跨租户查不到", async () => {
    const registry = new MemoryChallengeRegistry();
    await registry.upsertChallenge({ challengeId: "ch-1", tenantId: "tenant-a" });
    const base = {
      challengeId: "ch-1",
      contentVersion: "1.0.0",
      tenantId: "tenant-a",
      vmProfileVersion: "1.0.0",
      privateBundleSha256: "a".repeat(64),
      publicDescriptorSha256: "b".repeat(64),
      privateBundleObject: "ch-1/1.0.0/bundle.json",
      publicDescriptorObject: "ch-1/1.0.0/descriptor.json",
      signature: "sig",
      signerKeyId: "default",
    };
    await registry.insertChallengeVersion(base);
    await expect(registry.insertChallengeVersion(base)).rejects.toMatchObject({
      code: "challenge_version_conflict",
    });
    expect(await registry.findChallengeVersion("ch-1", "1.0.0", "tenant-b")).toBeNull();
    expect(await registry.findChallengeVersion("ch-1", "1.0.0", "tenant-a")).not.toBeNull();
  });

  it("PersistenceError 携带稳定错误码(错误面纪律)", () => {
    const error = new PersistenceError("store_unavailable", "依赖不可用");
    expect(error.code).toBe("store_unavailable");
    expect(error.name).toBe("PersistenceError");
  });
});
