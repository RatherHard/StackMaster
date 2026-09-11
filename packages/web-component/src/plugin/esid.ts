/**
 * esid 一次性读取(嵌入协议 §4.1 插件侧行为要点;D-API-75 通道 a 前置)。
 *
 * iframe 文档加载后从 `location.fragment` **一次性**读取 `#esid=<esid>`:
 *  - 无权限语义:esid 只是握手认证值(知识证明,V-5),不是凭证;
 *  - 一次性:读后只存进程内存,不写入任何持久化(硬门槛:fragment 不进
 *    浏览器历史之外的任何存储);
 *  - fragment 非 esid 形态 / 缺失 → 返回 null(调用方直接降级显示,
 *    不发起握手、不发起任何取回请求)。
 *
 * 校验复用 embed-runtime 的 `validateEmbedSessionId`(Q4 定案:esid 校验
 * 无状态构件单实现双侧消费;其内部锚点 = protocol EmbedSessionIdSchema,
 * 熵下限 22 字符在契约层拒绝短值)。
 */
import { validateEmbedSessionId } from "@stackmaster/embed-runtime";

/** fragment 中 esid 的定位模式:`#esid=` 开头或 `&esid=` 跟随;值须到参数尾。 */
const ESID_FRAGMENT_PATTERN = /(?:^#|&)esid=([A-Za-z0-9_-]{22,128})(?=&|$)/;

/**
 * 从 URL fragment(含前导 `#`,或 null 表示无 fragment)提取并校验 esid。
 * 返回 null = fragment 缺失 / 非 esid 形态(降级显示路径)。
 */
export function readEmbedSessionIdFromFragment(fragment: string | null): string | null {
  if (fragment === null || fragment === "") {
    return null;
  }
  const match = ESID_FRAGMENT_PATTERN.exec(fragment);
  const candidate = match?.[1];
  if (candidate === undefined) {
    return null;
  }
  try {
    return validateEmbedSessionId(candidate);
  } catch {
    // 形态不符(长度 / 字符集):与缺失同路径降级,零回显差异(V-12 同纪律)。
    return null;
  }
}
