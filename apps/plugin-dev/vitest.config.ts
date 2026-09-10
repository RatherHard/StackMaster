import { defineConfig } from "vitest/config";

/** 开发壳冒烟测试环境:jsdom(锁 devDep jsdom);挂载逻辑无布局依赖。 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
