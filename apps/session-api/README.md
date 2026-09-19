# apps/session-api 开发上手(session-api 会话编排器;信任域 2)

本文是 `apps/session-api` 的开发上手文档(阶段三 WP-8 交付):环境准备、一键
拓扑、测试入口、常见问题与 Windows 降级路径。语义与决策的权威来源:
`docs/develop/权威API语义规约.md`(D-API-*);部署拓扑依据计划书 5.8 / 5.3。

## 一、环境准备

- Node.js ≥ 22、pnpm(packageManager 见根 package.json)、Docker + Compose;
- 本机 cargo(可选):host 混合拓扑需要本机 `vm-worker` 二进制
  (`cargo build -p vm-worker --manifest-path vm-engine/Cargo.toml`,产物在
  `vm-engine/target/{debug,release}/`);完整容器拓扑则不需要本机 cargo;
- 首次:`pnpm install` && `pnpm build`(turbo 全图;session-api 的
  `dist/` 与 workspace 依赖就位)。

## 二、Compose 一键拓扑(推荐;计划书 5.8 dev 定义)

全拓扑 = PostgreSQL 16 + Redis 7 + MinIO + session-api + vm-worker
(vm-worker 不是常驻服务:由编排器按会话 spawn,ADR-3;compose 中的
`vm-worker` 服务是一次性 linux 二进制冒烟,显式触发,不参与 `up --wait`,
D-API-64):

```bash
pnpm --filter @stackmaster/session-api compose:app:up     # up -d --build --wait(等 healthcheck)
#   session-api → http://127.0.0.1:13000(/healthz /readyz /metrics)
#   启动地址链:POST /auth/launch-tickets(宿主凭证)→ GET /app/c/:id/:version?t=<票>
#   → 302 + sm_launch_grant Cookie → 页面(同源托管 apps/page-app/dist)
#   PostgreSQL 15432 / Redis 16379 / MinIO 19000(控制台 19001)
pnpm --filter @stackmaster/session-api compose:app:down   # down -v(含数据卷)
```

> **页面产物由本服务同源托管**(WP-92/96):`compose/app.yaml` 把宿主
> `apps/page-app/dist` 只读挂进容器并显式配 `SESSION_API_PAGE_APP_DIR`(镜像
> 不构建 page-app)。宿主未构建 page-app 时 Docker 会建出空目录 ⇒ 静态面注册
> 零路由、容器照常启动、换票不受影响(只是没有页面可看)。人工走查前先:
> `pnpm --filter @stackmaster/vm-ui build && pnpm --filter @stackmaster/page-app build`。

- 首次构建耗时主要在 Rust 阶段(容器内构建 linux vm-worker);
  `WORKER_CARGO_PROFILE` 缺省 `debug`(控制本地时长),CI 传 `release`
  (D-API-64);Rust 源码未变时该层走构建缓存,增量构建很快;
- 迁移**自动执行**:session-api 启动序列自带 `runMigrations`
  (失败即拒绝启动,fail-closed;无需手工迁移步骤);
- 凭据与密钥(`compose/app.yaml` / `compose/integration.env`)全部是本地
  dev / CI 专用合成值,**严禁用于任何真实环境**;
- 纯依赖服务(不含 session-api):`compose:deps:up` / `compose:deps:down`。

**角色引导 = deps 面(WP-78 / WP-79 收口;全新数据卷一次收敛)**:迁移 007 以
`CREATE POLICY ... TO session_app / TO verifier` 引用两个应用连接角色,故
**任何执行迁移的路径都必须先有角色**。拓扑内角色创建的唯一来源 =
`db-roles-init`(**服务定义在 `compose/deps.yaml`**,脚本
`compose/db-roles-init.sql`,镜像 `postgres:16`,`restart: "no"` **零授权语句**)
—— 它只依赖 `postgres`,又为「跑迁移的两条路径」共用,故属 deps 面;`app.yaml`
**只引用不重复定义**该服务。分层:

| 面 | 文件 | 职责 |
|---|---|---|
| deps 面 | `compose/deps.yaml` → `db-roles-init`(`db-roles-init.sql`) | **角色创建**(session_app / verifier;口令唯一来源;只读属性断言:非 superuser / 非 bypassrls) |
| deps 面 | postgres / redis / minio | 依赖服务本体 |
| app 面 | `session-api-db-init.sql` / `verifier-db-init.sql` | **授权面**(GRANT / REVOKE 按角色分域;已零 `CREATE ROLE`) |
| app 面 | session-api / verifier / vm-worker | 应用与执行域 |

两条路径都一次收敛(`--wait` 语义见下方注):

```text
# ① deps-only(host 拓扑 / test:integration / SESSION_API_IT=1 pnpm test:coverage 完整门禁形态)
docker compose -f compose/deps.yaml up -d --wait        # postgres healthy → db-roles-init healthy(角色在场),exit 0

# ② app 全拓扑(无环执行序)
postgres(healthy) → db-roles-init(healthy) → session-api(healthy)
  → session-api-db-init(exit 0) → verifier-db-init(exit 0) → verifier
```

- **`db-roles-init` 的形态 = 引导 + 健康锚**:引导语句(`psql -f
  db-roles-init.sql`)执行完即 `exec sleep infinity`,健康探针语义 = 两个角色
  在场且非 superuser / 非 bypassrls。这不是「跑完即退」的一次性容器,原因是
  compose `up --wait` 对**无依赖方**的一次性容器判为失败(实测 compose
  2.40.3:`container session-api-deps-db-roles-init-1 exited (0)` → exit 1),
  而 deps-only 的 `up -d --wait` 有四个消费方(session-api / verifier 的 IT
  `globalSetup`、`test:compose` host 形态、文档化的 `compose:deps:up`);
- `session-api` → `db-roles-init: service_healthy`(迁移前置;强于
  `service_completed_successfully`:校验角色属性而非仅校验 psql 退出码);
- `verifier-db-init` → `session-api-db-init: service_completed_successfully`
  —— 两个角色治理 init 的 `GRANT` / `REVOKE` 会写同一批 PG 目录行(public
  schema `nspacl` + 动作 / 审计账 `relacl`),并发执行偶发
  `ERROR: tuple concurrently updated`(症状 = 同一次 `up` 中随机一方失败),
  串行化后同一 `up` 内不存在并发目录写;
- 两个治理 init 的授权语义零变化;角色缺席时它们以
  `ERROR: role "..." does not exist` 确定性失败(引导缺席的显式红灯,不再有
  兜底守卫掩盖)。PG 角色是**集群级**对象,故 deps 面引导对测试的 scratch 库
  同样成立;
- **host 降级形态的判据随之变化**:deps-only 下角色在场但**授权面缺席**
  (两个治理 init 属 app 面)⇒ `test:compose` host 形态的两条角色/RLS 红灯
  用例按「授权面未就位」跳过并如实登记;container 形态(全拓扑)实跑。

### 环境变量

session-api 的配置走 `SESSION_API_*` 环境变量,三道闸校验(必备键缺失 /
未知保留键 / 取值非法,任一不过即拒绝启动,D-API-9)。完整键表与语义:
`docs/develop/权威API语义规约.md` 的 D-API-9 / D-API-19 / D-API-39 /
D-API-58 / D-API-70(必备六键:签发密钥、宿主共享凭证、PG / Redis /
MinIO 端点与快照加密密钥;其余有缺省值)。compose 拓扑的键值集中在
`compose/app.yaml`;宿主进程形态的键值在 `compose/integration.env`。

**分发改版(WP-96)新增的三个键 —— 启动地址链的开面条件**:

| 键 | 缺省 | 语义与纪律 |
|---|---|---|
| `SESSION_API_PUBLIC_ORIGIN` | **null(签发面未启用 ⇒ `POST /auth/launch-tickets` 一律 404 同形)** | 启动地址与**页面 origin** 的共同来源(签发端点永不采信 `Host` 头)。值必须是**浏览器实际访问的源**;`sm_launch_grant` 是 `SameSite=Strict`,`localhost` 与 `127.0.0.1` 不同源 ⇒ 该值必须与 `SESSION_API_ALLOWED_ORIGINS` 里的页面 origin **逐字同源** |
| `SESSION_API_PAGE_APP_DIR` | 未设 ⇒ 用仓库内 `apps/page-app/dist`(存在即托管、不存在即不注册) | **显式配了却指不到目录 ⇒ 拒绝启动**(fail-closed)。人工走查页面形态时,它必须指向已构建的 page-app 产物 |
| `SESSION_API_HOST_TENANTS` | 空 ⇒ 宿主成绩面与**签发面**整体 404 | 兼作启动地址链的**锚租户**(字典序最小项):会话租户恒等于它,而 `create_session` 的题目装载按 `(challengeId, version, tenantId)` 强制过滤 ⇒ **要被启动地址链加载的题目必须登记在该租户下**(k6 种子脚本据此派生登记租户) |


## 三、常用命令

| 命令 | 说明 |
|---|---|
| `pnpm --filter @stackmaster/session-api build` | `tsc -b` 构建 dist |
| `pnpm --filter @stackmaster/session-api typecheck` | 构建 + 测试类型双检 |
| `pnpm --filter @stackmaster/session-api test` | 单元 + 内存同构集成(vitest;容器门控集成测试自动跳过) |
| `pnpm --filter @stackmaster/session-api test:integration` | 容器门控集成(`SESSION_API_IT=1`,经 `--env-file` 注入依赖服务连接;需 deps 拓扑在运行) |
| `pnpm --filter @stackmaster/session-api test:compose` | Compose 拓扑集成(双形态,见下) |
| `pnpm --filter @stackmaster/session-api k6:baseline` | k6 基线首采(对运行中的全拓扑;见 §五) |
| `pnpm test:coverage`(仓库根;完整门禁形态 `SESSION_API_IT=1 pnpm test:coverage`) | TS 覆盖率(vitest projects 聚合 apps + packages;整体 ≥ 80%,四维门槛;IT 形态纳入容器门控集成测试) |
| `pnpm test:rust` / `pnpm lint:rust`(仓库根) | Rust 门禁(debug + release 双 profile / 纪律门禁) |

### test:compose 双拓扑形态(D-API-65)

- `container`(CI 形态,完整 linux 拓扑):
  `SESSION_API_TOPOLOGY=container pnpm --filter @stackmaster/session-api test:compose`
  ——构建镜像 → `up -d --build --wait` → vm-worker linux 冒烟 → vitest
  `test/compose`(全链路 + 跨域载荷机检零命中 + 编排器重启恢复)→ `down -v`;
- `host`(缺省;本机 Windows 降级形态):deps.yaml 依赖服务 + session-api
  宿主进程(`node dist/index.js`)+ 本机 worker 二进制
  (`STACKMASTER_WORKER_BIN` 或 `vm-engine/target/{debug,release}` 产物;
  重启语义 = SIGTERM 优雅停机冲刷后重新拉起)。

## 四、Windows dev 降级路径(任务分解 §六登记项)

vm-worker 是 linux 优先交付的执行域二进制:容器镜像内为 linux 构建
(Rust 阶段容器内编译);本机 Windows 侧有两条路径:

1. **host 混合拓扑(本机最快)**:`cargo build -p vm-worker
   --manifest-path vm-engine/Cargo.toml`(产物
   `vm-engine/target/debug/vm-worker.exe`)→ `compose:deps:up` → 手动以
   `compose/integration.env` + `REQUIRED_AUTH_ENV` 值域拉起宿主进程,或直接
   跑 `test:compose`(host 形态自动完成同样的装配)。`ensureWorkerBinary`
   的产物解析序(env → target/debug → target/release)对 Windows 产物
   天然兼容;
2. **完整容器拓扑(与 CI 同构)**:`compose:app:up`。本机 Rust 容器构建
   冷启动较慢(debug 档约数分钟,Rust 源码变更后需要重建该层);构建一次后
   增量很快。CI(`compose-integration` job)始终为完整 linux 拓扑 +
   `WORKER_CARGO_PROFILE=release`,即"Compose 仅承诺 linux 环境全功能"
   的保证面。

## 五、可观测面

- `GET /healthz` liveness(恒 200)/ `GET /readyz` readiness(PG / Redis /
  MinIO 探针,D-API-34)/ `GET /metrics` Prometheus 文本格式(D-API-70);
- 指标最小集五个族:动作 RTT(histogram,p50/p95)、并发会话数(gauge)、
  动作队列深度(gauge)、Worker 池占用(gauge)、投影增量字节数(histogram);
  标签纪律:零秘密、零标识符(会话 / 租户 / 用户只进受控日志),机检见
  `src/metrics/metrics.ts`(D-API-71);
- 日志:Pino 结构化 JSON(stdout);redaction 与字段纪律见 D-API-9;
- OpenTelemetry 全链路 span 为 T0 可选增量(仅登记决策,未实现,D-API-72)。

## 六、k6 基线首采(质量门禁 9)

前置:`compose:app:up` 已运行(或 host 形态等价,`BASE_URL` /
`HOST_BASE_URL` 指向宿主进程)。脚本在 `k6/`,经官方镜像 `grafana/k6`
执行(runner 免卷挂载:脚本经 stdin 传入容器):

```bash
pnpm --filter @stackmaster/session-api k6:baseline
```

- **链路(WP-96 起)= 启动地址链**:`POST /auth/launch-tickets`(宿主凭证;体恰两键)
  → `GET launchUrl`(**手工补 `Sec-Fetch-Mode: navigate`**、`redirects: 0` 不跟随
  302 ⇒ 接住 `Set-Cookie: sm_launch_grant`)→ `POST /sessions`
  `create_session`(**`protocolVersion: 2`,payload 恰两键**;授权来自 Cookie)→
  后续命令同版。**k6 没有浏览器**:导航头靠手工补、302 靠不跟随接住、`launchUrl`
  的 origin(服务端按 `SESSION_API_PUBLIC_ORIGIN` 派生)重新基到 `BASE_URL`;
  **票据绝不进日志与指标标签**(换票请求以静态路由模板打 tag)。**旧链
  `POST /auth/embed-tokens` 与四键载荷已随嵌入协议面退役**;
- 场景(`k6/scenarios/`):`action-rtt-wss.js`(启动地址链 → WSS stop-and-wait
  动作 RTT)、`rest-lifecycle.js`(REST 五命令全生命周期)、
  `concurrent-sessions.js`(阶梯并发维持 + /metrics 采样);
- ⚠ **负载模型已变,读数与旧基线不可比**:新链的 `userId` 是**部署级配置**
  (`SESSION_API_LAUNCH_USER_ID`,缺省 `launch-anon`,D-LT-5 第 6 条)⇒ 三场景
  共享同一 `(tenant,user)` 预算,旧脚本的「每迭代唯一用户」**结构性不可用**;
  场景因此按**共享预算均摊节奏**运行(签发 60/min、REST 120/min 两条预算取紧者;
  runner 从 `compose/integration.env` 自动对齐,**不为压测调低护栏**)。任一硬闸
  拒绝即让迭代失败(不静默跑在半数被拒的状态);
- **不设通过阈值**(10.3 / 13.6:数据作为 T2 触发判据基线,避免过早优化,
  D-API-73);
- 结果归档 `k6/results/<UTC 时间戳>/`:逐场景原始 summary JSON(含
  `chain: "launch-address/v2"` 与 `minIterationMs`)+ stderr 留档 + 采集前 / 后
  `/metrics` 快照 + `summary.md` 人读摘要;
- 首采记录(2026-09-10,本机 compose 容器拓扑,**旧链**):见
  `k6/results/2026-09-09T223628898Z/summary.md` 与
  `docs/phases/阶段三验收评审.md` §一.8 —— 该读数属**历史证据**,新链下须重采。

## 七、常见问题(FAQ)

- **启动即退出 / 配置校验失败**:看 stderr 单行 JSON 的 `issues`(只含字段
  名与原因,绝不含字段值,D-API-9)。compose 形态看
  `docker compose logs session-api`;
- **启动地址链 404 / 401(WP-96 起;旧链 `POST /auth/embed-tokens` 已退役)**:
  - `POST /auth/launch-tickets` **404 同形** = 签发面未启用(未配
    `SESSION_API_PUBLIC_ORIGIN`)/ 白名单外租户(未配 `SESSION_API_HOST_TENANTS`)
    / 题目不存在或未发布 —— 三者刻意同形(防枚举);
  - **401** = 宿主凭证不符(`Authorization: Bearer`),或换票时缺
    `Sec-Fetch-Mode: navigate`(非顶层导航),或票据已过期 / 已消费 / 绑定不符;
  - `launchUrl` 贴进浏览器 **404**(但换票本身已成功)= 该拓扑没有托管页面
    (`SESSION_API_PAGE_APP_DIR` 未配且仓库内 `apps/page-app/dist` 不存在)⇒ 人工
    走查请用 `compose:app:up`(已配该键 + bind mount)或 `dev:host`;
- **create_session 422(challenge_invalid)**:题目未登记 **或登记租户与锚租户不符**
  —— 新链的会话租户恒等于 `SESSION_API_HOST_TENANTS` 的字典序最小项,而题目装载按
  `(challengeId, version, tenantId)` 过滤(签发期的「已发布」校验是跨租户公开面,
  **不会**替你挡住这个错配)。登记路径见
  `test/compose/compose-full-chain.integration.test.ts` 的登记段
  (ChallengeRegistrar + Ed25519 登记签名;k6 种子脚本 `k6/seed-challenge.mjs`
  已按该租户派生);
- **429 / 409**:限流与预算是生产行为(每租户 / 每用户 120 req/min、并发
  预算默认 8 / 租户,提交 30/min,D-API-50)。⚠ 分发改版后 `userId` 是**部署级
  配置**(`SESSION_API_LAUNCH_USER_ID`,缺省 `launch-anon`)⇒ **同一部署下所有
  学习者共用一条每用户预算**,压测脚本按共享预算均摊节奏(不再是「每迭代唯一
  用户」);**不要调低护栏做"压测"**;
- **Redis / PG / MinIO 连不上(宿主进程形态)**:核对 `compose/integration.env`
  的端口映射(15432 / 16379 / 19000)与 `compose:deps:up` 状态;
- **端口占用**:13000(app)/ 15432 / 16379 / 19000 / 19001 固定发布,
  冲突时先 `compose:app:down` / `compose:deps:down` 清场;
- **测试为什么跳过**:单元运行中容器门控测试(集成 / compose)按
  `SESSION_API_IT` / `SESSION_API_COMPOSE` 门控跳过并输出跳过原因——这是
  纪律(单元测试无条件可跑),不是缺陷。
