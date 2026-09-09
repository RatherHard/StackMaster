import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 进程级集成测试 spawn 真实 vm-worker(装载 + 执行全链路),
    // 首次构建二进制可能较慢。
    testTimeout: 120_000,
  },
});
