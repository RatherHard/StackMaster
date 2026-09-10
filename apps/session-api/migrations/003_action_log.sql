-- 003 规范化动作日志(WP-3;计划书 5.7:append-only,按时间分区)。
-- append-only 强制层(D-API-22):数据库层触发器抛异常——应用角色无论
-- 权限配置如何,UPDATE / DELETE 一律在库内被拒(集成测试带红灯反例);
-- REVOKE UPDATE/DELETE 的应用角色治理归阶段六部署面,作为第二层。
-- 落库纪律:仅已接受动作(拒绝不入账,D-W8-9 编排器账本同源);动作日志
-- 是玩家提交可见面 BOUNDARY,本身不加密、但必须零秘密(秘密语料扫描
-- 测试锚点,ZR-B4 / B6 存储面)。

CREATE TABLE IF NOT EXISTS action_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id      TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  client_seq     BIGINT NOT NULL,
  revision_after BIGINT NOT NULL,
  -- 规范化动作对象(玩家提交可见面)。
  action         JSONB NOT NULL,
  -- submit 引用同锚(内部裁决引用标识;NULL = 尚未随 submit 锚定)。
  submission_ref TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 分区维护:MVP 期以 DEFAULT 分区兜底接收全部写入(按时间分区结构即此
-- 成立);原生月度分区与归档轮转归阶段六(runner 暴露
-- createActionLogPartition 供运维面提前建分区)。
CREATE TABLE IF NOT EXISTS action_log_default PARTITION OF action_log DEFAULT;

CREATE INDEX IF NOT EXISTS idx_action_log_session
  ON action_log (tenant_id, session_id, id);

-- append-only 强制:BEFORE UPDATE / DELETE / TRUNCATE 一律抛异常。
CREATE OR REPLACE FUNCTION action_log_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'action_log is append-only: % is forbidden (D-API-22)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_log_append_only ON action_log;
CREATE TRIGGER action_log_append_only
  BEFORE UPDATE OR DELETE ON action_log
  FOR EACH ROW EXECUTE FUNCTION action_log_forbid_mutation();

DROP TRIGGER IF EXISTS action_log_no_truncate ON action_log;
CREATE TRIGGER action_log_no_truncate
  BEFORE TRUNCATE ON action_log
  FOR EACH STATEMENT EXECUTE FUNCTION action_log_forbid_mutation();
