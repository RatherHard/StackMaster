/**
 * WP-3 KeyValueStore → WP-2 认证端口的薄适配器(任务 B 装配面;D-API-33)。
 *
 *  - LaunchGrantStore:键域 `launchGrant:{jti}`;`consume` 的**原子单次消费**
 *    由 `deleteIfPresent`(Redis GETDEL)仲裁:并发消费方至多一方拿到
 *    `deleteIfPresent = true`,其余一律 null——未签发 / 已消费 / 已过期三态
 *    同形(D-API-14 / D-API-18);
 *  - CredentialRevocationStore:键域 `cred-revoked:{jti}`(存在即拒绝;
 *    TTL 由调用方按凭证剩余有效期给出,≥ 剩余有效期为调用方义务);
 *  - jti 为服务端签发 UUID,仍经 encodeURIComponent 编码保形(与幂等键
 *    同一防键分隔符注入纪律,D-API-24;编码对 UUID 恒等,零语义差异);
 *  - 载荷纪律:签发记录 JSON 形态在消费侧做最小形状校验,形态损坏按
 *    "无有效记录"处理(fail-closed,拒绝消费)。
 *
 * **退役登记(2026-09-19,分发改版 WP-96)**:embed token 签发记录的 Redis
 * 适配器 `KeyValueTokenIssuanceStore` 与键域 `token:{jti}` 随嵌入协议面与
 * create_session 的 v1 分支**同批物理删除**。
 */
import type {
  CredentialRevocationStore,
  IssuedLaunchGrantRecord,
  LaunchGrantStore,
} from "../auth/ports.js";
import type { KeyValueStore } from "../persistence/ports.js";

const REVOCATION_KEY_PREFIX = "cred-revoked:";
/**
 * 启动授权凭证键域(WP-91;D-LT-5 5a)。**独立键域** —— 理由见
 * `auth/ports.ts` 的 `LaunchGrantStore` 段:本族不因 embed 面退役而改变键名。
 */
const LAUNCH_GRANT_KEY_PREFIX = "launchGrant:";

function revocationKey(jti: string): string {
  return `${REVOCATION_KEY_PREFIX}${encodeURIComponent(jti)}`;
}

function launchGrantKey(jti: string): string {
  return `${LAUNCH_GRANT_KEY_PREFIX}${encodeURIComponent(jti)}`;
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

/** 启动授权凭证记录的最小形状校验(存储是权威锚;形态损坏 = 无有效记录)。 */
function decodeIssuedLaunchGrant(raw: string): IssuedLaunchGrantRecord | null {
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
  const stringFields = ["jti", "tenantId", "userId", "challengeId", "challengeVersion"] as const;
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
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
}

/**
 * 启动授权凭证签发记录存储的 Redis 适配器(键域 `launchGrant:{jti}`;WP-91)。
 *
 * 与已退役的 `KeyValueTokenIssuanceStore`(embed token,键域 `token:{jti}`,
 * 2026-09-19 随 WP-96 删除)**逐条同构**:GETDEL 原子单次消费 ⇒ 并发消费
 * 至多一方成功;未签发 / 已消费 / 已过期三态同形返回 null;形态损坏 fail-closed
 * 按"无有效记录"处理。
 *
 * 分级 = **fail-closed**(登记于 `REDIS_DEGRADE_POLICY.launchGrantStore`):
 * KeyValueStore 故障翻译为 `store_unavailable` ⇒ create_session 侧拒绝(401),
 * 不降级进程内、不静默放行。
 */
export class KeyValueLaunchGrantStore implements LaunchGrantStore {
  constructor(private readonly kv: KeyValueStore) {}

  async put(record: IssuedLaunchGrantRecord, ttlSeconds: number): Promise<void> {
    await this.kv.set(launchGrantKey(record.jti), JSON.stringify(record), ttlSeconds);
  }

  async consume(jti: string): Promise<IssuedLaunchGrantRecord | null> {
    const key = launchGrantKey(jti);
    const raw = await this.kv.get(key);
    if (raw === null) {
      return null; // 未签发 / 已过期(TTL 自然失效)
    }
    // 原子单次消费仲裁:GETDEL 存在即删,并发下至多一方成功。
    const deleted = await this.kv.deleteIfPresent(key);
    if (!deleted) {
      return null; // 并发消费方已抢先消费
    }
    return decodeIssuedLaunchGrant(raw);
  }
}
