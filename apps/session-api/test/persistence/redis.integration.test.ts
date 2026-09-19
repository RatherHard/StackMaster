/**
 * 容器门控集成测试:Redis 键域(TTL、原子消费、路由、固定窗口计数)与
 * 幂等窗口 Redis 后端(fresh / replay-identical / conflict / TTL 过期 → fresh)。
 * 分级降级语义(D-API-24)的故障注入形态在 idempotency-window.test.ts
 * (单元)覆盖;此处验证真实 Redis 上的语义与 TTL。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryIdempotencyWindow,
  RedisIdempotencyWindow,
  RedisKeyValueStore,
  RedisLaunchTicketStore,
  RedisRateLimitCounter,
  RedisRouteStore,
  createRedisConnection,
  type RedisLike,
} from "../../src/persistence/index.js";
import { generateLaunchTicketToken, launchTicketKey } from "../../src/launch/ticket-token.js";
import { IT_ENABLED, IT_CONFIG, SKIP_REASON, sleep, uniqueIds } from "./helpers/it.js";

/**
 * 固定的"应用时钟"(Unix epoch 秒)。Lua 内的过期兜底比较以 ARGV 传入该值 ⇒
 * 过期路径**不依赖真实时间**,可被确定性驱动(与 TTL 的 1 s 真实等待分开)。
 */
const FIXED_NOW_SECONDS = 1_800_000_000;

describe.skipIf(!IT_ENABLED)("Redis 键域(容器门控)", () => {
  let redis: RedisLike;
  const ids = uniqueIds("redis");

  beforeAll(async () => {
    redis = await createRedisConnection(IT_CONFIG.redisUrl);
  });

  afterAll(async () => {
    const maybe = redis as unknown as { disconnect?: () => void };
    if (redis && typeof maybe.disconnect === "function") {
      maybe.disconnect();
    }
  });

  it("KeyValueStore:set/get 往返;TTL 真实生效(过期读空)", async () => {
    const store = new RedisKeyValueStore(redis);
    await store.set(`token:${ids.sessionId}`, "issued-record", 1);
    expect(await store.get(`token:${ids.sessionId}`)).toBe("issued-record");
    await sleep(1200);
    expect(await store.get(`token:${ids.sessionId}`)).toBeNull();
  });

  it("KeyValueStore:deleteIfPresent 原子单次消费(jti 单次消费语义)", async () => {
    const store = new RedisKeyValueStore(redis);
    await store.set(`token:${ids.sessionId}-once`, "record", 60);
    expect(await store.deleteIfPresent(`token:${ids.sessionId}-once`)).toBe(true);
    expect(await store.deleteIfPresent(`token:${ids.sessionId}-once`)).toBe(false);
    expect(await store.get(`token:${ids.sessionId}-once`)).toBeNull();
    await store.delete(`token:${ids.sessionId}-absent`);
  });

  it("RouteStore:绑定 / 解析 / 释放;TTL 过期返回 null", async () => {
    const routes = new RedisRouteStore(redis);
    await routes.bind(ids.sessionId, "orchestrator-a", 60);
    expect(await routes.resolve(ids.sessionId)).toBe("orchestrator-a");
    await routes.bind(ids.sessionId, "orchestrator-b", 60); // 恢复接管:覆盖写
    expect(await routes.resolve(ids.sessionId)).toBe("orchestrator-b");
    await routes.release(ids.sessionId);
    expect(await routes.resolve(ids.sessionId)).toBeNull();
    // TTL 过期路径(1s 窗口)。
    await routes.bind(`${ids.sessionId}-ttl`, "orchestrator-c", 1);
    await sleep(1200);
    expect(await routes.resolve(`${ids.sessionId}-ttl`)).toBeNull();
  });

  it("RateLimitCounter:固定窗口原子计数;窗口过期重置", async () => {
    const counter = new RedisRateLimitCounter(redis);
    const key = `${ids.tenantId}:${ids.sessionId}`;
    expect(await counter.increment(key, 2)).toBe(1);
    expect(await counter.increment(key, 2)).toBe(2);
    expect(await counter.increment(key, 2)).toBe(3);
    await sleep(2100);
    expect(await counter.increment(key, 2)).toBe(1);
  });

  it("幂等窗口 Redis 后端:fresh → replay-identical;同键异负载 → conflict", async () => {
    const window = new RedisIdempotencyWindow(redis, 60);
    expect(await window.checkAndRecord(ids.sessionId, "k1", "canonical-1")).toBe("fresh");
    expect(await window.checkAndRecord(ids.sessionId, "k1", "canonical-1")).toBe("replay-identical");
    expect(await window.checkAndRecord(ids.sessionId, "k1", "canonical-2")).toBe("conflict");
    // (sessionId, key) 复合键:异会话同键互不干扰。
    expect(await window.checkAndRecord(`${ids.sessionId}-b`, "k1", "canonical-2")).toBe("fresh");
  });

  it("幂等窗口 TTL 过期 → fresh(固定窗口,重放不续期)", async () => {
    const window = new RedisIdempotencyWindow(redis, 1);
    await window.checkAndRecord(ids.sessionId, "k-ttl", "canonical-1");
    // TTL 自首次登记起算:窗口内重放命中。
    expect(await window.checkAndRecord(ids.sessionId, "k-ttl", "canonical-1")).toBe("replay-identical");
    await sleep(1100);
    expect(await window.checkAndRecord(ids.sessionId, "k-ttl", "canonical-1")).toBe("fresh");
  });

  it("降级同构:进程内窗口与 Redis 后端三值判定逐条一致(降级不破坏语义)", async () => {
    const memory = new MemoryIdempotencyWindow(60);
    const redisWindow = new RedisIdempotencyWindow(redis, 60);
    const key = `k-par-${ids.sessionId}`;
    expect(await memory.checkAndRecord(ids.sessionId, key, "c1")).toBe(
      await redisWindow.checkAndRecord(ids.sessionId, `${key}-r`, "c1"),
    );
    expect(await memory.checkAndRecord(ids.sessionId, key, "c1")).toBe("replay-identical");
    expect(await redisWindow.checkAndRecord(ids.sessionId, `${key}-r`, "c1")).toBe("replay-identical");
    expect(await memory.checkAndRecord(ids.sessionId, key, "c2")).toBe("conflict");
    expect(await redisWindow.checkAndRecord(ids.sessionId, `${key}-r`, "c2")).toBe("conflict");
  });

  // ── 启动票据键域 launch:{jti}(WP-91;D-LT-2)真机语义 ──────────────────
  // 机检 ④「单次消费原子性」的**真实 Redis** 版(内存替身版见
  // test/launch/launch-ticket-store.test.ts)。两者都必须存在:内存替身证明
  // 端口语义,这里证明 **Lua 脚本在真实 Redis 上的原子性** —— 后者无法用任何
  // TS 假实现替代(假实现复刻的是 Lua 的意图,不是 Redis 的执行模型)。

  /** 造一份绑定记录(tenantId 是票据内封装的字段,不在 URL 上)。 */
  function bindingFor(challengeId: string, version: string, expiresAt: number) {
    return { tenantId: ids.tenantId, challengeId, version, expiresAt };
  }

  it("LaunchTicketStore:签发 → 换票取回完整绑定(含 URL 上不存在的 tenantId)", async () => {
    const store = new RedisLaunchTicketStore(redis, () => FIXED_NOW_SECONDS * 1000);
    const token = generateLaunchTicketToken();
    const binding = bindingFor("ch-1", "1.0.0", FIXED_NOW_SECONDS + 60);
    await store.put(token, binding, 60);

    const redeemed = await store.consume(token, { challengeId: "ch-1", version: "1.0.0" });
    expect(redeemed).toEqual(binding);
    // 租户**只能**从记录取回(URL / body 参数不参与派生)。
    expect(redeemed?.tenantId).toBe(ids.tenantId);
  });

  it("LaunchTicketStore:绑定不符 ⇒ 返回 null 且**不消费**(合法持有者仍可换票)", async () => {
    const store = new RedisLaunchTicketStore(redis, () => FIXED_NOW_SECONDS * 1000);
    const token = generateLaunchTicketToken();
    await store.put(token, bindingFor("ch-2", "1.0.0", FIXED_NOW_SECONDS + 60), 60);

    // 三处不符:错 challengeId / 错 version / 两者都错。
    expect(await store.consume(token, { challengeId: "ch-other", version: "1.0.0" })).toBeNull();
    expect(await store.consume(token, { challengeId: "ch-2", version: "9.9.9" })).toBeNull();
    expect(await store.consume(token, { challengeId: "ch-other", version: "9.9.9" })).toBeNull();

    // ★ 关键断言:上面三次错配**没有**烧掉票据。
    expect(await store.consume(token, { challengeId: "ch-2", version: "1.0.0" })).not.toBeNull();
    // 这次正确消费之后才真的没了。
    expect(await store.consume(token, { challengeId: "ch-2", version: "1.0.0" })).toBeNull();
  });

  it("LaunchTicketStore:并发两次换票恰一次成功(单次消费原子性)", async () => {
    const store = new RedisLaunchTicketStore(redis, () => FIXED_NOW_SECONDS * 1000);
    const token = generateLaunchTicketToken();
    const binding = bindingFor("ch-3", "2.1.0", FIXED_NOW_SECONDS + 60);
    await store.put(token, binding, 60);

    const results = await Promise.all([
      store.consume(token, { challengeId: "ch-3", version: "2.1.0" }),
      store.consume(token, { challengeId: "ch-3", version: "2.1.0" }),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual(binding);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("LaunchTicketStore:TTL 到期 ⇒ 与「不存在」同形返回 null", async () => {
    const store = new RedisLaunchTicketStore(redis, () => Date.now());
    const token = generateLaunchTicketToken();
    // 键 TTL 与记录 expiresAt 同源同值(1 s)。
    const expiresAt = Math.floor(Date.now() / 1000) + 1;
    await store.put(token, bindingFor("ch-4", "1.0.0", expiresAt), 1);
    await sleep(1200);
    expect(await store.consume(token, { challengeId: "ch-4", version: "1.0.0" })).toBeNull();
  });

  it("LaunchTicketStore:记录内 expiresAt 已过期(键仍在)⇒ 拒绝并清除", async () => {
    // TTL 与 expiresAt 不同源时的兜底路径(应用时钟比较在 Lua 内)。
    const store = new RedisLaunchTicketStore(redis, () => FIXED_NOW_SECONDS * 1000);
    const token = generateLaunchTicketToken();
    await store.put(token, bindingFor("ch-5", "1.0.0", FIXED_NOW_SECONDS - 1), 300);
    expect(await store.consume(token, { challengeId: "ch-5", version: "1.0.0" })).toBeNull();
  });

  it("LaunchTicketStore:形态损坏的记录 ⇒ 按无有效记录处理(fail-closed)", async () => {
    const store = new RedisLaunchTicketStore(redis, () => FIXED_NOW_SECONDS * 1000);
    const kv = new RedisKeyValueStore(redis);
    const good = generateLaunchTicketToken();
    await kv.set(launchTicketKey(good), "{not json", 60);
    expect(await store.consume(good, { challengeId: "ch-6", version: "1.0.0" })).toBeNull();

    const missingField = generateLaunchTicketToken();
    await kv.set(launchTicketKey(missingField), JSON.stringify({ challengeId: "ch-6" }), 60);
    expect(await store.consume(missingField, { challengeId: "ch-6", version: "1.0.0" })).toBeNull();
  });

  it("LaunchTicketStore:未签发的票据 ⇒ null(与已消费 / 已过期同形)", async () => {
    const store = new RedisLaunchTicketStore(redis, () => FIXED_NOW_SECONDS * 1000);
    expect(
      await store.consume(generateLaunchTicketToken(), { challengeId: "ch-7", version: "1.0.0" }),
    ).toBeNull();
  });

  it("LaunchTicketStore:存储不可用 ⇒ PersistenceError(store_unavailable),不降级", async () => {
    const broken = new RedisLaunchTicketStore(
      {
        async call() {
          throw new Error("Connection is closed.");
        },
      },
      () => FIXED_NOW_SECONDS * 1000,
    );
    await expect(
      broken.consume(generateLaunchTicketToken(), { challengeId: "ch-8", version: "1.0.0" }),
    ).rejects.toMatchObject({ code: "store_unavailable" });
  });
});

describe.skipIf(IT_ENABLED)("容器门控未开启", () => {
  it(`Redis 集成测试跳过:${SKIP_REASON}`, () => {
    expect(IT_ENABLED).toBe(false);
  });
});
