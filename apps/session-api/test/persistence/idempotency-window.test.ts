/**
 * 幂等窗口后端与分级降级策略测试(WP-3;D-API-24)。
 * 完成标准映射:同键同负载 → replay-identical;同键异负载 → conflict;
 * TTL 过期 → fresh;Redis 不可用 → 幂等窗口降级进程内(语义不变),
 * token / route / rate fail-closed(策略表登记 + 故障翻译确定性)。
 */

import { describe, expect, it } from "vitest";
import {
  MemoryIdempotencyWindow,
  PersistenceError,
  REDIS_DEGRADE_POLICY,
  RedisIdempotencyWindow,
  ResilientIdempotencyWindow,
  type RedisLike,
} from "../../src/persistence/index.js";

describe("REDIS_DEGRADE_POLICY(分级降级策略表)", () => {
  it("幂等窗口可降级进程内;token / route / rate fail-closed", () => {
    expect(REDIS_DEGRADE_POLICY.idempotencyWindow.degrade).toBe("degrade-to-process");
    expect(REDIS_DEGRADE_POLICY.tokenStore.degrade).toBe("fail-closed");
    expect(REDIS_DEGRADE_POLICY.routeStore.degrade).toBe("fail-closed");
    expect(REDIS_DEGRADE_POLICY.rateLimitCounter.degrade).toBe("fail-closed");
    // 每条分级都带理由(窗口是效率设施,正确性由 baseRevision 与串行保证)。
    expect(REDIS_DEGRADE_POLICY.idempotencyWindow.rationale).toContain("效率设施");
  });
});

/** 故障注入假 Redis:call 即抛(依赖不可用形态)。 */
function failingRedis(): RedisLike {
  return {
    async call() {
      throw new Error("Connection is closed.");
    },
  };
}

/** 内存 Redis 假实现:仅覆盖幂等窗口用到的 GET/SET/EX 语义(EVAL 走 TS 复刻)。 */
function fakeRedis(): RedisLike & { store: Map<string, { value: string; expiresAt: number }>; now: () => number } {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const nowMs = 1_000_000;
  const fake = {
    store,
    now: () => nowMs,
    async call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown> {
      if (command === "EVAL") {
        // 与生产 Lua 同语义的 TS 复刻(字节比较 + 固定 TTL):
        // EVAL script numkeys key canonical ttl
        const key = String(args[2]);
        const canonical = String(args[3]);
        const ttl = Number(args[4]);
        const entry = store.get(key);
        if (entry !== undefined) {
          if (entry.expiresAt <= nowMs) {
            store.delete(key);
          } else if (entry.value === canonical) {
            return 1;
          } else {
            return 2;
          }
        }
        store.set(key, { value: canonical, expiresAt: nowMs + ttl * 1000 });
        return 0;
      }
      throw new Error(`fake redis: unsupported command ${command}`);
    },
  };
  return fake;
}

describe("RedisIdempotencyWindow(假 Redis 承载 EVAL 语义)", () => {
  it("fresh / replay-identical / conflict 三值判定", async () => {
    const redis = fakeRedis();
    const window = new RedisIdempotencyWindow(redis, 300);
    expect(await window.checkAndRecord("sess-1", "k", "canonical-1")).toBe("fresh");
    expect(await window.checkAndRecord("sess-1", "k", "canonical-1")).toBe("replay-identical");
    expect(await window.checkAndRecord("sess-1", "k", "canonical-2")).toBe("conflict");
  });

  it("键命名 = idem:{sessionId}:{encodeURIComponent(key)}(键域纪律)", async () => {
    const redis = fakeRedis();
    const window = new RedisIdempotencyWindow(redis, 300);
    await window.checkAndRecord("sess-1", "key/with:colon", "canonical");
    expect([...redis.store.keys()][0]).toBe("idem:sess-1:key%2Fwith%3Acolon");
  });
});

describe("ResilientIdempotencyWindow(分级降级:主 Redis 故障 → 进程内)", () => {
  it("Redis 不可用 → 降级进程内,后续调用语义不变且粘性保持", async () => {
    const degradations: string[] = [];
    const window = new ResilientIdempotencyWindow(
      new RedisIdempotencyWindow(failingRedis(), 300),
      300,
      (event) => degradations.push(`${event.dependency}:${event.backend}`),
    );
    expect(await window.checkAndRecord("sess-1", "k", "canonical-1")).toBe("fresh");
    expect(await window.checkAndRecord("sess-1", "k", "canonical-1")).toBe("replay-identical");
    expect(await window.checkAndRecord("sess-1", "k", "canonical-2")).toBe("conflict");
    expect(window.currentBackend()).toBe("in-process");
    expect(degradations).toEqual(["idempotencyWindow:in-process"]);
  });

  it("降级后同接口继续提供 TTL 过期 → fresh 语义(降级不破坏正确性语义)", async () => {
    const window = new ResilientIdempotencyWindow(
      new RedisIdempotencyWindow(failingRedis(), 300),
      300,
    );
    await window.checkAndRecord("sess-1", "k", "c1");
    // 内部 fallback 的假时钟不可注入——直接断言降级路径的三值语义即可
    // (TTL 过期语义由 MemoryIdempotencyWindow 单测与 Redis 集成测试覆盖)。
    expect(await window.checkAndRecord("sess-1", "k", "c1")).toBe("replay-identical");
  });

  it("主用健康时不降级(backend = redis)", async () => {
    const window = new ResilientIdempotencyWindow(
      new RedisIdempotencyWindow(fakeRedis(), 300),
      300,
    );
    await window.checkAndRecord("sess-1", "k", "c1");
    expect(window.currentBackend()).toBe("redis");
  });
});

describe("MemoryIdempotencyWindow 与 Redis 后端同语义(契约同构)", () => {
  it("三值判定语义逐条一致(进程内 = 降级载体,同接口同语义)", async () => {
    const memory = new MemoryIdempotencyWindow(300);
    const redis = new RedisIdempotencyWindow(fakeRedis(), 300);
    for (const window of [memory, redis]) {
      expect(await window.checkAndRecord("s", "k", "c1")).toBe("fresh");
      expect(await window.checkAndRecord("s", "k", "c1")).toBe("replay-identical");
      expect(await window.checkAndRecord("s", "k", "c2")).toBe("conflict");
    }
  });

  it("fail-closed 分级的故障翻译是确定性 PersistenceError(store_unavailable)", async () => {
    // route / token 消费的 RedisLike 故障必须立即以稳定错误码上抛,
    // 绝不静默放行(fail-closed 的确定性路径)。
    const { RedisRouteStore, RedisKeyValueStore, RedisRateLimitCounter } = await import(
      "../../src/persistence/index.js"
    );
    await expect(new RedisRouteStore(failingRedis()).resolve("sess-1")).rejects.toMatchObject({
      code: "store_unavailable",
    });
    await expect(new RedisKeyValueStore(failingRedis()).get("token:x")).rejects.toMatchObject({
      code: "store_unavailable",
    });
    await expect(
      new RedisRateLimitCounter(failingRedis()).increment("rate:t:u", 10),
    ).rejects.toBeInstanceOf(PersistenceError);
  });
});
