/**
 * PostgreSQL 题目注册表(challenges / challenge_versions;WP-3)。
 * 版本不可变:同 (challengeId, contentVersion) 重复登记即确定性拒绝。
 * 行内只有双包 SHA-256 摘要与签名;包本体在对象存储(私有桶服务端专用)。
 */

import type { Pool } from "pg";
import { PersistenceError } from "../errors.js";
import type {
  ChallengeRegistry,
  ChallengeVersionInput,
  ChallengeVersionRow,
} from "../ports.js";

interface VersionRowRaw {
  challenge_id: string;
  content_version: string;
  tenant_id: string;
  vm_profile_version: string;
  private_bundle_sha256: string;
  public_descriptor_sha256: string;
  private_bundle_object: string;
  public_descriptor_object: string;
  signature: string;
  signer_key_id: string;
  registered_at: Date;
}

function mapRow(raw: VersionRowRaw): ChallengeVersionRow {
  return {
    challengeId: raw.challenge_id,
    contentVersion: raw.content_version,
    tenantId: raw.tenant_id,
    vmProfileVersion: raw.vm_profile_version,
    privateBundleSha256: raw.private_bundle_sha256.trim(),
    publicDescriptorSha256: raw.public_descriptor_sha256.trim(),
    privateBundleObject: raw.private_bundle_object,
    publicDescriptorObject: raw.public_descriptor_object,
    signature: raw.signature,
    signerKeyId: raw.signer_key_id,
    registeredAt: raw.registered_at.toISOString(),
  };
}

export class PostgresChallengeRegistry implements ChallengeRegistry {
  constructor(private readonly pool: Pool) {}

  async upsertChallenge(input: { challengeId: string; tenantId: string; title?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO challenges (challenge_id, tenant_id, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (challenge_id) DO UPDATE SET updated_at = now()`,
      [input.challengeId, input.tenantId, input.title ?? null],
    );
  }

  async insertChallengeVersion(input: ChallengeVersionInput): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO challenge_versions (
           tenant_id, challenge_id, content_version, vm_profile_version,
           private_bundle_sha256, public_descriptor_sha256,
           private_bundle_object, public_descriptor_object, signature, signer_key_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.tenantId,
          input.challengeId,
          input.contentVersion,
          input.vmProfileVersion,
          input.privateBundleSha256,
          input.publicDescriptorSha256,
          input.privateBundleObject,
          input.publicDescriptorObject,
          input.signature,
          input.signerKeyId,
        ],
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || code === "23503") {
        // 23505 唯一冲突 = 版本已登记;23503 外键 = challenge 未注册。
        throw new PersistenceError("challenge_version_conflict", "题目版本已登记或题目未注册(版本不可变)", {
          cause: error,
        });
      }
      throw new PersistenceError("store_unavailable", "题目版本登记失败", { cause: error });
    }
  }

  async findChallengeVersion(challengeId: string, version: string, tenantId: string): Promise<ChallengeVersionRow | null> {
    const result = await this.pool.query<VersionRowRaw>(
      `SELECT * FROM challenge_versions
       WHERE challenge_id = $1 AND content_version = $2 AND tenant_id = $3`,
      [challengeId, version, tenantId],
    );
    const raw = result.rows[0];
    return raw === undefined ? null : mapRow(raw);
  }

  async listChallengeVersions(challengeId: string, tenantId: string): Promise<ChallengeVersionRow[]> {
    const result = await this.pool.query<VersionRowRaw>(
      `SELECT * FROM challenge_versions
       WHERE challenge_id = $1 AND tenant_id = $2
       ORDER BY registered_at ASC`,
      [challengeId, tenantId],
    );
    return result.rows.map(mapRow);
  }
}
