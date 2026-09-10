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
  RedisRateLimitCounter,
  RedisRouteStore,
  createRedisConnection,
  type RedisLike,
} from "../../src/persistence/index.js";
import { IT_ENABLED, IT_CONFIG, SKIP_REASON, sleep, uniqueIds } from "./helpers/it.js";

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
});

describe.skipIf(IT_ENABLED)("容器门控未开启", () => {
  it(`Redis 集成测试跳过:${SKIP_REASON}`, () => {
    expect(IT_ENABLED).toBe(false);
  });
});
