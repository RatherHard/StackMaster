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

## 浏览器联调(亲手玩)

### 一次性准备

```bash
# ① 依赖容器(PostgreSQL 15432 / Redis 16379 / MinIO 19000;需 Docker Desktop 在运行)
pnpm --filter @stackmaster/session-api compose:deps:up

# ② 联调拓扑(session-api http://127.0.0.1:13000 + verifier :13100;
#    已把开发壳 origin http://localhost:5173 加入来源白名单;Ctrl+C 整体停止)
pnpm --filter @stackmaster/session-api dev:host

# ③ 登记三道题(每拓扑生命周期一次即可;运行中实例直读同一 PG/MinIO)
SESSION_API_COMPOSE=1 pnpm --filter @stackmaster/session-api exec \
  vitest run test/extended-challenges/register-extended.compose.integration.test.ts

# ④ 开发壳(vite 代理 /sessions、/auth、/descriptors → 13000)
pnpm --filter @stackmaster/plugin-dev dev     # http://localhost:5173
```

### 每一局开始前:签发 embed token

embed token 是**短时(1 小时)且单次消费**的凭证(jti 一次性):每次创建会话都要新签一个。

```bash
# cwd 任意;三道题改 E2E_CHALLENGE_ID 即可
SESSION_API_ORIGIN=http://127.0.0.1:13000 \
SESSION_API_HOST_BACKEND_TOKEN=host-backend-shared-credential-0123456789 \
E2E_TENANT_ID=tenant-dev-0001 \
E2E_USER_ID=user-dev-0001 \
E2E_CHALLENGE_ID=sm-x01-ret2win-ir \
E2E_CHALLENGE_VERSION=1.0.0 \
E2E_EMBED_SESSION_ID=esid-dev-local-browser-000000001 \
node apps/plugin-dev/scripts/issue-embed-token.mjs
# stdout 输出 {"embedToken":"...","expiresAt":...}
```

### 创建会话并游玩

浏览器打开 **http://localhost:5173**(必须用 `localhost`,来源白名单按精确 origin 匹配),
表单填入与签发时**完全相同**的四元组:

| 表单字段 | 值 |
|---|---|
| challengeId | `sm-x01-ret2win-ir`(或另两题) |
| challengeVersion | `1.0.0` |
| embedSessionId | `esid-dev-local-browser-000000001`(= 签发时的 E2E_EMBED_SESSION_ID) |
| embedToken | 签发输出的 token |

点「创建并连接」→ 工作区挂载。想要真实题面/提示(而非本地夹具),改用 URL:
`http://localhost:5173/?descriptor=formal&challengeId=sm-x01-ret2win-ir&challengeVersion=1.0.0`。

游玩节奏:「Payload 搭建」页用积木写字节(或读栈视图观察)→ 顶部菜单「指令步进」推进 →
状态变 `won` → 菜单「提交」→ 顶部裁决横幅等待 `verdicted`(独立 verifier 重放,约几秒)。
终态会话不可继续操作:再开一局 = 重新签 token → 重新创建会话。

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
| create_session 401 | token 已被消费(jti 单次)或过期(1 h)→ 重新签发 |
| 请求 403 / 无 Cookie | 打开的不是 `http://localhost:5173`,或 dev:host 未把 5173 加入白名单 |
| 提交后一直 pending | verifier 未运行(检查 `http://127.0.0.1:13100/healthz`) |
| 描述包 404 | 没登记(跑步骤③),或 token 租户 ≠ 登记租户(两者都要 `tenant-dev-0001`) |
| 13000 连接拒绝 | dev:host 未运行;deps 未起时它也起不来 |
