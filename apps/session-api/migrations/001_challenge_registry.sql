-- 001 题目域注册表(WP-3;计划书 5.7:challenges / challenge_versions
-- 版本链、公开/私有包哈希与签名)。全部带租户作用域列;查询层租户校验
-- 强制(行级策略归阶段六完善)。
-- 幂等形态:IF NOT EXISTS(防御记录表与库状态不一致的运维态)。

CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  title        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS challenge_versions (
  tenant_id                TEXT NOT NULL,
  challenge_id             TEXT NOT NULL REFERENCES challenges(challenge_id),
  content_version          TEXT NOT NULL,
  vm_profile_version       TEXT NOT NULL,
  -- 双包 SHA-256 摘要(hex,64 位十六进制);包本体在对象存储,表内只有摘要。
  private_bundle_sha256    CHAR(64) NOT NULL,
  public_descriptor_sha256 CHAR(64) NOT NULL,
  -- 对象存储对象名(private-bundles / public-descriptors 桶内键)。
  private_bundle_object    TEXT NOT NULL,
  public_descriptor_object TEXT NOT NULL,
  -- 双包登记签名(Ed25519,base64;签名基线见 D-API-23)。
  signature                TEXT NOT NULL,
  signer_key_id            TEXT NOT NULL DEFAULT 'default',
  registered_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, content_version)
);

CREATE INDEX IF NOT EXISTS idx_challenge_versions_tenant
  ON challenge_versions (tenant_id, challenge_id);
