/**
 * <pwn-memory-vm> —— 插件 Shell 正式实现(阶段五 WP-52;占位桩退场)。
 *
 * 独立来源 iframe 内的插件视图托管:一次性读取 fragment esid → 发起嵌入握手
 * (PluginEmbedHandshake,V-1'/V-5/V-7/V-8/V-10/V-11/V-12 插件角色)→ 引导
 * 配置取回(D-API-75 默认通道 a,与握手并行)→ SessionClient create_session
 * (embedToken 随 create_session 命令体、embedSessionId = esid,credentials
 * include;冻结 SessionCommandRequest 契约)→ 挂载 <sm-workspace>(vm-ui 公开
 * 投影渲染 / 断线横幅 / sync-projection 重连由 vm-ui 既有能力承接)。
 *
 * 降级面(静态文案,零反射面——嵌入协议 §4.3:不回显任何对端消息内容):
 *  - esid 缺失 / 形态不符 → 直接降级,不发起握手与取回(无重试入口);
 *  - 引导配置取回失败 / 形态不符 → 降级(重试入口重跑取回);
 *  - T_handshake 窗口耗尽未就绪 → 降级(重试入口 = 同会话 hello 重发,seq 递增,
 *    §4.5);迟到的 ready 通过全部校验后仍可完成握手(慢网韧性);
 *  - create_session 失败 → 降级(重试入口重建会话;token 单次消费语义由
 *    服务端裁决)。
 *
 * 能力降级三行(§4.4):未授予 auto_resize → 不装配高度管道(固定高度);
 * 未授予 theme / language → 外观保持内置默认(light / zh-CN);capabilities
 * 空数组 = 完全静态形态(工作区照常渲染,无高度 / 外观消息往来)。
 *
 * 主题 / 语言接线位(WP-53 增量面):EmbedAppearanceController 为唯一接线点,
 * 解析结果落 host 元素 `data-sm-theme`(二值)/ `data-sm-language` 与
 * `color-scheme`;三值状态与语言字符串经 `appearanceSnapshot` 可读。主题双套
 * 变量与 i18n 抽取面归 WP-53,在本接口上增量。
 *
 * 依赖纪律(Q3 定案):本包消费 embed-runtime 无状态构件与 vm-ui 公开导出,
 * 自包含打包(lit / vm-ui / protocol / embed-runtime 内联进 dist 单产物)。
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";

import { MAX_EMBED_HEIGHT_PX } from "@stackmaster/protocol";
import {
  HANDSHAKE_TIMEOUT_MS_DEFAULT,
  HELLO_MAX_RETRIES_DEFAULT,
} from "@stackmaster/embed-runtime";
import {
  PWN_EMBED_EVENTS,
  PluginEmbedHandshake,
  type PluginCredentialDetail,
  type PluginDegradedDetail,
  type PluginLanguageChangedDetail,
  type PluginListenWindow,
  type PluginParentWindow,
  type PluginReadyDetail,
  type PluginScheduler,
  type PluginThemeChangedDetail,
} from "./plugin/handshake.js";
import {
  EmbedAppearanceController,
  type EmbedAppearanceSnapshot,
  type MediaQueryLike,
} from "./plugin/appearance.js";
import { fetchEmbedBootstrapConfig, type EmbedBootstrapConfig } from "./plugin/bootstrap.js";
import { readEmbedSessionIdFromFragment } from "./plugin/esid.js";
import { HeightReporter, type FrameSchedulerLike } from "./plugin/height-reporter.js";
import { SessionClient, SmWorkspace } from "@stackmaster/vm-ui";

/** 降级原因(静态文案键;零反射面)。 */
export type PwnDegradedReason =
  | "esid-missing"
  | "bootstrap-failed"
  | "handshake-timeout"
  | "session-failed";

/** 降级静态文案(唯一可见内容;不携带任何对端消息细节)。 */
const DEGRADED_TEXTS: Readonly<Record<PwnDegradedReason, string>> = {
  "esid-missing": "嵌入会话缺失:页面 URL 未携带有效的会话标识,无法启动。请从宿主平台重新进入。",
  "bootstrap-failed": "引导配置取回失败:未能取得会话引导信息。可点击重试,或从宿主平台重新进入。",
  "handshake-timeout": "连接宿主超时:在时限内未完成握手。可点击重试,或从宿主平台重新进入。",
  "session-failed": "会话创建失败:未能建立练习会话。可点击重试,或从宿主平台重新进入。",
};

const CONNECTING_TEXT = "正在建立嵌入连接……";

/** 部署级全局配置注入形态(优先级低于 attribute)。 */
interface PwnGlobalConfig {
  readonly bootstrapEndpoint?: string;
}

/** ResizeObserver 最小面(真实全局的结构子集;jsdom 无此全局)。 */
interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

@customElement("pwn-memory-vm")
export class PwnMemoryVm extends LitElement {
  /* ── 部署配置属性面 ─────────────────────────────────────────────────── */

  /** 引导配置取回端点 URL(D-API-75 通道 a;插件文档页经 attribute 注入)。 */
  @property({ type: String, attribute: "bootstrap-endpoint" })
  bootstrapEndpoint = "";

  /** T_handshake(默认 10000;D-API-77 内置常量,属性面仅供部署收紧与测试)。 */
  @property({ type: Number, attribute: "handshake-timeout-ms" })
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS_DEFAULT;

  /** hello 重试上限(默认 3;D-API-77)。 */
  @property({ type: Number, attribute: "hello-max-retries" })
  helloMaxRetries = HELLO_MAX_RETRIES_DEFAULT;

  /** 高度收紧上限(默认 = 协议冻结常量;只可收紧,越上限回落常量不放宽)。 */
  @property({ type: Number, attribute: "max-height-px" })
  maxHeightPx = MAX_EMBED_HEIGHT_PX;

  /* ── 测试接缝(非 attribute;默认走浏览器全局)──────────────────────── */

  /** fragment 来源注入(默认读 window.location.hash)。 */
  @property({ attribute: false })
  locationHash: string | null = null;

  /** fetch 注入(引导配置取回;默认 globalThis.fetch)。 */
  @property({ attribute: false })
  fetchImpl: typeof fetch | null = null;

  /** 发起窗口注入(默认 window.parent)。 */
  @property({ attribute: false })
  parentWindow: PluginParentWindow | null = null;

  /** 监听窗口注入(默认 globalThis)。 */
  @property({ attribute: false })
  listenWindow: PluginListenWindow | null = null;

  /** V-1' 期望 source 注入(默认同 parentWindow)。 */
  @property({ attribute: false })
  expectedSource: unknown = undefined;

  /** 时钟 / 调度器注入(T_handshake 与限速;默认 performance.now / setTimeout)。 */
  @property({ attribute: false })
  clock: (() => number) | null = null;

  @property({ attribute: false })
  scheduler: PluginScheduler | null = null;

  /** SessionClient 工厂注入(默认 new SessionClient({ baseUrl });集成测试接缝)。 */
  @property({ attribute: false })
  createSessionClient: ((options: { baseUrl?: string }) => SessionClient) | null = null;

  /** 内容高度测量注入(默认 () => this.scrollHeight)。 */
  @property({ attribute: false })
  measureHeight: (() => number) | null = null;

  /** rAF 调度注入(高度合流;默认全局 requestAnimationFrame)。 */
  @property({ attribute: false })
  frameScheduler: FrameSchedulerLike | null = null;

  /** matchMedia 注入(auto 主题系统跟随;默认 window.matchMedia)。 */
  @property({ attribute: false })
  matchMediaImpl: ((query: string) => MediaQueryLike | null) | null = null;

  /* ── 内部状态(非响应式声明;变更点手动 requestUpdate)────────────────── */

  readonly #workspaceRef: Ref<SmWorkspace> = createRef();
  #booted = false;
  #disposed = false;
  #esid: string | null = null;
  #handshake: PluginEmbedHandshake | null = null;
  #bootstrapConfig: EmbedBootstrapConfig | null = null;
  #portCredential: string | null = null;
  #client: SessionClient | null = null;
  #sessionStarting = false;
  #readySeen = false;
  #degraded: PwnDegradedReason | null = null;
  readonly #appearance = new EmbedAppearanceController();
  #heightReporter: HeightReporter | null = null;
  #resizeObserver: ResizeObserverLike | null = null;
  #localCounters: Record<string, number> = {};
  #appearanceDisposer: (() => void) | null = null;

  static override styles = css`
    :host {
      display: block;
      background: canvas;
      color: canvastext;
    }

    .status {
      margin: 0;
      padding: 1rem;
      font: system-ui 0.875rem sans-serif;
      color: graytext;
    }

    .degraded {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 1rem;
      border: 1px solid rgb(0 0 0 / 15%);
      border-radius: 8px;
      font: system-ui 0.875rem sans-serif;
    }

    .degraded p {
      margin: 0;
    }

    .degraded button {
      align-self: flex-start;
      font: inherit;
      padding: 0.3125rem 0.75rem;
      cursor: pointer;
    }

    .workspace-slot {
      display: block;
      min-block-size: 16rem;
    }
  `;

  /* ── 诊断只读面(测试 / WP-55 E2E 锚)───────────────────────────────── */

  /** 当前阶段(diagnostics / E2E)。 */
  get phase(): "connecting" | "degraded" | "session-ready" {
    if (this.#degraded !== null) return "degraded";
    if (this.#client !== null) return "session-ready";
    return "connecting";
  }

  /** 降级原因(未降级为 null)。 */
  get degradedReason(): PwnDegradedReason | null {
    return this.#degraded;
  }

  /** 违规计数快照(协议违规键与宿主侧同词汇 + 本地高度护栏键;V-12 本地面)。 */
  get violationCounters(): Readonly<Record<string, number>> {
    return Object.freeze({
      ...this.#localCounters,
      ...(this.#handshake?.getViolationCounters() ?? {}),
    });
  }

  /** 外观快照(theme 三值保持 + resolved 二值 + 语言;WP-53 接线读出面)。 */
  get appearanceSnapshot(): EmbedAppearanceSnapshot {
    return this.#appearance.snapshot;
  }

  /** 当前嵌入会话标识(与 iframe URL fragment 同值;非秘密)。 */
  get embedSessionId(): string | null {
    return this.#esid;
  }

  /** port 备用通道凭证是否已收取(只报布尔,凭证值零回显)。 */
  get portCredentialReceived(): boolean {
    return this.#portCredential !== null;
  }

  /* ── 生命周期 ───────────────────────────────────────────────────────── */

  protected override firstUpdated(): void {
    // Lit 属性在插入前已就位(测试经 createElement + 属性赋值 + append);
    // 幂等守卫使热更新 / 重挂不重启管道。
    this.#boot();
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.#appearanceDisposer ??= this.#appearance.onChange((snapshot) => {
      this.#applyAppearanceToHost(snapshot);
    });
    this.#applyAppearanceToHost(this.#appearance.snapshot);
  }

  public override disconnectedCallback(): void {
    this.#teardown();
    super.disconnectedCallback();
  }

  /* ── 装配管线 ───────────────────────────────────────────────────────── */

  #boot(): void {
    if (this.#booted || this.#disposed) return;
    this.#booted = true;

    // 1. esid 一次性读取(fragment;缺失 / 形态不符 → 直接降级,零请求)。
    const hash = this.locationHash ?? window.location.hash;
    const esid = readEmbedSessionIdFromFragment(hash);
    if (esid === null) {
      this.#degrade("esid-missing");
      this.requestUpdate();
      return;
    }
    this.#esid = esid;

    // 2. 嵌入握手(hello 立即发出;与引导配置取回并行——token 只服务
    //    create-session,握手不依赖它)。
    this.#handshake = new PluginEmbedHandshake({
      esid,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      helloMaxRetries: this.helloMaxRetries,
      ...(this.parentWindow !== null ? { parentWindow: this.parentWindow } : {}),
      ...(this.listenWindow !== null ? { listenWindow: this.listenWindow } : {}),
      ...(this.expectedSource !== undefined ? { expectedSource: this.expectedSource } : {}),
      ...(this.clock !== null ? { clock: this.clock } : {}),
      ...(this.scheduler !== null ? { scheduler: this.scheduler } : {}),
    });
    this.#handshake.addEventListener(PWN_EMBED_EVENTS.ready, (event: Event) => {
      this.#onReady((event as CustomEvent<PluginReadyDetail>).detail);
    });
    this.#handshake.addEventListener(PWN_EMBED_EVENTS.degraded, (event: Event) => {
      const detail = (event as CustomEvent<PluginDegradedDetail>).detail;
      this.#degrade(detail.reason);
      this.requestUpdate();
    });
    this.#handshake.addEventListener(PWN_EMBED_EVENTS.themeChanged, (event: Event) => {
      this.#appearance.apply({ theme: (event as CustomEvent<PluginThemeChangedDetail>).detail.theme });
    });
    this.#handshake.addEventListener(PWN_EMBED_EVENTS.languageChanged, (event: Event) => {
      this.#appearance.apply({
        language: (event as CustomEvent<PluginLanguageChangedDetail>).detail.language,
      });
    });
    this.#handshake.addEventListener(PWN_EMBED_EVENTS.credential, (event: Event) => {
      // D-API-75 备用通道 b:凭证只保留(值零回显零解析;默认路径 a 为主——
      // 引导配置另含题目上下文与 sessionApiOrigin,port 信封不携带)。
      this.#portCredential = (event as CustomEvent<PluginCredentialDetail>).detail.credential;
    });
    this.#handshake.start();

    // 3. 引导配置取回(并行;失败降级可重试)。
    void this.#fetchBootstrap();
    this.requestUpdate();
  }

  /** 引导配置取回端点解析:attribute / property 优先,全局配置其次。 */
  #resolveBootstrapEndpoint(): string | null {
    const local = this.bootstrapEndpoint.trim();
    if (local !== "") {
      return local;
    }
    const global = (globalThis as { PWN_MEMORY_VM_CONFIG?: PwnGlobalConfig }).PWN_MEMORY_VM_CONFIG
      ?.bootstrapEndpoint;
    if (typeof global === "string" && global.trim() !== "") {
      return global.trim();
    }
    return null;
  }

  async #fetchBootstrap(): Promise<void> {
    const esid = this.#esid;
    if (esid === null || this.#disposed) return;
    const endpoint = this.#resolveBootstrapEndpoint();
    if (endpoint === null) {
      this.#degrade("bootstrap-failed");
      this.requestUpdate();
      return;
    }
    const config = await fetchEmbedBootstrapConfig(endpoint, esid, {
      ...(this.fetchImpl !== null ? { fetchImpl: this.fetchImpl } : {}),
    });
    if (this.#disposed) return;
    if (config === null) {
      this.#degrade("bootstrap-failed");
    } else {
      this.#bootstrapConfig = config;
      if (this.#degraded === "bootstrap-failed") {
        this.#degraded = null;
      }
      void this.#tryStartSession();
    }
    this.requestUpdate();
  }

  #onReady(detail: PluginReadyDetail): void {
    this.#readySeen = true;
    if (this.#degraded === "handshake-timeout") {
      // 迟到的 ready 完成握手:清降级、回连接态(重试入口随之隐藏)。
      this.#degraded = null;
    }
    // 主题 / 语言接线位:ready.config 幂等应用(重放安全,§4.5)。
    this.#appearance.apply({ theme: detail.config.theme, language: detail.config.language });
    if (detail.grantedCapabilities.includes("auto_resize")) {
      this.#setupHeightReporter();
    } else {
      this.#teardownHeightReporter();
    }
    void this.#tryStartSession();
    this.requestUpdate();
  }

  /** create_session → connect → 工作区挂载(ready + 引导配置双就绪后执行)。 */
  async #tryStartSession(): Promise<void> {
    if (
      !this.#readySeen ||
      this.#bootstrapConfig === null ||
      this.#esid === null ||
      this.#client !== null ||
      this.#sessionStarting ||
      this.#disposed
    ) {
      return;
    }
    this.#sessionStarting = true;
    const config = this.#bootstrapConfig;
    let client: SessionClient | null = null;
    try {
      client = this.#createSessionClient({ baseUrl: config.sessionApiOrigin });
      // 冻结 SessionCommandRequest 载荷:题目上下文三方比对输入 + embed token
      // (embedSessionId = esid;身份零承载,凭证 Cookie 由响应 Set-Cookie 交付)。
      await client.createSession({
        challengeId: config.challengeId,
        challengeVersion: config.challengeVersion,
        embedSessionId: this.#esid,
        embedToken: config.embedToken,
      });
      client.connect();
      this.#client = client;
      this.#degraded = null;
    } catch {
      // 零反射面:失败细节不进 DOM(会话命令的 PublicError 呈现归开发壳形态;
      // 嵌入壳降级为静态文案,重试入口重建会话)。
      client?.dispose();
      this.#degrade("session-failed");
    } finally {
      this.#sessionStarting = false;
    }
    this.requestUpdate();
  }

  #createSessionClient(options: { baseUrl?: string }): SessionClient {
    if (this.createSessionClient !== null) {
      return this.createSessionClient(options);
    }
    return new SessionClient(options);
  }

  /** 工作区终态引导(工作区「新建会话」→ close + create 复用同一引导配置)。 */
  readonly #onNewSessionRequest = (): void => {
    void (async () => {
      if (this.#bootstrapConfig === null || this.#disposed) return;
      const old = this.#client;
      if (old !== null) {
        try {
          await old.closeSession();
        } catch {
          // 已终态 / 已关闭的 close 被拒:不阻塞新建(Q5 引导语义)。
        }
        old.dispose();
        this.#client = null;
      }
      this.#readySeen = true;
      await this.#tryStartSession();
    })();
  };

  /* ── 高度管道(仅 auto_resize 已授予时装配,§4.4)────────────────────── */

  #setupHeightReporter(): void {
    if (this.#heightReporter !== null || this.#disposed) return;
    let maxHeight = this.maxHeightPx;
    if (!Number.isInteger(maxHeight) || maxHeight < 1 || maxHeight > MAX_EMBED_HEIGHT_PX) {
      maxHeight = MAX_EMBED_HEIGHT_PX; // 属性面越界回落冻结常量(不放宽)。
    }
    this.#heightReporter = new HeightReporter({
      measure: this.measureHeight ?? (() => this.scrollHeight),
      send: (heightPx) => {
        this.#handshake?.sendHeightChanged(heightPx);
      },
      maxHeightPx: maxHeight,
      ...(this.frameScheduler !== null ? { frameScheduler: this.frameScheduler } : {}),
      onOversizeDrop: () => {
        this.#bumpLocalCounter("pwn-height-oversize");
      },
      onRateLimitDrop: () => {
        this.#bumpLocalCounter("pwn-height-rate-limit");
      },
    });
    // 内容高度变化驱动:ResizeObserver 可用则挂接(jsdom 无此全局,守卫跳过;
    // 测试经 notifyContentHeightChange() 手动驱动)。
    const observerCtor = (globalThis as { ResizeObserver?: new (cb: () => void) => ResizeObserverLike })
      .ResizeObserver;
    if (observerCtor !== undefined) {
      const observer = new observerCtor(() => {
        this.#heightReporter?.notifyContentHeightChange();
      });
      observer.observe(this);
      this.#resizeObserver = observer;
    }
    this.#heightReporter.notifyContentHeightChange();
  }

  /** 测试 / 宿主手动入口:通知内容高度变化(与 ResizeObserver 同管道)。 */
  notifyContentHeightChange(): void {
    this.#heightReporter?.notifyContentHeightChange();
  }

  #teardownHeightReporter(): void {
    this.#heightReporter?.dispose();
    this.#heightReporter = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  #bumpLocalCounter(key: string): void {
    this.#localCounters = { ...this.#localCounters, [key]: (this.#localCounters[key] ?? 0) + 1 };
  }

  /* ── 降级与重试(§4.3 / §4.5)────────────────────────────────────────── */

  #degrade(reason: PwnDegradedReason): void {
    this.#degraded = reason;
  }

  readonly #onRetryClick = (): void => {
    const reason = this.#degraded;
    if (reason === null || this.#disposed) return;
    if (reason === "handshake-timeout") {
      // 同会话重发(seq 递增,§4.5);迟到的 ready 到达即恢复。
      this.#degraded = null;
      this.#handshake?.retry();
    } else if (reason === "bootstrap-failed") {
      this.#degraded = null;
      void this.#fetchBootstrap();
    } else if (reason === "session-failed") {
      this.#degraded = null;
      const old = this.#client;
      if (old !== null) {
        old.dispose();
        this.#client = null;
      }
      void this.#tryStartSession();
    }
    // esid-missing 无重试入口(按钮不渲染)。
    this.requestUpdate();
  };

  /* ── 外观落地面(WP-53 接线位)────────────────────────────────────────── */

  #applyAppearanceToHost(snapshot: EmbedAppearanceSnapshot): void {
    // 二值解析结果落 attribute 与 color-scheme(功能对比度层面;主题双套变量
    // 归 WP-53 在此锚点上增量)。三值状态经 appearanceSnapshot 可读。
    this.setAttribute("data-sm-theme", snapshot.resolvedTheme);
    this.setAttribute("data-sm-language", snapshot.language);
    this.style.colorScheme = snapshot.resolvedTheme;
  }

  /* ── 释放 ───────────────────────────────────────────────────────────── */

  #teardown(): void {
    this.#disposed = true;
    this.#teardownHeightReporter();
    this.#handshake?.dispose();
    this.#handshake = null;
    this.#client?.dispose();
    this.#client = null;
    this.#appearanceDisposer?.();
    this.#appearanceDisposer = null;
    this.#appearance.dispose();
  }

  /* ── 渲染 ───────────────────────────────────────────────────────────── */

  protected override render(): unknown {
    const degraded = this.#degraded;
    if (degraded !== null) {
      const retryable = degraded !== "esid-missing";
      return html`
        <div class="degraded" data-testid="pwn-degraded" data-pwn-reason=${degraded}>
          <p role="status" data-testid="pwn-status">${DEGRADED_TEXTS[degraded]}</p>
          ${retryable
            ? html`<button
                type="button"
                class="retry"
                data-testid="pwn-retry-button"
                @click=${this.#onRetryClick}
              >
                重试
              </button>`
            : nothing}
        </div>
      `;
    }
    if (this.#client !== null) {
      return html`
        <div class="workspace-slot" data-testid="pwn-workspace">
          <sm-workspace
            ${ref(this.#workspaceRef)}
            .client=${this.#client}
            @new-session-request=${this.#onNewSessionRequest}
          ></sm-workspace>
        </div>
      `;
    }
    return html`<p class="status" role="status" data-testid="pwn-status">${CONNECTING_TEXT}</p>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pwn-memory-vm": PwnMemoryVm;
  }
}
