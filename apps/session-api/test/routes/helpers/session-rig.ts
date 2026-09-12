/**
 * WP-4 REST 生命周期路由测试装配台(内存同构运行时):
 * 内存持久化端口(WP-3 memory-stores)+ WP-2 内存认证端口 + 假 worker +
 * 真实路由 / 错误映射 / 冻结 Schema 校验(与 src/runtime/runtime.ts 同一
 * 装配拓扑,载体换成内存实现——端口契约逐一同构)。
 *
 * 覆盖面:签发 embed token → create_session → sync_projection →
 * checkpoint(manager.applyAction,WSS 归 WP-5 的同一入口)→
 * list_checkpoints → submit → close_session 全链路 + 红灯矩阵。
 */

import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { EmbedTokenClaims } from "@stackmaster/protocol/server-only";
import type { WssFrame } from "@stackmaster/protocol";
import {
  buildBytePair,
  buildIrPair,
} from "../../../../../packages/challenge-compiler/test/helpers/private-bundle.js";
import {
  InMemoryAuditSink,
  InMemoryCredentialRevocationStore,
  InMemoryTokenIssuanceStore,
  buildAuthPlugin,
  createTokenSigner,
  type IssuedEmbedTokenRecord,
  type TokenSigner,
} from "../../../src/auth/index.js";
import { loadSessionApiConfig, type SessionApiConfig } from "../../../src/config.js";
import { createLogger } from "../../../src/logger.js";
import { buildServer } from "../../../src/server.js";
import { buildSessionRoutes } from "../../../src/routes/session-routes.js";
import {
  FixedWindowRateGate,
  RateLimitedCreateSessionGuard,
  SessionActionRateLimiter,
  TerminalSessionCleaner,
  keepaliveExpiryReaper,
} from "../../../src/limits/index.js";
import { buildWssChannel, WSS_CHANNEL_ROUTE, type SessionConnectionRegistry } from "../../../src/wss/index.js";
import {
  DEBUG_CHANNEL_ROUTE,
  DebugChannelOrchestrator,
  buildDebugChannel,
  placeholderDebugVariantProvider,
  type DebugVariantProvider,
} from "../../../src/debug/index.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../../src/auth/cookie.js";
import { LiveSessionManager } from "../../../src/sessions/session-manager.js";
import {
  MemoryActionLogStore,
  MemoryChallengeBundleStore,
  MemoryChallengeRegistry,
  MemoryRateLimitCounter,
  MemoryRouteStore,
  MemorySessionRepository,
  MemorySnapshotStore,
  MemorySubmissionStore,
  MemoryIdempotencyWindow,
  SnapshotCipher,
  SnapshotPersistence,
  sha256Hex,
} from "../../../src/persistence/index.js";
import { buildDescriptorRoutes } from "../../../src/routes/descriptor-routes.js";
import { buildVerdictRoutes } from "../../../src/routes/verdict-routes.js";
import type { Logger } from "pino";
import { createLogCapture, type LogCapture } from "../../helpers/log-capture.js";
import { OutboundFrameRecorder } from "../../wss/helpers/outbound-frame-recorder.js";
import {
  REQUIRED_AUTH_ENV,
  HOST_BACKEND_TOKEN,
  REQUIRED_STORAGE_ENV,
} from "../../helpers/required-env.js";

/** 测试身份语料(非秘密合成标识符;与 auth-rig 同值域)。 */
export const TEST_TENANT_ID = "tenant-alpha";
export const TEST_TENANT_BETA_ID = "tenant-beta";
export const TEST_USER_ID = "user-42";
export const TEST_CHALLENGE_ID = "chal-stack-escape";
export const TEST_CHALLENGE_VERSION = "1.2.3";

export const DEFAULT_ALLOWED_ORIGINS = "https://plugin.example";

export const TEST_HOST_BACKEND_TOKEN = HOST_BACKEND_TOKEN;

const FAKE_WORKER = join(fileURLToPath(new URL(".", import.meta.url)), "fake-worker.mjs");

/** injectWS 建立的客户端 WebSocket(injectWS 返回类型的结构收口)。 */
export type RigWssClient = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

export type FakeWorkerMode =
  | "replay"
  | "watchdog_on_apply"
  | "watchdog_on_shutdown"
  | "crash_on_apply";

export function fakeWorkerCommand(mode: FakeWorkerMode = "replay") {
  return {
    command: process.execPath,
    args: [FAKE_WORKER],
    env: [["FAKE_MODE", mode]] as readonly (readonly [string, string])[],
  };
}

/** 调试面假 worker 路径(实现 load_variant + debug_* 命令最小子集;WP-41)。 */
const FAKE_DEBUG_WORKER = fileURLToPath(
  new URL("../../debug/helpers/fake-debug-worker.mjs", import.meta.url),
);

/** 调试面假 worker 进程描述(WP-41)。 */
export function fakeDebugWorkerCommand() {
  return {
    command: process.execPath,
    args: [FAKE_DEBUG_WORKER],
  };
}

export function makeEmbedSessionId(): string {
  return randomBytes(16).toString("base64url");
}

export interface SessionRigOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly workerMode?: FakeWorkerMode;
  readonly now?: () => number;
  /**
   * 指标面注入(WP-8,D-API-70;可选,缺省 = 不接线,与既有测试零差异):
   * 传入 SessionMetrics 实例即装配到 manager(观测动作 RTT / 队列深度 /
   * 会话 gauges),供指标接线测试消费。
   */
  readonly metrics?: import("../../../src/metrics/metrics.js").SessionMetrics;
  /**
   * 调试通道装配面(阶段四 WP-41;缺省 = 占位变体供给 + 假调试 worker,
   * 与 runtime.ts 同一装配拓扑)。选项:
   *  - `workerCommand`:调试 worker 进程描述(缺省 = fake-debug-worker);
   *  - `idleRecycleSeconds`:空闲回收窗口(缺省 = 保持窗口数值);
   *  - `enabled`:false = 不装配调试通道(通道红灯基线);
   *  - `variantProviderFactory`:变体供给端口工厂(WP-42:生产 Provider 路径
   *    的集成测试经此注入 `productionDebugVariantProvider`,入参 = rig 的
   *    内存双包存储,保证与 rig 消费同一对象;缺省仍为占位实现)。
   */
  readonly debug?: {
    readonly enabled?: boolean;
    readonly workerCommand?: { readonly command: string; readonly args?: readonly string[] };
    readonly idleRecycleSeconds?: number;
    readonly variantProviderFactory?: (bundles: MemoryChallengeBundleStore) => DebugVariantProvider;
  };
  /**
   * WSS 通道数值面(测试注入亚秒值以加速心跳 / 空闲 / 保持窗口行为验证;
   * 缺省取 config 默认值。与 runtime.ts 同一装配拓扑,仅数值面可覆写)。
   */
  readonly wss?: {
    readonly heartbeatIntervalSeconds?: number;
    readonly idleTimeoutSeconds?: number;
    readonly messageRatePerSecond?: number;
    readonly sendBufferLimit?: number;
    readonly disconnectKeepaliveSeconds?: number;
    /** 断线保持到期钩子(WP-6 回收挂载点的测试观察面)。 */
    readonly onKeepaliveExpiry?: (session: {
      readonly sessionId: string;
      readonly tenantId: string;
    }) => void | Promise<void>;
    /** 追加的出站帧录制面(装配台默认已挂一个 rig 级录制器)。 */
    readonly extraOutboundFrameSink?: (frame: WssFrame) => void;
  };
}

export interface SessionTestRig {
  readonly app: FastifyInstance;
  readonly config: SessionApiConfig;
  readonly logger: Logger;
  readonly capture: LogCapture;
  readonly manager: LiveSessionManager;
  readonly signer: TokenSigner;
  readonly audit: InMemoryAuditSink;
  readonly issuanceStore: InMemoryTokenIssuanceStore;
  readonly revocationStore: InMemoryCredentialRevocationStore;
  readonly sessions: MemorySessionRepository;
  /** 题目注册表(内存实现;descriptor 下发红灯直接登记版本行 / 读登记摘要)。 */
  readonly registry: MemoryChallengeRegistry;
  /** 题目双包对象存储(内存实现;调试变体 provider 的公开描述包读取源)。 */
  readonly bundles: MemoryChallengeBundleStore;
  readonly snapshots: MemorySnapshotStore;
  /** 提交引用 + 裁决呈现面读取端口(内存同构;recordVerdict 为测试驱动面)。 */
  readonly submissions: MemorySubmissionStore;
  /** 幂等窗口(WP-5 动作通道前置守卫的内存后端;与生产同接口)。 */
  readonly idempotencyWindow: MemoryIdempotencyWindow;
  /** 动作日志存储(append-only 端口的内存实现;submit 增量落库已接线,D-API-56)。 */
  readonly actionLog: MemoryActionLogStore;
  /** 固定窗口计数器(WP-6 限流执行点的内存实现)。 */
  readonly rateLimitCounter: MemoryRateLimitCounter;
  /** 终态会话保留窗口清理入口(WP-6,D-API-55;T0 无 cron,可调用)。 */
  readonly terminalCleaner: TerminalSessionCleaner;
  /** 每会话动作频率限制(WP-6,D-API-53;与每连接令牌桶叠加)。 */
  readonly sessionActionLimiter: SessionActionRateLimiter;
  /** 路由键(WP-5 通道激活绑定;T0 单实例消费,D-API-49)。 */
  readonly routeStore: MemoryRouteStore;
  /** WSS 连接注册表(多连接踢旧 / 断线保持计时器 / 停机关闭)。 */
  readonly wssRegistry: SessionConnectionRegistry;
  /** 调试实例编排器(WP-41;回收断言 / dispose 面)。 */
  readonly debugOrchestrator: DebugChannelOrchestrator;
  /** 建立已认证的调试通道连接(injectWS;Cookie 呈递升级凭证)。 */
  connectDebugChannel(cookie: string, headers?: Record<string, string>): Promise<RigWssClient>;
  /** rig 级出站帧录制器(WP-7 录制机检的捕获面;全部测试隐式可用)。 */
  readonly outboundRecorder: OutboundFrameRecorder;
  /** 建立已认证的 WSS 通道连接(injectWS;Cookie 呈递升级凭证,D-API-12)。 */
  connectChannel(cookie: string, headers?: Record<string, string>): Promise<RigWssClient>;
  /** 登记测试题目双包(字节模式;调试变体路径的公开编码表面)。 */
  registerByteChallenge(input?: {
    readonly challengeId?: string;
    readonly challengeVersion?: string;
    readonly tenantId?: string;
    readonly byteProgramHex?: string;
  }): Promise<void>;
  /** 登记测试题目双包(IR 模式最小合法对;装载管线真实校验)。 */
  registerChallenge(input?: {
    readonly challengeId?: string;
    readonly challengeVersion?: string;
    readonly tenantId?: string;
  }): Promise<void>;
  /** 直接经 signer + store 签发测试 embed token(嵌入协议 §六的签发面替身)。 */
  issueEmbedToken(overrides?: {
    readonly ttlSeconds?: number;
    readonly claims?: Partial<
      Pick<EmbedTokenClaims, "tenantId" | "userId" | "challengeId" | "challengeVersion" | "embedSessionId">
    >;
  }): Promise<{ token: string; claims: EmbedTokenClaims; record: IssuedEmbedTokenRecord }>;
}

export async function buildSessionTestRig(options: SessionRigOptions = {}): Promise<SessionTestRig> {
  const now = options.now;
  const config = loadSessionApiConfig({
    NODE_ENV: "test",
    SESSION_API_PORT: "0",
    SESSION_API_SIGNING_KEY: REQUIRED_AUTH_ENV.SESSION_API_SIGNING_KEY,
    SESSION_API_HOST_BACKEND_TOKEN: TEST_HOST_BACKEND_TOKEN,
    SESSION_API_ALLOWED_ORIGINS: DEFAULT_ALLOWED_ORIGINS,
    ...REQUIRED_STORAGE_ENV,
    ...options.env,
  });
  const capture = createLogCapture();
  const logger = createLogger(config, capture.stream);

  // ── 内存持久化面(WP-3 memory-stores;端口同构)──
  const registry = new MemoryChallengeRegistry(now);
  const bundles = new MemoryChallengeBundleStore();
  const sessions = new MemorySessionRepository(now);
  const snapshots = new MemorySnapshotStore(now);
  const submissions = new MemorySubmissionStore(now);
  const actionLog = new MemoryActionLogStore(now);
  const routeStore = new MemoryRouteStore(now);
  const rateLimitCounter = new MemoryRateLimitCounter(now);
  const idempotencyWindow = new MemoryIdempotencyWindow(config.idempotencyWindowTtlSeconds, now);

  const cipher = SnapshotCipher.fromBase64Key(config.snapshotEncryptionKey);
  const snapshotPersistence = new SnapshotPersistence({ store: snapshots, cipher });

  // ── WP-2 内存认证端口 ──
  const audit = new InMemoryAuditSink();
  const issuanceStore = new InMemoryTokenIssuanceStore({ now });
  const revocationStore = new InMemoryCredentialRevocationStore({ now });
  const signer = await createTokenSigner(config.signingKey);

  // ── 会话管理器(假 worker 注入;WP-6 执行面与生产装配同源)──
  // ── 调试实例编排器(阶段四 WP-41;占位变体供给 + 假调试 worker)──
  const debugOrchestrator = new DebugChannelOrchestrator({
    manager: {
      getSessionSummary: (sessionId, tenantId) => managerRef.current?.getSessionSummary(sessionId, tenantId) ?? null,
      listCheckpoints: async (sessionId, tenantId) =>
        (await managerRef.current?.listCheckpoints(sessionId, tenantId)) ?? [],
    },
    variantProvider: options.debug?.variantProviderFactory?.(bundles) ?? placeholderDebugVariantProvider({
      getPublic: async (challengeId, version) => bundles.getPublic(challengeId, version),
    }),
    bundles,
    actionLog,
    logger,
    idleRecycleSeconds: options.debug?.idleRecycleSeconds ?? config.disconnectKeepaliveSeconds,
    runToBreakpointMaxSteps: 10_000,
    workerCommand: options.debug?.workerCommand ?? fakeDebugWorkerCommand(),
    ...(now === undefined ? {} : { now }),
  });
  // manager 惰性绑定(编排器先于 manager 构造;闭包在请求期消费)。
  const managerRef: { current: LiveSessionManager | null } = { current: null };

  const manager = new LiveSessionManager({
    registry,
    bundles,
    sessions,
    submissions,
    snapshotPersistence,
    audit,
    logger,
    clientSeqLimit: config.maxClientSeqPerSession,
    actionLog,
    snapshots,
    quotaLimits: {
      maxCheckpointsPerSession: config.maxCheckpointsPerSession,
      snapshotByteBudget: config.snapshotByteBudget,
      tenantStorageQuotaBytes: config.tenantStorageQuotaBytes,
    },
    maxConcurrentSessionsPerTenant: config.maxConcurrentSessionsPerTenant,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    onSessionClosed: ({ sessionId, tenantId }) => debugOrchestrator.recycleSession(sessionId, tenantId),
    ...(now === undefined ? {} : { now }),
    workerCommand: fakeWorkerCommand(options.workerMode ?? "replay"),
  });
  managerRef.current = manager;

  // ── WP-6 限流面(与 runtime.ts 同一拓扑;内存计数器载体)──
  const requestRateGate = new FixedWindowRateGate({
    counter: rateLimitCounter,
    limitPerWindow: config.rateLimitRequestsPerMinute,
  });
  const submitRateGate = new FixedWindowRateGate({
    counter: rateLimitCounter,
    limitPerWindow: config.submissionsPerMinute,
  });
  // 裁决重询频率闸(阶段六 WP-63,D-API-84):与 runtime.ts 同一拓扑。
  const verdictRateGate = new FixedWindowRateGate({
    counter: rateLimitCounter,
    limitPerWindow: config.verdictQueriesPerMinute,
  });
  const createSessionGuard = new RateLimitedCreateSessionGuard({
    rateGate: requestRateGate,
    liveCountByTenant: (tenantId) => manager.liveCountByTenant(tenantId),
    maxConcurrentSessionsPerTenant: config.maxConcurrentSessionsPerTenant,
    logger,
  });
  // 数值面:测试注入亚秒值(缺省 config 默认);每会话动作频率与每连接令牌桶
  // 同源同值(D-API-53),同一覆写保持两道闸一致。
  const wssMessageRatePerSecond =
    options.wss?.messageRatePerSecond ?? config.wssMessageRatePerSecond;
  const sessionActionLimiter = new SessionActionRateLimiter({
    capacityPerSecond: wssMessageRatePerSecond,
    ...(now === undefined ? {} : { now }),
  });
  const terminalCleaner = new TerminalSessionCleaner({
    sessions,
    snapshots,
    ...(now === undefined ? {} : { now }),
  });

  // ── 服务装配(与 runtime.ts 同一拓扑)──
  const outboundRecorder = new OutboundFrameRecorder();
  const extraOutboundFrameSink = options.wss?.extraOutboundFrameSink;
  // 保持到期回收链(D-API-55):生产回收执行面(keepaliveExpiryReaper)在先,
  // 测试观察钩子(options.wss.onKeepaliveExpiry)在后——回收语义不变,只追加观察。
  const reaper = keepaliveExpiryReaper(manager, logger);
  const wssChannel = buildWssChannel({
    manager,
    idempotencyWindow,
    routeStore,
    signer,
    revocationStore,
    allowedOrigins: config.allowedOrigins,
    logger,
    // 数值面:测试注入亚秒值(缺省 config 默认);其余与生产装配同源。
    heartbeatIntervalSeconds: options.wss?.heartbeatIntervalSeconds ?? config.wssHeartbeatIntervalSeconds,
    idleTimeoutSeconds: options.wss?.idleTimeoutSeconds ?? config.wssIdleTimeoutSeconds,
    messageRatePerSecond: wssMessageRatePerSecond,
    sessionActionLimiter,
    sendBufferLimit: options.wss?.sendBufferLimit ?? config.wssSendBufferLimit,
    disconnectKeepaliveSeconds:
      options.wss?.disconnectKeepaliveSeconds ?? config.disconnectKeepaliveSeconds,
    onKeepaliveExpiry:
      options.wss?.onKeepaliveExpiry === undefined
        ? reaper
        : async (session) => {
            await reaper(session);
            await options.wss?.onKeepaliveExpiry?.(session);
          },
    limits: {
      maxJsonDepth: config.maxJsonDepth,
      maxArrayLength: 256,
      maxStringLength: 4096,
    },
    outboundFrameSink: extraOutboundFrameSink === undefined
      ? outboundRecorder.sink
      : (frame) => {
          outboundRecorder.sink(frame);
          extraOutboundFrameSink(frame);
        },
    ...(now === undefined ? {} : { now }),
  });

  // 调试通道(阶段四 WP-41;须在既有 WSS 通道之后注册——@fastify/websocket
  // 装饰器由前者注册,后者复用同一装饰面)。
  const debugChannelPlugin =
    options.debug?.enabled === false
      ? undefined
      : buildDebugChannel({
          orchestrator: debugOrchestrator,
          signer,
          revocationStore,
          allowedOrigins: config.allowedOrigins,
          logger,
          heartbeatIntervalSeconds: options.wss?.heartbeatIntervalSeconds ?? config.wssHeartbeatIntervalSeconds,
          idleTimeoutSeconds: options.wss?.idleTimeoutSeconds ?? config.wssIdleTimeoutSeconds,
          messageRatePerSecond: wssMessageRatePerSecond,
          sessionActionLimiter,
          sendBufferLimit: options.wss?.sendBufferLimit ?? config.wssSendBufferLimit,
          limits: {
            maxJsonDepth: config.maxJsonDepth,
            maxArrayLength: 256,
            maxStringLength: 4096,
          },
          ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
          ...(now === undefined ? {} : { now }),
        });

  const app = buildServer(config, logger, {
    authPlugin: buildAuthPlugin({ config, signer, issuanceStore, revocationStore, audit }),
    sessionRoutes: buildSessionRoutes({      config,
      manager,
      logger,
      guards: {
        maxJsonDepth: config.maxJsonDepth,
        maxArrayLength: 256,
        maxStringLength: 4096,
      },
      signer,
      issuanceStore,
      revocationStore,
      audit,
      allowedOrigins: config.allowedOrigins,
      createSessionGuard,
      requestRateGate: (tenantId, userId) =>
        requestRateGate.acquireOrThrow(`rate:${tenantId}:${userId}`, "request_rate"),
      submitRateGate: (tenantId, userId) =>
        submitRateGate.acquireOrThrow(`rate:${tenantId}:${userId}:submit`, "submission_rate"),
      // Cookie Path 调宽(D-API-83):与生产 runtime.ts 同一装配拓扑。
      credentialCookiePath: "/",
      ...(now === undefined ? {} : { now }),
    }),
    // 裁决呈现路由(阶段六 WP-63,D-API-83):与 runtime.ts 同一装配拓扑
    // (内存 submissions 承载 VerdictQueryStore 端口 + 裁决重询频率闸)。
    verdictRoutes: buildVerdictRoutes({
      signer,
      revocationStore,
      allowedOrigins: config.allowedOrigins,
      verdicts: submissions,
      verdictRateGate: (tenantId, userId) =>
        verdictRateGate.acquireOrThrow(`rate:${tenantId}:${userId}:verdict`, "verdict_query_rate"),
      ...(now === undefined ? {} : { now }),
    }),
    // 公开描述包下发路由(阶段五 WP-50,D-API-76):与 runtime.ts 同一
    // 装配拓扑(registry / bundles 内存实现 + config 护栏数值)。
    descriptorRoutes: buildDescriptorRoutes({
      registry,
      bundles,
      maxDescriptorBytes: config.maxDescriptorBytes,
      maxJsonDepth: config.maxJsonDepth,
    }),
    wssChannel: wssChannel.plugin,
    ...(debugChannelPlugin === undefined ? {} : { debugChannel: debugChannelPlugin }),
  });
  await app.ready();

  return {
    app,
    config,
    logger,
    capture,
    manager,
    signer,
    audit,
    issuanceStore,
    revocationStore,
    sessions,
    registry,
    bundles,
    snapshots,
    submissions,
    idempotencyWindow,
    actionLog,
    rateLimitCounter,
    terminalCleaner,
    sessionActionLimiter,
    routeStore,
    wssRegistry: wssChannel.registry,
    debugOrchestrator,
    outboundRecorder,
    async connectDebugChannel(cookie: string, headers: Record<string, string> = {}) {
      return app.injectWS(DEBUG_CHANNEL_ROUTE, {
        headers: { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}`, ...headers },
      });
    },
    async connectChannel(cookie: string, headers: Record<string, string> = {}) {
      return app.injectWS(WSS_CHANNEL_ROUTE, {
        headers: { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}`, ...headers },
      });
    },
    async registerByteChallenge(input?: {
      challengeId?: string;
      challengeVersion?: string;
      tenantId?: string;
      byteProgramHex?: string;
    }): Promise<void> {
      const challengeId = input?.challengeId ?? TEST_CHALLENGE_ID;
      const challengeVersion = input?.challengeVersion ?? TEST_CHALLENGE_VERSION;
      const tenantId = input?.tenantId ?? TEST_TENANT_ID;
      const pair = buildBytePair({
        ...(input?.byteProgramHex === undefined ? {} : { byteProgramHex: input.byteProgramHex }),
        mutate: (mutable) => {
          const descriptor = mutable.publicDescriptor as unknown as {
            challengeId: string;
            challengeContentVersion: string;
            initialProjection: { visibleRegisters: { name: string; valueHex: string }[] };
          };
          descriptor.challengeId = challengeId;
          descriptor.challengeContentVersion = challengeVersion;
          const bundle = mutable.privateBundle as {
            challengeId: string;
            challengeContentVersion: string;
            initialState: { registers: Record<string, string> };
            entrypointAddressHex: string;
          };
          bundle.challengeId = challengeId;
          bundle.challengeContentVersion = challengeVersion;
          // 初始 RIP 对齐字节程序入口(缺省镜像公开包的 0x400100 填充区;
          // 调试变体与真实实例同源取值,重放对齐要求两者一致)。
          const rip = descriptor.initialProjection.visibleRegisters.find((r) => r.name === "RIP");
          if (rip !== undefined) {
            rip.valueHex = bundle.entrypointAddressHex;
          }
          bundle.initialState.registers["RIP"] = bundle.entrypointAddressHex;
        },
      });
      const publicDescriptorBytes = Buffer.from(JSON.stringify(pair.publicDescriptor), "utf8");
      await registry.upsertChallenge({ challengeId, tenantId });
      await registry.insertChallengeVersion({
        challengeId,
        contentVersion: challengeVersion,
        tenantId,
        vmProfileVersion: "1.0.0",
        // 双包摘要 = 实际入桶字节的 SHA-256(WP-50 起 descriptor 下发端点按
        // 登记摘要动态复算,D-API-76;rig 与登记路径 ChallengeRegistrar 同源)。
        privateBundleSha256: sha256Hex(Buffer.from(JSON.stringify(pair.privateBundle), "utf8")),
        publicDescriptorSha256: sha256Hex(publicDescriptorBytes),
        privateBundleObject: `${challengeId}/${challengeVersion}/bundle.json`,
        publicDescriptorObject: `${challengeId}/${challengeVersion}/descriptor.json`,
        signature: "test-signature",
        signerKeyId: "test-key",
      });
      await bundles.putPrivate(
        challengeId,
        challengeVersion,
        Buffer.from(JSON.stringify(pair.privateBundle), "utf8"),
      );
      await bundles.putPublic(challengeId, challengeVersion, publicDescriptorBytes);
    },

    async registerChallenge(input = {}) {
      const challengeId = input.challengeId ?? TEST_CHALLENGE_ID;
      const challengeVersion = input.challengeVersion ?? TEST_CHALLENGE_VERSION;
      const tenantId = input.tenantId ?? TEST_TENANT_ID;
      const pair = buildIrPair({
        mutate: (mutable) => {
          const descriptor = mutable.publicDescriptor as { challengeId: string; challengeContentVersion: string };
          descriptor.challengeId = challengeId;
          descriptor.challengeContentVersion = challengeVersion;
          const bundle = mutable.privateBundle as {
            challengeId: string;
            challengeContentVersion: string;
          };
          bundle.challengeId = challengeId;
          bundle.challengeContentVersion = challengeVersion;
        },
      });
      const publicDescriptorBytes = Buffer.from(JSON.stringify(pair.publicDescriptor), "utf8");
      await registry.upsertChallenge({ challengeId, tenantId });
      await registry.insertChallengeVersion({
        challengeId,
        contentVersion: challengeVersion,
        tenantId,
        vmProfileVersion: "1.0.0",
        // 双包摘要 = 实际入桶字节的 SHA-256(WP-50,D-API-76 同上)。
        privateBundleSha256: sha256Hex(Buffer.from(JSON.stringify(pair.privateBundle), "utf8")),
        publicDescriptorSha256: sha256Hex(publicDescriptorBytes),
        privateBundleObject: `${challengeId}/${challengeVersion}/bundle.json`,
        publicDescriptorObject: `${challengeId}/${challengeVersion}/descriptor.json`,
        signature: "test-signature",
        signerKeyId: "test-key",
      });
      await bundles.putPrivate(
        challengeId,
        challengeVersion,
        Buffer.from(JSON.stringify(pair.privateBundle), "utf8"),
      );
      await bundles.putPublic(challengeId, challengeVersion, publicDescriptorBytes);
    },
    async issueEmbedToken(overrides = {}) {
      const ttlSeconds = overrides.ttlSeconds ?? config.embedTokenTtlSeconds;
      const nowMs = (now ?? Date.now)();
      const claims: EmbedTokenClaims = {
        tenantId: overrides.claims?.tenantId ?? TEST_TENANT_ID,
        userId: overrides.claims?.userId ?? TEST_USER_ID,
        challengeId: overrides.claims?.challengeId ?? TEST_CHALLENGE_ID,
        challengeVersion: overrides.claims?.challengeVersion ?? TEST_CHALLENGE_VERSION,
        embedSessionId: overrides.claims?.embedSessionId ?? makeEmbedSessionId(),
        jti: randomUUID(),
        expiresAt: Math.floor(nowMs / 1000) + ttlSeconds,
      };
      const token = await signer.signEmbedToken(claims);
      const record: IssuedEmbedTokenRecord = {
        jti: claims.jti,
        tenantId: claims.tenantId,
        userId: claims.userId,
        challengeId: claims.challengeId,
        challengeVersion: claims.challengeVersion,
        embedSessionId: claims.embedSessionId,
        issuedAt: nowMs,
        expiresAt: claims.expiresAt * 1000,
      };
      await issuanceStore.put(record, ttlSeconds);
      return { token, claims, record };
    },
  };
}

/** 从 create-session 响应提取 Set-Cookie 呈递值(inject 无 Cookie Jar)。 */
export function sessionCredentialFromSetCookie(response: {
  headers: Record<string, unknown>;
}): string {
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof raw !== "string") {
    throw new Error("响应缺少 Set-Cookie(凭证交付面缺失)");
  }
  const separator = raw.indexOf("=");
  const value = raw.slice(separator + 1, raw.indexOf(";", separator));
  return value;
}

/** 构造会话命令请求体(冻结信封;protocolVersion 固定当前版本 1)。 */
export function sessionCommand(
  command: "create_session" | "sync_projection" | "list_checkpoints" | "submit" | "close_session",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { command, protocolVersion: 1, payload };
}

/**
 * Cookie 呈递的变更方法请求必须携带白名单 Origin(D-API-17 CSRF 闸;
 * inject 不自动携带,测试显式补齐)。
 */
export function credentialHeaders(): Record<string, string> {
  return { origin: DEFAULT_ALLOWED_ORIGINS };
}
