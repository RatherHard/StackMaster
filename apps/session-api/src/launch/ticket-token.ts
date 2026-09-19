/**
 * 启动票据令牌的生成、形态校验与 Redis 键派生(WP-91;D-LT-2「熵 / 编码」行;
 * 设计全文 = `docs/develop/启动票据契约设计草案.md` §四 / §五)。
 *
 * **本模块是票据令牌的域内单一来源**:生成、形态校验、键派生三件事只在这里
 * 定义一次。其余位置(签发路由 / 换票路由 / 存储适配器)一律引用本模块,
 * **不得各自写一份** —— 「同一形态两处各写一份」正是本仓库反复踩过的缺陷族。
 *
 * 三条硬性口径:
 *
 *  1. **票据是不透明持有证明**(D-LT-1):**不签发、不解析 claims**、不携带
 *     任何可读语义。因此本模块**没有** encode / decode —— 票据的全部含义都在
 *     服务端存储记录里(«服务端存绑定»),令牌本身只是一段高熵随机字节。
 *     这与 `embedToken`(签名载荷、需跨语言校验 claims)是**结构性不同的东西**。
 *  2. **熵 ≥ 128 bit**(D-LT-2):`LAUNCH_TICKET_ENTROPY_BYTES` = 16(= 128 bit),
 *     经 base64url 无填充编码后**恰 22 字符** = 契约常量
 *     `LAUNCH_TICKET_TOKEN_LENGTH`。生成后**自检长度**,漂移即抛错
 *     (fail-closed:不静默产出一个形态不符的票据)。
 *  3. **令牌值禁入日志 / URL 之外的任何通道**(D-LT-3):它只在 `launchUrl`
 *     的 `?t=` 内交付;`redactRequestUrl`(logger.ts)负责它不落访问日志。
 */
import { randomBytes } from "node:crypto";
import { LAUNCH_TICKET_TOKEN_LENGTH } from "@stackmaster/protocol";

/**
 * 票据令牌的 CSPRNG 熵字节数(**16 字节 = 128 bit**,D-LT-2 下限的**恰好**
 * 取值,不是"取大了更安全"的宽松值)。
 *
 * **为什么恰是 16**:base64url 无填充编码的字符数 = `ceil(4n/3)`,其中
 * `n mod 3 == 1` 时尾组占 2 字符:
 *  - `n = 16`:16 mod 3 = 1 ⇒ 5 组 × 4 + 2 = **22 字符** ⇒ 与契约常量
 *    `LAUNCH_TICKET_TOKEN_LENGTH`(22)**逐字相等**;
 *  - `n = 17`:17 mod 3 = 2 ⇒ 5 组 × 4 + 3 = 23 字符 ⇒ 比契约常量长 1
 *    (实测确认:23 字符),会与 `LaunchTicketResponse.launchUrl` 的长度预期漂移。
 *
 * 故 16 是「满足 ≥ 128 bit 且编码长度恰等于契约常量」的唯一取值;
 * 嵌入协议的 `sessionId` 用同一条 128 bit 下限(其 `minLength: 22` 同值),
 * 但两族**各自独立冻结**,不共享常量(D-LT-2 明示)。
 */
export const LAUNCH_TICKET_ENTROPY_BYTES = 16;

/**
 * 票据令牌的**形态护栏**上限(字符;D-LT-2「长度上限 ≈ 128 字符(护栏)」)。
 *
 * 与 `LAUNCH_TICKET_TOKEN_LENGTH`(22,生成面的**精确**长度)**用途不同**:
 *  - 22 是**生成面**的不变量(我们产出的令牌恒为 22);
 *  - 128 是**消费面**的入站护栏 —— 入站令牌是攻击者可控输入,先按长度裁掉
 *    超长形态再进 Redis(避免把任意长字符串当键用)。它**不是**"合法令牌可以
 *    长到 128":任何长度 ≠ 22 的入站令牌在形态校验即被拒(见
 *    `isLaunchTicketTokenShape`),128 只是"连形态校验都不值得跑"的粗闸。
 */
export const LAUNCH_TICKET_TOKEN_MAX_LENGTH = 128;

/**
 * 令牌字符集(base64url 无填充:`A-Z a-z 0-9 _ -`;无 `=` 填充字符)。
 *
 * 与 Node `Buffer.toString("base64url")` 的输出形态一致(实测:16 字节 →
 * 22 字符、零填充)。用它做**入站形态校验**:非本字符集的令牌不会是我们签发的,
 * 在触碰存储之前即拒绝(零存储面探测、零日志面注入)。
 */
const TOKEN_SHAPE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 生成一枚启动票据令牌(≥128 bit CSPRNG;**base64url 22 字符**)。
 *
 * 每次调用独立取熵(`randomBytes` 是 CSPRNG,非可预测伪随机)——票据的
 * 不可猜测性是其全部安全性来源(不签名、不携带 claims),故这里**不得**
 * 引入任何可复现的 seed 通道(与 VM 域「题目随机化用服务端可复现 seed」的
 * 纪律**不冲突**:那是判题确定性,这是凭证不可预测性,两者的要求正好相反)。
 *
 * @throws Error 编码长度与契约常量 `LAUNCH_TICKET_TOKEN_LENGTH` 不一致时
 *   (契约漂移 = 实现事故,不静默降级;与 `issueSessionCredential` 的长度
 *   自检同纪律)。
 */
export function generateLaunchTicketToken(): string {
  const token = randomBytes(LAUNCH_TICKET_ENTROPY_BYTES).toString("base64url");
  if (token.length !== LAUNCH_TICKET_TOKEN_LENGTH) {
    throw new Error(
      `生成的启动票据令牌长度为 ${token.length},与契约常量 ${LAUNCH_TICKET_TOKEN_LENGTH} 不一致(契约漂移)`,
    );
  }
  return token;
}

/**
 * 入站令牌形态校验(纯函数;**不触碰存储**):非字符串 / 空 / 超粗闸上限 /
 * 含非 base64url 字符 ⇒ false。
 *
 * 用途 = 换票路由的第一步粗筛(在 Redis 之前)。**注意它不返回「这枚票据
 * 是否合法」** —— 形态合法只说明"它长得像我们签发的",是否签发过 / 是否已
 * 消费 / 是否过期这三种"无有效记录"形态**只能**由原子消费面回答,且三者在
 * 响应面**逐字节同形**(D-LT-2「换票路由」行;防枚举)。
 */
export function isLaunchTicketTokenShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LAUNCH_TICKET_TOKEN_MAX_LENGTH &&
    TOKEN_SHAPE_PATTERN.test(value)
  );
}

/**
 * `launch:{jti}` 键域前缀(权威 API 语义规约的 Redis 键域表登记项;
 * 分级 = **fail-closed**,见 `persistence/idempotency-window.ts`)。
 */
export const LAUNCH_TICKET_KEY_PREFIX = "launch:";

/**
 * 票据 → Redis 键(`launch:{jti}`;D-LT-2「绑定」行)。
 *
 * 令牌分量经 `encodeURIComponent` 编码保形(与幂等键 / `token:{jti}` /
 * `cred-revoked:{jti}` 同一防键分隔符注入纪律,D-API-24)。对 base64url 字符集
 * 该编码恒等(`-` / `_` 不受影响,实测),故零语义差异 —— 它是纵深防御,
 * 使得即使未来字符集放宽也不会出现键跨越。
 *
 * 键域**禁止** `KEYS` 类全扫(D-LT-3「不做」清单):一切访问按键点查。
 */
export function launchTicketKey(token: string): string {
  return `${LAUNCH_TICKET_KEY_PREFIX}${encodeURIComponent(token)}`;
}
