/**
 * LaunchTicketResponse —— 启动票据签发响应载荷(WP-90 冻结;D-LT-1 / D-LT-2)。
 *
 * `POST /auth/launch-tickets` 的响应体,**恰两键**(strictObject:`launchUrl` /
 * `expiresAt`)。设计全文 = `docs/develop/启动票据契约设计草案.md` §二 / §六,
 * 字段分类论证 = `docs/contracts/数据分类与秘密零驻留清单.md` §6.12。
 *
 * 三条硬性语义(逐字遵守 D-LT-1 / D-LT-2):
 *
 *  1. **票据值只在 `launchUrl` 内,响应不另回票据字段**。票据是不透明持有
 *     证明(≥128 bit CSPRNG 的 base64url 22 字符),**不签发、不解析 claims**
 *     ⇒ 本族**没有** claims Schema(与 `EmbedTokenClaims` 的关键差异:后者是
 *     签名载荷、需跨语言校验)。多回一个 `ticket` / `jti` 字段只会把同一个
 *     秘密复制到第二个可被日志与前端缓存捕获的位置 ⇒ 契约层无此表达位。
 *  2. **不携带 `protocolVersion` 字段**(D-LT-1「不做」清单第 7 项):N-1 受理
 *     是**路由级事实**,回显版本判定细节即扩大探测面 —— 沿 `HostScoresResponse`
 *     / `VerdictQueryResponse` / `SessionCommandResponse` 先例,契约版本由
 *     `$id` 命名空间 `…/schemas/launch-ticket/v1` 承载。
 *  3. **不携带 tenantId / userId**(6.2):租户由宿主凭证 ×
 *     `SESSION_API_HOST_TENANTS` 白名单在服务端派生,响应回显租户只扩大
 *     跨租户探测面而无任何用途(D-API-124 同款论证)。
 *
 * 分类 = `BOUNDARY`(整体):载荷跨边界(服务端 → 平台后端 → 学习者浏览器),
 * 逐字段值来源 = 服务端生成的绝对地址 + 服务端时钟,零判题秘密派生。
 */
import { z } from "zod";
import { LAUNCH_URL_MAX_LENGTH } from "../common/limits.js";

/**
 * 启动地址形态:`http(s)` **绝对** URL(含 scheme 与 authority,不含空白)。
 *
 * 用 `pattern` 而非 `z.url()`(`format: "uri"`)是**跨语言一致性的硬要求**:
 * 本仓库的 JSON Schema 消费方(Rust `jsonschema`)默认**不校验 format**,而 TS
 * 侧 `z.url()` 会校验 ⇒ 用 format 会出现「TS 拒、Rust 收」的分歧,违反契约纪律
 * 5.6「同一组样例必须被 TS 与 Rust 校验器同时接受或拒绝」。pattern 两侧都强制。
 *
 * 允许 `http` 是**有意**的:开发 / 集成拓扑的启动地址是
 * `http://127.0.0.1:13000/app/...`(同源反代下生产为 `https`),契约不该把本地
 * 拓扑判成非法;拒绝的是**相对地址**与**无 scheme 的伪地址**(`javascript:` 等
 * 无 `//` 的形态同样被本 pattern 排除)。
 */
const LAUNCH_URL_PATTERN = /^https?:\/\/[^\s]+$/;

/**
 * 签发响应体(恰两键:`launchUrl` / `expiresAt`;D-LT-1)。
 */
export const LaunchTicketResponseSchema = z.strictObject({
  /**
   * 一次性启动地址(**绝对 URL**,携带票据于 `?t=` 查询参数;D-LT-2 方案 A)。
   *
   * 长度上限 = `LAUNCH_URL_MAX_LENGTH`(2048;取值依据见 `common/limits.ts`
   * 该常量注释:2048 是 URL 在浏览器 / 反代 / 访问日志链路上的事实性公共上限,
   * 而本族最坏形态仅 ≈ 300 字符 ⇒ 上限是外圈护栏而非约束)。
   */
  launchUrl: z
    .string()
    .min(1, "启动地址不得为空")
    .max(LAUNCH_URL_MAX_LENGTH, `启动地址超过最大长度 ${LAUNCH_URL_MAX_LENGTH}`)
    .regex(LAUNCH_URL_PATTERN, "启动地址必须是不含空白的 http(s) 绝对 URL"),
  /**
   * 票据过期时刻:Unix epoch 秒(UTC)。签发 TTL 缺省
   * `DEFAULT_LAUNCH_TICKET_TTL_SECONDS`(300)、天花板
   * `MAX_LAUNCH_TICKET_TTL_SECONDS`(3600),两者见 `common/limits.ts`;
   * Redis TTL 与响应回显值**同值**(D-LT-2「有效期」行)。
   */
  expiresAt: z.number().int().min(0),
});

export type LaunchTicketResponse = z.infer<typeof LaunchTicketResponseSchema>;
