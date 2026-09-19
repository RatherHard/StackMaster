# k6 归档读数(逐次采集一个目录)

本目录存放 `pnpm --filter @stackmaster/session-api k6:baseline` 的**归档读数**:
每个子目录 = 一次采集,内含逐场景原始 summary JSON(`<scenario>.json`)+ stderr
留档 + 采集前 / 后 `/metrics` 快照 + `summary.md`(人读摘要)。

## ⚠ 链路口径分两代,**不可并列解读**(WP-96 分发改版)

| 归档 | 链路 | 说明 |
|---|---|---|
| `2026-09-09T223628898Z/`、`2026-09-12T130117550Z/`、`2026-09-12T134452996Z/` | **旧链(已退役)** | `POST /auth/embed-tokens` + `create_session` 四键载荷(含 embed token),`protocolVersion: 1` |
| 之后新采集的目录 | **启动地址链** | `POST /auth/launch-tickets` → 换票 302 + `sm_launch_grant` Cookie → `create_session` **恰两键**、`protocolVersion: 2`;summary JSON 里带 `chain: "launch-address/v2"` |

**两代读数为什么不可比**(不是"数字变了",而是负载模型变了):

- 旧链的 `userId` 由请求体自报 ⇒ 脚本按「**每迭代唯一用户**」规避每用户预算削顶;
- 新链的 `userId` 由服务端配置派生(`SESSION_API_LAUNCH_USER_ID`,缺省
  `launch-anon`,D-LT-5 第 6 条)⇒ **同一部署下全部会话共用一条**
  `rate:{tenant}:{user}` 预算,签发另有一条 `rate:{锚租户}:launch_tickets`
  (缺省 60/min)⇒ 三场景改为按**共享预算均摊节奏**运行(summary JSON 的
  `minIterationMs` 即该节奏)。

故:**旧目录是历史证据,只增不改**(它们记录的是已退役链路的读数);新链的
T2 触发判据须以**新采集**为准。退役面清单见
`docs/contracts/启动票据协议.md` §七 与 `CLAUDE.md` 的 WP-96 段。
