/**
 * 引导配置取回(D-API-75 默认通道 a;嵌入协议 §4.1 插件侧行为要点)。
 *
 * 插件以 fragment 中的一次性 esid 经 **POST 请求体**向宿主后端的引导配置
 * 取回端点(端点 URL 由插件文档页经 attribute / 全局配置注入)换取
 * `{embedToken, sessionApiOrigin, challengeId, challengeVersion, embedSessionId}`:
 *  - POST 体承载,禁入 URL query(V-13 红灯反例锚点之一);
 *  - token 只存页面内存:不解析、不校验、不在会话期外留存(浏览器对 token
 *    保持不透明;EmbedTokenClaims 解析器只在 protocol/server-only,本包绝不
 *    消费);
 *  - 取回失败 / 响应形态不符 → 返回 null(调用方降级显示):静态文案,
 *    **零反射面**——不回显任何响应内容(嵌入协议 §4.3);
 *  - `embedSessionId` 回包必须与本端 esid 全等(绑定一致性;不等即视为
 *    形态不符,降级)。
 */

/** 引导配置(浏览器侧形态;token 为不透明字符串)。 */
export interface EmbedBootstrapConfig {
  /** embed token(不透明;仅随 create_session 提交)。 */
  readonly embedToken: string;
  /** session-api 浏览器面 origin(create-session / WSS 目标)。 */
  readonly sessionApiOrigin: string;
  /** 题目上下文(随 create_session 三方比对;与 token 签发记录一致由服务端担保)。 */
  readonly challengeId: string;
  readonly challengeVersion: string;
  /** 嵌入会话标识(必须与本端 esid 全等)。 */
  readonly embedSessionId: string;
}

/** 取回选项(fetch 注入 = 测试确定性;默认 globalThis.fetch)。 */
export interface FetchBootstrapOptions {
  readonly fetchImpl?: typeof fetch;
}

/** sessionApiOrigin 必须是可解析的 http(s) origin(防任意字符串注入 fetch 基址)。 */
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * 取回引导配置;任何失败(网络 / 非 200 / 形态不符 / esid 不等)一律返回
 * null,不区分原因、不抛错、不回显细节(V-12 同纪律的取回面延伸)。
 */
export async function fetchEmbedBootstrapConfig(
  endpoint: string,
  esid: string,
  options: FetchBootstrapOptions = {},
): Promise<EmbedBootstrapConfig | null> {
  const doFetch = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embedSessionId: esid }),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const embedToken = record["embedToken"];
  const sessionApiOrigin = record["sessionApiOrigin"];
  const challengeId = record["challengeId"];
  const challengeVersion = record["challengeVersion"];
  const embedSessionId = record["embedSessionId"];
  if (
    typeof embedToken !== "string" ||
    embedToken === "" ||
    typeof sessionApiOrigin !== "string" ||
    !isHttpOrigin(sessionApiOrigin) ||
    typeof challengeId !== "string" ||
    challengeId === "" ||
    typeof challengeVersion !== "string" ||
    challengeVersion === "" ||
    typeof embedSessionId !== "string" ||
    // 绑定一致性:取回记录的 esid 必须与本端 fragment 值全等。
    embedSessionId !== esid
  ) {
    return null;
  }
  return { embedToken, sessionApiOrigin, challengeId, challengeVersion, embedSessionId };
}
