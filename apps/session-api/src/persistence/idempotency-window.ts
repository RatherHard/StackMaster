/**
 * 幂等窗口 Redis 后端 + 分级降级策略(D-W8-9;D-API-24)。
 *
 * Redis 键域四键域的**可用性分级**(权威 API 语义规约 D-API-24):
 *  - `idem:{sessionId}:{key}`(幂等窗口):**可降级进程内**——协议 §4.3
 *    "窗口是效率设施,正确性由 baseRevision 与单会话串行保证";Redis 不可
 *    用时损失的是跨实例共享窗口,不损失协议正确性;
 *  - `token:{jti}`(WP-2 消费)、`route:{sessionId}`、`rate:{tenant}:{user}`:
 *    **不可降级,fail-closed**——单次消费凭证与路由定位是安全 / 一致性控制,
 *    降级即语义破坏;依赖故障时操作以稳定错误码确定性失败(不静默放行)。
 *
 * 键命名:`idem:{sessionId}:{key}`,key 分量经 encodeURIComponent 编码
 * (幂等键为客户端输入,编码保形防键分隔符注入;D-API-24)。
 * TTL:固定窗口——TTL 自首次登记起算,重放命中**不续期**(无限重试不得到
 * 无限窗口);过期后同键重新登记为 fresh(完成标准的 TTL 过期路径)。
 */

import { PersistenceError } from "./errors.js";
import type { IdempotencyVerdict, IdempotencyWindow } from "./ports.js";
import { MemoryIdempotencyWindow } from "./memory-stores.js";

/** 最小 Redis 客户端面(ioredis 实例结构兼容;测试可注入假客户端)。 */
export interface RedisLike {
  call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown>;
}

/** Redis 键域依赖分级登记(D-API-24;策略表即文档,代码即裁决点)。 */
export type RedisDependency = "idempotencyWindow" | "tokenStore" | "routeStore" | "rateLimitCounter";
export type DegradeClass = "degrade-to-process" | "fail-closed";

export const REDIS_DEGRADE_POLICY: Readonly<
  Record<RedisDependency, { degrade: DegradeClass; rationale: string }>
> = {
  idempotencyWindow: {
    degrade: "degrade-to-process",
    rationale: "窗口是效率设施,正确性由 baseRevision 与单会话串行保证(协议 §4.3)",
  },
  tokenStore: {
    degrade: "fail-closed",
    rationale: "jti 单次消费是凭证重放防线,降级即语义破坏(WP-2 经 KeyValueStore 原语消费)",
  },
  routeStore: {
    degrade: "fail-closed",
    rationale: "会话路由定位是投递一致性控制,降级会造成双属主投递歧义",
  },
  rateLimitCounter: {
    degrade: "fail-closed",
    rationale: "限流计数是资源保护控制,降级即敞开请求面(保守取 fail-closed;数值策略归 WP-6)",
  },
};

/** Lua:同键同负载 → 1(replay-identical);同键异负载 → 2(conflict);
 *  未登记 → 原子 SET NX 语义登记并返回 0(fresh)。固定 TTL 不续期。 */
const IDEMPOTENCY_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then
  if cur == ARGV[1] then return 1 end
  return 2
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 0
`;

function idemKey(sessionId: string, key: string): string {
  return `idem:${sessionId}:${encodeURIComponent(key)}`;
}

/** 幂等窗口 Redis 后端(原子比较并登记;TTL 由构造参数注入 config 值)。 */
export class RedisIdempotencyWindow implements IdempotencyWindow {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number,
  ) {}

  async checkAndRecord(sessionId: string, key: string, canonicalRequest: string): Promise<IdempotencyVerdict> {
    const result = (await this.redis.call(
      "EVAL",
      IDEMPOTENCY_LUA,
      "1",
      idemKey(sessionId, key),
      canonicalRequest,
      this.ttlSeconds,
    )) as unknown;
    if (result === 0) {
      return "fresh";
    }
    if (result === 1) {
      return "replay-identical";
    }
    if (result === 2) {
      return "conflict";
    }
    throw new PersistenceError("store_unavailable", "幂等窗口返回了不可解释的结果");
  }
}

/** 降级通知(可观测面:结构化事件,不携带任何请求载荷)。 */
export type DegradeListener = (event: {
  dependency: "idempotencyWindow";
  backend: "redis" | "in-process";
  reason: string;
}) => void;

/**
 * 弹性幂等窗口:主用 Redis,故障即粘性降级到进程内实现(同接口)。
 * 一旦降级,进程生命周期内保持降级(探测恢复属演进项;重启即复位)。
 * 载荷纪律:错误原因只取 message 语义,不透传底层响应体。
 */
export class ResilientIdempotencyWindow implements IdempotencyWindow {
  private readonly fallback: MemoryIdempotencyWindow;
  private backend: "redis" | "in-process" = "redis";

  constructor(
    private readonly primary: IdempotencyWindow,
    ttlSeconds: number,
    private readonly onDegrade?: DegradeListener,
  ) {
    this.fallback = new MemoryIdempotencyWindow(ttlSeconds);
  }

  currentBackend(): "redis" | "in-process" {
    return this.backend;
  }

  async checkAndRecord(sessionId: string, key: string, canonicalRequest: string): Promise<IdempotencyVerdict> {
    if (this.backend === "in-process") {
      return this.fallback.checkAndRecord(sessionId, key, canonicalRequest);
    }
    try {
      return await this.primary.checkAndRecord(sessionId, key, canonicalRequest);
    } catch (error) {
      this.backend = "in-process";
      this.onDegrade?.({
        dependency: "idempotencyWindow",
        backend: "in-process",
        reason: error instanceof Error ? error.message : "primary unavailable",
      });
      // 窗口是效率设施(协议 §4.3):本次调用以进程内窗口继续承载,语义不变。
      return this.fallback.checkAndRecord(sessionId, key, canonicalRequest);
    }
  }
}
