/**
 * 临时旁路配置(不入库;本轮真机 IT 取证用):与 `vitest.config.ts` 同形,
 * 仅去掉 `globalSetup`(该 setup 会 `docker compose -f compose/deps.yaml up`,
 * 而本机运行中的 `compose:app:up` 拓扑已占用 15432/16379/19000 ⇒ 必红)。
 * test/debug 的真机 IT 只用内存存储 + 真实 vm-worker 二进制,不依赖 deps 容器。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    environment: "node",
    include: ["test/debug/**/*.test.ts", "test/scan/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
