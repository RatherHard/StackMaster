/**
 * 启动地址与换票路径的**纯函数**构造 / 解析(WP-91;D-LT-2 / D-LT-3)。
 *
 * **为什么单列一个模块**:`launchUrl` 是「地址即授权入口」这一对外形态的
 * 唯一产出点(D-LT-1),而它的构造涉及三处契约常量(路径模板、查询参数名、
 * 绝对 origin)。把它做成纯函数(无 IO / 无时钟 / 无随机)使三件事同时成立:
 *  1. 签发路由与测试用**同一份**逻辑(不存在"测试里手拼 URL,生产里另一套");
 *  2. 302 的**干净路径**与签发时的路径由**同一个** `launchRedeemPath` 产出 ⇒
 *     「302 到不含票据的干净路径」这条纪律不靠两处字面量保持同步;
 *  3. 形态可被穷举断言(见 `test/launch/launch-url.test.ts`)。
 *
 * 三处契约常量一律从 `@stackmaster/protocol` **导入**,本文件不写任何字面量。
 */
import { LAUNCH_TICKET_QUERY_PARAM, LAUNCH_TICKET_REDEEM_PATH_TEMPLATE } from "@stackmaster/protocol";

/** 模板中的两个占位符(与契约模板逐字对应;在此单源命名)。 */
const CHALLENGE_ID_PLACEHOLDER = ":challengeId";
const VERSION_PLACEHOLDER = ":version";

/**
 * 换票**干净路径**(不含查询串)= 302 的 Location。
 *
 * 这正是「302 抹除票据」的实现:Location 由本函数产出,而本函数**结构上
 * 无法**表达查询串 ⇒ 「忘了抹」在这条路径上不可表达(不是靠人记得)。
 */
export function launchRedeemPath(challengeId: string, version: string): string {
  return LAUNCH_TICKET_REDEEM_PATH_TEMPLATE.replace(
    CHALLENGE_ID_PLACEHOLDER,
    encodeURIComponent(challengeId),
  ).replace(VERSION_PLACEHOLDER, encodeURIComponent(version));
}

/**
 * 绝对启动地址 = `{origin}{干净路径}?{查询参数名}={票据}`(D-LT-2 方案 A)。
 *
 * `origin` 由调用方从**服务端配置**(`SESSION_API_PUBLIC_ORIGIN`)给出,
 * **永不**从请求头派生(`Host` / `X-Forwarded-*` 是 Host 头注入面)。
 */
export function buildLaunchUrl(
  origin: string,
  challengeId: string,
  version: string,
  ticket: string,
): string {
  return `${origin}${launchRedeemPath(challengeId, version)}?${LAUNCH_TICKET_QUERY_PARAM}=${encodeURIComponent(ticket)}`;
}

/**
 * 从 Fastify 解析后的查询对象里取票据值(**只认字符串形态**)。
 *
 * Fastify 的 query 解析对重复参数会给出数组 ⇒ 非字符串一律视为"没有票据",
 * 不在这一层做任何"取第一个"之类的宽容解释:本函数的唯一职责是把
 * 「一个字符串或什么都没有」递给形态校验,宽容解释会让"重复参数"这种
 * 可疑形态静默通过。
 */
export function launchTicketFromQuery(query: unknown): string | undefined {
  if (query === null || typeof query !== "object") {
    return undefined;
  }
  const raw = (query as Record<string, unknown>)[LAUNCH_TICKET_QUERY_PARAM];
  return typeof raw === "string" ? raw : undefined;
}
