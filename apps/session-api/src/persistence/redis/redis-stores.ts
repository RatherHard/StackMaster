/**
 * Redis 适配器(键值原语 / 路由 / 限流计数;D-API-24 分级:token / route /
 * rate 全部 fail-closed,依赖故障即稳定错误码确定性失败)。
 */

import { PersistenceError } from "../errors.js";
import type { KeyValueStore, RateLimitCounter, RouteStore } from "../ports.js";
import type { RedisLike } from "../idempotency-window.js";

/** 连接工厂(ioredis;等待 ready 后返回——fail-closed 分级要求故障在操作
 * 时即刻暴露,而非"连接建立前命令被拒绝"的启动竞态形态)。 */
export async function createRedisConnection(redisUrl: string): Promise<RedisLike> {
  const { Redis } = await import("ioredis");
  const client = new Redis(redisUrl, {
    // fail-closed:离线队列会吞掉故障时段的命令,使 fail-closed 语义退化;
    // 关闭后依赖故障立即表现为命令级错误。
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  await new Promise<void>((resolve, reject) => {
    if (client.status === "ready") {
      resolve();
      return;
    }
    client.once("ready", () => resolve());
    client.once("error", (error: Error) => reject(error));
  });
  return client as unknown as RedisLike;
}

/** 统一故障翻译:ioredis 的错误面收敛为稳定错误码(零底层细节外泄)。 */
function translate(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }
  return new PersistenceError("store_unavailable", "Redis 操作失败(fail-closed:依赖不可用)", {
    cause: error,
  });
}

/** 通用键值原语(GET / SET EX / GETDEL / DEL;token:{jti} 归 WP-2 消费)。 */
export class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.redis.call("GET", key);
      return typeof value === "string" ? value : null;
    } catch (error) {
      throw translate(error);
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new PersistenceError("invalid_identifier", "TTL 必须为正(键域全部带 TTL 纪律)");
    }
    try {
      await this.redis.call("SET", key, value, "EX", String(Math.floor(ttlSeconds)));
    } catch (error) {
      throw translate(error);
    }
  }

  async deleteIfPresent(key: string): Promise<boolean> {
    try {
      // GETDEL(Redis ≥ 6.2):取值与删除单命令原子,jti 单次消费原语。
      const value = await this.redis.call("GETDEL", key);
      return typeof value === "string";
    } catch (error) {
      throw translate(error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.call("DEL", key);
    } catch (error) {
      throw translate(error);
    }
  }
}

const ROUTE_PREFIX = "route:";

/** 会话路由键(route:{sessionId});绑定即覆盖,TTL 与会话保活节奏一致。 */
export class RedisRouteStore implements RouteStore {
  constructor(private readonly redis: RedisLike) {}

  async bind(sessionId: string, owner: string, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new PersistenceError("invalid_identifier", "TTL 必须为正(键域全部带 TTL 纪律)");
    }
    try {
      await this.redis.call("SET", `${ROUTE_PREFIX}${sessionId}`, owner, "EX", String(Math.floor(ttlSeconds)));
    } catch (error) {
      throw translate(error);
    }
  }

  async resolve(sessionId: string): Promise<string | null> {
    try {
      const owner = await this.redis.call("GET", `${ROUTE_PREFIX}${sessionId}`);
      return typeof owner === "string" ? owner : null;
    } catch (error) {
      throw translate(error);
    }
  }

  async release(sessionId: string): Promise<void> {
    try {
      await this.redis.call("DEL", `${ROUTE_PREFIX}${sessionId}`);
    } catch (error) {
      throw translate(error);
    }
  }
}

/** Lua:INCR + 首增立即 EXPIRE(单脚本原子,固定窗口锚定于首增)。 */
const RATE_LIMIT_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return v
`;

const RATE_PREFIX = "rate:";

/** 固定窗口原子计数器(rate:{tenant}:{user} 键域;消费方 WP-6)。 */
export class RedisRateLimitCounter implements RateLimitCounter {
  constructor(private readonly redis: RedisLike) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new PersistenceError("invalid_identifier", "窗口时长必须为正");
    }
    try {
      const count = await this.redis.call(
        "EVAL",
        RATE_LIMIT_LUA,
        "1",
        `${RATE_PREFIX}${key}`,
        String(Math.floor(windowSeconds)),
      );
      return typeof count === "number" ? count : Number(count);
    } catch (error) {
      throw translate(error);
    }
  }
}
