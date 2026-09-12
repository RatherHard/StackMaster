-- verifier 独立 PG 角色治理(WP-61;信任域 4,与 session-api 不共享凭证;
-- WP-65 行级租户政策形态说明,D-API-101)。
--
-- 最小授权面(D-API-87;与 004 / 005 迁移的裁决域结构配套):
--   submissions / challenge_versions / challenges  —— 只读(裁决引用与登记摘要);
--   verifier_runs                                  —— SELECT / INSERT / UPDATE(认领与状态机);
--   verdicts                                       —— SELECT / INSERT(幂等落库,无更新面)。
-- 无 DELETE / 无 DDL / 无其余表域授权。
--
-- 行级租户政策(007 迁移 / D-API-101):RLS 对本角色强制(ENABLE + FORCE,
-- rolbypassrls = false——非旁路角色),政策按角色分立 = TO verifier USING (true)
-- 的信任域 4 放行政策:裁决队列消费的跨租户读取与租户维度落库是设计内访问
-- 面(verifier 不注入 app.tenant_id);政策放行不等于授权,写越权仍由本脚本
-- 的 GRANT 面维持(政策与授权双层正交)。
--
-- 幂等形态:角色与授权均可重复执行(compose 一次性 init 服务在既有卷上
-- 重复运行安全)。执行前置:session-api 已完成迁移(004 / 005 已应用)。
-- 凭据为本地开发 / CI 专用合成值,严禁用于任何真实环境。

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verifier') THEN
    CREATE ROLE verifier LOGIN PASSWORD 'verifier-dev';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO verifier;

GRANT SELECT ON submissions TO verifier;
GRANT SELECT ON challenges TO verifier;
GRANT SELECT ON challenge_versions TO verifier;
GRANT SELECT, INSERT, UPDATE ON verifier_runs TO verifier;
GRANT SELECT, INSERT ON verdicts TO verifier;

-- 审计发射面预留(WP-64 Q5 定案 / WP-62 接线,D-API-90 / 93):verifier 可
-- 追加裁决域审计事件(verdict_completed / verdict_replay_failed / verdict_rejected);
-- 零 UPDATE / 零 DELETE(append-only,库层触发器同拒;kind CHECK 同约束)。
GRANT INSERT ON audit_log TO verifier;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO verifier;
