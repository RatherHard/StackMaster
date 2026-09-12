/**
 * 会话编排核心(WP-8;进程内服务,HTTP / WSS 网络面归阶段三)。
 *
 * 生命周期状态机、单会话串行队列、worker 进程管理、服务端校验基线 #1–#5
 * 的编排侧实现、revision / 投影账本、幂等缓存、submit 内部引用与崩溃替换
 * 恢复的语义权威:`docs/develop/会话编排语义规约.md`(D-W8-1 ~ D-W8-10)。
 *
 * 秘密零驻留(规约 §三):私有包与会话种子在本层**只透传**——load 帧构造
 * 仅读取 `seedPolicy.strategy`(决定是否必须携带会话种子)与身份三元组,
 * 不解析 secrets / judging / hiddenTests / IR,不进账本、缓存与日志;崩溃
 * 恢复因此要求调用方**重新提供**装载参数(recover 不留存私有包)。
 */

import {
  ActionObjectSchema,
  ActionRequestSchema,
  ActionResponseSchema,
  PublicStateProjectionSchema,
  canonicalize,
  type ActionResponse,
  type PublicStateProjection,
} from "@stackmaster/protocol";

/** 12 动作判别对象(协议冻结面;`type` + `args`)。 */
export type ActionObject = import("@stackmaster/protocol").ActionObject;
import { OrchestratorError } from "./errors.js";
import type { AuthContext } from "./auth.js";
import { stubAuthContext } from "./auth.js";
import {
  WorkerConnection,
  type ReadyFrame,
  type WorkerCommandSpec,
  type WorkerExit,
} from "./worker-connection.js";
import { resolveWorkerLauncher, type WorkerLauncherFactory } from "./worker-execution.js";

/** 编排器可产生的确定性拒绝码(冻结 PublicError 16 码子集)。 */
export type PrecheckErrorCode =
  | "stale_base_revision"
  | "stale_client_seq"
  | "idempotency_conflict";

/** 冻结静态模板(基线 #8:零解释、零校验器细节)。 */
const PRECHECK_MESSAGES: Record<PrecheckErrorCode, string> = {
  stale_base_revision: "base revision is stale",
  stale_client_seq: "client sequence is stale",
  idempotency_conflict: "idempotency key conflict",
};

/** checkpoint 账本条目(list-checkpoints 的数据源)。 */
export interface CheckpointEntry {
  readonly checkpointId: string;
  readonly label?: string;
  /** 内容 revision(create_checkpoint 响应的 revision)。 */
  readonly revision: number;
  /** 快照信封(崩溃恢复点)。 */
  readonly snapshot: Record<string, unknown>;
}

/** submit 内部裁决引用(阶段六 verifier 重放的对接形态;D-W8-9)。 */
export interface SubmitReference {
  readonly form: "stackmaster-session-submit/1";
  readonly sessionId: string;
  readonly challenge: {
    readonly challengeId: string;
    readonly challengeContentVersion: string;
    readonly vmProfileVersion: string;
  };
  readonly engine: {
    readonly vmEngineVersion: string;
    readonly engineBuildId: string;
  };
  /** seed 策略元数据(**不含 seed 值**)。 */
  readonly seedPolicy: { readonly strategy: string };
  readonly revision: number;
  readonly publicStatus: string;
  /** 规范化动作日志(仅已接受动作;被拒绝不入账)。 */
  readonly actionLog: readonly {
    readonly clientSeq: number;
    readonly revisionAfter: number;
    readonly action: ActionObject;
  }[];
  /**
   * 重放材料(阶段六 WP-61;`exportReplayMaterial` 随行,编排器落库前组装):
   * 六记录项上下文 + 引擎权威规范化动作日志(`stackmaster-action-log/1`
   * 文本,含状态哈希序列)。整体 SERVER_ONLY:引擎进程协议面,零浏览器
   * 可达面;verifier 消费(纯搬运与落库,零裁决语义)。
   */
  readonly replay?: ReplayMaterial;
}

/** 回放上下文(六记录项,版本策略 §三;**不含 seed 值**)。 */
export interface ReplayContextSummary {
  readonly challengeId: string;
  readonly challengeContentVersion: string;
  readonly vmProfileVersion: string;
  readonly vmEngineVersion: string;
  readonly engineBuildId: string;
  readonly verdictRuleVersion: string;
  readonly challengeBundleHash: string;
  readonly vmProfileHash: string;
  readonly archBits: number;
  readonly seedPolicy: {
    readonly strategy: string;
    readonly derivation: {
      readonly algorithmId: string;
      readonly draws: number;
    } | null;
  };
}

/** 重放材料(`export_action_log` 响应;引擎进程协议 SERVER_ONLY 面)。 */
export interface ReplayMaterial {
  readonly replayContext: ReplayContextSummary;
  /** 规范化动作日志文本(`stackmaster-action-log/1`;`log_digest` 的摘要输入)。 */
  readonly actionLog: string;
}

export interface CreateSessionOptions {
  /** 服务端签发的会话标识(缺省由核心生成随机串)。 */
  sessionId?: string;
  /** 私有判题包(整体 SERVER_ONLY;worker 是唯一校验点,本层只透传)。 */
  privateBundle: unknown;
  /** 公开描述包(D-F10;整体 PUBLIC,本层只透传)。 */
  publicDescriptor: unknown;
  /** 会话种子(D-F9:编排器生成传入;`fixed` 策略必须省略)。 */
  sessionSeedHex?: string;
  /** 可注入 worker 进程描述(测试假 worker;缺省定位真实二进制)。 */
  workerCommand?: WorkerCommandSpec;
  /**
   * 可注入 worker 执行形态启动器工厂(WP-66:容器池显式启用形态经此注入;
   * 优先于 workerCommand —— 形态选择归装配层,单会话启动器由会话 ID 派生)。
   */
  workerLauncherFactory?: WorkerLauncherFactory;
  /** 可注入认证上下文(阶段二替身;真实认证归阶段三)。 */
  auth?: AuthContext;
}

export interface RecoverOptions extends CreateSessionOptions {
  /** 最近服务端快照信封(export_snapshot / checkpoint 回执形态)。 */
  snapshot: Record<string, unknown>;
}

export type SessionPhase = "active" | "crashed" | "closed";

interface LoadedSummary {
  challengeId: string;
  challengeContentVersion: string;
  vmProfileVersion: string;
}

/**
 * 单会话编排器:一个实例绑定一个 worker 进程(ADR-3 单会话单进程),
 * 一个串行队列(基线 #5),一份 revision / 投影 / checkpoint / 幂等账本。
 */
export class SessionOrchestrator {
  private connection: WorkerConnection;
  private readonly ready: ReadyFrame;
  private readonly sessionId: string;
  private readonly loaded: LoadedSummary;
  private readonly seedStrategy: string;
  private readonly auth: AuthContext;
  private queue: Promise<void>;
  private clientSeqWatermark: number;
  private revisionLedger: number;
  private lastProjection: PublicStateProjection;
  private readonly idempotencyCache = new Map<
    string,
    {
      requestCanonical: string;
      response: ActionResponse;
      originalClientSeq: number;
      originalBaseRevision: number;
    }
  >();
  private readonly checkpointLedger: CheckpointEntry[] = [];
  private readonly acceptedActions: {
    clientSeq: number;
    revisionAfter: number;
    action: ActionObject;
  }[] = [];
  private publicStatus: string;
  private phaseState: SessionPhase = "active";

  private constructor(init: {
    connection: WorkerConnection;
    ready: ReadyFrame;
    sessionId: string;
    loaded: LoadedSummary;
    seedStrategy: string;
    auth: AuthContext;
    revision: number;
    projection: PublicStateProjection;
  }) {
    this.connection = init.connection;
    this.ready = init.ready;
    this.sessionId = init.sessionId;
    this.loaded = init.loaded;
    this.seedStrategy = init.seedStrategy;
    this.auth = init.auth;
    this.revisionLedger = init.revision;
    this.lastProjection = init.projection;
    this.queue = Promise.resolve();
    this.clientSeqWatermark = 0;
    this.publicStatus = init.projection.status;
  }

  /** create-session:执行形态启动 → ready 比对 → load → query_projection(§5.1;WP-66 形态注入)。 */
  static async create(options: CreateSessionOptions): Promise<SessionOrchestrator> {
    // 会话标识先于承载启动确定(容器形态按其派生容器名;生成序对调用方零观感差异)。
    const sessionId = options.sessionId ?? SessionOrchestrator.generateSessionId();
    const launcher = await resolveWorkerLauncher({
      sessionId,
      workerLauncherFactory: options.workerLauncherFactory,
      workerCommand: options.workerCommand,
    });
    const { connection, ready } = await WorkerConnection.connect(launcher);

    // 私有包透传面:仅读取 seed 策略(决定会话种子义务)与身份三元组。
    const bundle = options.privateBundle as
      | {
          seedPolicy?: { strategy?: string };
          challengeId?: string;
          challengeContentVersion?: string;
          vmProfileVersion?: string;
        }
      | undefined;
    const strategy = bundle?.seedPolicy?.strategy ?? "fixed";
    try {
      if (strategy === "fixed" && options.sessionSeedHex !== undefined) {
        throw new OrchestratorError(
          "worker_command_rejected",
          "fixed 策略禁止携带会话种子(seed 在包内)",
        );
      }
      if (
        strategy === "server_random_per_session" &&
        options.sessionSeedHex === undefined
      ) {
        throw new OrchestratorError(
          "worker_command_rejected",
          "server_random_per_session 策略必须携带编排器生成的会话种子",
        );
      }
      const load = await connection.request({
        type: "load",
        privateBundle: options.privateBundle,
        publicDescriptor: options.publicDescriptor,
        ...(options.sessionSeedHex === undefined
          ? {}
          : { sessionSeedHex: options.sessionSeedHex }),
      });
      if (load.type !== "loaded") {
        throw new OrchestratorError(
          "worker_command_rejected",
          "题目装载被 worker 拒绝(challenge_invalid 方向)",
        );
      }
      const loaded = load.loaded as LoadedSummary & { initialRevision: number };

      const projection = await SessionOrchestrator.queryProjection(connection);
      const auth = options.auth ?? stubAuthContext;
      auth.assertSessionAllowed({ sessionId });

      return new SessionOrchestrator({
        connection,
        ready,
        sessionId,
        loaded: {
          challengeId: loaded.challengeId,
          challengeContentVersion: loaded.challengeContentVersion,
          vmProfileVersion: loaded.vmProfileVersion,
        },
        seedStrategy: strategy,
        auth,
        revision: loaded.initialRevision,
        projection,
      });
    } catch (error) {
      connection.destroy();
      throw error;
    }
  }

  /**
   * 崩溃替换恢复(协议 D-F8 编排侧编排):spawn 新进程 → load(私有包 +
   * 公开包,调用方重新提供——核心不留存)→ import_snapshot → 重同步取数;
   * 账本重建:revision 自快照信封续算、checkpoint 账本清空(§4.7 退化)。
   */
  static async recover(options: RecoverOptions): Promise<SessionOrchestrator> {
    const session = await SessionOrchestrator.create(options);
    const envelopeRevision = options.snapshot["revision"];
    const imported = await session.rawRequest({
      type: "import_snapshot",
      snapshot: options.snapshot,
    });
    if (imported.type !== "snapshot_imported") {
      session.connection.destroy();
      throw new OrchestratorError(
        "worker_command_rejected",
        "快照导入被 worker 拒绝",
      );
    }
    if (typeof envelopeRevision === "number") {
      session.revisionLedger = envelopeRevision;
    }
    session.lastProjection = await SessionOrchestrator.queryProjection(
      session.connection,
    );
    session.publicStatus = session.lastProjection.status;
    return session;
  }

  /** 会话标识。 */
  get id(): string {
    return this.sessionId;
  }

  /** 认证派生主体(基线 #1:身份只来自认证上下文)。 */
  get principal(): { userId: string; tenantId: string } {
    return this.auth.principal();
  }

  /** 权威 revision(账本;只来自 worker 响应)。 */
  get revision(): number {
    return this.revisionLedger;
  }

  /** 最近缓存投影(sync-projection 的重发源)。 */
  get projection(): PublicStateProjection {
    return this.lastProjection;
  }

  /** 已接受动作数(规范化动作日志长度)。 */
  get acceptedActionCount(): number {
    return this.acceptedActions.length;
  }

  get phase(): SessionPhase {
    return this.phaseState;
  }

  // ── 动作面(基线 #3/#4/#5 的编排侧实现)────────────────────────────────

  /**
   * 入队一个动作:串行队列 → 幂等 → clientSeq 高水位 → baseRevision 预检 →
   * worker `apply_action` → 响应复验 → 账本推进。预检拒绝是确定性响应
   * (不触发 worker 往返)。
   */
  applyAction(
    action: ActionObject,
    options: { idempotencyKey?: string } = {},
  ): Promise<ActionResponse> {
    // 动作判别式复验(未知动作 / 非法 args 在编排器即拒绝;worker 重校验
    // #6 是第二道闸)。
    const validated = ActionObjectSchema.parse(action) as ActionObject;
    return this.enqueue(() => this.applyActionNow(validated, options.idempotencyKey));
  }

  private async applyActionNow(
    action: ActionObject,
    idempotencyKey: string | undefined,
  ): Promise<ActionResponse> {
    this.assertActive();
    const requestId = `req-${crypto.randomUUID().replaceAll("-", "")}`;
    const key = idempotencyKey ?? `auto-${requestId}`;

    // 基线 #4:幂等防重(§4.3)——重试必须原样重发同一请求(同 clientSeq /
    // baseRevision):缓存命中时以**原始信封序号**重构请求做规范化比较;
    // 同键同负载 → 字节相同重放缓存响应;同键异负载 → 确定性冲突拒绝。
    const cached = this.idempotencyCache.get(key);
    if (cached !== undefined) {
      const retry = ActionRequestSchema.parse({
        protocolVersion: 1,
        sessionId: this.sessionId,
        clientSeq: cached.originalClientSeq,
        baseRevision: cached.originalBaseRevision,
        idempotencyKey: key,
        action,
      });
      if (canonicalize(retry) === cached.requestCanonical) {
        return cached.response;
      }
      return this.precheckRejection(this.revisionLedger, requestId, "idempotency_conflict");
    }

    const clientSeq = this.clientSeqWatermark + 1;
    const request = ActionRequestSchema.parse({
      protocolVersion: 1,
      sessionId: this.sessionId,
      clientSeq,
      baseRevision: this.revisionLedger,
      idempotencyKey: key,
      action,
    });

    // 基线 #5(clientSeq 高水位)+ 基线 #3(baseRevision 预检)。
    // 被拒绝的请求同样消耗其 clientSeq(高水位仍推进)。
    if (request.clientSeq <= this.clientSeqWatermark) {
      this.clientSeqWatermark = request.clientSeq;
      return this.precheckRejection(this.revisionLedger, requestId, "stale_client_seq");
    }
    if (request.baseRevision !== this.revisionLedger) {
      this.clientSeqWatermark = request.clientSeq;
      return this.precheckRejection(this.revisionLedger, requestId, "stale_base_revision");
    }

    let frame;
    try {
      frame = await this.connection.request({
        type: "apply_action",
        requestId,
        actionRequest: request,
      });
    } catch (error) {
      // 连接层故障(进程退出 / 帧违规):标记崩溃后原样上抛(恢复路径)。
      this.phaseState = "crashed";
      throw error;
    }
    const response = this.expectActionResponse(frame);

    // 账本推进(权威 revision 来自 worker;ZR-P5 账本侧断言:增量 ∈ {0,+1})。
    const delta = response.revision - this.revisionLedger;
    if (delta !== 0 && delta !== 1) {
      this.phaseState = "crashed";
      this.connection.kill();
      throw new OrchestratorError(
        "protocol_violation",
        "worker revision 增量越界(非 {0,+1})",
      );
    }
    this.clientSeqWatermark = request.clientSeq;
    this.revisionLedger = response.revision;
    if (response.status !== "rejected") {
      this.acceptedActions.push({
        clientSeq: request.clientSeq,
        revisionAfter: response.revision,
        action,
      });
      this.publicStatus = response.status;
      // 缓存完整投影以 worker 权威再生成刷新(第二帧,stop-and-wait):
      // 投影生成唯一来源在执行域内(ADR-7),编排器不做增量合流——
      // sync-projection 重发的"最近缓存投影"由此保持权威(D-W8-9)。
      this.lastProjection = await SessionOrchestrator.queryProjection(
        this.connection,
      );
    }
    this.idempotencyCache.set(key, {
      requestCanonical: canonicalize(request),
      response,
      originalClientSeq: request.clientSeq,
      originalBaseRevision: request.baseRevision,
    });

    // checkpoint 回执 → 账本(D-F7;list-checkpoints 的数据源)。
    if (action.type === "create_checkpoint" && response.status !== "rejected") {
      const receipt = frame["checkpointExport"] as
        | { checkpointId?: unknown; snapshot?: Record<string, unknown> }
        | null
        | undefined;
      if (
        receipt !== null &&
        typeof receipt === "object" &&
        typeof receipt.checkpointId === "string"
      ) {
        this.checkpointLedger.push({
          checkpointId: receipt.checkpointId,
          ...(action.args.label === undefined ? {} : { label: action.args.label }),
          revision: response.revision,
          snapshot: receipt.snapshot ?? {},
        });
      }
    }
    return response;
  }

  /** list-checkpoints:编排器账本查询,无 worker 往返(§5.1)。 */
  listCheckpoints(): readonly CheckpointEntry[] {
    return this.checkpointLedger;
  }

  /** sync-projection:重发最近缓存投影,不触发谓词重询(D1 约束 1)。 */
  syncProjection(): { revision: number; projection: PublicStateProjection } {
    this.assertActive();
    return { revision: this.revisionLedger, projection: this.lastProjection };
  }

  /** submit:内部裁决引用(D-W8-9;最终裁决归阶段六 verifier)。 */
  submit(): SubmitReference {
    return {
      form: "stackmaster-session-submit/1",
      sessionId: this.sessionId,
      challenge: this.loaded,
      engine: {
        vmEngineVersion: this.ready.vmEngineVersion,
        engineBuildId: this.ready.engineBuildId,
      },
      seedPolicy: { strategy: this.seedStrategy },
      revision: this.revisionLedger,
      publicStatus: this.publicStatus,
      actionLog: this.acceptedActions,
    };
  }

  /**
   * 重放材料导出(阶段六 WP-61;`export_action_log` worker 往返):引擎权威
   * 的六记录项上下文 + 规范化动作日志文本。编排器在 submit 落库前调用并组装
   * 进裁决引用(`replay` 字段);经串行队列承载,不与在途动作交错。响应面为
   * 引擎 SERVER_ONLY 面:本层只做最小结构复验(5.6 对 worker 输出复验的
   * 编排侧纪律)后原样透传,零语义解析。
   */
  exportReplayMaterial(): Promise<ReplayMaterial> {
    return this.enqueue(async () => {
      this.assertActive();
      const frame = await this.rawRequest({ type: "export_action_log" });
      if (frame.type !== "action_log_exported") {
        this.phaseState = "crashed";
        this.connection.kill();
        throw new OrchestratorError(
          "invalid_worker_output",
          "export_action_log 未回 action_log_exported 帧",
        );
      }
      const material = parseReplayMaterial(frame);
      if (material === null) {
        this.phaseState = "crashed";
        this.connection.kill();
        throw new OrchestratorError(
          "invalid_worker_output",
          "worker 重放材料未通过结构复验",
        );
      }
      return material;
    });
  }

  // ── 关闭与进程管理(D-W8-10)──────────────────────────────────────────

  /** close-session:优雅 shutdown,进程以退出码 0 结束,不复用。 */
  async closeSession(): Promise<void> {
    await this.queue;
    if (this.phase === "closed") {
      return;
    }
    if (this.phase === "crashed") {
      throw new OrchestratorError("worker_crashed", "worker 已崩溃,无需关闭");
    }
    const ack = await this.connection.request({ type: "shutdown" });
    if (ack.type !== "shutdown_ack") {
      this.connection.kill();
      this.phaseState = "crashed";
      throw new OrchestratorError("protocol_violation", "shutdown 未获确认");
    }
    const exit = await this.connection.waitExit();
    this.phaseState = exit.kind === "graceful" ? "closed" : "crashed";
    if (exit.kind !== "graceful") {
      throw new OrchestratorError("worker_crashed", "worker 退出码非 0");
    }
  }

  /** 强制终止(编排器外层资源兜底;恢复归 SessionOrchestrator.recover)。 */
  async kill(): Promise<WorkerExit> {
    this.phaseState = "crashed";
    this.connection.kill();
    return this.connection.waitExit();
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** 串行队列入口(基线 #5;响应顺序 = 执行顺序)。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertActive(): void {
    if (this.phase !== "active") {
      throw new OrchestratorError(
        "worker_crashed",
        "会话不可用;崩溃恢复走 SessionOrchestrator.recover",
      );
    }
  }

  /** 预检确定性拒绝(基线 #8:冻结形态 + 静态模板,零细节)。 */
  private precheckRejection(
    revision: number,
    requestId: string,
    code: PrecheckErrorCode,
  ): ActionResponse {
    return ActionResponseSchema.parse({
      requestId,
      revision,
      status: "rejected",
      projectionDelta: null,
      publicEvents: [],
      userVisibleError: { code, message: PRECHECK_MESSAGES[code] },
    });
  }

  /** worker 响应复验(编排器对 worker 输出按同一契约重新校验,5.6)。 */
  private expectActionResponse(frame: {
    type: string;
    [field: string]: unknown;
  }): ActionResponse {
    if (frame.type === "command_error") {
      // 命令级错误(§六)不是动作响应:转译为编排错误,不伪造响应面。
      const error = frame["error"] as { code?: string } | undefined;
      throw new OrchestratorError(
        "worker_command_rejected",
        `worker 命令级错误:${error?.code ?? "unknown"}`,
      );
    }
    if (frame.type !== "action_response") {
      this.phaseState = "crashed";
      this.connection.kill();
      throw new OrchestratorError(
        "invalid_worker_output",
        "apply_action 未回 action_response 帧",
      );
    }
    const parsed = ActionResponseSchema.safeParse(frame["actionResponse"]);
    if (!parsed.success) {
      this.phaseState = "crashed";
      this.connection.kill();
      throw new OrchestratorError(
        "invalid_worker_output",
        "worker 响应未通过冻结 Schema 复验",
      );
    }
    const response = parsed.data;
    // 载荷占位约束(语义 §2.2):delta.revision === 信封 revision。
    if (
      response.projectionDelta !== null &&
      response.projectionDelta.revision !== response.revision
    ) {
      this.phaseState = "crashed";
      this.connection.kill();
      throw new OrchestratorError(
        "invalid_worker_output",
        "worker 增量 revision 与信封不一致",
      );
    }
    return response;
  }

  private rawRequest(frame: Record<string, unknown>): Promise<{
    type: string;
    seq?: number;
    [field: string]: unknown;
  }> {
    return this.connection.request(frame);
  }

  private static async queryProjection(
    connection: WorkerConnection,
  ): Promise<PublicStateProjection> {
    const frame = await connection.request({ type: "query_projection" });
    if (frame.type !== "projection") {
      connection.destroy();
      throw new OrchestratorError(
        "invalid_worker_output",
        "query_projection 未回 projection 帧",
      );
    }
    const parsed = PublicStateProjectionSchema.safeParse(frame["projection"]);
    if (!parsed.success) {
      connection.destroy();
      throw new OrchestratorError(
        "invalid_worker_output",
        "worker 投影未通过冻结 Schema 复验",
      );
    }
    return parsed.data;
  }

  /** 会话标识(服务端签发字符集 `^[A-Za-z0-9_-]{1,128}$`)。 */
  private static generateSessionId(): string {
    return `sess-${crypto.randomUUID().replaceAll("-", "")}`;
  }
}

/** 64 位十六进制(SHA-256 摘要 / 状态哈希形态域)。 */
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * 重放材料最小结构复验(WP-61;编排器对 worker 输出的复验纪律,5.6):
 * 字段在、类型对、摘要形态合;零语义解析(内容面归引擎与 verifier)。
 * 失败返回 null(调用方按 invalid_worker_output 处置)。
 */
function parseReplayMaterial(frame: { readonly [field: string]: unknown }): ReplayMaterial | null {
  const context = frame["replayContext"];
  const actionLog = frame["actionLog"];
  if (typeof actionLog !== "string" || actionLog.length === 0) {
    return null;
  }
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const record = context as { readonly [field: string]: unknown };
  const stringFields = [
    "challengeId",
    "challengeContentVersion",
    "vmProfileVersion",
    "vmEngineVersion",
    "engineBuildId",
    "verdictRuleVersion",
  ] as const;
  for (const field of stringFields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return null;
    }
  }
  if (
    typeof record["challengeBundleHash"] !== "string" ||
    !HEX_64.test(record["challengeBundleHash"] as string) ||
    typeof record["vmProfileHash"] !== "string" ||
    !HEX_64.test(record["vmProfileHash"] as string)
  ) {
    return null;
  }
  if (record["archBits"] !== 32 && record["archBits"] !== 64) {
    return null;
  }
  const seedPolicy = record["seedPolicy"];
  if (seedPolicy === null || typeof seedPolicy !== "object" || Array.isArray(seedPolicy)) {
    return null;
  }
  const strategy = (seedPolicy as { readonly [field: string]: unknown })["strategy"];
  if (strategy !== "fixed" && strategy !== "server_random_per_session") {
    return null;
  }
  return {
    replayContext: context as unknown as ReplayContextSummary,
    actionLog,
  };
}
