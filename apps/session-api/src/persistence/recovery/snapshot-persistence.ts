/**
 * 快照落库门面(WP-3;D-W8-11"编排器对快照只存取不解析"的装配形态)。
 *
 * 职责边界:把快照信封(编排器从 checkpoint 回执 / export_snapshot 获得)
 * 规范化序列化为字节后整体加密落库;读取时取回密文、解密、还原信封对象。
 * 本模块**零字段语义**:序列化是机械形态转换,不读、不派生、不缓存任何
 * 快照内字段(seedState 等载荷归 worker 所有,恢复时整体移交 session-core
 * / worker)。
 */

import { PersistenceError } from "../errors.js";
import type { SnapshotOrigin, SnapshotRecord, SnapshotStore } from "../ports.js";
import type { SnapshotCipher } from "../snapshot-cipher.js";

export interface PersistSnapshotInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly origin: SnapshotOrigin;
  readonly revision: number;
  readonly checkpointId?: string | null;
  /** 快照信封(worker 所有;整体加密,零字段解析)。 */
  readonly envelope: Record<string, unknown>;
}

export interface LoadedSnapshot {
  readonly record: SnapshotRecord;
  readonly envelope: Record<string, unknown>;
}

export class SnapshotPersistence {
  constructor(
    private readonly deps: { readonly store: SnapshotStore; readonly cipher: SnapshotCipher },
  ) {}

  /** 信封 → 密文落库(明文只存在于加密调用的瞬时作用域)。 */
  async persist(input: PersistSnapshotInput): Promise<SnapshotRecord> {
    const plaintext = Buffer.from(JSON.stringify(input.envelope), "utf8");
    const ciphertext = this.deps.cipher.encrypt(plaintext);
    return this.deps.store.save({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      checkpointId: input.checkpointId ?? null,
      origin: input.origin,
      revision: input.revision,
      ciphertext,
    });
  }

  /** 最近快照 → 解密还原信封(无快照返回 null)。 */
  async loadLatest(sessionId: string, tenantId: string): Promise<LoadedSnapshot | null> {
    const record = await this.deps.store.latest(sessionId, tenantId);
    if (record === null) {
      return null;
    }
    return { record, envelope: this.decryptEnvelope(record.ciphertext) };
  }

  private decryptEnvelope(ciphertext: Uint8Array): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(this.deps.cipher.decrypt(ciphertext)).toString("utf8"));
    } catch (error) {
      // 解密 / 解析失败统一为快照完整性错误(fail-closed;恢复路径拒绝)。
      throw new PersistenceError("snapshot_auth_failed", "快照解密或形态还原失败", { cause: error });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PersistenceError("snapshot_ciphertext_malformed", "快照信封必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  }
}
