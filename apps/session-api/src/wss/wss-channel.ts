/**
 * WSS 动作通道连接状态机(阶段三 WP-5 核心;D-API-40 ~ D-API-48)。
 *
 * 连接生命周期状态机(升级由 fastify 生命周期 + 凭证 preHandler 完成):
 *
 *   [升级请求] → 凭证 preHandler(D-API-12 Cookie;失败 = HTTP 401 统一形态,
 *                升级即拒)→ handler(claims.sessionId 升级即锚定本连接)
 *     → ACTIVE_AWAITING_FRAME(已认证、未锚定版本;心跳 / 空闲已生效)
 *     → 首帧(受理集合内)protocolVersion = 本连接解释版本(D-API-2 连接级锚定)
 *     → ACTIVE_ANCHORED(此后任何帧携带其他版本一律确定性拒绝;响应帧携带
 *        本连接锚定版本,不携带"新版本"——信封按请求版本解释)
 *     → CLOSED(空闲超时 1000 / 踢旧 1008 / 停机 1001 / 背压 1013 / 对端关闭)
 *
 * 每帧流水线(收序即处理序;串行链保证帧序 = 执行序,D-API-46):
 *   频率闸(同步,令牌桶)→ 文本 / JSON 形态 → 结构护栏 → 版本受理 + 连接锚定
 *   → 冻结 WssFrameSchema(strictObject)重新校验 → 方向检查(客户端只发
 *   action)→ 会话绑定(帧 sessionId 与载荷 sessionId 均须等于凭证绑定会话)
 *   → [串行链] 幂等窗口前置守卫(fresh / replay-identical → applyAction;
 *   conflict → 确定性拒绝)→ manager.applyAction(单会话串行不变)→
 *   action_response 信封下发(载荷原样转发执行域产物,零投影合成,ADR-7)。
 *
 * 传输层纪律(D-API-5):入站 seq 不做拒绝依据(高水位不做、乱序不拒——权威
 * 判定只在载荷层);出站 seq 服务端连接内严格递增(允许跳号);帧 requestId
 * 为发送方关联值,响应帧原样回显。
 */
import {
  PublicErrorSchema,
  SESSION_ACTION_PROTOCOL_VERSION,
  WssFrameSchema,
  canonicalize,
  type ActionResponse,
  type PublicError,
  type WssFrame,
} from "@stackmaster/protocol";
import type { SessionCredentialClaims } from "@stackmaster/protocol/server-only";
import type { Logger } from "pino";

import type { LiveSessionManager } from "../sessions/session-manager.js";
import {
  ChallengeLoadRejected,
  ClientSeqBudgetExhausted,
  MappedOrchestratorFailure,
} from "../sessions/session-manager.js";
import { PersistenceError } from "../persistence/errors.js";
import { mapDomainFailure } from "../routes/error-mapping.js";
import type { RequestGuardLimits } from "../routes/request-guards.js";
import type { IdempotencyWindow } from "../persistence/ports.js";
import {
  WSS_CLOSE_IDLE_TIMEOUT,
  WSS_CLOSE_INTERNAL_DRIFT,
  WSS_CLOSE_REPLACED,
  WSS_CLOSE_SEND_BUFFER_OVERFLOW,
  WSS_CLOSE_SHUTDOWN,
  WSS_ACTION_RATE_LIMIT_ERROR,
  WSS_CONNECTION_REPLACED_ERROR,
  WSS_IDEMPOTENCY_CONFLICT_ERROR,
  WSS_IDLE_TIMEOUT_ERROR,
  WSS_MALFORMED_FRAME_ERROR,
  WSS_RATE_LIMIT_ERROR,
  WSS_SEND_BUFFER_OVERFLOW_ERROR,
  WSS_SESSION_MISMATCH_ERROR,
  WSS_UNSUPPORTED_VERSION_ERROR,
} from "./channel-constants.js";
import { BoundedSendBuffer, type FrameWriteSink } from "./bounded-send-buffer.js";
import { parseWssChannelFrame, type WssFrameRejection } from "./frame-contract.js";
import { MessageRateLimiter } from "./message-rate-limiter.js";
import type { RegistryChannel, SessionConnectionRegistry } from "./connection-registry.js";

/** 服务端 WebSocket 连接的最小结构面(对 ws.WebSocket 的结构镜像;测试可注入替身)。 */
export interface ChannelSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  ping(cb?: () => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "pong", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

export interface ActionChannelOptions {
  readonly socket: ChannelSocket;
  /** 升级期通过统一认证入口的会话凭证 claims(claims.sessionId 升级即锚定)。 */
  readonly claims: SessionCredentialClaims;
  readonly manager: LiveSessionManager;
  readonly idempotencyWindow: IdempotencyWindow;
  readonly registry: SessionConnectionRegistry;
  readonly logger: Logger;
  /** 结构护栏(与 REST 同值装配;8.3)。 */
  readonly limits: RequestGuardLimits;
  /** 心跳间隔(秒;D-API-42)。 */
  readonly heartbeatIntervalSeconds: number;
  /** 空闲超时(秒;pong / 入站消息静默判定,D-API-42)。 */
  readonly idleTimeoutSeconds: number;
  /** 通道消息频率(令牌桶容量 = 速率 / 秒;D-API-43)。 */
  readonly messageRatePerSecond: number;
  /**
   * 每会话动作频率闸(WP-6,D-API-53;与每连接令牌桶叠加,同源实现——
   * MessageRateLimiter 按会话键,跨连接存活;缺省未注入 = 不设本闸)。
   */
  readonly sessionActionLimiter?: { tryTake(sessionId: string): boolean };
  /** 发送缓冲帧数上限(背压;D-API-44)。 */
  readonly sendBufferLimit: number;
  /**
   * 出站帧录制面(WP-7 跨域载荷机检的捕获钩子;每帧在过冻结 Schema 自检之后、
   * 入发送缓冲之前回调。生产装配缺省不注入)。
   */
  readonly outboundFrameSink?: (frame: WssFrame) => void;
  readonly now?: () => number;
}

/**
 * 出站帧构造输入(protocolVersion 以连接锚定版本承载;锚定前以服务端当前版本
 * 兜底——形态由 #emitFrame 内的冻结 Schema 自检裁决,漂移即拒绝下发)。
 */
interface OutboundFrameInput {
  protocolVersion: number;
  type: "action_response" | "error";
  sessionId: string;
  seq: number;
  requestId?: string;
  payload: ActionResponse | PublicError;
}

/** 空闲断开后 socket 收尾的宽限(确保 close 帧上线后再 terminate;非配置面)。 */
const TERMINATE_GRACE_MS = 1000;

export class ActionChannelConnection implements RegistryChannel {
  readonly #options: ActionChannelOptions;
  readonly #log: Logger;
  readonly #socket: ChannelSocket;
  readonly #claims: SessionCredentialClaims;
  readonly #rateLimiter: MessageRateLimiter;
  readonly #sendBuffer: BoundedSendBuffer;
  /** 单连接串行链:帧序 = 执行序(响应按执行序下发,D-API-46)。 */
  #chain: Promise<void> = Promise.resolve();
  /** 连接锚定的协议版本(首帧即协商;null = 尚未锚定)。 */
  #anchoredVersion: number | null = null;
  #outboundSeq = 0;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #terminateTimer: NodeJS.Timeout | null = null;
  #lastAliveAt: number;
  #closed = false;
  /** 关闭已发起(错误帧 / close 帧已出;防空闲节拍与重复关闭路径重入)。 */
  #closing = false;
  #started = false;

  constructor(options: ActionChannelOptions) {
    this.#options = options;
    this.#socket = options.socket;
    this.#claims = options.claims;
    this.#log = options.logger.child({
      component: "wss-channel",
      sessionId: options.claims.sessionId,
      tenantId: options.claims.tenantId,
    });
    this.#rateLimiter = new MessageRateLimiter({
      capacityPerSecond: options.messageRatePerSecond,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#sendBuffer = new BoundedSendBuffer({
      sink: this.#sinkFrameText,
      limit: options.sendBufferLimit,
      onOverflow: () => this.#onSendBufferOverflow(),
      onWriteError: (error) => {
        this.#log.warn({ reason: error.message }, "wss socket write failed");
      },
    });
    this.#lastAliveAt = (options.now ?? Date.now)();
  }

  /** 凭证绑定会话(RegistryChannel 面)。 */
  get sessionId(): string {
    return this.#claims.sessionId;
  }

  get tenantId(): string {
    return this.#claims.tenantId;
  }

  /** 连接是否已关闭(测试断言)。 */
  get isClosed(): boolean {
    return this.#closed;
  }

  /** 连接锚定的协议版本(未锚定为 null;测试断言)。 */
  get anchoredVersion(): number | null {
    return this.#anchoredVersion;
  }

  /** 启动:登记注册表(踢旧在先)、挂事件、起心跳节拍。 */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#options.registry.activate(this);
    this.#socket.on("message", (data, isBinary) => this.#onRawMessage(data, isBinary));
    this.#socket.on("pong", () => {
      this.#lastAliveAt = this.#nowMs();
    });
    this.#socket.on("error", (error) => {
      this.#log.warn({ reason: error.message }, "wss socket error");
    });
    this.#socket.on("close", () => this.#onClosed());
    const heartbeatMs = this.#options.heartbeatIntervalSeconds * 1000;
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(), heartbeatMs);
    this.#heartbeatTimer.unref();
    this.#log.debug({ idleTimeoutSeconds: this.#options.idleTimeoutSeconds }, "wss channel started");
  }

  /** 踢旧(D-API-40):错误帧说明后以 1008 策略关闭。 */
  replaceByNewConnection(): void {
    this.#emitError(WSS_CONNECTION_REPLACED_ERROR);
    this.#closeSocket(WSS_CLOSE_REPLACED, "connection replaced");
  }

  /** 停机收尾(D-API-48):冲刷发送缓冲后以 1001 有序关闭。 */
  async closeForShutdown(): Promise<void> {
    await this.#sendBuffer.waitDrained(TERMINATE_GRACE_MS);
    this.#closeSocket(WSS_CLOSE_SHUTDOWN, "server shutting down");
  }

  // ── 入站:同步前置闸 + 串行链 ───────────────────────────────────────────

  #onRawMessage(data: Buffer, isBinary: boolean): void {
    if (this.#closed) {
      return;
    }
    this.#lastAliveAt = this.#nowMs();

    // 1. 频率闸(D-API-43):同步判定,触顶 = 逐帧确定性拒绝(连接保持)。
    if (!this.#rateLimiter.tryTake()) {
      this.#log.warn({ reason: "message_rate_exceeded" }, "wss frame rejected");
      this.#emitError(WSS_RATE_LIMIT_ERROR);
      return;
    }
    // 1b. 每会话动作频率闸(WP-6,D-API-53):与每连接令牌桶叠加、同源实现;
    //     桶跨连接存活(重连不重置预算),触顶 = 同族冻结错误帧确定性拒绝。
    if (
      this.#options.sessionActionLimiter !== undefined &&
      !this.#options.sessionActionLimiter.tryTake(this.#claims.sessionId)
    ) {
      this.#log.warn({ reason: "session_action_rate_exceeded" }, "wss frame rejected");
      this.#emitError(WSS_ACTION_RATE_LIMIT_ERROR);
      return;
    }

    // 2. 二进制帧 = 畸形(通道只承载 JSON 文本帧;信封契约无二进制形态)。
    if (isBinary) {
      this.#rejectFrame({ kind: "malformed_frame" });
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(data.toString("utf8"));
    } catch {
      this.#rejectFrame({ kind: "malformed_json" });
      return;
    }

    // 3. 结构护栏 → 版本受理 + 连接锚定 → 冻结帧 Schema 重新校验(D-API-46)。
    const parsed = parseWssChannelFrame(parsedJson, this.#anchoredVersion, this.#options.limits);
    if (!parsed.ok) {
      this.#rejectFrame(parsed.rejection);
      return;
    }
    const frame = parsed.frame;

    // 4. 方向检查:客户端 → 服务端只允许 action(信封三值封闭的方向集)。
    if (frame.type !== "action") {
      this.#rejectFrame({ kind: "malformed_frame" });
      return;
    }

    // 5. 会话绑定(基线 #2 的通道面):帧 sessionId 与载荷 sessionId 都必须
    //    等于凭证绑定会话;跨会话帧一律确定性拒绝(零细节差异,防枚举)。
    if (frame.sessionId !== this.#claims.sessionId || frame.payload.sessionId !== this.#claims.sessionId) {
      this.#rejectFrame({ kind: "session_mismatch" });
      return;
    }

    // 6. 串行链:幂等窗口前置守卫 → applyAction → action_response 下发。
    //    入站 seq 不做拒绝依据(D-API-5:权威判定只在载荷层)。
    this.#chain = this.#chain.then(() => this.#processActionFrame(frame), () => undefined);
  }

  async #processActionFrame(frame: Extract<WssFrame, { type: "action" }>): Promise<void> {
    if (this.#closed) {
      return;
    }
    // 幂等窗口前置守卫(D-W8-9 / D-API-24):载荷 = 规范化序列化后的完整
    // ActionRequest(传输层帧字段不在契约内,§4.3)。
    // fresh → 递入 applyAction;replay-identical → 仍递入(同进程字节相同
    // 重放由编排核心账本返回缓存响应);conflict → 确定性拒绝。
    let verdict: "fresh" | "replay-identical" | "conflict";
    try {
      verdict = await this.#options.idempotencyWindow.checkAndRecord(
        this.#claims.sessionId,
        frame.payload.idempotencyKey,
        canonicalize(frame.payload),
      );
    } catch (error) {
      this.#log.warn(
        { reason: error instanceof Error ? error.message : "idempotency window failure" },
        "idempotency window failure",
      );
      this.#emitDomainFailure(error);
      return;
    }
    if (verdict === "conflict") {
      this.#log.warn({ reason: "idempotency_conflict" }, "wss action rejected by idempotency guard");
      this.#emitError(WSS_IDEMPOTENCY_CONFLICT_ERROR);
      return;
    }

    let response: ActionResponse;
    try {
      response = await this.#options.manager.applyAction(
        this.#claims.sessionId,
        this.#claims.tenantId,
        frame.payload.action,
        { idempotencyKey: frame.payload.idempotencyKey },
      );
    } catch (error) {
      this.#logDomainFailure(error);
      this.#emitDomainFailure(error);
      return;
    }

    // 响应即完整下发:载荷原样转发执行域产物(ProjectionDelta / publicEvents),
    // 编排器零投影合成、零增量合流、零本地推导(ADR-7 / D-API-47)。
    this.#emitFrame({
      protocolVersion: this.#anchoredVersion ?? SESSION_ACTION_PROTOCOL_VERSION,
      type: "action_response",
      sessionId: this.#claims.sessionId,
      seq: this.#nextSeq(),
      ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }),
      payload: response,
    });
  }

  // ── 出站:错误帧与信封 ──────────────────────────────────────────────────

  /** 通道级拒绝(同步闸):错误帧 + 受控日志;连接保持(逐帧确定性拒绝)。 */
  #rejectFrame(rejection: WssFrameRejection | { kind: "session_mismatch" }): void {
    const reason =
      rejection.kind === "session_mismatch"
        ? "session_binding_mismatch"
        : rejection.kind;
    const details = rejection.kind === "session_mismatch" ? {} : {
      ...(rejection.issueCount === undefined ? {} : { issueCount: rejection.issueCount }),
      ...(rejection.issuePaths === undefined ? {} : { issuePaths: rejection.issuePaths }),
      ...(rejection.dimension === undefined ? {} : { dimension: rejection.dimension }),
    };
    this.#log.warn({ reason, ...details }, "wss frame rejected");
    const payload: PublicError =
      rejection.kind === "unsupported_version" || rejection.kind === "version_anchor_violation"
        ? WSS_UNSUPPORTED_VERSION_ERROR
        : rejection.kind === "session_mismatch"
          ? WSS_SESSION_MISMATCH_ERROR
          : WSS_MALFORMED_FRAME_ERROR;
    this.#emitError(payload);
  }

  /** 错误帧(WssFrame.error 分支;载荷 = 冻结 PublicError 静态形态)。 */
  #emitError(payload: PublicError): void {
    this.#emitFrame({
      protocolVersion: this.#anchoredVersion ?? SESSION_ACTION_PROTOCOL_VERSION,
      type: "error",
      sessionId: this.#claims.sessionId,
      seq: this.#nextSeq(),
      payload,
    });
  }

  /** 编排器域失败 → 冻结错误帧(复用 D-API-32 映射矩阵的载荷面)。 */
  #emitDomainFailure(error: unknown): void {
    const mapped = mapDomainFailure(error);
    this.#emitError(mapped === null ? INTERNAL_FAILURE_ERROR : mapped.body);
  }

  #logDomainFailure(error: unknown): void {
    if (error instanceof MappedOrchestratorFailure) {
      this.#log.warn({ kind: error.kind }, "wss action failed in orchestrator domain");
      return;
    }
    if (error instanceof ClientSeqBudgetExhausted) {
      this.#log.warn({ sessionId: error.sessionId }, "client seq budget exhausted on wss action");
      return;
    }
    if (error instanceof ChallengeLoadRejected || error instanceof PersistenceError) {
      this.#log.warn(
        { type: error.name, reason: error.message },
        "wss action failed in domain layer",
      );
      return;
    }
    this.#log.warn(
      { type: error instanceof Error ? error.name : "NonError" },
      "wss action failed with unknown error",
    );
  }

  // ── 发送缓冲与 socket ──────────────────────────────────────────────────

  readonly #sinkFrameText: FrameWriteSink = (text, onWritten) => {
    try {
      this.#socket.send(text, onWritten);
    } catch (error) {
      onWritten(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /**
   * 出站唯一入口:过冻结帧 Schema 自检(漂移即实现事故:记录并策略关闭,
   * 绝不下发非契约形态)→ 录制钩子(WP-7)→ 有界发送缓冲(背压,超限即
   * 溢出断开路径)。
   */
  #emitFrame(frame: OutboundFrameInput): void {
    if (this.#closed || this.#closing) {
      return;
    }
    let valid: WssFrame;
    try {
      valid = WssFrameSchema.parse(frame);
    } catch (error) {
      // 契约漂移 = 实现事故:细节只进受控日志,连接立即策略关闭。
      this.#log.error(
        { reason: error instanceof Error ? error.message : "outbound frame drift" },
        "outbound frame failed contract self-check",
      );
      this.#closeSocket(WSS_CLOSE_INTERNAL_DRIFT, "internal contract drift");
      return;
    }
    this.#options.outboundFrameSink?.(valid);
    this.#sendBuffer.enqueue(JSON.stringify(valid));
  }

  /** 背压断开路径(D-API-44):尽力直发错误帧(绕过已溢出缓冲)→ close 1013。 */
  #onSendBufferOverflow(): void {
    this.#log.warn({ reason: "send_buffer_overflow" }, "wss channel disconnected (slow consumer)");
    const errorFrameText = JSON.stringify(
      WssFrameSchema.parse({
        protocolVersion: this.#anchoredVersion ?? SESSION_ACTION_PROTOCOL_VERSION,
        type: "error",
        sessionId: this.#claims.sessionId,
        seq: this.#nextSeq(),
        payload: WSS_SEND_BUFFER_OVERFLOW_ERROR,
      }),
    );
    this.#options.outboundFrameSink?.(JSON.parse(errorFrameText) as WssFrame);
    try {
      this.#socket.send(errorFrameText, () => undefined);
    } catch {
      // 发送失败不改变断开路径:close / terminate 照常执行。
    }
    this.#closeSocket(WSS_CLOSE_SEND_BUFFER_OVERFLOW, "send buffer limit exceeded");
  }

  #closeSocket(code: number, reason: string): void {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    try {
      this.#socket.close(code, reason);
    } catch (error) {
      this.#log.warn(
        { reason: error instanceof Error ? error.message : "close failed" },
        "wss socket close failed",
      );
    }
    // 宽限后强制收尾:对端不回 close 握手也不悬挂资源(定时器不阻止进程退出)。
    if (this.#terminateTimer === null) {
      this.#terminateTimer = setTimeout(() => {
        try {
          this.#socket.terminate();
        } catch {
          // 收尾失败无进一步处置面。
        }
      }, TERMINATE_GRACE_MS);
      this.#terminateTimer.unref();
    }
  }

  // ── 心跳 / 空闲(D-API-42)──────────────────────────────────────────────

  #heartbeatTick(): void {
    if (this.#closed || this.#closing) {
      return;
    }
    const idleMs = this.#options.idleTimeoutSeconds * 1000;
    if (this.#nowMs() - this.#lastAliveAt > idleMs) {
      this.#log.info({ reason: "idle_timeout" }, "wss channel idle timeout");
      // 尽力直发错误帧(绕过发送缓冲,空闲断开不受背压状态影响)→ close 1000。
      this.#emitError(WSS_IDLE_TIMEOUT_ERROR);
      this.#sendBuffer.dispose();
      this.#closeSocket(WSS_CLOSE_IDLE_TIMEOUT, "idle timeout");
      return;
    }
    try {
      this.#socket.ping();
    } catch {
      // ping 失败交由 close/error 事件收尾。
    }
    // route:{sessionId} 续期与会话保活同节奏(D-API-49)。
    this.#options.registry.refreshRoute(this.#claims.sessionId);
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────

  #onClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#terminateTimer !== null) {
      clearTimeout(this.#terminateTimer);
      this.#terminateTimer = null;
    }
    this.#sendBuffer.dispose();
    this.#options.registry.deactivate(this);
    this.#log.info({ anchoredVersion: this.#anchoredVersion }, "wss channel closed");
  }

  #nextSeq(): number {
    this.#outboundSeq += 1;
    return this.#outboundSeq;
  }

  #nowMs(): number {
    return (this.#options.now ?? Date.now)();
  }
}

/** 未知编排失败的兜底错误帧(与 server.ts 500 兜底同形;细节只进日志)。 */
const INTERNAL_FAILURE_ERROR: PublicError = PublicErrorSchema.parse({
  code: "internal_error",
  message: "internal error",
});
