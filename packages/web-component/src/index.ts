/**
 * @stackmaster/web-component —— <pwn-memory-vm> 插件 Shell(阶段五 WP-52 正式实现)。
 *
 * 独立来源 iframe 内的插件视图托管:嵌入握手(插件侧 V 规则编排)、esid
 * fragment 一次性读取、引导配置取回(D-API-75 通道 a)、height_changed 上报
 * (rAF 合流 + 每秒上限 30 + MAX_EMBED_HEIGHT_PX 护栏)、主题 / 语言接线位、
 * 会话全流程挂接(SessionClient → <sm-workspace>)。契约单一来源 =
 * @stackmaster/protocol(EmbedMessage 解析器公开入口;浏览器不解析 token,
 * EmbedTokenClaims 解析器不经本包消费)。
 *
 * 装配形态(Q3 定案):本包依赖 vm-ui(工作区)与 embed-runtime(无状态
 * 构件),vite 库模式把 lit / vm-ui / protocol / embed-runtime 全部内联进
 * dist 单产物——宿主 / 插件文档页以 `<script type="module">` 直接加载,非根
 * 路径部署 = 文档页内相对路径引用,受限 CSP 兼容(零 eval、文档页零内联脚本)。
 */
export * from "./pwn-memory-vm.js";
export * from "./plugin/handshake.js";
export * from "./plugin/appearance.js";
export * from "./plugin/bootstrap.js";
export * from "./plugin/esid.js";
export * from "./plugin/height-reporter.js";
