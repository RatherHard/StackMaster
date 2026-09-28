# @stackmaster/vm-ui

投影渲染库(阶段四轨道 A:WP-F1 脚手架 + WP-F2 会话客户端与数据源抽象 +
WP-F3/F4 视图 + WP-F5 工作区容器):公开投影的浏览器渲染层,Lit 3 +
TypeScript,Vite library mode 多入口构建。依赖方向强制为只依赖
`@stackmaster/protocol` 的**公开入口**(dependency-cruiser
`browser-packages-only-depend-on-protocol`);禁止依赖
`@stackmaster/protocol/server-only`、challenge-schema、session-core /
session-api / vm-engine。

## 目录(模块地图)

```
src/
├── index.ts                        公开入口(导出工作区 / 视图 / 客户端 /
│                                   数据源 / 渲染原语)
├── workspace/                      WP-F5:工作区容器与菜单
│   ├── sm-workspace.ts             <sm-workspace> 工作区本体——**整页布局**
│   │                               (自身即页面主体,`block-size: 100dvh`,
│   │                               不依赖宿主给高度;2026-09-18 UI 改版 =
│   │                               D-API-153 / D-UI-1 ~ D-UI-7)、**左右两分**
│   │                               (固定 1:1、无 gap / border / divider、不可
│   │                               调;右半侧 = payload 搭建窗口,左半侧 =
│   │                               视图管理窗口 —— 列表按钮 + 固定 2 个可见
│   │                               视图位纵向堆叠)、**固定窗口集**(WP-71 /
│   │                               D-MP-1:登记集合各恰一实例常驻)、组合根装配
│   │                               (client → ProjectionDataSource → 各视图)、
│   │                               跨视图集成接线
│   ├── sm-workspace-menu.ts        <sm-workspace-menu> 顶部菜单——**三组**
│   │                               (D-UI-7 补充裁定 + decisions §四·补.5:
│   │                               「视图」= 10 个聚焦按钮 + 「重置视图」,
│   │                               注册表驱动、aria-pressed 表达当前焦点,
│   │                               **不承载勾选 / 排序** / 「模式」= 模式指示 /
│   │                               「运行」= 指令步进 step + 积木步进
│   │                               payload-step(WP-F6,仅 payload 页激活时可用)
│   │                               + 运行到断点(WP-F8,调试档)+ 解题/调试模式
│   │                               切换(WP-F8,debugMode 可用才显示)+ 提交 +
│   │                               重启 reset(终态禁用+引导))/
│   │                               会话状态与断线横幅 / what-if 纪律横幅 /
│   │                               拒绝错误呈现。**「窗口」组与「布局」组均已
│   │                               不存在**
│   ├── tab-registry.ts             窗口类型注册表(stack / free / registers /
│   │                               payload / debug=指令视图 带工厂;ED 组件面
│   │                               五类(structure/call-stack/memory-diff/
│   │                               timeline/checkpoints)登记;可扩展;WP-71 /
│   │                               D-MP-1:一登记项 = 恰一个常驻窗口)
│   ├── workspace-model.ts          布局模型纯状态机——**一条有序视图列表 +
│   │                               每类型 `visible` 勾选 + 焦点**(取代原
│   │                               「列 / 窗口结构」)、视图集绑定
│   │                               (`bindWindows(bindings, order?)`,
│   │                               **已无 `columns` 参数**,`workspace-model.ts:
│   │                               191`)、焦点导航(focusWindow)、
│   │                               列表内重排(moveView)、勾选(setViewVisible)、
│   │                               重置视图(resetViews)、窗口集不变量机检
│   │                               (isWindowSetComplete / isLayoutStateValid)
│   ├── layout-presets.ts           可读性阈值与**视图默认顺序的单一来源**——
│   │                               宽度推导值(`MIN_COLUMN_WIDTH` = 452.4px ⇒
│   │                               `SIDE_PANEL_MIN_WIDTH_PX` = 左半侧宽度底线)、
│   │                               视图位高度算式(viewSlotHeightPx +
│   │                               VISIBLE_VIEW_SLOT_COUNT = 2)、
│   │                               `DEFAULT_VIEW_ORDER` / `orderByDefault()`;
│   │                               原 P0/P1/P2 列预设与窗高下限已废止(见 README
│   │                               废止表与文件头)
│   ├── byte-tab.ts                 <sm-byte-tab> 字节页组合(字节视图 + VMA
│   │                               侧栏;vma-select ↔ showRegion ↔
│   │                               selectedRegionId 回路;rowDecorator 透传)
│   └── sm-register-annotation.ts   <sm-register-annotation> 行左缘寄存器交叉
│                                   标注(复用 F4 renderRegisterAnnotationCell;
│                                   点击行内展开寄存器值)
├── payload/                        WP-F6:Payload 搭建面
│   ├── sm-payload-tab.ts           <sm-payload-tab> 三区布局(FE-PB-01:左 =
│   │                               Blockly 画布 light DOM 挂载 / 右上 = 原子
│   │                               步骤程序区(当前步高亮)/ 右下 = 执行输出
│   │                               区);编译 + 运行/单步/暂停/复位;唯一起始
│   │                               积木预置(FE-PB-03);refresh() 约定
│   ├── executor.ts                 PayloadStepExecutor——原子动作粒度步进状态机
│   │                               (idle/running/paused/done/error;断点暂停
│   │                               M7 变通、rejected 停驻手动重试、动作提交面
│   │                               PayloadActionSink 可注入、间隔等待可注入)
│   └── compiler/                   积木 → 12 动作编译器(纯逻辑;无头 Blockly,
│       │                           序列化 JSON 输入,零 DOM 渲染依赖)
│       ├── blocks.ts               积木定义与中文工具箱(UI 与编译器唯一共享
│       │                           源;FE-PB-02 八类 + 会话动作 + 中文 tooltip)
│       ├── compile.ts              compilePayload:序列化 JSON → PayloadProgram
│       │                           (循环/分支/函数内联展开 + PAYLOAD_MAX_
│       │                           EXPANDED_ACTIONS 上限;allowedActions 编译
│       │                           期裁剪;错误即值)
│       ├── eval.ts                 客户端求值环境(公开投影只读快照:寄存器 +
│       │                           窗口内字节;UTF-8 字符串定案;64 位回绕)
│       └── types.ts                PayloadProgram / PayloadStep / 编译错误码
├── client/                         WP-F2:会话客户端面
│   ├── session-client.ts           SessionClient——REST 5 命令 + 裁决查询(WP-63)、
│   │                               认证 WSS、动作账本(clientSeq/baseRevision/idempotencyKey)、
│   │                               断线重连(指数退避 + sync 对齐)、rAF 合帧
│   ├── verdict-poller.ts           VerdictPoller——正式裁决重询状态机(WP-63:
│   │                               pending/verdicted/unavailable 呈现;确定性间隔 + 退避)
│   ├── projection-store.ts         ProjectionStore——最近公开投影 + ProjectionDelta
│   │                               增量应用 + 订阅 API(rAF 批量通知视图)
│   ├── transport.ts                可注入传输面(WsLikeSocket / fetch / rAF / 定时器)
│   ├── debug-channel-client.ts     DebugChannelClient——调试通道客户端(WP-F8:
│   │                               独立端点 /sessions/debug-channel、独立协议
│   │                               版本锚定、attach 自动化、requestId 关联、
│   │                               推送帧事件面;ADR-DC1 条款 1 / §六 R3)
│   └── session-errors.ts           SessionClientError / SessionCommandError
├── datasource/                     WP-F2:双档数据源抽象
│   ├── types.ts                    MemoryDataSource 接口(视图唯一依赖面)+
│   │                               AddrRange / ByteQuery / Hit / Row / RegisterRow /
│   │                               VmaList / Instr
│   ├── projection-data-source.ts   公开档 ProjectionDataSource(冻结公开投影)
│   └── debug-data-source.ts        调试档 DebugDataSource(WP-F8:调试通道
│                                   推送+显式拉取的本地缓存;扩展方法
│                                   prefetchWindow / searchAllMemory / step /
│                                   runToBreakpoint / 断点集合;组合根装配
│                                   createDebugDataSource)
├── render/                         WP-F2:共享渲染原语(WP-F3/F4 并行消费,
│                                   避免两视图互相依赖)
│   ├── hex.ts                      bytesHex 小写 / valueHex 恒 0x+大写归一化、
│   │                               分组格式化、地址解析与展示
│   ├── special-display.ts          特殊显示单元格(可见 ASCII / 占位 / 语义标注
│   │                               纯函数 + Lit 渲染辅助)
│   └── rows.ts                     8 字节行切分与偏移对齐纯函数
└── views/
    ├── byte/(WP-F3 字节视图核心,公开视图档)
    │   ├── alignment.ts            对齐偏移(0..7)行切分纯函数:整行网格 +
    │   │                           窗口对齐外扩查询区间 + 重切(regroupRows);
    │   │                           偏移语义 = FE-ST-03「对齐基址 + k×8 + offset」
    │   ├── view-model.ts           默认区域选取 / rsp·rbp 锚点解析(M13)/
    │   │                           跳转输入解析(M3 窗口内导航)纯函数
    │   ├── byte-view.ts            <sm-byte-view> 字节视图本体(栈视图与自由
    │   │                           视图共用;三段布局 + lit-virtualizer 虚拟
    │   │                           列表 + 锚点 + 窗口内导航/检索;WP-F5 最小
    │   │                           diff 增补 rowDecorator 挂点与 scrollToAddress)
    │   └── vma-list.ts             <sm-vma-list> VMA 列表侧栏(FE-FV-06;
    │                               regions() 直读、按地址有序、vma-select 事件)
    ├── instruction/(WP-F8 指令视图,调试档)
    │   └── sm-instruction-view.ts  <sm-instruction-view>:FE-IN-01~08(三段
    │                               布局 / jumpTarget 延展 / 函数表 / rip 锚点 /
    │                               检索双入口 / 行断点 / prefetch 跳转管线)
    ├── register/(WP-F4 寄存器视图)
    │   ├── sm-register-view.ts     <sm-register-view>:FE-RG-01/02/03
    │   └── cross-annotation.ts     FE-RG-04 交叉标注纯函数 + 渲染辅助
    ├── chain/(WP-F4 跳转链;WP-F8 增补延伸挂点)
    │   ├── resolve.ts              FE-ST-07/09 链解析纯函数(小端、回环、窗口外)
    │   ├── visible-run.ts          FE-ST-10 可见字符延伸
    │   └── sm-jump-chain.ts        <sm-jump-chain>:链芯片 + SVG 回环 + 展开;
    │                               viewport-jump 事件(组件只发事件);
    │                               extendable/extendHandler 延伸入口(F8)
    └── ed/(WP-F9 ED 七组件,属性驱动可独立实例化;挂接归 WP-F8)
        ├── sm-structure-view.ts    <sm-structure-view>(FE-ED-01;highlight-jump)
        ├── sm-call-stack.ts        <sm-call-stack>(FE-ED-02;截断明示)
        ├── sm-memory-diff.ts       <sm-memory-diff>(FE-ED-03;整体替换)
        ├── sm-timeline.ts          <sm-timeline>(FE-ED-04)
        ├── sm-checkpoints.ts       <sm-checkpoints>(FE-ED-05;两步确认)
        ├── sm-hint-ladder.ts       <sm-hint-ladder>(FE-ED-06;本地 revealPolicy)
        └── sm-error-explainer.ts   <sm-error-explainer>(FE-ED-07;teachingNote)
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
- 调试档 `DebugDataSource`(WP-F8 填充,契约见下方 WP-F8 章节):调试通道
  缓存模型(全量语义;`instructionStream` 仅此档存在)+ 调试档独有扩展方法。
  **投影结构同构映射是调试档 VMA / 寄存器 / 行区域归属的唯一来源**(WP-70
  接线修复):`regions()` / `registers()` / `bytesRows()` 的 `regionId`·`offset`
  全部读 `projectionProvider`(组合根装配 = `() => session.store.snapshot ?? null`,
  即会话公开投影面;每次调用读最新快照,投影前进即随动);**缺省不传 = 恒
  null → 空 VMA / 空寄存器**(独立使用形态的既有行为保留,反例见
  `test/datasource/debug-data-source.test.ts`)。调试档**不得**从调试通道字节
  本地推导区域归属或寄存器(ADR-DC1 what-if 纪律;来源 ⊆ 公开投影)。

装配形态(F5 接线参考):`dataSource = new ProjectionDataSource(client.store)`
——该装配发生在**组合根**(工作区容器),视图只接收 `MemoryDataSource`;
调试档同理:`createDebugDataSource(client, { projectionProvider: () =>
client.store.snapshot ?? null })`(工厂 options = 运输面 & 数据源面:运输键
透传 `DebugChannelClient`,数据源键只进 `DebugDataSource`;两面不混)。

## SessionClient 行为契约(WP-F2 定稿)

- **REST 5 命令**(冻结路由表 D-API-1):`POST /sessions`(create_session,
  201 + Set-Cookie)、`/sessions/projection-sync`、`/sessions/checkpoints`、
  `/sessions/submissions`、`/sessions/close`;请求体 = 冻结
  `SessionCommandRequest` 信封;一律 `credentials: "include"`
  (会话凭证 Cookie 交付,D-API-12;响应体零凭证字段)。
- **裁决呈现通道**(阶段六 WP-63,D-API-83):`GET /verdicts/:submissionId`
  (`SessionClient.queryVerdict`,Cookie 凭证同模型;响应体过冻结
  `VerdictQueryResponseSchema` 自检)——重询由 `VerdictPoller` 驱动
  (确定性间隔 + 失败退避 + verdicted 即停 + 断线暂停重连恢复;呈现与
  「已提交」态语义见 D-API-99);裁决数据只经本通道(REST)呈现,**不经任何跨文档
  消息面**——嵌入协议已于 2026-09-19 随 WP-96 物理删除,原 V-9(V-1~V-13 同批)
  的约束**按现状结构性成立**(裁决面不存在可被帧旁路的通路)。
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
  进 dist 产物,产物不含裸模块导入——承载方可以用 `<script type="module">`
  直接加载 `dist/index.js`,不经打包器。**当前承载形态 = `apps/page-app`**
  (prebuild 经 `scripts/sync-vm-ui-dist.mjs` 把 `packages/vm-ui/dist` 同步到
  `public/vm-ui/`,运行期按 URL 动态 `import("/vm-ui/index.js")` 并带
  `@vite-ignore` ⇒ 不产生静态依赖边;原 `apps/plugin-dev` 开发壳已于
  2026-09-19 随 WP-96 物理删除);
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

## 主题与语言机制面(WP-53,2026-09-11;WP-73 主题边界修订;2026-09-18 D-UI-6 终端单主题)

本仓的实现义务(阶段五边界裁决 2,**纪律仍然有效**:**主题/语言是机制不是视觉
美化**;其原载体「嵌入协议冻结面」已于 2026-09-19 随 WP-96 物理删除,纪律本身
不随之退场 —— 实现载体改为「锚 + 文档级样式表 + `data-sm-*` 属性」);
定案细节与遗留登记见 `docs/develop/阶段五WP53决策草稿.md`。
**WP-73 修订(历史,三预设期)**:阶段五的「视觉风格零重设计」边界曾按中期计划 §2.1
修订为**完整设计 token 集 + terminal 预设**;**2026-09-18 D-UI-6** 进一步把三预设
退役为**终端单主题**(机制:锚 + 文档级样式表 + 自定义属性继承,均不变)。

### 主题(src/theme/theme-tokens.ts;2026-09-18 D-UI-6 **终端单主题**)

> **本节 = 单主题回填点**(2026-09-18 UI 改版 D-UI-6;`docs/develop/decisions-分发改版与UI重设计.md`):
> `light` / `dark` / `auto` 三预设**已退役**,21 枚 token 名**全部保留**、取值收敛为
> 终端一套。历史口径(WP-73「三预设 token 表」)不删,见文末沿革段。

**变量面 = 21 个 CSS 自定义属性 × 单套取值**(`SM_THEME_PRESET_VALUES` =
`SM_THEME_VALUES` = `["terminal"]`;`auto` 与 `@media (prefers-color-scheme)` 系统
跟随分支一并退场;第 21 个 = M3 WP-80 的深底画布精灵处理,见下表末行):

| 族 | token | 取值(终端单套) |
|---|---|---|
| 背景三层 | `--sm-bg-base` | `#0b0f0b` 近黑(非纯黑) |
| | `--sm-bg-panel` | `#101610` 面板 |
| | `--sm-bg-inset` | `#070907` 内嵌区 |
| 前景 | `--sm-fg` | `#b9ffc4` 磷光绿(16.7:1) |
| | `--sm-fg-dim` | `#6dd47f` 暗绿(10.5:1) |
| 语义色 | `--sm-accent` | `#4fe6c2` 青绿(12.4:1) |
| | `--sm-warn` | `#ffc857` 琥珀(12.6:1) |
| | `--sm-danger` | `#ff8a94`(8.6:1) |
| | `--sm-selection` | `#1c3a25`(对前景 10.8:1) |
| | `--sm-focus-ring` | `#a9ffb8`(16.3:1) |
| 字体 | `--sm-font-mono` | §2.1 定案栈 |
| 效果(恒有定义) | `--sm-scanline-opacity` / `--sm-caret-blink` | `0.06` / `1.1s` |
| 深底精灵处理(M3 WP-80) | `--sm-canvas-sprite-filter` | `brightness(1.6)` |
| 功能对比度族 | `--sm-border` / `--sm-border-button` / `--sm-border-strong` / `--sm-divider` / `--sm-divider-faint` / `--sm-badge-bg` / `--sm-badge-bg-soft` | 磷光绿 α 阶梯(28/34/46/16/12/18/10%) |

- **数值口径**:一律**具体色值**(不依赖系统颜色关键词 ⇒ 真机 axe 判定确定、跨平台
  一致),为**保守可读初值** —— 前景对三层背景的 WCAG 对比度实测 ≥ 8.1:1
  (括号内数值 = 对 `--sm-bg-base`)。
- **可读性口径**:真机 axe color-contrast 是**唯一权威门禁**;本包在 jsdom 层固化
  结构 + 公式面证据(`test/theming/theme-terminal.test.ts`:21 键精确锁定 / 锚同源
  生成 / 效果面恒有定义 / 色板 WCAG 逐对机检)。
- **注入 = `:root` 级缺省 + 单一显式 terminal 锚 + 文档级样式表 + 自定义属性继承**:
  `ensureSmThemeStyles(document)` 幂等注入(各组件 connectedCallback 调用);
  `:root{…}` 规则落在 `html` ⇒ **未设锚的元素同样是终端**(单主题的结构性保证,
  不依赖组件侧回退值副本);`[data-sm-theme="terminal"]` 显式锚同值幂等,并兜住
  三预设期的历史坏锚(一律收敛为终端值)。变量沿 composed 树继承穿透 shadow DOM,
  组件以 `var(--sm-*)` **裸形态**消费(无回退值)、零 JS 解析。锚样式表由变量记录
  **同源生成**(单一来源,严禁手写重复块)。
- **回退值纪律(2026-09-18 起)**:`var(--sm-*, <回退>)` 的回退值**不得是浅色字面量**
  (token 缺失时会静默回落成浅色),只允许终端等价或省略 —— 本仓现行处置 =
  **省略**(唯一例外 = 等宽字体栈 `var(--sm-font-mono, <SM_MONO_FONT_STACK>)`,
  逐字形态由 `test/theming/theme.test.ts` 机检防副本漂移)。
- **独立使用形态**:`<sm-workspace theme="terminal">`(转写为自身 `data-sm-theme`;
  值域即 `SmThemeValue` = 单值;`null` = 不写锚 ⇒ `:root` 缺省 = 终端)。
- **效果类 token 的实装**:扫描线 overlay 与光标闪烁为 `aria-hidden` 纯装饰、
  `pointer-events: none`、包在 `prefers-reduced-motion: no-preference` 内(或给
  reduce 覆盖)、动画只用 transform / opacity;字号下限 13px 由机检固定。
- **深底画布精灵处理(M3 WP-80;M1 遗留项结清)**:Blockly 画布上的垃圾桶 / 缩放
  图标取自 `media/sprites.svg`(`.trash{fill:#888}` / `.zoom{stroke:#888}`,整张精灵表
  经 `<image>` 引用),在近黑画布上偏暗。**按主题锚改写选择器不可行**
  —— 画布样式表注入**画布宿主所在根**(生产形态 = 工作区 shadow 根),而主题锚
  `data-sm-theme` 在 shadow 树**之外**,树内样式表匹配不到树外祖先(M1 真机实测
  `filter` 恒 `none`);故改由 **token 承载**:
  `blockly-theme.ts` 的 `PAYLOAD_CANVAS_CSS` 对 `.blocklyTrash` / `.blocklyZoom`
  取 `filter: var(--sm-canvas-sprite-filter)` —— 自定义属性**沿 composed 树继承**
  穿透 shadow 边界,`var()` 在元素自身求值 ⇒ 零祖先选择器、零重新 inject。真机
  (chromium,真 dist + 真画布)实测 `brightness(1.6)` 下合成非文本对比度
  **3.04:1**(达 WCAG 1.4.11 非文本 3:1;修前 1.82);`--sm-canvas-sprite-filter`
  是唯一一处**非颜色** token。机检:`test/payload/canvas-sprite-filter.test.ts`
  (绑定 + **禁锚选择器回潮** + 单主题恒有定义)、`test/theming/theme-terminal.test.ts`
  (键数锁 21)。
- 机械护栏测试(`test/theming/theme.test.ts` + `test/theming/theme-terminal.test.ts`):
  全部组件样式 var() 之外零 `rgb(0 0 0` / `crimson` 硬编码;除等宽字体栈外**零回退
  值**;axe 套件 **terminal 单锚**零 violations(`color-contrast` 沿既有豁免)。
- **沿革(仅留档,不再有效)**:WP-73 曾把变量面扩为「21 token × light / dark /
  terminal 三预设」(light / dark 取系统颜色关键词 ⇒ 零视觉变化,light / dark 下
  效果面取 `0` / `0s`、精灵滤镜取 `none`),并以 `FROZEN_CONTRAST_VARIABLES` 冻结
  light / dark 的 8 个功能对比度值 —— 该冻结语料与三预设键集一致断言**随 D-UI-6
  一并退场**(测试改为单主题断言,**键集精确锁定保留**)。

### i18n(src/i18n/)

- **Q5 定案**:内置语言集 = {zh-CN(默认), en};zh-CN 目录值 = 现行文案
  原样(抽取只增不破——既有测试文案断言零回退),en 为真实可读英文;
  目录完整性由类型系统(`Record<SmMessageKey, string>`)+ 测试双向断言;
- **取词**:`t(key, params?)` 类型安全,`{name}` 占位双语同构;**响应式**:
  `setLocale / getLocale / onLocaleChange` 模块级 store + `LocaleController`
  组件订阅(切换即重渲染);**BCP-47 降级确定性**:精确 → 主子标签前缀
  (zh-TW→zh-CN、en-GB→en)→ 默认 zh-CN,未知标签确定性回落;
- **锚消费**:组件连接时沿 composed 树找最近 `[data-sm-language]`(WP-52 落下的
  锚机制;原嵌入协议的 `language_changed` 消息面已于 2026-09-19 随 WP-96 退役,
  现在只剩「锚属性」一条路径)并挂 MutationObserver,运行中**锚属性变更**即生效;
  无锚 = 保持内置默认 zh-CN(原嵌入协议 §4.4「宿主不设锚」降级口径,该契约面
  已物理删除,口径保留);
- **抽取面**:全部用户可见字符串(~420 键);协议/状态机词(connected、
  running、write_bytes 等)与数据值(地址、regionId)不入目录;固化语义:
  状态/日志/时间线/编译标签按生成时刻 locale,积木画布按 Blockly 注册时刻
  (运行中切换不追溯,遗留登记)。

### 测试增量(WP-53)

`test/i18n/i18n.test.ts`(目录完整性 / BCP-47 矩阵 / 响应式 / 取词)、
`test/i18n/locale-anchor.test.ts`(锚消费 / 运行中切换 / 无锚降级 / 未设锚保持
默认)、`test/theming/theme.test.ts`(锚样式表 / 变量面 / 机械护栏 /
theme 属性转写 / axe 双主题);既有 518 用例零回退。

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

## WP-F3:字节视图核心(src/views/byte,2026-09-11)

公开视图档(WP-F3)交付面:`<sm-byte-view>` 字节视图本体(栈视图与自由视图
**共用默认形态**,FE-FV-01/02 不重复实现;`view-kind` 只决定标题)、
`<sm-vma-list>` VMA 侧栏。全部只依赖 `MemoryDataSource` 接口;公开入口
(index.ts)导出与工作区集成归 WP-F5 统一接线。

### 定案规则(同时登记于源码注释)

- **默认区域选取**:含 rsp 值的区域(按区域全长 `[起点, 起点+byteLength)`
  判定),否则 `regions()` 第一项;无区域 → 空态。栈/自由视图共用此规则。
- **行网格与窗口外 cell**:行 = 整行 8 字节,对齐偏移 `offset ∈ 0..7` 把网格
  边界平移为「地址 ≡ offset (mod 8)」;窗口两端**对齐外扩**后交给
  `bytesRows()` 查询,越出窗口的地址按数据源契约返回窗口外 cell——行边缘
  十六进制段退化为 `??`(cell-outside)、特殊显示段 `renderSpecialDisplayCell`
  占位,行数 ≤ 513(512 行 + 边界),虚拟化必须真实生效。
- **rsp/rbp 锚点(FE-ST-04 公开档 + M13)**:进入视图 / 切区域时视口锚定
  rsp(窗口外回退顶部);值落在当前区域**已下发窗口**(`windowByteLength`
  前缀,D3)→ 锚点行高亮 + 「回锚」按钮;窗口外 → 明示
  「<寄存器> 内容不在可见窗口」(不渲染空白、不报错);寄存器未公开 → 不呈现。
- **窗口内导航(FE-ST-06 公开档 / M3)**:跳转输入 `0x` 十六进制 = 绝对地址、
  纯十进制 = 窗口内偏移;窗口外输入给「在可见窗口之外」反馈,不报错不滚动;
  检索调 `dataSource.search()`(语义 = 仅已下发窗口字节),命中列表点击滚动,
  跨区域命中先切区域(派发 `region-change`)。

### 组件公共 API(F5 接线)

- `<sm-byte-view>` 属性:`dataSource: MemoryDataSource | null`(换绑即重建)、
  `viewKind: "stack" | "free"`、`alignmentOffset: number(0..7)`、
  `activeRegionId: string | null`;方法:`refresh()`(投影更新驱动,接线
  `client.onProjectionChanged(() => view.refresh())`)、
  `showRegion(regionId)`;事件:`region-change`(detail `{regionId}`,
  bubbles + composed)。预留 F4 跳转链右段槽位:行右段(特殊显示列)为独立
  `<span role="cell" class="row-special">`,`<sm-jump-chain>` 由 F5 在宿主层
  按行挂接,本组件不直接依赖链组件。
- `<sm-vma-list>` 属性:`dataSource`、`selectedRegionId`;事件:`vma-select`
  (detail `{regionId}`)→ 宿主接 `byteView.showRegion(regionId)`;方法:
  `refresh()`。
- 动画纪律:组件样式零动画;如后续引入过渡只允许 transform / opacity。

测试面:`test/views/byte/`(行切分纯函数偏移 0..7 × 窗口边界 × 奇数长度、
窗口外 cell 语义、锚点命中/窗口外(M13)、VMA 渲染与选择事件、检索命中滚动、
虚拟列表首屏有界、高地址在下顺序;夹具 = `fake-data-source.ts` 内存版
`MemoryDataSource`,镜像公开档契约语义,组件测试不经任何 client/store)。

## WP-F4:寄存器视图与跳转链(src/views/register、src/views/chain,2026-09-11)

公开视图档(WP-F4)交付面:寄存器视图、寄存器 × 区域交叉标注原语、跳转链
窗口内部分(首段 ≤3 段、循环回环、窗口外截断、链末可见字符延伸)。全部只依赖
`MemoryDataSource` 接口;公开入口(index.ts)导出与跨视图集成归 WP-F5 统一接线。

```
src/views/
├── register/
│   ├── sm-register-view.ts   <sm-register-view>:FE-RG-01/02/03——纵向全量白名单
│   │                         寄存器(M14:前端不留占位)、行三段布局(名 / 值 /
│   │                         特殊显示列"→ regionId")、点击值复制剪贴板(Q8 降级)、
│   │                         行聚焦 + Enter 复制基线
│   └── cross-annotation.ts   FE-RG-04 纯函数:crossAnnotateRegisters(registers,
│                             regions) → RegisterHit[](值命中已下发窗口的行集合)+
│                             renderRegisterAnnotationCell(字节视图行左缘标注
│                             单元格;点击展开归宿主接线,不直改 sm-byte-view)
└── chain/
    ├── resolve.ts            FE-ST-07/09 纯函数:resolveJumpChain(start, dataSource,
    │                         {maxSegments}) → JumpChainSegment[]({addressHex,
    │                         valueHex?, targetAddressHex?, loopBack?, outsideWindow?})+
    │                         chainLimitReached;横向 3 段上限 / 展开 32 段上限常量
    ├── visible-run.ts        FE-ST-10 纯函数:visibleRunAt(链末可见字符延伸,
    │                         ≤32 字节)+ renderVisibleRun(引号字符段)
    │                         (WP-75#11 登记:模块原导出 visibleRunOfRow(行内
    │                         全可见字符)无调用方,已于 M2 清理;行级需求由
    │                         byte-view 的逐 cell 特殊显示承载)
    └── sm-jump-chain.ts      <sm-jump-chain>:横向 ≤3 段地址芯片 + SVG 回环箭头 +
                              尾随目标芯片 + "展开完整链"(竖向,可收起);
                              点击地址发 viewport-jump 事件(组件只发事件)
```

### 端序与链解析定案(WP-F4 登记)

- **端序 = 小端**:公开投影不携带端序字段,公开描述包 `vmProfile.endianness`
  已冻结 "little",`MemoryDataSource` 无端序入参——`resolveJumpChain` 一律按
  小端解释窗口字节(低地址字节为低位);协议未来携带端序时在 resolve.ts 接入。
- **段语义**:段地址的 8 字节须全部落在某区域已下发窗口(`windowByteLength`
  前缀)内才可解引用,否则该段 `outsideWindow`(截断不报错,D3);值落在某可见
  区域**范围**(`byteLength`)→ 给出 `targetAddressHex` 继续解引用(超出已下发
  前缀的落点由下一段 `outsideWindow` 表达"窗口外落点即截断");值未落任何区域
  → 仅记 `valueHex` 终止;目标已在链中 → `loopBack` 回环终止。
- **交叉标注口径**:FE-RG-04 按窗口内部分交付——值命中**已下发窗口**才产出
  标注;窗口外 / 未映射缺席且不报错。跳转链同理(窗口内部分),全量归 WP-F8。
- **Q8 剪贴板降级**:`navigator.clipboard` 不可用(非安全上下文)或写入被拒 →
  选中文本节点 + 行内提示"已就绪手动复制"(自动消隐);成功反馈"已复制"。
  剪贴板调用可注入(`<sm-register-view>.copyToClipboard`)。

### F5 接线事件契约

- `<sm-jump-chain>`:`viewport-jump` 事件(bubbles + composed),detail
  `{ addressHex: string; withinWindow: boolean }`——落点窗口内由宿主处理滚动,
  `withinWindow: false`(窗口外段)宿主给"窗口外"反馈;组件只发事件。
- `<sm-register-view>` 属性:`dataSource: MemoryDataSource | null`、
  `copyToClipboard: ClipboardWriter`;投影更新由宿主重设数据源(或替换装配面)驱动。

测试面:`test/views/register/`(交叉标注 + 寄存器视图:复制成功 / 降级两路径、
键盘 Enter、大写归一化)、`test/views/chain/`(首段解析 / 端序 / 回环 / 窗口外 /
段数上限 / 展开 / 点击事件 / 可见字符延伸)。组件测试经 `test/tsconfig.json`
(Lit legacy 装饰器);测试用公开档夹具 = `ProjectionStore + ProjectionDataSource`
(与生产同一语义路径)。jsdom 的 Selection 不支持影子根内选区(rangeCount 恒 0,
真实浏览器无此限制),降级路径测试以 `Selection.addRange` 侦察验证。

## WP-F5:工作区容器与菜单(src/workspace,2026-09-11;WP-71 起固定窗口集;2026-09-18 起整页布局 —— D-API-153 / D-UI-1 ~ D-UI-7)

M2 收口交付面:`<sm-workspace>` 工作区本体(F1 空壳替换为真实现)、
`<sm-workspace-menu>` 顶部菜单、窗口类型注册表、布局模型纯状态机、
`<sm-byte-tab>` 字节页组合、`<sm-register-annotation>` 行左缘交叉标注。

### 定案规则(主控已裁决,同时登记于源码注释)

- **固定窗口集(D-MP-1,WP-71;2026-09-18 改版后仍不修订)**:视图集合 =
  注册表登记的**全部类型、各恰一个实例、常驻**;视图**没有开 / 关状态**,只有
  「显示 / 暂离(不勾选)」与「聚焦」。管理动作收敛为**聚焦导航**
  (`focusWindow(type)` / 菜单「视图」组)、**勾选显示**(左半侧列表按钮的
  原生 checkbox,**唯一入口**)、**列表内重排**(左半侧列表按钮的拖拽 /
  `Alt + ↑ / ↓`,**唯一入口**)。工作区接入(首帧前)一次性绑定
  (`WorkspaceLayoutModel.bindWindows(entries, order?)` —— **已无 `columns`
  参数**;顺序缺省 = **登记序**,显式 `order` = 未覆盖类型按登记序补末尾,
  登记序来源 = `layout-presets.ts` 的 `DEFAULT_VIEW_ORDER`,**顺序语义的唯一
  来源**,模型自身不持有默认顺序字面量);无关闭入口、无空态引导;
  解题 ↔ 调试模式切换**只换绑数据源**(`layoutSnapshot` 深度相等),布局零副作用。
- **整页布局与左右两分(D-UI-1 / D-UI-2)**:工作区自身即页面主体
  (`display: grid` + `block-size: 100dvh`),**不依赖宿主给高度**,溢出不上浮到
  文档层;左右两分 = `grid-template-columns: repeat(2, minmax(452.4px, 1fr))`
  —— **固定 1:1、无 gap / 无 border / 无 divider、不可调**(无分界拖拽手柄);
  左半侧 `min-inline-size: 452.4px` ⇒ 窄屏页面**横向滚动**;**右半侧 = payload
  搭建窗口**(从 `#contents` 里把 payload 内容元素**同一实例**挂过去,不重建),
  **左半侧 = 视图管理窗口**(列表按钮在上,视图位纵向堆叠在下)。详见下节。
- **窗口类型注册表(Q2 起四类,WP-71 起单实例常驻)**:`stack`(栈视图)/
  `free`(自由视图)共用 `<sm-byte-tab>`(view-kind 只决定标题)/`registers`
  (寄存器视图)/`payload`/`debug`(WP-F8 起 = 指令视图真工厂)带工厂;
  `register()` 为开放扩展点(Map 保序覆盖语义:宿主可替换工厂 / 文案);
  **注册项不携带实例数语义字段**——单实例由 `bindWindows` 结构性保证
  (窗口 id ≡ 类型键,同类型重复实例无法表达)。
- **菜单(FE-WS-03/04a/05;三组口径见下)**:**「视图」组** = 10 个视图**聚焦**
  按钮(点击 = 聚焦并滚动到该视图,`aria-pressed` 表达当前焦点,恒可用无禁用态)
  + **「重置视图」**(恢复默认顺序 + 全选);该组**不承载勾选 / 排序**(唯一入口
  = 左半侧列表按钮,D-UI-7 补充裁定,见 `decisions-分发改版与UI重设计.md`
  §四·补.5)。**「模式」组** = 模式指示(解题模式 / 调试模式)。**「运行」组** =
  指令步进 `step`(恰执行一条指令后暂停)+ 积木步进 payload-step + 运行到断点 +
  模式切换 + 提交 + 重启测试环境 `reset`(**终态(won/failed)禁用**并呈现
  「测试环境已结束,请新建会话」引导——引导动作 = `new-session-request` 事件,
  **由消费方执行** `close_session`(如未关)+ 新会话流程(工作区只发请求事件)——
  分发改版后的承载形态 = 独立页面 `apps/page-app`,而启动授权凭证是**单次消费**
  的 ⇒ 新会话须由平台**重新签发一次性启动地址**;引导动作口径 = Q5/M11)。
  **「窗口」组与「布局」组均已不存在**。积木步进归 WP-F6(Q3)、运行到断点与
  解题/调试模式切换 UI 归 WP-F8。
- **连接状态呈现**:connecting/connected/reconnecting/disconnected 全量呈现
  (status + revision + 连接态);reconnecting 显示 attempt / retryDelayMs;
  connection-replaced(close 1008 单连接策略)转为 alert + 手动重连;
  断线横幅呈现「最近一次公开投影(revision N)+ 重连中」,**零本地 VM 降级**;
  动作被拒(onActionRejected)呈现 userVisibleError——code + message +
  explanation(hints 与事实字段),「知道了」消隐。
- **组合根装配**:工作区持有 `client`,`client` 换绑即
  `dataSource = new ProjectionDataSource(client.store)` 注入各窗口内容,
  `client.onProjectionChanged(() => 各内容 refresh())` 驱动刷新;视图组件
  本身仍只依赖 `MemoryDataSource` 接口(§四纪律不破)。

### 整页布局与视图管理窗口(2026-09-18 UI 改版;D-API-153 / D-UI-1 ~ D-UI-7)

本版把工作区从「Niri 式列条带」整体改为**整页布局 + 左右两分 + 左半侧视图管理
窗口**。以下逐面登记**当前形态**;原 WP-72 的列条带交互见文末**废止表**
(历史定案条目本身保留在案,不静默删除)。

**① 整页布局(FE-WS-01 / D-UI-1)**:`<sm-workspace>` 自身即页面主体 ——
`display: grid` + `block-size: 100dvh`(兜底 `100%`),**不依赖宿主 / 壳给出高度**;
页面根不可滚动,溢出**不上浮到文档层**(纵向由左半侧内部滚动承载)。

**② 左右两分(D-UI-1)**:`grid-template-columns: repeat(2, minmax(452.4px, 1fr))`
—— **固定 1:1、不可调**;两侧同底线 ⇒ 宽屏精确等分;窄屏(网格宽 > 视口宽)时
**页面横向滚动**(判据见 `test/geometry/measure-workspace-geometry.cjs` ⑦)。
**无 gap、无 border、无 divider、无分界拖拽手柄**;左半侧另有
`min-inline-size: 452.4px`(常量 `SIDE_PANEL_MIN_WIDTH_PX`)。**否决项(不得复活)**:
窄屏隐藏右半侧 / 改抽屉或 Tab 切换 / 改上下堆叠 / 新增断点阈值表的替代物。

**③ 右半侧 = payload 搭建窗口(固定)**:payload 内容元素从 `#contents` 里以
**同一实例**挂到右半侧(不重建 —— payload 状态跨模式 / 跨渲染必须保留,
FE-WS-07 的 `#contents` 生命周期约定是既有不变量);右半侧不随左侧滚动移动。
**裁决 A(D-UI-7 ①)**:左半侧视图栈**不渲染 payload 视图位**(payload 的唯一
呈现位 = 固定右半侧)⇒ `landmark-unique` 重名消除,面板地标名保持原样。

**④ 左半侧 = 视图管理窗口(FE-WS-11 / D-UI-2 / D-UI-3 / D-UI-4)**:

- **列表按钮在上、视图位纵向堆叠在下**;`.ws-stack` 是**滚动容器**
  (`overflow-y: auto` + `scroll-behavior: smooth`,**`prefers-reduced-motion:
  reduce` 下降级为 `auto`** —— 本版 reduced-motion 的降级对象就是这条**左半侧
  丝滑滚动动画**;`Ctrl + ↑/↓` 的滚动定位同受此降级)。
- **只滚动、不压缩**:每个**可见**视图位高度由 `viewSlotHeightPx()`
  (`src/workspace/layout-presets.ts`)**算好后内联**到 `.ws-view` 的
  `block-size`;算式 = `max(floor((左半侧可视高 − 列表按钮高 − 留白) ÷ 2), 下限)`,
  **下限** = `ceil(VIEW_PANEL_CHROME_HEIGHT_PX + 4 × HEX_ROW_HEIGHT_PX)`;空间不足
  时视位高不低于下限,多余部分由左半侧纵向滚动承载。**可读性判据(FE-WS-15)**:
  **不得出现「视图被压到装不下一行字节」**(历史反例:4 窗列每窗 146px 而面板
  chrome 实测 182.1px;2026-09-19 新反例 = 遗留 #39 窄档 chrome 反超视位高)。
- **列表按钮(勾选 / 排序的唯一入口,D-UI-4 / D-UI-7 ③)**:视图管理窗口的
  `<details><summary>` 列表 —— **原生 `<input type="checkbox">`** 承载勾选
  (`Space` 原生可用)、**列表内拖拽重排**(落点反馈 = 静态 class
  `drop-before` / `drop-after` + `dragging` opacity,零动画、零浮动层)、
  **`Alt + ↑ / ↓`** 键盘等价重排;操作经 `aria-live="polite"` 播报
  「已显示 / 已隐藏 / 已移动到第 N 位」。
- **`Ctrl + ↑ / ↓`(D-UI-3)**:在**左半侧容器**上捕获 `keydown` 并
  `preventDefault()`(覆盖浏览器页面滚动默认),切换一格**可见**视图位,
  **边界不环绕**;当前视图名经常驻 `role="status"` 宣读。
- **视图类型名写在视图内左上角**(FE-WS-11):`.view-label` 是面板内第一个元素,
  **不是独立标题栏**(原 `.tab-bar` 整条退场);面板地标名保持原样
  (`aria-label` = 注册表 `info.title`,D-UI-7 ①:不因标题栏消失而改名,避免
  二次 axe 地标重名回归)。
- **视口外降级渲染(保留,与布局形态无关)**:视图位声明
  `content-visibility: auto` + `contain-intrinsic-size: auto <VIEW_SLOT_INTRINSIC_PX>px`
  (语义标记 `data-render-degrade="content-visibility"`),
  离屏子树由浏览器跳过渲染与绘制 —— 零 JS、零浮动层。
- **尺寸变化驱动**:`#onViewportResize`(+ `#measureLeftRole()` 读 `.ws-left` 的
  `clientWidth` / `clientHeight`,`view?.innerWidth` / `innerHeight` 作无布局环境
  兜底)**只更新测量值与快照面**;`#measureViewportWidth()` 与「跨档重绑」语义
  **已不存在**(窄屏形态不改变,D-UI-5)。

**⑤ 终端单主题(2026-09-18 D-UI-6)**:主题收敛为**一套** —— `SM_THEME_PRESET_VALUES
= ["terminal"]`;21 枚 token 名保留(`--sm-*`),锚 = **`:root` 级缺省**(未设锚
即终端)+ **单一 `[data-sm-theme="terminal"]` 锚**(零 JS 解析,`ensureSmThemeStyles`
幂等注入);**回退值一律不得是浅色字面量**(token 缺失时会静默回落成浅色 ——
本仓反复踩过的「看起来生效」失败模式),由无豁免的严格回退值机检兜住;
字号下限 13px。

**⑥ 常量语义改述(数值一个字不改)**:`VISIBLE_VIEW_SLOT_COUNT = 2`
(D-UI-2:**固定两个可见视图位**,数量不可配置);`SIDE_PANEL_MIN_WIDTH_PX =
MIN_COLUMN_WIDTH = 452.4px` —— 该 58ch × 7.8px 推导值**载体已改挂**(沿革:
原载体 = 已废止的列条带列宽,见下方废止表;现载体 = 左半侧宽度底线),
含义同步改述为「**十六进制行本身**不折行」,**不含**字节
视图自带的 `14rem`(224px)VMA 侧栏 ⇒ **左半侧宽 < ≈766px 时字节视图必有某种
降级**(折叠侧栏 / 列头折行 / 视图内横向滚动)= **已接受的代价,不是缺陷**;
「把该底线抬到 ≈766px」**已否决**(会把表达力问题变成准入问题,并使 1024 / 1366
笔记本不可用)。可读性红线的独立载体 = `apps/page-app/e2e/geometry-guard.spec.ts`
(真机量「完整可见数据行数」;`N ≥ 1` 全档无条件,`N = 4` 仅免折行宽度档要求)。

**⑦ 默认顺序的单一来源**:`layout-presets.ts` 的 `DEFAULT_VIEW_ORDER`(顺序与
改版前的列排布登记序一致)+ `orderByDefault()`;`bindWindows(bindings, order?)`
的 `order` 参数是唯一注入点,工作区与菜单**不得**再写第二份默认顺序字面量。

#### 废止表(WP-72 历史定案 → 本版处置;**条目本身保留在案,不得静默删除**)

废止宣告:**已废止(2026-09-18/19 UI 改版;D-API-153 / D-UI-1 ~ D-UI-7)**。
下表左列为**已验收过的历史定案**(WP-72 / D-API-152),右列为本版处置;原定案
(三类拖拽落点 / 列宽五档 / 焦点列相机 / P0·P1·P2 预设 / 窗高下限)随**列条带整体
废止**,源码中已物理删除(不留兼容别名)。**裁决条目本身保留**:权威文本 =
`docs/develop/decisions-分发改版与UI重设计.md`(D-UI-1 ~ D-UI-7 / §四·补)与
`docs/develop/权威API语义规约.md` **D-API-152 / D-API-153**(两条**仍在案**)。

| 已废止的 WP-72 定案 | 本版处置 |
|---|---|
| Niri 式列条带(列的有序序列、列间水平滚动、列内 Hyprland 二叉分割) | 整条退场;模型改为**一条有序视图列表 + `visible` 勾选 + 焦点**(`workspace-model.ts`) |
| 视口宽预设 **P0 / P1 / P2** 三档 + 阈值判定表(`WIDE_MIN_PX` / `NARROW_MAX_PX`)+ `selectLayoutPreset` / `LAYOUT_PRESETS` / `LayoutPresetId` | 整条退场;默认顺序改由 `DEFAULT_VIEW_ORDER` + `orderByDefault()` 承担 |
| 列宽五档 `COLUMN_WIDTH_PRESETS`(1/4、1/3、1/2、2/3、全宽)与「布局」组入口 | 整条退场(列结构不存在);菜单**「布局」组已不存在** |
| 列间 / 窗间分隔条(`role="separator"` + `tabindex=0` + 方向键 ±32px)与 `DRAG_THRESHOLD_PX` 列宽语义 | 整条退场;两分**固定 1:1、不可调** |
| 焦点列居中相机 `layout-camera.ts` 的 `cameraScrollLeft` / `ensureTabVisible` 横向居中 | **源码文件已删除**;纵向滚动改由 `.ws-stack` 原生滚动 + `Ctrl + ↑/↓` 切换承担 |
| 三类拖拽落点 `DropTarget`:`stack` / `cross-column` / `new-column`、列间空隙新建列位 `openColumnAt`、`data-gap-index` / `drop-target` 轮廓 / `.layout-status` | 整条退场;只保留**列表内重排**一种落点语义(`drop-before` / `drop-after`) |
| 窗高 / 列高下限:`MIN_ROW_HEIGHT_PX = 266`、`columnMinHeightPx` / `columnChromePx`、拖拽像素语义与 `layout-divider.ts` | **常量与文件均已删除**;可读性改由「左半侧只滚动不压缩 + 每视图位确定高度」承载(算式见 ④) |
| 尺寸状态进模型:`columns[].widthRatio` / `columns[].rowHeights` / `viewportWidth` / `setColumnWidth` / `setRowHeights` / `applyPreset` / `resetLayout` | 快照面替换为 `views[]` / `focusedType` / `activeType` / `leftRoleWidth`;「重置布局」→ **「重置视图」**(恢复默认顺序 + 全选) |
| 窗口标题栏 `tabindex=0` 方向键列内重排 / 跨列移动、标题栏控件面 | `.tab-bar` 与标题栏键盘面退场;类型名移入视图内左上角,键盘路径改由列表按钮承担 |

### 跨视图集成接线(本 WP 落地点)
- **VMA 回路**:`vma-select` → `byteView.showRegion(regionId)`;
  `region-change` → 回写 `vmaList.selectedRegionId`(在 `<sm-byte-tab>` 内闭环)。
- **寄存器交叉标注(FE-RG-04)**:投影变更后 `crossAnnotateRegisters` 缓存;
  行装饰按行区间 `[rowBaseAddressHex, rowBase + cells.length)` 过滤命中,
  行左缘渲染 `<sm-register-annotation>`(按钮面复用 F4
  `renderRegisterAnnotationCell`,点击行内展开寄存器值列表)。
- **跳转链(FE-ST-07/09)**:行右段(`.row-special` 槽位)按行挂
  `<sm-jump-chain>`——仅当该行 8 字节小端解释**形似地址**(可解引用且落回
  某可见区域范围,经 `resolveJumpChain(maxSegments:1)` 判定)才挂载;
  虚拟列表只渲染可视行 → 挂载量天然有界。宿主监听 `viewport-jump`:
  `withinWindow` → `byteView.scrollToAddress(addressHex)` 滚动到目标行 +
  反馈;`withinWindow: false` → 「在可见窗口之外」反馈,不滚动不报错。

### byte-view.ts 最小 diff 登记(WP-F5 唯一动 F3 交付文件处)

行装饰与 viewport-jump 滚动必须落在字节视图行内/行几何上,宿主层无法在不
复制渲染逻辑的前提下注入,故对 `src/views/byte/byte-view.ts` 做**最小 diff**
(行为零回归,F3 测试全绿):

1. 新增 `rowDecorator` 属性 + `ByteRowDecoration` 接口:`lead` 渲染在行左缘
   (地址段之前)、`specialSuffix` 追加在 `.row-special` 末尾;装饰器换绑时
   重建行渲染器(虚拟列表以 renderItem 身份变化重渲染可视行);
2. 新增 `scrollToAddress(addressHex): boolean` 公共方法(复用内部
   `rowIndexForAddress` + 滚动管线;窗口外返回 false)。

其余集成全部为宿主层追加渲染 / 包装组件,未改 F3/F4 任何其他文件。

### 测试面

`test/workspace/`:布局模型(`workspace-model.test.ts` / `workspace-layout-model.test.ts`:
窗口集绑定各恰一实例 / 缺省登记序与显式 `order` / 焦点导航 focusWindow /
**`visible` 勾选幂等与焦点不受影响** / **列表内重排 `moveView` 与原地 no-op** /
`resetViews` 恢复默认顺序 + 全选 / `Ctrl + ↑/↓` 落点 `stepActiveView` 不环绕 /
窗口集不变量机检 `isWindowSetComplete` / `isLayoutStateValid`)、可读性阈值与默认
顺序(`layout-presets.test.ts`:宽度推导逐项机检 / `SIDE_PANEL_MIN_WIDTH_PX =
MIN_COLUMN_WIDTH` 载体改挂左半侧 / `viewSlotHeightPx()` 与
`VISIBLE_VIEW_SLOT_COUNT`)、注册表(默认登记序 / 工厂面 / 登记集合 → 窗口集 1:1 /
可扩展 / 覆盖更新)、`<sm-workspace-menu>`(**三组口径与 aria-pressed 焦点表达 /
无 `.window-group-label` 与 `.layout-group` 断言** / 无「打开 / 关闭」语义文案 /
step·reset 禁用矩阵 / 终态引导 / 断线横幅 attempt·retryDelayMs /
connection-replaced 手动重连 / 拒绝错误含 explanation)、`<sm-byte-tab>`(vma 回路 /
rowDecorator 透传 / refresh)、`<sm-register-annotation>`(按钮面 / 点击展开收起)、
`<sm-workspace>` 集成与整页布局(`sm-workspace.test.ts` / `sm-workspace-layout.test.ts`:
全部登记类型常驻且各恰一实例 / 无关闭入口(按钮 / aria / 公共 API 三面)/
无空态引导 / focusWindow 聚焦与滚动 / **左右两分与视位高内联** / **列表按钮勾选与
`Alt + ↑/↓` 重排 / `aria-live` 播报** / **`Ctrl + ↑/↓` 捕获与 `preventDefault`** /
**模式切换 layoutSnapshot 深度相等** / **真实 SessionClient mock 全链路**:
step·reset 帧形态、终态禁用引导、断线横幅、踢旧重连、rejected 呈现、投影回流刷新、
交叉标注与跳转链挂载、viewport-jump 滚动/窗口外反馈)。

## WP-F9:教学组件面(src/views/ed + src/ed,2026-09-11)

计划书阶段四范围的 FE-ED-01~08(《阶段四任务分解》§二轨道 C WP-F9;来源 =
计划书 §十二阶段四原文)。独立组件面,**全部属性驱动、可独立实例化、
standalone 测试**;不集成进工作区——工作区挂接 / 失败计数接线 / 错误呈现
替换归 **WP-F8**。公开描述包类型(challenge-schema)前端**禁止 import**
(dependency-cruiser),故 `PublicHint` / `PublicErrorMapping` 以本地最小
结构类型登记于 `src/ed/ed-types.ts`(对齐锚 =
`packages/challenge-schema/docs/双包Schema语义.md`;结构化类型系统下与
challenge-schema 实例互认)。

### 组件清单与属性/事件契约(F8 接线表)

| 组件 | FE | 属性(全部 `attribute: false` 除注明) | 事件 | 数据来源(宿主注入) |
|---|---|---|---|---|
| `<sm-structure-view>` | FE-ED-01 | `highlights: SemanticHighlight[]`(协议投影 semanticHighlights) | `highlight-jump`,detail `{regionId, addressHex}`(bubbles+composed) | `client.store.snapshot.semanticHighlights` |
| `<sm-call-stack>` | FE-ED-02 | `frames: PublicCallFrame[]` | — | `snapshot.callStackSummary`(delta 存在即整体替换,store 已处理) |
| `<sm-memory-diff>` | FE-ED-03 | `beforeRegions?: VisibleMemoryRegion[]`(动作前快照)、`delta: ProjectionDelta \| null` | — | 宿主在 onActionResponse / onProjectionChanged 处保存前一投影 `visibleRegions` + 最新 `projectionDelta` |
| `<sm-timeline>` | FE-ED-04 | `entries: TimelineEntry[]`、`currentRevision: number \| null` | — | 纯函数 `buildTimeline(actionRecords, checkpoints, submissions?)`(src/ed/timeline.ts)消费 `onActionResponse` 流 + `client.listCheckpoints()`(+ 可选 submit 记录);`currentRevision = client.store.revision` |
| `<sm-checkpoints>` | FE-ED-05 | `checkpoints: CheckpointRef[]`、`sendAction: (action: ActionObject) => void \| null`、`sessionTerminal: boolean`(attr `session-terminal`)、`error: string`(attr) | — | `client.listCheckpoints()` 刷新 `checkpoints`;`sendAction = client.sendAction.bind(client)`;终态 = 投影 `status ∈ {won, failed}`;`error` 由 onActionRejected / SessionCommandError 文案驱动 |
| `<sm-hint-ladder>` | FE-ED-06 | `hints: PublicHint[]`、`failures: number`(attr) | — | 公开描述包 `hintLadder`;`failures` = 宿主按 ActionResponse failed/wrong_answer 类反馈自账(组件本地执行 revealPolicy,零派发零网络) |
| `<sm-error-explainer>` | FE-ED-07 | `error: PublicError \| null`、`mappings: PublicErrorMapping[]` | — | `userVisibleError`(onActionRejected);`publicErrorMapping`(公开描述包) |

纯函数面(`src/ed/`):`computeByteDiff(beforeRegions, dirtyRanges)` →
`ByteDiffUnit[]`(跨 dirtyRange 归并、前值仅在前快照已下发窗口内判定、写回
原值剔除、地址升序、bytesHex 大小写归一小写);`buildTimeline` /
`summarizeActionObject`(动作摘要 = type + 关键参数;create_checkpoint 响应
与 checkpoint 列表同 revision 时去重只保留 checkpoint 条目);`validateCheckpointLabel`
(≤128 + 禁 C0/C1,与 protocol CreateCheckpointArgsSchema 同则)。

### 语义口径(与协议/规约逐条对齐)

- **FE-ED-01**:kind 分组序 = 冻结枚举序(buffer_start → return_address_slot
  → saved_rbp_slot → canary_slot → custom),空组不渲染;semanticHighlights
  是静态声明面(增量恒缺席),只在初始投影 / sync 全量变化;
- **FE-ED-02**:index 0 标注「最内帧(当前函数)」;截断标记(last frame
  presence-only `truncated`)→ 明示「仅显示最内 64 帧」,**不用 +N 计数**
  (D2),不渲染空白;空栈空态;
- **FE-ED-03**:delta 整体替换语义——组件只整体重算最新 delta,不跨 delta
  累积;前值不可知(窗口外 / 未知区域 / before 缺省)行内明示「前值不可知」,
  不伪造;`truncated` range → 「变更承载被截断,已按协议以 sync-projection
  重新对齐」;
- **FE-ED-05**:checkout 两步确认(组件内确认态,非原生 confirm);校验失败
  行内呈现不派发;列表刷新由宿主在响应回流后重拉 `list_checkpoints`;
- **FE-ED-07**:能力矩阵缺席形态——`addressHex`(forbidden / null-only)、
  `explanation`(forbidden 码)缺席就不渲染,**不以 null/空串区分**;
  explanation 子字段逐键「存在才渲染」;teachingNote 按 errorCode 匹配,
  无匹配给「该错误暂无教学注解」。

### FE-ED-08 无障碍基线与 axe 豁免清单

全部 7 组件:语义化 DOM(嵌套列表 / ol / table+caption+scope / dl / 原生
button+input)、全键盘可达(Tab 序、Enter/Space 原生激活、`:focus-visible`
可见焦点)、kind/状态/截断/当前/锁定等信息全部文本承载(不以视觉为唯一
载体)、动画零(zero transform/opacity 之外的属性)。

`test/ed/axe.test.ts`:每组件代表性满内容挂载后 `axe.run(document,
{resultTypes:["violations"]})`,断言零 violations;套件含**红灯反例**
(light DOM + shadow DOM 各一的无名称按钮必须被检出,证明机检真实生效、
axe 穿透 open shadow DOM)。豁免清单(逐条理由登记在测试文件头,不得整体
跳过):

1. `color-contrast`(rules 配置禁用)——jsdom 无布局引擎与真实 CSS 级联,
   对比度不可判定,任何结论都是环境伪影;对比度证据留给 WP-45 的真实浏览器
   Playwright 报告归档(阶段退出条件 6);
2. 页面级 harness 修正(非规则豁免)——测试文档注入 `lang="zh-CN"`、
   `document.title`、唯一 `<main>` + `<h1>`:模拟**承载页面**的页面职责
   (当前分发形态 = `apps/page-app` 整页壳;原插件壳已随 WP-96 物理删除),
   不构成对组件面的让步。

测试面:`test/ed/`(computeByteDiff 归并/窗口外/前值缺失边界、buildTimeline
动作流/checkpoint 混合/终态/submit 合并、标签校验、axe 套件)、
`test/views/ed/`(七组件渲染/交互/事件:分组与 highlight-jump、截断明示、
diff 对照与整体替换、时间线当前 revision、create 校验/checkout 两步确认/
终态禁用、revealPolicy 两分支与计数边界、能力矩阵缺席形态 × teachingNote
匹配/缺省)。新代码行覆盖 100%(分支 95.3%,≥85% 门槛)。

### WP-F8 对接注意事项

- 组件尚未进入公开入口(`src/index.ts` 未导出,`vite.config.ts` 未加入口)
  ——挂接工作区时由 F8 一并追加导出与(如需)独立 bundle 入口;
- `<sm-memory-diff>` 需要「动作前快照」:宿主在投影变更处保留前一投影
  `visibleRegions`(如 store 订阅里缓存 `snapshot.visibleRegions` 再应用
  delta),组件只收 `(beforeRegions, delta)`;
- `<sm-hint-ladder>.failures` 的计数口径 = ActionResponse 教学失败反馈
  (failed / wrong_answer 类)由宿主自账;checkout/create 派发后刷新
  `list_checkpoints` 的时点建议 = 对应动作响应到达且 `status ≠ rejected`;
- `<sm-error-explainer>` 可整体替换 F5 菜单条(`sm-workspace-menu` 内联的
  拒绝错误呈现)或并存:属性面已对齐(userVisibleError + 公开描述包
  mappings)。


## WP-F6:Payload 搭建框架(src/payload,2026-09-11)

M3 交付面:`<sm-payload-tab>` 三区布局(FE-PB-01)、积木 → 12 动作编译器
骨架(M9 变通口径)、原子动作粒度步进执行器(Q3 主控定案)、工作区「积木
步进」菜单动作(FE-WS-04b)。

### 定案规则(主控已裁决,同时登记于源码注释)

- **Q3 原子动作粒度**:积木图编译为 12 动作**原子动作序列,每个原子动作 =
  一步**;循环/分支的步进暂停只发生在原子动作边界;断点积木 = 步进暂停点
  (M7 变通:纯客户端编排,服务端协议零改动);程序区按原子步骤逐行列出、
  当前步高亮,输出区逐条记录动作摘要 + 响应状态 + 可解释错误——步进粒度
  以此呈现,submit 裁决命令与积木步进无关(独立按钮/流程)。
- **求值口径(M9 底线)**:变量/运算/字符串/列表在**客户端编译期求值**,
  求值环境 = 公开投影只读快照(`createPublicEvalEnvironment(dataSource)`:
  `registers()` → 寄存器名 → 值;`bytesRows()` → 窗口内字节;未知引用 /
  窗口外地址**确定性报错**,零静默兜底)。数值 = 64 位无符号回绕(与协议
  64 位容器同构);端序 = 小端(同 WP-F4 定案)。
- **编码定案**:公开档无编码表下发,字符串一律按 **UTF-8** 字节写字入
  `write_bytes`(公开描述包 `encodingTable` 仅属字节权威执行模式的接口
  token 语义,与积木字符串无关)。
- **展开上限**:`PAYLOAD_MAX_EXPANDED_ACTIONS = 256`(同时约束"展开语句访问
  数"与"产出步骤数",取更严者)——循环/函数内联超限**确定性报错**;函数
  内联深度上限 `PAYLOAD_MAX_CALL_DEPTH = 32`(防递归失控);表达式求值步数
  上限 `PAYLOAD_MAX_EVAL_STEPS = 4096`。
- **allowedActions 编译期裁剪**:积木映射的动作不在题目 `allowedActions`
  白名单 → 编译错误(带 blockId,UI 以 Blockly 警示气泡标红),不产出对应
  步骤;缺省白名单 = 12 动作裁去 `run_to_event`(教学范围定案:不暴露)。
- **运行期限流(D-API-50~53)**:429 / `budget_exhausted` → 执行器转
  `error` 态 + `onError` 分发可解释 `PublicError`,**光标不动**(被拒动作未
  执行,revision 不前进),重试由用户手动步进(同一动作重新提交);实测
  反馈只调 D-API-50~53 参数面,不改契约(执行器 `stepIntervalMs` +
  可注入 `delay` 是联调 knob)。
- **编辑即复位**:画布结构变更(Blockly 结构事件)→ 程序过期标记;运行/
  单步前自动重编译并复位游标(确定性语义:编辑即复位步进)。
- **shadow DOM 适配定案(实测)**:Blockly 官方对 shadow DOM 支持有限
  (样式注入 document 头、几何依赖 light 树)——画布容器以 **light DOM**
  挂载(组件内 `appendChild` 到自身轻 DOM + `<slot name="canvas">` 布局),
  右栏留 shadow DOM。jsdom 实测:inject / 序列化 / 工具箱均可运行(零几何
  退化,结构冒烟无碍);真实渲染验证归 WP-F7 Playwright。
- **已知取舍(登记)**:会话动作通道无发起方关联——payload 执行期间,其他
  来源动作(如工作区「指令步进」)的响应会被执行器当作自己的下一步推进;
  教学 UI 约定 payload 运行/暂停期间不混用其他动作入口,幂等键级关联留
  WP-F7/F8 演进。变量/列表/函数名 = 文本字段(不用 Blockly 变量模型 /
  flyout 动态列表)——序列化形态稳定、无头编译零额外状态。

### 积木 → 动作映射定案表(FE-PB-02 八类;唯一起始积木 FE-PB-03)

| 拆解类别 | 积木 | 求值 / 映射 | 对应动作 |
|---|---|---|---|
| 会话动作(增设) | 写字节 / 压栈 / 出栈 / 调用 / 返回 / 单步 | 直接映射 | `write_bytes` / `push` / `pop` / `call` / `ret` / `step` |
| 字符串 | 写字符串 / 连接 / UTF-8 字节数 | UTF-8 编码(定案) | 写字符串 → `write_bytes` |
| 断点 | 断点积木 | 步进暂停点(M7 变通) | `breakpoint` 步骤标记(非动作) |
| 变量 | 赋值 / 读取 / 增减 | 客户端编译期求值 | —(不产生动作) |
| 列表 | 追加(自动建表)/ 取项 / 长度 | 客户端编译期求值 | — |
| 分支 | 如果/否则 | 编译期求值,只展开被选中的支 | — |
| 循环 | 重复 N 次 | 编译期逐次展开(≤ 上限) | — |
| 函数(模块化) | 定义 / 语句调用 / 取返回值 | 编译期内联展开,可带返回值 | — |
| 运算与赋值 | 数字 / 文本 / 算术 / 比较 | 客户端编译期求值(64 位回绕) | — |
| 公开投影读取(增设) | 寄存器 / 读 8 字节(小端)/ 读单字节 | 求值环境直读 | — |

偏差登记:拆解文档 FE-PB-02 八类没有给 12 动作映射留落点(变量/列表/分支
等求值类积木不产生动作)——以"编译到 12 动作原子"为唯一准绳,增设「会话
动作」分类承载映射定案(write bytes/push/pop/call/ret/step),并增设「公开
投影读取」承载求值环境面;八类全部按拆解原文存在。

### 工作区接线(F5 形态)

- **窗口注册**:`tab-registry.ts` 增 `PAYLOAD_TAB_TYPE("payload")` 登记,
  「打开」菜单出现「Payload 搭建」;内容元素实现 `refresh?()`(投影更新 →
  重建求值环境并重编译)与可赋值 `dataSource` 属性(workspace 约定)。
- **组合根注入**:`dataSource` 经工厂上下文;动作提交面 `actionSink`
  (SessionClient 结构兼容 `PayloadActionSink`)由工作区按 duck-typing
  约定注入(`"actionSink" in content` 即绑,与 dataSource 同法,client 换
  绑经 `#rebindContents` 重绑)。
- **菜单「积木步进」(FE-WS-04b)**:`payload-step` 菜单动作,**仅 payload
  窗口激活(焦点)时可用**(工作区按焦点页类型计算 `payloadStepEnabled`
  注入菜单);点击 → 焦点 payload 页 `stepOnce()` = 自动编译 + 推进一个原子
  动作并暂停。
- **FE-WS-07(payload 状态两模式共用)归 WP-F8**:本 WP 已保证 payload 元
  素状态不被窗口切换销毁(照 workspace `#contents` 生命周期约定;固定窗口集
  下窗口**常驻、无关闭入口**,弃置只发生在工作区整体卸载)。

### 出题者积木声明面(M10 / WP-80;2026-09-17)

- **输入面**:公开描述包顶层可选字段 `authorBlocks`(形状与规则见
  `challenge-schema/docs/双包Schema语义.md` §2.1 / §五)。客户端在
  `src/descriptor/challenge-descriptor.ts` 的 `parseAuthorBlocks` 做**形状闸**
  (键集封闭 / 动作 ⊆ `SESSION_ACTION_TYPES` / 参数名禁令 / 上限),坏形态整体
  回落 `null`(不渲染误导性工具箱);**客户端不持有私有包**,故接口存在性
  (`XS-BLOCK-IFACE-REF`)由服务端与编译链兜底 —— 两层判定**同则但不同源**
  (vm-ui 只依赖 `protocol`,禁 import `challenge-schema`,依赖纪律 5.5)。
- **积木生成**:`src/payload/compiler/blocks.ts` 的 `buildAuthorBlockDefinitions()` /
  `buildAuthorBlockCategory()` 把每个模板转成一枚动态积木(类型名
  `payload_author_<id>`,槽 = `input_value`,显示名 `displayText` + 槽标签),
  `buildPayloadToolbox()` / `registerPayloadBlocks()` 追加「题目积木」分类;
  **零声明 ⇒ 定义表与工具箱逐字节等于 M10 之前**(回归护栏见测试)。
- **编译面**:`compiler/compile.ts` 的 `compileAuthorBlock()` 按声明顺序展开动作,
  槽引用经 `evalValueInput` 求值后按参数语义格式化(`addressHex` / `targetHex`
  → 地址串、`valueHex` → `0x` + 大写 hex),`allowedActions` 裁剪**原样保留**
  (越界动作以 `unauthorized_action` 拒绝,错误携带积木 `id`);未声明类型
  → `unknown_block_type`,槽缺失 → `missing_input`。
- **注入面**:`SmWorkspace` 的 `authorBlocks` duck-typing 注入(与 `dataSource` /
  `actionSink` 同法)。**M10 顺带修一处晚到缺陷**:描述包**异步晚到**时,注册表
  内容元素(无模板绑定)过去不会补同步 ⇒ `willUpdate` 现对
  `challengeDescriptor` 变更重跑 `#syncEdContents()`。
- **测试**:`test/payload/author-blocks.test.ts`(15 例:零声明回归 / 定义与工具箱 /
  幂等注册 / 编译求值与裁剪)、`test/payload/author-blocks-injection.test.ts`
  (4 例:声明集经工作区注入落到真组件并可用)、`test/descriptor/challenge-descriptor.test.ts`
  (11 例坏形态红灯)。

### 测试面

`test/payload/`:积木定义(tooltip 齐备 / 分类齐备 / 无头可实例化)、编译器
(顺序映射 / UTF-8 字符串 / 变量与运算 / 分支与循环展开 / 断点标记 /
allowedActions 裁剪 / 展开与深度上限 / 未知引用 / 函数内联与递归 / 列表 /
结构性错误 / 公开投影求值环境——全部以序列化 JSON 输入)、执行器(fake
sink 记录调用序:逐步提交时序 / 断点暂停恢复 / 用户暂停 / rejected 手动
重试 / 间隔等待注入 / load 复位)、`<sm-payload-tab>` 冒烟(三区结构 /
轻 DOM 画布宿主 / 唯一起始积木不可删 / 程序区与输出区呈现 / 动作通道注入
运行 / 注册表登记);`test/workspace/`(注册表五类 / 菜单积木步进禁用矩阵
/ payload 页 actionSink 注入与菜单接线)。

## 虚拟列表裁决(WP-F7 收口,2026-09-11):lit-virtualizer → 自研 sm-window-list

- **缺陷证据**:@lit-labs/virtualizer 2.1.1 在本仓库实际环境(Vite 8/rolldown 构建产物 + 嵌套 shadow DOM 挂载)下,scroller 模式 `rangeChanged` 不触发行不渲染,且最小复现(纯文档级两实例)呈现"仅首个实例渲染"的时序性——两实例创建顺序互换、结果随之互换。jsdom 兼容冒烟(F1)无法暴露该缺陷(jsdom 无真实布局时序)。
- **裁决**:字节/指令视图改用自研 `<sm-window-list>`(确定性窗口化:流内 sizer + translateY 切片 + light DOM 渲染;jsdom/隐藏态以有界回退视口窗口化,"虚拟化真实生效"在任何环境有界)。窗口上限 512 行,性能余量充足。
- **保留面**:`@lit-labs/virtualizer` 依赖与 `test/lit-virtualizer-compat.test.ts` 兼容冒烟保留,作为上游修复后的回归重试锚;上行风险登记于阶段四验收评审。

## 第三方依赖审计(WP-F6,2026-09-11;风险表「Blockly 体积与产物隔离扫描
的交互」闭环)

| 依赖 | 事实登记 |
|---|---|
| `blockly@13.2.1` | 用途:积木编辑器画布(FE-PB-05 采纳项,编译器仅消费其**无头 workspace 序列化**,不依赖 DOM 渲染)。License:**Apache-2.0**(与本包 GPL-3.0-or-later 共存无冲突)。**零运行时依赖**(dependencies 为空;仅一条 peerDependency `jsdom >=27.4.0 <30.0.0` 服务于其 Node 入口——本包经 pnpm devDep 供给 jsdom 30,浏览器入口不受影响)。**无 postinstall / preinstall 脚本**(scripts 为空),pnpm allow-scripts 零放行面。 |
| core-js 说明 | 风险表假设"core-js 为其可选依赖"——实测 blockly 13.2.1 **不含 core-js**(依赖表为空),该假设不成立,无 build 脚本被 pnpm 忽略的副作用面;如未来版本引入再补审计。 |
| 体积量级 | `blockly_compressed.js` 约 634 KB(原始);经 vite 库模式内联后 vm-ui 主 chunk 约 1.2 MB(gzip ≈ 294 KB),其中 Blockly 贡献约 0.9 MB 原始(gzip ≈ 250 KB)。积木编辑器是重型交互面,该量级在教学主功能可接受;如需瘦身可后续按入口拆分(Blockly 独立 chunk),本 WP 不做。 |
| scan:public 交互 | dist 内 blockly 产物对私有面标记/引擎标识/节点内建**零命中**(dist 中两处 `jsdom` 字符串 = rolldown 路径注释 + Blockly 运行时告警文案,非导入;无 `require(...)`)。`pnpm scan:public` 实测通过:3 个公开包已扫描、0 违规(仅 protocol 既有 3 条 allowlist)。扫描基线在 F7 一次建立的口径不变。 |

## WP-F8:调试模式档落地(WP-F8 主章节,2026-09-11)

轨道 C 汇合交付面(依赖 WP-40/41/42/44 调试通道全线 + WP-F5 工作区):
`DebugDataSource` 填充、`DebugChannelClient` 调试通道客户端、
`<sm-instruction-view>` 指令视图全量(FE-IN-01~08)、原生断点 /
run-to-breakpoint(FE-IN-08 / FE-WS-04c)、跳转链全延伸(FE-ST-08/10)、
工作区解题/调试模式切换与 payload 状态共用(FE-WS-06/07)、ED 七组件
工作区挂接(轨道 C 收口)、what-if UI 纪律(ADR-DC1 条款 7)。

### 定案登记(主控已裁决,同时登记于源码注释)

1. **DebugDataSource 数据模型 = 推送 + 显式拉取的本地缓存**(全部属
   "公开投影与 UI 状态",调试通道数据公开性由零装载保证,ADR-DC1 条款 2;
   **只消费调试通道数据,零旁路真实私有包内容**):
   - 窗口缓存:`debug_window_data` 回执(显式拉取唯一来源)按地址归并为
     互不重叠/相邻的连续段;`bytesRows` / `search` 只覆盖缓存窗口,缓存外 =
     "窗口外" cell(与公开档同形,越界不报错);
   - `regions()` = 解题模式公开投影 `visibleRegions` 的**结构同构映射**;
     `windowByteLength` = 区域内已缓存字节的最大覆盖面(中段空洞以窗口外
     cell 显式呈现,不伪造)。**已知边界:v1 夹具 aslrEnabled 恒缺席/false,
     区域地址与调试实例一致;aslr-on 题目的调试档区域列表精度 = 结构描述级,
     地址对齐演进 = D-J8 / D-J10 登记项**(协议 v1 调试通道不携带 ASLR 布尔
     与基址派生面到浏览器;投影仍携带会话真实地址,双实例地址差异的 UI 呈现
     由 what-if 横幅 ASLR 提示语承接);
   - `registers()` = 公开投影 `visibleRegisters`(调试协议 v1 无寄存器帧;
     重放对齐后公开投影寄存器面即结构同构展示面);
   - `instructionStream(range)` 实现于**缓存指令流**(仅 `debug_instruction_
     stream` 推送覆盖面;每次暂停推送暂停落点上下文 maxItems=16,§九推送
     模型;协议 v1 无 C→S 拉取帧 → 超出覆盖面 = 空数组,不伪造);
   - 函数表来自 attach 推送帧(`debug_function_table` 恰一次,按起始地址
     升序缓存);
   - **扩展方法契约(调试档独有面,不在 MemoryDataSource 接口上——照接口
     注释惯例,视图 duck-typing 探测)**:`prefetchWindow(addressHex,
     byteLength?)`(异步,发出 `debug_window` 帧并入缓存,视图在事件回调里
     await 后 refresh)、`searchAllMemory(patternHex, maxHits?)`(异步全内存
     `debug_search`,与同步 `search()`(仅缓存窗口)双入口区分)、
     `step()` / `runToBreakpoint(addresses?)`(异步,回执 = `debug_paused`;
     缺省断点集合 = 当前集合,空集合确定性抛错)、断点集合管理
     (`addBreakpoint` / `removeBreakpoint` / `toggleBreakpoint` /
     `breakpoints` / `breakpointCount` / `isBreakpoint`)、状态面
     (`instructions()` / `instructionAt()` / `functions` / `paused` /
     `pausedAddressHex` / `attached` / `connectionStatus`)与 `onChange`
     (缓存 / 暂停 / 断点 / 连接变更事件;调试推送异步到达,视图自订阅后
     refresh——公开投影的 rAF 合帧仍归 SessionClient)。
2. **指令视图 FE-IN 全量口径**:`<sm-instruction-view>` 挂在 `debug` 窗口
   类型(F5 占位替换为真工厂,FE-IN-01"替换 debug 占位的同时新增");
   FE-IN-02 三段布局(地址 / 伪机器码 bytesHex 可缺席呈现"—"/文本 +
   jumpTargetHex 延展);FE-IN-03 jumpTarget 延展显示 + 点击跳转;FE-IN-04
   函数表面板(来自推送,点击跳转);FE-IN-05 rip 锚点(最新 paused 地址行
   高亮 + 回锚;三级回退 debug_paused → attach paused → RIP 寄存器公开值);
   FE-IN-06 地址跳转 = 推送覆盖面内滚动定位,超出覆盖面 → 自动 prefetchWindow
   后重试一次,仍不可达给"覆盖面之外"反馈(窗口字节已入缓存,字节视图可看);
   FE-IN-07 检索双入口分开呈现:字节检索走 `debug_search`(全内存,异步)+
   指令文本检索走缓存流过滤(大小写不敏感);FE-IN-08 行断点切换(断点集合 =
   调试档 UI 状态,`breakpoints-changed` 事件回流工作区)。暂停原因呈现
   (debug_paused 封闭四值各自文案):step = 单步暂停 / breakpoint = 命中断点
   已暂停 / program_halt = 程序已自行停机 / budget = 预算耗尽确定性暂停。
   解题模式(公开档数据源)下呈现"切换到调试模式"引导空态,不伪造指令流。
3. **FE-IN-08 / FE-WS-04c 原生断点**:行断点切换(调试档集合)+ 菜单
   「运行到断点」动作(仅调试模式 && 断点集合非空 && 会话通道可用且未终态
   可用,宿主计算 `runToBreakpointEnabled` 注入)→ `debug_run_to_breakpoint`
   (breakpoints = 当前集合);命中 / 预算 / 停机文案见上。
4. **FE-WS-06/07 模式切换**:工作区菜单「切换到调试模式 / 返回解题模式」
   (`debugModeAvailable` 属性门槛——可用性 = **公开描述包的 `debugMode` 声明**
   (opt-out:缺省即启用,仅显式 `false` 关闭)由承载方注入;当前分发形态 =
   独立页面 `apps/page-app` 在 boot 阶段经 `GET /descriptors/:id/:version`
   取包后注入;未启用题目隐藏切换项);切换 = workspace 重绑数据源
   (公开档 ProjectionDataSource ↔ DebugDataSource,`debugDataSourceFactory`
   测试接缝,缺省 `createDebugDataSource(client)` 组合根装配),字节视图换绑
   即重建 = 锚点/滚动重置(F5 既有行为,验收口径);client 换绑(新会话)
   确定性退回解题模式。**payload 窗口状态两模式共用**(切换不销毁 payload
   元素,`#contents` 生命周期不变);断点积木双档:解题模式 = 步进暂停
   (WP-F6 现状),调试模式 = 断点集合并入调试断点——挂点 = 内容元素
   `breakpointAddresses()` 声明面(sm-payload-tab 已实现,v1 编译器断点步骤
   无地址承载返回空,编译器演进携带 addressHex 后自动并入,零工作区改动)。
   **what-if 纪律(条款 7)**:调试模式下工作区顶部常驻显式横幅
   「调试通过 ≠ 提交通过(裁决以提交为准)」+ ASLR 地址差异提示语
   ("调试实例地址与真实实例可能不同,硬编码绝对地址跨实例失效属预期教学
   语义");调试交互反馈(attach / 暂停原因 / 通道断开)独立状态行,降级
   文案明示。
5. **FE-ST-08/10 跳转链全延伸**:调试模式下 `<sm-jump-chain>` 数据源 =
   DebugDataSource;组件增补 `extendable` + `extendHandler` 挂点(最小 diff)
   ——链末段窗口外时呈现「延伸」按钮 → 宿主 prefetchWindow 目标段并入缓存 →
   组件重解析(resolveJumpChain 同步语义保留),呈现「已延伸至缓存边界」
   反馈(仍不可达)或延伸后的新链;失败给降级文案。解题档(extendable 缺省
   false)维持窗口外截断现状。工作区 viewport-jump / highlight-jump 的窗口外
   落点在调试模式下同样自动 prefetch 后重试一次。
6. **ED 组件挂接(轨道 C 收口)**:ED 七组件按 F9 README 契约挂入工作区——
   新增窗口类型 structure(FE-ED-01,highlights = 快照 semanticHighlights,
   highlight-jump → 字节视图 showRegion/scrollToAddress + 调试档 prefetch
   重试)、call-stack(FE-ED-02)、timeline(FE-ED-04,entries =
   buildTimeline(动作账本, checkpoints);动作账本 = 宿主自 onActionResponse
   记录(发送侧 FIFO 配对,响应不携带动作本体;payload 运行期不混用其他
   动作入口的既有取舍沿用),公开投影 + UI 状态,合规)、checkpoints
   (FE-ED-05,sendAction 注入;create/checkout 响应到达且未拒 → 重拉
   `list_checkpoints` 刷新)、memory-diff(FE-ED-03,取简 = 独立窗口;宿主
   经 `client.store.subscribe` 维护"前一投影 visibleRegions + 最新 delta")
   ——注入机制 = 组合根 `#syncEdContents` duck-typing(同 dataSource /
   actionSink 约定);FE-ED-06 提示 ladder + FE-ED-07 错误解释挂工作区
   「教学面板」(`<details>` 折叠区,提示 = 公开描述包 hintLadder,失败计数 =
   宿主自 onActionResponse `failed` 状态自账;错误解释与 F5 菜单内联拒绝呈现
   **增强并存**,数据 = userVisibleError + 公开描述包 publicErrorMapping)。
   `src/index.ts` 导出 ED 组件、纯函数与 DebugDataSource / DebugChannelClient。
7. **描述包注入(当前形态 = 服务端取包)**:承载方在 boot 阶段取**公开描述包**
   (独立页面形态 = `apps/page-app` 的 `GET /descriptors/:id/:version`,同源),
   再把 `debugModeAvailable`(opt-out 归一)/ `hintLadder` / `publicErrorMapping`
   注入工作区装配(`challengeDescriptor` / `challengeStatic` / `descriptorStatus`);
   取包失败 = **fail-soft**:`descriptorStatus="absent"` + 缺席明示,会话照常可用,
   切换项隐藏。**沿革**:`apps/plugin-dev` 曾以本地夹具
   `apps/plugin-dev/fixtures/dev-descriptor.json`(照公开包数据形态自建,零代码
   依赖)走同一注入面 —— 该应用已于 2026-09-19 随 WP-96 物理删除,夹具随之退场。

### 测试面

`test/client/debug-channel-client.test.ts`(attach 自动化帧形态 / requestId
关联 / 推送帧 / 错误帧关联拒绝 / 版本锚定·方向·会话绑定漂移兜底 / seq /
dispose)、`test/datasource/debug-data-source.test.ts`(缓存窗口命中·窗口外·
归并、prefetch 帧形态与 regions 映射、search 双入口、instructionStream 缓存
边界、函数表、断点集合、step/runToBreakpoint 帧发送(fake transport)、组合根
装配)、`test/views/instruction/sm-instruction-view.test.ts`(三段渲染缺席
语义 / rip 锚点 / jumpTarget·函数表·地址跳转 prefetch 管线 / 检索双入口 /
断点切换事件 / 暂停文案)、`test/workspace/sm-workspace-mode.test.ts`
(debugModeAvailable 门槛、换绑后数据源替换与横幅显隐、payload 元素保留与
断点积木并入口、运行到断点矩阵、ED 挂接:结构视图联动 / 时间线条目 /
checkpoint 刷新时点 / 提示揭示 / 错误解释)、`test/views/chain/
sm-jump-chain-extend.test.ts`(延伸入口 / 缓存边界反馈 / 失败降级)、
`test/views/byte/byte-view.test.ts`(调试档窗口外跳转 prefetch 重试)。
