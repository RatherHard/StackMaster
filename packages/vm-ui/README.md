# @stackmaster/vm-ui

投影渲染库(阶段四轨道 A:WP-F1 脚手架 + WP-F2 会话客户端与数据源抽象):
公开投影的浏览器渲染层,Lit 3 + TypeScript,Vite library mode 多入口构建。
依赖方向强制为只依赖 `@stackmaster/protocol` 的**公开入口**(dependency-cruiser
`browser-packages-only-depend-on-protocol`);禁止依赖
`@stackmaster/protocol/server-only`、challenge-schema、session-core /
session-api / vm-engine。

## 目录(模块地图)

```
src/
├── index.ts                        公开入口(导出视图 / 客户端 / 数据源 / 渲染原语)
├── ui/                             视图组件(sm-workspace 空壳;WP-F3/F4/F5 填充)
├── client/                         WP-F2:会话客户端面
│   ├── session-client.ts           SessionClient——REST 5 命令、认证 WSS、
│   │                               动作账本(clientSeq/baseRevision/idempotencyKey)、
│   │                               断线重连(指数退避 + sync 对齐)、rAF 合帧
│   ├── projection-store.ts         ProjectionStore——最近公开投影 + ProjectionDelta
│   │                               增量应用 + 订阅 API(rAF 批量通知视图)
│   ├── transport.ts                可注入传输面(WsLikeSocket / fetch / rAF / 定时器)
│   └── session-errors.ts           SessionClientError / SessionCommandError
├── datasource/                     WP-F2:双档数据源抽象
│   ├── types.ts                    MemoryDataSource 接口(视图唯一依赖面)+
│   │                               AddrRange / ByteQuery / Hit / Row / RegisterRow /
│   │                               VmaList / Instr
│   ├── projection-data-source.ts   公开档 ProjectionDataSource(冻结公开投影)
│   └── debug-data-source.ts        调试档占位骨架(WP-F8 填充;方法抛错)
└── render/                         WP-F2:共享渲染原语(WP-F3/F4 并行消费,
                                    避免两视图互相依赖)
    ├── hex.ts                      bytesHex 小写 / valueHex 恒 0x+大写归一化、
    │                               分组格式化、地址解析与展示
    ├── special-display.ts          特殊显示单元格(可见 ASCII / 占位 / 语义标注
    │                               纯函数 + Lit 渲染辅助)
    └── rows.ts                     8 字节行切分与偏移对齐纯函数
```

## 双档数据源纪律(评审解耦的关键约束)

《前端实施计划》§四:视图组件**只许依赖 `MemoryDataSource` 接口**,禁止绕过
接口直读 `SessionClient` / `ProjectionStore` 的投影存储——这是"ADR-DC1 评审
结果不影响已写代码"的唯一保证点(评审前由 code review 把关,评审后可升级为
dependency-cruiser / ESLint 规则)。

```
interface MemoryDataSource {          // UI 组件只依赖此接口
  regions(): VmaList;                 // FE-FV-06
  registers(): RegisterRow[];         // FE-RG-01/02
  bytesRows(range: AddrRange): Row[]; // FE-ST/FE-FV 行渲染
  search(query: ByteQuery): Hit[];
  instructionStream?(range): Instr[]; // 调试档独有;公开档 undefined
}
```

- 公开档 `ProjectionDataSource`:数据源 = 冻结公开投影,语义受 D3(窗口锚定
  区域起点,`windowByteLength` = 已下发前缀)与 `currentInstruction` 单条约束;
  **越界查询返回"窗口外"标记 cell(byteHex/byte/offset 为 null)而非报错**;
  `search` 仅在已下发窗口字节内检索;`instructionStream` 不实现。
- 调试档 `DebugDataSource`:WP-F8 填充(全量语义;`instructionStream` 仅此档
  存在);本包内仅占位骨架,方法一律抛"调试档由 WP-F8 填充"。

装配形态(F5 接线参考):`dataSource = new ProjectionDataSource(client.store)`
——该装配发生在**组合根**(工作区容器),视图只接收 `MemoryDataSource`。

## SessionClient 行为契约(WP-F2 定稿)

- **REST 5 命令**(冻结路由表 D-API-1):`POST /sessions`(create_session,
  201 + Set-Cookie)、`/sessions/projection-sync`、`/sessions/checkpoints`、
  `/sessions/submissions`、`/sessions/close`;请求体 = 冻结
  `SessionCommandRequest` 信封;一律 `credentials: "include"`
  (会话凭证 Cookie 交付,D-API-12;响应体零凭证字段)。
- **认证 WSS**:`GET /sessions/channel` 升级即 Cookie 认证;客户端→服务端仅
  `action` 帧。**连接级版本锚定**(D-API-2)由首帧 `protocolVersion` 承载——
  本客户端所有帧恒携带 `SESSION_ACTION_PROTOCOL_VERSION`(照 WssFrame 信封
  六字段),服务端拒绝漂移;不发明锚定专用帧(帧类型集合封闭)。
- **动作账本**:`clientSeq` 自 1 严格递增(会话级,不随重连重置);
  `baseRevision` = 最近已知投影 revision;`idempotencyKey` 每动作唯一
  (缺省 `crypto.randomUUID`,内存账本防撞;可注入)。响应按传输层
  `requestId`(= 幂等键)关联。
- **rejected 耦合**:`projectionDelta` 必为 null、`userVisibleError` 必在
  (Schema 机检)→ `onActionRejected` 立即分发,revision 不前进。
- **增量与合帧**:action_response 的增量先入队,`requestAnimationFrame`
  回调里批量应用到 store 并**每帧至多一次**通知视图;注入 `raf` 可用假帧调度
  测试;无 rAF 环境(Node/SSR)降级为微任务批处理。
- **truncated 语义**:dirtyRange 带 `truncated` 标记 ⇒ 帧内应用后自动 REST
  `sync_projection` 重新对齐(9.1 sanctioned 路径);增量 revision 错位同样
  触发 sync 兜底(客户端零本地推导)。
- **断线重连**:断线保留最近一次公开投影(只展示,零本地 VM 降级);自动
  重连指数退避(`delay = min(initial·2^n, maxDelayMs)`,无抖动,可配)→
  成功后立即 `sync_projection` 对齐 → 以新 revision 继续。close 1000(服务端
  语义 = 空闲超时)/ 1001(停机)/ 1009(帧超限)/ 1013(背压)自动重连并
  语义化分发;close 1008 不自动重连——携带 "connection replaced" 错误帧 =
  同会话新连接踢旧(单连接策略,避免两客户端互踢循环),无该错误帧 = 策略
  关闭(升级后未认证族)。心跳 / 空闲(30s/60s)由服务端负责(浏览器
  WebSocket 自动回应 pong),客户端不实现。
- **已知取舍**:重连 open 与 sync 完成之间的窗口内 `sendAction` 可能以过期
  `baseRevision` 被服务端以 `stale_base_revision` 拒绝——这是可解释错误的
  正常路径(先 sync 再重试),客户端不阻塞动作投递。

## 构建形态

- `pnpm build` = `tsc -b`(emitDeclarationOnly,先产 `dist/*.d.ts`)+
  `vite build`(库模式多入口:`index` 与 `sm-workspace`,ESM 输出 `dist/`);
  `emptyOutDir: false`——vite 不得抹掉 tsc 先行产出的声明文件;
- **产物自包含**:运行时依赖(lit、@lit-labs/virtualizer、protocol/zod)内联
  进 dist 产物,产物不含裸模块导入——宿主(含 `apps/plugin-dev` 开发壳)可以
  用 `<script type="module">` 直接加载 `dist/index.js`,不经打包器;
- turbo 任务对齐:`build` outputs 为 `dist/**` 与 `*.tsbuildinfo`。

## 版本组合登记(WP-F1 锁定,2026-09-11)

| 依赖 | 锁定范围 | 说明 |
|---|---|---|
| `lit` | `^3.3.3` | Lit 3 最新稳定 |
| `@lit-labs/virtualizer` | `^2.1.1` | 声明依赖 `lit ^3.2.0`,与 lit 3.3.3 组合经兼容冒烟验证 |
| `vite` | `^8.3.0` | 最新稳定(rolldown/oxc 工具链) |
| `jsdom` | `^30.0.1` | 组件测试环境(vitest `environment: "jsdom"`) |

已验证组合:**lit 3.3.3 × @lit-labs/virtualizer 2.1.1 × vite 8.3.0**;
兼容证据 = `test/lit-virtualizer-compat.test.ts`(10 万行虚拟列表首屏渲染冒烟,
《前端实施计划》§六登记风险的落地对策)。升级任一依赖先更新此处与本测试,
再跑 `pnpm --filter @stackmaster/vm-ui test`。

**装饰器模式登记**:本包 tsconfig 采用 `experimentalDecorators: true` +
`useDefineForClassFields: false`(Lit 经典装饰器形态)。原因:Vite 8 的
oxc 转换器**尚不支持 TC39 标准装饰器 lowering**(oxc-project/oxc#9170),
标准装饰器需退回 Vite 7(esbuild)或引入 Babel;Lit 3 对两种模式均兼容,
待 oxc 支持后可统一切换标准模式(`@property` 需改 `accessor` 字段)。

## 测试

- 环境:jsdom(无布局引擎),`test/setup.ts` 桩补 `ResizeObserver`、
  `getBoundingClientRect`(固定 300×300)与 rAF 兜底——虚拟列表首屏计算
  在该桩下进行;
- WP-F2 测试面:`test/client/`(session-client 全链路 mock fetch / mock
  WebSocket、projection-store、transport)、`test/datasource/`(公开档窗口
  语义 / 调试档骨架)、`test/render/`(hex / rows / special-display)、
  `test/public-api.test.ts`(导出面冻结);测试基建 `test/helpers/fixtures.ts`
  (夹具经冻结 Schema 自检 + Cookie 罐 mock fetch + 手工驱动 mock WebSocket +
  假 rAF / 假定时器);
- 覆盖率:本包纳入根 `pnpm test:coverage` 聚合(`vitest.coverage.config.ts`
  projects 含 `packages/*`),整体门槛 ≥ 80%;WP-F2 新代码行覆盖 ≥ 85%
  (包级实测:stmts 96.0 / branch 88.1 / funcs 96.2 / lines 96.2)。

## Node 侧集成接入方式(WP-F7 前的冒烟路径)

`SessionClient` 全部传输依赖可注入,Node 侧(undici + `ws`)可复用同一实现
做 compose 集成冒烟(WP-F7 Playwright 最小集之前的路径):

```ts
import { fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import { SessionClient, type WsLikeSocket, type WebSocketFactory } from "@stackmaster/vm-ui";

// Node 侧无 Cookie 罐:从 create_session 响应取 Set-Cookie,升级握手手动呈递。
function nodeWebSocketFactory(cookieHeader: string): WebSocketFactory {
  return (url) => {
    const ws = new WebSocket(url, { headers: { cookie: cookieHeader } });
    const socket: WsLikeSocket = {
      send: (data) => void ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
    ws.on("open", () => socket.onopen?.());
    ws.on("message", (data) => socket.onmessage?.({ data: data.toString() }));
    ws.on("close", (code, reason) => socket.onclose?.({ code, reason: reason.toString() }));
    ws.on("error", () => socket.onerror?.());
    return socket;
  };
}

const client = new SessionClient({
  baseUrl: "http://127.0.0.1:13000",                       // compose:app:up 拓扑
  fetch: undiciFetch as unknown as typeof fetch,
  webSocketFactory: nodeWebSocketFactory(sessionCookie),   // 会话凭证手动呈递
});
// create_session → connect → sendAction → 投影增量 → 断线重连全链路与浏览器同构。
```

本 WP 未强制跑 compose E2E(留给 WP-F7 的 Playwright 最小集);上述接入面已由
mock 全链路测试覆盖同一代码路径。

## 纪律速查

- 视图组件禁止绕过 `MemoryDataSource` 接口直读 session-client 投影存储
  (前端实施计划 §四;评审解耦的关键约束);
- 浏览器任何位置只保存公开投影与 UI 状态(幂等键 / clientSeq 账本属会话
  UI 状态;IndexedDB 持久化未做,亦无必要——无秘密可持久化);
- 断线只展示最近一次公开投影,重连走 sync-projection;禁止任何形式的本地
  VM 执行降级;
- 与 protocol 契约形态一字不差(valueHex 恒大写、bytesHex 小写、rejected
  耦合、truncated 语义、sync 仅 REST、动作仅 WSS);
- 动画只用 transform / opacity 等 compositor 友好属性;语义化 DOM +
  虚拟列表,控制流用 SVG;屏幕阅读器信息不得只存在于 Canvas。
