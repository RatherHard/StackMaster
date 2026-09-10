import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 库模式多入口构建(WP-F1):
 *  - index         公开入口(导出 SmWorkspace,后续 WP 在此扩充公开 API);
 *  - sm-workspace  组件入口(<sm-workspace> 可单独加载注册)。
 *
 * 形态要点:
 *  - 声明文件由 `tsc -b`(emitDeclarationOnly)先行产出到 dist/,因此
 *    emptyOutDir 必须为 false,避免 vite build 抹掉 dist/*.d.ts;
 *  - 产物自包含:运行时依赖(lit、@lit-labs/virtualizer)内联进 bundle,
 *    plugin-dev / 宿主平台以 <script type="module"> 直接加载 dist 产物,
 *    不经打包器解析裸模块导入(加载模型见 apps/plugin-dev/README.md);
 *  - 动画纪律(CLAUDE.md 第十章):组件样式只允许 transform / opacity 等
 *    compositor 友好属性参与动画,入口层面不做任何全局样式注入。
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        "sm-workspace": fileURLToPath(new URL("./src/ui/sm-workspace.ts", import.meta.url)),
      },
      formats: ["es"],
    },
  },
});
