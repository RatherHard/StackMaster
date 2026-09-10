/**
 * @stackmaster/vm-ui —— 投影渲染库(WP-F1 脚手架)。
 *
 * 定位:公开投影的浏览器渲染层(字节视图、寄存器、工作区容器等),Lit 3 +
 * TypeScript,Vite library mode 多入口构建;依赖方向强制为只依赖
 * @stackmaster/protocol 的公开入口(dependency-cruiser
 * browser-packages-only-depend-on-protocol 规则)。
 *
 * 目录占位(WP-F2 落地后接入并在此导出):
 *  - src/client/     session-client:REST 5 命令、认证 WSS、断线重连、rAF 合帧;
 *  - src/datasource/ MemoryDataSource 双档抽象与 ProjectionDataSource 公开档。
 *
 * 视图组件纪律(前端实施计划 §四):视图禁止绕过数据源接口直读
 * session-client 投影存储;浏览器任何位置只保存公开投影与 UI 状态。
 */
export * from "./ui/sm-workspace.js";
