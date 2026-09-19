# 扩展题目集(sm-x01 ~ sm-x03)

三道 pwn 教学题的构造式语料与测试(与 `../mvp-challenges/` 同一制作管线):

| ID | 标题 | 模式 | 教学点 |
|---|---|---|---|
| `sm-x01-ret2win-ir` | 幕间收尾:leave 与 ret 的回归劫持 | IR | `leave; ret` 栈帧劫持,覆写返回地址到 win |
| `sm-x02-rop-minimal` | 借力打力:最小 ROP 链 | 字节 | gadget `pop RDI; ret` + 密钥参数 + win 块密钥校验 |
| `sm-x03-int-truncation-ir` | 量过的尺子是断的:整数截断盲区 | IR | 8 位截断检查 ≠ 64 位范围检查 |

## 无头测试(不需要浏览器 / Docker)

```bash
pnpm --filter @stackmaster/session-api exec vitest run test/extended-challenges
# 门禁 21 + 裁决闭环(真实 vm-worker)14 = 35 用例
```

## 浏览器联调(亲手玩;WP-96 起 = **启动地址链 / 页面分发**)

### 一次性准备

```bash
# ① 依赖容器(PostgreSQL 15432 / Redis 16379 / MinIO 19000;需 Docker Desktop 在运行)
pnpm --filter @stackmaster/session-api compose:deps:up

# ② 页面产物(页面由 session-api 同源托管;vm-ui 必须先构建)
pnpm --filter @stackmaster/vm-ui build
pnpm --filter @stackmaster/page-app build

# ③ 联调拓扑(dev:host:session-api http://localhost:13000 + verifier :13100;
#    它自带 SESSION_API_PUBLIC_ORIGIN 与页面目录装配 = 同源托管 page-app 产物;
#    Ctrl+C 整体停止)
pnpm --filter @stackmaster/session-api dev:host

# ④ 登记三道题(每拓扑生命周期一次即可;运行中实例直读同一 PG/MinIO)
#    登记租户缺省 = 启动地址链锚租户(host-scores-tenant,dev:host 继承
#    compose/integration.env),**与会话租户一致**才建得出会话。
SESSION_API_COMPOSE=1 pnpm --filter @stackmaster/session-api exec \
  vitest run test/extended-challenges/register-extended.compose.integration.test.ts
```

### 每一局开始前:领一张一次性启动地址

启动票据是**短时(缺省 5 分钟)且单次消费**的持有证明:每次创建会话都要新领一张。
**地址只发给对应学习者**(交付纪律,契约 §六「会话固定」行的基线缓解)。

```bash
# cwd 任意;三道题改 challengeId 即可。SESSION_API_PUBLIC_ORIGIN 必须与
# dev:host 的 PUBLIC_ORIGIN 同源(localhost:13000;localhost 与 127.0.0.1 不同源,
# 而 sm_launch_grant 是 SameSite=Strict ⇒ 页面与 API 必须同源)
curl.exe -sS -X POST http://localhost:13000/auth/launch-tickets \
  -H "authorization: Bearer host-backend-shared-credential-0123456789" \
  -H 'content-type: application/json' \
  -d '{"challengeId":"sm-x01-ret2win-ir","version":"1.0.0"}'
# ⇒ {"launchUrl":"http://localhost:13000/app/c/sm-x01-ret2win-ir/1.0.0?t=<一次性票据>",
#    "expiresAt":...}
```

### 打开地址即开局(无需表单、无需 token)

把 `launchUrl` **整体贴进浏览器**:

1. 服务端换票(`Sec-Fetch-Mode: navigate` 由顶层导航自带)→ `Set-Cookie:
   sm_launch_grant`(Path=`/sessions`,HttpOnly,SameSite=Strict)→ **302 到不含
   票据的干净路径**(地址栏里不再有 `?t=`;票据即刻脱离历史与 Referer);
2. 页面(与 API 同源)自动 `POST /sessions`(`create_session`,payload 恰两键
   `{challengeId, challengeVersion}`,`protocolVersion: 2`;授权来自 Cookie)
   → 工作区挂载;
3. 想换一道题:把**同一张票**再打开一次是不行的(单次消费,401 统一形态)
   —— 回上一步重新领一张,改 `challengeId` / `version`。

游玩节奏:「Payload 搭建」页用积木写字节(或读栈视图观察)→ 顶部菜单「指令步进」推进 →
状态变 `won` → 菜单「提交」→ 顶部裁决横幅等待 `verdicted`(独立 verifier 重放,约几秒)。
终态会话不可继续操作:再开一局 = 重新领一张启动地址。

### 速通攻略(剧透)

- **x01**:向 `0x7ffff7f0` 写 48 hex×2 字节:
  `41×16 + 42×8 + 0600000000000000`(填充 32 B + 覆写返回地址槽为 win 索引 6)→「指令步进」×2 → won。
- **x02**:向 `0x7ffff7f0` 写 96 hex 字节:
  `41×16 + 42×8 + 0003400000000000 + EFBEADDE00000000 + 0002400000000000`
  (链 = gadget `pop RDI;ret` @0x400300 + 密钥 0xDEADBEEF + win @0x400200)
  →「返回」一次弹上 gadget,再「指令步进」×5 推完链(pop 密钥 → ret 进 win → cmp/jne 门 → WINFLAG)→ won。
- **x03**:向 `0x600000` 写 `2800000000000000`(size=40,低字节 0x28 过检),
  向 `0x600008` 写 `0c00000000000000`(note=win 索引 12)→「指令步进」×12 → won。
- **失败路径也值得看**:x01 返回地址写 `8`(走 lose)、x02 密钥改一位(走 fail)、
  x03 size 写 `2800000001000000`(≈4 GB,未映射写 → memory_fault)。

### 故障排查

| 症状 | 原因与处置 |
|---|---|
| 签发 `POST /auth/launch-tickets` 404 | 签发面未启用(`SESSION_API_PUBLIC_ORIGIN` 未配)/ 白名单外租户 / 题目未发布 —— 三者同形(防枚举);dev:host 已配该键,**题目未登记**最常见(跑步骤④) |
| 签发 401 | 宿主凭证不符(dev 合成值 = `host-backend-shared-credential-0123456789`) |
| 打开地址 401 | 票据已被消费(单次)或过期(缺省 5 分钟)→ 重新领一张;或用非顶层导航打开(手工 curl 不带 `Sec-Fetch-Mode: navigate`) |
| 页面打开 404(换票其实成功) | 该拓扑没托管页面:先按步骤② 构建 page-app,并用 `dev:host`(它自带页面目录装配) |
| 页面里 `create_session` 422(challenge_invalid) | 登记租户 ≠ **锚租户**:新链的会话租户恒等于 `SESSION_API_HOST_TENANTS` 的字典序最小项(dev:host = `host-scores-tenant`,见 `compose/integration.env`),而题目装载按 `(challengeId, version, tenantId)` 过滤 —— 登记脚本的缺省已是该租户,只有显式覆盖了 `EXT_DEV_TENANT_ID` 时才需核对 |
| 提交后一直 pending | verifier 未运行(检查 `http://127.0.0.1:13100/healthz`) |
| 13000 连接拒绝 | dev:host 未运行;deps 未起时它也起不来 |
