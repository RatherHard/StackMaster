-- 007 行级租户策略(WP-65;计划书 5.7 租户作用域,阶段六 D-API-20 收口 / D-API-101)。
--
-- 行级策略(RLS)是查询层租户校验(D-API-20)之外的第二道结构闸:即使
-- 查询层 WHERE 缺席或被绕过(直连 SQL / 注入面 / 存储实现缺陷),库层仍把
-- 跨租户访问折叠为"不存在"(零行)或确定性拒绝(WITH CHECK)。
--
-- ── 设计形态(按角色分立,无 BYPASSRLS 旁路角色,无超级用户应用连接义务)──
--
-- 1. 全部租户作用域表(题目域 / 会话域 / 动作域 / 裁决域 / 审计域九表)+
--    action_log 默认分区:ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY
--    (FORCE = 表属主同受政策约束;BYPASSRLS 仅超级用户既有属性,本迁移
--    不授予任何角色);
-- 2. session_app(应用连接角色,D-API-93)策略 = 租户绑定谓词:
--      tenant_id = current_setting('app.tenant_id', true)
--    (is_missing 形态:GUC 缺失返回 NULL → 谓词恒假 → 零行,fail-closed;
--    注入点 = 连接层 TenantScope 每事务 SET LOCAL,D-API-101)。
--    生命周期例外为逐命令窄面政策行(专用 GUC 承载,SET LOCAL 仅事务内
--    生效,常驻会话态零残留):
--      app.boot_recovery   —— 启动恢复枚举(D-API-63 查询层例外的行级同构;
--                              仅 SELECT 放行,UPDATE / DELETE 不外溢);
--      app.retention_purge —— 保留期清理(D-API-55):跨租户**租户枚举读**
--                              (政策行)+ 逐租户删除(租户绑定政策承载)
--                              两段式——RLS 下 DELETE 永不跨租户(零跨租户
--                              DELETE 政策行,PG 对 DELETE 施加 SELECT 可见
--                              与 DELETE 政策双重谓词,窄面 DELETE 例外会
--                              连带打开读面,故不取);
--      app.audit_archive   —— 审计归档切片(D-API-92 跨租户运维读面;
--                              仅 audit_log SELECT 放行);
-- 3. verifier(信任域 4,D-API-87)政策 = 角色级放行:TO verifier USING (true)
--    ——裁决队列消费(submissions / challenge_versions / challenges 跨租户读、
--    verifier_runs 认领推进、verdicts 幂等落库、audit_log 审计发射)是设计内
--    的跨租户访问面;RLS 对 verifier 依然强制(非 BYPASSRLS),政策按角色
--    分立成文而非旁路;写越权仍由 GRANT 面(D-API-93)维持,政策放行不等于
--    授权;
-- 4. 注册表公开读面(challenges / challenge_versions):SELECT 对 session_app
--    全放行——公开描述包下发(D-API-76)的登记读面 = 全局公开登记值(双包
--    摘要 / 对象名 / 签名,公开内容定位符),为查询层既有的第二处跨租户读
--    例外(先例注释,challenge-registry.findPublishedChallengeVersion)的行级
--    同构;写面(INSERT / UPDATE)以 WITH CHECK 租户绑定——跨租户 challengeId
--    冲突(upsert ON CONFLICT DO UPDATE)由"不可见即报错"转为确定性失败
--    (fail-closed 强化,防跨租户登记行标题改写);
-- 5. 零租户维度表(audit_archive_batches 归档台账 / _session_api_migrations
--    迁移记账):**不启用 RLS**——服务级台账,无租户谓词可表达(逐表论证
--    义务,D-API-101);访问面由 GRANT 治理(D-API-93)承载。
--
-- 幂等形态:ENABLE / FORCE 幂等;政策 DROP POLICY IF EXISTS + CREATE POLICY
-- (字面漂移自愈);辅助函数 CREATE OR REPLACE。执行角色 = 迁移属主
-- (compose dev = 超级用户;生产 = 专用迁移角色,生产连线义务 D-API-93)。

-- ═══ 会话域:sessions ═══
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sessions_tenant_isolation ON sessions;
CREATE POLICY sessions_tenant_isolation ON sessions TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sessions_boot_recovery_read ON sessions;
CREATE POLICY sessions_boot_recovery_read ON sessions FOR SELECT TO session_app
  USING (current_setting('app.boot_recovery', true) = 'on');

-- 保留期清理例外(D-API-55):PG 对 DELETE 施加"SELECT 可见 + DELETE 政策"
-- 双重谓词(政策按命令 OR、跨命令 AND)——跨租户 DELETE 政策行会连带打开
-- 读面,且"库层存在跨租户删除路径"本身违背零跨租户删除纪律。形态定为
-- 两段式:枚举(app.retention_purge GUC 下的跨租户租户枚举读,本政策行)
-- → 逐租户删除(tenant_id 绑定的 sessions_tenant_isolation 政策承载;
-- 连接层 purgeTerminalSessionsBefore 两段实现,D-API-101)——RLS 下
-- DELETE 永不跨租户(零跨租户 DELETE 政策行,比窄面 DELETE 例外更强)。
DROP POLICY IF EXISTS sessions_retention_tenant_scan ON sessions;
CREATE POLICY sessions_retention_tenant_scan ON sessions FOR SELECT TO session_app
  USING (current_setting('app.retention_purge', true) = 'on');

-- ═══ 会话域:checkpoints ═══
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkpoints_tenant_isolation ON checkpoints;
CREATE POLICY checkpoints_tenant_isolation ON checkpoints TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS checkpoints_boot_recovery_read ON checkpoints;
CREATE POLICY checkpoints_boot_recovery_read ON checkpoints FOR SELECT TO session_app
  USING (current_setting('app.boot_recovery', true) = 'on');

-- 保留期清理例外(sessions_retention_tenant_scan 同构论证:枚举 + 逐租户删除,
-- 零跨租户 DELETE 政策行)。
DROP POLICY IF EXISTS checkpoints_retention_tenant_scan ON checkpoints;
CREATE POLICY checkpoints_retention_tenant_scan ON checkpoints FOR SELECT TO session_app
  USING (current_setting('app.retention_purge', true) = 'on');

-- ═══ 动作域:action_log(分区表;父表 + 默认分区双层闸)═══
ALTER TABLE action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS action_log_tenant_isolation ON action_log;
CREATE POLICY action_log_tenant_isolation ON action_log TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- 父表政策不自动覆盖分区的直连访问:默认分区(与未来月度分区)以同一
-- 函数补齐(政策 + GRANT 单源;run-migrations.createActionLogPartition 在
-- 建分区后调用本函数,运维面零第二实现)。
CREATE OR REPLACE FUNCTION session_api_apply_action_log_row_security(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('DROP POLICY IF EXISTS action_log_tenant_isolation ON %I', partition_name);
  EXECUTE format(
    'CREATE POLICY action_log_tenant_isolation ON %I TO session_app
       USING (tenant_id = current_setting(''app.tenant_id'', true))
       WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
    partition_name
  );
  EXECUTE format('GRANT SELECT, INSERT ON %I TO session_app', partition_name);
END;
$$ LANGUAGE plpgsql;

SELECT session_api_apply_action_log_row_security('action_log_default');

-- ═══ 裁决域:submissions(session-api 写入面租户绑定;verifier 跨租户读)═══
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS submissions_tenant_isolation ON submissions;
CREATE POLICY submissions_tenant_isolation ON submissions TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS submissions_verifier_read ON submissions;
CREATE POLICY submissions_verifier_read ON submissions FOR SELECT TO verifier
  USING (true);

-- ═══ 裁决域:verifier_runs(session-api 入队;verifier 认领与状态机)═══
ALTER TABLE verifier_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifier_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS verifier_runs_tenant_isolation ON verifier_runs;
CREATE POLICY verifier_runs_tenant_isolation ON verifier_runs TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS verifier_runs_verifier_trust_domain ON verifier_runs;
CREATE POLICY verifier_runs_verifier_trust_domain ON verifier_runs TO verifier
  USING (true)
  WITH CHECK (true);

-- ═══ 裁决域:verdicts(session-api 呈现读租户绑定;verifier 幂等落库)═══
ALTER TABLE verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE verdicts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS verdicts_tenant_isolation ON verdicts;
CREATE POLICY verdicts_tenant_isolation ON verdicts TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS verdicts_verifier_trust_domain ON verdicts;
CREATE POLICY verdicts_verifier_trust_domain ON verdicts TO verifier
  USING (true)
  WITH CHECK (true);

-- ═══ 题目域:challenges(登记读面全局公开;写面租户绑定)═══
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS challenges_registry_read ON challenges;
CREATE POLICY challenges_registry_read ON challenges FOR SELECT TO session_app
  USING (true);

DROP POLICY IF EXISTS challenges_tenant_write ON challenges;
CREATE POLICY challenges_tenant_write ON challenges TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS challenges_verifier_read ON challenges;
CREATE POLICY challenges_verifier_read ON challenges FOR SELECT TO verifier
  USING (true);

-- ═══ 题目域:challenge_versions(同 challenges;登记读面 = 公开描述包下发)═══
ALTER TABLE challenge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS challenge_versions_registry_read ON challenge_versions;
CREATE POLICY challenge_versions_registry_read ON challenge_versions FOR SELECT TO session_app
  USING (true);

DROP POLICY IF EXISTS challenge_versions_tenant_write ON challenge_versions;
CREATE POLICY challenge_versions_tenant_write ON challenge_versions TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS challenge_versions_verifier_read ON challenge_versions;
CREATE POLICY challenge_versions_verifier_read ON challenge_versions FOR SELECT TO verifier
  USING (true);

-- ═══ 审计域:audit_log(安全事件账;写面租户绑定 + 归档窄面读)═══
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- 应用侧发射:行租户必须与注入租户一致(WITH CHECK;UPDATE / DELETE 由
-- 库层触发器 + REVOKE 双层先行拒绝,无政策行 = 默认拒)。
DROP POLICY IF EXISTS audit_log_tenant_insert ON audit_log;
CREATE POLICY audit_log_tenant_insert ON audit_log FOR INSERT TO session_app
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- 归档切片(D-API-92 台账即游标):跨租户运维读面仅经 app.audit_archive
-- 承载(SET LOCAL 仅归档事务内生效);应用无逐租户审计读面(安全账)。
DROP POLICY IF EXISTS audit_log_archive_read ON audit_log;
CREATE POLICY audit_log_archive_read ON audit_log FOR SELECT TO session_app
  USING (current_setting('app.audit_archive', true) = 'on');

-- verifier 审计发射面(D-API-90 / 95:裁决域三值;信任域 4 系统主体跨租户)。
DROP POLICY IF EXISTS audit_log_verifier_insert ON audit_log;
CREATE POLICY audit_log_verifier_insert ON audit_log FOR INSERT TO verifier
  WITH CHECK (true);
