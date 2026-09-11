import { defineConfig } from "vitest/config";

/**
 * SDK 测试环境:jsdom(锁 devDep jsdom)——宿主侧 postMessage 通道语义
 * (MessageEvent.origin / source)在 jsdom 下可构造;时钟 / 随机源 /
 * MessageChannel 全部经构造选项注入(测试确定性纪律,参照 session-api
 * 时钟注入先例),jsdom 只承担事件对象与 EventTarget 形态。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
