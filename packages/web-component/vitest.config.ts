import { defineConfig } from "vitest/config";

/** 组件测试环境:jsdom(锁 devDep jsdom);占位组件渲染冒烟无布局依赖。 */
export default defineConfig({
  test: {
    reporters: process.env["CI"] ? ["default", "github-actions"] : ["default"],
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
