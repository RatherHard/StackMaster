/**
 * 真机几何测量的 Vite 开发服务器配置(M3 遗留-5 ①,仅测量用,不进产物)。
 *
 * 根 = 包根(packages/vm-ui):一次服务器同时提供
 *  - 当前源码形态:`/src/views/instruction/sm-instruction-view.ts`(Vite 现场转译);
 *  - 修复前形态:`/dist/sm-workspace-CpaZ0UGg.js`(2026-09-17 17:15 的**修复前
 *    构建产物**,自带 `customElements.define` 自注册,可直接在浏览器里跑)。
 * 两形态在**同一页面骨架 / 同一 CSS / 同一数据夹具 / 同一浏览器**下测量 ⇒
 * 行高差异只可能来自模板字面空白这一处改动。
 *
 * `root` 取 `process.cwd()`:本配置由仓库内 `vite` 以 `cwd = packages/vm-ui`
 * 启动(见 measure-instruction-geometry.cjs),不使用 `import.meta.url`
 * (配置文件会被 Vite 打包到临时路径,URL 不可靠)。
 */
export default {
  root: process.cwd(),
  appType: "mpa",
  cacheDir: "node_modules/.vite-geometry",
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    fs: { strict: false },
  },
};
