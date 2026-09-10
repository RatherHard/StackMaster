/**
 * create-session 限流守卫(任务分解 WP-6 第 1 条;D-API-35 接入点的 WP-6 执行面,
 * D-API-51 / D-API-52)。
 *
 * 挂载点:POST /sessions 的 `CreateSessionGuard.beforeCreate`(embed token 三方
 * 比对通过之后、题目装载之前,D-API-35)。本守卫承载两个维度的早期判定:
 *  1. 每租户 / 每用户请求频率:`rate:{tenant}:{user}` 固定窗口计数(WP-3
 *     RateLimitCounter),触顶 = 确定性拒绝(429 + 冻结形态,D-API-50);
 *  2. 每租户并发会话预算的**早期快检**(fail-fast:在题目装载等昂贵步骤前
 *     拒绝)。预算的**精确执行面**在 LiveSessionManager.createSession 的
 *     同步入场预留(首个 await 之前完成检查与预留,并发创建窗口不超卖,
 *     D-API-52)——守卫快检与精确执行面呈现同一冻结形态。
 *
 * 缺省未注入 = 放行(D-API-35 缺省形态;测试可注入替身)。
 */
import type { FastifyRequest } from "fastify";

import type { CreateSessionGuard } from "../routes/session-routes.js";
import type { Logger } from "pino";

import { ConcurrentSessionBudgetExhausted, RateLimitExceeded } from "./errors.js";
import { FixedWindowRateGate } from "./rate-gate.js";

/** 频率计数键(`rate:{tenant}:{user}`;WP-3 键域纪律)。 */
export function tenantUserRateKey(tenantId: string, userId: string): string {
  return `rate:${tenantId}:${userId}`;
}

export interface RateLimitedCreateSessionGuardOptions {
  /** 每租户 / 每用户请求频率闸(`rate:{tenant}:{user}` 固定窗口)。 */
  readonly rateGate: FixedWindowRateGate;
  /** 并发预算早期快检的计量源(LiveSessionManager 在途表;只读)。 */
  readonly liveCountByTenant: (tenantId: string) => number;
  readonly maxConcurrentSessionsPerTenant: number;
  readonly logger: Logger;
}

export class RateLimitedCreateSessionGuard implements CreateSessionGuard {
  readonly #options: RateLimitedCreateSessionGuardOptions;
  readonly #log: Logger;

  constructor(options: RateLimitedCreateSessionGuardOptions) {
    this.#options = options;
    this.#log = options.logger.child({ component: "create-session-guard" });
  }

  async beforeCreate(
    _request: FastifyRequest,
    identity: {
      readonly tenantId: string;
      readonly userId: string;
      readonly challengeId: string;
      readonly challengeVersion: string;
    },
  ): Promise<void> {
    if (!(await this.#options.rateGate.tryAcquire(tenantUserRateKey(identity.tenantId, identity.userId)))) {
      this.#log.warn(
        { tenantId: identity.tenantId, reason: "request_rate_exceeded" },
        "create_session rejected by rate guard",
      );
      throw new RateLimitExceeded("request_rate", "create-session rate:{tenant}:{user} window exceeded");
    }
    const live = this.#options.liveCountByTenant(identity.tenantId);
    if (live >= this.#options.maxConcurrentSessionsPerTenant) {
      this.#log.warn(
        { tenantId: identity.tenantId, reason: "concurrent_budget_exceeded_early_check" },
        "create_session rejected by concurrent budget early check",
      );
      throw new ConcurrentSessionBudgetExhausted(
        `tenant ${identity.tenantId} early check: live ${live} >= budget ${this.#options.maxConcurrentSessionsPerTenant}`,
      );
    }
  }
}
