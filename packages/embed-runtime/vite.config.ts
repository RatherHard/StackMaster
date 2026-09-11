import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 库模式构建(WP-51):
 *  - 单入口 index(src/index.ts),ESM 输出 dist/index.js;
 *  - 声明文件由 `tsc -b`(emitDeclarationOnly)先行产出,emptyOutDir 须为
 *    false,避免 vite build 抹掉 dist/*.d.ts;
 *  - 产物自包含:@stackmaster/protocol(zod)内联进 bundle——宿主平台页面
 *    以 `<script type="module">` / 动态 import 直接加载本包产物,不经打包器
 *    解析裸模块导入(与 vm-ui / web-component 自包含纪律一致)。本包零 UI
 *    依赖,无需内联 lit。
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
