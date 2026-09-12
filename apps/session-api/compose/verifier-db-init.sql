-- verifier 独立 PG 角色治理(WP-61;信任域 4,与 session-api 不共享凭证)。
--
-- 最小授权面(D-API-87;与 004 / 005 迁移的裁决域结构配套):
--   submissions / challenge_versions / challenges  —— 只读(裁决引用与登记摘要);
--   verifier_runs                                  —— SELECT / INSERT / UPDATE(认领与状态机);
--   verdicts                                       —— SELECT / INSERT(幂等落库,无更新面)。
-- 无 DELETE / 无 DDL / 无其余表域授权——行级策略(RLS)归 WP-65 全表域启用。
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
