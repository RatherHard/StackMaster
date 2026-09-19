/**
 * 启动地址的**纯函数**解析(分发改版 WP-92)。
 *
 * ## 形态来源:契约,不是字面量
 *
 * 地址形态 = `GET /app/c/:challengeId/:version`(兑换)与其后的**干净路径**
 * (无查询串;302 的 Location)。这条路径的**唯一权威**是契约常量
 * `LAUNCH_TICKET_REDEEM_PATH_TEMPLATE`(`packages/protocol`,WP-90 冻结)——
 * 本模块从它**推导**前缀与参数字典序,而不是抄一份字面量:
 * 契约改了模板,这里自动跟着改,不存在"两处字面量各自漂移"。
 *
 * ## 为什么不需要处理查询串
 *
 * 换票由**服务端**完成,票据在 URL query 里;服务端消费后 **302** 到**不含
 * 票据的干净路径**(D-LT-2 方案 A)。因此页面被加载时 query 已不存在,本解析
 * 器也**刻意**不读 `?t=`:
 *  - 读了也没有用(票据是一次性的、已消费);
 *  - 更重要的:浏览器侧**不做任何授权判断**——「这个地址有效吗」只由
 *    `POST /sessions` 的应答回答(401 = 地址已失效)。
 *
 * ## 解析失败 = 页面级呈现
 *
 * 路径不匹配(用户手打地址 / 被截断 / 部署在别的路径前缀)时返回 `null`,
 * 由引导层呈现「地址无效」**且不发起任何网络请求**——一个形态明显不对的
 * 地址不该产生 401 噪音,也不该让页面看起来"在加载"。
 */
import { LAUNCH_TICKET_REDEEM_PATH_TEMPLATE } from "@stackmaster/protocol";

/** 题目导航信息(公开;租户与授权由服务端绑定,不在此处)。 */
export interface LaunchPath {
  readonly challengeId: string;
  readonly version: string;
}

/** 模板中的占位符记法(与契约模板逐字对应;在此单源命名)。 */
const PLACEHOLDER_PREFIX = ":";
const SEGMENT_SEPARATOR = "/";

/** 模板切分结果:静态片段 + 占位符名(顺序即路径段顺序)。 */
type PathSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "placeholder"; readonly name: string };

/**
 * 把契约模板切成段(`/app/c/:challengeId/:version` ⇒
 * `["app"(literal), "c"(literal), "challengeId"(placeholder), "version"(placeholder)]`)。
 *
 * 模块初始化期算一次(模板是常量),故解析是纯查表 + 逐段比较。
 */
function parseTemplate(template: string): readonly PathSegment[] {
  return template
    .split(SEGMENT_SEPARATOR)
    .filter((segment) => segment !== "")
    .map((segment) =>
      segment.startsWith(PLACEHOLDER_PREFIX)
        ? { kind: "placeholder" as const, name: segment.slice(PLACEHOLDER_PREFIX.length) }
        : { kind: "literal" as const, value: segment },
    );
}

const TEMPLATE_SEGMENTS = parseTemplate(LAUNCH_TICKET_REDEEM_PATH_TEMPLATE);

/** 模板期望的段数(解析时用于快速否定;段数不符无须逐段比较)。 */
export const LAUNCH_PATH_SEGMENT_COUNT = TEMPLATE_SEGMENTS.length;

/** 占位符名(按出现顺序;装配层与 E2E 断言共用,免于各自写字面量)。 */
export const LAUNCH_PATH_PLACEHOLDERS: readonly string[] = TEMPLATE_SEGMENTS.filter(
  (segment) => segment.kind === "placeholder",
).map((segment) => segment.name);

/** 解码路径段;解码失败(畸形百分号编码)按无效处理,不抛错。 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * 从 `location.pathname` 解析题目导航信息。
 *
 * 行为:
 *  - **完全匹配**才成功(段数、静态段逐字、占位符段非空);多一段 / 少一段 /
 *    静态段不符一律 `null`;
 *  - **尾部斜杠按无效处理**(`/app/c/x/1.0.0/` 与模板不符)。这是刻意的严格:
 *    服务端 302 的 Location 由契约常量产出,结构上不含尾部斜杠;而"宽容解释"
 *    会让 `/app/c/x/1.0.0/<任意后缀>` 一类**被拼接污染**的地址悄悄生效 ——
 *    在"地址即授权入口"的形态下,宁可让学习者看到一句"地址无效";
 *  - 占位符值做百分号解码(与契约里 `encodeURIComponent` 的产出对称);
 *    解码失败(畸形百分号编码)或解码后为空串一律无效。
 *
 * @param pathname 例如 `window.location.pathname`。
 */
export function parseLaunchPath(pathname: string): LaunchPath | null {
  // **不**过滤空段:段数比较本身就承担"尾部斜杠 / 连续斜杠"的拒绝
  // (`/app/c/x/1.0.0/` 切出 5 段,而模板 4 段 ⇒ null)。
  const rawSegments = pathname.split(SEGMENT_SEPARATOR);
  if (rawSegments.length !== TEMPLATE_SEGMENTS.length + 1 || rawSegments[0] !== "") {
    // 合法形态必以 `/` 起始 ⇒ 切分后首段恒为空串。
    return null;
  }
  const captured: Record<string, string> = {};
  for (let index = 0; index < TEMPLATE_SEGMENTS.length; index += 1) {
    const expected = TEMPLATE_SEGMENTS[index];
    const actual = rawSegments[index + 1];
    if (expected === undefined || actual === undefined || actual === "") {
      return null;
    }
    if (expected.kind === "literal") {
      if (actual !== expected.value) {
        return null;
      }
      continue;
    }
    const decoded = decodeSegment(actual);
    if (decoded === null || decoded === "") {
      return null;
    }
    captured[expected.name] = decoded;
  }
  const challengeId = captured["challengeId"];
  const version = captured["version"];
  if (challengeId === undefined || version === undefined) {
    // 结构性不可达:模板若不含这两个占位符,契约本身就不成立。
    return null;
  }
  return { challengeId, version };
}

/**
 * 换票回跳页的**规范路径**(E2E / 调试用;与契约模板同源)。
 *
 * 生产路径上页面从不构造它——地址由服务端签发(D-LT-1),302 的 Location 也由
 * 服务端产出。此函数存在的唯一理由是让冒烟测试能构造**合法**地址,而不是在
 * 测试里手拼一份可能漂移的字面量。
 */
export function launchRedeemPath(challengeId: string, version: string): string {
  const values: Readonly<Record<string, string>> = { challengeId, version };
  const rendered = TEMPLATE_SEGMENTS.map((segment) => {
    if (segment.kind === "literal") {
      return segment.value;
    }
    const value = values[segment.name];
    if (value === undefined) {
      // 结构性不可达:占位符名不在这两个已知键内 ⇒ 契约模板变了,而调用方
      // 没有跟上。抛错优于静默产出错误地址(测试会立刻发现)。
      throw new Error(`启动地址模板含未知占位符:${segment.name}`);
    }
    return encodeURIComponent(value);
  });
  return `${SEGMENT_SEPARATOR}${rendered.join(SEGMENT_SEPARATOR)}`;
}
