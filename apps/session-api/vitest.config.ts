import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 集成测试 spawn 真实进程(dist/index.js)走启动 → 健康检查 → 优雅停机全链路。
    testTimeout: 30_000,
    // WP-3 持久化面:容器门控集成测试的依赖服务生命周期(仅 SESSION_API_IT=1
    // 时执行 docker compose up --wait / down;单元测试运行为空操作)。
    globalSetup: ["test/persistence/compose-lifecycle.ts"],
    globalSetupTimeout: 300_000,
  },
});
