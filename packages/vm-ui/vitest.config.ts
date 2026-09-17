import { defineConfig } from "vitest/config";

/**
 * 组件测试环境:jsdom(锁 devDep jsdom)。
 *
 * jsdom 没有布局引擎,ResizeObserver / 元素尺寸由 test/setup.ts 桩补齐;
 * lit-virtualizer × Lit 3 的兼容冒烟依赖该桩完成首屏可见范围计算。
 */
export default defineConfig({
  test: {
    // CI 下追加 github-actions reporter:失败用例发 `::error` 注解,使 CI 红点
    // **免凭证**即可逐用例读出(缘由与边界见 .github/workflows/ci.yml 同名说明)。
    // 本地无 CI 变量时维持 default ⇒ 输出零变化。
    reporters: process.env["CI"] ? ["default", "github-actions"] : ["default"],
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
