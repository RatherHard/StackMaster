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
#   PostgreSQL 15432 / Redis 16379 / MinIO 19000(控制台 19001)
pnpm --filter @stackmaster/session-api compose:app:down   # down -v(含数据卷)
```

- 首次构建耗时主要在 Rust 阶段(容器内构建 linux vm-worker);
  `WORKER_CARGO_PROFILE` 缺省 `debug`(控制本地时长),CI 传 `release`
  (D-API-64);Rust 源码未变时该层走构建缓存,增量构建很快;
- 迁移**自动执行**:session-api 启动序列自带 `runMigrations`
  (失败即拒绝启动,fail-closed;无需手工迁移步骤);
- 凭据与密钥(`compose/app.yaml` / `compose/integration.env`)全部是本地
  dev / CI 专用合成值,**严禁用于任何真实环境**;
- 纯依赖服务(不含 session-api):`compose:deps:up` / `compose:deps:down`。

### 环境变量

session-api 的配置走 `SESSION_API_*` 环境变量,三道闸校验(必备键缺失 /
未知保留键 / 取值非法,任一不过即拒绝启动,D-API-9)。完整键表与语义:
`docs/develop/权威API语义规约.md` 的 D-API-9 / D-API-19 / D-API-39 /
D-API-58 / D-API-70(必备六键:签发密钥、宿主共享凭证、PG / Redis /
MinIO 端点与快照加密密钥;其余有缺省值)。compose 拓扑的键值集中在
`compose/app.yaml`;宿主进程形态的键值在 `compose/integration.env`。

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

- 场景(`k6/scenarios/`):`action-rtt-wss.js`(签发 → create_session →
  WSS stop-and-wait 动作 RTT)、`rest-lifecycle.js`(REST 五命令全生命周期)、
  `concurrent-sessions.js`(阶梯并发维持 + /metrics 采样);
- **不设通过阈值**(10.3 / 13.6:数据作为 T2 触发判据基线,避免过早优化,
  D-API-73);
- 结果归档 `k6/results/<UTC 时间戳>/`:逐场景原始 summary JSON + stderr
  留档 + 采集前 / 后 `/metrics` 快照 + `summary.md` 人读摘要;
- 首采记录(2026-09-10,本机 compose 容器拓扑):见
  `k6/results/2026-09-09T223628898Z/summary.md` 与
  `docs/phases/阶段三验收评审.md` §一.8。

## 七、常见问题(FAQ)

- **启动即退出 / 配置校验失败**:看 stderr 单行 JSON 的 `issues`(只含字段
  名与原因,绝不含字段值,D-API-9)。compose 形态看
  `docker compose logs session-api`;
- **create_session 404/422(challenge invalid)**:题目未登记——参考
  `test/compose/compose-full-chain.integration.test.ts` 的登记路径
  (ChallengeRegistrar + Ed25519 登记签名;批量题目制作归 MVP 期);
- **429 / 409**:限流与预算是生产行为(每租户 / 每用户 120 req/min、并发
  预算默认 8 / 租户,提交 30/min,D-API-50),压测脚本已按每迭代唯一用户
  规避削顶,不要调低护栏做"压测";
- **Redis / PG / MinIO 连不上(宿主进程形态)**:核对 `compose/integration.env`
  的端口映射(15432 / 16379 / 19000)与 `compose:deps:up` 状态;
- **端口占用**:13000(app)/ 15432 / 16379 / 19000 / 19001 固定发布,
  冲突时先 `compose:app:down` / `compose:deps:down` 清场;
- **测试为什么跳过**:单元运行中容器门控测试(集成 / compose)按
  `SESSION_API_IT` / `SESSION_API_COMPOSE` 门控跳过并输出跳过原因——这是
  纪律(单元测试无条件可跑),不是缺陷。
