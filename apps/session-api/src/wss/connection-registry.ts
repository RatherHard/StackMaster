/**
 * 会话连接注册表(任务分解 WP-5 第 4 / 5 条;D-API-40 / D-API-45)。
 *
 * 多连接策略 = **踢旧**:同会话第二连接在激活时把旧连接以错误帧说明
 * (connection replaced)后策略关闭——教学场景同账号重连体验优先;服务端
 * 串行不变性是底线(每会话至多一条活跃通道,叠加 manager 单会话串行队列,
 * 串行无并发执行)。
 *
 * 断线保持(§4.2.3 服务端侧义务):会话不因连接断开而关闭;最后一个活跃
 * 连接移除时启动保持计时器(`SESSION_API_DISCONNECT_KEEPALIVE_SECONDS`,
 * 默认 300 s),重连(下一连接激活)即取消。计时器到期 = `route:{sessionId}`
 * 键释放 + `onKeepaliveExpiry` 钩子(WP-6 会话资源回收的挂载点:本注册表
 * 只负责计时器启动 / 取消,回收执行面归 WP-6)。
 *
 * RouteStore 消费(D-API-49,T0 单实例形态):连接激活时 bind、心跳节拍
 * 续期、保持到期 / 停机时 release;绑定失败只进受控日志不拒绝连接——T0 中
 * 路由定位未被消费,Redis fail-closed 的完整路由接线归 T1 多实例演进。
 */
import type { Logger } from "pino";

import type { RouteStore } from "../persistence/ports.js";

/** 注册表对活跃通道的最小依赖面(由 ActionChannelConnection 实现)。 */
export interface RegistryChannel {
  /** 通道绑定的会话(凭证 claims.sessionId,升级即锚定)。 */
  readonly sessionId: string;
  readonly tenantId: string;
  /** 踢旧:错误帧说明后策略关闭(D-API-40)。 */
  replaceByNewConnection(): void;
  /** 停机收尾:冲刷发送缓冲后以 close 1001 有序关闭(D-API-48)。 */
  closeForShutdown(): Promise<void>;
}

export interface SessionConnectionRegistryOptions {
  readonly logger: Logger;
  /** 断线保持窗口(秒;config.disconnectKeepaliveSeconds,默认 300)。 */
  readonly disconnectKeepaliveSeconds: number;
  /** RouteStore 端口(T0 单实例消费;可省略)。 */
  readonly routeStore?: RouteStore;
  /** 路由键 TTL(秒;与会话保活节奏一致——取保持窗口 + 心跳余量)。 */
  readonly routeTtlSeconds: number;
  /** 本编排器实例标识(route:{sessionId} 的属主值;非秘密)。 */
  readonly ownerId: string;
  /**
   * 保持窗口到期钩子(WP-6 会话资源回收的挂载点;缺省仅释放 route 键并记录)。
   * 回收执行面(会话关闭 / worker 回收 / 会话行对齐)归 WP-6。
   */
  readonly onKeepaliveExpiry?: (session: {
    readonly sessionId: string;
    readonly tenantId: string;
  }) => void | Promise<void>;
  readonly now?: () => number;
}

interface ActiveEntry {
  readonly channel: RegistryChannel;
}

export class SessionConnectionRegistry {
  readonly #options: SessionConnectionRegistryOptions;
  readonly #log: Logger;
  readonly #active = new Map<string, ActiveEntry>();
  readonly #keepaliveTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: SessionConnectionRegistryOptions) {
    this.#options = options;
    this.#log = options.logger.child({ component: "wss-connection-registry" });
  }

  /** 本实例标识(路由属主值)。 */
  get ownerId(): string {
    return this.#options.ownerId;
  }

  /** 活跃连接数(可观测 / 测试断言)。 */
  get activeCount(): number {
    return this.#active.size;
  }

  /** 保持窗口待到期会话(可观测 / 测试断言)。 */
  keepalivePendingSessionIds(): readonly string[] {
    return [...this.#keepaliveTimers.keys()];
  }

  /** 会话是否有活跃通道。 */
  hasActive(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  /**
   * 激活连接(升级完成即调用):取消该会话待到期的保持计时器 → 踢旧 →
   * 登记为新属主 → route 键绑定(尽力)。
   */
  activate(channel: RegistryChannel): void {
    this.#cancelKeepalive(channel.sessionId);
    const existing = this.#active.get(channel.sessionId);
    if (existing !== undefined && existing.channel !== channel) {
      this.#log.info(
        { sessionId: channel.sessionId, tenantId: channel.tenantId },
        "wss connection replaced by new connection (kick-old)",
      );
      existing.channel.replaceByNewConnection();
    }
    this.#active.set(channel.sessionId, { channel });
    this.#bindRoute(channel.sessionId);
  }

  /**
   * 连接关闭收尾:仅当关闭的仍是登记属主时移除;移除后无活跃连接即启动
   * 断线保持计时器(会话保持,不关闭)。
   */
  deactivate(channel: RegistryChannel): void {
    const entry = this.#active.get(channel.sessionId);
    if (entry === undefined || entry.channel !== channel) {
      return;
    }
    this.#active.delete(channel.sessionId);
    this.#startKeepalive(channel.sessionId, channel.tenantId);
  }

  /**
   * 优雅停机(D-API-48):全部活跃通道有序关闭(冲刷发送缓冲 → close 1001),
   * 保持计时器全部取消(会话状态由停机冲刷步骤落盘,回收归重启恢复)。
   */
  async closeAll(): Promise<void> {
    this.#cancelAllKeepaliveTimers();
    const channels = [...this.#active.values()].map((entry) => entry.channel);
    this.#active.clear();
    await Promise.all(channels.map((channel) => channel.closeForShutdown()));
    if (channels.length > 0) {
      this.#log.info({ connections: channels.length }, "wss channels closed for shutdown");
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #bindRoute(sessionId: string): void {
    const { routeStore } = this.#options;
    if (routeStore === undefined) {
      return;
    }
    routeStore
      .bind(sessionId, this.#options.ownerId, this.#options.routeTtlSeconds)
      .catch((error: unknown) => {
        // T0 单实例:路由定位未被消费,绑定失败不拒绝连接(只进受控日志);
        // fail-closed 的完整路由接线归 T1 多实例(D-API-49)。
        this.#log.warn(
          { sessionId, reason: error instanceof Error ? error.message : "bind failed" },
          "route bind failed (routing not consumed in single-instance mode)",
        );
      });
  }

  /** 心跳节拍的 route 续期(尽力;失败同 bind 只进受控日志)。 */
  refreshRoute(sessionId: string): void {
    const { routeStore } = this.#options;
    if (routeStore === undefined || !this.#active.has(sessionId)) {
      return;
    }
    routeStore
      .bind(sessionId, this.#options.ownerId, this.#options.routeTtlSeconds)
      .catch((error: unknown) => {
        this.#log.warn(
          { sessionId, reason: error instanceof Error ? error.message : "refresh failed" },
          "route refresh failed (routing not consumed in single-instance mode)",
        );
      });
  }

  #startKeepalive(sessionId: string, tenantId: string): void {
    this.#cancelKeepalive(sessionId);
    const timeoutMs = this.#options.disconnectKeepaliveSeconds * 1000;
    const timer = setTimeout(() => {
      this.#keepaliveTimers.delete(sessionId);
      void this.#expireKeepalive(sessionId, tenantId);
    }, timeoutMs);
    timer.unref();
    this.#keepaliveTimers.set(sessionId, timer);
  }

  async #expireKeepalive(sessionId: string, tenantId: string): Promise<void> {
    this.#log.info({ sessionId, tenantId }, "disconnect keepalive window expired");
    const { routeStore, onKeepaliveExpiry } = this.#options;
    if (routeStore !== undefined) {
      await routeStore.release(sessionId).catch((error: unknown) => {
        this.#log.warn(
          { sessionId, reason: error instanceof Error ? error.message : "release failed" },
          "route release failed on keepalive expiry",
        );
      });
    }
    // WP-6 挂载点:回收执行面归 WP-6;缺省(未注入)到此为止。
    await onKeepaliveExpiry?.({ sessionId, tenantId });
  }

  #cancelKeepalive(sessionId: string): void {
    const timer = this.#keepaliveTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#keepaliveTimers.delete(sessionId);
    }
  }

  #cancelAllKeepaliveTimers(): void {
    for (const timer of this.#keepaliveTimers.values()) {
      clearTimeout(timer);
    }
    this.#keepaliveTimers.clear();
  }
}
