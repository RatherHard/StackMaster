-- session-api 应用连接角色治理(WP-64;D-API-22 第二层的阶段六落地面 / D-API-93)。
--
-- 与 verifier-db-init.sql(WP-61 先例)同形态的一次性 init:独立最小授权角色
-- session_app,REVOKE UPDATE/DELETE 于两本 append-only 账(action_log / audit_log)
-- ——迁移 006 的库层触发器为第一强制层,本脚本的角色治理为第二层。
-- 生产连线义务(D-API-93 登记):应用连接应使用本角色(SESSION_API_POSTGRES_URL
-- 指向最小授权凭证),不得使用表属主(属主的隐含权利不受 REVOKE 影响);
-- compose dev 拓扑沿用管理面凭证属角色治理降级,如实登记(CI 始终完整拓扑)。
--
-- 幂等形态:角色与授权均可重复执行(一次性 init 服务在既有卷上重复运行安全)。
-- 执行前置:session-api 已完成迁移(006 已应用,audit_log 在场)。
-- 凭据为本地开发 / CI 专用合成值,严禁用于任何真实环境。

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'session_app') THEN
    CREATE ROLE session_app LOGIN PASSWORD 'session-app-dev';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO session_app;

-- ── append-only 账:只有 SELECT / INSERT,零 UPDATE / DELETE / TRUNCATE ──
GRANT SELECT, INSERT ON action_log TO session_app;
GRANT SELECT, INSERT ON audit_log TO session_app;
GRANT SELECT, INSERT ON audit_archive_batches TO session_app;
REVOKE UPDATE, DELETE, TRUNCATE ON action_log FROM session_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM session_app;

-- ── 会话域 / 裁决域 / 题目域:按应用端口实际面最小授予 ──
GRANT SELECT, INSERT, UPDATE ON sessions TO session_app;
GRANT SELECT, INSERT, DELETE ON checkpoints TO session_app; -- DELETE 仅保留期清理 sanction(D-API-20 / 25)
GRANT SELECT, INSERT ON submissions TO session_app;
GRANT SELECT, INSERT ON verifier_runs TO session_app;       -- submit 入队(D-API-85)
GRANT SELECT ON verdicts TO session_app;                    -- 裁决呈现面姿态(D-API-83;WP-63 接线)
GRANT SELECT, INSERT, UPDATE ON challenges TO session_app;  -- upsert(登记路径)
GRANT SELECT, INSERT ON challenge_versions TO session_app;
GRANT SELECT, INSERT, UPDATE ON _session_api_migrations TO session_app; -- 迁移记账

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO session_app;
