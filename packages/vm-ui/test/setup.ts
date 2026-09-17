/**
 * jsdom 测试环境补齐(WP-F1;jsdom 无布局引擎)。
 *
 * - ResizeObserver:lit-virtualizer 的可见范围计算依赖它;桩在 observe 时
 *   异步报告固定视口尺寸(300×300),让虚拟列表在 jsdom 下完成首屏计算。
 * - Element.prototype.getBoundingClientRect:统一返回 300×300 包围盒,
 *   供 virtualizer / 组件的几何读取路径使用。
 * - requestAnimationFrame:vitest jsdom 环境通常已提供(pretendToBeVisual),
 *   此处仅兜底,防止环境差异导致组件帧驱动逻辑失效。
 * - Blockly `genUid()` 确定性化:见下方 §Blockly id 注入(实测根因,非风格偏好)。
 */
import * as Blockly from "blockly";
import { vi } from "vitest";

/** 桩报告的固定视口尺寸(宽高一致,断言只关心"渲染出了少量行")。 */
const MOCK_VIEWPORT_SIZE = 300;

/** 构造固定尺寸的观察 entry(jsdom 无布局,全部按视口桩尺寸报告)。 */
function entryFor(target: Element): ResizeObserverEntry {
  const contentRect = {
    width: MOCK_VIEWPORT_SIZE,
    height: MOCK_VIEWPORT_SIZE,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: MOCK_VIEWPORT_SIZE,
    bottom: MOCK_VIEWPORT_SIZE,
    toJSON: () => ({}),
  };
  const boxSize = [{ inlineSize: MOCK_VIEWPORT_SIZE, blockSize: MOCK_VIEWPORT_SIZE }];
  return {
    target,
    contentRect,
    borderBoxSize: boxSize,
    contentBoxSize: boxSize,
    devicePixelContentBoxSize: boxSize,
  } as unknown as ResizeObserverEntry;
}

/** ResizeObserver 桩:每个目标仅在开始观察时回调一次(与真实观察者语义
 *  一致;若每次 observe 都回调,virtualizer 的重渲染再观察路径会形成无限
 *  微任务循环,进程假死)。 */
class MockResizeObserver implements ResizeObserver {
  private readonly observed = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    if (this.observed.has(target)) {
      return;
    }
    this.observed.add(target);
    queueMicrotask(() => {
      if (this.observed.has(target)) {
        this.callback([entryFor(target)], this as unknown as ResizeObserver);
      }
    });
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

vi.stubGlobal("ResizeObserver", MockResizeObserver);

// jsdom 无布局:给所有元素一个非零包围盒(virtualizer 几何路径依赖)。
const stubRect = (): DOMRect =>
  ({
    width: MOCK_VIEWPORT_SIZE,
    height: MOCK_VIEWPORT_SIZE,
    top: 0,
    left: 0,
    right: MOCK_VIEWPORT_SIZE,
    bottom: MOCK_VIEWPORT_SIZE,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  writable: true,
  value: stubRect,
});

// requestAnimationFrame 兜底(vitest jsdom 环境一般自带)。
if (typeof globalThis.requestAnimationFrame === "undefined") {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    return setTimeout(() => callback(performance.now()), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
    clearTimeout(handle);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * §Blockly id 注入(测试环境确定性化)
 *
 * 实测根因(判据链,测试侧复现与护栏见
 * test/payload/blockly-id-css-safety.test.ts):
 *   1. Blockly 13.2.1 `genUid()` 从 88 字符汤(26 个符号 `!#$%()*+,-./:;=?@[]^_`{|}~`
 *      + 62 个字母数字)随机取 20 位;实现 `Mb={genUid:()=>{…charAt(Math.random()*88)}}`。
 *   2. 该 id 落在 Blockly 画布根 `<g class="blocklyWorkspace" role="region">` 上。
 *      `role="region"` 是地标 ⇒ axe 的 `landmark-unique` 会为它生成选择器。
 *   3. axe-core 4.13.0 `getElmId()`(axe.js:11048)执行 `doc.querySelectorAll('#' +
 *      CSS.escape(id))` 探测唯一性;jsdom 30.0.1 的选择器引擎
 *      @asamuzakjp/dom-selector@8.3.2 在 `parseSelector()`(parser.js:191)用
 *      `/^$|^\s*>|,\s*$/` 判「尾部逗号的选择器列表」,把**以逗号结尾的 id**
 *      (转义后仍以 `\,` 结尾)误判为非法并抛
 *      `SyntaxError: Invalid selector #…\,`,整个 axe.run 崩掉。
 *   4. 该缺陷在 dom-selector 9.1.4(当前最新)仍在;jsdom 声明 `^8.3.0`,
 *      8.3.2 即 8.x 末版 ⇒ 版本覆盖(pnpm.overrides)无解。
 *   5. P(20 位随机 id 以逗号结尾) = 1/88 ≈ 1.14% ⇒ 约每百次挂载抖一次。
 *
 * 处置:经 Blockly **自己的测试接缝** `utils.idGenerator.TEST_ONLY.genUid`
 * (core/utils/idgenerator.d.ts:6-14 公开声明;公开 `genUid()` 的实现就是
 * `return TEST_ONLY.genUid()`,故覆写该属性即全局生效——实测已确认)注入
 * 确定性且符合 DOM id 字符口径的生成器。仅影响测试环境的 id 取值,不改产品
 * 代码、不改任何断言语义(严格说还消除了「同一用例两次运行 DOM 不同」的噪声)。
 *
 * 若接缝消失(Blockly 变更),这里**直接抛错**:宁可整套测试显式红,也不许
 * 悄悄退回 1.14% 抖动。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 注入生成器的 id 前缀(与测试文件的 INJECTED_UID_PATTERN 同口径)。 */
const INJECTED_UID_PREFIX = "sm-blockly-uid-";

type BlocklyIdGeneratorSeam = {
  genUid: () => string;
  TEST_ONLY: { genUid: () => string };
};

let injectedUidCounter = 0;

function installDeterministicBlocklyIds(): void {
  const idGenerator = Blockly.utils.idGenerator as unknown as
    | BlocklyIdGeneratorSeam
    | undefined;
  const testOnly = idGenerator?.TEST_ONLY;
  if (idGenerator === undefined || typeof testOnly?.genUid !== "function") {
    throw new Error(
      "Blockly 测试接缝 utils.idGenerator.TEST_ONLY.genUid 不可用;" +
        "本仓库依赖它注入确定性 id 以规避 jsdom 选择器引擎对「逗号结尾 id」的崩溃" +
        "(原因详见 test/setup.ts §Blockly id 注入)。请改用新的等价接缝," +
        "不要直接删除注入(否则 axe 用例会退回约 1.14% 的随机抖动)。",
    );
  }
  testOnly.genUid = (): string => {
    injectedUidCounter += 1;
    return `${INJECTED_UID_PREFIX}${injectedUidCounter.toString(36)}`;
  };
  // 生效自检:公开 genUid 必须立刻读到注入值(防「改了不生效」的静默回退)。
  const probe = idGenerator.genUid();
  if (!probe.startsWith(INJECTED_UID_PREFIX)) {
    throw new Error(
      `Blockly id 注入未生效:utils.idGenerator.genUid() 返回 ${JSON.stringify(probe)}。` +
        "注入点已失效,axe 用例将退回随机抖动,请修好注入再跑测试。",
    );
  }
}

installDeterministicBlocklyIds();

