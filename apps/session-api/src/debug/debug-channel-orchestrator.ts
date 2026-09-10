/**
 * DebugChannelOrchestrator —— 调试实例编排(阶段四 WP-41;ADR-DC1 条款
 * 3/4/6、§四"工程与资源")。
 *
 * # 生命周期
 *
 *   debug_attach → 取会话 + debugMode 判定(公开描述包 `debugMode !== false`,
 *   WP-43 Schema 定稿前形态)→ 经 DebugVariantProvider 取变体 → 按需 spawn
 *   调试 worker(第二 per-session 进程,复用 WorkerConnection.spawn /
 *   ensureWorkerBinary;每会话至多一个调试实例,attach 幂等)→ load_variant
 *   → 从权威动作日志(ActionLogStore.listBySession)按 origin 截断逐条
 *   debug_apply_recorded 确定性重放 → debug_attached 回执。
 *
 *   空闲回收照 session-recycling 范式:每实例登记 lastActivity,清扫节拍
 *   (注入时钟)对空闲超过窗口(复用断线保持窗口预算,不设新配置键)的
 *   实例走 IPC shutdown(Windows 无 SIGTERM 纪律;失败收割);会话终态 /
 *   close 时同步回收(`recycleSession`,经 onSessionClosed / 保持到期钩子
 *   接线)。
 *
 * # 零装载与不进权威日志(条款 2/3/4)
 *
 *  - 装载清单只有变体 + 公开描述包:**真实私有判题包与真实 checkpoint 快照
 *    (含加密信封)零装载**——编排器从不向调试 worker 发送 `load` /
 *    `import_snapshot` 命令,worker 侧对两命令按状态机拒绝(双端断言);
 *  - attach 起点为 checkpoint 时只解析其**日志位置**(revision),不携带
 *    快照字节;
 *  - 调试交互走独立命令面(load_variant / debug_*),**不写 ActionLogStore**
 *    (权威日志仍只含真实会话动作)。
 *
 * # 限额(条款 6)
 *
 * 调试帧经既有 SessionActionRateLimiter 同一会话桶(在通道连接层执行,与
 * 解题 429 形态字节级一致);本层不设第二类预算。
 *
 * # 串行
 *
 * 每实例一条串行链(帧序 = 执行序);重放对齐期间实例不可服务其他帧。
 */
import type { PublicError } from "@stackmaster/protocol";
import { DEBUG_SEARCH_MAX_HITS } from "@stackmaster/protocol";
import { DebugVariantBundleSchema } from "@stackmaster/protocol/server-only";
import { ensureWorkerBinary, WorkerConnection, type WorkerCommandSpec, type WorkerFrame } from "@stackmaster/session-core";
import type { Logger } from "pino";

import type { ActionLogStore, ChallengeBundleStore } from "../persistence/ports.js";
import type { SessionMetrics } from "../metrics/metrics.js";
import { DEBUG_INTERNAL_ERROR } from "./debug-channel-constants.js";
import type { DebugVariantProvider } from "./debug-variant-provider.js";

/** attach 起点(WP-40 `DebugAttachOrigin` 的编排器侧形态)。 */
export type DebugAttachOrigin =
  | { readonly kind: "revision"; readonly revision: number }
  | { readonly kind: "checkpoint"; readonly checkpointId: string };

/** 调试实例状态摘要(debug_attached 回执与状态查询的载荷)。 */
export interface DebugInstanceState {
  readonly revision: number;
  readonly status: string;
  readonly ripHex: string;
  readonly halted: boolean;
}

/** 任意地址窗口读取结果。 */
export interface DebugWindowResult {
  readonly addressHex: string;
  readonly bytesHex: string;
  readonly truncated: boolean;
}

/** 单步 / 断点运行的暂停回执。 */
export interface DebugHaltResult {
  readonly reason: "step" | "breakpoint" | "program_halt" | "budget";
  readonly addressHex: string;
  readonly stepsExecuted: number;
}

/** 全内存检索单命中。 */
export interface DebugSearchHit {
  readonly addressHex: string;
  readonly bytesHex: string;
}

/** 伪指令流 / 函数表展示条目(worker 展示数据原样转发;零本地推导)。 */
export interface DebugDisplayEntry {
  readonly [field: string]: unknown;
}

/** 编排器域失败(呈现面 = 冻结 PublicError 静态载荷;细节只进受控日志)。 */
export class DebugChannelError extends Error {
  constructor(
    readonly payload: PublicError,
    detail: string,
  ) {
    super(`debug channel failure: ${detail}`);
    this.name = "DebugChannelError";
  }
}

function sessionNotFoundError(): DebugChannelError {
  // 防枚举:不存在 / 已关闭 / 租户不匹配同形(会话定位失败统一形态)。
  return new DebugChannelError(
    { code: "invalid_input_format", message: "session mismatch" },
    "session not found in live registry",
  );
}

export interface DebugChannelOrchestratorDeps {
  readonly manager: {
    /** 会话定位(存在性 + 租户绑定 + 题目身份与权威 revision)。 */
    getSessionSummary(
      sessionId: string,
      tenantId: string,
    ): { challengeId: string; challengeVersion: string; revision: number } | null;
    /** checkpoint 账本查询(checkpoint 起点 → 日志位置)。 */
    listCheckpoints(
      sessionId: string,
      tenantId: string,
    ): Promise<readonly { checkpointId: string; revision: number }[]>;
  };
  readonly variantProvider: DebugVariantProvider;
  /** 公开描述包读取(debugMode 判定 + load_variant 公开面)。 */
  readonly bundles: ChallengeBundleStore;
  /** 权威动作日志(append-only;重放对齐唯一来源)。 */
  readonly actionLog: ActionLogStore;
  readonly logger: Logger;
  /** 可注入 worker 进程描述(测试;缺省由 session-core 定位真实二进制)。 */
  readonly workerCommand?: WorkerCommandSpec;
  readonly metrics?: SessionMetrics;
  /**
   * 调试实例空闲回收窗口(秒;复用断线保持窗口预算,不设第二类配置键)。
   */
  readonly idleRecycleSeconds: number;
  /** 清扫节拍(秒;缺省 = min(空闲窗口, 5) 秒)。 */
  readonly sweepIntervalSeconds?: number;
  /**
   * run_to_breakpoint 单帧步数上限(服务端常量,防长占;worker 侧另有硬帽)。
   */
  readonly runToBreakpointMaxSteps: number;
  readonly now?: () => number;
}

interface DebugInstance {
  readonly tenantId: string;
  readonly challengeId: string;
  readonly challengeContentVersion: string;
  readonly connection: WorkerConnection;
  /** 实例串行链(帧序 = 执行序;重放对齐占用链)。 */
  chain: Promise<unknown>;
  lastActivityMs: number;
}

/** 公开描述包 debugMode 判定的最小读取面(WP-43 Schema 定稿前形态)。 */
interface PublicDescriptorDebugModeView {
  readonly debugMode?: boolean;
}

export class DebugChannelOrchestrator {
  readonly #deps: DebugChannelOrchestratorDeps;
  readonly #log: Logger;
  readonly #instances = new Map<string, DebugInstance>();
  #sweepTimer: NodeJS.Timeout | null = null;
  #disposed = false;

  constructor(deps: DebugChannelOrchestratorDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ component: "debug-channel-orchestrator" });
    const intervalSeconds = deps.sweepIntervalSeconds ?? Math.min(deps.idleRecycleSeconds, 5);
    this.#sweepTimer = setInterval(() => this.#sweep(), intervalSeconds * 1000);
    this.#sweepTimer.unref();
  }

  /** 当前调试实例数(可观测 / 测试断言;metrics gauge 同源)。 */
  get instanceCount(): number {
    return this.#instances.size;
  }

  /** 会话是否持有调试实例(测试断言)。 */
  hasInstance(sessionId: string): boolean {
    return this.#instances.has(sessionId);
  }

  // ── attach:spawn + load_variant + 确定性重放对齐 ────────────────────────

  /**
   * debug_attach(幂等):会话已持有调试实例时直接返回当前对齐态(不重复
   * spawn / 重放);否则走 spawn → 装载 → 重放全流程。
   */
  async attach(
    sessionId: string,
    tenantId: string,
    origin: DebugAttachOrigin,
  ): Promise<{ revision: number; status: string; pausedAddressHex?: string }> {
    const existing = this.#instances.get(sessionId);
    if (existing !== undefined && existing.tenantId === tenantId) {
      // attach 幂等:复用既有实例(重放对齐是一次性成本)。
      const state = await this.#enqueue(existing, () => this.#queryState(existing.connection));
      return this.#attachReceipt(state);
    }
    if (existing !== undefined) {
      throw sessionNotFoundError(); // 租户不匹配与不存在同形(防枚举)
    }
    const summary = this.#deps.manager.getSessionSummary(sessionId, tenantId);
    if (summary === null) {
      throw sessionNotFoundError();
    }
    await this.#assertDebugEnabled(summary.challengeId, summary.challengeVersion);

    // 起点 → 日志位置(checkpoint 只解析日志位置,禁止快照字节入调试进程)。
    let targetRevision: number;
    if (origin.kind === "revision") {
      if (origin.revision > summary.revision) {
        throw new DebugChannelError(
          { code: "invalid_input_format", message: "revision is not available" },
          `attach origin revision ${origin.revision} beyond authoritative ${summary.revision}`,
        );
      }
      targetRevision = origin.revision;
    } else {
      const checkpoints = await this.#deps.manager.listCheckpoints(sessionId, tenantId);
      const checkpoint = checkpoints.find((entry) => entry.checkpointId === origin.checkpointId);
      if (checkpoint === undefined) {
        throw new DebugChannelError(
          { code: "invalid_input_format", message: "unknown checkpoint" },
          `attach origin checkpoint ${origin.checkpointId} not found`,
        );
      }
      targetRevision = checkpoint.revision;
    }

    // 变体(零装载;装配点即过冻结 Schema)+ 公开描述包(公开面)。
    const variant = await this.#deps.variantProvider.forSession({
      sessionId,
      tenantId,
      challengeId: summary.challengeId,
      challengeContentVersion: summary.challengeVersion,
    });
    // 身份三元组与会话锁定面比对(变体必须属于本会话锁定的题目)。
    const identity = {
      challengeId: (variant as { challengeId?: unknown }).challengeId,
      challengeContentVersion: (variant as { challengeContentVersion?: unknown }).challengeContentVersion,
    };
    if (
      identity.challengeId !== summary.challengeId ||
      identity.challengeContentVersion !== summary.challengeVersion
    ) {
      throw new DebugChannelError(
        DEBUG_INTERNAL_ERROR,
        "variant identity does not match session-locked challenge",
      );
    }
    const publicDescriptor = await this.#readPublicDescriptor(summary.challengeId, summary.challengeVersion);

    // 按需 spawn 调试 worker(每会话至多一个;复用 WorkerConnection.spawn)。
    const command = this.#deps.workerCommand ?? { command: await ensureWorkerBinary() };
    const connection = (await WorkerConnection.spawn(command)).connection;
    const instance: DebugInstance = {
      tenantId,
      challengeId: summary.challengeId,
      challengeContentVersion: summary.challengeVersion,
      connection,
      chain: Promise.resolve(),
      lastActivityMs: this.#nowMs(),
    };

    try {
      const aligned = await this.#enqueue(instance, async () => {
        await this.#loadVariant(instance.connection, variant, publicDescriptor, summary);
        const revision = await this.#replayTo(sessionId, tenantId, instance.connection, targetRevision);
        return this.#queryStateToRevision(instance.connection, revision);
      });
      this.#instances.set(sessionId, instance);
      this.#syncGauge();
      this.#deps.metrics?.observeDebugFrame("debug_attach", "accepted");
      this.#log.info(
        { sessionId, tenantId, revision: aligned.revision, targetRevision },
        "debug instance attached (deterministic replay aligned)",
      );
      return this.#attachReceipt(aligned);
    } catch (error) {
      // 装载 / 重放失败:实例不可信,收割进程后上抛(呈现面由通道映射)。
      instance.connection.destroy();
      await instance.connection.waitExit().catch(() => undefined);
      throw error;
    }
  }

  // ── 调试交互面(转 worker 帧,原样回执)────────────────────────────────

  /** debug_window:任意地址窗口读取(零装载使隐藏区域公开)。 */
  async window(
    sessionId: string,
    tenantId: string,
    addressHex: string,
    byteLength: number,
  ): Promise<DebugWindowResult> {
    const instance = this.#requireInstance(sessionId, tenantId);
    return this.#enqueue(instance, async () => {
      this.#touch(instance);
      const frame = await instance.connection.request({
        type: "debug_read_window",
        addressHex,
        byteLength,
      });
      this.#expectNotCommandError(frame, "debug_read_window");
      if (frame.type !== "debug_window_data") {
        throw new DebugChannelError(DEBUG_INTERNAL_ERROR, "unexpected worker frame for debug_read_window");
      }
      return {
        addressHex: String(frame["addressHex"]),
        bytesHex: String(frame["bytesHex"]),
        truncated: Boolean(frame["truncated"]),
      };
    });
  }

  /** debug_step:调试实例单步(无判题闸门评估,条款 4)。 */
  async step(sessionId: string, tenantId: string): Promise<DebugHaltResult> {
    const instance = this.#requireInstance(sessionId, tenantId);
    return this.#enqueue(instance, async () => {
      this.#touch(instance);
      const frame = await instance.connection.request({ type: "debug_step" });
      return this.#haltResult(frame, "debug_step");
    });
  }

  /** debug_run_to_breakpoint:运行至命中任一断点(步数上限防长占)。 */
  async runToBreakpoint(
    sessionId: string,
    tenantId: string,
    breakpoints: readonly string[],
  ): Promise<DebugHaltResult> {
    const instance = this.#requireInstance(sessionId, tenantId);
    return this.#enqueue(instance, async () => {
      this.#touch(instance);
      const frame = await instance.connection.request({
        type: "debug_run_to_breakpoint",
        breakpoints: [...breakpoints],
        maxSteps: this.#deps.runToBreakpointMaxSteps,
      });
      return this.#haltResult(frame, "debug_run_to_breakpoint");
    });
  }

  /** debug_search:全变体内存检索。 */
  async search(
    sessionId: string,
    tenantId: string,
    patternHex: string,
    maxHits?: number,
  ): Promise<{ hits: readonly DebugSearchHit[]; truncated: boolean }> {
    const instance = this.#requireInstance(sessionId, tenantId);
    return this.#enqueue(instance, async () => {
      this.#touch(instance);
      const frame = await instance.connection.request({
        type: "debug_search",
        patternHex,
        // worker 侧命令镜像 max_hits 必填(WP-40 契约面 maxHits 可选,缺省 =
        // 服务端上限):省略时以协议上限补齐,防帧形态不合法被 worker 判
        // envelope_invalid 并终止进程(调试实例一旦误标 crashed 即不可恢复)。
        maxHits: maxHits ?? DEBUG_SEARCH_MAX_HITS,
      });
      this.#expectNotCommandError(frame, "debug_search");
      if (frame.type !== "debug_search_results") {
        throw new DebugChannelError(DEBUG_INTERNAL_ERROR, "unexpected worker frame for debug_search");
      }
      return {
        hits: (frame["hits"] as DebugSearchHit[]) ?? [],
        truncated: Boolean(frame["truncated"]),
      };
    });
  }

  /** debug_instruction_stream:伪指令流展示数据(IR 不出进程,D5)。 */
  async instructionStream(
    sessionId: string,
    tenantId: string,
    addressHex: string,
    maxItems: number,
  ): Promise<{ instructions: readonly DebugDisplayEntry[]; truncated: boolean }> {
    const instance = this.#requireInstance(sessionId, tenantId);
    return this.#enqueue(instance, async () => {
      this.#touch(instance);
      const frame = await instance.connection.request({
        type: "debug_instruction_stream",
        addressHex,
        maxItems,
      });
      this.#expectNotCommandError(frame, "debug_instruction_stream");
      if (frame.type !== "debug_instruction_stream_data") {
        throw new DebugChannelError(
          DEBUG_INTERNAL_ERROR,
          "unexpected worker frame for debug_instruction_stream",
        );
      }
      return {
        instructions: (frame["instructions"] as DebugDisplayEntry[]) ?? [],
        truncated: Boolean(frame["truncated"]),
      };
    });
  }

  /** debug_function_table:函数表展示数据。 */
  async functionTable(
    sessionId: string,
    tenantId: string,
  ): Promise<{ functions: readonly DebugDisplayEntry[]; truncated: boolean }> {
    const instance = this.#requireInstance(sessionId, tenantId);
    return this.#enqueue(instance, async () => {
      this.#touch(instance);
      const frame = await instance.connection.request({ type: "debug_function_table" });
      this.#expectNotCommandError(frame, "debug_function_table");
      if (frame.type !== "debug_function_table_data") {
        throw new DebugChannelError(DEBUG_INTERNAL_ERROR, "unexpected worker frame for debug_function_table");
      }
      return {
        functions: (frame["functions"] as DebugDisplayEntry[]) ?? [],
        truncated: Boolean(frame["truncated"]),
      };
    });
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 会话终态 / close 时的同步回收(close_session、断线保持到期回收路径
   * 接线;不存在该会话的实例时无操作——幂等)。
   */
  async recycleSession(sessionId: string, tenantId?: string): Promise<void> {
    const instance = this.#instances.get(sessionId);
    if (instance === undefined) {
      return;
    }
    if (tenantId !== undefined && instance.tenantId !== tenantId) {
      return;
    }
    this.#instances.delete(sessionId);
    this.#syncGauge();
    await this.#gracefulShutdown(instance, "session_closed");
  }

  /** 停机收尾:清扫定时器停摆 + 全部实例回收(优雅停机序列调用)。 */
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    const sessions = [...this.#instances.keys()];
    await Promise.all(sessions.map((sessionId) => this.recycleSession(sessionId)));
    if (sessions.length > 0) {
      this.#log.info({ instances: sessions.length }, "debug instances recycled for shutdown");
    }
  }

  // ── 内部:重放对齐与 worker 通信 ─────────────────────────────────────────

  /**
   * 确定性重放对齐(条款 3):权威动作日志按 origin 截断(revisionAfter ≤
   * target,append-only 序)逐条 debug_apply_recorded;每条回执 revision 必须
   * 与权威日志一致,错位即中止(呈现 internal_error;编排侧缺陷方向)。
   * 返回实际对齐到的 revision(动作日志随 submit 落库,可合法落后于请求
   * 起点——回执如实登记对齐进度锚点)。
   */
  async #replayTo(
    sessionId: string,
    tenantId: string,
    connection: WorkerConnection,
    targetRevision: number,
  ): Promise<number> {
    const entries = await this.#deps.actionLog.listBySession(sessionId, tenantId);
    let aligned = 0;
    for (const entry of entries) {
      if (entry.revisionAfter > targetRevision) {
        break;
      }
      if (entry.revisionAfter !== aligned + 1) {
        throw new DebugChannelError(
          DEBUG_INTERNAL_ERROR,
          `authoritative action log is not contiguous at revision ${entry.revisionAfter}`,
        );
      }
      const frame = await connection.request({
        type: "debug_apply_recorded",
        action: entry.action,
      });
      if (frame.type !== "debug_applied" || frame["revision"] !== entry.revisionAfter) {
        connection.destroy();
        throw new DebugChannelError(
          DEBUG_INTERNAL_ERROR,
          `replay misalignment at revision ${entry.revisionAfter}`,
        );
      }
      aligned = entry.revisionAfter;
    }
    return aligned;
  }

  /** load_variant:零装载唯一入口(拒绝即 attach 失败,变体不出编排器)。 */
  async #loadVariant(
    connection: WorkerConnection,
    variant: Record<string, unknown>,
    publicDescriptor: Record<string, unknown>,
    summary: { challengeId: string; challengeVersion: string },
  ): Promise<void> {
    // 双重校验(编排器对自产载荷按同一契约复验;worker 侧 fail-closed 兜底)。
    const parsed = DebugVariantBundleSchema.parse(variant);
    const frame = await connection.request({
      type: "load_variant",
      variant: parsed,
      publicDescriptor,
    });
    if (frame.type !== "variant_loaded") {
      connection.destroy();
      throw new DebugChannelError(
        DEBUG_INTERNAL_ERROR,
        "debug worker rejected the variant bundle (challenge_invalid direction)",
      );
    }
    const loaded = frame["loaded"] as { challengeId?: string; challengeContentVersion?: string } | undefined;
    if (
      loaded?.challengeId !== summary.challengeId ||
      loaded?.challengeContentVersion !== summary.challengeVersion
    ) {
      connection.destroy();
      throw new DebugChannelError(
        DEBUG_INTERNAL_ERROR,
        "debug worker loaded a variant with mismatched identity",
      );
    }
  }

  async #queryState(connection: WorkerConnection): Promise<DebugInstanceState> {
    const frame = await connection.request({ type: "debug_query_state" });
    if (frame.type !== "debug_state") {
      throw new DebugChannelError(DEBUG_INTERNAL_ERROR, "unexpected worker frame for debug_query_state");
    }
    const state = frame["state"] as {
      revision: number;
      status: string;
      ripHex: string;
      halted: boolean;
    };
    return state;
  }

  async #queryStateToRevision(
    connection: WorkerConnection,
    expectedRevision: number,
  ): Promise<DebugInstanceState> {
    const state = await this.#queryState(connection);
    if (state.revision !== expectedRevision) {
      throw new DebugChannelError(
        DEBUG_INTERNAL_ERROR,
        `debug revision ${state.revision} disagrees with replay alignment ${expectedRevision}`,
      );
    }
    return state;
  }

  #attachReceipt(state: DebugInstanceState): {
    revision: number;
    status: string;
    pausedAddressHex?: string;
  } {
    return state.status === "paused"
      ? { revision: state.revision, status: state.status, pausedAddressHex: state.ripHex }
      : { revision: state.revision, status: state.status };
  }

  #haltResult(frame: WorkerFrame, command: string): DebugHaltResult {
    this.#expectNotCommandError(frame, command);
    if (frame.type !== "debug_halted") {
      throw new DebugChannelError(DEBUG_INTERNAL_ERROR, `unexpected worker frame for ${command}`);
    }
    return {
      reason: frame["reason"] as DebugHaltResult["reason"],
      addressHex: String(frame["addressHex"]),
      stepsExecuted: Number(frame["stepsExecuted"]),
    };
  }

  #expectNotCommandError(frame: WorkerFrame, command: string): void {
    if (frame.type === "command_error") {
      // 命令级错误 = 载荷级拒绝(invalid_input_format / inaccessible_address)
      // 或实例故障(internal_error):前者确定性呈现,后者按实例故障处置
      // (呈现同形,细节只进日志)。
      throw new DebugChannelError(
        { code: "invalid_input_format", message: "debug request was rejected" },
        `worker rejected ${command}: ${String((frame["error"] as { code?: string })?.code)}`,
      );
    }
  }

  /** debugMode 判定(公开描述包 JSON 的 `debugMode !== false`;WP-43 定稿前形态)。 */
  async #assertDebugEnabled(challengeId: string, challengeVersion: string): Promise<void> {
    const descriptor = await this.#readPublicDescriptorView(challengeId, challengeVersion);
    if ((descriptor as PublicDescriptorDebugModeView | undefined)?.debugMode === false) {
      throw new DebugChannelError(
        { code: "invalid_input_format", message: "debug mode is not enabled" },
        `challenge ${challengeId} declares debugMode: false`,
      );
    }
  }

  async #readPublicDescriptor(
    challengeId: string,
    challengeVersion: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.#deps.bundles.getPublic(challengeId, challengeVersion);
    if (raw === null) {
      throw new DebugChannelError(
        DEBUG_INTERNAL_ERROR,
        "public descriptor missing for session-locked challenge",
      );
    }
    return JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
  }

  async #readPublicDescriptorView(
    challengeId: string,
    challengeVersion: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.#readPublicDescriptor(challengeId, challengeVersion);
    } catch {
      return undefined;
    }
  }

  // ── 内部:实例簿记 ───────────────────────────────────────────────────────

  #requireInstance(sessionId: string, tenantId: string): DebugInstance {
    const instance = this.#instances.get(sessionId);
    if (instance === undefined || instance.tenantId !== tenantId) {
      throw new DebugChannelError(
        { code: "invalid_input_format", message: "debug instance is not attached" },
        "no debug instance for session",
      );
    }
    return instance;
  }

  /** 实例串行链(帧序 = 执行序;链上异常不吞)。 */
  #enqueue<T>(instance: DebugInstance, work: () => Promise<T>): Promise<T> {
    const run = instance.chain.then(work, work);
    instance.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #touch(instance: DebugInstance): void {
    instance.lastActivityMs = this.#nowMs();
  }

  #nowMs(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #syncGauge(): void {
    this.#deps.metrics?.setDebugWorkerProcesses(this.#instances.size);
  }

  /** 空闲回收执行面(照 session-recycling 范式;失败只进受控日志)。 */
  async #gracefulShutdown(instance: DebugInstance, reason: string): Promise<void> {
    try {
      const ack = await instance.connection.request({ type: "shutdown" });
      if (ack.type !== "shutdown_ack") {
        instance.connection.kill();
      }
      const exit = await instance.connection.waitExit();
      this.#log.info({ reason, exitKind: exit.kind }, "debug worker recycled");
    } catch (error) {
      // 优雅关闭失败(worker 已死 / 协议违规):收割退出。
      instance.connection.kill();
      await instance.connection.waitExit().catch(() => undefined);
      this.#log.warn(
        { reason: error instanceof Error ? error.message : "graceful shutdown failed" },
        "debug worker recycle fell back to reap",
      );
    }
  }

  #sweep(): void {
    if (this.#disposed) {
      return;
    }
    const idleMs = this.#deps.idleRecycleSeconds * 1000;
    const now = this.#nowMs();
    for (const [sessionId, instance] of this.#instances) {
      if (now - instance.lastActivityMs > idleMs) {
        this.#instances.delete(sessionId);
        this.#syncGauge();
        void this.#gracefulShutdown(instance, "idle_recycled");
      }
    }
  }
}
