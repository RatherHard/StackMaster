import { defineConfig } from "vitest/config";

/**
 * 组件测试环境:jsdom(锁 devDep jsdom)。
 *
 * jsdom 没有布局引擎,ResizeObserver / 元素尺寸由 test/setup.ts 桩补齐;
 * lit-virtualizer × Lit 3 的兼容冒烟依赖该桩完成首屏可见范围计算。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
