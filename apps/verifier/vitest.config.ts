import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // verify 客户端的进程级用例(spawn 假 worker 协议往返)为真实进程链路。
    testTimeout: 15_000,
    // 容器门控集成测试的依赖服务生命周期(仅 SESSION_API_IT=1 时执行
    // docker compose up --wait / down;单元测试运行为空操作)。
    globalSetup: ["test/helpers/compose-lifecycle.ts"],
    globalSetupTimeout: 300_000,
  },
});
