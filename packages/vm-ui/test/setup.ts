/**
 * jsdom 测试环境补齐(WP-F1;jsdom 无布局引擎)。
 *
 * - ResizeObserver:lit-virtualizer 的可见范围计算依赖它;桩在 observe 时
 *   异步报告固定视口尺寸(300×300),让虚拟列表在 jsdom 下完成首屏计算。
 * - Element.prototype.getBoundingClientRect:统一返回 300×300 包围盒,
 *   供 virtualizer / 组件的几何读取路径使用。
 * - requestAnimationFrame:vitest jsdom 环境通常已提供(pretendToBeVisual),
 *   此处仅兜底,防止环境差异导致组件帧驱动逻辑失效。
 */
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
