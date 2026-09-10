/**
 * @stackmaster/vm-ui —— 投影渲染库(阶段四轨道 A;WP-F1 脚手架,WP-F2 扩充)。
 *
 * 定位:公开投影的浏览器渲染层(字节视图、寄存器、工作区容器等),Lit 3 +
 * TypeScript,Vite library mode 多入口构建;依赖方向强制为只依赖
 * @stackmaster/protocol 的公开入口(dependency-cruiser
 * browser-packages-only-depend-on-protocol 规则)。
 *
 * 模块地图(WP-F2 落地):
 *  - src/client/     session-client:REST 5 命令、认证 WSS、断线重连、rAF 合帧;
 *                    projection-store:公开投影状态存储(最近投影 + 增量应用);
 *                    transport / session-errors:可注入传输层与错误面;
 *  - src/datasource/ MemoryDataSource 双档抽象(视图唯一依赖面)、
 *                    ProjectionDataSource 公开档、DebugDataSource 占位(WP-F8);
 *  - src/render/     共享渲染原语(hex / special-display / rows),供
 *                    WP-F3/F4 并行消费,避免两视图互相依赖;
 *  - src/ui/         视图组件(WP-F3/F4/F5 填充)。
 *
 * 视图组件纪律(前端实施计划 §四):视图禁止绕过 MemoryDataSource 接口直读
 * session-client 投影存储;浏览器任何位置只保存公开投影与 UI 状态;断线只展示
 * 最近一次公开投影,重连走 sync-projection,禁止任何本地 VM 执行降级。
 */

// ── 视图组件 ──
export * from "./ui/sm-workspace.js";

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
