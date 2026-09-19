import { defineConfig } from "vite";

/**
 * page-app 构建配置(分发改版 WP-92;**application build,不是 library mode**)。
 *
 * ## 1) 为什么是 application build
 *
 * `CLAUDE.md` 技术栈表(2026-09-18 分发改版)已把浏览器 UI 的构建形态改写为
 * 「插件三形态打包退役 ⇒ **页面应用 application build**;library mode 仅服务
 * 内部包」。本应用是**最终交付物**(一个页面),不是被别的宿主 import 的库 ⇒
 * `vite build` 缺省形态(html 入口 + 代码分割 + 资源指纹)正是所需形态;只要
 * 不是 `build.lib`,就是 application build。
 *
 * ## 2) vm-ui 产物为什么走 publicDir 而不是静态 import
 *
 * `tooling/dependency-cruiser.cjs` 的 `no-backend-dependency-on-browser-packages`
 * **禁止 apps/** 静态依赖浏览器可达包(vm-ui / web-component / embed-runtime /
 * react-wrapper)。这不是可以绕过的风格问题,而是安全边界:浏览器包的机制面
 * 不进服务端可达的构建图。`apps/plugin-dev` 的既有做法是「vm-ui dist 作为静态
 * 资源提供 + 运行期按 **URL** 动态 import」——本应用沿用同一形态,只是把资源
 * 位置从"平铺到产物根"改为 "`dist/vm-ui/` 子目录":
 *
 *  - 构建前:`scripts/sync-vm-ui-dist.mjs` 把 `packages/vm-ui/dist` 同步到本应用
 *    的 `public/vm-ui/`(**为什么需要这一趟**:vite 的 publicDir 语义是"内容
 *    平铺到 outDir 根",直接指过去会让 vm-ui 的 `index.html` / `index.js` 与本
 *    应用产物同名相撞 —— 实测 `dist/index.html` 会被覆盖);
 *  - 构建期:vite 把 `public/` 整目录拷贝到 `dist/` ⇒ 产物里有 `dist/vm-ui/`;
 *  - 运行期:`src/main.ts` 以变量型 URL 动态 import `/vm-ui/index.js`
 *    (带 `@vite-ignore` 注解)取回 `SessionClient` 等命名导出 ⇒ 不进构建图、
 *    零依赖边。
 *
 * 好处是**产物自包含**:`dist/` 一个目录即可独立托管(session-api 的
 * `SESSION_API_PAGE_APP_DIR` 就指向它)。
 *
 * ## 3) dev server 反代
 *
 * 生产形态是**同源**(session-api 托管页面);开发态页面在 5180、API 在
 * session-api 上,故用反代把同源**还原**出来(`/sessions` / `/app` /
 * `/descriptors` 三个前缀转给 session-api),Cookie(SameSite=Strict)与相对
 * 路径 baseUrl 的语义因此与生产一致。环境变量 `SESSION_API_ORIGIN` 覆盖目标;
 * `SESSION_API_PROXY=off` 关反代(纯静态联调)。
 *
 * `public/` 里的 `vm-ui/` 由 `predev` 钩子自动同步 ⇒ 开发态 `/vm-ui/index.js`
 * 直接可用。
 */
const sessionApiOrigin = process.env.SESSION_API_ORIGIN ?? "http://127.0.0.1:13000";
const proxyEnabled = process.env.SESSION_API_PROXY !== "off";

export default defineConfig({
  // vm-ui 产物经 scripts/sync-vm-ui-dist.mjs 暂存于此,整目录拷贝进 dist/。
  publicDir: "public",
  build: {
    // application build:html 入口由 index.html 承担,产物落 dist/。
    outDir: "dist",
    // 产物自包含:不依赖 CDN / 外部运行时(资源内联阈值为 0 = 一律出文件)。
    assetsInlineLimit: 0,
  },
  server: {
    port: 5180,
    /**
     * 文件监视忽略面(dev-only;与 `apps/plugin-dev/vite.config.ts` 同款加固)。
     * 写文件工具与编辑器的原子写会留下 `<name>.<pid>.<guid>.tmpdir/`,而
     * Windows 对该目录内文件的 `watch` 返回 **EBUSY**,会让 Vite 的 FSWatcher
     * **整个进程退出**。前缀不固定(见过 `._…` 与 `.…` 两种)⇒ **必须按后缀
     * `.tmpdir` 匹配**;`.tmp/` = Playwright 产物目录,一并忽略。
     */
    watch: {
      ignored: ["**/*.tmpdir", "**/*.tmpdir/**", "**/.tmp/**", "**/._*"],
    },
    proxy: proxyEnabled
      ? {
          // 会话生命周期 REST 与认证 WSS(含 GET /sessions/channel 升级)。
          "/sessions": { target: sessionApiOrigin, changeOrigin: true, ws: true },
          /**
           * 兑换回跳页(**同一个路径身兼两职**,故必须按查询串分流):
           *  - 带 `?t=<票据>` ⇒ 是**服务端换票**请求,转给 session-api
           *    (换票 + Set-Cookie + 302 到干净路径);
           *  - 不带票据 ⇒ 是 302 之后的**页面请求**,必须留给本地静态资源,
           *    否则开发态永远拿不到页面(实测:整段 `/app` 一律反代会把干净路径
           *    也打到后端 ⇒ 502)。
           */
          "/app": {
            target: sessionApiOrigin,
            changeOrigin: true,
            bypass: (request) =>
              new URL(request.url ?? "/", "http://localhost").searchParams.has("t")
                ? undefined
                : request.url,
          },
          // 公开描述包下发端点。
          "/descriptors": { target: sessionApiOrigin, changeOrigin: true },
        }
      : undefined,
  },
});
