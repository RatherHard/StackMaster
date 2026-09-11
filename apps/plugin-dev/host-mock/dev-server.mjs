/**
 * 宿主模拟页 dev 替身(WP-51;D-API-75 MVP 演示面的"宿主后端")。
 *
 * 形态:vite dev-only 中间件插件(仅 serve 生效,不进构建产物),由
 * apps/plugin-dev/vite.config.ts 装配。职责:
 *  1. `POST /host-api/embed-tokens` —— 签发代理:持 SESSION_API_HOST_BACKEND_TOKEN
 *     (环境变量注入,不入库、不设缺省值,沿 issue-embed-token.mjs 脚本纪律)
 *     向 session-api 调 `POST /auth/embed-tokens`(D-API-11),并把
 *     (esid → 题目上下文 + token)登记进进程内一次性记录表;
 *  2. `POST /host-api/embed-bootstrap` —— 引导配置取回端点(D-API-75 默认
 *     通道):插件以 iframe fragment 中的一次性 esid 经 **POST 请求体**换取
 *     `{embedToken, sessionApiOrigin, challengeId, challengeVersion,
 *     embedSessionId}`;记录取走即删(esid 单次有效、重载即轮换)。token 全程
 *     不进 URL query、不经 postMessage、不进日志;
 *  3. `/vendor/embed-runtime/*` —— 以静态资源形态提供 embed-runtime 自包含
 *     dist 产物,供宿主模拟页动态加载(与 vm-ui 经 publicDir 的加载模型
 *     同构:apps 不静态依赖浏览器包,dependency-cruiser
 *     no-backend-dependency-on-browser-packages 不产生模块依赖边)。
 *
 * CORS 姿态:`/host-api/embed-tokens`(宿主页面签发代理)只服务同源调用
 * (vite dev origin),不回显 ACAO——签发凭证不对其他 origin 开放(WP-51 姿态)。
 * `POST /host-api/embed-bootstrap`(插件面的引导取回端点)自 WP-52 起对插件
 * 独立来源 origin(PLUGIN_SITE_ORIGIN,默认 http://localhost:5174)回显精确
 * ACAO——跨源插件 iframe 的取回是 D-API-75 默认形态;不在白名单的 origin
 * fail-closed(不回显任何 ACAO)。
 * 本文件为纯 JavaScript + JSDoc(.mjs 不经 TS 编译,与 issue-embed-token.mjs
 * 同纪律);node 内建能力一律经显式 import,避免裸全局。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** session-api 源(compose:app:up 发布端口;与 vite.config.ts 代理同缺省)。 */
const SESSION_API_ORIGIN_DEFAULT = "http://127.0.0.1:13000";
/** 浏览器面 session-api 源(下发给插件的 create-session 目标;demo-override 已登记 5173)。 */
const SESSION_API_BROWSER_ORIGIN_DEFAULT = "http://localhost:13000";

/** esid 形态(与 protocol EmbedSessionIdSchema 的字符集/长度一致;dev 端预检)。 */
const ESID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * 插件独立来源 origin 清单(WP-52 demo 拓扑;WP-55 增补逗号分隔多形态)。
 * 仅 `POST /host-api/embed-bootstrap`(插件面的引导取回端点,D-API-75 通道 a)
 * 对清单内 origin 回显 ACAO——跨源插件 iframe 的取回是 D-API-75 的默认形态;
 * `/host-api/embed-tokens`(宿主页面的签发代理)保持同源-only(WP-51 姿态:
 * 签发凭证不跨 origin 开放)。缺省 = 5174(正式产物)+ 5175(非根路径部署
 * 形态,同源产物换前缀部署的 E2E 面);生产语义由宿主后端按其插件来源清单配置。
 */
const PLUGIN_SITE_ORIGINS = new Set(
  (process.env["PLUGIN_SITE_ORIGIN"] ?? "http://localhost:5174,http://localhost:5175")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
);

/** 引导取回端点的 CORS 头(精确 origin 白名单;fail-closed:不在表内不回显)。 */
function bootstrapCorsHeaders(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !PLUGIN_SITE_ORIGINS.has(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "vary": "Origin",
    "access-control-allow-credentials": "false", // 引导取回零凭证语义(POST 体承载 esid)。
  };
}

/** 进程内一次性引导配置记录表(esid → 记录;取走即删)。 */
const bootstrapRecords = new Map();

/** embed-runtime 自包含 dist 目录(静态资源挂载点)。 */
const EMBED_RUNTIME_DIST = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "embed-runtime",
  "dist",
);

/** dev 替身的环境输入(缺凭证 → 签发端确定性失败并给出指引)。 */
function envConfig() {
  return {
    sessionApiOrigin: process.env["SESSION_API_ORIGIN"] ?? SESSION_API_ORIGIN_DEFAULT,
    sessionApiBrowserOrigin:
      process.env["SESSION_API_BROWSER_ORIGIN"] ?? SESSION_API_BROWSER_ORIGIN_DEFAULT,
    hostBackendToken: process.env["SESSION_API_HOST_BACKEND_TOKEN"] ?? "",
  };
}

/** 读取并解析 JSON 请求体(解析失败返回 null)。 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** JSON 响应写出的最小助手(带 dev 替身统一错误形态)。 */
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** JSON 响应 + 附加头(引导取回端点的 CORS 面)。 */
function writeJsonWithHeaders(res, status, extraHeaders, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** 字符串字段预检(全部必填)。 */
function requireStringFields(body, fields) {
  for (const field of fields) {
    const value = body[field];
    if (typeof value !== "string" || value === "") return false;
  }
  return true;
}

/** 调 session-api `POST /auth/embed-tokens`(服务端间;D-API-11 响应形态)。 */
async function issueEmbedToken(config, body) {
  const response = await globalThis.fetch(`${config.sessionApiOrigin}/auth/embed-tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.hostBackendToken}`,
    },
    body: JSON.stringify({
      tenantId: body.tenantId,
      userId: body.userId,
      challengeId: body.challengeId,
      challengeVersion: body.challengeVersion,
      embedSessionId: body.embedSessionId,
    }),
  });
  if (response.status !== 201) {
    return null;
  }
  const issued = await response.json();
  if (typeof issued?.embedToken !== "string" || issued.embedToken === "") {
    return null;
  }
  return { embedToken: issued.embedToken, expiresAt: issued.expiresAt ?? 0 };
}

/** /host-api/embed-tokens:页面级签发代理(登记一次性引导记录)。 */
async function handleIssue(req, res) {
  const config = envConfig();
  if (config.hostBackendToken === "") {
    writeJson(res, 503, {
      error: "host_backend_token_missing",
      message:
        "缺少 SESSION_API_HOST_BACKEND_TOKEN(宿主后端共享凭证;compose dev 合成值见 apps/session-api/compose/app.yaml,只走环境变量)",
    });
    return;
  }
  const body = await readJsonBody(req);
  if (
    body === null ||
    !requireStringFields(body, ["tenantId", "userId", "challengeId", "challengeVersion", "embedSessionId"]) ||
    !ESID_PATTERN.test(body.embedSessionId)
  ) {
    writeJson(res, 400, { error: "invalid_input_format", message: "签发请求体契约不合法" });
    return;
  }
  const issued = await issueEmbedToken(config, body);
  if (issued === null) {
    writeJson(res, 502, {
      error: "issuance_failed",
      message: "POST /auth/embed-tokens 失败(核对凭证与题目登记上下文;响应体为冻结 PublicError 形态,此处不透出)",
    });
    return;
  }
  bootstrapRecords.set(body.embedSessionId, {
    tenantId: body.tenantId,
    userId: body.userId,
    challengeId: body.challengeId,
    challengeVersion: body.challengeVersion,
    embedToken: issued.embedToken,
    expiresAt: issued.expiresAt,
  });
  // 页面响应只含 token 与过期时刻(token 仅存页面内存;不落任何持久化)。
  writeJson(res, 200, { embedToken: issued.embedToken, expiresAt: issued.expiresAt });
}

/** /host-api/embed-bootstrap:插件经 POST 体以 esid 换引导配置(D-API-75 通道 a)。 */
async function handleBootstrap(req, res) {
  // WP-52 demo 拓扑:插件独立来源 iframe 跨源取回(精确 origin 白名单)。
  const cors = bootstrapCorsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...cors,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }
  const body = await readJsonBody(req);
  const esid = body?.embedSessionId;
  if (body === null || typeof esid !== "string" || !ESID_PATTERN.test(esid)) {
    writeJsonWithHeaders(res, 400, cors, { error: "invalid_input_format", message: "引导取回必须以 POST 体携带 embedSessionId" });
    return;
  }
  const record = bootstrapRecords.get(esid);
  if (record === undefined) {
    // 未登记 / 已消费同形拒绝:esid 单次有效,重载即轮换(D-API-75)。
    writeJsonWithHeaders(res, 404, cors, { error: "bootstrap_not_found", message: "resource not found" });
    return;
  }
  bootstrapRecords.delete(esid);
  const config = envConfig();
  writeJsonWithHeaders(res, 200, cors, {
    embedToken: record.embedToken,
    sessionApiOrigin: config.sessionApiBrowserOrigin,
    challengeId: record.challengeId,
    challengeVersion: record.challengeVersion,
    embedSessionId: esid,
  });
}

/** /vendor/embed-runtime 静态资源(自包含 dist;防穿越 + 最小 MIME)。 */
function serveEmbedRuntimeDist(req, res) {
  const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const relative = normalize(requestPath).replace(/^([/\\])+/, "");
  const candidate = join(EMBED_RUNTIME_DIST, relative);
  if (!candidate.startsWith(EMBED_RUNTIME_DIST + sep) || !existsSync(candidate)) {
    writeJson(res, 404, { error: "resource_not_found", message: "resource not found" });
    return;
  }
  if (!statSync(candidate).isFile()) {
    writeJson(res, 404, { error: "resource_not_found", message: "resource not found" });
    return;
  }
  const mime = extname(candidate) === ".mjs" ? "text/javascript" : "application/javascript";
  res.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
  createReadStream(candidate).pipe(res);
}

/**
 * vite 插件(apply: serve = dev-only):装配 /host-api 两端点与
 * /vendor/embed-runtime 静态资源。
 */
export function hostMockDevServer() {
  return {
    name: "plugin-dev-host-mock-dev-server",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/vendor/embed-runtime", (req, res) => {
        serveEmbedRuntimeDist(req, res);
      });
      server.middlewares.use("/host-api", (req, res) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (req.method === "POST" && pathname === "/embed-tokens") {
          void handleIssue(req, res);
          return;
        }
        if (req.method === "POST" && pathname === "/embed-bootstrap") {
          void handleBootstrap(req, res);
          return;
        }
        writeJson(res, 404, { error: "resource_not_found", message: "resource not found" });
      });
      server.config.logger.info(
        "  ➜  host-mock:宿主模拟页挂载于 /host-mock/(签发代理 + 引导配置取回端点已就绪)",
      );
    },
  };
}
