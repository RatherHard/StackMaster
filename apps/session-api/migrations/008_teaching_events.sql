-- 008 教学事件采集载体(WP-82;O-MP-1 定案 = 权威 API 语义规约 D-API-139,
-- 登记片段 docs/develop/decisions-m3/WP-82.md;中期计划 §3.4 指标采集最小面)。
--
-- ── 为什么是**新表**而不是给 audit_log 加 kind ─────────────────────────────
-- 教学事件(题目开始 / 通过 / 回退次数)是**数据事件账**(教学观察面),
-- 而 audit_log 是**安全事件账**(kind 十值封闭集,migrations/006 库层 CHECK,
-- D-API-90 定案后冻结)。复用 audit_log 需要新增 kind ⇒ 须按 D-API-59 口径
-- 重开「安全事件账 vs 数据事件账」边界论证;新表使两账边界结构性分离、
-- 且**零审计 kind 新增**(本迁移不触碰 audit_log 任何字面)。
-- 采集面**不经 `/metrics` 通道**(定案原文):/metrics 是运维面(白名单机检
-- assertMetricsTextDiscipline),教学事件走应用事件存储 = 本表。
--
-- ── 与 007(行级租户策略)对照说明 ────────────────────────────────────────
-- 形态**逐条同构**,唯一差别是「表由本迁移创建 ⇒ 政策与授权同批落在本文件」:
--  1. ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY(FORCE = 表属主
--     同受政策约束;无 BYPASSRLS 旁路角色,与 007 第 1 条同款);
--  2. 租户绑定政策 TO session_app USING / WITH CHECK 谓词恒为
--       tenant_id = current_setting('app.tenant_id', true)
--     (is_missing 形态:GUC 缺失返回 NULL ⇒ 谓词恒假 ⇒ 零行,fail-closed;
--     注入点 = 连接层 TenantScope 每事务 SET LOCAL,D-API-101);
--  3. 保留期清理例外 = **两段式**(007 第 2 条同款论证):app.retention_purge
--     GUC 下只放行**跨租户租户枚举读**(本文件 *_retention_tenant_scan 政策行)
--     → 逐租户 DELETE(租户绑定政策承载)。**零跨租户 DELETE 政策行**:
--     PG 对 DELETE 施加「SELECT 可见 + DELETE 政策」双重谓词,窄面 DELETE
--     例外会连带打开读面,故不取(007 原文口径);RLS 下 DELETE 永不跨租户。
--  4. 授权面:007 面内 GRANT 只出现在 action_log 分区辅助函数里(其余表的
--     GRANT 归 compose/session-api-db-init.sql 部署面,D-API-93)。本表由
--     **迁移新建**,而部署面 init 脚本在 PG 容器首启时执行、早于应用启动
--     迁移(且该脚本是既有 lane 的禁改面)⇒ 新表的授权只能与本表同批落在
--     本迁移(单源,**零第二处 GRANT 字面**)。下次修订部署面 init 脚本时
--     应把本段 GRANT 字面与那里统一,属部署面义务,如实登记。
--
-- ── 表形态纪律(零学习者标识 / 零秘密 / 闭合可伪造面)────────────────────
--  - **零学习者标识**:无 user_id 列、无原始 session_id 列——采集面只承载
--    **单向会话摘要** subject_digest(SHA-256 hex,服务端派生、不可反解、
--    不离开服务端且端口面无返回位;见 src/teaching/derive.ts);
--  - **零秘密**:无 flag / seed / 快照 / 私有包内容 / 完整事件日志;载重只有
--    公开描述包已分类公开常量(题目身份)、服务端时刻、聚合数值与有界枚举
--    (数据分类清单新增章逐字段论证);
--  - **kind 封闭集**:v1 = 服务端可派生三值,库层 CHECK 强制(字面与 TS 侧
--    COLLECTIBLE_TEACHING_EVENT_KINDS 同锚)。**「提示使用」不在集合内** ——
--    v1 如实登记「暂不可采集」(hintLadder 只在公开描述包、服务端无记录入口,
--    且不得靠客户端自报,6.2):不接受自报 ⇒ 该 kind 在库层**结构性不可写入**,
--    伪造计数不存在表达位。未来扩集 = 新迁移 + 更新本 CHECK(additive,不回溯);
--  - **幂等**:source_ref = 源权威行的确定性派生锚(不含原始会话标识文本),
--    UNIQUE (tenant_id, kind, source_ref) 使重放采集 ON CONFLICT DO NOTHING
--    零重复、零改写(采集写入的幂等面,WP-82 D-API-150);
--  - **append-only(与 audit_log / action_log 同款纪律,一处分野)**:UPDATE 与
--    TRUNCATE 一律库层抛异常(改账 / 毁账不可能);**DELETE 不设触发器** ——
--    本表带保留期(定案三项之一),删除由保留期制裁路径唯一承载(逐租户
--    DELETE + 上面两段式政策),这是与 audit_log(无保留期、零 DELETE)的
--    登记差异。
--
-- 幂等形态:整文件可重放(CREATE ... IF NOT EXISTS / DROP ... IF EXISTS /
-- 约束存在性检查 / CREATE OR REPLACE)。执行角色 = 迁移属主(compose dev =
-- 超级用户;生产 = 专用迁移角色,生产连线义务 D-API-93)。

-- ═══ 教学事件表 ═══
CREATE TABLE IF NOT EXISTS teaching_events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY,
  -- 租户作用域列(行级政策谓词绑定面;与 007 全表域同形)。
  tenant_id         TEXT NOT NULL,
  -- 事件种类:v1 服务端可派生三值封闭集(库层 CHECK 见下)。
  kind              TEXT NOT NULL,
  -- 事件时刻 = **源权威行时刻**的落库形态(题目开始 = sessions.created_at;
  -- 通过 = verdicts.created_at;回退 = action_log.created_at)。保留期以本列
  -- 为窗口基准(不按写入时刻 created_at——采集重放不得延长教学事件寿命)。
  occurred_at       TIMESTAMPTZ NOT NULL,
  -- 题目身份(公开描述包已分类公开常量;§12.2 challengeId / challengeVersion)。
  challenge_id      TEXT NOT NULL,
  challenge_version TEXT NOT NULL,
  -- 单向会话摘要(SHA-256 hex;服务端派生,仅用于幂等分组与逐会话聚合的
  -- 内部分组,任何端口方法都不返回该列)。
  subject_digest    CHAR(64) NOT NULL,
  -- 源权威行确定性派生锚(session:<sha256> / verdict:<uuid> / action:<id>):
  -- 幂等唯一键的一部分;**不含原始会话标识的可读文本**。
  source_ref        TEXT NOT NULL,
  -- 事件计数(单事件形态恒 1;为未来的批次计数形态预留同一列,当前采集器
  -- 只写 1;≥ 1 由 CHECK 强制——零 / 负计数在任何路径上都不可表达)。
  event_count       INTEGER NOT NULL DEFAULT 1 CHECK (event_count >= 1),
  -- 派生口径版本(重放 / 复算锚;口径变更 = 新版本字面 + 新 source_ref 前缀,
  -- 不原地改写既有行——UPDATE 已被触发器禁止)。
  derivation        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 聚合查询扫描列(按题目 / 版本分组;受控查询的唯一分组维度)。
CREATE INDEX IF NOT EXISTS idx_teaching_events_tenant_challenge
  ON teaching_events (tenant_id, challenge_id, challenge_version);
-- 保留期清理扫描列(按事件时刻窗口)。
CREATE INDEX IF NOT EXISTS idx_teaching_events_occurred ON teaching_events (occurred_at);
-- 幂等锚(采集重放零重复的库层强制面)。
CREATE UNIQUE INDEX IF NOT EXISTS uq_teaching_events_source
  ON teaching_events (tenant_id, kind, source_ref);

-- kind 封闭集合库层强制(v1 三值;与 TS 侧 COLLECTIBLE_TEACHING_EVENT_KINDS
-- 同锚)。「提示使用」不在集合内 = 结构性不可写入(不靠纪律,靠约束)。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teaching_events_kind_closed_set') THEN
    ALTER TABLE teaching_events ADD CONSTRAINT teaching_events_kind_closed_set CHECK (kind IN (
      'challenge_started',
      'passed',
      'undo'
    ));
  END IF;
END
$$;

-- ═══ append-only 强制(UPDATE / TRUNCATE 拒;DELETE 由保留期制裁路径承载)═══
CREATE OR REPLACE FUNCTION teaching_events_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'teaching_events is append-only for % (retention DELETE is the only sanctioned path; WP-82)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teaching_events_append_only ON teaching_events;
CREATE TRIGGER teaching_events_append_only
  BEFORE UPDATE ON teaching_events
  FOR EACH ROW EXECUTE FUNCTION teaching_events_forbid_mutation();

DROP TRIGGER IF EXISTS teaching_events_no_truncate ON teaching_events;
CREATE TRIGGER teaching_events_no_truncate
  BEFORE TRUNCATE ON teaching_events
  FOR EACH STATEMENT EXECUTE FUNCTION teaching_events_forbid_mutation();

-- ═══ 行级租户策略(007 形态同构;要点见文件头)═══
ALTER TABLE teaching_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE teaching_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teaching_events_tenant_isolation ON teaching_events;
CREATE POLICY teaching_events_tenant_isolation ON teaching_events TO session_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- 保留期清理例外(两段式第一段):跨租户**租户枚举读**;DELETE 不外溢
-- (无租户上下文的 DELETE 在法律上仍受 tenant 绑定政策约束 ⇒ 零行)。
DROP POLICY IF EXISTS teaching_events_retention_tenant_scan ON teaching_events;
CREATE POLICY teaching_events_retention_tenant_scan ON teaching_events FOR SELECT TO session_app
  USING (current_setting('app.retention_purge', true) = 'on');

-- ═══ 授权面(与本表同批单源;理由见文件头第 4 条)═══
-- 采集写入 = INSERT;聚合查询 = SELECT;保留期 = DELETE(唯一 sanction 面)。
REVOKE UPDATE, TRUNCATE ON teaching_events FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON teaching_events TO session_app;
-- 自增列(GENERATED ALWAYS AS IDENTITY)的隐式序列需显式 USAGE(audit_log
-- 的 compose 授权面同款,verifier-db-init.sql)。
GRANT USAGE, SELECT ON SEQUENCE teaching_events_id_seq TO session_app;
