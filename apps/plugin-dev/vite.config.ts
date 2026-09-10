import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * plugin-dev 开发壳 Vite 配置(WP-F1;仅供开发联调,不参与生产部署)。
 *
 * 1) vm-ui 产物加载:packages/vm-ui/dist 经 publicDir 以静态资源形态提供,
 *    index.html 用 `<script type="module" src="/index.js">` 直接加载并注册
 *    <sm-workspace>——这是"平台宿主加载已发布组件包"的真实拓扑,开发壳不把
 *    浏览器可达包打进自身构建图(dependency-cruiser
 *    no-backend-dependency-on-browser-packages 禁止 apps 静态依赖浏览器包)。
 *    dev 依赖声明(@stackmaster/vm-ui,devDependencies)只为 turbo ^build
 *    构建序与工作区链接,不产生模块依赖边。
 *
 * 2) 会话 API 反代(开发联调用):把 /sessions 与 /auth 同源代理到
 *    session-api,令浏览器侧请求与开发壳同源(Cookie SameSite=Strict 路径,
 *    《前端实施计划》§五联调环境表)。
 *    - 目标:环境变量 SESSION_API_ORIGIN,默认 http://127.0.0.1:13000
 *      (compose:app:up 拓扑发布端口);
 *    - 关闭:SESSION_API_PROXY=off(纯静态开发);
 *    - 注意:若不走反代、直连后端跨端口联调,须在 session-api 的
 *      SESSION_API_ALLOWED_ORIGINS 登记开发 origin(如 http://localhost:5173)。
 */
const vmUiDist = fileURLToPath(new URL("../../packages/vm-ui/dist", import.meta.url));
const sessionApiOrigin = process.env.SESSION_API_ORIGIN ?? "http://127.0.0.1:13000";
const proxyEnabled = process.env.SESSION_API_PROXY !== "off";

export default defineConfig({
  publicDir: vmUiDist,
  server: {
    port: 5173,
    proxy: proxyEnabled
      ? {
          // REST 5 命令面(POST /sessions 等)与认证 WSS(GET /sessions/channel)。
          "/sessions": { target: sessionApiOrigin, changeOrigin: true, ws: true },
          // embed token 开发签发面(POST /auth/embed-tokens;凭证走环境变量,不入库)。
          "/auth": { target: sessionApiOrigin, changeOrigin: true },
        }
      : undefined,
  },
});
