-- 拓扑级应用角色创建(WP-78 / WP-79 收口;全新数据卷确定性收敛)。
--
-- ── 为什么角色创建必须前移(缺陷 ① 定案)───────────────────────────────
-- 迁移 007_row_level_security 以 `CREATE POLICY ... TO session_app` /
-- `TO verifier` 引用两个应用连接角色 ⇒ **角色必须先于任何迁移存在**。
-- 角色创建原先只挂在两个角色治理 init 服务里,而这两个服务的
-- depends_on = session-api: service_healthy —— 与迁移形成死锁:
--   session-api 启动 → 迁移 007 报 `role "session_app" does not exist`
--   (PersistenceError,已回滚)→ 进程退出 → 永不 healthy → 两个 init 永不
--   执行 → 角色永不创建。全新数据卷上无论等多久都不收敛。
-- 本文件 = 该环的破环点,且是**两条迁移路径共用的唯一角色来源**(WP-79):
--   - deps-only 拓扑(host 拓扑 / test:integration / `SESSION_API_IT=1
--     pnpm test:coverage` 完整门禁形态):测试套件在 deps 拓扑之上自行跑
--     迁移,若角色引导只挂在 app 面,全新 deps 卷上整批集成测试必红 ——
--     故服务定义下沉到 compose/deps.yaml;
--   - app 全拓扑:`session-api.depends_on: db-roles-init:
--     service_completed_successfully` 保证角色先于迁移(执行序见
--     compose/app.yaml 文件头)。
--
-- ── 形态 ──────────────────────────────────────────────────────────────
-- 一次性服务 `db-roles-init`(**服务定义在 compose/deps.yaml**;app.yaml 只
-- 引用不重复定义):镜像 postgres:16,管理面凭据,restart: "no",零安装依赖 /
-- 零新增运行时面。
-- 授权面(GRANT / REVOKE)不在此文件:由 app 面的 session-api-db-init.sql 与
-- verifier-db-init.sql 按角色分域承载(单点创建 + 分域授权,职责不重叠);
-- 两个治理脚本已**不含 CREATE ROLE**(角色单一来源 = 本文件)。
--
-- ── 幂等 ──────────────────────────────────────────────────────────────
-- IF NOT EXISTS 守卫:既有卷重复运行安全(角色已在场时零目录写,故与任何
-- 并发执行者也无 pg_authid 写冲突)。未显式设置 SUPERUSER / BYPASSRLS /
-- CREATEDB / CREATEROLE ⇒ 缺省 false(RLS 强制保持的前提,见文件末只读
-- 断言)。
-- 口令的唯一来源 = 本文件(WP-79 后两个治理 init 不再含口令字面值;口径零变更:
-- session_app = session-app-dev,verifier = verifier-dev,admin_ro = admin-ro-dev,
-- 与 compose/app.yaml / integration.env 的连接串一致)。
-- 凭据为本地开发 / CI 专用合成值,严禁用于任何真实环境。

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'session_app') THEN
    CREATE ROLE session_app LOGIN PASSWORD 'session-app-dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'verifier') THEN
    CREATE ROLE verifier LOGIN PASSWORD 'verifier-dev';
  END IF;
  -- WP-79:信任域 4 管理面只读角色(独立凭证;与 session_app / verifier 不共享)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_ro') THEN
    CREATE ROLE admin_ro LOGIN PASSWORD 'admin-ro-dev';
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
    WHERE rolname IN ('session_app', 'verifier', 'admin_ro') AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION '角色 session_app / verifier / admin_ro 不得为超级用户或 BYPASSRLS 角色(行级租户策略强制前提,D-API-101)';
  END IF;
END
$$;
