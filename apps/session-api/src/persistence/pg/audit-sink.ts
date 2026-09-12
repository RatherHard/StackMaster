/**
 * PostgreSQL 审计落库实现(WP-64;阶段六 D-API-33 已知留白收口,D-API-91)。
 *
 * 端口语义零改动(D-API-18 ② / D-API-33):只有 append,无更新 / 删除路径
 * (append-only 端口形状即第一强制层);数据库层由 `audit_log` 上的
 * BEFORE UPDATE / DELETE / TRUNCATE 触发器一律 RAISE EXCEPTION(第二强制层,
 * migrations/006,`action_log` 同款纪律 D-API-22),应用连接角色的
 * REVOKE UPDATE/DELETE 为部署面第三层(D-API-93,compose/session-api-db-init.sql)。
 *
 * fail-closed 语义:落库失败以 PersistenceError(store_unavailable)上抛,
 * 绝不静默吞没——审计是安全事件账,append 失败即调用方(签发 / 消费 /
 * 生命周期)同步失败(与既有 InMemory 调用点的 await 传播行为同构;
 * D-API-33"审计失败不得静默"方向)。错误消息只含稳定语义文案,零载荷
 * 细节(与持久化面错误纪律同源)。
 */

import type { Pool } from "pg";
import { TenantScope } from "./connection.js";
import type { AuditEvent, AuditSink } from "../../auth/ports.js";
import { PersistenceError } from "../errors.js";

export class PgAuditSink implements AuditSink {
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    // 行级租户策略第二道结构闸的注入点(007 迁移 / D-API-101):逐事务
    // SET LOCAL app.tenant_id;audit_log_tenant_insert 政策 WITH CHECK 使
    // 行租户与注入租户强制一致(跨租户审计发射在库层确定性拒绝)。
    this.#scope = new TenantScope(pool);
  }

  async append(event: AuditEvent): Promise<void> {
    try {
      await this.#scope.query(
        event.actor.tenantId,
        `INSERT INTO audit_log (kind, at, tenant_id, user_id, session_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          event.kind,
          // 事件时刻(epoch 毫秒 → timestamptz;归档序列化以 ISO 往返)。
          new Date(event.at),
          event.actor.tenantId,
          event.actor.userId,
          event.sessionId ?? null,
          event.detail === undefined ? null : JSON.stringify(event.detail),
        ],
      );
    } catch (error) {
      throw new PersistenceError("store_unavailable", "审计事件落库失败(append-only,fail-closed)", {
        cause: error,
      });
    }
  }
}
