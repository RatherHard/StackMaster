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
 *  - src/datasource/ MemoryDataSource 双档抽象(视图唯一依赖面)、
 *                    ProjectionDataSource 公开档、DebugDataSource 占位(WP-F8);
 *  - src/render/     共享渲染原语(hex / special-display / rows);
 *  - src/views/      WP-F3 字节视图(byte-view / vma-list)、WP-F4 寄存器视图
 *                    与跳转链(register / chain)。
 *
 * 视图组件纪律(前端实施计划 §四):视图禁止绕过 MemoryDataSource 接口直读
 * session-client 投影存储;浏览器任何位置只保存公开投影与 UI 状态;断线只展示
 * 最近一次公开投影,重连走 sync-projection,禁止任何本地 VM 执行降级。
 */

// ── 工作区容器与菜单(WP-F5)──
export * from "./workspace/sm-workspace.js";
export * from "./workspace/sm-workspace-menu.js";
export * from "./workspace/tab-registry.js";
export * from "./workspace/workspace-model.js";
export * from "./workspace/byte-tab.js";
export * from "./workspace/sm-register-annotation.js";

// ── Payload 搭建(WP-F6)──
export * from "./payload/sm-payload-tab.js";
export * from "./payload/executor.js";
export * from "./payload/compiler/types.js";
export * from "./payload/compiler/blocks.js";
export * from "./payload/compiler/compile.js";
export * from "./payload/compiler/eval.js";

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

// ── 会话客户端与投影存储 ──
export * from "./client/session-client.js";
export * from "./client/projection-store.js";
export * from "./client/session-errors.js";
export * from "./client/transport.js";

// ── 双档数据源抽象 ──
export * from "./datasource/types.js";
export * from "./datasource/projection-data-source.js";
export * from "./datasource/debug-data-source.js";

// ── 共享渲染原语 ──
export * from "./render/hex.js";
export * from "./render/rows.js";
export * from "./render/special-display.js";
