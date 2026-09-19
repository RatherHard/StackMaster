/**
 * 工作区整页布局真机几何测量的 Vite 开发服务器配置
 * (2026-09-18 整页布局改版 / D-API-153;仅测量用,不进产物)。
 *
 * 根 = 包根(`packages/vm-ui`):一次服务器提供 `/src/workspace/sm-workspace.ts`
 * (Vite 现场转译),浏览器里挂载真组件并读真机几何。
 *
 * `root` 取 `process.cwd()`:本配置由仓库内 `vite` 以 `cwd = packages/vm-ui`
 * 启动(见 measure-workspace-geometry.cjs),不使用 `import.meta.url`
 * (配置文件会被 Vite 打包到临时路径,URL 不可靠)。
 */
export default {
  root: process.cwd(),
  appType: "mpa",
  cacheDir: "node_modules/.vite-geometry-workspace",
  server: {
    host: "127.0.0.1",
    port: 5198,
    strictPort: true,
    fs: { strict: false },
  },
};
