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
);
