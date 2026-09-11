// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint 9 flat config(WP-0 基线)。
 *
 * 基线采用 typescript-eslint 推荐规则(非类型感知),聚焦正确性与可读性;
 * 引擎确定性 lint、浏览器产物隔离扫描等专项规则随对应 WP 落地(质量门禁见 CLAUDE.md)。
 *
 * 从仓库根目录运行:`pnpm lint`
 * (等价于 `eslint --config tooling/eslint.config.mjs packages`)。
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/*.cjs"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // TypeScript 类型系统已覆盖未定义变量检查,typescript-eslint 官方建议关闭
      "no-undef": "off",
    },
  },
  {
    // 测试期假 worker(独立 Node 脚本,spawn 直启,不经 TS 编译)。
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    // 宿主模拟页浏览器脚本(WP-51 联调面;dev-only,不经打包器,以 ES module
    // 直接加载——浏览器全局在此声明,与下方 k6 / mjs 分段同先例)。
    files: ["apps/plugin-dev/host-mock/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        URL: "readonly",
        crypto: "readonly",
        console: "readonly",
      },
    },
  },
  {
    // 宿主模拟页 / 插件站点 dev 脚本(WP-51/52 联调面;Node 侧零依赖脚本)。
    // smoke-embed.mjs 的 page.waitForFunction / evaluate 回调运行于浏览器上下文,
    // 故一并声明 window / document(声明过剩对纯 Node 脚本无害)。
    files: ["apps/plugin-dev/host-mock/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        fetch: "readonly",
        window: "readonly",
        document: "readonly",
      },
    },
  },
  {
    // k6 压测场景与运行器(阶段三 WP-8;k6 运行时全局 + Node 全局,
    // 独立脚本不经 TS 编译;docs/develop/权威API语义规约.md D-API-73)。
    files: ["apps/session-api/k6/**"],
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
      },
    },
  },
);
