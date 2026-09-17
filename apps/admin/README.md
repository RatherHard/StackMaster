# @stackmaster/admin —— 管理面最小只读面(WP-79;D-MP-5 分支 A)

信任域 4 的**第三个独立应用**:题目登记列表 / 裁决查询 / 成绩导出三张**只读**面。
独立凭证、独立网络域、独立部署,**不入插件链路**(零浏览器可达面)。

## 结构底线(硬约束,勿"优化"掉)

| 约束 | 兑现方式 |
|---|---|
| **凭证独立**(计划书 `:807`) | `ADMIN_CREDENTIAL_SHA256`(只存摘要)+ `Authorization: Bearer`;零复用会话凭证 / `SESSION_API_HOST_BACKEND_TOKEN`;控制台页凭证只在内存(零 Cookie / 零 Web Storage / 零 URL 参数) |
| **网络与部署独立** | 自有网络域 `admin-net` + 自有发布端口(dev `13200:3200`);CSP `frame-ancestors 'none'`,零宿主来源白名单 |
| **凭证 × 租户绑定**(O-MP-6 同源) | `ADMIN_TENANTS` 白名单;**空 / 缺失 ⇒ 数据面整体 404 同形**(fail-closed);`?tenant=` 只能在集合内子选;跨租户与不存在**同形** |
| **数据面只读**(D-API-135) | 自有只读 PG 角色 `admin_ro` 直连;**零 app→app 依赖**;四层只读(端口面 / 语句护栏 / 授权面 / RLS 仅 SELECT 政策) |
| **契约复用** | 成绩导出逐字过 `HostScoresResponseSchema.parse()`(WP-78 契约);裁决逐条过 `VerdictQueryResponseSchema`;登记值过 `@stackmaster/challenge-schema` 的公开模式源 |
| **审计**(D-API-136) | 受控日志 + 指标计数(**不新增审计 kind**:十值封闭集);**披露点 fail-closed**(审计失败 ⇒ 503 零下发) |

## 端点

| 面 | 路由 | 说明 |
|---|---|---|
| 运维 | `GET /healthz` / `GET /readyz` / `GET /metrics` | 探针失败 503 冻结且失败方不透出;指标标签零标识符 |
| 数据 | `GET /admin/challenges` | 题目登记列表(`?tenant=` / `?limit=`) |
| 数据 | `GET /admin/verdicts` | 裁决查询(`?tenant=` / `?limit=` / `?submissionId=` / `?challengeId=` / `?since=` / `?until=`;有界窗口 + `truncated`) |
| 数据 | `GET /admin/scores` | 成绩导出(WP-78 契约;`?cursor=` keyset 分页) |
| 只读页 | `GET /` + `/admin.js` + `/admin.css` | 最小只读控制台(语义化 DOM;非 vm-ui 交付面) |

冻结拒绝面:401 `authentication failed` / 404 `resource not found` / 400 `invalid request` /
429 `rate limit exceeded` / 503 `storage unavailable`(审计失败为同族 503)。

## 配置(三道闸:缺必备键 / 未知保留键 / 越天花板一律拒绝启动)

| 键 | 缺省 | 说明 |
|---|---|---|
| `ADMIN_POSTGRES_URL` | **必备** | `admin_ro` 连接串(只读角色) |
| `ADMIN_CREDENTIAL_SHA256` | **必备** | 凭证 sha256(小写十六进制 64 位);明文不入配置 |
| `ADMIN_TENANTS` | 空 | 逗号分隔绑定租户白名单;空 = 数据面整体 404 |
| `ADMIN_HOST` / `ADMIN_PORT` | `0.0.0.0` / `3200` | 监听面 |
| `ADMIN_LOG_LEVEL` / `ADMIN_LOG_ERROR_STACKS` | `info` / `false` | 受控日志 |
| `ADMIN_GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS` | `10` | 停机看门狗 |
| `ADMIN_SCORES_BATCH` | `100`(天花板 `500`) | 成绩单页条数 |
| `ADMIN_RATE_LIMIT_PER_MINUTE` | `120`(天花板 `6000`) | 每客户端 IP 固定窗口 |

## 命令

```sh
pnpm --filter @stackmaster/admin typecheck       # tsc -b + 测试面 typecheck
pnpm --filter @stackmaster/admin test            # 单元 / 服务级(零容器)
pnpm --filter @stackmaster/admin test:integration # 容器门控(需 docker compose deps;SESSION_API_IT=1)
pnpm --filter @stackmaster/admin build           # tsc -b
pnpm --filter @stackmaster/admin start           # node dist/index.js
```

**待应用片段**(本 WP 无权限改动的三个文件):`compose/db-roles-init.sql`(`admin_ro` 建角)、
`compose/deps.yaml`(db-roles-init 健康探针角色数 2 → 3)、`compose/app.yaml`(`admin` 服务 +
`admin-db-init` + `admin-net` + postgres 三宿)。逐字片段与插入位见
`docs/develop/decisions-m3/WP-79.md` §待应用片段。片段应用前,容器门控用例自行引导角色
(`test/helpers/it.ts#ADMIN_ROLE_BOOTSTRAP_SQL`),可独立复跑。

## 决策台账

D-API-134(独立凭证 + 租户绑定)/ D-API-135(只读数据面 + 契约复用 + 三面语义)/
D-API-136(审计落点与披露点 fail-closed)——全文见 `docs/develop/decisions-m3/WP-79.md`。
