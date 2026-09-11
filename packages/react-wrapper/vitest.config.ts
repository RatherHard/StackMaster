import { defineConfig } from "vitest/config";

/**
 * 组件测试环境:jsdom(锁 devDep jsdom)。渲染 → 握手模拟 → 事件回调断言
 * 全部走真实 DOM iframe(jsdom contentWindow)与注入式 message 事件;
 * 握手超时(10 s 真实定时器)不会在同步断言窗口内触发,无需假钟。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.tsx", "src/**/*.ts"],
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
