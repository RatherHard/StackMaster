/**
 * 在途会话管理器(任务分解 WP-4 装配面;WP-5 WSS 通道的动作入口对接面)。
 *
 * 职责:把 WP-3 的持久化端口与 WP-2 的认证派生身份接到 session-core 的
 * `SessionOrchestrator`——
 *  - create-session 全链路:注册表取版本行 → 对象存储取双包 → challenge-compiler
 *    `loadChallengePair` 装载管线 → `SessionOrchestrator.create`(私有包
 *    **只透传**:本层对双包仅读取 `seedPolicy.strategy` 以决定会话种子义务,
 *    与 session-core 同一豁免面,零其他字段语义)→ sessions 行落库;
 *  - 生命周期命令的编排侧入口(sync / list / submit / close)与动作入口
 *    (applyAction,WSS 归 WP-5 复用);
 *  - 快照恢复点落库(D-API-25):create_checkpoint 接受回执 → 密文落库
 *    (explicit_checkpoint);周期策略触发 → 最近恢复点落库(auto_periodic);
 *    close 前 → 终态恢复点(session_close);停机冲刷 → 未落库恢复点补落;
 *  - 失败分类:编排器域异常翻译为封闭的呈现类别(timeout / engine_error /
 *    cancelled / session_terminal),worker 退出码 3(看门狗超时)→ timeout,
 *    不透出进程细节(D-API-32 映射矩阵的编排侧判别点);
 *  - WP-6 执行面:每租户并发会话预算(同步入场预留,D-API-52)、checkpoint
 *    存储与快照配额(预执行确定性拒绝,D-API-54)、断线保持到期回收
 *    (reclaimDisconnected,D-API-55)、submit 引用的动作日志增量落库
 *    (D-API-56)——限流频率面在路由 / 通道层(src/limits)。
 *
 * 会话定位:一切命令以 (sessionId, tenantId) 双条件查找在途表——租户不匹配
 * 与不存在同形态返回 null(防枚举;凭证绑定锚已在凭证中间件先行校验)。
 * 已关闭会话从在途表移除:后续命令一律 404(终态资源不复活;重开 =
 * 重新 create_session)。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { loadChallengePair } from "@stackmaster/challenge-compiler";
import {
  ActionResponseSchema,
  type PublicStateProjection,
  type ActionResponse,
  type ActionObject,
} from "@stackmaster/protocol";
import {
  OrchestratorError,
  SessionOrchestrator,
  type SubmitReference,
  type WorkerCommandSpec,
  type WorkerExit,
} from "@stackmaster/session-core";
import type { Logger } from "pino";

import { createSessionAuthContext } from "../auth/auth-context.js";
import type { AuditSink } from "../auth/ports.js";
import type { SessionMetrics } from "../metrics/metrics.js";
import type {
  ActionLogEntryInput,
  ActionLogStore,
  ChallengeBundleStore,
  ChallengeRegistry,
  SessionRepository,
  SnapshotStore,
  SubmissionStore,
} from "../persistence/ports.js";
import type { SnapshotPersistence } from "../persistence/recovery/snapshot-persistence.js";
import type { AutoSnapshotPolicy } from "../persistence/recovery/auto-snapshot-policy.js";
import {
  CHECKPOINT_QUOTA_MESSAGES,
  TenantStorageQuotaMeter,
  envelopeByteLength,
  evaluateCheckpointQuota,
  type CheckpointQuotaLimits,
  type CheckpointQuotaVerdict,
} from "../limits/index.js";
import { ConcurrentSessionBudgetExhausted } from "../limits/errors.js";

/** 题目装载拒绝(注册表缺失 / 双包缺失 / 装载管线任一层拒绝;细节只进日志)。 */
export class ChallengeLoadRejected extends Error {
  constructor(detail: string) {
    super(`challenge load rejected: ${detail}`);
    this.name = "ChallengeLoadRejected";
  }
}

/** clientSeq 单会话预算触顶(协议 §4.4:确定性拒绝,恢复路径 = 重新 create_session)。 */
export class ClientSeqBudgetExhausted extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`client sequence budget exhausted for session ${sessionId}`);
    this.name = "ClientSeqBudgetExhausted";
    this.sessionId = sessionId;
  }
}

/** 已完成分类的编排器域失败(呈现面由 error-mapping 矩阵决定;细节仅日志)。 */
export class MappedOrchestratorFailure extends Error {
  readonly kind: "timeout" | "engine_error" | "cancelled" | "session_terminal" | "not_found";

  constructor(kind: MappedOrchestratorFailure["kind"], detail: string) {
    super(`orchestrator failure (${kind}): ${detail}`);
    this.name = "MappedOrchestratorFailure";
    this.kind = kind;
  }
}

/** 认证派生的会话创建输入(consumeEmbedToken 三方比对通过后的身份)。 */
export interface VerifiedCreateIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly embedTokenJti: string;
}

export interface CreateSessionOutcome {
  readonly sessionId: string;
  readonly revision: number;
  readonly projection: PublicStateProjection;
}

export interface LiveSessionManagerDeps {
  readonly registry: ChallengeRegistry;
  readonly bundles: ChallengeBundleStore;
  readonly sessions: SessionRepository;
  readonly submissions: SubmissionStore;
  readonly snapshotPersistence: SnapshotPersistence;
  readonly audit: AuditSink;
  readonly logger: Logger;
  /** clientSeq 单会话预算(config.maxClientSeqPerSession;协议 §4.4)。 */
  readonly clientSeqLimit: number;
  /** 周期自动快照策略(D-API-25;装配 config.autoSnapshotEveryRevisions)。 */
  readonly autoSnapshot?: AutoSnapshotPolicy;
  // ── WP-6:action_log 落库(D-API-56)与存储 / 快照配额(D-API-54)──
  /** 动作日志存储(append-only;仅已接受动作,与 submit 引用同锚)。 */
  readonly actionLog: ActionLogStore;
  /** 快照仓储(租户存储配额计量源;组合查询用)。 */
  readonly snapshots?: SnapshotStore;
  /** checkpoint 配额三元组(config 启动校验后的冻结形态;缺省 = 全放行)。 */
  readonly quotaLimits?: CheckpointQuotaLimits;
  /** 每租户并发会话预算(config.maxConcurrentSessionsPerTenant;D-API-52)。 */
  readonly maxConcurrentSessionsPerTenant: number;
  /**
   * 指标面(WP-8,D-API-70;可选,缺省 = 零观测开销):动作 RTT / 队列深度 /
   * 并发会话数 / Worker 占用 / 投影增量字节。标签纪律见 metrics 模块
   * (会话 ID 等标识符不入标签)。
   */
  readonly metrics?: SessionMetrics;
  /** 可注入 worker 进程描述(测试假 worker;缺省由 session-core 定位真实二进制)。 */
  readonly workerCommand?: WorkerCommandSpec;
  readonly now?: () => number;
}

interface LiveSession {
  readonly session: SessionOrchestrator;
  readonly tenantId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly challengeVersion: string;
  readonly seedStrategy: string;
  /** 已落库的 checkpoint 恢复点(幂等去重锚)。 */
  readonly persistedCheckpoints: Set<string>;
  /** clientSeq 预算计量(进入动作路径的次数;幂等重放同耗,保守方向)。 */
  clientSeqUsed: number;
  /** 上次落快照时的权威 revision(周期策略计量基准)。 */
  lastSnapshotRevision: number;
  /** 已落 action_log 的已接受动作数(增量补账锚;D-API-56)。 */
  persistedActionCount: number;
  /** 快照字节预算粘性超限标记(只升不降;D-API-54)。 */
  snapshotOverBudget: boolean;
}

/** 会话种子(D-F9:编排器生成的 256-bit 会话种子;hex 形态;仅瞬时存在于 load 帧)。 */
function generateSessionSeedHex(): string {
  return randomBytes(32).toString("hex");
}

/** 服务端签发会话标识(冻结字符集 `^[A-Za-z0-9_-]{1,128}$`)。 */
function generateSessionId(): string {
  return `sess-${randomUUID().replaceAll("-", "")}`;
}

export class LiveSessionManager {
  readonly #live = new Map<string, LiveSession>();
  readonly #deps: LiveSessionManagerDeps;
  readonly #log: Logger;
  /** 并发预算入场预留(每租户;与 #live 合计为预算计量,D-API-52)。 */
  readonly #pendingByTenant = new Map<string, number>();
  /** 租户存储配额计量器(snapshots 缺省时为 null,配额维度降级为放行)。 */
  readonly #tenantStorageMeter: TenantStorageQuotaMeter | null;
  /** 在途动作调用数(队列深度 gauge 真源;WP-8,D-API-70)。 */
  #inFlightActions = 0;

  constructor(deps: LiveSessionManagerDeps) {
    if (!Number.isInteger(deps.clientSeqLimit) || deps.clientSeqLimit < 1) {
      throw new Error("LiveSessionManager:clientSeqLimit 必须为正整数(config 启动校验已拦截)");
    }
    if (
      !Number.isInteger(deps.maxConcurrentSessionsPerTenant) ||
      deps.maxConcurrentSessionsPerTenant < 1
    ) {
      throw new Error(
        "LiveSessionManager:maxConcurrentSessionsPerTenant 必须为正整数(config 启动校验已拦截)",
      );
    }
    this.#deps = deps;
    this.#log = deps.logger.child({ component: "session-manager" });
    this.#tenantStorageMeter =
      deps.snapshots === undefined ? null : new TenantStorageQuotaMeter(deps.sessions, deps.snapshots);
  }

  /** 在途会话数(可观测 / 测试断言)。 */
  get liveCount(): number {
    return this.#live.size;
  }

  /** 指定租户的在途会话数(并发预算快检源;不含入场预留,D-API-52)。 */
  liveCountByTenant(tenantId: string): number {
    let count = 0;
    for (const entry of this.#live.values()) {
      if (entry.tenantId === tenantId) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 会话生命周期计量同步(WP-8,D-API-70 / D-API-72):并发会话数与 Worker
   * 占用在 T0 每会话单进程模型下同源(每个在途会话恰持有一个 vm-worker
   * 子进程);T1 容器化 Worker 池引入后两者分道(池占用 = 进程池租约数)。
   * 标识符不入指标(标签纪律,D-API-71)。
   */
  #syncSessionGauges(): void {
    const metrics = this.#deps.metrics;
    if (metrics === undefined) {
      return;
    }
    const live = this.#live.size;
    metrics.setLiveSessions(live);
    metrics.setWorkerProcesses(live);
  }

  /** 队列深度同步(在途动作调用数;进入 / 离开动作执行路径时调用)。 */
  #syncQueueDepth(): void {
    this.#deps.metrics?.setQueueDepth(this.#inFlightActions);
  }

  // ── create-session 全链路 ────────────────────────────────────────────────

  /**
   * 创建会话:并发预算同步入场预留(D-API-52)→ 注册表 → 双包 → 装载管线 →
   * 编排器 → 会话行 → create_session 审计。embed token 的三方比对消费在路由
   * 层先行完成(身份以本方法输入到达);装载失败抛 ChallengeLoadRejected
   * (呈现 422 / challenge_invalid,细节仅日志),预算触顶抛
   * ConcurrentSessionBudgetExhausted(呈现 429,细节仅日志)。
   *
   * 预算的检查与预留都在首个 await 之前同步完成(JS 单线程下对并发创建
   * 原子):在途数 + 入场预留 ≥ 预算即拒绝——并发创建窗口不超卖、失败路径
   * 在 finally 中如数释放(D-API-52)。
   */
  async createSession(identity: VerifiedCreateIdentity): Promise<CreateSessionOutcome> {
    const pending = this.#pendingByTenant.get(identity.tenantId) ?? 0;
    const liveForTenant = this.liveCountByTenant(identity.tenantId);
    if (liveForTenant + pending >= this.#deps.maxConcurrentSessionsPerTenant) {
      this.#log.warn(
        {
          tenantId: identity.tenantId,
          reason: "concurrent_session_budget_exhausted",
          live: liveForTenant,
          pending,
        },
        "create_session rejected by concurrent session budget",
      );
      throw new ConcurrentSessionBudgetExhausted(
        `tenant ${identity.tenantId} live ${liveForTenant} + pending ${pending} >= budget ` +
          `${this.#deps.maxConcurrentSessionsPerTenant}`,
      );
    }
    this.#pendingByTenant.set(identity.tenantId, pending + 1);
    try {
      return await this.#createSessionReserved(identity);
    } finally {
      const current = this.#pendingByTenant.get(identity.tenantId) ?? 1;
      if (current <= 1) {
        this.#pendingByTenant.delete(identity.tenantId);
      } else {
        this.#pendingByTenant.set(identity.tenantId, current - 1);
      }
    }
  }

  /** createSession 主体(预算预留已取得的路径;私有)。 */
  async #createSessionReserved(identity: VerifiedCreateIdentity): Promise<CreateSessionOutcome> {
    const versionRow = await this.#deps.registry.findChallengeVersion(
      identity.challengeId,
      identity.challengeVersion,
      identity.tenantId,
    );
    if (versionRow === null) {
      this.#log.warn(
        {
          reason: "version_not_registered",
          challengeId: identity.challengeId,
          challengeVersion: identity.challengeVersion,
        },
        "challenge load rejected",
      );
      throw new ChallengeLoadRejected(
        `题目版本未登记(challengeId=${identity.challengeId}, version=${identity.challengeVersion})`,
      );
    }
    const privateRaw = await this.#deps.bundles.getPrivate(identity.challengeId, identity.challengeVersion);
    const publicRaw = await this.#deps.bundles.getPublic(identity.challengeId, identity.challengeVersion);
    if (privateRaw === null || publicRaw === null) {
      this.#log.warn(
        { reason: "bundle_missing", challengeId: identity.challengeId },
        "challenge load rejected",
      );
      throw new ChallengeLoadRejected("题目双包在对象存储中缺失");
    }
    let privateBundle: unknown;
    let publicDescriptor: unknown;
    try {
      privateBundle = JSON.parse(Buffer.from(privateRaw).toString("utf8"));
      publicDescriptor = JSON.parse(Buffer.from(publicRaw).toString("utf8"));
    } catch {
      this.#log.warn(
        { reason: "bundle_malformed_json", challengeId: identity.challengeId },
        "challenge load rejected",
      );
      throw new ChallengeLoadRejected("题目双包不是合法 JSON 形态");
    }

    // 装载管线(Schema → 检查器 → 编译期校验):拒绝即整体拒绝,产物不部分构造。
    // 违规明细(ruleId / message)只进受控日志——message 可能引用包内片段,
    // 绝不外发(私有包内容不入任何公开面)。
    const loaded = loadChallengePair({ publicDescriptor, privateBundle });
    if (!loaded.ok) {
      this.#log.warn(
        {
          challengeId: identity.challengeId,
          challengeVersion: identity.challengeVersion,
          violationCount: loaded.violations.length,
          violationRuleIds: loaded.violations.map((item) => item.ruleId),
        },
        "challenge load rejected by compiler pipeline",
      );
      throw new ChallengeLoadRejected(`装载管线拒绝(${loaded.violations.length} 项违规)`);
    }

    // 会话种子义务:仅读取 seedPolicy.strategy(与 session-core 同一豁免面)。
    const strategy = readSeedStrategy(privateBundle);
    const sessionId = generateSessionId();
    const orchestrator = await SessionOrchestrator.create({
      sessionId,
      privateBundle,
      publicDescriptor,
      ...(strategy === "server_random_per_session" ? { sessionSeedHex: generateSessionSeedHex() } : {}),
      ...(this.#deps.workerCommand === undefined ? {} : { workerCommand: this.#deps.workerCommand }),
      auth: createSessionAuthContext({ sessionId, tenantId: identity.tenantId, userId: identity.userId }),
    });

    await this.#deps.sessions.insertSession({
      sessionId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      challengeId: identity.challengeId,
      challengeVersion: identity.challengeVersion,
      seedStrategy: strategy,
    });

    this.#live.set(sessionId, {
      session: orchestrator,
      tenantId: identity.tenantId,
      userId: identity.userId,
      challengeId: identity.challengeId,
      challengeVersion: identity.challengeVersion,
      seedStrategy: strategy,
      persistedCheckpoints: new Set<string>(),
      clientSeqUsed: 0,
      lastSnapshotRevision: orchestrator.revision,
      persistedActionCount: 0,
      snapshotOverBudget: false,
    });
    this.#syncSessionGauges();

    await this.#deps.audit.append({
      kind: "create_session",
      at: (this.#deps.now ?? Date.now)(),
      actor: { tenantId: identity.tenantId, userId: identity.userId },
      sessionId,
      detail: { embedTokenJti: identity.embedTokenJti, challengeVersion: identity.challengeVersion },
    });
    this.#log.info({ sessionId, tenantId: identity.tenantId, revision: orchestrator.revision }, "session created");
    return {
      sessionId,
      revision: orchestrator.revision,
      projection: orchestrator.projection,
    };
  }

  // ── 生命周期命令(WP-5 复用同一入口)────────────────────────────────────

  /** sync-projection:重发最近缓存投影(不触发谓词重询)。 */
  async syncProjection(
    sessionId: string,
    tenantId: string,
  ): Promise<{ revision: number; projection: PublicStateProjection }> {
    const entry = this.#lookup(sessionId, tenantId);
    if (entry === null) {
      return this.#sessionGone();
    }
    try {
      return entry.session.syncProjection();
    } catch (error) {
      throw await this.#classifyOrchestratorFailure(entry, error);
    }
  }

  /** list-checkpoints:编排器账本查询(快照信封整体 SERVER_ONLY,不离开本层)。 */
  async listCheckpoints(
    sessionId: string,
    tenantId: string,
  ): Promise<readonly { checkpointId: string; label?: string; revision: number }[]> {
    const entry = this.#lookup(sessionId, tenantId);
    if (entry === null) {
      return this.#sessionGone();
    }
    return entry.session.listCheckpoints().map((entry) => ({
      checkpointId: entry.checkpointId,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      revision: entry.revision,
    }));
  }

  /**
   * submit:内部裁决引用落库(submissions 行),响应只含 {submissionId, revision};
   * 随后把引用内的权威动作日志增量落入 ActionLogStore(WP-6 接线,D-API-56:
   * 仅已接受动作——拒绝天然不入账,引用只含已接受动作;增量条目以本次提交
   * 引用为锚 submissionRef;落库失败不影响 submit 成功响应,裁决引用是权威锚)。
   */
  async submit(
    sessionId: string,
    tenantId: string,
  ): Promise<{ submissionId: string; revision: number }> {
    const entry = this.#lookup(sessionId, tenantId);
    if (entry === null) {
      return this.#sessionGone();
    }
    let reference: SubmitReference;
    try {
      reference = entry.session.submit();
    } catch (error) {
      throw await this.#classifyOrchestratorFailure(entry, error);
    }
    const record = await this.#deps.submissions.record({
      tenantId,
      sessionId,
      revision: reference.revision,
      publicStatus: reference.publicStatus,
      reference,
    });
    await this.#persistActionLogDelta(entry, record.id, reference);
    await this.#deps.audit.append({
      kind: "submit",
      at: (this.#deps.now ?? Date.now)(),
      actor: { tenantId, userId: entry.userId },
      sessionId,
      detail: { submissionId: record.id, revision: reference.revision },
    });
    return { submissionId: record.id, revision: reference.revision };
  }

  /** close-session:终态恢复点 → 优雅关闭 → 会话行 closed → 移出在途表。 */
  async closeSession(sessionId: string, tenantId: string): Promise<{ revision: number }> {
    const entry = this.#lookup(sessionId, tenantId);
    if (entry === null) {
      return this.#sessionGone();
    }
    const revision = entry.session.revision;
    // 终态恢复点(D-API-25 ③):close 前落最近恢复点(会话关闭触发点)。
    await this.#flushSessionSnapshot(entry, "session_close", { dedupe: false });
    try {
      await entry.session.closeSession();
    } catch (error) {
      throw await this.#classifyOrchestratorFailure(entry, error);
    }
    await this.#deps.sessions.updateSessionPhase(sessionId, tenantId, "closed");
    this.#live.delete(sessionId);
    this.#syncSessionGauges();
    this.#log.info({ sessionId, tenantId }, "session closed");
    return { revision };
  }

  /**
   * 动作入口(WP-5 WSS 通道复用;REST 面不镜像 12 动作,D-API-1)。
   * clientSeq 预算在此计量:触顶确定性拒绝(幂等重放也消耗预算份额——
   * 保守方向,拒绝确定性不变;恢复路径 = 重新 create_session)。
   * create_checkpoint 在进入执行域之前先过配额闸(WP-6,D-API-54):预执行
   * 确定性拒绝,不触发 worker 往返、不消耗 clientSeq 预算份额;呈现 = 编排器
   * 侧预检 ActionResponse(与 session-core 预检同形,budget_exhausted 静态文案)。
   */
  async applyAction(
    sessionId: string,
    tenantId: string,
    action: ActionObject,
    options: { idempotencyKey?: string } = {},
  ): Promise<ActionResponse> {
    const entry = this.#lookup(sessionId, tenantId);
    if (entry === null) {
      return this.#sessionGone();
    }
    if (entry.clientSeqUsed >= this.#deps.clientSeqLimit) {
      throw new ClientSeqBudgetExhausted(sessionId);
    }
    if (action.type === "create_checkpoint") {
      const verdict = await this.#evaluateCheckpointQuota(entry);
      if (!verdict.ok) {
        this.#log.warn(
          { sessionId, tenantId, reason: verdict.reason },
          "create_checkpoint rejected by storage quota",
        );
        return this.#checkpointQuotaRejection(entry, verdict);
      }
    }
    entry.clientSeqUsed += 1;
    // 指标面(WP-8,D-API-70):队列深度 + 动作 RTT + 投影增量字节。观测在
    // 执行段外围,任何指标路径不得改变既有行为(纯观测,异常传播不变)。
    this.#inFlightActions += 1;
    this.#syncQueueDepth();
    const startedAtMs = performance.now();
    let response: ActionResponse;
    try {
      try {
        response = await entry.session.applyAction(action, options);
      } catch (error) {
        this.#deps.metrics?.observeActionRtt(
          action.type,
          "error",
          (performance.now() - startedAtMs) / 1000,
        );
        throw await this.#classifyOrchestratorFailure(entry, error);
      }
      const elapsedSeconds = (performance.now() - startedAtMs) / 1000;
      this.#deps.metrics?.observeActionRtt(
        action.type,
        // outcome 有界三值(D-API-71):拒绝单独分道;其余执行态(running /
        // paused / won / failed)均属已接受动作(含可解释失败,I-5)。
        response.status === "rejected" ? "rejected" : "accepted",
        elapsedSeconds,
      );
      if (response.status !== "rejected" && response.projectionDelta !== null) {
        this.#deps.metrics?.observeProjectionDelta(
          action.type,
          Buffer.byteLength(JSON.stringify(response.projectionDelta), "utf8"),
        );
      }
    } finally {
      this.#inFlightActions -= 1;
      this.#syncQueueDepth();
    }
    // 快照恢复点落库(显式 checkpoint 触发)+ 周期策略判定(D-API-25)。
    await this.#afterAcceptedAction(entry, action, response);
    return response;
  }

  /** 停机冲刷("在途会话状态落盘"):补落未落库恢复点 + 推进快照锚。 */
  async flushAll(): Promise<void> {
    for (const entry of this.#live.values()) {
      await this.#flushSessionSnapshot(entry, "explicit_checkpoint", { dedupe: true });
    }
    this.#log.info({ liveSessions: this.#live.size }, "live session state flushed");
  }

  /**
   * 断线保持到期回收(WP-6;D-API-55,挂载点 = SessionConnectionRegistry
   * onKeepaliveExpiry 钩子,经 keepaliveExpiryReaper 接线)。回收 =
   * closeSession 语义的资源释放路径:终态恢复点落库(尽力,失败不阻断回收)→
   * worker 优雅关闭(失败即收割退出)→ sessions 行 phase 对齐 closed →
   * 移出在途表 → session_force_closed 审计。`route:{sessionId}` 的释放由
   * 注册表先行完成,本路径不触碰 route 键(无双重释放);已不存在的会话
   * 返回 not_live(回收幂等)。
   */
  async reclaimDisconnected(sessionId: string, tenantId: string): Promise<"reclaimed" | "not_live"> {
    const entry = this.#lookup(sessionId, tenantId);
    if (entry === null) {
      return "not_live";
    }
    try {
      await this.#flushSessionSnapshot(entry, "session_close", { dedupe: false });
    } catch (error) {
      this.#log.warn(
        {
          sessionId,
          tenantId,
          reason: error instanceof Error ? error.message : "terminal snapshot flush failed",
        },
        "terminal snapshot flush failed before keepalive reclaim (reclaim continues)",
      );
    }
    try {
      await entry.session.closeSession();
    } catch (error) {
      // 优雅关闭失败(worker 已死 / 协议违规):收割退出——回收优先于状态细分,
      // 退出形态只进审计与受控日志。
      this.#log.warn(
        {
          sessionId,
          tenantId,
          reason: error instanceof Error ? error.message : "graceful close failed",
        },
        "graceful close failed on keepalive reclaim; worker reaped",
      );
      await entry.session.kill().catch(() => undefined);
    }
    await this.#deps.sessions.updateSessionPhase(sessionId, tenantId, "closed");
    this.#live.delete(sessionId);
    this.#syncSessionGauges();
    await this.#deps.audit.append({
      kind: "session_force_closed",
      at: (this.#deps.now ?? Date.now)(),
      actor: { tenantId: entry.tenantId, userId: entry.userId },
      sessionId,
      detail: { reason: "disconnect_keepalive_expiry" },
    });
    this.#log.info({ sessionId, tenantId }, "session reclaimed after disconnect keepalive expiry");
    return "reclaimed";
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 重启恢复装配(WP-7,D-API-63):把经 `SessionRecoveryService.planRecovery`
   * + `SessionOrchestrator.recover`(两步 load + import_snapshot,D-F8)重建
   * 的编排器重新纳入在途表。计量面按"进程内计数随旧进程消亡"的语义重置:
   *  - clientSeqUsed = 0(clientSeq 预算是本进程进入动作路径的次数计量,
   *    D-API-38;重启即新计量窗口);
   *  - persistedCheckpoints = 空(checkpoint 账本在 recover 中清空,§4.7 退化
   *    形态;后续恢复点按新账本落库);
   *  - persistedActionCount = 0(恢复后账本自快照状态重启,动作日志增量自此
   *    起算——快照锚之前的条目已随重启前的 submit 落库,append-only 不重复);
   *  - lastSnapshotRevision = 恢复 revision(周期策略计量基准)。
   * 不追加审计(审计 kind 集合冻结,D-API-59);恢复事实进受控日志。
   */
  async adoptRecovered(entry: {
    readonly session: SessionOrchestrator;
    readonly tenantId: string;
    readonly userId: string;
    readonly challengeId: string;
    readonly challengeVersion: string;
    readonly seedStrategy: string;
  }): Promise<void> {
    const session = entry.session;
    this.#live.set(session.id, {
      session,
      tenantId: entry.tenantId,
      userId: entry.userId,
      challengeId: entry.challengeId,
      challengeVersion: entry.challengeVersion,
      seedStrategy: entry.seedStrategy,
      persistedCheckpoints: new Set<string>(),
      clientSeqUsed: 0,
      lastSnapshotRevision: session.revision,
      persistedActionCount: 0,
      snapshotOverBudget: false,
    });
    this.#syncSessionGauges();
    this.#log.info(
      { sessionId: session.id, tenantId: entry.tenantId, revision: session.revision },
      "recovered session adopted into live registry",
    );
  }

  /**
   * checkpoint 配额预执行判定(WP-6,D-API-54):粘性超限标记 → 数量上限 →
   * 最近信封字节估计 → 租户存储用量。计量源缺失(snapshots 未注入)时租户
   * 维度放行(持久化边界复核仍兜住粘性维度)。
   */
  async #evaluateCheckpointQuota(entry: LiveSession): Promise<CheckpointQuotaVerdict> {
    const limits = this.#deps.quotaLimits;
    if (limits === undefined) {
      return { ok: true };
    }
    const checkpoints = entry.session.listCheckpoints();
    const latest = checkpoints[checkpoints.length - 1];
    let tenantUsed: number | null = null;
    if (this.#tenantStorageMeter !== null) {
      tenantUsed = await this.#tenantStorageMeter.usedBytes(entry.tenantId);
    }
    return evaluateCheckpointQuota({
      checkpointCount: checkpoints.length,
      latestEnvelopeByteLength: latest === undefined ? null : envelopeByteLength(latest.snapshot),
      snapshotOverBudget: entry.snapshotOverBudget,
      tenantStorageUsedBytes: tenantUsed,
      limits,
    });
  }

  /** 配额触顶的确定性预检响应(与 session-core 预检同形;requestId 服务端签发)。 */
  #checkpointQuotaRejection(entry: LiveSession, verdict: CheckpointQuotaVerdict): ActionResponse {
    const reason = verdict.ok ? undefined : verdict.reason;
    return ActionResponseSchema.parse({
      requestId: `req-${randomUUID().replaceAll("-", "")}`,
      revision: entry.session.revision,
      status: "rejected",
      projectionDelta: null,
      publicEvents: [],
      userVisibleError: {
        code: "budget_exhausted",
        message: CHECKPOINT_QUOTA_MESSAGES[reason ?? "checkpoint_count"],
      },
    });
  }

  /**
   * 动作日志增量落库(WP-6 接线,D-API-56):SubmitReference.actionLog 是编排
   * 核心账本的权威投影(仅已接受动作,拒绝天然不入账;条目 clientSeq 为编排
   * 器内部水位,与裁决引用同源)。只落上次提交之后的增量(append-only 不重复),
   * 每条以本次 submissions 行为锚(submissionRef)。落库失败:不回滚裁决引用
   * (reference 是权威锚,verifier 重放面以引用为准),不推进增量锚——下次
   * submit 补账;细节只进受控日志(审计 kind 集合冻结,不因实现期接线扩张)。
   */
  async #persistActionLogDelta(
    entry: LiveSession,
    submissionRef: string,
    reference: SubmitReference,
  ): Promise<void> {
    const pending = reference.actionLog.slice(entry.persistedActionCount);
    if (pending.length === 0) {
      return;
    }
    const inputs: ActionLogEntryInput[] = pending.map((item) => ({
      sessionId: entry.session.id,
      tenantId: entry.tenantId,
      clientSeq: item.clientSeq,
      revisionAfter: item.revisionAfter,
      action: item.action,
      submissionRef,
    }));
    try {
      await this.#deps.actionLog.append(inputs);
      entry.persistedActionCount = reference.actionLog.length;
    } catch (error) {
      this.#log.warn(
        {
          sessionId: entry.session.id,
          tenantId: entry.tenantId,
          submissionRef,
          pendingCount: pending.length,
          reason: error instanceof Error ? error.message : "action log persistence failed",
        },
        "action log persistence failed (submission reference remains authoritative; delta retried on next submit)",
      );
    }
  }

  #lookup(sessionId: string, tenantId: string): LiveSession | null {
    const entry = this.#live.get(sessionId);
    if (entry === undefined || entry.tenantId !== tenantId) {
      return null; // 租户不匹配与不存在同形态(防枚举)
    }
    return entry;
  }

  /** 会话定位失败统一形态(不存在 / 已关闭回收 / 租户不匹配同形;路由层映射 404 防枚举)。 */
  #sessionGone(): never {
    throw new MappedOrchestratorFailure("not_found", "session not found in live registry");
  }

  /**
   * 编排器域异常分类:worker 崩溃先收割退出(watchdog_timeout → timeout,
   * 其余 → engine_error)并把会话移出在途表;已关闭回收的定位失败以
   * session_terminal 表达(呈现 404)。cancelled 为 WP-6 强制终止预留类别。
   */
  async #classifyOrchestratorFailure(
    entry: LiveSession,
    error: unknown,
  ): Promise<MappedOrchestratorFailure> {
    if (error instanceof MappedOrchestratorFailure) {
      return error;
    }
    if (error instanceof OrchestratorError) {
      if (error.code === "session_closed") {
        return new MappedOrchestratorFailure("session_terminal", error.message);
      }
      if (error.code === "worker_crashed" || error.code === "invalid_worker_output") {
        const exit = await this.#reap(entry);
        if (exit.kind === "watchdog_timeout") {
          return new MappedOrchestratorFailure("timeout", "worker watchdog timeout (exit kind)");
        }
        return new MappedOrchestratorFailure("engine_error", `worker exited (${exit.kind})`);
      }
      return new MappedOrchestratorFailure("engine_error", error.message);
    }
    return new MappedOrchestratorFailure(
      "engine_error",
      error instanceof Error ? error.message : "unknown orchestrator failure",
    );
  }

  /** 收割崩溃会话:强制终止 → 移出在途表 → session_force_closed 审计。 */
  async #reap(entry: LiveSession): Promise<WorkerExit> {
    const exit = await entry.session.kill();
    this.#live.delete(entry.session.id);
    this.#syncSessionGauges();
    await this.#deps.audit.append({
      kind: "session_force_closed",
      at: (this.#deps.now ?? Date.now)(),
      actor: { tenantId: entry.tenantId, userId: entry.userId },
      sessionId: entry.session.id,
      detail: { exitKind: exit.kind },
    });
    this.#log.warn({ sessionId: entry.session.id, exitKind: exit.kind }, "session reaped after worker failure");
    return exit;
  }

  /** 已接受动作后的恢复点落库:显式 checkpoint 回执 + 周期策略触发。 */
  async #afterAcceptedAction(
    entry: LiveSession,
    action: ActionObject,
    response: ActionResponse,
  ): Promise<void> {
    if (action.type === "create_checkpoint" && response.status !== "rejected") {
      await this.#flushSessionSnapshot(entry, "explicit_checkpoint", { dedupe: true });
      return;
    }
    const policy = this.#deps.autoSnapshot;
    if (
      policy !== undefined &&
      response.status !== "rejected" &&
      policy.shouldAutoSnapshot(entry.session.revision - entry.lastSnapshotRevision)
    ) {
      await this.#flushSessionSnapshot(entry, "auto_periodic", { dedupe: false });
      entry.lastSnapshotRevision = entry.session.revision;
    }
  }

  /**
   * 落最近恢复点:编排器账本最近 checkpoint 信封 → SnapshotPersistence 密文落库
   * (信封零字段解析;编排核心未暴露逐 revision export 通道前,周期触发复用
   * 最近恢复点——信封自身 revision 如实落行,恢复语义本为"最近快照丢尾")。
   * 无恢复点可用(尚无 checkpoint)时静默跳过(无快照即无恢复点,不伪造)。
   * 持久化边界的字节预算复核(WP-6,D-API-54):实际信封字节超出预算即不落库
   * (恢复锚回退上一个预算内快照)并置粘性标记,此后 create_checkpoint 一律
   * 预执行拒绝;超限事实进审计与受控日志,零响应面透出。
   */
  async #flushSessionSnapshot(
    entry: LiveSession,
    origin: "explicit_checkpoint" | "auto_periodic" | "session_close",
    options: { dedupe: boolean },
  ): Promise<void> {
    const checkpoints = entry.session.listCheckpoints();
    const latest = checkpoints[checkpoints.length - 1];
    if (latest === undefined) {
      return;
    }
    if (options.dedupe && entry.persistedCheckpoints.has(latest.checkpointId)) {
      return;
    }
    const byteBudget = this.#deps.quotaLimits?.snapshotByteBudget;
    if (byteBudget !== undefined && envelopeByteLength(latest.snapshot) > byteBudget) {
      if (!entry.snapshotOverBudget) {
        entry.snapshotOverBudget = true;
        // 超限事实只进受控日志(审计 kind 集合冻结,不因实现期接线扩张;
        // 扩展归阶段六审计面,D-API-54)。
        this.#log.warn(
          { sessionId: entry.session.id, tenantId: entry.tenantId },
          "snapshot envelope beyond byte budget; checkpoint persistence halted (sticky)",
        );
      }
      return;
    }
    const record = await this.#deps.snapshotPersistence.persist({
      tenantId: entry.tenantId,
      sessionId: entry.session.id,
      checkpointId: latest.checkpointId,
      origin,
      revision: latest.revision,
      envelope: latest.snapshot,
    });
    entry.persistedCheckpoints.add(latest.checkpointId);
    entry.lastSnapshotRevision = Math.max(entry.lastSnapshotRevision, entry.session.revision);
    await this.#deps.sessions.updateSessionSnapshotAnchor(
      entry.session.id,
      entry.tenantId,
      record.id,
      entry.session.revision,
    );
  }
}

/** seed 策略豁免面读取(与 session-core 同一字段;零其他包内字段语义)。 */
function readSeedStrategy(privateBundle: unknown): string {
  const bundle = privateBundle as
    | { seedPolicy?: { strategy?: string } }
    | undefined;
  return bundle?.seedPolicy?.strategy ?? "fixed";
}
