-- 005 裁决域启用(WP-61;阶段六 D-API-85 消费语义的落库面)。004 预留的
-- verdicts / verifier_runs 两表进入写入形态,本迁移只补齐结构性约束:
--  - verdicts.submission_id 唯一:裁决幂等(同 submission 重复裁决确定性
--    同判、不重复写入,D-API-85)的库层强制;
--  - verifier_runs(status) 认领索引:PG 轮询 FOR UPDATE SKIP LOCKED 批量
--    认领 pending 行的扫描面。
-- 应用角色最小授权(verifier 独立角色;信任域 4,与 session-api 不共享凭证)
-- 归 compose 部署面的角色治理脚本(compose/verifier-db-init.sql)。

CREATE UNIQUE INDEX IF NOT EXISTS uq_verdicts_submission
  ON verdicts (submission_id);

CREATE INDEX IF NOT EXISTS idx_verifier_runs_status
  ON verifier_runs (status, created_at);
