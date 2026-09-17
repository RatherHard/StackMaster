/**
 * 管理面查询审计(D-MP-5 分支 A;D-API-136)。
 *
 * ── 硬约束:审计 kind 是十值封闭集(D-API-90,D-API-59 收口)────────────
 * `apps/session-api/src/auth/ports.ts` 的 `AUDIT_EVENT_KINDS` 与 006 迁移的
 * `audit_log_kind_closed_set` CHECK 把审计账锁在十值。十值全部是**状态变更
 * 或凭证事实**(签发 / 消费 / 吊销 / 建会话 / 提交 / 强制关闭 / 三个裁决域
 * 事实),**没有**任何"查询 / 读取"种类。管理面查询是**运维读取事实**,
 * 不是安全事件账里的状态变更事实:
 *
 *  - 复用既有 kind 会伪造安全事实(把一次读取记成 `submit` / `verdict_*`
 *    是账目污染,不是节约);
 *  - 新增 kind 必须按 D-API-59 口径重开「安全事件账 vs 运维事件账」论证
 *    (十值一次性定案的开口),**不属本 WP 权限范围**——本 WP 不新增 kind。
 *  - 先例:D-API-92 归档动作同属运维事件,同样**不进审计账**,走受控日志
 *    + `/metrics` 计数器。本条沿同一裁决口径。
 *
 * ── 因此:管理面查询审计 = 受控日志 + 指标计数器,且 fail-closed ─────────
 * 审计落点在**响应下发之前**:`record()` 抛错 ⇒ 路由以 503 冻结形态收口,
 * **零数据下发**(读取可能已在内存中发生,但不构成披露——披露点是响应)。
 * 记录内容零秘密:surface / outcome / 绑定租户 / 系统主体 / 时刻;凭证值与
 * 摘要、呈递头、请求原文一律不入记录。
 *
 * ── 结构性的第二重保证 ────────────────────────────────────────────────
 * 管理面数据连接角色是 `admin_ro`,其对 `audit_log` **只有 SELECT 之外的
 * 零授权**(compose/admin-db-init.sql:最小授权面 = 五个只读表,audit_log
 * 零 GRANT)⇒ 即使实现被误改为写审计账,库层也会确定性拒绝。运维读取事实
 * 由受控日志承载,是"账目归属"而不是"授权不足"的结果——两者互相独立,
 * 都指向同一结论。
 */
import type { Logger } from "pino";

import type { AdminOutcome, AdminSurface } from "../metrics.js";

/** 受控日志事件名(固定字面;日志面即本账的唯一出口)。 */
export const ADMIN_QUERY_AUDIT_EVENT = "admin_query";

/**
 * 管理面查询审计记录。
 *
 * `tenantId` 已由凭证绑定集合解析(绝不来自请求体);`outcome = denied` 的
 * 记录(凭证被拒)不带租户——那时没有任何租户上下文可得,凭空填一个就是
 * 伪造账目。
 */
export interface AdminQueryAuditRecord {
  readonly surface: AdminSurface;
  readonly outcome: AdminOutcome;
  /** 绑定解析后的租户(仅数据面经凭证校验后的记录携带)。 */
  readonly tenantId?: string;
  /** 系统主体标识(固定字面;管理面没有逐用户主体,D-API-134)。 */
  readonly actor: string;
  /** 事件时刻(Unix epoch 毫秒;测试可注入 now)。 */
  readonly at: number;
}

/** 审计端口(append-only 语义:只有 record,没有更新 / 删除)。 */
export interface AdminQueryAudit {
  record(entry: AdminQueryAuditRecord): Promise<void>;
}

/** 审计主体(管理面系统主体;与会话 / 宿主面的 actor 字面不同域)。 */
export const ADMIN_AUDIT_ACTOR = "admin";

/** 受控日志实现(Pino 单一出口;零凭证材料、零请求原文)。 */
export class ControlledLogAdminQueryAudit implements AdminQueryAudit {
  constructor(private readonly logger: Logger) {}

  record(entry: AdminQueryAuditRecord): Promise<void> {
    // 结构化字段全部是有界枚举 + 数字 + 绑定租户标识符;凭证值 / 摘要 /
    // Authorization 头 / 查询串原文都不在字段表里(零秘密面)。
    this.logger.info(
      {
        event: ADMIN_QUERY_AUDIT_EVENT,
        surface: entry.surface,
        outcome: entry.outcome,
        actor: entry.actor,
        at: entry.at,
        ...(entry.tenantId === undefined ? {} : { tenantId: entry.tenantId }),
      },
      "admin read-only query audited",
    );
    return Promise.resolve();
  }
}

/** 测试 / 内存实现(可注入失败,用于 fail-closed 红灯)。 */
export class MemoryAdminQueryAudit implements AdminQueryAudit {
  readonly entries: AdminQueryAuditRecord[] = [];
  /** 注入失败开关:设值后 record 恒抛(证明零数据下发)。 */
  failWith: Error | null = null;

  record(entry: AdminQueryAuditRecord): Promise<void> {
    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }
    this.entries.push(entry);
    return Promise.resolve();
  }
}
