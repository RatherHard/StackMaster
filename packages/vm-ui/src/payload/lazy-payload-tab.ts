/**
 * <sm-payload-tab-host> —— Payload 窗口的**惰性宿主**(WP-83;主控 2026-09-17 派单实施)。
 *
 * ── 存在理由(体积归因实测)────────────────────────────────────────────────
 *
 * `<sm-payload-tab>` 及其编译链(`compiler/blocks` / `compiler/compile`)静态
 * import `blockly`(含 `blockly_compressed.js`),而窗口集是**常驻**的
 * (D-MP-1:10 类窗口各恰一实例、无关闭入口)⇒ 桌面板结构性进入主 chunk。
 * 实测:`blockly` + `@blockly/*` 占主 chunk **903.56 kB raw / 215.57 kB gzip**
 * (拆分前主 chunk = 1,379.02 kB / 336.36 kB gzip)。
 *
 * ── 边界形态(为什么是「宿主 + 动态 import」而不是改组件内部)─────────────
 *
 *  - 本宿主是 workspace 唯一消费面的**透传壳**:workspace 只经 duck-typing
 *    契约触达内容元素(`dataSource` / `actionSink` / `refresh` /
 *    `breakpointAddresses` / `stepOnce` + 两个 payload 事件),故惰性化只需
 *    一个壳,不必把 `<sm-payload-tab>` 的首帧 Blockly inject 改成 async
 *    (后者要动 payload 内部,行为面风险更高);
 *  - 触发点 = 宿主**首次连接**(工作区在首帧前建窗即连接):Blockly 的
 *    下载 / 解析 / 求值与其**同步 inject** 都离开启动路径 ⇒ 首屏可交互时间
 *    不再等 904 kB 的引擎;真正的按需触发(视口进入 / 首次交互)是后续可
 *    叠加的增量,本波次不做(会改变「常驻窗口内容恒在场」的既有语义);
 *  - **light DOM**(`createRenderRoot()` 返回宿主自身):与 payload 页画布
 *    宿主同因 —— Blockly 几何依赖 light 树。
 *
 * ── 行为等价性(逐条对齐)──────────────────────────────────────────────────
 *
 *  - `dataSource` / `actionSink` / `authorBlocks`(M10/WP-80 出题者积木声明面)
 *    为**转发访问器**:赋值即透传给真组件(`#rebindContents` / `#bindActionSink`
 *    的 duck-typing 探测 `in` 命中);
 *  - `refresh()`(投影更新约定)/ `breakpointAddresses()`(断点积木并入面)/
 *    `stepOnce()`(菜单「积木步进」)全量转发;
 *  - `renderRoot` 由 Lit 正常赋值 ⇒ 工作区 `#refreshContents` 的
 *    「未首渲染则延后」判定与惰性化前一致;
 *  - 真组件就绪后**立即 `refresh()`** ⇒ 复现「挂载即编译」并广播
 *    `payload-breakpoints-changed`(WP-76 断点并入的既有触发点之一);
 *    `payload-breakpoints-changed` / `payload-client-pause` 均为
 *    `bubbles + composed` 且由真组件自身派发 ⇒ 经宿主原样冒泡到工作区,
 *    宿主**不复制、不改写**事件;
 *  - 真组件实例在宿主 `disconnectedCallback` 时移除并释放(与惰性化前
 *    「窗口内容随工作区断开」同义)。
 *
 * 差异(如实登记,见 WP-83 报告 §判定):内容元素**创建时刻**由同步变为
 * 「动态 import 就绪后」⇒ 依赖「连接后同步存在 `<sm-payload-tab>`」的既有
 * 测试改用 `whenReady()` 就绪钩子;用户可见面不变(窗口内容仍在首次挂载后
 * 立即出现,首帧不等 Blockly)。
 */
import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

import type { MemoryDataSource } from "../datasource/types.js";
import type { PayloadAuthorBlockDecl } from "./compiler/blocks.js";
import type { PayloadActionSink } from "./executor.js";
import type { SmPayloadTab } from "./sm-payload-tab.js";

/** 真组件的 duck-typing 面(类型仅编译期:零运行时 import 边)。 */
type PayloadTabLike = SmPayloadTab;

@customElement("sm-payload-tab-host")
export class SmPayloadTabHost extends LitElement {
  #dataSource: MemoryDataSource | null = null;
  #actionSink: PayloadActionSink | null = null;
  #authorBlocks: readonly PayloadAuthorBlockDecl[] | null = null;
  #inner: PayloadTabLike | null = null;
  #ready: Promise<PayloadTabLike> | null = null;

  /** 数据源(转发访问器;`#rebindContents` 换绑即透传)。 */
  get dataSource(): MemoryDataSource | null {
    return this.#dataSource;
  }

  set dataSource(value: MemoryDataSource | null) {
    this.#dataSource = value;
    if (this.#inner !== null) {
      this.#inner.dataSource = value;
    }
  }

  /** 会话客户端(转发访问器;`#bindActionSink` 换绑即透传)。 */
  get actionSink(): PayloadActionSink | null {
    return this.#actionSink;
  }

  set actionSink(value: PayloadActionSink | null) {
    this.#actionSink = value;
    if (this.#inner !== null) {
      this.#inner.actionSink = value;
    }
  }

  /**
   * M10/WP-80:出题者积木声明面(转发访问器;工作区组合根按 duck-typing
   * `authorBlocks` 注入 ⇒ 宿主必须在场,否则真组件拿不到声明集)。
   * 缺省 null / 空数组 = 题目未声明模板(工具箱与既有一字不差)。
   */
  get authorBlocks(): readonly PayloadAuthorBlockDecl[] | null {
    return this.#authorBlocks;
  }

  set authorBlocks(value: readonly PayloadAuthorBlockDecl[] | null) {
    this.#authorBlocks = value;
    if (this.#inner !== null) {
      this.#inner.authorBlocks = value;
    }
  }

  /** 已就绪的真组件(null = 引擎尚未取回)。 */
  get payloadTab(): PayloadTabLike | null {
    return this.#inner;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    // Blockly 需要 light 树几何(与 payload 页画布宿主同因)。
    return this;
  }

  protected override render(): unknown {
    return html``;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.whenReady();
  }

  override disconnectedCallback(): void {
    this.#inner?.remove();
    this.#inner = null;
    this.#ready = null;
    super.disconnectedCallback();
  }

  /**
   * 真组件就绪(惰性 `import()` + 创建 + 属性透传 + 首次编译)。
   * 同一实例只加载一次;`connectedCallback` 与读侧(`refresh()`)共用本入口。
   */
  async whenReady(): Promise<PayloadTabLike> {
    this.#ready ??= (async (): Promise<PayloadTabLike> => {
      await import("./sm-payload-tab.js");
      const inner = document.createElement("sm-payload-tab") as PayloadTabLike;
      inner.dataSource = this.#dataSource;
      inner.actionSink = this.#actionSink;
      inner.authorBlocks = this.#authorBlocks;
      this.#inner = inner;
      this.appendChild(inner);
      // 复现「挂载即编译」:发射 payload-breakpoints-changed(WP-76 并入触发点)。
      inner.refresh();
      return inner;
    })();
    return this.#ready;
  }

  /** 投影更新约定(工作区接线);未就绪则触发加载(编译在就绪后立即补做)。 */
  refresh(): void {
    if (this.#inner !== null) {
      this.#inner.refresh();
      return;
    }
    void this.whenReady();
  }

  /** 断点积木地址集(工作区 `#mergePayloadBreakpoints` 的读面)。 */
  breakpointAddresses(): readonly string[] {
    return this.#inner?.breakpointAddresses() ?? [];
  }

  /** 菜单「积木步进」落点(`#stepFocusedPayload`);未就绪 = 防御性 no-op。 */
  stepOnce(): void {
    this.#inner?.stepOnce();
  }
}
