/**
 * embed token 开发签发脚本(WP-F7 E2E 联调基建;《前端实施计划》§五联调环境表)。
 *
 * plugin-dev 开发壳扮演宿主:持 bearer 共享凭证(SESSION_API_HOST_BACKEND_TOKEN,
 * 宿主后端 → session-api 服务端间行,D-API-11/15)调 `POST /auth/embed-tokens`,
 * 把签发的 embedToken 输出到 stdout,供创建会话表单 / E2E 自动化消费。
 *
 * 凭证纪律:共享凭证只走环境变量,不入库、不设缺省值(缺 env 即失败并给出
 * 指引);embed token 是短时凭证(TTL 由服务端配置),仍不写入任何持久化文件。
 *
 * 用法(CLI 形态;compose:app:up 拓扑缺省端口 13000):
 *   SESSION_API_ORIGIN=http://127.0.0.1:13000 \
 *   SESSION_API_HOST_BACKEND_TOKEN=<宿主共享凭证(compose dev 合成值见 compose/app.yaml)> \
 *   node apps/plugin-dev/scripts/issue-embed-token.mjs
 *
 * 可选环境变量:E2E_TENANT_ID / E2E_USER_ID / E2E_CHALLENGE_ID /
 * E2E_CHALLENGE_VERSION;embedSessionId 缺省每进程随机(128-bit base64url)。
 *
 * 库形态:E2E 帮手(e2e/fixtures.ts)直接 import { issueEmbedToken } 复用同一
 * 实现(本文件保持纯 JavaScript + JSDoc,.mjs 不经 TS 编译,与 k6 脚本同纪律)。
 */

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * 签发请求输入(冻结 EmbedTokenIssuanceRequestSchema 的字段面)。
 *
 * @typedef {object} IssueEmbedTokenInput
 * @property {string} origin session-api 源(compose:app:up 发布 http://127.0.0.1:13000)。
 * @property {string} bearerToken 宿主后端共享凭证(bearer;只经环境变量呈递,不落日志)。
 * @property {string} tenantId
 * @property {string} userId
 * @property {string} challengeId
 * @property {string} challengeVersion
 * @property {string} embedSessionId 嵌入会话标识(冻结 Schema 最短 22 字符 base64url)。
 */

/**
 * 签发响应(D-API-11:响应体 JSON 交付;token 禁入 URL / 日志)。
 *
 * @typedef {object} IssuedEmbedToken
 * @property {string} embedToken
 * @property {number} expiresAt 过期时刻(Unix epoch 秒)。
 */

/**
 * 调 `POST /auth/embed-tokens` 签发 embed token。非 201(凭证错 / 请求体
 * 契约不合法)抛错并携带状态码;响应体不整体打印(token 只经返回值流转)。
 *
 * @param {IssueEmbedTokenInput} input
 * @returns {Promise<IssuedEmbedToken>}
 */
export async function issueEmbedToken(input) {
  const response = await globalThis.fetch(`${input.origin}/auth/embed-tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.bearerToken}`,
    },
    body: JSON.stringify({
      tenantId: input.tenantId,
      userId: input.userId,
      challengeId: input.challengeId,
      challengeVersion: input.challengeVersion,
      embedSessionId: input.embedSessionId,
    }),
  });
  if (response.status !== 201) {
    throw new Error(
      `POST /auth/embed-tokens 失败:HTTP ${response.status}` +
        "(核对 SESSION_API_HOST_BACKEND_TOKEN 与题目登记上下文;响应体为冻结 PublicError 形态,此处不透出)",
    );
  }
  const body = /** @type {{ embedToken?: string; expiresAt?: number }} */ (await response.json());
  if (typeof body?.embedToken !== "string" || body.embedToken === "") {
    throw new Error("POST /auth/embed-tokens 响应缺少 embedToken 字段(契约漂移?)");
  }
  return { embedToken: body.embedToken, expiresAt: body.expiresAt ?? 0 };
}

/**
 * 从环境变量组装签发输入(凭证缺失即抛错,给出可操作指引)。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {IssueEmbedTokenInput}
 */
export function issueInputFromEnv(env = process.env) {
  const origin = env["SESSION_API_ORIGIN"] ?? "http://127.0.0.1:13000";
  const bearerToken = env["SESSION_API_HOST_BACKEND_TOKEN"] ?? "";
  if (bearerToken === "") {
    throw new Error(
      "缺少 SESSION_API_HOST_BACKEND_TOKEN(宿主后端共享凭证;compose dev 合成值见" +
        " apps/session-api/compose/app.yaml,只走环境变量,不入库)",
    );
  }
  return {
    origin,
    bearerToken,
    tenantId: env["E2E_TENANT_ID"] ?? "e2e-tenant",
    userId: env["E2E_USER_ID"] ?? "e2e-user",
    challengeId: env["E2E_CHALLENGE_ID"] ?? "chal-e2e-plugin-dev",
    challengeVersion: env["E2E_CHALLENGE_VERSION"] ?? "1.0.0",
    // 每次签发唯一 embedSessionId(128-bit CSPRNG base64url ≥ 22 字符)。
    embedSessionId: env["E2E_EMBED_SESSION_ID"] ?? randomBytes(16).toString("base64url"),
  };
}

// ── CLI 入口(直接执行本文件时;被 import 时不触发)────────────────────────
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const { embedToken, expiresAt } = await issueEmbedToken(issueInputFromEnv());
    // stdout 只承载 token 与过期时刻(消费方管道解析);诊断信息走 stderr。
    process.stdout.write(`${JSON.stringify({ embedToken, expiresAt })}\n`);
  } catch (error) {
    process.stderr.write(`[issue-embed-token] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
