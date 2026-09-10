/**
 * 编排器重启恢复(WP-3;计划书 5.3 / 6.3,会话编排语义规约 D-W8-9 / §四.2)。
 *
 * 两步恢复(D-F8):sessions 行 + 最近快照 → 重启后
 *   load(私有包 + 公开描述包,调用方重新提供)→ import_snapshot(快照信封)
 * → query_projection,复用 session-core 的 `SessionOrchestrator.recover` 路径
 * (本模块只产出其输入形态,不复制恢复状态机)。
 *
 * 恢复点 = 显式 checkpoint + 周期性自动快照(间隔与触发策略配置化,
 * D-API-25)+ 会话关闭;快照保留期由 SnapshotStore.purgeExpired 承担。
 *
 * 秘密零驻留(D-API-23):会话种子永不持久化——sessions 行只有 seed 策略
 * 元数据;server_random_per_session 会话恢复时由 `recoverySeed` 现场再生成
 * 一次性 load 种子(仅瞬时存在于 load 帧构造),import_snapshot 以快照
 * seedState 全量覆盖(快照与回放语义规约 §三"整体替换当前内容"),原始
 * 会话种子不落任何存储。
 */

import { PersistenceError } from "../errors.js";
import type {
  ChallengeBundleStore,
  ChallengeRegistry,
  SessionRepository,
  SnapshotStore,
} from "../ports.js";
import type { SnapshotCipher } from "../snapshot-cipher.js";
import { SnapshotPersistence } from "./snapshot-persistence.js";

/**
 * 两步恢复输入(session-core `RecoverOptions` 同构形态):
 *  - `load.*` 两步之一:spawn + load 的装载参数(私有包 / 公开包 / 一次性种子);
 *  - `snapshot` 两步之二:import_snapshot 载荷(解密后的快照信封对象)。
 * 消费方(WP-4 装配)以此调用 `SessionOrchestrator.recover({...plan.load,
 * snapshot: plan.snapshot, workerCommand})`。
 */
export interface RecoveryPlan {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly challenge: { readonly challengeId: string; readonly challengeVersion: string };
  readonly seedStrategy: string;
  readonly load: {
    readonly privateBundle: unknown;
    readonly publicDescriptor: unknown;
    readonly sessionSeedHex?: string;
  };
  readonly snapshot: Record<string, unknown>;
  readonly snapshotRevision: number | null;
}

export interface SessionRecoveryDeps {
  readonly sessions: SessionRepository;
  readonly registry: ChallengeRegistry;
  readonly bundles: ChallengeBundleStore;
  readonly snapshots: SnapshotStore;
  readonly cipher: SnapshotCipher;
  /**
   * 一次性恢复种子生成器(server_random_per_session 专用;现场 CSPRNG,
   * D-F9 同源)。未提供且策略要求种子 → 恢复拒绝(fail-closed)。
   */
  readonly recoverySeed?: () => string;
}

function decodeJsonBundle(content: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(content).toString("utf8"));
  } catch (error) {
    throw new PersistenceError("store_unavailable", `${label}不是合法 JSON 形态`, { cause: error });
  }
}

export class SessionRecoveryService {
  private readonly snapshotPersistence: SnapshotPersistence;

  constructor(private readonly deps: SessionRecoveryDeps) {
    this.snapshotPersistence = new SnapshotPersistence({
      store: deps.snapshots,
      cipher: deps.cipher,
    });
  }

  /**
   * 产出恢复计划:会话行(租户强制)→ 版本行 → 双包取回 → 最近快照解密。
   * 已关闭会话拒绝恢复(终态不可复活);无快照恢复点拒绝(无 I-4 前提)。
   */
  async planRecovery(sessionId: string, tenantId: string): Promise<RecoveryPlan> {
    const session = await this.deps.sessions.findSession(sessionId, tenantId);
    if (session === null) {
      throw new PersistenceError("session_not_found", "会话不存在或租户不匹配");
    }
    if (session.phase === "closed") {
      throw new PersistenceError("session_not_found", "会话已关闭,不提供恢复路径");
    }

    const version = await this.deps.registry.findChallengeVersion(
      session.challengeId,
      session.challengeVersion,
      tenantId,
    );
    if (version === null) {
      throw new PersistenceError("session_not_found", "会话绑定的题目版本不可读");
    }

    const privateRaw = await this.deps.bundles.getPrivate(session.challengeId, session.challengeVersion);
    const publicRaw = await this.deps.bundles.getPublic(session.challengeId, session.challengeVersion);
    if (privateRaw === null || publicRaw === null) {
      throw new PersistenceError("session_not_found", "会话绑定的题目双包不可取回");
    }

    const loaded = await this.snapshotPersistence.loadLatest(sessionId, tenantId);
    if (loaded === null) {
      throw new PersistenceError("no_snapshot_for_recovery", "无快照恢复点(恢复要求至少一个恢复点)");
    }

    return {
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      userId: session.userId,
      challenge: { challengeId: session.challengeId, challengeVersion: session.challengeVersion },
      seedStrategy: session.seedStrategy,
      load: {
        privateBundle: decodeJsonBundle(privateRaw, "私有判题包"),
        publicDescriptor: decodeJsonBundle(publicRaw, "公开描述包"),
        // seed 永不持久化:server_random 策略现场再生成一次性 load 种子,
        // import_snapshot 全量覆盖 seedState(D-API-23);fixed 策略种子在包内。
        ...(session.seedStrategy === "server_random_per_session"
          ? this.recoverySeedHex()
          : {}),
      },
      snapshot: loaded.envelope,
      snapshotRevision: typeof loaded.envelope["revision"] === "number" ? (loaded.envelope["revision"] as number) : null,
    };
  }

  private recoverySeedHex(): { sessionSeedHex: string } {
    if (this.deps.recoverySeed === undefined) {
      throw new PersistenceError("no_snapshot_for_recovery", "恢复策略要求一次性种子生成器");
    }
    return { sessionSeedHex: this.deps.recoverySeed() };
  }
}
