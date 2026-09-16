-- 拓扑级应用角色创建(WP-78 收口;全新数据卷确定性收敛)。
--
-- ── 为什么角色创建必须前移(缺陷 ① 定案)───────────────────────────────
-- 迁移 007_row_level_security 以 `CREATE POLICY ... TO session_app` /
-- `TO verifier` 引用两个应用连接角色 ⇒ **角色必须早于 session-api 启动时
-- 的迁移存在**。角色创建原先只挂在两个角色治理 init 服务里,而这两个服务
-- 的 depends_on = session-api: service_healthy —— 与迁移形成死锁:
--   session-api 启动 → 迁移 007 报 `role "session_app" does not exist`
--   (PersistenceError,已回滚)→ 进程退出 → 永不 healthy → 两个 init 永不
--   执行 → 角色永不创建。全新数据卷上无论等多久都不收敛。
-- 本文件 = 该环的破环点:唯一拓扑级角色创建来源,执行序见 compose/app.yaml
-- 文件头(postgres healthy → db-roles-init completed → session-api healthy)。
--
-- ── 形态 ──────────────────────────────────────────────────────────────
-- 一次性服务 `db-roles-init`(compose/app.yaml;镜像 postgres:16,管理面
-- 凭据,restart: "no"),零安装依赖 / 零新增运行时面。
-- 授权面(GRANT / REVOKE)不在此文件:仍由 session-api-db-init.sql 与
-- verifier-db-init.sql 按角色分域承载(单点创建 + 分域授权,职责不重叠)。
--
-- ── 幂等 ──────────────────────────────────────────────────────────────
-- IF NOT EXISTS 守卫:既有卷重复运行安全(角色已在场时零目录写,故与任何
-- 并发执行者也无 pg_authid 写冲突)。未显式设置 SUPERUSER / BYPASSRLS /
-- CREATEDB / CREATEROLE ⇒ 缺省 false(RLS 强制保持的前提,见文件末只读
-- 断言)。
-- 口令与两个治理 init 文件保持一致(单一口令来源 = 本文件;零口令变更)。
-- 凭据为本地开发 / CI 专用合成值,严禁用于任何真实环境。

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'session_app') THEN
    CREATE ROLE session_app LOGIN PASSWORD 'session-app-dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verifier') THEN
    CREATE ROLE verifier LOGIN PASSWORD 'verifier-dev';
  END IF;
END
$$;

-- ── 只读不变量断言(零目录写)─────────────────────────────────────────
-- 角色属性是行级租户策略的强制前提:两个角色都不得是超级用户 / RLS 旁路角色
-- (007 的 ENABLE + FORCE ROW LEVEL SECURITY 只对非旁路角色成立)。
-- 若既有卷上出现被手工提权的角色,这里以确定性失败暴露,而非静默放行。
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname IN ('session_app', 'verifier') AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION '角色 session_app / verifier 不得为超级用户或 BYPASSRLS 角色(行级租户策略强制前提,D-API-101)';
  END IF;
END
$$;
