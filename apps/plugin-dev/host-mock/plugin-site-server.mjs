/**
 * 插件文档页站点(WP-52 demo 拓扑;插件独立来源形态)。
 *
 * 形态:零依赖 Node http 静态服务器(dev 联调面),在独立端口(默认 5174)
 * 承载 packages/web-component 的插件文档页与自包含产物——与宿主模拟页
 * (vite dev,5173)构成「宿主 origin ≠ 插件 origin」的独立来源演示拓扑:
 *   宿主模拟页  http://localhost:5173/host-mock/          (签发 + 建 iframe)
 *   插件文档页  http://localhost:5174/                     (正式产物;iframe src)
 *   引导取回    http://localhost:5173/host-api/embed-bootstrap
 *               (插件页跨源 POST;dev-server.mjs 按 PLUGIN_SITE_ORIGIN 回 ACAO)
 *   create-session / WSS → http://localhost:13000
 *               (插件 origin 经 compose demo-override 增补进 ALLOWED_ORIGINS)
 *
 * 路由(固定映射,零目录穿越面):
 *   GET /            → packages/web-component/plugin/index.html
 *                       (响应携带 CSP 头 `script-src 'self'`——受限 CSP 兼容
 *                       的真实运行证明:文档页零内联脚本、产物单文件)
 *   GET /pwn-memory-vm.js → packages/web-component/dist/index.js
 *   其余             → 404(JSON,与 dev-server.mjs 同款错误形态)
 *
 * 启动:`pnpm --filter @stackmaster/plugin-dev dev:plugin-site`
 * (需先构建 packages/web-component:pnpm --filter @stackmaster/web-component build)。
 * 本文件为纯 JavaScript + JSDoc(.mjs 不经 TS 编译);node 内建能力一律显式 import。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_SITE_PORT = Number(process.env["PLUGIN_SITE_PORT"] ?? 5174);

/** 插件文档页与产物源(packages/web-component;dist 须先构建)。 */
const WEB_COMPONENT_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "web-component",
);

/** 固定路由表(路径 → 文件;零通配、零穿越)。 */
const ROUTES = new Map([
  ["/", { file: join(WEB_COMPONENT_ROOT, "plugin", "index.html"), type: "text/html", csp: true }],
  ["/index.html", { file: join(WEB_COMPONENT_ROOT, "plugin", "index.html"), type: "text/html", csp: true }],
  [
    "/pwn-memory-vm.js",
    { file: join(WEB_COMPONENT_ROOT, "dist", "index.js"), type: "text/javascript", csp: false },
  ],
]);

const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];
  const route = ROUTES.get(pathname === "" ? "/" : pathname);
  if (route === undefined || !existsSync(route.file) || !statSync(route.file).isFile()) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "resource_not_found", message: "resource not found" }));
    return;
  }
  const headers = {
    "content-type": `${route.type}; charset=utf-8`,
    // 受限 CSP 形态自测:插件文档页在 `script-src 'self'` 下可完整运行
    // (页面唯一脚本是同源产物文件;零内联脚本、零 eval,见 artifact.test.ts)。
    ...(route.csp ? { "content-security-policy": "script-src 'self'" } : {}),
  };
  res.writeHead(200, headers);
  createReadStream(route.file).pipe(res);
});

server.listen(PLUGIN_SITE_PORT, () => {
  const artifact = join(WEB_COMPONENT_ROOT, "dist", "index.js");
  if (!existsSync(artifact)) {
    console.error(
      "[plugin-site] packages/web-component/dist/index.js 不存在——先执行 pnpm --filter @stackmaster/web-component build",
    );
    process.exit(1);
  }
  console.log(
    `[plugin-site] 插件文档页就绪:http://localhost:${String(PLUGIN_SITE_PORT)}/(CSP script-src 'self';正式产物 @ /pwn-memory-vm.js)`,
  );
});
