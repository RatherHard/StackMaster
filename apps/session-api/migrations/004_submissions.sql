-- 004 裁决域表结构预留(WP-3;计划书 5.7:submissions / verdicts /
-- verifier_runs)。本阶段只落 submissions(内部裁决引用,阶段六 verifier
-- 重放的输入面);verdicts / verifier_runs 为结构预留,阶段六写入。

CREATE TABLE IF NOT EXISTS submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  revision      BIGINT NOT NULL,
  public_status TEXT NOT NULL,
  -- 内部裁决引用完整形态(stackmaster-session-submit/1;D-W8-9)。
  -- 含规范化动作日志(服务端面,非玩家通道);零 seed / 零私有包内容。
  reference     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_session
  ON submissions (tenant_id, session_id, created_at DESC);

-- ── 以下两表为阶段六结构预留,本阶段零写入 ──

CREATE TABLE IF NOT EXISTS verdicts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  submission_id UUID NOT NULL REFERENCES submissions(id),
  verdict       TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verifier_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  submission_id UUID NOT NULL REFERENCES submissions(id),
  status        TEXT NOT NULL,
  -- 规范化动作日志摘要(SHA-256 hex;可重放性的绑定面)。
  log_digest    CHAR(64),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
