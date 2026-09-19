import { defineConfig } from "vitest/config";

/**
 * page-app 单测环境:jsdom(挂载 / 路径解析 / 代理回执都需要 DOM)。
 *
 * 测试范围**只到 vm-ui 产物边界**:vm-ui 由运行期 URL 加载(apps 与浏览器可达
 * 包之间没有依赖边,见 `vite.config.ts` 文件头),故单测一律注入替身模块;
 * 「真产物 + 真浏览器」的验证归 `e2e/page-app.spec.ts`。
 */
export default defineConfig({
  test: {
    reporters: process.env["CI"] ? ["default", "github-actions"] : ["default"],
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
