-- 002 会话域(WP-3;计划书 5.7:sessions、checkpoints 存 COW 快照 blob)。
-- 快照纪律(D-W8-11 / D-API-21):checkpoints.ciphertext 只允许 AES-256-GCM
-- 密文信封(编排器对快照只存取不解析,加密在应用层 SnapshotCipher);
-- 恢复点 = 显式 checkpoint + 周期自动快照 + 会话关闭(D-API-25),origin
-- 列区分三触发点;保留期由应用侧 purgeExpired(SESSION_API_SNAPSHOT_
-- RETENTION_DAYS)执行。

CREATE TABLE IF NOT EXISTS checkpoints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  -- 显式 checkpoint 标识(协议冻结字符集);周期 / 关闭快照为 NULL。
  checkpoint_id TEXT,
  -- 恢复点触发来源:explicit_checkpoint | auto_periodic | session_close。
  origin        TEXT NOT NULL CHECK (origin IN ('explicit_checkpoint', 'auto_periodic', 'session_close')),
  revision      BIGINT NOT NULL,
  -- AES-256-GCM 密文信封(整包加密;明文永不落库)。
  ciphertext    BYTEA NOT NULL,
  byte_size     INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session
  ON checkpoints (tenant_id, session_id, created_at DESC);
-- 保留期清理扫描列。
CREATE INDEX IF NOT EXISTS idx_checkpoints_expiry ON checkpoints (created_at);

CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  challenge_id       TEXT NOT NULL,
  challenge_version  TEXT NOT NULL,
  phase              TEXT NOT NULL CHECK (phase IN ('active', 'crashed', 'closed')),
  -- seed 策略元数据(不含 seed 值——seed 永不持久化,D-API-23;合法落点
  -- 只有加密快照内的 seedState)。
  seed_strategy      TEXT NOT NULL,
  latest_revision    BIGINT NOT NULL DEFAULT 0,
  -- 快照锚:最近恢复点(checkpoints.id)。
  latest_snapshot_id UUID REFERENCES checkpoints(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id, user_id);
