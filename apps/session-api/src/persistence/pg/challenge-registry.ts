/**
 * PostgreSQL 题目注册表(challenges / challenge_versions;WP-3)。
 * 版本不可变:同 (challengeId, contentVersion) 重复登记即确定性拒绝。
 * 行内只有双包 SHA-256 摘要与签名;包本体在对象存储(私有桶服务端专用)。
 */

import type { Pool, QueryResult, QueryResultRow } from "pg";
import { TenantScope } from "./connection.js";
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
  readonly #pool: Pool;
  readonly #scope: TenantScope;

  constructor(pool: Pool) {
    // 行级租户策略第二道结构闸的注入点(007 迁移 / D-API-101):注册表
    // 读面全局公开(D-API-76 政策 SELECT 放行),写面经 SET LOCAL 注入
    // 租户上下文(WITH CHECK 租户绑定)。
    this.#pool = pool;
    this.#scope = new TenantScope(pool);
  }

  async upsertChallenge(input: { challengeId: string; tenantId: string; title?: string }): Promise<void> {
    await this.#scope.query(
      input.tenantId,
      `INSERT INTO challenges (challenge_id, tenant_id, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (challenge_id) DO UPDATE SET updated_at = now()`,
      [input.challengeId, input.tenantId, input.title ?? null],
    );
  }

  async insertChallengeVersion(input: ChallengeVersionInput): Promise<void> {
    try {
      await this.#scope.query(
        input.tenantId,
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
    const result = await this.#scope.query<VersionRowRaw>(
      tenantId,
      `SELECT * FROM challenge_versions
       WHERE challenge_id = $1 AND content_version = $2 AND tenant_id = $3`,
      [challengeId, version, tenantId],
    );
    const raw = result.rows[0];
    return raw === undefined ? null : mapRow(raw);
  }

  async listChallengeVersions(challengeId: string, tenantId: string): Promise<ChallengeVersionRow[]> {
    const result = await this.#scope.query<VersionRowRaw>(
      tenantId,
      `SELECT * FROM challenge_versions
       WHERE challenge_id = $1 AND tenant_id = $2
       ORDER BY registered_at ASC`,
      [challengeId, tenantId],
    );
    return result.rows.map(mapRow);
  }

  /**
   * 公开面版本行读取(阶段五 WP-50,D-API-76):无租户过滤(公开描述包是
   * 公开内容,查询层租户过滤的第二处跨租户例外,先例 D-API-63;
   * (challenge_id, content_version) 为主键,结果唯一)。行级政策形态同构:
   * 注册表读面 = 全局公开登记值(SELECT 政策全放行,007 迁移),无需租户
   * 上下文。故障翻译与既有写路径同形(store_unavailable)。
   */
  async findPublishedChallengeVersion(challengeId: string, version: string): Promise<ChallengeVersionRow | null> {
    try {
      // 公开读面经池直连(不注入租户上下文;政策不依赖 GUC)。连接复用
      // 零租户态残留:SET LOCAL 仅注入事务内生效(COMMIT 即归零)。
      const result = await this.#scopeRaw<VersionRowRaw>(
        `SELECT * FROM challenge_versions
         WHERE challenge_id = $1 AND content_version = $2`,
        [challengeId, version],
      );
      const raw = result.rows[0];
      return raw === undefined ? null : mapRow(raw);
    } catch (error) {
      throw new PersistenceError("store_unavailable", "题目版本读取失败", { cause: error });
    }
  }

  async #scopeRaw<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    return this.#pool.query<Row>(text, [...values]);
  }
}
