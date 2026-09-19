/**
 * Redis 适配器(键值原语 / 路由 / 限流计数;D-API-24 分级:token / route /
 * rate 全部 fail-closed,依赖故障即稳定错误码确定性失败)。
 */

import { PersistenceError } from "../errors.js";
import type {
  KeyValueStore,
  LaunchTicketBinding,
  LaunchTicketRedemptionKey,
  LaunchTicketStore,
  RateLimitCounter,
  RouteStore,
} from "../ports.js";
import type { RedisLike } from "../idempotency-window.js";
import { launchTicketKey } from "../../launch/ticket-token.js";

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

// ── 启动票据键域(launch:{jti};WP-91,D-LT-2)────────────────────────────

/**
 * Lua:**比较并交换**式原子消费(WP-91;D-LT-2「单次消费」行)。
 *
 * 三步全在**同一个脚本**内完成(Redis 单线程执行脚本 ⇒ 整个脚本对其它客户端
 * 是原子的;这是"并发两次换票恰一次成功"的**唯一**保证来源,不是应用层的锁):
 *
 *  1. **不存在** ⇒ `false`(nil 应答):未签发 / 已消费 / TTL 自然过期,三态同形;
 *  2. **形态损坏 / 绑定不符** ⇒ `false` **且不删除**:
 *     - 形态损坏(非 JSON / 非 table / 字段类型不符)按"无有效记录"处理并
 *       **删除**(fail-closed:损坏记录永不能通过任何比较,留着只会反复解码;
 *       这与 `KeyValueTokenIssuanceStore.decodeIssuedRecord` 的 fail-closed 同纪律);
 *     - 绑定不符**绝不删除**:否则任何人拿票据配一个错 URL 打开一次即可把
 *       合法持有者的票据烧掉(可用性攻击面;见端口 `consume` 文档第 1 条);
 *  3. **值内过期兜底** ⇒ `false` 且删除:TTL 与 `expiresAt` 本应同源同值,但
 *     TTL 是 Redis 时钟、`expiresAt` 是应用时钟,两者可能在边界上不一致 ⇒
 *     再用应用侧 `now`(ARGV[3],由调用方注入,可测)做一次显式比较。
 *     任一不满足即拒绝(**取二者中更严的那个**)。
 *
 * 成功路径返回**原始 JSON 串**(而不是在 Lua 里拆字段返回数组):JSON 解码与
 * 最小形状校验统一收在 TS 侧一处(`decodeLaunchTicketBinding`),Lua 只管
 * 比较与删除 —— 跨语言双份解码逻辑是这个仓库已经踩过的漂移面。
 *
 * Redis 侧返回类型:`cur`(字符串)⇒ bulk string;`false` ⇒ nil 应答。
 */
const LAUNCH_TICKET_CONSUME_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return false end
local ok, rec = pcall(cjson.decode, cur)
if not ok or type(rec) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return false
end
local cid = rec['challengeId']
local ver = rec['version']
local exp = rec['expiresAt']
if type(cid) ~= 'string' or type(ver) ~= 'string' or type(exp) ~= 'number' then
  redis.call('DEL', KEYS[1])
  return false
end
if cid ~= ARGV[1] or ver ~= ARGV[2] then return false end
if exp <= tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
  return false
end
redis.call('DEL', KEYS[1])
return cur
`;

/**
 * 票据绑定记录的最小形状校验(存储是权威锚;**形态损坏 = 无有效记录**)。
 *
 * 与 `decodeIssuedRecord` 同纪律:消费侧不信任存储载荷形态,损坏即按
 * "没有这张票"处理(fail-closed 拒绝消费,不抛错、不半态)。
 *
 * ⚠ `tenantId` 的取值合法性**不在这里**判定 —— 它由签发时的租户派生路径
 * 保证(白名单成员)。这里只做**类型与存在性**判定;把取值语义判据塞进
 * 反序列化会造出第二个租户裁决点(D-LT-2「URL / body 参数永不进入租户派生
 * 路径」要求租户派生**唯一**)。
 */
function decodeLaunchTicketBinding(raw: string): LaunchTicketBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { tenantId, challengeId, version, expiresAt } = record;
  if (
    typeof tenantId !== "string" ||
    tenantId.length === 0 ||
    typeof challengeId !== "string" ||
    challengeId.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt)
  ) {
    return null;
  }
  return { tenantId, challengeId, version, expiresAt };
}

/**
 * 启动票据存储的 Redis 适配器(`launch:{jti}` 键域)。
 *
 * 分级 = **fail-closed**(D-LT-2;登记于 `idempotency-window.ts` 的
 * `REDIS_DEGRADE_POLICY`):一切故障经 `translate` 收敛为
 * `PersistenceError("store_unavailable")` ⇒ 既有 `error-mapping` 矩阵天然
 * 得 **503 `storage unavailable`**。**不降级进程内、不静默放行、不自造错误形态**
 * —— 票据单次消费是重放防线,降级即语义破坏。
 *
 * `now` 由构造参数注入(秒):它是 Lua 内过期兜底比较的输入,注入使该路径
 * 可被测试驱动(与 `MemoryLaunchTicketStore` 同形)。
 */
export class RedisLaunchTicketStore implements LaunchTicketStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly now: () => number = Date.now,
  ) {}

  async put(token: string, binding: LaunchTicketBinding, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new PersistenceError("invalid_identifier", "TTL 必须为正(键域全部带 TTL 纪律)");
    }
    try {
      // TTL 由 Redis 强制(键域"全部带 TTL"纪律,ADR-4);记录内另带
      // expiresAt 供 Lua 做应用时钟兜底比较(见 LAUNCH_TICKET_CONSUME_LUA)。
      await this.redis.call(
        "SET",
        launchTicketKey(token),
        JSON.stringify(binding),
        "EX",
        String(Math.floor(ttlSeconds)),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  async consume(
    token: string,
    expected: LaunchTicketRedemptionKey,
  ): Promise<LaunchTicketBinding | null> {
    let raw: unknown;
    try {
      raw = await this.redis.call(
        "EVAL",
        LAUNCH_TICKET_CONSUME_LUA,
        "1",
        launchTicketKey(token),
        expected.challengeId,
        expected.version,
        String(Math.floor(this.now() / 1000)),
      );
    } catch (error) {
      throw translate(error);
    }
    // Redis 的 nil 应答在 ioredis 侧为 null(null 与 false 都收敛到这里)。
    if (typeof raw !== "string") {
      return null;
    }
    // 形态损坏 ⇒ null(与"没有这张票"同形;原因只进受控日志面,不进端口面)。
    return decodeLaunchTicketBinding(raw);
  }
}
