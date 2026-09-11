import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * 库模式构建(WP-51 薄封装):
 *  - 单入口 index(src/index.tsx),ESM 输出 dist/index.js;
 *  - 声明文件由 `tsc -b`(emitDeclarationOnly)先行产出,emptyOutDir 须为 false;
 *  - react 是 peerDependency:构建产物外置 react / react-dom(含自动 JSX
 *    runtime 的 react/jsx-runtime)——薄封装不内联 React,消费方(打包器)
 *    与应用共享同一 React 实例;
 *  - @stackmaster/embed-runtime 是 dependencies:与 react 同样外置——薄封装
 *    消费方为打包器用户(React 应用),SDK 产物(embed-runtime dist 自包含)
 *    由其按需打包,避免 protocol 双份内联。
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.tsx", import.meta.url)),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^react(?:\/.*)?$/, /^react-dom(?:\/.*)?$/, /^@stackmaster\/embed-runtime$/],
    },
  },
});
