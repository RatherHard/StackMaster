/**
 * 题目内容版本格式常量(格式常量,**非**凭证解析器)。
 *
 * 题目内容版本格式:与 @stackmaster/challenge-schema 的 SEMVER_PATTERN_SOURCE
 * 同一冻结格式(`X.Y.Z`)。本包不得依赖工作区包(5.5),故在此以同一字面量
 * 重复冻结;格式变更属契约变更,两端必须同步(CI golden fixture 覆盖)。
 *
 * **迁移留档(2026-09-19,分发改版 WP-96)**:本常量原定义于
 * `src/embed/embed-token-claims.ts`。嵌入协议契约面(`EmbedTokenClaims` /
 * `EmbedMessage`、`EMBED_PROTOCOL_VERSION` / `EMBED_SCHEMA_BASE_ID`)随退役面
 * **同批物理删除**,但本常量**不是**嵌入协议语义的一部分 —— 它是题目内容版本的
 * **格式常量**,被会话动作协议请求(v2 `create_session` 载荷)、会话凭证 claims、
 * 启动授权凭证 claims、启动票据签发请求、调试变体镜像与宿主成绩同步响应共同
 * 复用 ⇒ 迁到中立位置 `src/common/`(与 identifiers / limits 同层),
 * **正则源码逐字不变**(逐字冻结:`^[0-9]+\.[0-9]+\.[0-9]+$`),
 * 且**双入口可达性照旧**:包入口 `@stackmaster/protocol` 与子路径
 * `@stackmaster/protocol/server-only` 都导出它(它是格式常量,不受
 * 「凭证解析器不给浏览器」的导出面纪律约束)。
 *
 * 机检锚:`test/challenge-content-version.test.ts` 断言本常量的字面值逐字冻结、
 * 且**全仓只有这一处正则源码**(禁复制第二份字面量);launch-ticket 契约测试同款。
 */

export const CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE = "^[0-9]+\\.[0-9]+\\.[0-9]+$";
