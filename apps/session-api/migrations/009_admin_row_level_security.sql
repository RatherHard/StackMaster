-- 009 管理面行级租户策略(D-MP-5 分支 A;WP-79 交付面,决策登记 D-API-135)。
--
-- 与 007(会话 / 裁决 / 题目 / 审计域的既有角色政策)**同形分域**,但刻意
-- 不改 007:007 是既有角色(session_app / verifier)的政策面,管理面角色
-- admin_ro 是**独立凭证面**,其政策独立成文,避免与并发改动冲突,也让
-- "管理面读面有哪些表、各自什么谓词"在一处可读。
--
-- ── 形态 ──────────────────────────────────────────────────────────────
-- 1. 五个管理面只读表(challenges / challenge_versions / sessions /
--    submissions / verdicts)对 admin_ro:ENABLE + FORCE ROW LEVEL SECURITY
--    (FORCE = 表属主同受约束;admin_ro 非属主,双重保险);
-- 2. 政策 = **租户绑定谓词**:
--      tenant_id = current_setting('app.tenant_id', true)
--    GUC 缺失(is_missing 形态)返回 NULL ⇒ 谓词恒假 ⇒ **零行**(fail-closed);
--    注入点 = admin 自有连接层 `AdminTenantScope` 每事务 SET LOCAL
--    (D-API-101 同款形态,管理面自实现,不 import 编排器代码);
-- 3. 政策**只授 SELECT**(`FOR SELECT TO admin_ro`):写面(INSERT / UPDATE /
--    DELETE)**没有**任何 permissive 政策 ⇒ 对 admin_ro 默认拒——库层零写
--    的第三重保证(与 compose/admin-db-init.sql 的零 DML 授权、应用的
--    只读语句护栏彼此独立);
-- 4. 文件末只读断言:若日后有人给 admin_ro 加上非 SELECT 政策,迁移以
--    确定性失败暴露(fail-closed 自检,形态与 db-roles-init.sql 的属性断言
--    同款)。
--
-- 幂等形态:ENABLE / FORCE 幂等;政策 DROP POLICY IF EXISTS + CREATE POLICY
-- (字面漂移自愈)。执行角色 = 迁移属主(compose dev = 超级用户;生产 =
-- 专用迁移角色,生产连线义务 D-API-93)。
-- 执行前置:admin_ro 角色已存在(角色创建单一来源 = compose/db-roles-init.sql,
-- 本 WP 提供待应用片段;缺席时本迁移以 `role "admin_ro" does not exist`
-- 确定性失败,即引导缺席的显式红灯)。

-- ═══ 题目域:challenges(登记读面,按管理面绑定租户收敛)═══
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS challenges_admin_read ON challenges;
CREATE POLICY challenges_admin_read ON challenges FOR SELECT TO admin_ro
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ═══ 题目域:challenge_versions(版本链摘要;同谓词)═══
ALTER TABLE challenge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS challenge_versions_admin_read ON challenge_versions;
CREATE POLICY challenge_versions_admin_read ON challenge_versions FOR SELECT TO admin_ro
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ═══ 会话域:sessions(成绩 / 裁决的题目标识来源)═══
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sessions_admin_read ON sessions;
CREATE POLICY sessions_admin_read ON sessions FOR SELECT TO admin_ro
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ═══ 裁决域:submissions(提交定位与 revision)═══
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS submissions_admin_read ON submissions;
CREATE POLICY submissions_admin_read ON submissions FOR SELECT TO admin_ro
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ═══ 裁决域:verdicts(裁决查询与成绩导出)═══
ALTER TABLE verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdicts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS verdicts_admin_read ON verdicts;
CREATE POLICY verdicts_admin_read ON verdicts FOR SELECT TO admin_ro
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ── 只读政策自检(零写政策面;fail-closed)───────────────────────────────
-- 管理面角色不得持有任何非 SELECT 政策:一旦出现,本迁移确定性失败
-- (与 compose/db-roles-init.sql 的角色属性断言同款形态)。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE 'admin_ro' = ANY (roles) AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '管理面角色 admin_ro 不得持有非 SELECT 政策(管理面零写,D-API-135)';
  END IF;
END
$$;
