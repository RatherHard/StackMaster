/**
 * ui/sm-workspace —— 独立组件入口(WP-F1 建立的加载面,WP-F5 改造为转发)。
 *
 * <sm-workspace> 的实现已随 WP-F5 迁移至 src/workspace/(工作区容器 + 菜单 +
 * 标签页注册表);本模块保留同一入口路径:vite 多入口(build.entry["sm-workspace"])
 * 与 package.json exports["./sm-workspace"] 的消费面不变——宿主以
 * `<script type="module" src="…/sm-workspace.js">` 单独加载即可注册完整
 * 工作区(含其模板依赖:菜单 / 字节页 / 标注 / 跳转链)。
 *
 * `export *` 自带被转发模块的求值副作用(自定义元素注册)。
 */
export * from "../workspace/sm-workspace.js";
