/**
 * WP-3 KeyValueStore → WP-2 认证端口的薄适配器(任务 B 装配面;D-API-33)。
 *
 *  - TokenIssuanceStore:键域 `token:{jti}`(与 WP-2 端口语义同键名);
 *    `consume` 的**原子单次消费**由 `deleteIfPresent`(Redis GETDEL)仲裁:
 *    并发消费方至多一方拿到 `deleteIfPresent = true`,其余一律 null——
 *    未签发 / 已消费 / 已吊销 / 记录过期四态同形(D-API-14 / D-API-18);
 *  - CredentialRevocationStore:键域 `cred-revoked:{jti}`(存在即拒绝;
 *    TTL 由调用方按凭证剩余有效期给出,≥ 剩余有效期为调用方义务);
 *  - jti 为服务端签发 UUID,仍经 encodeURIComponent 编码保形(与幂等键
 *    同一防键分隔符注入纪律,D-API-24;编码对 UUID 恒等,零语义差异);
 *  - 载荷纪律:签发记录 JSON 形态在消费侧做最小形状校验,形态损坏按
 *    "无有效记录"处理(fail-closed,拒绝消费)。
 */
import type {
  CredentialRevocationStore,
  IssuedEmbedTokenRecord,
  TokenIssuanceStore,
} from "../auth/ports.js";
import type { KeyValueStore } from "../persistence/ports.js";

const TOKEN_KEY_PREFIX = "token:";
const REVOCATION_KEY_PREFIX = "cred-revoked:";

function tokenKey(jti: string): string {
  return `${TOKEN_KEY_PREFIX}${encodeURIComponent(jti)}`;
}

function revocationKey(jti: string): string {
  return `${REVOCATION_KEY_PREFIX}${encodeURIComponent(jti)}`;
}

/** 签发记录最小形状校验(存储是权威锚;形态损坏 = 无有效记录)。 */
function decodeIssuedRecord(raw: string): IssuedEmbedTokenRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const stringFields = [
    "jti",
    "tenantId",
    "userId",
    "challengeId",
    "challengeVersion",
    "embedSessionId",
  ] as const;
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return null;
    }
  }
  if (typeof record.issuedAt !== "number" || typeof record.expiresAt !== "number") {
    return null;
  }
  return {
    jti: record.jti as string,
    tenantId: record.tenantId as string,
    userId: record.userId as string,
    challengeId: record.challengeId as string,
    challengeVersion: record.challengeVersion as string,
    embedSessionId: record.embedSessionId as string,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
}

export class KeyValueTokenIssuanceStore implements TokenIssuanceStore {
  constructor(private readonly kv: KeyValueStore) {}

  async put(record: IssuedEmbedTokenRecord, ttlSeconds: number): Promise<void> {
    await this.kv.set(tokenKey(record.jti), JSON.stringify(record), ttlSeconds);
  }

  async consume(jti: string): Promise<IssuedEmbedTokenRecord | null> {
    const key = tokenKey(jti);
    const raw = await this.kv.get(key);
    if (raw === null) {
      return null; // 未签发 / 已过期(TTL 自然失效)
    }
    // 原子单次消费仲裁:GETDEL 存在即删,并发下至多一方成功。
    const deleted = await this.kv.deleteIfPresent(key);
    if (!deleted) {
      return null; // 并发消费方已抢先消费 / 已吊销
    }
    return decodeIssuedRecord(raw);
  }

  async revoke(jti: string): Promise<boolean> {
    return this.kv.deleteIfPresent(tokenKey(jti));
  }
}

export class KeyValueCredentialRevocationStore implements CredentialRevocationStore {
  constructor(private readonly kv: KeyValueStore) {}

  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    await this.kv.set(revocationKey(jti), "1", ttlSeconds);
  }

  async isRevoked(jti: string): Promise<boolean> {
    return (await this.kv.get(revocationKey(jti))) !== null;
  }
}
