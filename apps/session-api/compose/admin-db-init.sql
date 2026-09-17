-- 管理面独立 PG 角色治理(D-MP-5 分支 A;信任域 4,与 session-api / verifier
-- 不共享凭证;WP-79 交付面,决策登记 D-API-135)。
--
-- 最小授权面(与 009 迁移的 admin_ro 政策配套):
--   challenges / challenge_versions —— 只读(题目登记列表:公开登记值);
--   sessions                        —— 只读(成绩 / 裁决的题目标识来源);
--   submissions                     —— 只读(裁决查询的提交定位与 revision);
--   verdicts                        —— 只读(裁决查询与成绩导出)。
-- 零 INSERT / 零 UPDATE / 零 DELETE / 零 DDL / 零其余表域授权。
--
-- ── audit_log 零授权是**定案**而非疏漏(D-API-136)────────────────────
-- 审计账 `audit_log` 是安全事件账,其 kind 是十值封闭集(D-API-90);
-- 管理面查询是运维读取事实,按 D-API-59 / D-API-92 口径**不进审计账**,
-- 走受控日志 + 指标计数器。因此本脚本刻意**不**授予 admin_ro 对 audit_log
-- 的任何权限:即使实现被误改为写审计账,库层也会确定性拒绝
-- (`ERROR: permission denied for table audit_log`)——账目归属由设计决定,
-- 授权面独立地把误写变成红灯。
--
-- ── 行级租户政策(009 迁移 / D-API-135)───────────────────────────────
-- admin_ro 对所有可读表 `ENABLE + FORCE ROW LEVEL SECURITY`,政策按角色
-- 分立为租户绑定谓词 `tenant_id = current_setting('app.tenant_id', true)`:
-- GUC 缺失 ⇒ 谓词恒假 ⇒ **零行**(fail-closed);连接层每事务 `SET LOCAL`
-- 注入(D-API-101 同款形态,admin 侧自有实现)。政策与授权双层正交:政策
-- 放行不等于授权,写面越权仍由本脚本的 GRANT 面维持;反之,授权在场而
-- GUC 缺失也读不到任何行。
--
-- ── 幂等形态 ──────────────────────────────────────────────────────────
-- 角色与授权均可重复执行(compose 一次性 init 服务在既有卷上重复运行安全)。
-- 执行前置:session-api 已完成迁移(001 ~ 009 已应用)。
--
-- ── 角色来源与执行序(单一来源)────────────────────────────────────────
-- 角色创建的唯一来源 = compose/db-roles-init.sql(服务 db-roles-init)。
-- 本文件**不含 CREATE ROLE**:角色缺席时 `GRANT ... TO admin_ro` 以
-- `ERROR: role "admin_ro" does not exist` 确定性失败(ON_ERROR_STOP=1),
-- 即引导缺席的显式红灯。
-- app 全拓扑下本服务 depends_on session-api-db-init / verifier-db-init
-- `service_completed_successfully`——三个治理 init 的 GRANT / REVOKE 会写同
-- 一批 PG 目录行(public schema nspacl + 各表 relacl),并发执行会偶发
-- `ERROR: tuple concurrently updated`,故串行化(依赖方向无环)。
-- 凭据为本地开发 / CI 专用合成值,严禁用于任何真实环境。

GRANT USAGE ON SCHEMA public TO admin_ro;

GRANT SELECT ON challenges TO admin_ro;
GRANT SELECT ON challenge_versions TO admin_ro;
GRANT SELECT ON sessions TO admin_ro;
GRANT SELECT ON submissions TO admin_ro;
GRANT SELECT ON verdicts TO admin_ro;
