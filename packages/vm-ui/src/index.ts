/**
 * @stackmaster/vm-ui —— 投影渲染库(阶段四轨道 A;WP-F1 脚手架,WP-F2 扩充,
 * WP-F3/F4 视图,WP-F5 工作区容器)。
 *
 * 定位:公开投影的浏览器渲染层(工作区、字节视图、寄存器、跳转链等),Lit 3 +
 * TypeScript,Vite library mode 多入口构建;依赖方向强制为只依赖
 * @stackmaster/protocol 的公开入口(dependency-cruiser
 * browser-packages-only-depend-on-protocol 规则)。
 *
 * 模块地图:
 *  - src/workspace/  WP-F5:工作区容器(sm-workspace 列式滚动平铺 + 标签页
 *                    生命周期 + 顶部菜单)、tab-type registry、布局模型、
 *                    字节页组合(vma 回路)、寄存器交叉标注展开组件;
 *  - src/payload/    WP-F6:Payload 搭建(sm-payload-tab 三区布局)、
 *                    积木 → 12 动作编译器(无头 Blockly,序列化 JSON 输入)、
 *                    客户端求值环境(公开投影快照)、步进执行器(原子动作
 *                    粒度,Q3 定案);
 *  - src/client/     session-client:REST 5 命令、认证 WSS、断线重连、rAF 合帧;
 *                    projection-store:公开投影状态存储(最近投影 + 增量应用);
 *                    transport / session-errors:可注入传输层与错误面;
 *                    debug-channel-client:调试通道客户端(WP-F8,独立端点);
 *  - src/datasource/ MemoryDataSource 双档抽象(视图唯一依赖面)、
 *                    ProjectionDataSource 公开档、DebugDataSource 调试档(WP-F8
 *                    填充:调试通道缓存 + 扩展方法);
 *  - src/ed/ +       ED 教学组件面(WP-F9 组件 + 纯函数;WP-F8 挂接工作区);
 *  - src/render/     共享渲染原语(hex / special-display / rows);
 *  - src/views/      WP-F3 字节视图(byte-view / vma-list)、WP-F4 寄存器视图
 *                    与跳转链(register / chain)、WP-F8 指令视图(instruction)。
 *
 * 视图组件纪律(前端实施计划 §四):视图禁止绕过 MemoryDataSource 接口直读
 * session-client 投影存储;浏览器任何位置只保存公开投影与 UI 状态;断线只展示
 * 最近一次公开投影,重连走 sync-projection,禁止任何本地 VM 执行降级。
 */

// ── 工作区容器与菜单(WP-F5;WP-F8 模式切换 / ED 挂接;WP-72 布局交互)──
export * from "./workspace/sm-workspace.js";
export * from "./workspace/sm-workspace-menu.js";
export * from "./workspace/tab-registry.js";
export * from "./workspace/workspace-model.js";
export * from "./workspace/layout-presets.js";
export * from "./workspace/layout-camera.js";
export * from "./workspace/layout-divider.js";
export * from "./workspace/byte-tab.js";
export * from "./workspace/sm-register-annotation.js";

// ── ED 教学组件面(WP-F9 组件 × WP-F8 工作区挂接;导出 + 注册)──
export * from "./ed/ed-types.js";
export * from "./ed/memory-diff.js";
export * from "./ed/timeline.js";
export * from "./views/ed/sm-structure-view.js";
export * from "./views/ed/sm-call-stack.js";
export * from "./views/ed/sm-memory-diff.js";
export * from "./views/ed/sm-timeline.js";
export * from "./views/ed/sm-checkpoints.js";
export * from "./views/ed/sm-hint-ladder.js";
export * from "./views/ed/sm-error-explainer.js";

// ── 指令视图(WP-F8 / FE-IN-01~08,调试档)──
export * from "./views/instruction/sm-instruction-view.js";

// ── Payload 搭建(WP-F6;WP-83:Blockly 承载面退场为「类型 + 惰性访问器」)──
// 背景(实测):`sm-payload-tab` / `compiler/blocks` / `compiler/compile` 静态
// import `blockly`(blockly_compressed.js 等,合计约 904 kB raw / 216 kB gzip),
// 而本入口桶被 plugin-dev 与宿主以 `<script type="module" src="…/index.js">`
// **直接加载** ⇒ 静态再导出会把 Blockly 拉进首屏静态图。故值面只保留与
// Blockly 无关的三个模块,Blockly 承载面改为**类型再导出 + 惰性访问器**;
// 工作区内的取值路径 = `<sm-payload-tab-host>`(payload/lazy-payload-tab.ts)。
// 前后实测与「只改注册表 = 假绿」陷阱见 docs/develop/decisions-m3/WP-83.md。
export * from "./payload/executor.js";
export * from "./payload/compiler/types.js";
export * from "./payload/compiler/eval.js";
export type * from "./payload/sm-payload-tab.js";
export type * from "./payload/compiler/blocks.js";
export type * from "./payload/compiler/compile.js";
/**
 * 惰性取回 Payload 引擎(`<sm-payload-tab>` 组件 + Blockly 画布侧)。
 *
 * 需要值面(`SmPayloadTab` 类 / `breakpointAddresses` 等实例面)的消费者经此
 * 取回;**禁止**改回静态再导出 —— 那会把约 904 kB 的 Blockly 重新放回首屏
 * 静态图(实测:首屏静态图 450.53 kB → 1,396.71 kB)。
 */
export const loadPayloadEngine = (): Promise<typeof import("./payload/sm-payload-tab.js")> =>
  import("./payload/sm-payload-tab.js");

// ── 字节视图(WP-F3)──
export * from "./views/byte/byte-view.js";
export * from "./views/byte/vma-list.js";
export * from "./views/byte/alignment.js";
export * from "./views/byte/view-model.js";

// ── 寄存器视图与跳转链(WP-F4)──
export * from "./views/register/sm-register-view.js";
export * from "./views/register/cross-annotation.js";
export * from "./views/chain/resolve.js";
export * from "./views/chain/visible-run.js";
export * from "./views/chain/sm-jump-chain.js";

// ── 公开描述包客户端加载器(WP-54;M2 正式下发通道消费)──
export * from "./descriptor/challenge-descriptor.js";

// ── 会话客户端与投影存储 ──
export * from "./client/session-client.js";
export * from "./client/projection-store.js";
export * from "./client/session-errors.js";
export * from "./client/transport.js";
// 调试通道客户端(WP-F8;独立端点独立协议版本,ADR-DC1 条款 1)。
export * from "./client/debug-channel-client.js";

// ── 双档数据源抽象 ──
export * from "./datasource/types.js";
export * from "./datasource/projection-data-source.js";
export * from "./datasource/debug-data-source.js";

// ── 共享渲染原语 ──
export * from "./render/hex.js";
export * from "./render/rows.js";
export * from "./render/special-display.js";

// ── i18n 与主题机制面(WP-53)──
// i18n:消息目录(zh-CN = 现行文案原样 / en)、t() 类型安全取词、响应式
// locale(setLocale / onLocaleChange / LocaleController)、data-sm-language
// 锚消费(嵌入协议语义,与 EmbedAppearanceController 对接)。
export * from "./i18n/i18n.js";
export * from "./i18n/catalog-zh-CN.js";
export * from "./i18n/catalog-en.js";
// 主题:light/dark 双套 CSS 自定义属性变量集 + data-sm-theme 文档级锚样式表
// (auto 由 @media (prefers-color-scheme: dark) 承担,零 JS 解析)。
export * from "./theme/theme-tokens.js";
