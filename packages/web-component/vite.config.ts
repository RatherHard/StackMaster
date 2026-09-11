import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 库模式构建(WP-52 正式实现;Q3 定案:自包含单产物):
 *  - 单入口 index(src/index.ts),ESM 输出 dist/index.js;
 *  - 声明文件由 `tsc -b`(emitDeclarationOnly)先行产出,emptyOutDir 须为
 *    false,避免 vite build 抹掉 dist/*.d.ts;
 *  - 产物自包含:运行时依赖(lit、@stackmaster/vm-ui、@stackmaster/
 *    embed-runtime、@stackmaster/protocol/zod)全部内联进单文件——插件文档页
 *    以 `<script type="module" src="(相对路径)">` 直接加载,不经打包器解析
 *    裸模块导入;inlineDynamicImports 压平动态分块,保证「单产物」形态
 *    (非根路径部署下无伴随 chunk 的路径解析问题)。
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
    rollupOptions: {
      output: {
        // Vite 8(rolldown)选项形态:压平动态分块,保证「单产物」。
        codeSplitting: false,
      },
    },
  },
});
