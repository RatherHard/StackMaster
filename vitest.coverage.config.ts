/**
 * 根级覆盖率入口(阶段三 WP-8;质量门禁 3:TS 侧整体覆盖率 ≥ 80%)。
 *
 * 形态:vitest projects(root)聚合 packages/* 与 apps/* 的既有测试配置
 * (各包 vitest.config.ts 照常生效),coverage 在根级统一收集——一个报告
 * 覆盖 apps + packages 全部 TS 源码,门槛按整体(≥ 80%,四维)判定。
 *
 * 命名纪律:文件名**不取** `vitest.config.ts`——vitest 会上溯查找配置,
 * 包级 `vitest run`(cwd = 各包)会误读本文件并把 projects 解析到包目录
 * ("No projects were found")。专用文件名 + 显式 --config 根除该耦合;
 * `pnpm test`(turbo 逐包)不变,本入口只服务覆盖率证据。
 *
 * 用法:
 *  - 完整门禁形态 = `SESSION_API_IT=1 pnpm test:coverage`:纳入容器门控
 *    集成测试——runtime / 持久化装配面的覆盖来自真实容器路径(实测整体
 *    statements 88.71 / branches 81.23 / functions 89.78 / lines 88.68);
 *  - unit-only 跑法(无 IT 前缀)branches ≈ 79.1%(装配面未覆盖),差于
 *    门槛——如实记录,不作门禁形态;
 *  - 脚本同时携带 `--coverage` CLI 旗标:projects 形态下仅靠配置内
 *    `coverage.enabled` 不触发覆盖率收集(实测),以 CLI 旗标为准。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
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
