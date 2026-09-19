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
 * 解析结果落 host 元素 `data-sm-theme` / `data-sm-language` 与 `color-scheme`;
 * 三值状态与语言字符串经 `appearanceSnapshot` 可读。主题双套变量与 i18n 抽取
 * 面归 WP-53,在本接口上增量。
 *
 * M1 `terminal` 承载增量(WP-73 / D-MP-2;嵌入协议零改动):`terminal` 不经
 * 冻结协议传达,而由宿主元素上的 `data-sm-theme="terminal"` 扩展锚承载
 * (插件文档页预置 / 集成方直接设置)。
 *
 * **2026-09-18 UI 改版(D-UI-6 单主题收敛)**:`light` / `dark` / `auto` 三预设
 * 退役,本元素的落锚恒为 `SM_TERMINAL_THEME_VALUE`、`color-scheme` 恒 `dark`,
 * 不再消费 `resolvedTheme` 做分支;原「外部锚优先 / 锚变更观察」(WP-73)随三值
 * 判别对象一并退场(详见 `#applyAppearanceToHost`)。协议三值仍由状态面保持
 * (`appearanceSnapshot.theme` = 宿主下发原值)——**退役的是视觉分支,不是协议
 * 值域**;`EMBED_THEMES` 的物理退场属 WP-96。
 *
 * M2 描述包正式下发接入(WP-54 增量面):引导配置就绪即并行获取公开描述包
 * (`fetchChallengeDescriptor`,GET /descriptors/:challengeId/:version;哈希 +
 * 尺寸护栏双闸的客户端侧),**不阻塞 workspace 就绪**——hintLadder /
 * publicErrorMapping / 静态面 / debugMode 门控晚到即注入,加载失败 → 缺席
 * 明示(会话不受影响,零降级、零重试风暴)。FE-ED-06 / FE-ED-07 自此由正式
 * 下发通道驱动(夹具注入通道保留于 plugin-dev 开发壳的开发态)。
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
  challengeStaticFace,
  fetchChallengeDescriptor,
  type ChallengeDescriptorView,
  type ChallengeStaticFace,
  type WorkspaceDescriptorStatus,
} from "@stackmaster/vm-ui";
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
import { SessionClient, SM_TERMINAL_THEME_VALUE, SM_THEME_ATTRIBUTE, SmWorkspace } from "@stackmaster/vm-ui";

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

  /**
   * 描述包获取 origin(WP-54;缺省空 = 复用引导配置的 `sessionApiOrigin`)。
   * 部署可经 attribute 指向独立源(如 dev 壳的反代同源形态)。
   */
  @property({ type: String, attribute: "descriptor-origin" })
  descriptorOrigin = "";

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

  /**
   * matchMedia 注入(**单主题下不再消费**;D-UI-6 收敛:系统跟随分支随
   * `auto` 退役)。属性面保留的理由 = 改动最小 —— 它与 `EmbedAppearanceOptions
   * .matchMedia` 同属测试接缝面,删除会牵连 `pwn-memory-vm.ts` /
   * `appearance.ts` 的接缝断言;保留则零行为、零风险(注入假体也不再被读)。
   */
  @property({ attribute: false })
  matchMediaImpl: ((query: string) => MediaQueryLike | null) | null = null;

  /**
   * SHA-256 摘要注入(描述包完整性闸;默认 WebCrypto subtle——真实浏览器
   * 全局可用,jsdom 测试注入 Node webcrypto 同语义实现)。
   */
  @property({ attribute: false })
  sha256Hex: ((bytes: Uint8Array) => Promise<string>) | null = null;

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
  // WP-73 的 `#anchorObserver` / `#lastAnchoredTheme` 随 D-UI-6 单主题收敛删除
  // (理由见 `#applyAppearanceToHost` 之后的注释块)。

  // M2 描述包接入状态(WP-54;晚到注入,变更点手动 requestUpdate)。
  #descriptorView: ChallengeDescriptorView | null = null;
  #descriptorStatic: ChallengeStaticFace | null = null;
  #descriptorStatus: WorkspaceDescriptorStatus = "loading";

  static override styles = css`
    /* 整页布局定高链的**宿主段**(D-API-153 第 6 项:整页布局 = 顶层页面
       100dvh + 左半侧内部滚动)。本元素是嵌入形态下工作区的宿主:
       :host 给 100dvh 后,工作区 sm-workspace 的「block-size: 100%」有链可依
       (iframe 文档视口 = iframe 框高),无需宿主上报高度 / 无需
       height_changed / auto_resize(两者属退役面)。

       **遗留 #37 的载体消解**:#37 = 「宿主未给工作区定高 ⇒ 条带自身纵向滚动
       在两种已发布形态下都不会出现」。整页布局下「宿主给定高」这一前提不再
       必要(工作区自身即 100dvh),但宿主仍保留一条定高链,使 iframe 形态下
       工作区恰为视口高、内部滚动真正生效。

       主题单值化(D-UI-6):退役的浅色字面量(canvas / canvastext)换成终端
       等价;回退值均为**终端值**(token 缺失也回落成终端,不回落成浅色 ——
       见 packages/vm-ui/src/theme/theme-tokens.ts「回退值纪律」)。
       注意:本注释块位于 CSS 模板字面量内,一律不写反引号(TS scanner 会把
       反引号当模板定界符 ⇒ 整文件解析崩塌)。 */
    :host {
      display: block;
      block-size: 100dvh;
      min-block-size: 0;
      background: var(--sm-bg-base, #0b0f0b);
      color: var(--sm-fg, #b9ffc4);
    }

    .status {
      margin: 0;
      padding: 1rem;
      font: system-ui 0.875rem sans-serif;
      color: var(--sm-fg-dim, #6dd47f);
    }

    .degraded {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 1rem;
      border: 1px solid var(--sm-border, rgb(125 255 156 / 28%));
      border-radius: 8px;
      background: var(--sm-bg-panel, #101610);
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

    /* 定高链中段(宿主 → 工作区):原固定「min-block-size: 16rem」与「压缩以
       适配」一并退场(D-UI-153),改为「block-size: 100%」透传 :host 的定高;
       「min-block-size: 0」松开 grid / flex 子项的最小内容高,否则内容仍会把
       工作区撑到内容高、内部滚动容器退化为不可滚(遗留 #37 的失败模式)。
       (本注释在 CSS 模板字面量内,不写反引号。) */
    .workspace-slot {
      display: block;
      block-size: 100%;
      min-block-size: 0;
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

  /** 描述包接入状态(WP-54 诊断 / 测试锚;loading → loaded | absent)。 */
  get descriptorStatus(): WorkspaceDescriptorStatus {
    return this.#descriptorStatus;
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
    // 原 `#anchorObserver?.disconnect()` 随观察器一并删除(D-UI-6 单主题;
    // 此处已无属性观察面可断开)。
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
      // M2 描述包获取(与 create_session 并行;不阻塞 workspace 就绪)。
      void this.#loadDescriptor(config);
      void this.#tryStartSession();
    }
    this.requestUpdate();
  }

  /**
   * 描述包正式下发获取(WP-54):challengeId / version / origin 来自引导配置
   * (descriptor-origin attribute 可覆盖 origin)。成功 → hintLadder /
   * publicErrorMapping / 静态面 / debugMode 门控注入 workspace;失败 → 缺席
   * 明示(会话不受影响、零中断,失败细节不进 DOM)。无重试入口(网络失败
   * 的至多一次重试在加载器内;缺席明示为终态,重载 iframe 重新走管线)。
   */
  async #loadDescriptor(config: EmbedBootstrapConfig): Promise<void> {
    const origin = this.descriptorOrigin.trim() !== "" ? this.descriptorOrigin.trim() : config.sessionApiOrigin;
    const outcome = await fetchChallengeDescriptor({
      sessionApiOrigin: origin,
      challengeId: config.challengeId,
      challengeVersion: config.challengeVersion,
      ...(this.fetchImpl !== null ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.sha256Hex !== null ? { sha256Hex: this.sha256Hex } : {}),
    });
    if (this.#disposed) return;
    if (outcome.ok) {
      this.#descriptorView = outcome.descriptor;
      this.#descriptorStatic = challengeStaticFace(outcome.descriptor);
      this.#descriptorStatus = "loaded";
    } else {
      this.#descriptorView = null;
      this.#descriptorStatic = null;
      this.#descriptorStatus = "absent";
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

  /* ── 外观落地面(WP-53 接线位;2026-09-18 单主题收敛 D-UI-6)───────────── */

  /**
   * 外观落锚(元素 `data-sm-theme` / `data-sm-language` / `color-scheme` 的
   * 唯一写面;单主题形态):
   *  - **锚恒为终端值**:`light` / `dark` / `auto` 于 2026-09-18(D-UI-6)退役,
   *    故本处不再按 `snapshot.resolvedTheme` 分支,只写
   *    `SM_TERMINAL_THEME_VALUE`;
   *  - `color-scheme` 仍读 `snapshot.resolvedTheme`(**单一来源** =
   *    `EmbedAppearanceController#resolveTheme()`,单主题下恒 `"dark"`;
   *    终端属暗族,系统色控件不自相矛盾)—— 不在此处另写一份字面分支,避免
   *    「两处各自漂移」(本仓既有失败模式);
   *  - 外部锚语义因此**不再需要区分**:单主题下插件自身与外部写入的都是
   *    terminal,原「外部 terminal 锚优先 / 不夺锚」分支失去判别对象,整条退场;
   *  - 协议三值仍被 **状态面**保持(`appearanceSnapshot.theme` = 宿主下发原值,
   *    见 `EmbedAppearanceController`):退役的是**视觉分支**,不是协议值域,
   *    嵌入协议面(含 `EMBED_THEMES`)整体退役属 WP-96;
   *  - 语言面不受主题收敛影响(`data-sm-language` 照旧)。
   */
  #applyAppearanceToHost(snapshot: EmbedAppearanceSnapshot): void {
    this.setAttribute(SM_THEME_ATTRIBUTE, SM_TERMINAL_THEME_VALUE);
    this.setAttribute("data-sm-language", snapshot.language);
    this.style.colorScheme = snapshot.resolvedTheme;
  }

  /*
   * 原 `#observeAnchor()`(WP-73 外部锚观察 + 自身落锚回环过滤)整条删除
   * (2026-09-18,D-UI-6 单主题收敛):
   *
   * 该观察器的唯一职责是「外部把锚改成 terminal → 立即重新应用;锚被移除 →
   * 交还插件控制」。单主题下插件每次都写 terminal ⇒ ⓐ「外部 terminal 锚优先」
   * 无判别对象(外部写的与插件写的同值);ⓑ「锚被移除即交还」也无判别对象
   * (交还后插件写的仍是 terminal,幂等于不移除);ⓒ 锚值域只剩一个值 ⇒ 该
   * 观察器只剩「外部删锚后无意义地写回同值」的冗余功能,属纯噪音。故连
   * `#anchorObserver` / `#lastAnchoredTheme` 字段与 `disconnectedCallback` 里的
   * 断开清理一并删除,不留死代码。
   *
   * 安全性:删观察器**不削弱单主题保证** —— `:root` 级缺省已使「未设锚 = 终端」
   * (`packages/vm-ui/src/theme/theme-tokens.ts`「锚策略」段:变量落在 html 上
   * 沿树继承穿透 shadow DOM),显式锚只作同值兜底。
   */

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
            .challengeDescriptor=${this.#descriptorView === null
              ? null
              : {
                  hintLadder: this.#descriptorView.hintLadder,
                  publicErrorMapping: this.#descriptorView.publicErrorMapping,
                }}
            .challengeStatic=${this.#descriptorStatic}
            .descriptorStatus=${this.#descriptorStatus}
            .debugModeAvailable=${this.#descriptorView?.debugMode === true}
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
