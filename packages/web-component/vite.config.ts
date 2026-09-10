import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 库模式构建(WP-F1 占位包):
 *  - 单入口 index(src/index.ts),ESM 输出 dist/index.js;
 *  - 声明文件由 `tsc -b`(emitDeclarationOnly)先行产出,emptyOutDir 须为
 *    false,避免 vite build 抹掉 dist/*.d.ts;
 *  - 产物自包含(lit 内联):阶段五正式实现后,宿主平台以
 *    `<script type="module">` 直接加载本包产物(独立来源 iframe 内),
 *    不经打包器解析裸模块导入。
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      formats: ["es"],
    },
  },
});
