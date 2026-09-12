-- 006 审计域落库与归档(WP-64;计划书 5.7 审计域,阶段六 D-API-90 ~ D-API-93)。
-- audit_log 表 + append-only 库层触发器(action_log 同款纪律,D-API-22)+
-- 归档台账 + kind 封闭集合库层 CHECK + REVOKE 第二层。
-- 审计是安全事件账不是运维事件账(硬门槛):kind 十值封闭集合一次性定案
-- (D-API-90,D-API-59 阶段六开口收口),任何再扩张走新迁移 + 本约束同步。

-- ── 审计事件表(append-only;本阶段归档为副本形态,在线表不删行,D-API-92)──
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  kind       TEXT NOT NULL,
  -- 事件时刻(Unix epoch 毫秒的 timestamptz 形态;归档序列化以 ISO 往返)。
  at         TIMESTAMPTZ NOT NULL,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  -- 会话锚(缺省 NULL:身份不可得前的拒绝事件,先例 D-API-14 统一形态)。
  session_id TEXT,
  -- 仅非秘密标量字典(零凭证材料,D-API-18 detail 纪律;SERVER_ONLY 面,
  -- 数据分类清单 §6:审计日志零公开)。
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON audit_log (created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant
  ON audit_log (tenant_id, created_at);

-- kind 封闭集合库层强制(D-API-90):十值一次性定案后冻结,任何字面漂移
-- 在库层即拒(与 TS 侧 AUDIT_EVENT_KINDS 同锚;verifier 角色的 INSERT 同受
-- 本约束——裁决域三值发射面归 WP-62)。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_kind_closed_set') THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_kind_closed_set CHECK (kind IN (
      'embed_token_issued',
      'embed_token_consumed',
      'embed_token_revoked',
      'session_credential_issued',
      'create_session',
      'submit',
      'session_force_closed',
      'verdict_completed',
      'verdict_replay_failed',
      'verdict_rejected'
    ));
  END IF;
END
$$;

-- ── append-only 强制(D-API-22 action_log 同款):BEFORE UPDATE / DELETE /
--    TRUNCATE 一律抛异常。应用角色无论权限配置,变更一律在库内被拒。──
CREATE OR REPLACE FUNCTION audit_log_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is forbidden (D-API-90/22)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_forbid_mutation();

-- ── REVOKE 第二层(D-API-22 阶段六落地面 / D-API-93):审计与动作两表对
--    PUBLIC 收紧 UPDATE / DELETE / TRUNCATE。表属主(此处 = 迁移执行角色)
--    的隐含属主权不受 REVOKE 影响——生产连接义务(应用经最小授权角色
--    session_app 连接,compose/session-api-db-init.sql)与触发器层共同
--    承载;host 降级形态以管理面凭证运行属角色治理降级,如实登记。──
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON action_log FROM PUBLIC;

-- ── 归档台账(运维账,非审计事件;游标与批 ID 幂等载体,D-API-92)──
CREATE TABLE IF NOT EXISTS audit_archive_batches (
  -- 批 ID(SHA-256 hex):行集合边界确定性派生,重复归档不产生双份的锚。
  batch_id      CHAR(64) PRIMARY KEY,
  object_name   TEXT NOT NULL,
  manifest_name TEXT NOT NULL,
  -- 数据对象 SHA-256 hex(归档后完整性校验的复算锚)。
  data_sha256   CHAR(64) NOT NULL,
  row_count     BIGINT NOT NULL,
  -- 批窗口(键序游标:window_end + last_id 推进,零重叠零漏批)。
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  last_id       BIGINT NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_batches_window
  ON audit_archive_batches (window_end, last_id);
