/**
 * 启动票据契约族的**形态常量**(WP-90;D-LT-1 ~ D-LT-4,草案 §二 / §六 / §七)。
 *
 * 本文件只承载**跨 WP 共享的字面量**(签发路由 / 换票路径模板 / 票据查询参数名 /
 * 票据令牌长度):WP-91(签发与换票实现)与 WP-92(`apps/page-app`)按这些常量
 * 引用,**不得各自复制字面量** —— 两处写同一字面量即产生漂移面(「改一处忘了
 * 另一处」正是本仓库反复踩过的缺陷族)。
 *
 * **为什么这些常量在契约包而不是实现包**:它们合起来就是「**地址即授权入口**」
 * 这一对外形态 —— 票据如何随地址承载(`?t=`)、换票路径长什么样、签发端点在哪。
 * 形态变更(改载体 / 改路径 / 改参数名)= 对外契约变更,须走 WP-1 §1.3 流程。
 * 与 `EMBED_TOKEN_ISSUANCE_ROUTE` 的差异只在**登记位置**而非性质:后者历史上落在
 * 实现包(`apps/session-api/src/auth/plugin.ts`),本族按 D-LT-1「契约面颗粒度」
 * 裁定在契约包内**单源**登记。
 *
 * **不在此文件的数值护栏**:`LAUNCH_URL_MAX_LENGTH` /
 * `MAX_LAUNCH_TICKET_TTL_SECONDS` / `DEFAULT_LAUNCH_TICKET_TTL_SECONDS` 落
 * `../common/limits.ts` —— 沿该文件既有惯例:协议级数值上限(如
 * `MAX_EMBED_TOKEN_TTL_SECONDS`)与「带上限的缺省值」(如
 * `MAX_BYTES_PER_RANGE_DEFAULT`)统一在那一处登记(该文件头已声明其定位为
 * 「协议级资源护栏常量」)。
 */

/**
 * 启动票据签发端点(WP-90 契约族;草案 §六,主控裁定 §〇.1 第 3 项)。
 *
 * `POST /auth/launch-tickets`:平台后端以宿主凭证(`SESSION_API_HOST_BACKEND_TOKEN`)
 * 换取一次性启动地址。承继 `EMBED_TOKEN_ISSUANCE_ROUTE = "/auth/embed-tokens"` 的
 * 位置与鉴权姿态;后者随嵌入协议面**整体退役**(不保留过渡别名,硬切)。
 */
export const LAUNCH_TICKET_ISSUANCE_ROUTE = "/auth/launch-tickets";

/**
 * 换票路径模板(草案 §七,D-LT-2「换票路由」行)。
 *
 * 换票**不是独立 API**:由页面服务端在 `GET /app/c/:challengeId/:version?t=<ticket>`
 * 内完成(校验 → 原子消费 → 签发会话凭证 → 302 抹除票据)。`:challengeId` 与
 * `:version` 是**公开导航信息**(一题一址),与请求体同源同义。
 *
 * 模板中的两个占位符由 WP-91 / WP-92 填值;字面量单源在此,避免两处各写一份。
 */
export const LAUNCH_TICKET_REDEEM_PATH_TEMPLATE = "/app/c/:challengeId/:version";

/**
 * 票据在启动地址中的查询参数名(?t=<ticket>;D-LT-2 承载方式 = **方案 A**)。
 *
 * 方案 A = query + 服务端立即消费 + 302 抹除:换票全程在服务端完成,页面 JS
 * 不参与 ⇒ 票据不在不可信侧被处理。**代价已登记**:票据会进服务端访问日志 ⇒
 * 应用侧日志脱敏为强制机检项(D-LT-3),反代侧脱敏为运维硬要求(部署指南)。
 */
export const LAUNCH_TICKET_QUERY_PARAM = "t";

/**
 * 票据令牌的 base64url 字符长度(恰 22)。
 *
 * **推导**:22 × 6 = **132 bit ≥ 128 bit**,即「≥128 bit CSPRNG 的 base64url 编码」
 * 的最小整数长度(21 字符 = 126 bit,不足)。与嵌入协议的 `sessionId`
 * `minLength: 22`(同一条 128 bit 熵下限的编码长度,WP-1 清单 §6.4)同值同推导 ——
 * 两族各自独立冻结,不共享常量(嵌入协议整体退役,不得为省一个常量引入耦合)。
 *
 * **本值不进 JSON Schema**:票据令牌本身**不是契约字段**(D-LT-1:票据是不透明
 * 持有证明,不签发、不解析 claims ⇒ 不新增 claims Schema),它只作为生成器与
 * 实现面的长度锚点存在;契约面承载它的是 `LaunchTicketResponse.launchUrl`
 * (不透明字符串)与 `LAUNCH_TICKET_QUERY_PARAM`。
 */
export const LAUNCH_TICKET_TOKEN_LENGTH = 22;
