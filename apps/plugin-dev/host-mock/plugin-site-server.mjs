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
 * 子路径前缀形态(WP-55 13.4 非根路径部署):`--base-path /some/prefix`(或
 * 环境变量 PLUGIN_SITE_BASE_PATH)使服务器只在该前缀下应答(前缀外的路径
 * 404)——等价「整目录拷贝部署于任意路径前缀」的真实服务器形态;产物以相对
 * 路径引用(plugin/index.html `./pwn-memory-vm.js`),前缀剥离后路由不变。
 *
 * 启动:`pnpm --filter @stackmaster/plugin-dev dev:plugin-site`
 *   (变体:node host-mock/plugin-site-server.mjs --port 5175 --base-path /sub)
 * (需先构建 packages/web-component:pnpm --filter @stackmaster/web-component build)。
 * 本文件为纯 JavaScript + JSDoc(.mjs 不经 TS 编译);node 内建能力一律显式 import。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** CLI 参数(--port / --base-path)优先于环境变量,环境变量优先于缺省值。 */
function argValue(flag, envKey, fallback) {
  const argv = process.argv;
  const flagIndex = argv.indexOf(flag);
  if (flagIndex !== -1 && typeof argv[flagIndex + 1] === "string") {
    return argv[flagIndex + 1];
  }
  return process.env[envKey] ?? fallback;
}

const PLUGIN_SITE_PORT = Number(argValue("--port", "PLUGIN_SITE_PORT", 5174));
/** 子路径前缀(规范化为「以 / 开头、不以 / 结尾」;空串 = 根路径形态)。 */
const BASE_PATH = (() => {
  const raw = String(argValue("--base-path", "PLUGIN_SITE_BASE_PATH", ""));
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
})();

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

/**
 * E2E 扫描变体页(WP-55 axe;真实服务器路由——fulfill 形态的合成文档在本
 * 机 Chromium 下会触发 LNA(loopback 地址空间)拦截,插件面后续取回全灭,
 * 故以真实路由承载;内容与正式页同构,仅注入测试 attribute)。脚本以绝对
 * 路径引用产物(同源,CSP script-src 'self' 兼容)。
 */
const VARIANT_TEMPLATE = (attributes) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<title>StackMaster 插件页(pwn-memory-vm)</title></head>` +
  `<body><pwn-memory-vm bootstrap-endpoint="http://localhost:5173/host-api/embed-bootstrap"${attributes}></pwn-memory-vm>` +
  `<script type="module" src="/pwn-memory-vm.js"></script></body></html>`;

const VARIANT_ROUTES = new Map([
  ["/axe.html", VARIANT_TEMPLATE("")],
  ["/axe-fast.html", VARIANT_TEMPLATE(' handshake-timeout-ms="3000" hello-max-retries="0"')],
]);

const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];
  // 子路径前缀剥离(非根路径部署形态):前缀必须精确匹配,前缀外一律 404
  // (部署面前缀语义;剥离后走同一张固定路由表,零额外穿越面)。
  const relative =
    BASE_PATH === ""
      ? pathname
      : pathname === BASE_PATH
        ? "/"
        : pathname.startsWith(`${BASE_PATH}/`)
          ? pathname.slice(BASE_PATH.length)
          : null;
  if (relative === null) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "resource_not_found", message: "resource not found" }));
    return;
  }
  const route = ROUTES.get(relative === "" ? "/" : relative);
  const variantHtml = VARIANT_ROUTES.get(relative === "" ? "/" : relative);
  if (route === undefined && variantHtml === undefined) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "resource_not_found", message: "resource not found" }));
    return;
  }
  if (route === undefined) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "script-src 'self'",
    });
    res.end(variantHtml);
    return;
  }
  if (!existsSync(route.file) || !statSync(route.file).isFile()) {
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
