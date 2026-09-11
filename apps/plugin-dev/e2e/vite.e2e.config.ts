/**
 * E2E 专用 vite dev server 配置(WP-F7;playwright webServer 使用)。
 *
 * 为什么不复用 `vite.config.ts`:Vite 8 对 publicDir 文件(packages/vm-ui/dist)
 * 的**模块化请求**(`/index.js?import`)直接 500 拒绝——「publicDir 文件在构建期
 * 原样拷贝,不应被源码 import,只能经 HTML 标签引用」。而开发壳的加载模型
 * (README「加载模型」)是:静态 `<script type="module" src="/index.js">` 注册
 * 组件 + `src/main.ts` 动态 `import("/index.js")` 取 `SessionClient` 导出——
 * vite 的 import 分析会给变量型动态 import 包一层 `?import` 查询(经
 * `__vite__injectQuery`),该请求在 Vite 8 下即命中上述拒绝,壳引导失败。
 *
 * 修复语义(仅 E2E webServer,不改既有 vite.config.ts / src):对 vm-ui dist
 * 内文件的 `?import` 请求 **302 到去 query 的同路径**——浏览器模块映射按最终
 * URL 归并,动态 import 因此复用静态 script 已加载的**同一模块实例**
 * (`customElements.define` 只执行一次,`SessionClient` 导出照常可用)。这
 * 恰是原加载模型「同一 URL 同一实例」语义在 Vite 8 下的恢复方式。
 *
 * 其余(publicDir 指向 vm-ui dist、/sessions 与 /auth 反代、端口)直接继承
 * `vite.config.ts`(spread 复用,避免双份配置漂移)。
 */
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

// 继承应用配置(e2e 配置位于 apps/plugin-dev/e2e/ 下)。
// @ts-expect-error -- vite 配置装载器原生支持相对导入 TS 配置文件。
import appConfig from "../vite.config";

/** vm-ui 构建产物目录(与 vite.config.ts 的 publicDir 同源)。 */
const VM_UI_DIST = fileURLToPath(new URL("../../../packages/vm-ui/dist", import.meta.url));

/**
 * vm-ui dist 模块化请求重定向(见文件头说明)。只处理「路径命中 dist 内真实
 * 文件且带 import 查询」的请求;其余原样放行给 vite 内置中间件。
 */
function vmUiDistModuleRedirect(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url, "http://localhost");
    } catch {
      next();
      return;
    }
    if (!parsed.searchParams.has("import")) {
      next();
      return;
    }
    // 路径安全归一:必须落在 dist 目录内(防路径穿越),且确为真实文件。
    const filePath = resolve(VM_UI_DIST, `.${decodeURIComponent(parsed.pathname)}`);
    if (!filePath.startsWith(VM_UI_DIST.endsWith(sep) ? VM_UI_DIST : VM_UI_DIST + sep)) {
      next();
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      next();
      return;
    }
    // 302 到去 query 路径:浏览器以最终 URL 归并模块实例(见文件头)。
    res.writeHead(302, { location: parsed.pathname });
    res.end();
  };
  return {
    name: "plugin-dev-e2e:vm-ui-dist-module-redirect",
    apply: "serve",
    configureServer(server) {
      // 缺省 pre 位置:先于 vite 的 transform 中间件执行。
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  ...(appConfig as Record<string, unknown>),
  plugins: [vmUiDistModuleRedirect()],
});
